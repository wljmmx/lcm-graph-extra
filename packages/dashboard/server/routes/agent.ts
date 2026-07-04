/**
 * Agent 状态路由：转发 OpenClaw host /api/status。
 *
 * - 5s 超时，失败返回 { online: false, error }
 * - 成功返回 host 原始响应 + { online: true }
 *
 * host 地址由 env OPENCLAW_MCP_URL 配置，默认 http://127.0.0.1:18789。
 */
import type { FastifyInstance } from 'fastify';

const OPENCLAW_HOST = process.env.OPENCLAW_MCP_URL ?? 'http://127.0.0.1:18789';
const AGENT_TIMEOUT_MS = 5_000;

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/status', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
    try {
      const resp = await fetch(`${OPENCLAW_HOST}/api/status`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!resp.ok) {
        return { online: false, error: `OpenClaw host HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as Record<string, unknown>;
      // 透传 host 原始响应字段，并标记 online
      return { ...data, online: true };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = err instanceof Error ? err.message : String(err);
      const error = isAbort
        ? `OpenClaw host 请求超时（${AGENT_TIMEOUT_MS}ms）`
        : `OpenClaw host 不可达: ${msg}`;
      return { online: false, error };
    } finally {
      clearTimeout(timer);
    }
  });
}
