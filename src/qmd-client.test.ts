/**
 * QmdClient — 单元测试
 *
 * 使用 vi.mock 模拟 fetch 和 execFile
 *
 * 降级顺序：MCP /mcp → REST /query → CLI (child_process)
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

/** MCP initialize 阶段抛错（如超时、连接失败） */
function mockMcpInitFail(): void {
  mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
}

/** MCP tools/call 阶段抛错（如超时、embed 错误）—— 通过 reject 模拟异常向上传播 */
function mockMcpCallReject(msg: string): void {
  // initialize succeeds
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: (name: string) => name === "mcp-session-id" ? "test-session-1" : null },
    json: async () => ({ jsonrpc: "2.0", id: "init", result: {} }),
  } as Response);
  // tools/call 抛异常（用于模拟 embed 维度错误等）
  mockFetch.mockRejectedValueOnce(new Error(msg));
}

/** MCP tools/call 返回 JSON-RPC error（embed 错误等以 error 响应形式返回） */
function mockMcpCallError(errorMessage: string): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: (name: string) => name === "mcp-session-id" ? "test-session-1" : null },
    json: async () => ({ jsonrpc: "2.0", id: "init", result: {} }),
  } as Response);
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      jsonrpc: "2.0", id: 1,
      error: { code: -32603, message: errorMessage },
    }),
  } as Response);
}

/**
 * MCP tools/call 返回 isError=true 的响应（如 vec/hyde 不支持 -term 否定语法时）。
 * textContent 是错误描述而非 JSON，对应 qmd-client.ts queryViaMcp 中 isError 分支。
 */
function mockMcpIsError(errorText: string): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: (name: string) => name === "mcp-session-id" ? "test-session-1" : null },
    json: async () => ({ jsonrpc: "2.0", id: "init", result: {} }),
  } as Response);
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      jsonrpc: "2.0", id: 1,
      result: { content: [{ type: "text", text: errorText }], isError: true },
    }),
  } as Response);
}

function mockMcpTimeout(): void {
  mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
}

// REST /query mocks —— QmdClient MCP 失败后用 REST /query 降级
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
    it("returns results from MCP on success (no REST call)", async () => {
      // MCP 优先：MCP 成功时不应走 REST
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
      // MCP 协议需 2 次 fetch（initialize + tools/call），REST 不应被调用
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // 不应调用 REST /query 端点
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/query"),
        expect.anything(),
      );
    });

    it("falls back to REST when MCP fails with HTTP error", async () => {
      mockMcpFail(503);
      mockRestOk({
        results: [
          { docid: "#def", file: "fallback.md", title: "Fallback", score: 0.8, snippet: "cli result", line: 5, context: null },
        ],
      });

      const results = await client.query({
        searches: [{ type: "lex", query: "fallback" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#def");
      // MCP initialize(1) + MCP tools/call(1) + REST(1) = 3 次 fetch
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("falls back to REST when MCP times out", async () => {
      mockMcpInitFail(); // MCP initialize 超时
      mockRestOk({
        results: [
          { docid: "#timeout", file: "t.md", title: "Timeout", score: 0.5, snippet: "", line: 1, context: null },
        ],
      });

      const results = await client.query({
        searches: [{ type: "lex", query: "timeout" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#timeout");
    });

    it("falls back to CLI when both MCP and REST fail", async () => {
      mockMcpFail(500);
      mockRestFail(500);
      mockCliOk(JSON.stringify([
        { docid: "#cli", file: "c.md", title: "CLI", score: 0.6, snippet: "", line: 1, context: null },
      ]));

      const results = await client.query({
        searches: [{ type: "lex", query: "crash" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#cli");
    });

    it("throws when MCP, REST, and CLI all fail", async () => {
      mockMcpFail(500);
      mockRestFail(500);
      mockCliFail("CLI crashed");

      await expect(
        client.query({ searches: [{ type: "lex", query: "crash" }] }),
      ).rejects.toThrow();
    });

    it("marks MCP unavailable after failure and skips MCP on next call", async () => {
      // First call: MCP fails + REST fails → CLI
      mockMcpFail(500);
      mockRestFail(500);
      mockCliOk(JSON.stringify([{ docid: "#a", file: "a.md", title: "A", score: 0.5, snippet: "", line: 1, context: null }]));

      await client.query({ searches: [{ type: "lex", query: "a" }] });

      // Second call: MCP=false 跳过，REST=false（第一次失败已标记）跳过，直接走 CLI
      mockCliOk(JSON.stringify([{ docid: "#b", file: "b.md", title: "B", score: 0.5, snippet: "", line: 1, context: null }]));

      const results = await client.query({ searches: [{ type: "lex", query: "b" }] });

      // 第一次: MCP init(1) + MCP call(1) + REST(1) = 3 fetch
      // 第二次: MCP=false + REST=false 都跳过，直接 CLI，0 fetch
      // 总计 3 fetch
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(results[0].docid).toBe("#b");
    });
  });

  // ===================== MCP embed 错误降级到 REST (avoidVec) =============

  describe("MCP embed error → REST lex-only fallback", () => {
    it("REST uses lex-only searches when MCP fails with dimension mismatch", async () => {
      // MCP 失败：embed 维度错误
      mockMcpCallError("Dimension mismatch for query vector for the embedding column. Expected 1024 dimensions but received 768.");
      // REST 成功
      mockRestOk({ results: [{ docid: "#lex", file: "l.md", title: "Lex", score: 0.7, snippet: "", line: 1, context: null }] });

      const results = await client.query({
        searches: [
          { type: "lex", query: "lex-kw" },
          { type: "vec", query: "vec-kw" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#lex");

      // 验证 REST 调用时 body 只含 lex 子查询（avoidVec=true）
      const restCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/query"),
      );
      expect(restCall).toBeDefined();
      const restBody = JSON.parse((restCall![1] as any).body);
      expect(restBody.searches).toHaveLength(1);
      expect(restBody.searches[0].type).toBe("lex");
      expect(restBody.rerank).toBe(false); // embed 错误时禁用 rerank
    });

    it("REST keeps all searches when MCP fails with non-embed error", async () => {
      // MCP 失败：非 embed 错误（如 HTTP 500）
      mockMcpFail(500);
      mockRestOk({ results: [{ docid: "#r", file: "r.md", title: "R", score: 0.6, snippet: "", line: 1, context: null }] });

      const results = await client.query({
        searches: [
          { type: "lex", query: "lex-kw" },
          { type: "vec", query: "vec-kw" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#r");

      // 验证 REST 调用时 body 含所有子查询（avoidVec=false）
      const restCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/query"),
      );
      const restBody = JSON.parse((restCall![1] as any).body);
      expect(restBody.searches).toHaveLength(2);
      expect(restBody.rerank).toBe(true); // 非 embed 错误时保持 rerank
    });

    it("REST falls through to CLI when lex-only also fails (no lex subquery)", async () => {
      // MCP 失败：embed 错误，但 searches 只有 vec（无 lex）
      mockMcpCallError("Dimension mismatch for embedding");
      // REST 尝试（无 lex 退化，保留原样 → 可能再次失败）
      mockRestFail(500);
      // CLI 兜底
      mockCliOk(JSON.stringify([{ docid: "#cli", file: "c.md", title: "C", score: 0.5, snippet: "", line: 1, context: null }]));

      const results = await client.query({
        searches: [{ type: "vec", query: "vec-only" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#cli");
    });
  });

  // ===================== Fix 1.1: vec/hyde 剥离 -term 否定语法 ===========

  describe("Fix 1.1: strip -term negation from vec/hyde searches", () => {
    it("strips -term from vec query before sending to MCP", async () => {
      mockMcpOk({ results: [] });

      await client.query({
        searches: [
          { type: "lex", query: "hello -world" },
          { type: "vec", query: "hello -world" },
        ],
      });

      // 找到 tools/call (MCP /mcp) 请求的 body
      const mcpCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/mcp") && (c[1] as any)?.method === "POST",
      );
      expect(mcpCall).toBeDefined();
      const mcpBody = JSON.parse((mcpCall![1] as any).body);
      // method 为 tools/call 的请求才是 query 调用
      if (mcpBody.method === "tools/call") {
        const searches = mcpBody.params.arguments.searches;
        const lex = searches.find((s: any) => s.type === "lex");
        const vec = searches.find((s: any) => s.type === "vec");
        // lex 保留 -term（lex 支持否定语义）
        expect(lex.query).toBe("hello -world");
        // vec 剥离 -term（vec/hyde 不支持否定，会触发 isError）
        expect(vec.query).toBe("hello");
        expect(vec.query).not.toContain("-");
      }
    });

    it("does not strip --flag style double-hyphen from vec query", async () => {
      mockMcpOk({ results: [] });

      await client.query({
        searches: [{ type: "vec", query: "--no-rerank flag" }],
      });

      const mcpCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/mcp") && (c[1] as any)?.method === "POST",
      );
      const mcpBody = JSON.parse((mcpCall![1] as any).body);
      if (mcpBody.method === "tools/call") {
        const vec = mcpBody.params.arguments.searches[0];
        // --no-rerank 不应被当作 -term 剥离
        expect(vec.query).toContain("--no-rerank");
      }
    });

    it("strips multiple -term from hyde query", async () => {
      mockMcpOk({ results: [] });

      await client.query({
        searches: [{ type: "hyde", query: "foo -bar baz -qux" }],
      });

      const mcpCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/mcp") && (c[1] as any)?.method === "POST",
      );
      const mcpBody = JSON.parse((mcpCall![1] as any).body);
      if (mcpBody.method === "tools/call") {
        const hyde = mcpBody.params.arguments.searches[0];
        expect(hyde.query).toBe("foo baz");
        expect(hyde.query).not.toContain("-bar");
        expect(hyde.query).not.toContain("-qux");
      }
    });
  });

  // ===================== Fix 1.2: MCP isError 触发降级 ================

  describe("Fix 1.2: MCP isError triggers REST fallback", () => {
    it("falls back to REST when MCP returns isError (vec negation error)", async () => {
      // MCP 返回 isError=true（vec/hyde 不支持 -term），修复前会 return [] 丢失 L2 数据
      mockMcpIsError("Structured search (vec): Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions.");
      // REST 应被触发降级
      mockRestOk({
        results: [{ docid: "#rest", file: "r.md", title: "R", score: 0.7, snippet: "", line: 1, context: null }],
      });

      const results = await client.query({
        searches: [
          { type: "lex", query: "hello -world" },
          { type: "vec", query: "hello" }, // vec 已被 Fix 1.1 剥离 -term
        ],
      });

      // 应从 REST 拿到结果，而非返回空数组
      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#rest");
      // MCP init + tools/call + REST = 3 次 fetch
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("falls back to CLI when MCP isError and REST both fail", async () => {
      mockMcpIsError("Structured search (vec): Negation (-term) is not supported in vec/hyde queries.");
      mockRestFail(500);
      mockCliOk(JSON.stringify([{ docid: "#cli", file: "c.md", title: "C", score: 0.5, snippet: "", line: 1, context: null }]));

      const results = await client.query({
        searches: [{ type: "lex", query: "test" }, { type: "vec", query: "test" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#cli");
    });

    it("does not silently return empty array on MCP isError", async () => {
      mockMcpIsError("Some MCP error");
      mockRestFail(500);
      mockCliFail("CLI also failed");

      // 修复前：MCP isError 时 return []，不会抛错
      // 修复后：isError 抛错 → REST 失败 → CLI 失败 → 最终抛错
      await expect(
        client.query({ searches: [{ type: "lex", query: "test" }] }),
      ).rejects.toThrow();
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
    it("uses MCP /mcp endpoint for pure lex queries on success", async () => {
      mockMcpOk({ results: [] });
      await client.query({ searches: [{ type: "lex", query: "keyword" }] });
      // MCP 成功时端点是 /mcp（MCP JSON-RPC）
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/mcp"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("builds 'qmd search' command for pure lex on CLI fallback", async () => {
      mockMcpFail(500);
      mockRestFail(500);
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
      mockRestFail(500);
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
      mockRestFail(500);
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
      mockRestFail(500);
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
      mockRestFail(500);
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
      // 第一次 query: MCP initialize + tools/call = 2 fetches
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
    it("throws and falls to REST when initialize returns non-200", async () => {
      // MCP initialize 失败 → 抛错 → query() catch → mcpAvailable=false → REST
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({}),
      } as Response);
      mockRestOk({ results: [{ docid: "#r", file: "r.md", title: "R", score: 0.6, snippet: "", line: 1, context: null }] });

      const results = await client.query({ searches: [{ type: "lex", query: "test" }] });
      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#r");
    });

    it("throws and falls to REST when initialize has no mcp-session-id header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null }, // 无 mcp-session-id
        json: async () => ({ jsonrpc: "2.0", id: "init", result: {} }),
      } as Response);
      mockRestOk({ results: [{ docid: "#r", file: "r.md", title: "R", score: 0.6, snippet: "", line: 1, context: null }] });

      const results = await client.query({ searches: [{ type: "lex", query: "test" }] });
      expect(results).toHaveLength(1);
      expect(results[0].docid).toBe("#r");
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
