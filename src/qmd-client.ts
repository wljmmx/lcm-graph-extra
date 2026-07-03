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
        if (_mcpErr.includes("circuit breaker")) {
          this.logger.warn("[qmd-client] MCP circuit breaker OPEN, falling back to CLI");
        } else if (_mcpErr.includes("HTTP")) {
          this.logger.warn("[qmd-client] MCP service error (" + _mcpErr + "), falling back to CLI");
        } else if (_mcpErr.includes("empty response")) {
          this.logger.warn("[qmd-client] MCP query returned no results, falling back to CLI");
        } else {
          this.logger.warn("[qmd-client] MCP query failed, falling back to CLI", { err: _mcpErr });
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
        const body = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get", arguments: { file } },
        };
        const resp = await fetch(`${this.mcpBaseUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "mcp-session-id": await this.mcpInitialize(),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.mcpTimeout),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          const text = data?.result?.content?.[0]?.resource?.text
            ?? data?.result?.content?.[0]?.text;
          if (typeof text === "string") return text;
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
        const body = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "multi_get", arguments: { pattern } },
        };
        const resp = await fetch(`${this.mcpBaseUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "mcp-session-id": await this.mcpInitialize(),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.mcpTimeout),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          const items = data?.result?.content ?? [];
          return items
            .filter((c: any) => c.type === "resource")
            .map((c: any) => c.resource?.text ?? "");
        }
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
   * Returns index health and collection info as a string.
   */
  async status(): Promise<string | null> {
    try {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      };
      const resp = await fetch(`${this.mcpBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "mcp-session-id": await this.mcpInitialize(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.mcpTimeout),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as McpToolsCallResponse;
      const text = data?.result?.content?.[0]?.text;
      return typeof text === "string" ? text : null;
    } catch {
      return null;
    }
  }

  // ===================== internal — MCP path ==============================

  /** Initialize MCP session via initialize handshake */
  private async mcpInitialize(): Promise<string> {
    if (this.mcpSessionId) return this.mcpSessionId;

    const resp = await fetch(`${this.mcpBaseUrl}/mcp`, {
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

    if (!resp.ok) throw new Error(`MCP initialize HTTP ${resp.status}`);

    const sessionId = resp.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP initialize: no mcp-session-id header");

    this.mcpSessionId = sessionId;
    return sessionId;
  }

  private async queryViaMcp(params: SearchParams): Promise<QmdSearchResult[]> {
    const sessionId = await this.mcpInitialize();
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "query",
        arguments: {
          searches: params.searches,
          limit: params.limit ?? 10,
          minScore: params.minScore ?? 0,
          rerank: params.rerank ?? true,
        } as Record<string, unknown>,
      },
    };
    if (params.collections) (body.params.arguments as Record<string, unknown>).collections = params.collections;
    if (params.intent) (body.params.arguments as Record<string, unknown>).intent = params.intent;

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

    if (!resp.ok) {
      throw new Error(`MCP HTTP ${resp.status}`);
    }

    const data = await resp.json() as McpToolsCallResponse;
    const textContent = data?.result?.content?.[0]?.text;
    if (!textContent) {
      throw new Error("MCP query returned empty response");
    }

    let raw: Array<{
      docid?: string; file?: string; title?: string;
      score?: number; snippet?: string; line?: number; context?: string | null;
    }> = [];
    try {
      const parsed = JSON.parse(textContent);
      if (Array.isArray(parsed)) raw = parsed;
    } catch {
      // Non-JSON response (e.g. "No results found"), treat as empty
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
      const query = params.searches.find((s) => s.type === "lex")!.query;
      const args = ["search", query, "-n", n, "--format", "json"];
      if (!withRerank) args.push("--no-rerank");
      return { cmd: "qmd", args };
    }

    // Pure vec -> qmd vsearch
    if (hasVec && !hasLex && !hasHyde) {
      const query = params.searches.find((s) => s.type === "vec")!.query;
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

    const queryStr = lines.join("\\n");
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
}
