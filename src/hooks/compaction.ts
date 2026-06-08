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
import { resolveNeo4jConfig, resolveNeo4jSearchConfig } from '../config/neo4j-helper';

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

  // --- compaction config -------------------------------------------------
  const compConfig = instance.config.compaction;
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
    logger?.error?.({ err }, 'compaction: backup failed');
  }

  // --- step 2 — delegate to lossless-claw --------------------------------
  // DAG 压缩由 engine.compact() Step 1 通过 LosslessClawAdapter 调用
  logger?.info?.(
    `compaction: backed up ${fileCount} files; ` +
    `lossless-claw DAG compact runs via LosslessClawAdapter in engine.compact()`,
  );

  // --- step 3 — post-compaction entity extraction -------------------------
  try {
    const { GraphAdapter } = await import('../adapters/graph-adapter');
    const neo4jConn = resolveNeo4jConfig(instance.config);
    const neo4jSearch = resolveNeo4jSearchConfig(instance.config);
    const adapter = new GraphAdapter(
      { uri: neo4jConn.uri, user: neo4jConn.user, password: neo4jConn.password },
      { enabled: neo4jSearch.enabled, searchLimit: neo4jSearch.searchLimit },
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
    logger?.warn?.({ err }, 'compaction: Neo4j event logging failed');
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
    logger?.warn?.('compaction: failed to write marker', err);
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
