/**
 * Heartbeat Hook — periodic DAG health, TTL cleanup, backup check, qmd status
 */

import type { PluginInstance } from '../register';
// DreamingEngine removed (2026-06-10): replaced by OpenClaw native runDreamingSweepPhases
import { cleanupExpiredNodes } from '../core/ttl';
import type { TTLConfig } from '../core/ttl';
import { GraphMemoryManager } from '../core/graph';
import { QmdClient } from '../qmd-client';

// ---------- state key helpers ---------------------------------------------

const LAST_BACKUP_KEY = 'lcm-graph-extra:lastBackupTimestamp';

/** Read a timestamp (ms) from the plugin's persistent state, or 0. */
function getLastBackupTimestamp(instance: PluginInstance): number {
  try {
    const ctx = instance.context as unknown as Record<string, unknown>;
    const raw = ctx.persistentState as Record<string, unknown> | undefined;
    if (raw && typeof raw[LAST_BACKUP_KEY] === 'number') {
      return raw[LAST_BACKUP_KEY] as number;
    }
  } catch { /* ignore */ }
  return 0;
}

/** Persist a timestamp to the plugin's persistent state. */
function setLastBackupTimestamp(instance: PluginInstance, ts: number): void {
  try {
    const ctx = instance.context as unknown as Record<string, unknown>;
    const state = ctx.persistentState as Record<string, unknown>;
    if (!state) return;
    state[LAST_BACKUP_KEY] = ts;
  } catch { /* ignore */ }
}

// ---------- lazy QmdClient singleton ---------------------------------------

let _qmdClient: QmdClient | null = null;

function getQmdClient(): QmdClient {
  if (!_qmdClient) _qmdClient = new QmdClient();
  return _qmdClient;
}

// ---------- onHeartbeat ---------------------------------------------------

/**
 * heartbeat hook: 定期检查 DAG 健康状态、过期清理、qmd 状态
 *
 * TODO: 接入 OpenClaw 原生 runDreamingSweepPhases 替代自建 DreamingEngine
 *   - 从 openclaw/dist/dreaming-phases 导入
 *   - 传入 workspaceDir + pluginConfig + logger
 */
export async function onHeartbeat(instance: PluginInstance): Promise<void> {
  const { config, logger } = instance;

  // DreamingEngine removed — will be replaced by OpenClaw runDreamingSweepPhases
  // (see TODO above)

  try {
    // 1. TTL 清理（如果启用）
    if (config.ttl?.enabled) {
      await runTTLCleanup(instance);
    }

    // 2. DAG 健康检查 + qmd 状态检测
    await runHealthCheck(instance);

    // 3. 备份检查
    if (config.backupConfig?.enabled) {
      await checkBackupNeeded(instance);
    }

    logger.debug('heartbeat hook processed');
  } catch (err) {
    logger.error({ err }, 'heartbeat hook failed');
  }
}

// ---------- TTL Cleanup ---------------------------------------------------

/**
 * Run TTL cleanup against the current graph, logging what was removed.
 */
export async function runTTLCleanup(instance: PluginInstance): Promise<void> {
  const { config, logger } = instance;

  const manager = getManager(instance);
  if (!manager) {
    logger.debug('no GraphMemoryManager for TTL cleanup — skipping');
    return;
  }

  const ttlConfig: TTLConfig = {
    enabled: true,
    retentionDays: config.ttl?.retentionDays ?? 90,
    cleanupIntervalHours: config.ttl?.cleanupIntervalHours ?? 24,
    minWeight: 0.1,
    pinnedExempt: true,
  };

  const result = await cleanupExpiredNodes(manager, ttlConfig);
  if (result.deleted.length > 0) {
    logger.info({ deleted: result.deleted.length }, 'TTL cleanup removed expired nodes');
  } else {
    logger.debug('TTL cleanup: no expired nodes to remove');
  }
}

// ---------- Health Check --------------------------------------------------

/**
 * Walk the DAG and log warnings about orphan nodes or cycles.
 * Also checks qmd MCP status.
 */
export async function runHealthCheck(instance: PluginInstance): Promise<void> {
  const { logger } = instance;

  // --- qmd status check --------------------------------------------------
  let qmdOnline = false;
  try {
    qmdOnline = await getQmdClient().ping();
    logger.debug({ qmdOnline }, 'qmd MCP health check');
  } catch {
    logger.debug('qmd MCP health check failed');
  }

  // --- DAG health ---------------------------------------------------------
  const manager = getManager(instance);
  if (!manager) {
    logger.debug('no GraphMemoryManager for health check — skipping');
    return;
  }

  let orphanCount = 0;
  for (const [id] of manager._allNodeEntries()) {
    const edges = manager.getEdgesForNode(id);
    if (edges.incoming.length === 0 && edges.outgoing.length === 0) {
      orphanCount++;
    }
  }

  const hasCycle = manager.hasCycle();
  const totalNodes = manager._allNodeEntries().length;

  if (orphanCount > 0) {
    logger.warn({ orphanCount, totalNodes }, 'DAG health: orphan nodes detected');
  }
  if (hasCycle) {
    logger.warn('DAG health: cycle(s) detected in the graph');
  }

  logger.debug(
    { totalNodes, orphanCount, hasCycle, qmdOnline },
    'DAG health check completed',
  );
}

// ---------- Backup Check --------------------------------------------------

/**
 * If enough time has passed since the last backup, trigger one.
 */
async function checkBackupNeeded(instance: PluginInstance): Promise<void> {
  const { config, logger } = instance;

  if (!config.backupConfig) return;

  const intervalMs = config.backupConfig.intervalHours * 60 * 60 * 1000;
  const now = Date.now();
  const lastBackup = getLastBackupTimestamp(instance);

  if (lastBackup === 0 || (now - lastBackup) >= intervalMs) {
    logger.info(
      { intervalHours: config.backupConfig.intervalHours },
      'backup interval reached — triggering backup',
    );
    await performBackup(instance);
    setLastBackupTimestamp(instance, now);
  } else {
    const remaining = ((intervalMs - (now - lastBackup)) / (60 * 60 * 1000)).toFixed(1);
    logger.debug({ remainingHours: Number(remaining) }, 'backup not yet due');
  }
}

/**
 * Perform the actual backup (skeleton — logs intent, delegates to lifecycle/compact in future).
 */
async function performBackup(instance: PluginInstance): Promise<void> {
  const { logger } = instance;
  logger.info('backup started');
  // (future: call lifecycle.backupGraph or similar)
  logger.info('backup completed');
}

// ---------- Helpers -------------------------------------------------------

/**
 * Try to resolve the GraphMemoryManager from the plugin context.
 */
function getManager(instance: PluginInstance): GraphMemoryManager | null {
  try {
    const ctx = instance.context as unknown as Record<string, unknown>;
    const m = ctx.graphManager ?? ctx.manager;
    if (m instanceof GraphMemoryManager) return m;
  } catch { /* ignore */ }
  return null;
}
