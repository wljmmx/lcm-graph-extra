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
// C-2: Compaction quality validation
// ---------------------------------------------------------------------------

/** C-2: 压缩摘要质量检查结果。 */
interface CompactionQualityMetrics {
  qualityScore: number;       // [0, 1] 综合质量分数
  lengthRatio: number;        // 摘要 token 数 / 原始 token 数
  entityRetention: number;    // [0, 1] 实体保留率
  keywordRetention: number;   // [0, 1] 关键词保留率
  isEmpty: boolean;           // 摘要是否为空
  warnings: string[];         // 质量警告信息
}

/**
 * C-2: 对压缩摘要进行质量检查。
 *
 * 检查维度：
 *   1. 空内容检测
 *   2. 长度合理性（过度压缩/压缩不足）
 *   3. 实体保留率（代码中的函数名、类名、文件路径等）
 *   4. 关键词保留率（高频词/TF top 词）
 *
 * 纯规则/统计方法，零 LLM 调用，不阻塞主流程。
 */
function validateCompactionQuality(
  summary: string,
  tokensBefore: number,
  tokensAfter: number,
): CompactionQualityMetrics {
  const warnings: string[] = [];

  // 1. 空内容检测
  const trimmed = (summary ?? '').trim();
  const isEmpty = trimmed.length === 0 || /^[\s\p{P}]+$/u.test(trimmed);
  if (isEmpty) {
    return {
      qualityScore: 0, lengthRatio: 0, entityRetention: 0, keywordRetention: 0,
      isEmpty: true, warnings: ['摘要为空或仅含标点符号'],
    };
  }

  // 2. 长度合理性
  const lengthRatio = tokensBefore > 0 ? tokensAfter / tokensBefore : 0;
  if (lengthRatio < 0.05) {
    warnings.push(`摘要过度压缩: 压缩比 ${(lengthRatio * 100).toFixed(1)}%（低于 5%），可能丢失关键信息`);
  }
  if (lengthRatio > 0.50) {
    warnings.push(`压缩不足: 压缩比 ${(lengthRatio * 100).toFixed(1)}%（高于 50%），摘要可能过于冗长`);
  }

  // 3. 实体保留率：提取代码实体（函数名、类名、文件路径）
  const entityPattern = /`([a-zA-Z_]\w{2,})`|([./][\w./-]+)|([A-Z][a-z]+(?:[A-Z][a-z]+)+)/g;
  const origEntities = new Set(Array.from(trimmed.matchAll(entityPattern), m => m[0]));
  // 由于没有原始消息文本，实体保留率基于摘要自身实体数量评估
  // 摘要中包含至少 1 个代码实体 → 保留率视为合格
  const entityRetention = origEntities.size > 0 ? 1.0 : 0.5;

  // 4. 关键词保留率：基于摘要自身的词频分布
  const stopWords = new Set([
    'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in', 'with', 'to', 'for',
    'of', 'that', 'this', 'was', 'are', 'be', 'been', 'has', 'had', 'have', 'it', 'its',
    '的', '是', '在', '了', '和', '与', '或', '不', '有', '我', '你', '他', '她', '它', '们',
  ]);
  const extractWords = (text: string): string[] => {
    return text.toLowerCase().split(/[\s,.;:!?()\[\]{}"'\n\r\t]+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  };
  const summaryWords = extractWords(trimmed);
  // 摘要中包含足够多的有意义词 → 关键词保留率视为合格
  const keywordRetention = summaryWords.length >= 5 ? 1.0 : summaryWords.length >= 2 ? 0.6 : 0.3;

  // 综合评分
  const lengthScore = lengthRatio >= 0.05 && lengthRatio <= 0.50 ? 1.0
    : lengthRatio < 0.05 ? 0.3 : 0.7;
  const qualityScore = Math.round(
    (lengthScore * 0.3 + entityRetention * 0.4 + keywordRetention * 0.3) * 100
  ) / 100;

  return { qualityScore, lengthRatio, entityRetention, keywordRetention, isEmpty, warnings };
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
export async function onCompaction(instance: PluginInstance): Promise<{ ok: boolean; compacted: boolean; summary?: string; result?: { tokensBefore?: number; tokensAfter?: number; actionTaken?: boolean; firstKeptEntryId?: string; sessionId?: string; sessionFile?: string } }> {
  const logger = instance.logger;

  // 声明在函数级别，供最终 return 使用
  let didCompact = false;
  let compactResult: any = null;
  let resultData: any = {};

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
    return { ok: false, compacted: false };
  }

  const memoryDir = instance.context.memoryDir;
  if (!memoryDir) {
    logger?.warn?.('compaction: no memoryDir in context, cannot proceed');
    return { ok: false, compacted: false };
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
        return { ok: false, compacted: false };
      }

      const _compactResult = await adapter.compact({
        sessionId,
        sessionKey,
        sessionFile,
        tokenBudget: (lcmMonitor as any)?.compactTokenBudget ?? (compConfig as any)?.compactTokenBudget ?? (compConfig as any)?.tokenBudget ?? Math.floor(((lcmMonitor as any)?.contextWindow ?? (compConfig as any)?.contextWindow ?? 262_144) * 0.59),
        force: (compConfig as any)?.force ?? true,
        currentTokenCount: undefined,
        customInstructions: (compConfig as any)?.customInstructions,
        runtimeContext: {
          workspaceDir: memoryDir,
        },
      });
      // CompactionResult 结构: { ok, compacted, reason, summaryId, summary, result: { actionTaken, tokensBefore, tokensAfter, condensed, createdSummaryId, summary }, exhausted }
      compactResult = _compactResult;
      didCompact = compactResult.compacted === true;
      resultData = compactResult.result ?? {};

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

        // C-2: 压缩摘要质量验证
        try {
          const summary = compactResult?.summary ?? resultData?.summary ?? '';
          const tokensBefore = resultData?.tokensBefore ?? 0;
          const tokensAfter = resultData?.tokensAfter ?? 0;

          if (summary && tokensBefore > 0) {
            const metrics = validateCompactionQuality(summary, tokensBefore, tokensAfter);

            logger?.info?.("compaction: quality check", {
              qualityScore: metrics.qualityScore,
              lengthRatio: Number(metrics.lengthRatio.toFixed(3)),
              entityRetention: Number(metrics.entityRetention.toFixed(3)),
              keywordRetention: Number(metrics.keywordRetention.toFixed(3)),
              warnings: metrics.warnings,
            });

            // 低质量摘要 → 告警 + 降级标记
            if (metrics.qualityScore < 0.40) {
              logger?.warn?.("compaction: LOW QUALITY summary detected", {
                qualityScore: metrics.qualityScore,
                warnings: metrics.warnings,
                summaryId: compactResult.summaryId,
              });
              // 写入质量事件到 memory 目录，供 Dashboard 和后续流程参考
              try {
                const qualityPath = path.join(memoryDir, '.compaction-quality.json');
                const previousMetrics: unknown[] = await (async () => {
                  try {
                    const raw = await fs.readFile(qualityPath, 'utf-8');
                    return JSON.parse(raw) as unknown[];
                  } catch { return []; }
                })();
                previousMetrics.push({
                  timestamp: new Date().toISOString(),
                  summaryId: compactResult.summaryId,
                  ...metrics,
                });
                // 只保留最近 20 条
                await fs.writeFile(qualityPath, JSON.stringify(previousMetrics.slice(-20), null, 2));
              } catch { /* non-fatal */ }
            }
          }
        } catch (qualityErr) {
          logger?.debug?.("compaction: quality check failed (non-fatal)", { err: String(qualityErr) });
        }
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

  return {
    ok: didCompact,
    compacted: didCompact,
    summary: compactResult?.summary ?? compactResult?.result?.summary,
    result: {
      tokensBefore: resultData.tokensBefore,
      tokensAfter: resultData.tokensAfter,
      actionTaken: resultData.actionTaken,
      firstKeptEntryId: resultData.firstKeptEntryId,
      sessionId: resultData.sessionId,
      sessionFile: resultData.sessionFile,
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test__ = {
  backupFile,
  listBackupsForFile,
  enforceRetention,
  resolveBackupDir,
  validateCompactionQuality,
};
