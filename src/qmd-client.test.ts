/**
 * QmdClient — 单元测试
 *
 * 使用 vi.mock 模拟 fetch 和 execFile
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QmdClient, QmdSearchResult } from "./qmd-client";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    // Call the callback-based execFile, not promisified
    const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    mockExecFile(...args);
    const result = { stdout: "[]", stderr: "" };
    const error = null;
    // Simulate async
    setTimeout(() => cb(error, result), 10);
    return { on: vi.fn() };
  },
}));

// Mock global fetch
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// P1-12 FAIL-3: 修复 mock 以匹配实际 MCP 协议（initialize + tools/call 两步）。
// 原 mockMcpOk 只 mock 一次响应且 body 是 { results: [...] }，但 QmdClient.queryViaMcp
// 先发 initialize 请求（期望 mcp-session-id header），再发 tools/call 请求（期望
// { result: { content: [{ text: JSON.stringify(results) }] } }）。
function mockMcpOk(body: unknown): void {
  // 1st call: initialize response (with session id header)
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: (name: string) => name === "mcp-session-id" ? "test-session-1" : null },
    json: async () => ({ jsonrpc: "2.0", id: "init", result: {} }),
  } as Response);
  // 2nd call: tools/call response (body wrapped in MCP content format)
  const results = body && (body as any).results ? (body as any).results : body;
  const text = JSON.stringify(results);
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
  } as Response);
}

function mockMcpFail(status = 500): void {
  // initialize succeeds, tools/call fails
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: (name: string) => name === "mcp-session-id" ? "test-session-1" : null },
    json: async () => ({ jsonrpc: "2.0", id: "init", result: {} }),
  } as Response);
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({}),
  } as Response);
}

function mockMcpTimeout(): void {
  mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
}

// REST /query mocks —— QmdClient 优先用 REST /query，需先 mock REST 行为
function mockRestOk(body: unknown): void {
  const results = body && (body as any).results ? (body as any).results : body;
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ results: Array.isArray(results) ? results : [] }),
  } as Response);
}

function mockRestFail(status = 500): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({}),
  } as Response);
}

function mockRestTimeout(): void {
  mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
}

function mockCliOk(stdout: string): void {
  mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    setTimeout(() => cb(null, { stdout, stderr: "" }), 10);
  });
}

function mockCliFail(msg = "CLI error"): void {
  mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    setTimeout(() => cb(new Error(msg), { stdout: "", stderr: msg }), 10);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QmdClient", () => {
  let client: QmdClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QmdClient({ pingInterval: 999_999 }); // disable auto-recovery timer
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===================== query ============================================

  describe("query()", () => {
    it("returns results from MCP on success", async () => {
      // REST /query 先失败，从而走 MCP 路径
      mockRestFail(500);
      mockMcpOk({
        results: [
          {
            docid: "#abc",
            file: "test.md",
            title: "Test",
            score: 0.95,
            snippet: "hello world",
            line: 10,
            context: "memory",
          },
        ],
      });

      const results = await client.query({
        searches: [{ type: "lex", query: "hello" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        docid: "#abc",
        file: "test.md",
        score: 0.95,
      });
      // REST(1) + MCP initialize(1) + MCP tools/call(1) = 3 次 fetch
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("falls back to CLI when MCP fails with HTTP error", async () => {
      mockRestFail(500); // REST 先失败
      mockMcpFail(503);
      mockCliOk(JSON.stringify([
        { docid: "#def", file: "fallback.md", title: "Fallback", score: 0.8, snippet: "cli result", line: 5, context: null },
      ]));

      const results = await client.query({
        searches: [{ type: "lex", query: "fallback" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#def");
    });

    it("falls back to CLI when MCP times out", async () => {
      mockRestFail(500); // REST 先失败（非超时），快速降级到 MCP
      mockMcpTimeout(); // MCP initialize 超时
      mockCliOk(JSON.stringify([
        { docid: "#timeout", file: "t.md", title: "Timeout", score: 0.5, snippet: "", line: 1, context: null },
      ]));

      const results = await client.query({
        searches: [{ type: "lex", query: "timeout" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#timeout");
    });

    it("throws when both MCP and CLI fail", async () => {
      mockRestFail(500); // REST 先失败
      mockMcpFail(500);
      mockCliFail("CLI crashed");

      await expect(
        client.query({ searches: [{ type: "lex", query: "crash" }] }),
      ).rejects.toThrow();
    });

    it("marks MCP unavailable after failure and tries MCP again on next call", async () => {
      // First call: REST fails + MCP fails, 走 CLI
      mockRestFail(500);
      mockMcpFail(500);
      mockCliOk(JSON.stringify([{ docid: "#a", file: "a.md", title: "A", score: 0.5, snippet: "", line: 1, context: null }]));

      await client.query({ searches: [{ type: "lex", query: "a" }] });

      // Second call: REST=false + MCP=false，跳过两者直接走 CLI
      mockCliOk(JSON.stringify([{ docid: "#b", file: "b.md", title: "B", score: 0.5, snippet: "", line: 1, context: null }]));

      const results = await client.query({ searches: [{ type: "lex", query: "b" }] });

      // 第一次 query: REST(1) + MCP initialize(1) + MCP tools/call(1) = 3 次 fetch
      // 第二次 query: restAvailable=false + mcpAvailable=false，直接走 CLI，0 次 fetch
      // 总计 3 次 fetch
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(results[0].docid).toBe("#b");
    });

    // ===================== REST /query 优先路径 ===========================

    it("returns results from REST /query on success (skips MCP)", async () => {
      mockRestOk({
        results: [
          {
            docid: "#rest",
            file: "rest.md",
            title: "REST Result",
            score: 0.88,
            snippet: "via rest",
            line: 3,
            context: "ctx",
          },
        ],
      });

      const results = await client.query({
        searches: [{ type: "lex", query: "rest-test" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        docid: "#rest",
        file: "rest.md",
        score: 0.88,
      });
      // REST 成功后只调用 1 次 fetch（POST /query），不应走 MCP
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/query"),
        expect.objectContaining({ method: "POST" }),
      );
      // 不应调用 MCP /mcp 端点
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/mcp"),
        expect.anything(),
      );
    });

    it("falls back to MCP when REST /query times out", async () => {
      mockRestTimeout(); // REST 超时
      mockMcpOk({
        results: [
          { docid: "#mcp", file: "mcp.md", title: "MCP Result", score: 0.7, snippet: "via mcp", line: 1, context: null },
        ],
      });

      const results = await client.query({
        searches: [{ type: "vec", query: "fallback-test" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#mcp");
      // REST 超时(1) + MCP initialize(1) + MCP tools/call(1) = 3 次 fetch
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("marks REST unavailable and skips REST on next call", async () => {
      // First call: REST fails + MCP succeeds
      mockRestFail(500);
      mockMcpOk({ results: [{ docid: "#1", file: "a.md", title: "A", score: 1, snippet: "", line: 0, context: null }] });
      await client.query({ searches: [{ type: "lex", query: "a" }] });
      expect(mockFetch).toHaveBeenCalledTimes(3); // REST(1) + MCP(2)

      // Second call: restAvailable=false，跳过 REST，直接走 MCP（session 已缓存）
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0", id: 1,
          result: { content: [{ type: "text", text: JSON.stringify([{ docid: "#2", file: "b.md", title: "B", score: 1, snippet: "", line: 0, context: null }]) }] },
        }),
      } as Response);
      const results = await client.query({ searches: [{ type: "lex", query: "b" }] });
      // 第二次只调用 1 次 fetch（MCP tools/call，跳过 REST）
      expect(mockFetch).toHaveBeenCalledTimes(4); // 3 + 1
      expect(results[0].docid).toBe("#2");
    });
  });

  // ===================== ping =============================================

  describe("ping()", () => {
    it("returns true when MCP health endpoint responds OK", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      const result = await client.ping();
      expect(result).toBe(true);
    });

    it("returns false on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));
      const result = await client.ping();
      expect(result).toBe(false);
    });
  });

  // ===================== export types ====================================

  describe("types", () => {
    it("QmdSearchResult can be constructed", () => {
      const r: QmdSearchResult = {
        docid: "#x",
        file: "x.md",
        title: "X",
        score: 1,
        snippet: "",
        line: 0,
        context: null,
      };
      expect(r.docid).toBe("#x");
    });
  });

  // ===================== CLI command building ============================

  describe("CLI command building", () => {
    it("uses qmd search for pure lex queries", async () => {
      mockRestFail(500); // REST 先失败
      mockMcpOk({ results: [] });
      await client.query({ searches: [{ type: "lex", query: "keyword" }] });
      // REST 失败后走 MCP /mcp 端点
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/mcp"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("builds 'qmd search' command for pure lex on CLI fallback", async () => {
      mockRestFail(500); // REST 先失败
      mockMcpFail(500); // MCP 也失败
      mockCliOk(JSON.stringify([]));
      await client.query({ searches: [{ type: "lex", query: "lex-kw" }], limit: 5 });
      expect(mockExecFile).toHaveBeenCalledWith(
        "qmd",
        expect.arrayContaining(["search", "lex-kw", "-n", "5", "--format", "json"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("builds 'qmd vsearch' command for pure vec on CLI fallback", async () => {
      mockRestFail(500);
      mockMcpFail(500);
      mockCliOk(JSON.stringify([]));
      await client.query({ searches: [{ type: "vec", query: "vec-kw" }], limit: 3 });
      expect(mockExecFile).toHaveBeenCalledWith(
        "qmd",
        expect.arrayContaining(["vsearch", "vec-kw", "-n", "3", "--format", "json"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("builds 'qmd search' for mixed queries when cliFallbackSearchType='search'", async () => {
      const c = new QmdClient({ pingInterval: 999_999, cliFallbackSearchType: "search" });
      mockRestFail(500);
      mockMcpFail(500);
      mockCliOk(JSON.stringify([]));
      await c.query({
        searches: [{ type: "lex", query: "lex-kw" }, { type: "vec", query: "vec-kw" }],
      });
      expect(mockExecFile).toHaveBeenCalledWith(
        "qmd",
        expect.arrayContaining(["search", "lex-kw"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("builds 'qmd query' with real newlines for mixed when cliFallbackSearchType='vsearch'", async () => {
      const c = new QmdClient({ pingInterval: 999_999, cliFallbackSearchType: "vsearch" });
      mockRestFail(500);
      mockMcpFail(500);
      mockCliOk(JSON.stringify([]));
      await c.query({
        searches: [{ type: "lex", query: "lex-kw" }, { type: "vec", query: "vec-kw" }],
        intent: "debug",
      });
      // SEC M-15: 必须是真实换行符 \n，而非字面量 "\\n"
      const callArgs = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1] as unknown[];
      const args = callArgs[1] as string[];
      expect(args[0]).toBe("query");
      const queryArg = args[1];
      expect(queryArg).toContain("\n");
      expect(queryArg).toContain("intent: debug");
      expect(queryArg).toContain("lex: lex-kw");
      expect(queryArg).toContain("vec: vec-kw");
      // 确保不是字面量反斜杠+n
      expect(queryArg).not.toContain("\\n");
    });

    it("appends --no-rerank when rerank=false", async () => {
      mockRestFail(500);
      mockMcpFail(500);
      mockCliOk(JSON.stringify([]));
      await client.query({ searches: [{ type: "lex", query: "kw" }], rerank: false });
      expect(mockExecFile).toHaveBeenCalledWith(
        "qmd",
        expect.arrayContaining(["--no-rerank"]),
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  // ===================== get() ===========================================

  describe("get()", () => {
    it("returns document from MCP resource.text", async () => {
      mockMcpToolsCall({
        result: { content: [{ type: "resource", resource: { text: "doc content" } }] },
      });
      const result = await client.get("test.md");
      expect(result).toBe("doc content");
      expect(mockFetch).toHaveBeenCalledTimes(2); // initialize + tools/call
    });

    it("falls back to text field when resource.text missing", async () => {
      mockMcpToolsCall({
        result: { content: [{ type: "text", text: "plain text content" }] },
      });
      const result = await client.get("test.md");
      expect(result).toBe("plain text content");
    });

    it("falls back to CLI when MCP returns HTTP error", async () => {
      mockMcpFail(500);
      mockCliOk("cli document content");
      const result = await client.get("test.md");
      expect(result).toBe("cli document content");
    });

    it("returns null when both MCP and CLI fail", async () => {
      mockMcpFail(500);
      mockCliFail("not found");
      const result = await client.get("missing.md");
      expect(result).toBeNull();
    });

    it("falls through to CLI when MCP returns ok but no text", async () => {
      mockMcpToolsCall({ result: { content: [] } });
      mockCliOk("cli fallback content");
      const result = await client.get("test.md");
      expect(result).toBe("cli fallback content");
    });

    it("returns null when CLI returns empty stdout", async () => {
      mockMcpFail(500);
      mockCliOk("");
      const result = await client.get("empty.md");
      expect(result).toBeNull();
    });
  });

  // ===================== multiGet() ======================================

  describe("multiGet()", () => {
    it("returns array of document texts from MCP resources", async () => {
      mockMcpToolsCall({
        result: {
          content: [
            { type: "resource", resource: { text: "doc1 content" } },
            { type: "resource", resource: { text: "doc2 content" } },
          ],
        },
      });
      const results = await client.multiGet("*.md");
      expect(results).toHaveLength(2);
      expect(results[0]).toBe("doc1 content");
      expect(results[1]).toBe("doc2 content");
    });

    it("falls back to CLI when MCP fails", async () => {
      mockMcpFail(500);
      mockCliOk(JSON.stringify([
        { body: "cli doc 1" },
        { body: "cli doc 2" },
      ]));
      const results = await client.multiGet("*.md");
      expect(results).toHaveLength(2);
      expect(results[0]).toBe("cli doc 1");
      expect(results[1]).toBe("cli doc 2");
    });

    it("returns empty array when both MCP and CLI fail", async () => {
      mockMcpFail(500);
      mockCliFail("error");
      const results = await client.multiGet("*.md");
      expect(results).toEqual([]);
    });

    it("returns empty array when CLI output is not a JSON array", async () => {
      mockMcpFail(500);
      mockCliOk("{not an array}");
      const results = await client.multiGet("*.md");
      expect(results).toEqual([]);
    });
  });

  // ===================== status() ========================================

  describe("status()", () => {
    it("returns status text from MCP", async () => {
      mockMcpToolsCall({
        result: { content: [{ type: "text", text: "Index: 100 docs, 5 collections" }] },
      });
      const result = await client.status();
      expect(result).toBe("Index: 100 docs, 5 collections");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("v1.1-10: falls back to CLI when MCP returns HTTP error", async () => {
      mockMcpFail(500);
      mockCliOk("Index: 80 docs (CLI)");
      const result = await client.status();
      expect(result).toBe("Index: 80 docs (CLI)");
      expect(mockExecFile).toHaveBeenCalled();
    });

    it("v1.1-10: falls back to CLI on network error", async () => {
      mockMcpTimeout();
      mockCliOk("Index: 80 docs (CLI)");
      const result = await client.status();
      expect(result).toBe("Index: 80 docs (CLI)");
      expect(mockExecFile).toHaveBeenCalled();
    });

    it("v1.1-10: falls back to CLI when MCP returns ok but no text content", async () => {
      mockMcpToolsCall({ result: { content: [] } });
      mockCliOk("Index: 80 docs (CLI)");
      const result = await client.status();
      expect(result).toBe("Index: 80 docs (CLI)");
    });

    it("v1.1-10: returns null when both MCP and CLI fail", async () => {
      mockMcpFail(500);
      mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        setTimeout(() => cb(new Error("qmd CLI not found"), { stdout: "", stderr: "" }), 10);
      });
      const result = await client.status();
      expect(result).toBeNull();
    });
  });

  // ===================== dispose() =======================================

  describe("dispose()", () => {
    it("does not throw when called without active timer", () => {
      expect(() => client.dispose()).not.toThrow();
    });

    it("can be called multiple times safely (idempotent)", () => {
      client.dispose();
      client.dispose();
      client.dispose();
    });
  });

  // ===================== session caching =================================

  describe("session caching", () => {
    it("reuses mcp-session-id across multiple successful MCP calls", async () => {
      // 第一次 query: REST 失败 + MCP initialize + tools/call = 3 fetches
      mockRestFail(500);
      mockMcpOk({ results: [{ docid: "#1", file: "a.md", title: "A", score: 1, snippet: "", line: 0, context: null }] });
      await client.query({ searches: [{ type: "lex", query: "a" }] });
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // 第二次 query: restAvailable=false 跳过 REST, session 已缓存，只发 tools/call = 1 fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0", id: 1,
          result: { content: [{ type: "text", text: JSON.stringify([{ docid: "#2", file: "b.md", title: "B", score: 1, snippet: "", line: 0, context: null }]) }] },
        }),
      } as Response);
      const results = await client.query({ searches: [{ type: "lex", query: "b" }] });
      expect(mockFetch).toHaveBeenCalledTimes(4); // 3 + 1
      expect(results[0].docid).toBe("#2");
    });
  });

  // ===================== mcpInitialize failures ==========================

  describe("mcpInitialize failures", () => {
    it("throws and falls to CLI when initialize returns non-200", async () => {
      // REST 先失败 → MCP initialize 失败 → CLI
      mockRestFail(500);
      // initialize 失败 → 抛错 → query() catch → mcpAvailable=false → CLI
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({}),
      } as Response);
      mockCliOk(JSON.stringify([]));

      const results = await client.query({ searches: [{ type: "lex", query: "test" }] });
      expect(results).toEqual([]);
    });

    it("throws and falls to CLI when initialize has no mcp-session-id header", async () => {
      // REST 先失败 → MCP initialize 无 session → CLI
      mockRestFail(500);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null }, // 无 mcp-session-id
        json: async () => ({ jsonrpc: "2.0", id: "init", result: {} }),
      } as Response);
      mockCliOk(JSON.stringify([]));

      const results = await client.query({ searches: [{ type: "lex", query: "test" }] });
      expect(results).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 辅助 helper：通用 tools/call 响应 mock（用于 get/multiGet/status）
// ---------------------------------------------------------------------------

function mockMcpToolsCall(resultBody: unknown): void {
  // 1st fetch: initialize response (with session id header)
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: (name: string) => name === "mcp-session-id" ? "test-session-1" : null },
    json: async () => ({ jsonrpc: "2.0", id: "init", result: {} }),
  } as Response);
  // 2nd fetch: tools/call response
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => resultBody,
  } as Response);
}
