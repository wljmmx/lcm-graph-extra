// ============================================================
// TTL Expiration, Weight Decay, and Cleanup Scheduler
// ============================================================

import { GraphMemoryManager } from './graph';

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

/** Parse an ISO date string to a Date object, falling back to the current time on failure. */
function parseDate(value: string | undefined): Date {
  if (!value) return new Date();
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date() : d;
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
  halfLifeDays: number = 45,
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
    } catch {
      // silent — scheduler should not crash the host process
    }
  }, intervalMs);

  return {
    get lastRun() { return lastRun; },
    get runCount() { return runCount; },
    stop() { clearInterval(timer); },
  };
}
