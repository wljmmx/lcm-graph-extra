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
import { resolveNeo4jConfig } from '../config/neo4j-helper';

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

  // --- compaction config (fallback to windowMonitor) ---------------------
  const rawCompConfig = instance.config.compaction;
  const windowMonitor = instance.config.windowMonitor;

  // If compaction config is empty/missing, fall back to windowMonitor
  const compConfig = (
    rawCompConfig && Object.keys(rawCompConfig).length > 0
      ? rawCompConfig
      : windowMonitor || {}
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
    logger?.error?.('compaction: backup failed', { err });
  }

  // --- step 2 — delegate to lossless-claw via adapter ------------------
  try {
    const inst = instance as any;
    const adapter = inst._losslessClawAdapter;
    if (adapter && adapter.connected) {
      // Use SDK-injected context values directly (no fallback needed)
      const sessionId = inst.context.sessionId;
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
        tokenBudget: (windowMonitor as any)?.compactTokenBudget ?? (compConfig as any)?.compactTokenBudget ?? (compConfig as any)?.tokenBudget ?? Math.floor(((windowMonitor as any)?.contextWindow ?? (compConfig as any)?.contextWindow ?? 131072) * 0.45),
        force: (compConfig as any)?.force ?? true,
        currentTokenCount: undefined,
        customInstructions: (compConfig as any)?.customInstructions,
        runtimeContext: {
          workspaceDir: memoryDir,
        },
      });
      if (compactResult.ok) {
        logger?.info?.("compaction: lossless-claw DAG compact completed");
      } else {
        const reasonStr = compactResult.reason ?? "";
      if (reasonStr.includes("replay") || reasonStr.includes("refused")) {
        logger?.warn?.("compaction: lossless-claw replay protection triggered, skipping DAG compact", { reason: reasonStr });
      } else {
        logger?.warn?.("compaction: lossless-claw adapter compact reported issue", { reason: reasonStr });
      }
      }
    } else {
      logger?.debug?.("[lcm-graph-extra] LosslessClawAdapter not connected, skipping DAG compact");
    }
  } catch (err) {
    const errMsg = typeof err === "string" ? err : (err as Error).message ?? "unknown";
      if (errMsg.includes("replay") || errMsg.includes("refused")) {
        logger?.warn?.("compaction: lossless-claw replay protection active, will retry next cycle", { err });
      } else {
        logger?.warn?.("compaction: LosslessClawAdapter call failed (non-fatal)", { err });
      }
  }
  // --- step 3 — post-compaction entity extraction -------------------------
  try {
    const { GraphAdapter } = await import('../adapters/graph-adapter');
    const adapter = new GraphAdapter(
      resolveNeo4jConfig(undefined),
      { enabled: true, searchLimit: 5 },
    );
    // 记录压缩事件到 Neo4j（用于跟踪）
    await adapter.query(`
      MERGE (e:CompactionEvent {id: $id})
      ON CREATE SET
        e.timestamp = timestamp(),
        e.filesBackedUp = $files,
        e.backupDir = $backupDir
    `, {
      id: `compact_${Date.now()}`,
      files: fileCount,
      backupDir,
    });
  } catch (err) {
    logger?.warn?.('compaction: Neo4j event logging failed', { err });
  }

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
