/**
 * Agent 状态路由：转发 OpenClaw host 状态查询。
 *
 * - 依次尝试 /api/status、/status、/health 等路径
 * - 5s 超时，失败返回 { online: false, error }
 * - 成功返回 host 原始响应 + { online: true }
 *
 * host 地址由 env OPENCLAW_MCP_URL 配置，默认 http://127.0.0.1:18789。
 */
import type { FastifyInstance } from 'fastify';

const OPENCLAW_HOST = process.env.OPENCLAW_MCP_URL ?? 'http://127.0.0.1:18789';
const AGENT_TIMEOUT_MS = 5_000;
const STATUS_PATHS = ['/api/status', '/status', '/health'];

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/status', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
    try {
      // 依次尝试多个路径，找到第一个返回成功的
      for (const path of STATUS_PATHS) {
        try {
          const resp = await fetch(`${OPENCLAW_HOST}${path}`, {
            method: 'GET',
            signal: controller.signal,
          });
          if (resp.ok) {
            const data = (await resp.json()) as Record<string, unknown>;
            return { ...data, online: true, path };
          }
          // 404 继续尝试下一个路径
          if (resp.status === 404) continue;
          // 其他错误码直接返回
          return { online: false, error: `OpenClaw host HTTP ${resp.status}` };
        } catch {
          // 连接错误继续尝试下一个路径
          continue;
        }
      }
      // 所有路径都失败
      return { online: false, error: `OpenClaw host 不可达: all paths failed (${STATUS_PATHS.join(', ')})` };
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
