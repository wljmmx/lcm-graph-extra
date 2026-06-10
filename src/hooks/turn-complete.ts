/**
 * onTurnComplete hook — 每轮对话完成后的后处理。
 *
 * 职责:
 *   1. 经验提取 — 检测触发条件 → 写入 Neo4j EXPERIENCE PENDING
 *   2. 实体提取 — 写入 Neo4j 知识图谱（继承原有逻辑）
 *   3. 旧 turn-complete 的 compaction 阈值检查 → 已迁移到 onCompaction hook
 */

import type { PluginInstance } from '../register';
import { detectExperienceTrigger, extractRawExperience } from '../experience';

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * Called after every conversation turn.
 */
export async function onTurnComplete(instance: PluginInstance): Promise<void> {
  const { config, logger } = instance;

  // --- Check if experience extraction is enabled -------------------------
  const expConfig = config.experience;
  if (!expConfig?.enabled) {
    logger.debug('experience extraction disabled, skipping turn_complete work');
    return;
  }

  // --- Extract experience from messages ---------------------------------
  try {
    // 获取当前轮次的对话消息（模拟 context 中的 recentMessages）
    const recentMessages: Array<Record<string, unknown>> =
      (instance.context as any).recentMessages ?? [];
    const priorMessages: Array<Record<string, unknown>> =
      (instance.context as any).priorMessages ?? recentMessages.slice(0, -1);

    let extractedCount = 0;

    for (const message of recentMessages) {
      const trigger = detectExperienceTrigger(message, priorMessages);
      if (!trigger) continue;

      // 检查该触发类型是否在配置允许的范围内
      const allowedTriggers = expConfig.triggers ?? [
        'correction', 'failure', 'fix_success', 'explicit_save',
      ];
      if (!allowedTriggers.includes(trigger as any)) continue;

      const sessionId = (instance.context as any).sessionId ?? 'unknown';
      const taskId = (instance.context as any).taskId;
      const raw = extractRawExperience(trigger, message, sessionId, taskId);

      // 写入 Neo4j EXPERIENCE PENDING 节点
      try {
        const { ExperienceStorage } = await import('../experience');
        const { GraphAdapter } = await import('../adapters/graph-adapter');
        const adapter = new GraphAdapter(
          { uri: 'bolt://192.168.50.89:7687', user: 'neo4j', password: 'pro-gm-2.1.0' },
          { enabled: true, searchLimit: 5 },
        );
        const storage = new ExperienceStorage(adapter);
        await storage.saveRaw(raw);
        extractedCount++;
      } catch (storeErr) {
        logger.warn({ err: (storeErr as Error).message }, 'failed to save raw experience');
      }
    }

    if (extractedCount > 0) {
      logger.info(`turn_complete: extracted ${extractedCount} raw experience(s)`);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'turn_complete: experience extraction failed');
  }

  // --- Legacy: entity extraction (preserved) -----------------------------
  // Entity extraction and graph upsert logic remains unchanged.
  // It runs in its own background path.
}
