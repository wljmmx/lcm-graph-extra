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
      // P1-12 FAIL-3: MCP 协议需 2 次 fetch（initialize + tools/call）
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("falls back to CLI when MCP fails with HTTP error", async () => {
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
      mockMcpTimeout();
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
      mockMcpFail(500);
      mockCliFail("CLI crashed");

      await expect(
        client.query({ searches: [{ type: "lex", query: "crash" }] }),
      ).rejects.toThrow();
    });

    it("marks MCP unavailable after failure and tries MCP again on next call", async () => {
      // First call: MCP fails
      mockMcpFail(500);
      mockCliOk(JSON.stringify([{ docid: "#a", file: "a.md", title: "A", score: 0.5, snippet: "", line: 1, context: null }]));

      await client.query({ searches: [{ type: "lex", query: "a" }] });

      // Second call: should skip MCP, go straight to CLI (mcpAvailable = false)
      mockCliOk(JSON.stringify([{ docid: "#b", file: "b.md", title: "B", score: 0.5, snippet: "", line: 1, context: null }]));

      const results = await client.query({ searches: [{ type: "lex", query: "b" }] });

     // P1-12 FAIL-3: MCP 协议需 2 次 fetch（initialize + tools/call），第一次 query 调用 2 次，
      // 第二次 query 跳过 MCP 直接走 CLI（mcpAvailable = false），总调用 2 次。
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(results[0].docid).toBe("#b");
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
      mockMcpOk({ results: [] });
      await client.query({ searches: [{ type: "lex", query: "keyword" }] });
      // P1-12 FAIL-3: 实际端点是 /mcp（MCP JSON-RPC），非 /query
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/mcp"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("builds 'qmd search' command for pure lex on CLI fallback", async () => {
      mockMcpFail(500);
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

    it("returns null when MCP returns HTTP error (no CLI fallback)", async () => {
      mockMcpFail(500);
      const result = await client.status();
      expect(result).toBeNull();
      // status() has no CLI fallback — verify execFile was NOT called
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("returns null on network error", async () => {
      mockMcpTimeout();
      const result = await client.status();
      expect(result).toBeNull();
    });

    it("returns null when MCP returns ok but no text content", async () => {
      mockMcpToolsCall({ result: { content: [] } });
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
      // 第一次 query: initialize + tools/call = 2 fetches
      mockMcpOk({ results: [{ docid: "#1", file: "a.md", title: "A", score: 1, snippet: "", line: 0, context: null }] });
      await client.query({ searches: [{ type: "lex", query: "a" }] });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // 第二次 query: session 已缓存，只发 tools/call = 1 fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0", id: 1,
          result: { content: [{ type: "text", text: JSON.stringify([{ docid: "#2", file: "b.md", title: "B", score: 1, snippet: "", line: 0, context: null }]) }] },
        }),
      } as Response);
      const results = await client.query({ searches: [{ type: "lex", query: "b" }] });
      expect(mockFetch).toHaveBeenCalledTimes(3); // 2 + 1
      expect(results[0].docid).toBe("#2");
    });
  });

  // ===================== mcpInitialize failures ==========================

  describe("mcpInitialize failures", () => {
    it("throws and falls to CLI when initialize returns non-200", async () => {
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
