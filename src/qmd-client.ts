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
  /** P3-B3: 注入统一 logger；未提供时降级到 globalLogger。 */
  logger?: Logger;
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
  // 设为 8000ms 覆盖冷启动场景，避免首次查询永远超时 → 降级 REST。
  mcpQueryTimeout: 8000,
  cliTimeout: 30_000,
  // P2-B1: 混合搜索（lex+vec）降级时，默认走完整 hybrid 路径（qmd query 多行 typed query），
  // 而非 'search'（纯文本，丢失向量部分）。仅在显式配置 'search' 时才用轻量降级。
  cliFallbackSearchType: 'hybrid' as 'hybrid' | 'search',
  pingInterval: 30_000,
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
  /** P3-B3: 统一 logger，替换散落的 console.* 调用 */
  private readonly logger: Logger;

  /** null = undetermined, true = REST可用, false = REST不可用 */
  private restAvailable: boolean | null = null;
  /** null = undetermined, true = MCP可用, false = MCP不可用 */
  private mcpAvailable: boolean | null = null;
  /** 最近一次 MCP 失败是否为 embed 维度错误（用于决定 REST 降级是否避开 vec） */
  private lastMcpErrorIsEmbed = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: QmdClientOptions = {}) {
    this.mcpBaseUrl = opts.mcpBaseUrl ?? DEFAULTS.mcpBaseUrl;
    this.mcpTimeout = opts.mcpTimeout ?? DEFAULTS.mcpTimeout;
    this.mcpQueryTimeout = opts.mcpQueryTimeout ?? DEFAULTS.mcpQueryTimeout;
    this.cliTimeout = opts.cliTimeout ?? DEFAULTS.cliTimeout;
    this.cliFallbackSearchType = opts.cliFallbackSearchType ?? DEFAULTS.cliFallbackSearchType;
    this.pingInterval = opts.pingInterval ?? DEFAULTS.pingInterval;
    this.logger = resolveLogger(opts.logger);
  }

  // ===================== public API =======================================

  /**
   * Hybrid search — MCP first, REST fallback (lex-only), CLI last resort.
   * Results are normalised to QmdSearchResult[] regardless of source.
   */
  async query(params: SearchParams): Promise<QmdSearchResult[]> {
    // 清理 searches 中每个 query 的换行符。
    // qmd structured search (lex 模式) 不支持多行查询，含 \n/\r 会报错：
    //   "Structured search (lex): queries must be single-line. Remove newline characters."
    // vec/hyde 模式同样做清理以保持一致，避免将原始多行用户消息直接传入。
    // 处理：将 \r\n / \n / \r 替换为单个空格，并 trim 首尾空白。
    if (Array.isArray(params.searches)) {
      params = {
        ...params,
        searches: params.searches.map((s) => ({
          ...s,
          query: typeof s.query === 'string'
            ? s.query.replace(/\r\n|\n|\r/g, ' ').replace(/\s+/g, ' ').trim()
            : s.query,
        })),
      };
    }
    // 1. MCP 优先 — 完整 hybrid 搜索能力（lex+vec+hyde + SDK 自动展开 + RRF + rerank）
    if (this.mcpAvailable !== false) {
      try {
        const results = await this.queryViaMcp(params);
        this.mcpAvailable = true;
        this.clearRecovery();
        return results;
      } catch (err) {
        this.mcpAvailable = false;
        this.scheduleRecovery();
        const _mcpErr = (err as Error).message;
        const _mcpStack = (err as Error).stack;
        // 判断是否 embed 维度错误（REST 降级时需避开 vec）
        const isEmbedError = /dimension|embedding|mismatch/i.test(_mcpErr);
        this.lastMcpErrorIsEmbed = isEmbedError;
        if (isEmbedError) {
          this.logger.warn("[qmd-client] MCP embed error (likely model dim mismatch), falling back to REST lex-only", { err: _mcpErr });
        } else if (_mcpErr.includes("circuit breaker")) {
          this.logger.warn("[qmd-client] MCP circuit breaker OPEN, falling back to REST");
        } else if (_mcpErr.includes("HTTP")) {
          this.logger.warn("[qmd-client] MCP service error (" + _mcpErr + "), falling back to REST");
        } else if (_mcpErr.includes("empty response")) {
          this.logger.warn("[qmd-client] MCP query returned no results, falling back to REST");
        } else if (_mcpErr.includes("timeout") || _mcpErr.includes("Timeout") || _mcpErr.includes("aborted")) {
          this.logger.warn("[qmd-client] MCP query timeout, falling back to REST", { err: _mcpErr, mcpQueryTimeout: this.mcpQueryTimeout });
        } else if (_mcpErr.includes("fetch failed") || _mcpErr.includes("ECONNREFUSED") || _mcpErr.includes("ECONNRESET")) {
          this.logger.warn("[qmd-client] MCP connection failed, falling back to REST", { err: _mcpErr, baseUrl: this.mcpBaseUrl });
        } else {
          this.logger.warn("[qmd-client] MCP query failed, falling back to REST", { err: _mcpErr, stack: _mcpStack?.split('\n').slice(0, 5).join(' | ') });
        }
      }
    }

    // 2. REST /query 备选 — 仅在 MCP 失败后启用。
    //    若 MCP 失败是 embed 维度错误，REST 降级为 lex-only 避免再次触发 vec embed 错误。
    if (this.restAvailable !== false) {
      try {
        const results = await this.queryViaRest(params, this.lastMcpErrorIsEmbed);
        this.restAvailable = true;
        this.clearRecovery();
        return results;
      } catch (err) {
        this.restAvailable = false;
        const msg = (err as Error).message;
        if (msg.includes("timeout") || msg.includes("aborted")) {
          this.logger.warn("[qmd-client] REST /query timeout, falling back to CLI", { err: msg, timeout: this.mcpQueryTimeout });
        } else if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
          this.logger.warn("[qmd-client] REST /query connection failed, falling back to CLI", { err: msg, baseUrl: this.mcpBaseUrl });
        } else {
          this.logger.warn("[qmd-client] REST /query failed, falling back to CLI", { err: msg });
        }
      }
    }

    // 3. CLI 兜底
    return this.queryViaCli(params);
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
    this.logger?.debug?.(`[qmd-client] mcpCall: tool=${toolName}, retried=${retried}, mcpAvailable=${this.mcpAvailable}, hasSession=${!!this.mcpSessionId}`);
    const sessionId = await this.mcpInitialize();
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };
    this.logger?.debug?.(`[qmd-client] POST ${this.mcpBaseUrl}/mcp (tools/call: ${toolName}), sessionId=${sessionId?.slice(0, 8)}...`);
    const resp = await fetch(`${this.mcpBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.mcpQueryTimeout),
    });

    this.logger?.debug?.(`[qmd-client] mcpCall response: status=${resp.status}, statusText=${resp.statusText}, contentType=${resp.headers?.get('content-type')}`);

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

    // 检查 content-type：MCP 可能返回 SSE 格式（text/event-stream）而非 JSON
    const contentType = resp.headers?.get('content-type') ?? '';
    let data: any;
    if (contentType.includes('text/event-stream')) {
      // SSE 格式：解析 data: 行
      const text = await resp.text();
      this.logger?.debug?.(`[qmd-client] mcpCall SSE response (len=${text.length}), parsing...`);
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
        this.logger?.debug?.(`[qmd-client] mcpCall JSON parsed, keys=${Object.keys(data ?? {}).join(',')}, hasError=${!!data?.error}, hasResult=${!!data?.result}`);
      } catch (jsonErr) {
        // JSON 解析失败，可能是空响应或非 JSON 内容
        const rawText = await resp.text().catch(() => '');
        this.logger?.debug?.(`[qmd-client] mcpCall JSON parse failed`, { err: String(jsonErr), rawPreview: rawText.slice(0, 200) });
        throw new Error(`MCP response JSON parse failed: ${String(jsonErr)} (rawLen=${rawText.length})`);
      }
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
    const resp = await fetch(initUrl, {
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
      signal: AbortSignal.timeout(this.mcpTimeout),
    });

    this.logger?.debug?.(`[qmd-client] _doInitialize response: status=${resp.status}, statusText=${resp.statusText}, contentType=${resp.headers?.get('content-type')}`);

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

    this.logger?.debug?.(`[qmd-client] _doInitialize success: sessionId=${sessionId.slice(0, 8)}...`);
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

    this.logger?.debug?.(`[qmd-client] queryViaRest: POST ${this.mcpBaseUrl}/query (${searches.length} searches, avoidVec=${avoidVec})`);
    const resp = await fetch(`${this.mcpBaseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.mcpQueryTimeout),
    });

    if (!resp.ok) {
      throw new Error(`REST /query HTTP ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json() as { results?: Array<Record<string, unknown>> };
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
  }

  private async queryViaMcp(params: SearchParams): Promise<QmdSearchResult[]> {
    const args: Record<string, unknown> = {
      searches: params.searches,
      limit: params.limit ?? 10,
      minScore: params.minScore ?? 0,
      rerank: params.rerank ?? true,
    };
    if (params.collections) args.collections = params.collections;
    if (params.intent) args.intent = params.intent;

    this.logger?.debug?.(`[qmd-client] queryViaMcp: searches=${params.searches.length}, limit=${args.limit}, minScore=${args.minScore}`);
    const data = await this.mcpCall("query", args) as McpToolsCallResponse;
    const contentArr = data?.result?.content;
    const textContent = contentArr?.[0]?.text;
    this.logger?.debug?.(`[qmd-client] queryViaMcp response: contentArr=${Array.isArray(contentArr) ? contentArr.length : 'N/A'} items, textContentLen=${textContent?.length ?? 0}, isError=${data?.result?.isError}`);
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

    // MCP 返回错误时，textContent 是错误描述而非 JSON，直接返回空结果
    if (data?.result?.isError) {
      this.logger?.warn?.(`[qmd-client] MCP query returned error: ${textContent.slice(0, 200)}`);
      return [];
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
    if (hasLex && !hasVec && !hasHyde) {
      // SEC-L: 修复前 `find(...).query!` 非空断言。虽然 hasLex 已确认存在，但显式检查更稳健。
      const lexEntry = params.searches.find((s) => s.type === "lex");
      const query = lexEntry?.query ?? "";
      const args = ["search", query, "-n", n, "--format", "json"];
      if (!withRerank) args.push("--no-rerank");
      return { cmd: "qmd", args };
    }

    // Pure vec -> qmd vsearch
    if (hasVec && !hasLex && !hasHyde) {
      const vecEntry = params.searches.find((s) => s.type === "vec");
      const query = vecEntry?.query ?? "";
      return { cmd: "qmd", args: ["vsearch", query, "-n", n, "--format", "json"] };
    }

    // Mixed -> use search (lightweight) if cliFallbackSearchType is "search"
    if (this.cliFallbackSearchType === 'search') {
      const lexQuery = params.searches.find((s) => s.type === "lex")?.query ?? "";
      const args = ["search", lexQuery, "-n", n, "--format", "json"];
      if (!withRerank) args.push("--no-rerank");
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
