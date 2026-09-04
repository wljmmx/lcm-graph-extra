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
import { getOutboundAuthHeader } from '../lib/auth';
import { runReadQuery, toNumber } from '../lib/neo4j';

export interface GraphHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  source: 'gm-pro' | 'local' | 'none';
  nodeCount?: number;
  relationshipCount?: number;
  graphAdapterConnected?: boolean;
  circuitBreakerOpen?: boolean;
  circuitBreakerFailures?: number;
  details?: Record<string, unknown>;
  fetchedAt: number;
  error?: string;
}

/**
 * graph-memory-pro v2.6.0 图谱健康评分（GraphHealthMetric 落盘快照）。
 * 与上游 src/graph/maintenance/health.ts 的 GraphHealthScore 结构对齐。
 */
export interface GraphHealthScoreResponse {
  available: boolean;
  error?: string;
  timestamp?: number;
  /** 0-100 健康分 */
  score?: number;
  /** 五维评分（0-1） */
  dims?: {
    connectivity: number;
    density: number;
    influence: number;
    freshness: number;
    conflictFree: number;
  };
  metrics?: {
    activeNodes: number;
    totalEdges: number;
    isolatedNodes: number;
    isolatedRatio: number;
    avgDegree: number;
    avgPageRank: number;
    highStaleRatio: number;
    transitionalRatio: number;
  };
  /** 稀疏标记（score < 60 或 isolatedRatio > 0.3） */
  sparse?: boolean;
  anomalies?: string[];
}

export async function registerGraphHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/graph/health', async (req, reply) => {
    // E2 修复: 删除原先多余的 fetchPluginSnapshot() 调用。
    // 原代码先取一次 snapshot（5s 超时）再 fetch /internal/graph-health，
    // 但 snapshot 仅在降级分支用 graphAdapter 字段判断一次，导致每次请求
    // 多打一次 /internal/snapshot，插件不可达时把响应延迟拉到 5s+。
    // 现改为直接 fetch /internal/graph-health，失败时降级返回 unknown。
    const PLUGIN_SNAPSHOT_URL = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';
    const targetUrl = `${PLUGIN_SNAPSHOT_URL}/internal/graph-health`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(targetUrl, {
        headers: getOutboundAuthHeader(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        // 健壮性: 校验 Content-Type 为 JSON，避免命中返回 HTML（SPA 兜底/端口被占/代理拦截）
        const contentType = resp.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('application/json')) {
          // 取前 200 字符帮助定位 HTML 来源（多为 <!DOCTYPE html>）
          let snippet = '';
          try { snippet = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
          req.log.error(
            { url: targetUrl, status: resp.status, contentType, snippet },
            'graph-health 响应非 JSON（疑似 PLUGIN_SNAPSHOT_URL 指错或端口被占）',
          );
          return reply.send({
            status: 'unknown',
            source: 'none',
            fetchedAt: Date.now(),
            error: `plugin 响应非 JSON (Content-Type=${contentType || '空'}, status=${resp.status}); 请检查 PLUGIN_SNAPSHOT_URL=${PLUGIN_SNAPSHOT_URL} 是否指向插件 snapshot :7423`,
          } satisfies GraphHealthResponse);
        }
        try {
          const body = await resp.json() as Omit<GraphHealthResponse, 'fetchedAt'>;
          return reply.send({
            ...body,
            fetchedAt: Date.now(),
          } satisfies GraphHealthResponse);
        } catch (parseErr) {
          // 200 + JSON Content-Type 但 body 仍非法（罕见）
          req.log.error({ err: String(parseErr) }, 'graph-health JSON 解析失败');
          return reply.send({
            status: 'unknown',
            source: 'none',
            fetchedAt: Date.now(),
            error: `plugin 响应 JSON 解析失败: ${String(parseErr)}`,
          } satisfies GraphHealthResponse);
        }
      }
      // 插件未实现 /internal/graph-health 端点（旧版本），降级返回 unknown
      return reply.send({
        status: 'unknown',
        source: 'none',
        fetchedAt: Date.now(),
        error: `plugin /internal/graph-health returned ${resp.status}`,
      } satisfies GraphHealthResponse);
    } catch (fetchErr) {
      // 插件不可达 / 超时 —— 预期的降级场景，降为 warn 避免 error 级别污染日志
      // TypeError: fetch failed 通常是 ECONNREFUSED（:7423 未监听）或 ECONNRESET
      req.log.warn({ err: String(fetchErr), url: targetUrl }, 'graph-health fetch 失败，插件 snapshot 服务不可达');
      return reply.send({
        status: 'unknown',
        source: 'none',
        fetchedAt: Date.now(),
        error: `插件 snapshot 服务不可达 (${targetUrl}); 请检查插件是否已加载且 :7423 端口在监听`,
      } satisfies GraphHealthResponse);
    }
  });

  // v2.6.0 对接：图谱健康评分（直读 Neo4j 中 graph-memory-pro 落盘的 GraphHealthMetric 快照）
  app.get('/api/graph/health-score', async (req, reply) => {
    try {
      const result = await runReadQuery(
        'MATCH (m:GraphHealthMetric) RETURN m ORDER BY m.timestamp DESC LIMIT 1',
      );
      const record = result.records[0];
      if (!record) {
        return reply.send({ available: false, error: '尚无 GraphHealthMetric 快照（graph-memory-pro v2.6.0+ 维护后会落盘）' } satisfies GraphHealthScoreResponse);
      }
      const m = record.get('m') as Record<string, unknown>;
      const num = (v: unknown): number => toNumber(v) ?? 0;
      const metrics = {
        activeNodes: num(m.activeNodes),
        totalEdges: num(m.totalEdges),
        isolatedNodes: num(m.isolatedNodes),
        isolatedRatio: num(m.isolatedRatio),
        avgDegree: num(m.avgDegree),
        avgPageRank: num(m.avgPageRank),
        highStaleRatio: num(m.highStaleRatio),
        transitionalRatio: num(m.transitionalRatio),
      };
      return reply.send({
        available: true,
        timestamp: num(m.timestamp),
        score: num(m.score),
        dims: {
          connectivity: num(m.connectivity),
          density: num(m.density),
          influence: num(m.influence),
          freshness: num(m.freshness),
          conflictFree: num(m.conflictFree),
        },
        metrics,
        sparse: m.sparse === true,
      } satisfies GraphHealthScoreResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.warn({ err: msg }, 'graph health-score 查询失败（Neo4j 不可达）');
      return reply.send({
        available: false,
        error: `Neo4j 查询失败: ${msg}`,
      } satisfies GraphHealthScoreResponse);
    }
  });
}
