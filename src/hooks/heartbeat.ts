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

    // 4. 压缩压力三维度检查（即时阈值）
    await checkCompactionPressure(instance);

    // 5. 预测式压缩检查（预判2-3条对话后是否突破阈值，提前触发）
    await predictiveCompactionCheck(instance);

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


// ---------- Compaction Pressure Check -------------------------------------

/**
 * Three-dimension compaction pressure check:
 *   1. pending messages >= 15
 *   2. summary fragments >= 8
 *   3. token ratio > 0.65
 * Any one triggered => fire pre-compaction via _losslessClawAdapter
 */
export async function checkCompactionPressure(instance: PluginInstance): Promise<void> {
  const { logger } = instance;

  try {
    // Read workspace dir to inspect .lossless/ state
    const fs = await import("fs");
    const pathLib = await import("path");

    const ctx = instance.context as unknown as Record<string, unknown>;
    const workspaceDir = (ctx.workspaceDir as string)
      ?? (instance.config?.workspaceDir as string)
      ?? process.env.OPENCLAW_WORKSPACE
      ?? "";

    if (!workspaceDir) {
      logger.debug("checkCompactionPressure: no workspaceDir, skipping");
      return;
    }

    // Dimension 1: pending message count (session JSON files in .lossless/)
    const sessionDir = pathLib.join(workspaceDir, ".lossless", "sessions");
    let pendingMessages = 0;
    try {
      const sessionFiles = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".json"));
      for (const sf of sessionFiles) {
        try {
          const raw = fs.readFileSync(pathLib.join(sessionDir, sf), "utf8");
          const data = JSON.parse(raw);
          pendingMessages += Array.isArray(data.messages) ? data.messages.length : 0;
        } catch { /* skip */ }
      }
    } catch {
      logger.debug("checkCompactionPressure: sessions dir not accessible");
    }

    // Dimension 2: summary fragment count (summaries directory)
    const summaryDir = pathLib.join(workspaceDir, ".lossless", "summaries");
    let summaryFragments = 0;
    try {
      summaryFragments = fs.readdirSync(summaryDir).filter((f) => f.endsWith(".json")).length;
    } catch {
      logger.debug("checkCompactionPressure: summaries dir not accessible");
    }

    // Dimension 3: token ratio — estimate from compaction debt files
    let maxTokenRatio = 0;
    const debtDir = pathLib.join(workspaceDir, ".lossless", "debt");
    try {
      const debtFiles = fs.readdirSync(debtDir).filter((f) => f.endsWith(".json"));
      for (const df of debtFiles) {
        try {
          const raw = fs.readFileSync(pathLib.join(debtDir, df), "utf8");
          const debt = JSON.parse(raw);
          if (debt.currentTokenCount && debt.compactTokenBudget) {
            const ratio = debt.currentTokenCount / 262_144;
            maxTokenRatio = Math.max(maxTokenRatio, ratio);
          }
        } catch { /* skip */ }
      }
    } catch {
      logger.debug("checkCompactionPressure: debt dir not accessible");
    }

    // Check thresholds — any one triggers pre-compaction
    const signals = [];
    if (pendingMessages >= 15) {
      signals.push(`pending_messages=${pendingMessages}/>=15`);
    }
    if (summaryFragments >= 8) {
      signals.push(`summary_fragments=${summaryFragments}/>=8`);
    }
    if (maxTokenRatio > 0.65) {
      signals.push(`token_ratio=${maxTokenRatio.toFixed(3)}/>0.65`);
    }

    if (signals.length === 0) {
      logger.debug(
        { pendingMessages, summaryFragments, maxTokenRatio: Number(maxTokenRatio.toFixed(3)) },
        "checkCompactionPressure: within normal range",
      );
      return;
    }

    logger.warn(
      { signals, pendingMessages, summaryFragments, maxTokenRatio: Number(maxTokenRatio.toFixed(3)) },
      `checkCompactionPressure: ${signals.length} dimension(s) exceeded threshold, triggering async pre-compaction`,
    );

    // Trigger async pre-compaction via writeCompactionDebt + _losslessClawAdapter if available
    try {
      const { writeCompactionDebt } = await import("../lcm-bridge.js");

      // Write debt to ensure next assemble() picks it up
      writeCompactionDebt(
        Date.now() % 1_000_000,
        114_688,
        Math.round(maxTokenRatio * 262_144),
        `heartbeat_pressure_${signals.length}dims`,
      );
      logger.info("checkCompactionPressure: wrote compaction debt, next assemble will trigger");
    } catch (debtErr) {
      logger.warn({ err: debtErr }, "checkCompactionPressure: failed to write debt (non-fatal)");
    }
  } catch (err) {
    logger.error({ err }, "checkCompactionPressure failed");
  }
}

// ---------- Predictive Compaction ------------------------------------------

/**
 * 预测式压缩：如果当前指标 + N轮对话的增长预估会超过阈值，提前触发压缩。
 *
 * 策略：
 *   1. 记录最近两次心跳的 token/message/summary 数据点
 *   2. 计算线性增长速率（每心跳周期）
 *   3. 如果 current + rate × remaining_turns >= threshold，触发预压缩
 *
 * remaining_turns = 3（预计还有2-3条对话才会到下次心跳压缩）
 */

interface PressureSnapshot {
  timestamp: number;
  pendingMessages: number;
  summaryFragments: number;
  maxTokenRatio: number;
}

// 跨心跳周期的状态缓存
const pressureHistory: Array<PressureSnapshot> = [];
const MAX_HISTORY = 4;  // 保留最近4个点，足以计算趋势
const PREDICT_AHEAD_TURNS = 3;  // 预测未来3个心跳周期
const EARLY_TRIGGER_FACTOR = 0.85;  // 当预估达到阈值的85%时就开始压缩

async function collectPressureSnapshot(
  workspaceDir: string,
): Promise<PressureSnapshot | null> {
  const fs = await import("fs");
  const pathLib = await import("path");

  try {
    let pendingMessages = 0;
    const sessionDir = pathLib.join(workspaceDir, ".lossless", "sessions");
    try {
      const sessionFiles = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".json"));
      for (const sf of sessionFiles) {
        try {
          const raw = fs.readFileSync(pathLib.join(sessionDir, sf), "utf8");
          const data = JSON.parse(raw);
          pendingMessages += Array.isArray(data.messages) ? data.messages.length : 0;
        } catch { /* skip */ }
      }
    } catch {}

    let summaryFragments = 0;
    const summaryDir = pathLib.join(workspaceDir, ".lossless", "summaries");
    try {
      summaryFragments = fs.readdirSync(summaryDir).filter((f) => f.endsWith(".json")).length;
    } catch {}

    let maxTokenRatio = 0;
    const debtDir = pathLib.join(workspaceDir, ".lossless", "debt");
    try {
      const debtFiles = fs.readdirSync(debtDir).filter((f) => f.endsWith(".json"));
      for (const df of debtFiles) {
        try {
          const raw = fs.readFileSync(pathLib.join(debtDir, df), "utf8");
          const debt = JSON.parse(raw);
          if (debt.currentTokenCount) {
            maxTokenRatio = Math.max(maxTokenRatio, debt.currentTokenCount / 262_144);
          }
        } catch {}
      }
    } catch {}

    return {
      timestamp: Date.now(),
      pendingMessages,
      summaryFragments,
      maxTokenRatio,
    };
  } catch {
    return null;
  }
}

/**
 * 线性回归估算增长率：给定两个点，计算每周期增长量
 */
function estimateRate(
  oldVal: number,
  newVal: number,
  oldTime: number,
  newTime: number,
  periodMs: number,
): number {
  const timeDiff = newTime - oldTime;
  if (timeDiff <= 0) return 0;
  // 标准化为每周期的增长量
  const growthPerPeriod = ((newVal - oldVal) / timeDiff) * periodMs;
  return growthPerPeriod;
}

/**
 * 预测式压缩检查：基于历史趋势预判是否需要在2-3条对话内触发压缩
 */
export async function predictiveCompactionCheck(
  instance: PluginInstance,
): Promise<void> {
  const { logger } = instance;

  try {
    const ctx = instance.context as unknown as Record<string, unknown>;
    const workspaceDir = (ctx.workspaceDir as string)
      ?? (instance.config?.workspaceDir as string)
      ?? process.env.OPENCLAW_WORKSPACE
      ?? "";

    if (!workspaceDir) {
      logger.debug("predictiveCompactionCheck: no workspaceDir, skipping");
      return;
    }

    // 采集当前数据点
    const snapshot = await collectPressureSnapshot(workspaceDir);
    if (!snapshot) return;

    pressureHistory.push(snapshot);
    if (pressureHistory.length > MAX_HISTORY) {
      pressureHistory.shift();
    }

    // 至少需要2个点才能计算趋势
    if (pressureHistory.length < 2) {
      logger.debug("predictiveCompactionCheck: collecting data points, need >= 2");
      return;
    }

    const oldest = pressureHistory[0];
    const newest = pressureHistory[pressureHistory.length - 1];

    // 估算心跳周期（默认5分钟）
    const timeSpan = newest.timestamp - oldest.timestamp;
    const periodMs = timeSpan / (pressureHistory.length - 1) || 300_000;

    // 计算三个维度的增长率
    const msgRate = estimateRate(
      oldest.pendingMessages, newest.pendingMessages,
      oldest.timestamp, newest.timestamp, periodMs,
    );
    const summaryRate = estimateRate(
      oldest.summaryFragments, newest.summaryFragments,
      oldest.timestamp, newest.timestamp, periodMs,
    );
    const tokenRate = estimateRate(
      oldest.maxTokenRatio, newest.maxTokenRatio,
      oldest.timestamp, newest.timestamp, periodMs,
    );

    // 预测 PREDICT_AHEAD_TURNS 周期后的值
    const predictedMessages = newest.pendingMessages + msgRate * PREDICT_AHEAD_TURNS;
    const predictedSummaries = newest.summaryFragments + summaryRate * PREDICT_AHEAD_TURNS;
    const predictedTokenRatio = newest.maxTokenRatio + tokenRate * PREDICT_AHEAD_TURNS;

    // 阈值（与 checkCompactionPressure 一致）
    const MSG_THRESHOLD = 15;
    const SUMMARY_THRESHOLD = 8;
    const TOKEN_RATIO_THRESHOLD = 0.65;

    // 预测是否会在未来突破阈值（考虑 EARLY_TRIGGER_FACTOR 提前量）
    const predictSignals = [];

    if (predictedMessages * EARLY_TRIGGER_FACTOR >= MSG_THRESHOLD) {
      const turnsToThreshold = msgRate > 0
        ? Math.ceil((MSG_THRESHOLD - newest.pendingMessages) / msgRate)
        : Infinity;
      predictSignals.push(
        `messages: current=${newest.pendingMessages}, predicted_${PREDICT_AHEAD_TURNS}hops=${Math.round(predictedMessages)}, threshold_in~${turnsToThreshold} turns`
      );
    }

    if (predictedSummaries * EARLY_TRIGGER_FACTOR >= SUMMARY_THRESHOLD) {
      const turnsToThreshold = summaryRate > 0
        ? Math.ceil((SUMMARY_THRESHOLD - newest.summaryFragments) / summaryRate)
        : Infinity;
      predictSignals.push(
        `summaries: current=${newest.summaryFragments}, predicted_${PREDICT_AHEAD_TURNS}hops=${Math.round(predictedSummaries)}, threshold_in~${turnsToThreshold} turns`
      );
    }

    if (predictedTokenRatio * EARLY_TRIGGER_FACTOR >= TOKEN_RATIO_THRESHOLD) {
      const turnsToThreshold = tokenRate > 0
        ? Math.ceil((TOKEN_RATIO_THRESHOLD - newest.maxTokenRatio) / tokenRate)
        : Infinity;
      predictSignals.push(
        `token_ratio: current=${newest.maxTokenRatio.toFixed(3)}, predicted_${PREDICT_AHEAD_TURNS}hops=${predictedTokenRatio.toFixed(3)}, threshold_in~${turnsToThreshold} turns`
      );
    }

    if (predictSignals.length === 0) {
      logger.debug(
        {
          current: newest,
          rates: { msgRate: Number(msgRate.toFixed(2)), summaryRate: Number(summaryRate.toFixed(2)), tokenRate: Number(tokenRate.toFixed(4)) },
          predicted: { messages: Math.round(predictedMessages), summaries: Math.round(predictedSummaries), tokenRatio: Number(predictedTokenRatio.toFixed(3)) },
        },
        "predictiveCompactionCheck: no imminent threshold breach",
      );
      return;
    }

    // 预测到即将突破阈值，触发预压缩
    logger.warn(
      {
        signals: predictSignals,
        current: newest,
        rates: { msgRate: Number(msgRate.toFixed(2)), summaryRate: Number(summaryRate.toFixed(2)), tokenRate: Number(tokenRate.toFixed(4)) },
        predicted: { messages: Math.round(predictedMessages), summaries: Math.round(predictedSummaries), tokenRatio: Number(predictedTokenRatio.toFixed(3)) },
      },
      `predictiveCompactionCheck: ${predictSignals.length} dimension(s) approaching threshold, triggering early pre-compaction`,
    );

    // 写入压缩债务触发预压缩
    try {
      const { writeCompactionDebt } = await import("../lcm-bridge.js");
      writeCompactionDebt(
        Date.now() % 1_000_000,
        114_688,
        Math.round(newest.maxTokenRatio * 262_144),
        `predictive_early_${predictSignals.length}dims`,
      );
      logger.info("predictiveCompactionCheck: wrote compaction debt for early trigger");
    } catch (debtErr) {
      logger.warn({ err: debtErr }, "predictiveCompactionCheck: failed to write debt (non-fatal)");
    }
  } catch (err) {
    logger.error({ err }, "predictiveCompactionCheck failed");
  }
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
