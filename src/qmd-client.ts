/**
 * QmdClient — unified search client for QMD (MCP优先, REST备选, CLI兜底)
 *
 * Priority: MCP /mcp → REST /query → CLI (child_process) → throw
 * Auto-recovery: 降级后定期 ping, 恢复后自动切回 MCP
 *
 * 三级降级设计：
 * - MCP 优先：完整 hybrid 搜索能力（lex+vec+hyde + SDK 自动展开 + RRF + rerank）
 * - REST 备选：仅在 MCP 失败（embed 维度错误、超时、连接失败）时启用。
 *   为避免再次触发 MCP 同样的 embed 错误，REST 降级时只用 lex 子查询（纯 BM25），
 *   避开 vec embed 路径。recall 降低但保证可用。
 * - CLI 兜底：REST 也失败时最后兜底。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from './utils/logger.js';
import { resolveLogger } from './utils/logger.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// vec/hyde 否定语法剥离
// ---------------------------------------------------------------------------
// qmd server 对 vec/hyde 子查询不支持 lex 的 `-term` 否定语法，会整体返回 isError：
//   "Structured search (vec): Negation (-term) is not supported in vec/hyde queries.
//    Use lex for exclusions."
// 该函数移除 query 中形如 `-term` / `-multi-word` 的否定词，仅保留正向词喂给 vec/hyde。
// lex 子查询不走本函数，保留否定语义。
//
// 规则：
//   - 匹配 `-term`：前导为空白或行首，`-` 后紧跟非 `-` 开头的非空白字符序列
//   - 跳过 `--xxx`（双连字符视作其它语义，不处理）
//   - 连续空格压缩为单空格，首尾 trim
function stripVecNegation(q: string): string {
  let out = q.replace(/(^|\s)-(\S+)/g, (match, prefix: string, term: string) => {
    // term 以 `-` 开头说明是 `--xxx`，不当作否定词处理
    if (term.startsWith('-')) return match;
    return ' ';
  });
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 将文本按 maxChars 拆分为多个分片，尽量在句子边界处断开。
 * 分片之间无重叠（检索后端通过 RRF 合并多子查询结果，无需客户端去重）。
 *
 * 拆分策略：
 *   1. 若文本 <= maxChars，直接返回单元素数组
 *   2. 否则按 maxChars 切分，每段尽量在句号/换行/空格处断开
 *   3. 无法找到合适断点时，硬切在 maxChars 处
 */
function splitTextIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining.trim());
      break;
    }

    // 在 maxChars 范围内寻找最佳断点
    let cutPoint = maxChars;
    const searchWindow = remaining.slice(0, maxChars);

    // 优先级：句号 > 换行 > 空格 > 硬切
    const sentenceEnd = searchWindow.lastIndexOf('。');
    const periodEnd = searchWindow.lastIndexOf('.');
    const newlineEnd = Math.max(
      searchWindow.lastIndexOf('\n'),
      searchWindow.lastIndexOf('\r'),
    );
    const spaceEnd = searchWindow.lastIndexOf(' ');

    // 句号优先（在最后 30% 范围内才算有效断点）
    const minValidCut = Math.floor(maxChars * 0.5);
    if (sentenceEnd >= minValidCut) {
      cutPoint = sentenceEnd + 1; // 包含句号
    } else if (periodEnd >= minValidCut) {
      cutPoint = periodEnd + 1;
    } else if (newlineEnd >= minValidCut) {
      cutPoint = newlineEnd + 1;
    } else if (spaceEnd >= minValidCut) {
      cutPoint = spaceEnd + 1;
    }

    chunks.push(remaining.slice(0, cutPoint).trim());
    remaining = remaining.slice(cutPoint);
  }

  return chunks.filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QmdSearchResult {
  docid: string;
  file: string;
  title: string;
  score: number;
  snippet: string;
  line: number;
  context: string | null;
}

export interface SubSearch {
  type: "lex" | "vec" | "hyde";
  query: string;
}

export interface SearchParams {
  searches: SubSearch[];
  limit?: number;
  minScore?: number;
  collections?: string[];
  intent?: string;
  rerank?: boolean;
}

export interface QmdClientOptions {
  mcpBaseUrl?: string;
  /** MCP 初始化握手超时（ms）。初始化仅做 JSON-RPC handshake，通常 < 500ms。默认 3000ms。 */
  mcpTimeout?: number;
  /**
   * MCP 工具调用（查询）超时（ms）。
   * 首次查询需要 embedding 模型冷启动（4-5s），后续查询仅 300-400ms。
   * 修复前：mcpTimeout 同时用于 init 和 query，3s 太短导致首次查询永远超时 → 降级 REST。
   * 修复后：分离两个超时，query 默认 8000ms 覆盖冷启动，用户可通过 qmdMcpQueryTimeout 覆盖。
   */
  mcpQueryTimeout?: number;
  cliTimeout?: number;
  pingInterval?: number;
  cliFallbackSearchType?: 'search' | 'hybrid';
  /** 是否启用CLI降级能力。设为false时，MCP和REST均失败后直接抛错，不执行CLI命令（避免CLI卡死）。默认true。 */
  enableCliFallback?: boolean;
  /** P3-B3: 注入统一 logger；未提供时降级到 globalLogger。 */
  logger?: Logger;
  /** BUG-7: QMD vec/hyde 查询文本最大字符数，超过则截断。默认 8000（适配 qwen3-embed 32768 tokens）。 */
  qmdQueryMaxChars?: number;
}

// ---------------------------------------------------------------------------
// MCP response shape (from tools/call "query")
// ---------------------------------------------------------------------------

interface McpToolsCallResponse {
  result?: {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
    isError?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const QMD_CLIENT_DEFAULTS = {
  mcpBaseUrl: "http://127.0.0.1:8081",
  // MCP 初始化握手超时。初始化仅做 JSON-RPC handshake，通常 < 500ms。
  mcpTimeout: 3000,
  // MCP 工具调用（查询）超时。
  // 首次查询需要 embedding 模型冷启动（4-5s），后续查询仅 300-400ms。
  // 设为 15000ms 覆盖冷启动 + 排队场景。用户可通过 qmdMcpQueryTimeout 配置覆盖。
  mcpQueryTimeout: 15000,
  cliTimeout: 30_000,
  // P2-B1: 混合搜索（lex+vec）降级时，默认走完整 hybrid 路径（qmd query 多行 typed query），
  // 而非 'search'（纯文本，丢失向量部分）。仅在显式配置 'search' 时才用轻量降级。
  cliFallbackSearchType: 'hybrid' as 'hybrid' | 'search',
  pingInterval: 30_000,
  /** 默认启用CLI降级，保持向后兼容。用户可设为false禁用CLI避免卡死。 */
  enableCliFallback: true,
  /** BUG-7: QMD vec/hyde 查询文本最大字符数。默认 2000（适配 Qwen3.5-Embedding-0.6B num_ctx=8192 tokens，每 chunk ~1000 tokens，给文档侧留 7000+ tokens 空间）。 */
  qmdQueryMaxChars: 2000,
};

/** @deprecated 使用 QMD_CLIENT_DEFAULTS，保留向后兼容 */
const DEFAULTS = QMD_CLIENT_DEFAULTS;

// ---------------------------------------------------------------------------
// QmdClient
// ---------------------------------------------------------------------------

export class QmdClient {
  private readonly mcpBaseUrl: string;
  private readonly mcpTimeout: number;
  private readonly mcpQueryTimeout: number;
  private mcpSessionId: string | null = null;
  /** inflight initialize promise 去重，防止并发初始化创建多个 session */
  private _initPromise: Promise<string> | null = null;
  private readonly cliTimeout: number;
  private readonly cliFallbackSearchType: string;
  private readonly pingInterval: number;
  private readonly enableCliFallback: boolean;
  /** P3-B3: 统一 logger，替换散落的 console.* 调用 */
  private readonly logger: Logger;
  /** BUG-7: QMD vec/hyde 查询文本最大字符数，超过则分片。默认 2000（适配 Qwen3.5-Embedding-0.6B num_ctx=8192）。 */
  private readonly qmdQueryMaxChars: number;

  /** null = undetermined, true = REST可用, false = REST不可用 */
  private restAvailable: boolean | null = null;
  /** null = undetermined, true = MCP可用, false = MCP不可用 */
  private mcpAvailable: boolean | null = null;
  /** 最近一次 MCP 失败是否为 embed 维度错误（用于决定 REST 降级是否避开 vec） */
  private lastMcpErrorIsEmbed = false;
  /**
   * v2.5.0: 连续 context size 错误计数器。
   * 当 MCP 连续返回 context size 错误 ≥ 阈值时，自动禁用 vec/hyde 搜索（仅用 lex），
   * 避免反复触发 embedding 模型超限，减少 MCP 服务崩溃风险。
   * 在 MCP 恢复后重置。
   */
  private _vecContextErrorCount = 0;
  /** 连续 context size 错误阈值，超过后自动禁用 vec */
  private static readonly VEC_CONTEXT_ERROR_DISABLE_THRESHOLD = 3;
  /** 是否已自动禁用 vec 搜索 */
  private _vecAutoDisabled = false;
  /**
   * v2.6.0: 连续空结果计数器。
   * 当 MCP 连续返回空结果 ≥ 阈值时，自动标记 MCP 不可用，跳过后续检索。
   * 与 context size 错误不同：空结果表示 MCP 调通但索引无数据，继续调用纯属浪费。
   */
  private _emptyResultCount = 0;
  private static readonly EMPTY_RESULT_DISABLE_THRESHOLD = 2;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: QmdClientOptions = {}) {
    this.mcpBaseUrl = opts.mcpBaseUrl ?? DEFAULTS.mcpBaseUrl;
    this.mcpTimeout = opts.mcpTimeout ?? DEFAULTS.mcpTimeout;
    this.mcpQueryTimeout = opts.mcpQueryTimeout ?? DEFAULTS.mcpQueryTimeout;
    this.cliTimeout = opts.cliTimeout ?? DEFAULTS.cliTimeout;
    this.cliFallbackSearchType = opts.cliFallbackSearchType ?? DEFAULTS.cliFallbackSearchType;
    this.pingInterval = opts.pingInterval ?? DEFAULTS.pingInterval;
    this.enableCliFallback = opts.enableCliFallback ?? DEFAULTS.enableCliFallback;
    this.logger = resolveLogger(opts.logger);
    this.qmdQueryMaxChars = opts.qmdQueryMaxChars ?? DEFAULTS.qmdQueryMaxChars;
  }

  // ===================== public API =======================================

  /**
   * Hybrid search — MCP first, REST fallback (lex-only), CLI last resort.
   * Results are normalised to QmdSearchResult[] regardless of source.
   */
  async query(params: SearchParams): Promise<QmdSearchResult[]> {
    // 分阶段计时：用于总耗时超阈值时输出 breakdown，定位 L2_qmd 与 mcpCall 耗时差距来源。
    // 阶段含义：mcpMs/restMs/cliMs 仅在该阶段被尝试时累加；status 标记 ok/fail/skip。
    const qStart = Date.now();
    let mcpMs = 0, restMs = 0, cliMs = 0;
    let mcpStatus: 'ok' | 'fail' | 'skip' = 'skip';
    let restStatus: 'ok' | 'fail' | 'skip' = 'skip';
    let cliStatus: 'ok' | 'fail' = 'ok';
    const finalizeBreakdown = (finalTotalMs: number) => {
      // 总耗时 > 5s 时输出 breakdown，与 mcpCall 内部 >3s 的 slow 日志配合定位瓶颈。
      // 解决问题：日志曾出现 assemble L2_qmd=44711ms 但 mcpCall slow 仅 5598ms 的差距，
      // 差距来自 REST/CLI 降级链的累积耗时，此前无对应日志可证实。
      if (finalTotalMs <= 5000) return;
      const searchTypes = Array.isArray(params.searches)
        ? params.searches.map((s) => s.type).join(',')
        : '';
      this.logger?.warn?.(
        `[qmd-client] query slow breakdown: total=${finalTotalMs}ms (mcp=${mcpMs}ms/${mcpStatus}, rest=${restMs}ms/${restStatus}, cli=${cliMs}ms/${cliStatus}), searches=${params.searches?.length ?? 0}, searchTypes=${searchTypes}`,
        {
          totalMs: finalTotalMs,
          mcpMs, mcpStatus,
          restMs, restStatus,
          cliMs, cliStatus,
          searchesCount: params.searches?.length ?? 0,
          searchTypes,
          mcpAvailable: this.mcpAvailable,
          restAvailable: this.restAvailable,
          mcpQueryTimeout: this.mcpQueryTimeout,
          cliTimeout: this.cliTimeout,
        },
      );
    };

    // 清理 searches 中每个 query 的换行符。
    // qmd structured search (lex 模式) 不支持多行查询，含 \n/\r 会报错：
    //   "Structured search (lex): queries must be single-line. Remove newline characters."
    // vec/hyde 模式同样做清理以保持一致，避免将原始多行用户消息直接传入。
    // 处理：将 \r\n / \n / \r 替换为单个空格，并 trim 首尾空白。
    if (Array.isArray(params.searches)) {
      params = {
        ...params,
        searches: params.searches.map((s) => {
          if (typeof s.query !== 'string') return s;
          let q = s.query.replace(/\r\n|\n|\r/g, ' ').replace(/\s+/g, ' ').trim();
          // vec/hyde 不支持 lex 的 -term 否定语法，qmd server 会报错：
          //   "Structured search (vec): Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions."
          // 仅 lex 保留否定（lex 支持排除语义）。vec/hyde 剥离 -term 形式的否定词。
          if (s.type === 'vec' || s.type === 'hyde') {
            q = stripVecNegation(q);
          }
          return { ...s, query: q };
        }),
      };
    }
    // BUG-7: vec/hyde 查询文本分片（chunking），防止超过 embedding 模型 context window。
    // 当查询文本超过 qmdQueryMaxChars 时，不再截断丢弃信息，而是拆分为多个分片，
    // 每个分片作为独立的 vec/hyde 子查询发送。检索后端（MCP/REST）通过 RRF 合并
    // 多子查询结果，无需客户端手动去重。
    //
    // 分片的好处：
    //   1. 保留完整语义信息（不丢失任何查询内容）
    //   2. 每个分片更短，与索引文档拼接后更易落在 embedding 模型 context window 内
    //   3. 解决 "documents exceed the context size" 错误（索引文档过长时，缩短查询侧腾出空间）
    //
    // lex (BM25) 不受 token 限制，不参与分片。
    if (Array.isArray(params.searches)) {
      const maxChars = this.qmdQueryMaxChars;
      let anyChunked = false;
      const newSearches: SubSearch[] = [];
      for (const s of params.searches) {
        if ((s.type === 'vec' || s.type === 'hyde') && typeof s.query === 'string' && s.query.length > maxChars) {
          anyChunked = true;
          const chunks = splitTextIntoChunks(s.query, maxChars);
          for (const chunk of chunks) {
            newSearches.push({ ...s, query: chunk });
          }
        } else {
          newSearches.push(s);
        }
      }
      params = { ...params, searches: newSearches };
      if (anyChunked) {
        this.logger?.warn?.(
          `[qmd-client] vec/hyde query chunked into ${newSearches.length} total searches (chunkSize=${maxChars} chars)`,
          { maxChars, totalSearches: newSearches.length },
        );
      }
    }
    // 1. MCP 优先 — 完整 hybrid 搜索能力（lex+vec+hyde + SDK 自动展开 + RRF + rerank）
    if (this.mcpAvailable !== false) {
      // v2.5.0: 连续 context size 错误过多时自动禁用 vec，避免反复触发 MCP 崩溃
      let effectiveParams = params;
      if (this._vecAutoDisabled && Array.isArray(params.searches)) {
        const lexOnly = params.searches.filter((s) => s.type === "lex");
        if (lexOnly.length > 0) {
          this.logger?.warn?.(
            `[qmd-client] vec auto-disabled (${this._vecContextErrorCount} consecutive context size errors), using lex-only`,
          );
          effectiveParams = { ...params, searches: lexOnly, rerank: false };
        }
      }
      const mcpStart = Date.now();
      try {
        const results = await this.queryViaMcp(effectiveParams);
        mcpMs = Date.now() - mcpStart;
        // v2.6.0: 连续空结果检测 — MCP 调通但返回空结果时，累计计数器。
        // O6: 连续 2 次空结果后标记 MCP 不可用（原 3 次），避免浪费 2-7s/次。
        if (Array.isArray(results) && results.length === 0) {
          this._emptyResultCount++;
          if (this._emptyResultCount >= QmdClient.EMPTY_RESULT_DISABLE_THRESHOLD) {
            this.logger?.warn?.(
              `[qmd-client] MCP auto-disabled after ${this._emptyResultCount} consecutive empty results`,
            );
            this.mcpAvailable = false;
            this.scheduleRecovery();
            // 继续走 REST/CLI 降级链，不标记 mcpAvailable=true
          } else {
            this.mcpAvailable = true;
          }
        } else {
          this._emptyResultCount = 0;
          this.mcpAvailable = true;
        }
        if (this.mcpAvailable !== false) {
          this.clearRecovery();
          mcpStatus = 'ok';
          finalizeBreakdown(Date.now() - qStart);
          return results;
        }
        // mcpAvailable 被设为 false，继续走 REST/CLI 降级链
      } catch (err) {
        mcpMs = Date.now() - mcpStart;
        const _mcpErr = (err as Error).message;
        const _mcpStack = (err as Error).stack;
        const isContextSizeError = /context.?size|exceed.*(?:context|length)/i.test(_mcpErr);
        const isEmbedError = /dimension|embedding|mismatch/i.test(_mcpErr) || isContextSizeError;

        // v2.5.0: context size 错误时渐进降级重试，避免直接丢弃 MCP 路径。
        // 核心原因：服务端 embedding 模型在 rerank / vec 检索时需要将查询+文档拼接嵌入，
        // 若索引文档过长则超出 context window。客户端无法修复服务端文档分片，但可通过以下
        // 渐进策略在 MCP 内尝试恢复：
        //   1. rerank=false — 跳过最可能嵌入全文的 rerank 步骤
        //   2. lex-only    — 纯 BM25 检索，不触发 embedding
        // 仅当以上均失败时才标记 MCP 不可用、降级到 REST。
        if (isContextSizeError) {
          this._vecContextErrorCount++;
          if (this._vecContextErrorCount >= QmdClient.VEC_CONTEXT_ERROR_DISABLE_THRESHOLD && !this._vecAutoDisabled) {
            this._vecAutoDisabled = true;
            this.logger?.warn?.(
              `[qmd-client] vec auto-disabled after ${this._vecContextErrorCount} consecutive context size errors`,
              { err: _mcpErr.slice(0, 120) },
            );
          }
          const retryResult = await this._retryMcpContextSize(params, _mcpErr);
          if (retryResult !== null) {
            this.mcpAvailable = true;
            this.clearRecovery();
            mcpStatus = 'ok';
            finalizeBreakdown(Date.now() - qStart);
            return retryResult;
          }
        } else {
          // 非 context size 错误，重置计数器（仅 context size 是连续模式）
          this._vecContextErrorCount = 0;
        }

        mcpStatus = 'fail';
        // O6: MCP 失败时也累加空结果计数器，timeout/error 是比空结果更强的不可用信号
        this._emptyResultCount++;
        this.mcpAvailable = false;
        this.scheduleRecovery();
        this.lastMcpErrorIsEmbed = isEmbedError;
        if (isEmbedError) {
          const reason = isContextSizeError ? "context size exceeded" : "model dim mismatch";
          this.logger.warn(`[qmd-client] MCP embed error (${reason}), falling back to REST lex-only`, { err: _mcpErr });
        } else if (_mcpErr.includes("circuit breaker")) {
          this.logger.warn("[qmd-client] MCP circuit breaker OPEN, falling back to REST");
        } else if (_mcpErr.includes("HTTP")) {
          this.logger.warn("[qmd-client] MCP service error (" + _mcpErr + "), falling back to REST");
        } else if (_mcpErr.includes("empty response")) {
          this.logger.warn("[qmd-client] MCP query returned no results, falling back to REST");
        } else if (_mcpErr.includes("timeout") || _mcpErr.includes("Timeout") || _mcpErr.includes("aborted")) {
          this.logger.warn("[qmd-client] MCP query timeout, falling back to REST", { err: _mcpErr, mcpQueryTimeout: this.mcpQueryTimeout, url: `${this.mcpBaseUrl}/mcp` });
        } else if (_mcpErr.includes("fetch failed") || _mcpErr.includes("ECONNREFUSED") || _mcpErr.includes("ECONNRESET")) {
          this.logger.warn("[qmd-client] MCP connection failed, falling back to REST", { err: _mcpErr, url: `${this.mcpBaseUrl}/mcp` });
        } else {
          this.logger.warn("[qmd-client] MCP query failed, falling back to REST", { err: _mcpErr, url: `${this.mcpBaseUrl}/mcp`, stack: _mcpStack?.split('\n').slice(0, 5).join(' | ') });
        }
      }
    }

    // 2. REST /query 备选 — 仅在 MCP 失败后启用。
    //    若 MCP 失败是 embed 维度错误，REST 降级为 lex-only 避免再次触发 vec embed 错误。
    if (this.restAvailable !== false) {
      const restStart = Date.now();
      try {
        const results = await this.queryViaRest(params, this.lastMcpErrorIsEmbed);
        this.restAvailable = true;
        this.clearRecovery();
        restMs = Date.now() - restStart;
        restStatus = 'ok';
        finalizeBreakdown(Date.now() - qStart);
        return results;
      } catch (err) {
        restMs = Date.now() - restStart;
        restStatus = 'fail';
        this.restAvailable = false;
        const msg = (err as Error).message;
        if (msg.includes("timeout") || msg.includes("aborted")) {
          this.logger.warn("[qmd-client] REST /query timeout, falling back to CLI", { err: msg, timeout: this.mcpQueryTimeout, url: `${this.mcpBaseUrl}/query` });
        } else if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
          this.logger.warn("[qmd-client] REST /query connection failed, falling back to CLI", { err: msg, url: `${this.mcpBaseUrl}/query` });
        } else {
          this.logger.warn("[qmd-client] REST /query failed, falling back to CLI", { err: msg, url: `${this.mcpBaseUrl}/query` });
        }
      }
    }

    // 3. CLI 兜底（仅 enableCliFallback 为 true 时启用）
    if (!this.enableCliFallback) {
      this.logger.warn("[qmd-client] CLI fallback disabled (enableCliFallback=false), all query paths failed");
      finalizeBreakdown(Date.now() - qStart);
      throw new Error("QMD query failed: MCP and REST both unavailable, CLI fallback is disabled");
    }
    const cliStart = Date.now();
    try {
      const results = await this.queryViaCli(params);
      cliMs = Date.now() - cliStart;
      cliStatus = 'ok';
      finalizeBreakdown(Date.now() - qStart);
      return results;
    } catch (err) {
      cliMs = Date.now() - cliStart;
      cliStatus = 'fail';
      finalizeBreakdown(Date.now() - qStart);
      throw err;
    }
  }

  /**
   * Retrieve a single document by path or docid.
   */
  async get(file: string): Promise<string | null> {
    if (this.mcpAvailable !== false) {
      try {
        const data = await this.mcpCall("get", { file });
        const text = data?.result?.content?.[0]?.resource?.text
          ?? data?.result?.content?.[0]?.text;
        if (typeof text === "string") {
          this.mcpAvailable = true;
          this.clearRecovery();
          return text;
        }
      } catch {
        this.mcpAvailable = false;
        this.scheduleRecovery();
      }
    }

    if (!this.enableCliFallback) return null;

    try {
      const { stdout } = await execFileAsync("qmd", ["get", file], {
        timeout: this.cliTimeout,
      });
      return stdout || null;
    } catch {
      return null;
    }
  }

  /**
   * Batch retrieve multiple documents.
   */
  async multiGet(pattern: string): Promise<string[]> {
    if (this.mcpAvailable !== false) {
      try {
        const data = await this.mcpCall("multi_get", { pattern });
        const items = data?.result?.content ?? [];
        const result = items
          .filter((c: any) => c.type === "resource")
          .map((c: any) => c.resource?.text ?? "");
        this.mcpAvailable = true;
        this.clearRecovery();
        return result;
      } catch {
        this.mcpAvailable = false;
        this.scheduleRecovery();
      }
    }

    if (!this.enableCliFallback) return [];

    try {
      const { stdout } = await execFileAsync(
        "qmd", ["multi-get", pattern, "--format", "json"],
        { timeout: this.cliTimeout },
      );
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed.map((d: any) => d.body ?? "") : [];
    } catch {
      return [];
    }
  }

  /**
   * Quick health check against qmd MCP.
   */
  async ping(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.mcpBaseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * QMD index status — calls MCP tools/call for "status".
   * v1.1-10: MCP 不可用时降级到 `qmd status` CLI，避免 status() 永远返回 null。
   * Returns index health and collection info as a string.
   */
  async status(): Promise<string | null> {
    if (this.mcpAvailable !== false) {
      try {
        const data = await this.mcpCall("status", {}) as McpToolsCallResponse;
        const text = data?.result?.content?.[0]?.text;
        if (typeof text === "string") {
          this.mcpAvailable = true;
          this.clearRecovery();
          return text;
        }
      } catch (err) {
        this.mcpAvailable = false;
        this.scheduleRecovery();
        this.logger?.warn?.("[qmd-client] MCP status failed, falling back to CLI", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // v1.1-10: CLI fallback — `qmd status` outputs index info as text
    if (!this.enableCliFallback) return null;

    try {
      const { stdout } = await execFileAsync("qmd", ["status"], {
        timeout: this.cliTimeout,
      });
      return stdout || null;
    } catch (err) {
      this.logger?.debug?.("[qmd-client] qmd status CLI fallback failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ===================== internal — MCP path ==============================

  /** 判断错误是否由 session 过期/失效导致 */
  private isSessionExpiredError(resp: Response, body?: any): boolean {
    if (resp.status === 401 || resp.status === 403) return true;
    const statusText = resp.statusText?.toLowerCase() ?? '';
    if (statusText.includes('session') && statusText.includes('expired')) return true;
    if (statusText.includes('invalid') && statusText.includes('session')) return true;
    const errMsg = String(body?.error?.message ?? body?.error ?? '').toLowerCase();
    if (errMsg.includes('session') && (errMsg.includes('expired') || errMsg.includes('invalid') || errMsg.includes('closed'))) return true;
    return false;
  }

  /**
   * 通用 MCP 请求包装：自动处理 session 初始化 + 过期重连
   * @param toolName MCP tool 名称
   * @param args tool 参数
   * @param retried 内部使用，是否已经是重试（防止无限递归）
   */
  private async mcpCall(toolName: string, args: Record<string, unknown>, retried = false): Promise<any> {
    const t0 = Date.now();
    this.logger?.debug?.(`[qmd-client] mcpCall: tool=${toolName}, retried=${retried}, mcpAvailable=${this.mcpAvailable}, hasSession=${!!this.mcpSessionId}`);

    // 环节计时变量：在 catch 中用于定位超时发生在哪个环节。
    // 0 表示该环节未开始/未完成（失败时据此推断失败环节）。
    let initMs = 0;
    let fetchMs = 0;
    let parseMs = 0;

    try {
      // === 环节 1: initialize (session 握手) ===
      const initStart = Date.now();
      const sessionId = await this.mcpInitialize();
      initMs = Date.now() - initStart;

      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      };
      this.logger?.debug?.(`[qmd-client] POST ${this.mcpBaseUrl}/mcp (tools/call: ${toolName}), sessionId=${sessionId?.slice(0, 8)}..., initMs=${initMs}ms`);

      // === 环节 2: fetch (HTTP 请求 + 服务端处理) ===
      // 服务端处理包含: lex(BM25) + vec(embedding+ANN) + RRF + rerank(LLM)
      // 超时多发生在此环节（rerank LLM 调用慢 或 embedding 冷启动）
      const fetchStart = Date.now();
      // H1: 替换 AbortSignal.timeout() 为显式 setTimeout + clearTimeout，
      // 避免 AbortSignal.timeout() 创建的定时器在 Promise settle 后无法及时释放。
      let mcpFetchTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const mcpFetchTimeoutPromise = new Promise<never>((_, reject) => {
        mcpFetchTimeoutHandle = setTimeout(() => reject(new Error(`MCP fetch timeout (${this.mcpQueryTimeout}ms)`)), this.mcpQueryTimeout);
      });
      // 确保 timeout promise 的 rejection 被消费（避免 unhandled rejection）
      mcpFetchTimeoutPromise.catch(() => {});
      const resp = await Promise.race([
        fetch(`${this.mcpBaseUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify(body),
        }),
        mcpFetchTimeoutPromise,
      ]) as Response;
      if (mcpFetchTimeoutHandle !== undefined) clearTimeout(mcpFetchTimeoutHandle);
      fetchMs = Date.now() - fetchStart;

      this.logger?.debug?.(`[qmd-client] mcpCall response: status=${resp.status}, statusText=${resp.statusText}, contentType=${resp.headers?.get('content-type')}, initMs=${initMs}ms, fetchMs=${fetchMs}ms`);

      if (!resp.ok) {
        let respBody: any = null;
        try { respBody = await resp.json(); } catch (e) {
          this.logger?.debug?.(`[qmd-client] mcpCall non-ok response body parse failed`, { err: e instanceof Error ? e.message : String(e) });
        }
        this.logger?.debug?.(`[qmd-client] mcpCall non-ok response body`, { status: resp.status, body: respBody });

        if (!retried && this.isSessionExpiredError(resp, respBody)) {
          this.logger?.warn?.('[qmd-client] MCP session expired, reinitializing...');
          await this.mcpReinitialize();
          return this.mcpCall(toolName, args, true);
        }
        throw new Error(`MCP HTTP ${resp.status} ${resp.statusText}`);
      }

      // === 环节 3: parse (响应体解析: SSE 或 JSON) ===
      const contentType = resp.headers?.get('content-type') ?? '';
      let data: any;
      const parseStart = Date.now();
      if (contentType.includes('text/event-stream')) {
        // SSE 格式：解析 data: 行
        const text = await resp.text();
        const sseReadMs = Date.now() - parseStart;
        this.logger?.debug?.(`[qmd-client] mcpCall SSE response (len=${text.length}), parsing..., sseReadMs=${sseReadMs}ms`);
        const dataLines = text.split('\n').filter((l: string) => l.startsWith('data: ')).map((l: string) => l.slice(6));
        if (dataLines.length === 0) {
          throw new Error(`MCP SSE response has no data lines (len=${text.length})`);
        }
        try {
          data = JSON.parse(dataLines[dataLines.length - 1]);
          this.logger?.debug?.(`[qmd-client] mcpCall SSE parsed successfully, keys=${Object.keys(data ?? {}).join(',')}`);
        } catch (parseErr) {
          this.logger?.debug?.(`[qmd-client] mcpCall SSE parse failed`, { rawPreview: dataLines[dataLines.length - 1]?.slice(0, 200), err: String(parseErr) });
          throw new Error(`MCP SSE parse failed: ${String(parseErr)}`);
        }
      } else {
        try {
          data = await resp.json() as any;
          this.logger?.debug?.(`[qmd-client] mcpCall JSON parsed, keys=${Object.keys(data ?? {}).join(',')}, hasError=${!!data?.error}, hasResult=${!!data?.result}, parseMs=${Date.now() - parseStart}ms`);
        } catch (jsonErr) {
          // JSON 解析失败，可能是空响应或非 JSON 内容
          const rawText = await resp.text().catch(() => '');
          this.logger?.debug?.(`[qmd-client] mcpCall JSON parse failed`, { err: String(jsonErr), rawPreview: rawText.slice(0, 200) });
          throw new Error(`MCP response JSON parse failed: ${String(jsonErr)} (rawLen=${rawText.length})`);
        }
      }
      parseMs = Date.now() - parseStart;

      const totalMs = Date.now() - t0;
      // 慢查询 (>3s) 时输出 warn 级别，便于定位瓶颈
      if (totalMs > 3000) {
        this.logger?.warn?.(`[qmd-client] mcpCall slow: tool=${toolName}, total=${totalMs}ms (init=${initMs}ms, fetch=${fetchMs}ms, parse=${parseMs}ms)`);
      }

      if (data?.error && !retried) {
        if (this.isSessionExpiredError(resp, data)) {
          this.logger?.warn?.('[qmd-client] MCP session expired (from response error), reinitializing...', { errorMsg: data?.error?.message });
          await this.mcpReinitialize();
          return this.mcpCall(toolName, args, true);
        }
        this.logger?.debug?.(`[qmd-client] mcpCall response has error`, { error: data?.error });
        throw new Error(`MCP response error: ${data?.error?.message ?? JSON.stringify(data?.error)}`);
      }
      return data;
    } catch (err) {
      // 失败时输出各环节耗时，重点诊断超时场景。
      // 根据已完成的环节计时变量推断失败环节：
      //   initMs=0 → initialize 阶段失败
      //   fetchMs=0 → fetch 阶段失败（最常见超时点：服务端 rerank/embedding 慢）
      //   parseMs=0 → parse 阶段失败
      //   都>0     → post-parse（如 data.error 抛错）
      const totalMs = Date.now() - t0;
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|aborted/i.test(errMsg);
      let failedPhase: 'initialize' | 'fetch' | 'parse' | 'post-parse';
      if (initMs === 0) failedPhase = 'initialize';
      else if (fetchMs === 0) failedPhase = 'fetch';
      else if (parseMs === 0) failedPhase = 'parse';
      else failedPhase = 'post-parse';

      // 超时，或总耗时 >2s 的失败，都输出环节分解日志
      if (isTimeout || totalMs > 2000) {
        this.logger?.warn?.(
          `[qmd-client] mcpCall 失败环节诊断: tool=${toolName}, failedPhase=${failedPhase}, isTimeout=${isTimeout}, initMs=${initMs}ms, fetchMs=${fetchMs}ms, parseMs=${parseMs}ms, totalMs=${totalMs}ms, url=${this.mcpBaseUrl}/mcp`,
          {
            failedPhase,
            isTimeout,
            initMs,
            fetchMs,
            parseMs,
            totalMs,
            mcpTimeout: this.mcpTimeout,
            mcpQueryTimeout: this.mcpQueryTimeout,
            url: `${this.mcpBaseUrl}/mcp`,
            hasSession: !!this.mcpSessionId,
            err: errMsg,
          },
        );
      }
      throw err;
    }
  }

  /** Initialize MCP session via initialize handshake */
  private async mcpInitialize(): Promise<string> {
    if (this.mcpSessionId) return this.mcpSessionId;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInitialize().finally(() => { this._initPromise = null; });
    try {
      this.mcpSessionId = await this._initPromise;
      return this.mcpSessionId;
    } catch (err) {
      this._initPromise = null;
      throw err;
    }
  }

  /** 强制重新初始化 session（session 过期/服务重启时调用） */
  private async mcpReinitialize(): Promise<string> {
    this.mcpSessionId = null;
    this._initPromise = null;
    return this.mcpInitialize();
  }

  private async _doInitialize(): Promise<string> {
    const initUrl = `${this.mcpBaseUrl}/mcp`;
    this.logger?.debug?.(`[qmd-client] _doInitialize: POST ${initUrl} (initialize), timeout=${this.mcpTimeout}ms`);
    const initStart = Date.now();
    let resp: Response;
    try {
      // H1: 替换 AbortSignal.timeout() 为显式 setTimeout + clearTimeout
      let initTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const initTimeoutPromise = new Promise<never>((_, reject) => {
        initTimeoutHandle = setTimeout(() => reject(new Error(`MCP initialize timeout (${this.mcpTimeout}ms)`)), this.mcpTimeout);
      });
      initTimeoutPromise.catch(() => {});
      resp = await Promise.race([
        fetch(initUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {}, resources: {} },
              clientInfo: { name: "qmd-client", version: "1.0" },
            },
          }),
        }),
        initTimeoutPromise,
      ]) as Response;
      if (initTimeoutHandle !== undefined) clearTimeout(initTimeoutHandle);
    } catch (err) {
      // initialize 阶段失败（含超时）输出连接地址+端口，便于核实
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|aborted/i.test(errMsg);
      const elapsedMs = Date.now() - initStart;
      const initUrl = `${this.mcpBaseUrl}/mcp`;
      this.logger?.warn?.(
        `[qmd-client] _doInitialize 失败: isTimeout=${isTimeout}, elapsedMs=${elapsedMs}ms, mcpTimeout=${this.mcpTimeout}ms, url=${initUrl}`,
        {
          isTimeout,
          elapsedMs,
          mcpTimeout: this.mcpTimeout,
          url: initUrl,
          err: errMsg,
        },
      );
      throw err;
    }

    this.logger?.debug?.(`[qmd-client] _doInitialize response: status=${resp.status}, statusText=${resp.statusText}, contentType=${resp.headers?.get('content-type')}, elapsedMs=${Date.now() - initStart}ms`);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      this.logger?.debug?.(`[qmd-client] _doInitialize failed: HTTP ${resp.status}`, { errPreview: errText.slice(0, 300) });
      throw new Error(`MCP initialize HTTP ${resp.status} ${resp.statusText}`);
    }

    const sessionId = resp.headers?.get("mcp-session-id");
    if (!sessionId) {
      // 记录所有响应头，帮助排查为何缺少 mcp-session-id
      const allHeaders: Record<string, string> = {};
      resp.headers?.forEach((v: string, k: string) => { allHeaders[k] = v; });
      this.logger?.debug?.(`[qmd-client] _doInitialize: no mcp-session-id header`, { allHeaders, url: initUrl });
      throw new Error("MCP initialize: no mcp-session-id header in response");
    }

    this.logger?.debug?.(`[qmd-client] _doInitialize success: sessionId=${sessionId.slice(0, 8)}..., elapsedMs=${Date.now() - initStart}ms`);
    return sessionId;
  }

  /**
   * REST /query 模式 —— 直接 POST /query 调用 qmd store.search()，
   * 不经 MCP StreamableHTTP transport 层。
   * qmd server.ts 同时提供 REST /query（或 /search）端点，与 MCP /mcp 共用 store。
   *
   * @param avoidVec 为 true 时只保留 lex 子查询，避开 vec embed 路径。
   *   用于 MCP 失败原因是 embed 维度错误时，避免 REST 再次触发同样的错误。
   *   若过滤后无 lex 子查询，退化为使用原始所有子查询（保证不返回 0 结果的空操作）。
   */
  private async queryViaRest(params: SearchParams, avoidVec = false): Promise<QmdSearchResult[]> {
    const t0 = Date.now();
    // MCP embed 错误时降级为 lex-only（纯 BM25），避免再次触发 vec embed 错误
    let searches = params.searches;
    if (avoidVec) {
      const lexOnly = params.searches.filter((s) => s.type === "lex");
      if (lexOnly.length > 0) {
        searches = lexOnly;
      }
      // 若无 lex 子查询，保留原样（rest 端点会尝试 vec，可能再次失败 → 降级 CLI）
    }

    const body: Record<string, unknown> = {
      searches,
      limit: params.limit ?? 10,
      minScore: params.minScore ?? 0,
      // embed 错误场景下应禁用 rerank（rerank 可能依赖 vec 结果）
      rerank: avoidVec ? false : (params.rerank ?? true),
    };
    if (params.collections) body.collections = params.collections;
    if (params.intent) body.intent = params.intent;

    const searchTypes = searches.map((s) => s.type).join(',');
    this.logger?.debug?.(`[qmd-client] queryViaRest: POST ${this.mcpBaseUrl}/query (${searches.length} searches [${searchTypes}], avoidVec=${avoidVec}, rerank=${body.rerank})`);

    // 环节计时变量：catch 中用于定位超时环节
    let fetchMs = 0;
    let parseMs = 0;
    try {
      // === 环节 1: fetch (REST /query, 服务端处理) ===
      const fetchStart = Date.now();
      // H1: 替换 AbortSignal.timeout() 为显式 setTimeout + clearTimeout
      let restFetchTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const restFetchTimeoutPromise = new Promise<never>((_, reject) => {
        restFetchTimeoutHandle = setTimeout(() => reject(new Error(`REST fetch timeout (${this.mcpQueryTimeout}ms)`)), this.mcpQueryTimeout);
      });
      restFetchTimeoutPromise.catch(() => {});
      const resp = await Promise.race([
        fetch(`${this.mcpBaseUrl}/query`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        }),
        restFetchTimeoutPromise,
      ]) as Response;
      if (restFetchTimeoutHandle !== undefined) clearTimeout(restFetchTimeoutHandle);
      fetchMs = Date.now() - fetchStart;

      if (!resp.ok) {
        throw new Error(`REST /query HTTP ${resp.status} ${resp.statusText}`);
      }

      // === 环节 2: parse (JSON 解析) ===
      const parseStart = Date.now();
      const data = await resp.json() as { results?: Array<Record<string, unknown>> };
      parseMs = Date.now() - parseStart;

      const totalMs = Date.now() - t0;
      // 慢查询 (>3s) 时输出 warn 级别，便于定位瓶颈
      if (totalMs > 3000) {
        this.logger?.warn?.(`[qmd-client] queryViaRest slow: total=${totalMs}ms (fetch=${fetchMs}ms, parse=${parseMs}ms), searchTypes=[${searchTypes}], rerank=${body.rerank}`);
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      if (results.length === 0) return [];

      return results.map((r) => ({
        docid: typeof r.docid === "string" ? r.docid : "",
        file: typeof r.file === "string" ? r.file : "",
        title: typeof r.title === "string" ? r.title : "",
        score: typeof r.score === "number" ? r.score : 0,
        snippet: typeof r.snippet === "string" ? r.snippet : "",
        line: typeof r.line === "number" ? r.line : 0,
        context: typeof r.context === "string" ? r.context : null,
      }));
    } catch (err) {
      // 失败时输出各环节耗时，定位超时环节
      const totalMs = Date.now() - t0;
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|aborted/i.test(errMsg);
      // REST 仅有 fetch + parse 两个环节
      let failedPhase: 'fetch' | 'parse' | 'post-parse';
      if (fetchMs === 0) failedPhase = 'fetch';
      else if (parseMs === 0) failedPhase = 'parse';
      else failedPhase = 'post-parse';

      if (isTimeout || totalMs > 2000) {
        this.logger?.warn?.(
          `[qmd-client] queryViaRest 失败环节诊断: failedPhase=${failedPhase}, isTimeout=${isTimeout}, fetchMs=${fetchMs}ms, parseMs=${parseMs}ms, totalMs=${totalMs}ms, url=${this.mcpBaseUrl}/query`,
          {
            failedPhase,
            isTimeout,
            fetchMs,
            parseMs,
            totalMs,
            mcpQueryTimeout: this.mcpQueryTimeout,
            url: `${this.mcpBaseUrl}/query`,
            searchTypes,
            rerank: body.rerank,
            avoidVec,
            err: errMsg,
          },
        );
      }
      throw err;
    }
  }

  private async queryViaMcp(params: SearchParams): Promise<QmdSearchResult[]> {
    const t0 = Date.now();
    const args: Record<string, unknown> = {
      searches: params.searches,
      limit: params.limit ?? 10,
      minScore: params.minScore ?? 0,
      rerank: params.rerank ?? true,
    };
    if (params.collections) args.collections = params.collections;
    if (params.intent) args.intent = params.intent;

    const searchTypes = params.searches.map((s) => s.type).join(',');
    this.logger?.debug?.(`[qmd-client] queryViaMcp: searches=${params.searches.length} (${searchTypes}), limit=${args.limit}, minScore=${args.minScore}, rerank=${args.rerank}`);
    let data: McpToolsCallResponse;
    try {
      data = await this.mcpCall("query", args) as McpToolsCallResponse;
    } catch (err) {
      // 超时时补充 query 上下文（环节分解见 mcpCall 失败环节诊断日志）
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|aborted/i.test(errMsg);
      if (isTimeout) {
        this.logger?.warn?.(`[qmd-client] MCP query 超时 (query 上下文): 环节分解见上一条 mcpCall 失败诊断日志`, {
          totalMs: Date.now() - t0,
          mcpQueryTimeout: this.mcpQueryTimeout,
          url: `${this.mcpBaseUrl}/mcp`,
          hasSessionBefore: !!this.mcpSessionId,
          searchTypes,
          rerank: args.rerank,
          searchesCount: params.searches.length,
          limit: args.limit,
        });
      }
      throw err;
    }
    const mcpCallMs = Date.now() - t0;
    const contentArr = data?.result?.content;
    const textContent = contentArr?.[0]?.text;
    this.logger?.debug?.(`[qmd-client] queryViaMcp response: mcpCallMs=${mcpCallMs}ms, contentArr=${Array.isArray(contentArr) ? contentArr.length : 'N/A'} items, textContentLen=${textContent?.length ?? 0}, isError=${data?.result?.isError}`);
    if (!textContent) {
      // 记录响应结构帮助排查空响应问题
      this.logger?.debug?.(`[qmd-client] queryViaMcp: empty textContent`, { 
        hasResult: !!data?.result, 
        hasContent: !!contentArr, 
        contentTypes: Array.isArray(contentArr) ? contentArr.map((c: any) => c?.type).join(',') : 'N/A',
        rawPreview: JSON.stringify(data)?.slice(0, 300),
      });
      throw new Error("MCP query returned empty response");
    }

    // MCP 返回错误时（如 vec/hyde 不支持 -term 否定语法），textContent 是错误描述而非 JSON。
    // 抛错触发 query() 中的降级链（REST → CLI），避免静默丢失 L2 检索结果。
    // 修复前为 return [] —— 绕过降级链导致 l2_count:0 即使 lex 子查询本可成功。
    if (data?.result?.isError) {
      const errText = textContent.slice(0, 200);
      this.logger?.warn?.(`[qmd-client] MCP query returned error: ${errText}`);
      throw new Error(`MCP query returned error: ${errText}`);
    }

    let raw: Array<{
      docid?: string; file?: string; title?: string;
      score?: number; snippet?: string; line?: number; context?: string | null;
    }> = [];
    try {
      const parsed = JSON.parse(textContent);
      if (Array.isArray(parsed)) raw = parsed;
    } catch (e) {
      // Non-JSON response (e.g. "No results found"), treat as empty
      this.logger?.debug?.(`[qmd-client] search response parse failed, treating as empty`, { err: e instanceof Error ? e.message : String(e) });
    }

    if (raw.length === 0) {
      return [];
    }

    return raw.map((r) => ({
      docid: r.docid ?? "",
      file: r.file ?? "",
      title: r.title ?? "",
      score: r.score ?? 0,
      snippet: r.snippet ?? "",
      line: r.line ?? 0,
      context: r.context ?? null,
    }));
  }

  /**
   * v2.5.0: MCP context size 错误的渐进降级重试。
   *
   * 当服务端返回 "documents exceed the context size" 时，说明 embedding 模型在拼接
   * 查询+文档时超出了 context window。此时分两步渐进尝试（不标记 MCP 不可用）：
   *
   *   1. rerank=false — rerank 步骤最可能将全文文档与查询拼接嵌入，跳过它可能避开超限
   *   2. lex-only    — 纯 BM25 检索完全不走 embedding，不受 context size 限制
   *
   * 返回 null 表示所有重试均失败，调用方应继续降级到 REST。
   */
  private async _retryMcpContextSize(
    params: SearchParams,
    originalErr: string,
  ): Promise<QmdSearchResult[] | null> {
    const hasLex = params.searches.some((s) => s.type === "lex");
    const hasVecOrHyde = params.searches.some((s) => s.type === "vec" || s.type === "hyde");

    // Step 1: 重试 rerank=false（仅当有 vec/hyde 查询且原请求开启了 rerank 时才有意义）
    if (hasVecOrHyde && params.rerank !== false) {
      this.logger.warn(
        "[qmd-client] MCP context size exceeded, retrying with rerank=false",
        { err: originalErr.slice(0, 120) },
      );
      try {
        const noRerankParams = { ...params, rerank: false };
        const results = await this.queryViaMcp(noRerankParams);
        this.logger.info("[qmd-client] MCP retry with rerank=false succeeded");
        return results;
      } catch (retryErr) {
        const retryMsg = (retryErr as Error).message;
        if (/context.?size|exceed.*(?:context|length)/i.test(retryMsg)) {
          this.logger.warn(
            "[qmd-client] MCP rerank=false still context size exceeded, trying lex-only",
            { err: retryMsg.slice(0, 120) },
          );
        } else {
          // 非 context size 错误（如超时），不再继续重试
          this.logger.warn(
            "[qmd-client] MCP rerank=false retry failed with non-context-size error, aborting retries",
            { err: retryMsg.slice(0, 120) },
          );
          return null;
        }
      }
    }

    // Step 2: 重试 lex-only（纯 BM25，不需要 embedding）
    if (hasLex) {
      this.logger.warn("[qmd-client] MCP retrying lex-only (BM25, no embedding)");
      try {
        const lexOnly = params.searches.filter((s) => s.type === "lex");
        const lexParams: SearchParams = {
          ...params,
          searches: lexOnly,
          rerank: false,
        };
        const results = await this.queryViaMcp(lexParams);
        this.logger.info("[qmd-client] MCP lex-only retry succeeded");
        return results;
      } catch (retryErr) {
        this.logger.warn(
          "[qmd-client] MCP lex-only retry also failed, falling back to REST",
          { err: (retryErr as Error).message.slice(0, 120) },
        );
      }
    }

    return null;
  }

  // ===================== internal — CLI path ==============================

  private async queryViaCli(params: SearchParams): Promise<QmdSearchResult[]> {
    const { cmd, args } = this.buildCliCommand(params);
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: this.cliTimeout,
    });

    const parsed: unknown[] = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      throw new Error("CLI output is not a JSON array");
    }

    return parsed.map((r: any) => ({
      docid: r.docid ?? r.id ?? "",
      file: r.file ?? "",
      title: r.title ?? "",
      score: r.score ?? 0,
      snippet: r.snippet ?? "",
      line: r.line ?? 0,
      context: r.context ?? null,
    }));
  }

  /** Build the appropriate CLI command based on search params. */
  private buildCliCommand(params: SearchParams): { cmd: string; args: string[] } {
    const n = String(params.limit ?? 10);
    const hasLex = params.searches.some((s) => s.type === "lex");
    const hasVec = params.searches.some((s) => s.type === "vec");
    const hasHyde = params.searches.some((s) => s.type === "hyde");
    const withRerank = params.rerank ?? true;

    // Pure lex -> qmd search
    // qmd search 是纯 BM25 检索，无 LLM rerank 步骤，--no-rerank 参数无效
    if (hasLex && !hasVec && !hasHyde) {
      // SEC-L: 修复前 `find(...).query!` 非空断言。虽然 hasLex 已确认存在，但显式检查更稳健。
      const lexEntry = params.searches.find((s) => s.type === "lex");
      const query = lexEntry?.query ?? "";
      const args = ["search", query, "-n", n, "--format", "json"];
      return { cmd: "qmd", args };
    }

    // Pure vec -> qmd vsearch
    if (hasVec && !hasLex && !hasHyde) {
      const vecEntry = params.searches.find((s) => s.type === "vec");
      const query = vecEntry?.query ?? "";
      return { cmd: "qmd", args: ["vsearch", query, "-n", n, "--format", "json"] };
    }

    // Mixed -> use search (lightweight) if cliFallbackSearchType is "search"
    // qmd search 纯 BM25，--no-rerank 无效，不添加
    if (this.cliFallbackSearchType === 'search') {
      const lexQuery = params.searches.find((s) => s.type === "lex")?.query ?? "";
      const args = ["search", lexQuery, "-n", n, "--format", "json"];
      return { cmd: "qmd", args };
    }

    // Mixed -> build typed query document (full hybrid)
    const lines: string[] = [];
    if (params.intent) {
      lines.push(`intent: ${params.intent}`);
    }
    for (const s of params.searches) {
      lines.push(`${s.type}: ${s.query}`);
    }

    // SEC M-15: 修复前 lines.join("\\n") 是字面量反斜杠+n（2 字符），
    // 多检索 CLI fallback 收到 "lex:q\nvec:q" 单行文本而非多行，导致解析失败。
    // 改为真实换行符 "\n"。
    const queryStr = lines.join("\n");
    const args = ["query", queryStr, "-n", n, "--format", "json"];
    if (!withRerank) args.push("--no-rerank");
    return { cmd: "qmd", args };
  }

  // ===================== recovery =========================================

  private scheduleRecovery(): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(async () => {
      try {
        const ok = await this.ping();
        if (ok) {
          // /health 可达意味着 qmd 服务在线，MCP /mcp 应可达。
          // REST 仅作 MCP 失败的备选，保持 undetermined (null)，下次 query 时按需探测。
          this.mcpAvailable = true;
          this.lastMcpErrorIsEmbed = false; // 恢复 MCP 时清除 embed 错误标记
          this._vecContextErrorCount = 0;   // v2.5.0: 恢复时重置 context size 计数器
          this._vecAutoDisabled = false;    // v2.5.0: 恢复时重新启用 vec 搜索
          this._emptyResultCount = 0;       // O6: 恢复时重置空结果计数器
          this.mcpSessionId = null;
          this.clearRecovery();
          this.logger.info("[qmd-client] QMD MCP service recovered, switching back to MCP");
        } else {
          this.scheduleRecovery(); // retry
        }
      } catch {
        this.scheduleRecovery();
      }
    }, this.pingInterval);
  }

  private clearRecovery(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /**
   * 释放客户端持有的资源（recoveryTimer 等）。
   * SEC-2 H-8: 调用方应在 finally 块中调用以避免定时器泄漏。
   */
  dispose(): void {
    this.clearRecovery();
  }
}
