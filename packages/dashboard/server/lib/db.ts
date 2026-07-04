/**
 * lcm.db 只读连接工具。
 *
 * 与主包 src/health-metrics.ts 保持一致：通过 createRequire 方式加载 node:sqlite，
 * 避免直接 import 引发 TS 类型缺失问题。
 *
 * 表结构（见 src/health-metrics.ts 第 154 行附近）：
 *   health_metrics (
 *     ts INTEGER PRIMARY KEY,
 *     pending_msgs, summary_frags, token_ratio,
 *     cb_lcm_ok, cb_qmd_ok, cb_neo4j_ok,
 *     cb_lcm_fails, cb_qmd_fails, cb_neo4j_fails,
 *     assemble_ms, l2_ms, l3_ms, l4_ms,
 *     pending_exp, distilled_exp,
 *     tier_low, tier_med, tier_high
 *   )
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const req = createRequire(import.meta.url);
// node:sqlite 是 Node 内置模块，DatabaseSync 类型由 @types/node 提供
const { DatabaseSync } = req('node:sqlite') as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseSyncLike;
};

/** DatabaseSync 的最小可用类型描述（仅用到的部分） */
interface DatabaseSyncLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
  exec(sql: string): void;
}

// 单例 db 连接
let dbInstance: DatabaseSyncLike | null = null;

/** lcm.db 路径：从 env 读取，默认 ~/.openclaw/lcm.db */
function resolveDbPath(): string {
  const fromEnv = process.env.LCM_DB_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return resolve(homedir(), '.openclaw', 'lcm.db');
}

/**
 * 获取 lcm.db 只读连接（单例）。
 * 若文件不存在则返回 null（调用方需处理降级）。
 */
export function getDb(): DatabaseSyncLike | null {
  if (dbInstance) return dbInstance;
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    return null; // DB 不存在，调用方降级
  }
  dbInstance = new DatabaseSync(dbPath, { readOnly: true });
  return dbInstance;
}

/** health_metrics 表的行类型（与 src/health-metrics.ts 的 HealthSnapshot 对应） */
export interface HealthMetricRow {
  ts: number;
  pending_msgs: number;
  summary_frags: number;
  token_ratio: number;
  cb_lcm_ok: number;
  cb_qmd_ok: number;
  cb_neo4j_ok: number;
  cb_lcm_fails: number;
  cb_qmd_fails: number;
  cb_neo4j_fails: number;
  assemble_ms: number;
  l2_ms: number;
  l3_ms: number;
  l4_ms: number;
  pending_exp: number;
  distilled_exp: number;
  tier_low: number;
  tier_med: number;
  tier_high: number;
}

/**
 * 查询最近 n 条健康指标历史（按 ts DESC）。
 * 复用 src/health-metrics.ts readFromDb 的查询逻辑。
 */
export function queryHealthHistory(n: number = 20): HealthMetricRow[] {
  const db = getDb();
  if (!db) return [];
  const limit = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 20;
  try {
    const rows = db
      .prepare('SELECT * FROM health_metrics ORDER BY ts DESC LIMIT ?')
      .all(limit) as HealthMetricRow[];
    return rows;
  } catch {
    return [];
  }
}

/** 查询最新一条健康指标 */
export function queryHealthLatest(): HealthMetricRow | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db
      .prepare('SELECT * FROM health_metrics ORDER BY ts DESC LIMIT 1')
      .get() as HealthMetricRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** 关闭 db 连接（测试/优雅关闭用） */
export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // 忽略关闭错误
    }
    dbInstance = null;
  }
}
