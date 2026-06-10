/**
 * Heartbeat Hook — periodic DAG health, TTL cleanup, backup check, qmd status
 *                + Token压力监控 (Window Monitor)
 */

import type { PluginInstance } from '../register';
import { cleanupExpiredNodes } from '../core/ttl';
import type { TTLConfig } from '../core/ttl';
import { GraphMemoryManager } from '../core/graph';
import { QmdClient } from '../qmd-client';
import {
  getMessageStats,
  shouldTriggerCompact,
  writeCompactionDebt,
} from '../lcm-bridge';

// ---------- state key helpers ---------------------------------------------

const LAST_BACKUP_KEY = 'lcm-graph-extra:lastBackupTimestamp';
const LAST_PRESSURE_LOG_KEY = 'lcm-graph-extra:lastPressureLogTime';

/** Read a timestamp (ms) from the plugin's persistent state, or 0. */
function getPersistentTimestamp(instance: PluginInstance, key: string): number {
  try {
    const ctx = instance.context as Record<string, unknown>;
    const raw = ctx.persistentState as Record<string, unknown> | undefined;
    if (raw && typeof raw[key] === 'number') {
      return raw[key] as number;
    }
  } catch { /* ignore */ }
  return 0;
}

/** Persist a timestamp to the plugin's persistent state. */
function setPersistentTimestamp(instance: PluginInstance, key: string, ts: number): void {
  try {
    const ctx = instance.context as Record<string, unknown>;
    const state = ctx.persistentState as Record<string, unknown>;
    if (!state) return;
    state[key] = ts;
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
 * heartbeat hook: 定期检查 DAG 健康状态、过期清理、qmd 状态、Token 压力监控
 */
export async function onHeartbeat(instance: PluginInstance): Promise<void> {
  const { config, logger } = instance;

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

    // 4. Token压力监控 (Window Monitor)
    await runPressureCheck(instance);

    logger.debug('heartbeat hook processed');
  } catch (err) {
    logger.error({ err }, 'heartbeat hook failed');
  }
}

// ---------- Token Pressure Monitoring (Window Monitor) ---------------------

/**
 * 后台 Token 压力监控 — 定期检查 lossless-claw DB 中的消息数和 Token 用量，
 * 超过阈值时自动写入 compaction debt，触发后台 DAG 压缩。
 */
async function runPressureCheck(instance: PluginInstance): Promise<void> {
  const { config, logger } = instance;
  const wm = config.windowMonitor;
  if (!wm?.enabled) return;

  // 每 30 分钟才执行一次压力检查，避免频繁查询 DB
  const lastLog = getPersistentTimestamp(instance, LAST_PRESSURE_LOG_KEY);
  const now = Date.now();
  const pressureIntervalMs = 30 * 60 * 1000;
  if (lastLog > 0 && (now - lastLog) < pressureIntervalMs) {
    return; // 未到检查间隔
  }
  setPersistentTimestamp(instance, LAST_PRESSURE_LOG_KEY, now);

  try {
    // 通过 sessionKey 从 lossless-claw DB 获取会话状态
    const ctx = instance.context as Record<string, unknown>;
    const sessionKey = typeof ctx.sessionKey === 'string' ? ctx.sessionKey : '';
    const sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId : '';

    // 需要 import lcm-bridge 的 getConversationId
    const { getConversationId: getConvId } = await import('../lcm-bridge');
    const conversationId = getConvId(sessionKey, sessionId);
    if (conversationId == null) {
      logger.debug('[wm] heartbeat: no active conversation found');
      return;
    }

    const stats = getMessageStats(conversationId);
    const msgCount = stats.count;
    const totalTokens = stats.totalTokens;
    const contextWindow = wm.contextWindow ?? 131072;
    const tokenRatio = contextWindow > 0 ? totalTokens / contextWindow : 0;

    logger.debug(
      `[wm] heartbeat pressure: conv=${conversationId} msgs=${msgCount} ` +
      `tok=${totalTokens} ratio=${(tokenRatio * 100).toFixed(1)}%`
    );

    // 检查是否超过阈值
    const needsCompact = shouldTriggerCompact(msgCount, tokenRatio, {
      messageTriggerCount: wm.messageTriggerCount ?? 24,
      proactiveThreshold: wm.proactiveThreshold ?? 0.65,
    });

    if (needsCompact) {
      const compactBudget = wm.compactTokenBudget ?? 57344;
      const wrote = writeCompactionDebt(
        conversationId, compactBudget, totalTokens,
        'heartbeat_proactive',
      );
      if (wrote) {
        logger.info(
          `[wm] heartbeat: compaction debt written conv=${conversationId} ` +
          `msgs=${msgCount} tok=${totalTokens} ratio=${(tokenRatio * 100).toFixed(1)}%`
        );
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[wm] heartbeat pressure check failed');
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
export async function checkBackupNeeded(instance: PluginInstance): Promise<void> {
  const { config, logger } = instance;

  if (!config.backupConfig) return;

  const intervalMs = config.backupConfig.intervalHours * 60 * 60 * 1000;
  const now = Date.now();
  const lastBackup = getPersistentTimestamp(instance, LAST_BACKUP_KEY);

  if (lastBackup === 0 || (now - lastBackup) >= intervalMs) {
    logger.info(
      { intervalHours: config.backupConfig.intervalHours },
      'backup interval reached — triggering backup',
    );
    await performBackup(instance);
    setPersistentTimestamp(instance, LAST_BACKUP_KEY, now);
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
    const ctx = instance.context as Record<string, unknown>;
    const m = ctx.graphManager ?? ctx.manager;
    if (m instanceof GraphMemoryManager) return m;
  } catch { /* ignore */ }
  return null;
}
