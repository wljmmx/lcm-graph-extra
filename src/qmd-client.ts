/**
 * QmdClient — unified search client for QMD (MCP REST优先, CLI降级)
 *
 * Priority: MCP HTTP → CLI (child_process) → throw
 * Auto-recovery: 降级后定期 ping MCP, 恢复后自动切回
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
  mcpTimeout?: number;
  cliTimeout?: number;
  pingInterval?: number;
  cliFallbackSearchType?: 'search' | 'vsearch';
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

const DEFAULTS = {
  mcpBaseUrl: "http://127.0.0.1:8081",
  mcpTimeout: 5000,
  cliTimeout: 30_000,
  cliFallbackSearchType: 'search',
  pingInterval: 30_000,
};

// ---------------------------------------------------------------------------
// QmdClient
// ---------------------------------------------------------------------------

export class QmdClient {
  private readonly mcpBaseUrl: string;
  private readonly mcpTimeout: number;
  private mcpSessionId: string | null = null;
  /** inflight initialize promise 去重，防止并发初始化创建多个 session */
  private _initPromise: Promise<string> | null = null;
  private readonly cliTimeout: number;
  private readonly cliFallbackSearchType: string;
  private readonly pingInterval: number;
  /** P3-B3: 统一 logger，替换散落的 console.* 调用 */
  private readonly logger: Logger;

  /** null = undetermined, true = MCP可用, false = MCP不可用 */
  private mcpAvailable: boolean | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: QmdClientOptions = {}) {
    this.mcpBaseUrl = opts.mcpBaseUrl ?? DEFAULTS.mcpBaseUrl;
    this.mcpTimeout = opts.mcpTimeout ?? DEFAULTS.mcpTimeout;
    this.cliTimeout = opts.cliTimeout ?? DEFAULTS.cliTimeout;
    this.cliFallbackSearchType = opts.cliFallbackSearchType ?? DEFAULTS.cliFallbackSearchType;
    this.pingInterval = opts.pingInterval ?? DEFAULTS.pingInterval;
    this.logger = resolveLogger(opts.logger);
  }

  // ===================== public API =======================================

  /**
   * Hybrid search — MCP REST first, falls back to CLI on failure.
   * Results are normalised to QmdSearchResult[] regardless of source.
   */
  async query(params: SearchParams): Promise<QmdSearchResult[]> {
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
        if (_mcpErr.includes("circuit breaker")) {
          this.logger.warn("[qmd-client] MCP circuit breaker OPEN, falling back to CLI");
        } else if (_mcpErr.includes("HTTP")) {
          this.logger.warn("[qmd-client] MCP service error (" + _mcpErr + "), falling back to CLI");
        } else if (_mcpErr.includes("empty response")) {
          this.logger.warn("[qmd-client] MCP query returned no results, falling back to CLI");
        } else if (_mcpErr.includes("timeout") || _mcpErr.includes("Timeout") || _mcpErr.includes("aborted")) {
          this.logger.warn("[qmd-client] MCP query timeout, falling back to CLI", { err: _mcpErr, timeout: this.mcpTimeout });
        } else if (_mcpErr.includes("fetch failed") || _mcpErr.includes("ECONNREFUSED") || _mcpErr.includes("ECONNRESET")) {
          this.logger.warn("[qmd-client] MCP connection failed, falling back to CLI", { err: _mcpErr, baseUrl: this.mcpBaseUrl });
        } else {
          this.logger.warn("[qmd-client] MCP query failed, falling back to CLI", { err: _mcpErr, stack: _mcpStack?.split('\n').slice(0, 5).join(' | ') });
        }
      }
    }

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
      signal: AbortSignal.timeout(this.mcpTimeout),
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
          this.mcpAvailable = true;
          this.mcpSessionId = null;
          this.clearRecovery();
          this.logger.info("[qmd-client] MCP recovered, switching back");
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
