/**
 * 图谱健康路由（N-4: G-5 图谱健康对接）。
 *
 * 端点：
 * - GET /api/graph/health —— 转发插件 /internal/graph-health（gm-pro G-5 优先，降级到本地）
 *
 * 设计：
 * - 5s 超时，失败降级返回 { status: 'unknown', source: 'none' }
 * - 与插件 snapshot 服务复用同一健康判断逻辑
 */

import type { FastifyInstance } from 'fastify';
import { fetchPluginSnapshot } from '../lib/snapshot';

export interface GraphHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  source: 'gm-pro' | 'local' | 'none';
  nodeCount?: number;
  relationshipCount?: number;
  graphAdapterConnected?: boolean;
  details?: Record<string, unknown>;
  fetchedAt: number;
  error?: string;
}

export async function registerGraphHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/graph/health', async (_req, reply) => {
    try {
      const snapshot = await fetchPluginSnapshot();
      // fetchPluginSnapshot 返回完整 snapshot，但 graph-health 是独立端点
      // 改用直接 fetch /internal/graph-health 端点
      const PLUGIN_SNAPSHOT_URL = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${PLUGIN_SNAPSHOT_URL}/internal/graph-health`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (resp.ok) {
          const body = await resp.json() as Omit<GraphHealthResponse, 'fetchedAt'>;
          return reply.send({
            ...body,
            fetchedAt: Date.now(),
          } satisfies GraphHealthResponse);
        }
        // 插件未实现 /internal/graph-health 端点（旧版本）
        // 降级：从 snapshot.graphAdapter 推断
        if (snapshot) {
          const connected = !!snapshot.graphAdapter?.connected;
          const status: GraphHealthResponse['status'] =
            connected ? 'healthy' : (snapshot.graphAdapter?.connectFailed ? 'unhealthy' : 'degraded');
          return reply.send({
            status,
            source: 'local',
            graphAdapterConnected: connected,
            fetchedAt: Date.now(),
          } satisfies GraphHealthResponse);
        }
        return reply.send({
          status: 'unknown',
          source: 'none',
          fetchedAt: Date.now(),
          error: `plugin /internal/graph-health returned ${resp.status}`,
        } satisfies GraphHealthResponse);
      } catch (fetchErr) {
        // 插件不可达
        return reply.send({
          status: 'unknown',
          source: 'none',
          fetchedAt: Date.now(),
          error: String(fetchErr),
        } satisfies GraphHealthResponse);
      }
    } catch (err) {
      return reply.status(500).send({
        status: 'unknown',
        source: 'none',
        fetchedAt: Date.now(),
        error: String(err),
      } satisfies GraphHealthResponse);
    }
  });
}
