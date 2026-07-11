/**
 * 健康指标路由：直读 lcm.db + 插件 /internal/snapshot。
 *
 * - GET /api/health/history?n=144 —— 历史 health_metrics 时序（前端 HealthSnapshot 形态）
 * - GET /api/health/latest        —— 最新一条 db 快照 + 插件内存态聚合
 *
 * 数据形态转换：DB 行（snake_case + 0/1 布尔）→ 前端快照（camelCase + boolean），
 * 与主包 src/health-metrics.ts 的 HealthSnapshot 字段对齐。
 */
import type { FastifyInstance } from 'fastify';
import {
  queryHealthHistory,
  queryHealthLatest,
  type HealthMetricRow,
} from '../lib/db';
import { fetchPluginSnapshot, type PluginSnapshot } from '../lib/snapshot';

/** 前端期望的 HealthSnapshot（camelCase，与 src/health-metrics.ts 对齐） */
export interface HealthSnapshot {
  timestamp: number;
  pendingMessages: number;
  summaryFragments: number;
  maxTokenRatio: number;
  cbLcmAvailable: boolean;
  cbQmdAvailable: boolean;
  cbNeo4jAvailable: boolean;
  cbLcmFailures: number;
  cbQmdFailures: number;
  cbNeo4jFailures: number;
  lastAssembleMs: number;
  lastL2Ms: number;
  lastL3Ms: number;
  lastL4Ms: number;
  pendingExperienceCount: number;
  distilledExperienceCount: number;
  tierLow: number;
  tierMedium: number;
  tierHigh: number;
}

/** DB 行（snake_case + 0/1 布尔）→ 前端快照（camelCase + boolean） */
function rowToSnapshot(row: HealthMetricRow): HealthSnapshot {
  return {
    timestamp: row.ts,
    pendingMessages: row.pending_msgs,
    summaryFragments: row.summary_frags,
    maxTokenRatio: row.token_ratio,
    cbLcmAvailable: row.cb_lcm_ok !== 0,
    cbQmdAvailable: row.cb_qmd_ok !== 0,
    cbNeo4jAvailable: row.cb_neo4j_ok !== 0,
    cbLcmFailures: row.cb_lcm_fails,
    cbQmdFailures: row.cb_qmd_fails,
    cbNeo4jFailures: row.cb_neo4j_fails,
    lastAssembleMs: row.assemble_ms,
    lastL2Ms: row.l2_ms,
    lastL3Ms: row.l3_ms,
    lastL4Ms: row.l4_ms,
    pendingExperienceCount: row.pending_exp,
    distilledExperienceCount: row.distilled_exp,
    tierLow: row.tier_low,
    tierMedium: row.tier_med,
    tierHigh: row.tier_high,
  };
}

const DEFAULT_HISTORY_N = 144; // ~12h of 5min heartbeats
const MAX_HISTORY_N = 8640; // 上限 8640（30 天 × 288 条/天），支持按周/月聚合分析

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // 历史 health_metrics 时序
  app.get('/api/health/history', async (req, _reply) => {
    const query = (req.query as { n?: string }) ?? {};
    let n = DEFAULT_HISTORY_N;
    if (query.n !== undefined) {
      const parsed = Number(query.n);
      if (Number.isFinite(parsed) && parsed > 0) {
        // 截断到 [1, MAX_HISTORY_N]
        n = Math.min(Math.trunc(parsed), MAX_HISTORY_N);
      }
    }
    const rows = queryHealthHistory(n);
    const snapshots = rows.map(rowToSnapshot);
    return { snapshots };
  });

  // 最新一条 db 快照 + 插件内存态（并行，snapshot 失败不阻塞 db）
  app.get('/api/health/latest', async () => {
    const [row, memory] = await Promise.all([
      Promise.resolve(queryHealthLatest()),
      fetchPluginSnapshot().catch(() => null),
    ]);
    const db = row ? rowToSnapshot(row) : null;
    return { db, memory: (memory as PluginSnapshot | null) ?? null };
  });
}
