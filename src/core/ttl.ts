// ============================================================
// TTL Expiration, Weight Decay, and Cleanup Scheduler
// ============================================================

import { GraphMemoryManager } from './graph';
import { DEFAULTS } from '../config/defaults.js';
import { getGlobalLogger } from '../utils/logger.js';

// ---------- Types ---------------------------------------------------------

export interface TTLConfig {
  enabled: boolean;
  retentionDays: number;         // 默认 90 天
  cleanupIntervalHours: number;  // 默认 24 小时
  minWeight: number;            // 最低权重，低于此值的节点可清理
  pinnedExempt: boolean;        // 固定节点是否豁免
}

export const DEFAULT_TTL_CONFIG: TTLConfig = {
  enabled: true,
  retentionDays: 90,
  cleanupIntervalHours: 24,
  minWeight: 0.1,
  pinnedExempt: true,
};

// ---------- Helpers -------------------------------------------------------

/**
 * Parse an ISO date string to a Date object.
 *
 * P1-7 BUG-4: 原代码对坏数据/缺失值回退 `new Date()`（现在），导致节点被判为
 * "刚创建" → `created >= cutoff` → 永不过期。改为回退 epoch（1970-01-01），
 * 让数据损坏/缺失的节点被强制过期清理（保守策略：宁删勿留）。
 */
function parseDate(value: string | undefined): Date {
  if (!value) return new Date(0);
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** Return the number of days elapsed between two dates. */
function daysBetween(older: Date, newer: Date): number {
  return (newer.getTime() - older.getTime()) / (1000 * 60 * 60 * 24);
}

// ---------- findExpiredNodes ----------------------------------------------

/**
 * Find node IDs that should be removed due to age and low weight.
 *
 * A node is expired when:
 *   - Its `createdAt` is older than `retentionDays`, **and**
 *   - Its effective weight (after implicit decay) falls below `minWeight`.
 *
 * If `pinnedExempt` is true, nodes with `pinned === true` are never returned.
 */
export function findExpiredNodes(
  manager: GraphMemoryManager,
  config: TTLConfig
): string[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.retentionDays);

  return manager._allNodeEntries().reduce<string[]>((ids, [id, node]) => {
    // pinned exemption
    if (config.pinnedExempt && node.pinned) return ids;

    const created = parseDate(node.createdAt);
    if (created >= cutoff) return ids; // not old enough

    // Weight check — treat undefined / missing weight as 1.0 (safe default)
    const effectiveWeight = typeof node.weight === 'number' ? node.weight : 1.0;
    if (effectiveWeight > config.minWeight) return ids;

    ids.push(id);
    return ids;
  }, []);
}

// ---------- cleanupExpiredNodes -------------------------------------------

export async function cleanupExpiredNodes(
  manager: GraphMemoryManager,
  config: TTLConfig
): Promise<{
  deleted: string[];
  kept: string[];
  reasonByNode: Record<string, string>;
}> {
  const expiredIds = findExpiredNodes(manager, config);

  const deleted: string[] = [];
  const kept: string[] = [];
  const reasonByNode: Record<string, string> = {};

  for (const id of expiredIds) {
    const node = manager.getNode(id);
    if (!node) continue;

    // Determine reason(s)
    const reasons: string[] = [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.retentionDays);
    if (parseDate(node.createdAt) < cutoff) {
      reasons.push(`exceeded retention (${config.retentionDays} days)`);
    }
    const effectiveWeight = typeof node.weight === 'number' ? node.weight : 1.0;
    if (effectiveWeight <= config.minWeight) {
      reasons.push(`low weight (${effectiveWeight} ≤ ${config.minWeight})`);
    }

    manager.removeNode(id);
    deleted.push(id);
    reasonByNode[id] = reasons.join('; ');
  }

  // Nodes that exist but are not expired → kept (subset for report brevity)
  for (const [id, node] of manager._allNodeEntries()) {
    if (deleted.includes(id)) continue;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.retentionDays);
    const effectiveWeight = typeof node.weight === 'number' ? node.weight : 1.0;
    if (parseDate(node.createdAt) < cutoff || effectiveWeight <= config.minWeight) {
      // borderline — kept alive by pin or age alone not enough
      kept.push(id);
      reasonByNode[id] = 'kept (does not meet all removal criteria)';
    }
  }

  return { deleted, kept, reasonByNode };
}

// ---------- applyWeightDecay ----------------------------------------------

/**
 * Apply exponential weight decay to every node in the graph.
 *
 * Formula: `weight *= 0.5 ^ (daysSinceUpdate / halfLifeDays)`
 *
 * Clamped to `minWeight` so no node ever falls below the floor.
 */
export function applyWeightDecay(
  manager: GraphMemoryManager,
  halfLifeDays: number = DEFAULTS.ttl.halfLifeDays,
  minWeight: number = 0.01
): void {
  if (halfLifeDays <= 0) return;

  const now = new Date();
  for (const [id, node] of manager._allNodeEntries()) {
    let w: number;
    if (typeof node.weight === 'number') {
      w = node.weight;
    } else {
      continue; // no weight yet — nothing to decay
    }

    const updated = parseDate(node.updatedAt);
    const daysSinceUpdate = daysBetween(updated, now);
    const factor = Math.pow(0.5, daysSinceUpdate / halfLifeDays);
    w = Math.max(minWeight, w * factor);

    manager.updateNode(id, { weight: w });
  }
}

// ---------- CleanupScheduler ----------------------------------------------

export interface CleanupScheduler {
  stop: () => void;
  lastRun: string | null;
  runCount: number;
}

/**
 * Start a periodic cleanup scheduler.
 *
 * Returns a handle that tracks when it last ran and how many times,
 * plus a `stop` method to tear down the interval.
 */
export function startCleanupScheduler(
  manager: GraphMemoryManager,
  config: TTLConfig,
  onCleanup?: (result: Awaited<ReturnType<typeof cleanupExpiredNodes>>) => void
): CleanupScheduler {
  let lastRun: string | null = null;
  let runCount = 0;

  const intervalMs = config.cleanupIntervalHours * 60 * 60 * 1000;
  const timer = setInterval(async () => {
    if (!config.enabled) return;

    try {
      const result = await cleanupExpiredNodes(manager, config);
      lastRun = new Date().toISOString();
      runCount++;
      onCleanup?.(result);
    } catch (e) {
      // silent — scheduler should not crash the host process
      getGlobalLogger()?.debug?.("TTL cleanup scheduler iteration failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }
  }, intervalMs);

  return {
    get lastRun() { return lastRun; },
    get runCount() { return runCount; },
    stop() { clearInterval(timer); },
  };
}

// ---------- Neo4j-backed TTL (runtime path) --------------------------------

/**
 * Neo4j 图谱适配器最小接口约定（仅用到 query 方法）。
 * 避免直接 import GraphAdapter 形成循环依赖。
 */
export interface Neo4jTtlAdapter {
  query<T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/**
 * P0-2: 在 Neo4j 上执行权重衰减。
 *
 * 原有 `applyWeightDecay` 只作用于内存 GraphMemoryManager，而持久化节点存放在 Neo4j，
 * 内存图在每次检索后才临时加载，进程退出即丢失。因此节点权重永不衰减，TTL 过期判断
 * 失效，`lcmg_pin` 的豁免语义也无意义。
 *
 * 本函数在 Neo4j 上执行权重衰减：
 *   weight = max(minWeight, weight * 0.5 ^ (daysSinceUpdate / halfLifeDays))
 * 跳过 pinned=true 的节点（pinnedExempt=true 时）与无 weight 属性的节点。
 *
 * 实现为「读取 → JS 计算 → 批量写回」：部署环境的 Cypher 不支持 pow/power 等
 * 数学函数（报 Unknown function），因此在应用侧用 Math.pow 计算衰减因子。
 */
export async function applyNeo4jWeightDecay(
  adapter: Neo4jTtlAdapter,
  halfLifeDays: number = DEFAULTS.ttl.halfLifeDays,
  minWeight: number = 0.01,
  pinnedExempt: boolean = true,
): Promise<number> {
  if (halfLifeDays <= 0) return 0;
  try {
    const exemptClause = pinnedExempt ? 'AND NOT n.pinned = true' : '';

    // v2.1.12 修复：不再在 Cypher 里用数学函数（pow/power）。
    // 实测部署环境对这两个函数都报 "Unknown function"（非标准 Neo4j 或函数被限制），
    // 导致权重衰减从未生效。改为「读取 → JS 计算 → 批量写回」，不依赖任何 DB 数学函数。
    const rows = await adapter.query(
      `MATCH (n) WHERE n.weight IS NOT NULL AND n.updatedAt IS NOT NULL ${exemptClause}
       RETURN id(n) AS id, n.weight AS w, n.updatedAt AS ua`,
    );
    if (!rows || rows.length === 0) return 0;

    const now = Date.now();
    const updates: Array<{ id: number; w: number }> = [];
    for (const row of rows) {
      const id = Number(row?.id);
      if (!Number.isFinite(id)) continue;
      const w = Number(row?.w ?? 1);
      const uaDate = new Date(String(row?.ua));
      if (isNaN(uaDate.getTime())) continue;
      const secs = Math.max(0, (now - uaDate.getTime()) / 1000);
      if (secs <= 0) continue;
      // 衰减公式：weight = max(minWeight, weight * 0.5 ^ (daysSinceUpdate / halfLifeDays))
      const factor = Math.pow(0.5, (secs / 86400.0) / halfLifeDays);
      const newW = Math.max(minWeight, w * factor);
      updates.push({ id, w: newW });
    }
    if (updates.length === 0) return 0;

    // 批量写回（UNWIND 一条事务完成所有更新）
    await adapter.query(
      `UNWIND $rows AS row
       MATCH (n) WHERE id(n) = row.id
       SET n.weight = row.w
       RETURN count(n) AS c`,
      { rows: updates },
    );
    return updates.length;
  } catch (err) {
    getGlobalLogger()?.error?.('applyNeo4jWeightDecay failed — weight decay skipped, nodes will retain stale weights', { err: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

/**
 * P0-2: 在 Neo4j 上清理过期节点。
 *
 * 删除同时满足以下条件的节点：
 *   1. updatedAt 早于 retentionDays 天前
 *   2. weight < minWeight
 *   3. （pinnedExempt=true 时）非 pinned
 *
 * 返回删除的节点数。注意：DETACH DELETE 会一并删除关联边。
 */
export async function cleanupNeo4jExpiredNodes(
  adapter: Neo4jTtlAdapter,
  config: TTLConfig = DEFAULT_TTL_CONFIG,
): Promise<number> {
  if (!config.enabled) return 0;
  try {
    const exemptClause = config.pinnedExempt ? 'AND NOT n.pinned = true' : '';
    const result = await adapter.query(
      `MATCH (n) WHERE n.updatedAt IS NOT NULL ${exemptClause}
       WITH n, datetime(n.updatedAt) AS ua, datetime() AS now
       WHERE duration.inseconds(ua, now).seconds > $retentionSecs
         AND (coalesce(n.weight, 1.0) < $minWeight)
       DETACH DELETE n
       RETURN count(n) AS c`,
      { retentionSecs: config.retentionDays * 86400, minWeight: config.minWeight },
    );
    const row = result?.[0] as { c?: { toNumber?: () => number } | number } | undefined;
    const c = (row?.c as any)?.toNumber ? (row?.c as any).toNumber() : (row?.c as number) ?? 0;
    return typeof c === 'number' ? c : 0;
  } catch (err) {
    getGlobalLogger()?.error?.('cleanupNeo4jExpiredNodes failed — expired node cleanup skipped', { err: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
