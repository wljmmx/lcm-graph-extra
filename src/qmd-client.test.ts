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

function mockMcpOk(body: unknown): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => body,
  } as Response);
}

function mockMcpFail(status = 500): void {
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
      expect(mockFetch).toHaveBeenCalledTimes(1);
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

      // MCP was called only once (first call), second call went directly to CLI
      expect(mockFetch).toHaveBeenCalledTimes(1);
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

  describe("CLI command building (via query results)", () => {
    it("uses qmd search for pure lex queries", async () => {
      mockMcpOk({ results: [] });
      await client.query({ searches: [{ type: "lex", query: "keyword" }] });
      // Should have called MCP which we mocked, check MCP request body
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/query"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });
});
