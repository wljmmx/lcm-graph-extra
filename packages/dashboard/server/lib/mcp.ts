/**
 * OpenClaw MCP 工具调用客户端。
 *
 * 写路径统一通过本模块转发到插件 snapshot server 的 /internal/mcp-invoke 端点。
 *
 * 架构说明：
 * - OpenClaw host 端口 18789 是 LLM API（Ollama 桥接），不暴露 MCP invoke HTTP 端点
 * - 插件 snapshot server 端口 7423 与插件同进程，可直接调用已注册的工具 handler
 * - 因此 dashboard 转发到 snapshot server，而非 OpenClaw host
 *
 * 默认 host: http://127.0.0.1:7423（与 PLUGIN_SNAPSHOT_URL 对齐）
 */

// 与 server/lib/snapshot.ts / routes/config.ts / routes/graph-health.ts 共用 env var
const MCP_HOST = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';

// 30s 超时
const MCP_TIMEOUT_MS = 30_000;

/** MCP 工具调用响应 */
export interface McpInvokeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * 调用 OpenClaw MCP 工具。
 *
 * @param tool 工具名，如 "lcmg_maintain"
 * @param params 工具参数
 */
export async function invokeMcpTool(
  tool: string,
  params: Record<string, unknown>,
): Promise<McpInvokeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const resp = await fetch(`${MCP_HOST}/internal/mcp-invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool, params }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return {
        ok: false,
        error: `MCP host HTTP ${resp.status}: ${await safeReadText(resp)}`,
      };
    }
    const data = (await resp.json()) as Partial<McpInvokeResponse>;
    return {
      ok: Boolean(data.ok),
      result: data.result,
      error: data.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 超时（abort）单独提示，便于排查
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: `MCP 调用超时（${MCP_TIMEOUT_MS}ms）` };
    }
    return { ok: false, error: `MCP 调用失败: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 安全读取响应文本（失败时回退） */
async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '<unreadable body>';
  }
}
