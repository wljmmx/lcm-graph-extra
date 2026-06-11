import sqlite from 'node:sqlite';
/**
 * lcm-bridge — lossless-claw SQLite DB 操作桥接
 *
 * 功能:
 *   1. 查询当前会话的消息数/Token 用量
 *   2. 写入 compaction_maintenance 表（触发 lossless-claw 后台 DAG 压缩）
 *   3. Pressure 等级判定
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LCM_DB_PATH = join(homedir(), '.openclaw', 'lcm.db');

/** 压力等级 */
export type PressureTier = 'low' | 'medium' | 'high';

/** 压力信息 */
export interface PressureInfo {
  tier: PressureTier;
  messageCount: number;
  estimatedTokens: number;
  tokenRatio: number;
  contextWindow: number;
}

/** 各级检索限制 */
export interface RetrievalLimits {
  qmd: number;
  graph: number;
  exp: number;
}

/** 各级总注入上限 */
export interface MaxContextChars {
  low: number;
  medium: number;
  high: number;
}

// ---------------------------------------------------------------------------
// Internal — lazy DB 连接
// ---------------------------------------------------------------------------

function getDb(): any {
  try {
    return new (sqlite).DatabaseSync(LCM_DB_PATH);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 获取当前会话的 conversation_id
 */
export function getConversationId(sessionKey?: string, sessionId?: string): number | null {
  if (!sessionKey && !sessionId) return null;
  try {
    const db = getDb();
    if (!db) return null;

    let row: any = null;
    if (sessionKey) {
      row = db.prepare(
        'SELECT conversation_id FROM conversations WHERE session_key = ? AND active = 1 ORDER BY conversation_id DESC LIMIT 1'
      ).get(sessionKey);
    }
    if (!row && sessionId) {
      row = db.prepare(
        'SELECT conversation_id FROM conversations WHERE session_id = ? AND active = 1 ORDER BY conversation_id DESC LIMIT 1'
      ).get(sessionId);
    }
    db.close();
    return row?.conversation_id ?? null;
  } catch {
    return null;
  }
}

/**
 * 查询指定会话的消息数和总 token
 */
export function getMessageStats(conversationId: number): { count: number; totalTokens: number } {
  try {
    const db = getDb();
    if (!db) return { count: 0, totalTokens: 0 };
    const row = db.prepare(
      'SELECT COUNT(*) as cnt, COALESCE(SUM(token_count), 0) as total_tok FROM messages WHERE conversation_id = ?'
    ).get(conversationId) as any;
    db.close();
    return { count: row?.cnt ?? 0, totalTokens: row?.total_tok ?? 0 };
  } catch {
    return { count: 0, totalTokens: 0 };
  }
}

/**
 * 写入 compaction_maintenance 表，触发 lossless-claw 后台 DAG 压缩
 */
export function writeCompactionDebt(
  conversationId: number,
  tokenBudget: number,
  currentTokenCount: number,
  reason: string = 'proactive_lcm_graph_extra',
): boolean {
  try {
    const db = getDb();
    if (!db) return false;

    db.exec(
      `INSERT OR REPLACE INTO conversation_compaction_maintenance
       (conversation_id, pending, requested_at, reason, running, token_budget, current_token_count, updated_at)
       VALUES (?, 1, datetime('now'), ?, 0, ?, ?, datetime('now'))`,
      conversationId,
      reason,
      tokenBudget,
      currentTokenCount,
    );
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * 从消息列表估计 token 用量（快速估算，不查 DB）
 */
export function estimateTokensFromMessages(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg?.token_count && typeof msg.token_count === 'number') {
      total += msg.token_count;
    } else if (msg?.content) {
      total += Math.ceil(String(msg.content).length / 4);
    }
  }
  return total;
}

/**
 * 判定压力等级
 *
 * @param messageCount 当前消息数
 * @param tokenRatio 当前 token 使用比例 (0~1)
 * @param config 窗口监控配置
 */
export function determinePressureTier(
  messageCount: number,
  tokenRatio: number,
  config: {
    dedupRounds: number;
    highPressureThreshold: number;
    mediumPressureThreshold: number;
  },
): PressureTier {
  if (messageCount > config.dedupRounds * 2 || tokenRatio >= config.highPressureThreshold) {
    return 'high';
  }
  if (messageCount >= config.dedupRounds || tokenRatio >= config.mediumPressureThreshold) {
    return 'medium';
  }
  return 'low';
}

/**
 * 是否需要触发后台 compact
 */
export function shouldTriggerCompact(
  messageCount: number,
  tokenRatio: number,
  config: {
    dedupRounds: number;
    proactiveThreshold: number;
  },
): boolean {
  return messageCount >= config.dedupRounds || tokenRatio >= config.proactiveThreshold;
}

/**
 * 获取压力等级对应的检索限制
 */
export function getRetrievalLimitsForTier(tier: PressureTier, limits: {
  low: RetrievalLimits;
  medium: RetrievalLimits;
  high: RetrievalLimits;
}): RetrievalLimits {
  return limits[tier];
}

/**
 * 获取压力等级对应的总注入上限
 */
export function getMaxContextCharsForTier(tier: PressureTier, maxChars: MaxContextChars): number {
  return maxChars[tier];
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test__ = {
  LCM_DB_PATH,
  getDb,
};
