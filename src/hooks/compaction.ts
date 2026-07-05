/**
 * on_compaction hook — CE 协调的压缩策略。
 *
 * ownsCompaction = true:
 *   1. CE 决策: 判断上下文是否需要压缩
 *   2. 执行: 委托 OpenClaw 内置 lossless-claw compact()
 *   3. 后处理: 提取关键实体 + 经验 → 写入 Neo4j
 *
 * 注意: lossless-claw 的合并/压缩是 OpenClaw 内置行为。
 * 本 hook 仅在 CE 收到 compact() 调用时触发附加逻辑。
 */

import fs from 'fs/promises';
import path from 'path';
import type { PluginInstance } from '../register';
import { serializeError } from '../utils/logger.js';
// P2-6 H-12: resolveNeo4jConfig 已移除（step 3 死代码块删除后无引用）。

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Create a timestamped backup of `filePath` inside `backupDir`. */
async function backupFile(filePath: string, backupDir: string): Promise<string> {
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = path.basename(filePath);
  const backupPath = path.join(backupDir, `${baseName}.bak-${stamp}`);
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

/** Return all existing backups for a given original file, newest first. */
async function listBackupsForFile(
  filePath: string,
  backupDir: string,
): Promise<string[]> {
  const baseName = path.basename(filePath);
  try {
    const entries = await fs.readdir(backupDir);
    return entries
      .filter((e) => e.startsWith(`${baseName}.bak-`))
      .map((e) => path.join(backupDir, e))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Enforce max-backup retention by deleting oldest backups. */
async function enforceRetention(
  filePath: string,
  backupDir: string,
  maxBackups: number,
): Promise<void> {
  const backups = await listBackupsForFile(filePath, backupDir);
  while (backups.length > maxBackups) {
    const oldest = backups.pop();
    if (oldest) {
      try { await fs.unlink(oldest); } catch { /* already gone */ }
    }
  }
}

/** Resolve the backup directory from plugin config or fall back to `<memoryDir>/backups`. */
function resolveBackupDir(instance: PluginInstance): string {
  const cfg = instance.config;
  if (cfg.backupConfig?.backupDir) return cfg.backupConfig.backupDir;
  const memoryDir = instance.context.memoryDir || '.';
  return path.join(memoryDir, 'backups');
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * Called when CE decides compression is needed.
 *
 * Flow:
 *   1. 备份 memory 文件
 *   2. 委托 lossless-claw 执行实际 DAG 压缩
 *      (lossless-claw compact 是 OpenClaw 内置行为，无需手动调用)
 *   3. 压缩后提取关键实体 → 写入 Neo4j
 *   4. 记录压缩元数据
 */
export async function onCompaction(instance: PluginInstance): Promise<void> {
  const logger = instance.logger;

  // --- compaction config (fallback to lcmMonitor) ---------------------
  const rawCompConfig = instance.config.compaction;
  const lcmMonitor = instance.config.lcmMonitor;

  // If compaction config is empty/missing, fall back to lcmMonitor
  const compConfig = (
    rawCompConfig && Object.keys(rawCompConfig).length > 0
      ? rawCompConfig
      : lcmMonitor || {}
  );

  if (compConfig?.enabled === false) {
    logger?.debug?.('compaction: disabled by config, skipping');
    return;
  }

  const memoryDir = instance.context.memoryDir;
  if (!memoryDir) {
    logger?.warn?.('compaction: no memoryDir in context, cannot proceed');
    return;
  }

  // --- step 1 — backup memory files before compaction --------------------
  const backupDir = resolveBackupDir(instance);
  const maxBackups = instance.config.backupConfig?.maxBackups ?? 10;
  let fileCount = 0;
  try {
    const entries = await fs.readdir(memoryDir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const fp = path.join(memoryDir, entry);
      const stat = await fs.stat(fp);
      if (!stat.isFile()) continue;
      await backupFile(fp, backupDir);
      fileCount++;

      // Retention per file
      await enforceRetention(fp, backupDir, maxBackups);
    }
  } catch (err) {
    logger?.error?.('compaction: backup failed', { err: serializeError(err) });
  }

  // --- step 2 — delegate to lossless-claw via adapter ------------------
  try {
    const inst = instance as any;
    const adapter = inst._losslessClawAdapter;
    if (adapter && adapter.connected) {
      // Use SDK-injected context values directly (no fallback needed)
      // 修复：sessionId 可能是 number 类型（OpenClaw SDK 的 conversationId），
      // lossless-claw 内部调用 sessionId.trim() 会抛 "sessionId?.trim is not a function"
      // 强制 String 化确保下游始终拿到 string
      const sessionId = inst.context.sessionId != null
        ? String(inst.context.sessionId)
        : inst.context.sessionId;
      const sessionKey = inst.context.sessionKey;
      const sessionFile = inst.context.sessionFile;

      if (!sessionId || !sessionFile) {
        logger?.warn?.('compaction: missing sessionId or sessionFile in context, skipping');
        return;
      }

      const compactResult = await adapter.compact({
        sessionId,
        sessionKey,
        sessionFile,
        tokenBudget: (lcmMonitor as any)?.compactTokenBudget ?? (compConfig as any)?.compactTokenBudget ?? (compConfig as any)?.tokenBudget ?? Math.floor(((lcmMonitor as any)?.contextWindow ?? (compConfig as any)?.contextWindow ?? 262_144) * 0.45),
        force: (compConfig as any)?.force ?? true,
        currentTokenCount: undefined,
        customInstructions: (compConfig as any)?.customInstructions,
        runtimeContext: {
          workspaceDir: memoryDir,
        },
      });
      // CompactionResult 结构: { ok, compacted, reason, summaryId, summary, result: { actionTaken, tokensBefore, tokensAfter, condensed, createdSummaryId, summary }, exhausted }
      const didCompact = compactResult.compacted === true;
      const resultData = compactResult.result ?? {};

      if (didCompact) {
        logger?.info?.("compaction: lossless-claw DAG compact completed", {
          compacted: compactResult.compacted,
          tokensBefore: resultData.tokensBefore,
          tokensAfter: resultData.tokensAfter,
          condensed: resultData.condensed,
          createdSummaryId: resultData.createdSummaryId,
          summaryId: compactResult.summaryId,
          exhausted: compactResult.exhausted,
        });
      } else {
        logger?.info?.("compaction: lossless-claw — no action needed", {
          reason: compactResult.reason,
          exhausted: compactResult.exhausted,
        });
      }
    } else {
      logger?.debug?.("[lcm-graph-extra] LosslessClawAdapter not connected, skipping DAG compact");
    }
  } catch (err) {
    const errMsg = typeof err === "string" ? err : (err as Error).message ?? "unknown";
      if (errMsg.includes("replay") || errMsg.includes("refused")) {
        logger?.warn?.("compaction: lossless-claw replay protection active, will retry next cycle", { err: serializeError(err) });
      } else {
        logger?.warn?.("compaction: LosslessClawAdapter call failed (non-fatal)", { err: serializeError(err) });
      }
  }
  // --- step 3 — post-compaction entity extraction -------------------------
  // P2-6 H-12/H-15: 移除死代码块。原代码 `new GraphAdapter(...)` + `adapter.query(...)`
  // 存在两个问题：
  // 1. GraphAdapter 无 query 方法 → 调用必抛 TypeError，被 catch 静默吞掉，整块无副作用但也无效果。
  // 2. 即便 query 存在，new GraphAdapter 绕过 index.ts 的单例 graphAdapter，
  //    会创建第二个 Neo4j driver（连接池浪费 + 状态不同步）。
  // CompactionEvent 记录功能从未生效，移除死代码比保留误导性调用更诚实。
  // 若未来需要压缩事件追踪，应通过 index.ts 暴露的 graphAdapter 单例实现。

  // --- step 4 — record DAG snapshot marker ------------------------------
  try {
    const markerPath = path.join(memoryDir, '.compaction-marker.json');
    const marker = {
      timestamp: new Date().toISOString(),
      filesBackedUp: fileCount,
      backupDir,
    };
    await fs.writeFile(markerPath, JSON.stringify(marker, null, 2));
  } catch (err) {
    logger?.warn?.(`compaction: failed to write marker: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test__ = {
  backupFile,
  listBackupsForFile,
  enforceRetention,
  resolveBackupDir,
};
