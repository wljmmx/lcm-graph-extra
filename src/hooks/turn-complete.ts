/**
 * onTurnComplete hook — 每轮对话完成后的后处理。
 *
 * 职责:
 *   1. 经验提取 — 检测触发条件 → 写入 Neo4j EXPERIENCE PENDING
 *   2. 实体提取 — 从对话消息提取实体 → 写入 Neo4j 知识图谱
 *   3. 旧 turn-complete 的 compaction 阈值检查 → 已迁移到 onCompaction hook
 */

import type { PluginInstance } from '../register';
import { detectExperienceTrigger, extractRawExperience } from '../experience';
import { resolveNeo4jConfig, resolveNeo4jSearchConfig } from '../config/neo4j-helper';
import type { ExtractedEntity, ExtractedRelation } from '../types';

// ---------------------------------------------------------------------------
// Internal helpers — 消息到实体的简单提取
// ---------------------------------------------------------------------------

/** 从对话消息中提取实体和关系 */
function extractEntitiesFromMessages(
  messages: Array<Record<string, unknown>>,
): { entities: ExtractedEntity[]; relations: ExtractedRelation[] } {
  const entities: ExtractedEntity[] = [];
  const relations: ExtractedRelation[] = [];
  const seenNames = new Set<string>();

  for (const msg of messages) {
    const content = (msg.content as string) ?? '';
    if (!content) continue;

    // 模式: "我用/skill/XX 处理了 /task/YY"
    const skillMatch = content.match(/\/(?:skill|tool|ability)s?\/(\w[\w.-]*)/gi);
    if (skillMatch) {
      for (const raw of skillMatch) {
        const name = raw.replace(/^\/(?:skill|tool|ability)s?\//i, '').toLowerCase();
        if (!seenNames.has(name)) {
          seenNames.add(name);
          entities.push({
            name,
            type: 'SKILL',
            description: `Mentioned in conversation: ${content.slice(0, 200)}`,
            content: content.slice(0, 500),
          });
        }
      }
    }

    // 模式: "project XX", "task YY", "issue ZZ"
    const topicMatch = content.match(/\b(?:project|task|bug|issue|feature)\s+[""']?([A-Z]\w+(?:\s+\w+){0,3})[""']?/gi);
    if (topicMatch) {
      for (const raw of topicMatch) {
        const name = raw.replace(/^(?:project|task|bug|issue|feature)\s+/i, '').toLowerCase().slice(0, 64);
        if (!seenNames.has(name) && name.length > 1) {
          seenNames.add(name);
          entities.push({
            name,
            type: 'TASK',
            description: `Extracted from turn: ${content.slice(0, 200)}`,
            content: content.slice(0, 500),
          });
        }
      }
    }

    // 通用: 提取引用的实体名称（"关于 XXX"、"提到 XXX" 等模式）
    const refMatch = content.match(/(?:关于|提到|涉及|参考|叫|名为)\s+[""']?([\u4e00-\u9fff\w][\u4e00-\u9fff\w\s-]{1,30})[""']?/g);
    if (refMatch) {
      for (const raw of refMatch) {
        const name = raw.replace(/^(?:关于|提到|涉及|参考|叫|名为)\s+/g, '').toLowerCase().trim().slice(0, 64);
        if (!seenNames.has(name) && name.length > 1) {
          seenNames.add(name);
          entities.push({
            name,
            type: 'CONCEPT',
            description: `Referenced entity: ${content.slice(0, 200)}`,
            content: content.slice(0, 500),
          });
        }
      }
    }
  }

  return { entities, relations };
}

/** 去重窗口：同一 session 同类型 5 分钟内不重复提取 */
const dedupWindow = new Map<string, number>();

function isDuplicate(sessionKey: string): boolean {
  const last = dedupWindow.get(sessionKey);
  const now = Date.now();
  if (last && now - last < 5 * 60 * 1000) return true;
  dedupWindow.set(sessionKey, now);
  return false;
}

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
    const recentMessages: Array<Record<string, unknown>> =
      (instance.context as any).recentMessages ?? [];
    const priorMessages: Array<Record<string, unknown>> =
      (instance.context as any).priorMessages ?? recentMessages.slice(0, -1);

    let extractedCount = 0;

    // 解析 Neo4j 凭证（从配置 + 环境变量）
    const neo4jConn = resolveNeo4jConfig(config);
    const neo4jSearch = resolveNeo4jSearchConfig(config);

    for (const message of recentMessages) {
      const trigger = detectExperienceTrigger(message, priorMessages);
      if (!trigger) continue;

      const allowedTriggers = expConfig.triggers ?? [
        'correction', 'failure', 'fix_success', 'explicit_save',
      ];
      if (!allowedTriggers.includes(trigger as any)) continue;

      const sessionId = (instance.context as any).sessionId ?? 'unknown';
      const taskId = (instance.context as any).taskId;
      const raw = extractRawExperience(trigger, message, sessionId, taskId);

      try {
        const { ExperienceStorage } = await import('../experience');
        const { GraphAdapter } = await import('../adapters/graph-adapter');
        const adapter = new GraphAdapter(
          { uri: neo4jConn.uri, user: neo4jConn.user, password: neo4jConn.password },
          { enabled: neo4jSearch.enabled, searchLimit: neo4jSearch.searchLimit },
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

  // --- Entity extraction: 从对话消息中提取实体 → Neo4j 知识图谱 -----------
  try {
    const recentMessages: Array<Record<string, unknown>> =
      (instance.context as any).recentMessages ?? [];

    if (recentMessages.length === 0) return;

    // 去重检查：同一 session 批量消息 5 分钟内只提取一次
    const sessionKey = (instance.context as any).sessionId ?? 'default';
    if (isDuplicate(sessionKey)) {
      logger.trace?.('entity extraction: skipped (dedup window)');
      return;
    }

    const { entities, relations } = extractEntitiesFromMessages(recentMessages);

    if (entities.length > 0 || relations.length > 0) {
      const neo4jConn = resolveNeo4jConfig(config);
      const neo4jSearch = resolveNeo4jSearchConfig(config);
      const { GraphAdapter } = await import('../adapters/graph-adapter');
      const adapter = new GraphAdapter(
        { uri: neo4jConn.uri, user: neo4jConn.user, password: neo4jConn.password },
        { enabled: neo4jSearch.enabled, searchLimit: 5 },
      );

      const result = await adapter.upsertEntities(entities, relations);
      logger.info(
        `turn_complete: extracted ${entities.length} entities, ` +
        `upserted ${result.upserted}, conflicts ${result.conflicts}`,
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'turn_complete: entity extraction failed');
  }
}
