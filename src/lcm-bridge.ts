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
import { createRequire } from 'node:module';

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

const _lcmRequire = createRequire(import.meta.url);

function getDb(): any {
  try {
    const { DatabaseSync } = _lcmRequire('node:sqlite');
    return new DatabaseSync(LCM_DB_PATH);
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
  // P1-9 BUG-6: 把 db 引用提到 try 外，close 移到 finally，防止 prepare 抛错时连接泄漏
  let db: any = null;
  try {
    db = getDb();
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
    return row?.conversation_id ?? null;
  } catch {
    return null;
  } finally {
    if (db) { try { db.close(); } catch { /* already closed or close failed */ } }
  }
}

/**
 * 查询指定会话的消息数和总 token
 */
export function getMessageStats(conversationId: number): { count: number; totalTokens: number } {
  let db: any = null;
  try {
    db = getDb();
    if (!db) return { count: 0, totalTokens: 0 };
    const row = db.prepare(
      'SELECT COUNT(*) as cnt, COALESCE(SUM(token_count), 0) as total_tok FROM messages WHERE conversation_id = ?'
    ).get(conversationId) as any;
    return { count: row?.cnt ?? 0, totalTokens: row?.total_tok ?? 0 };
  } catch {
    return { count: 0, totalTokens: 0 };
  } finally {
    if (db) { try { db.close(); } catch { /* already closed or close failed */ } }
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
  let db: any = null;
  try {
    db = getDb();
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
    return true;
  } catch {
    return false;
  } finally {
    if (db) { try { db.close(); } catch { /* already closed or close failed */ } }
  }
}

/**
 * 从消息列表估计 token 用量（快速估算，不查 DB）
 */
/**
 * Estimate tokens from text using a Chinese-aware heuristic.
 * Formula: max(1, ceil(CJK chars / 1.5 + non-CJK chars / 4.0))
 */
export function estimateTokensFromText(text: string): number {
  let cjkCount = 0;
  let nonCjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    // CJK Unified Ideographs + extensions, Hiragana, Katakana, Hangul
    if (
      (cp >= 0x2E80 && cp <= 0x9FFF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0x3040 && cp <= 0x30FF) ||
      (cp >= 0x31F0 && cp <= 0x31FF)
    ) {
      cjkCount++;
    } else {
      nonCjkCount++;
    }
  }
  return Math.max(1, Math.ceil(cjkCount / 1.5 + nonCjkCount / 4.0));
}

export function estimateTokensFromMessages(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg?.token_count && typeof msg.token_count === 'number') {
      total += msg.token_count;
    } else if (msg?.content) {
      // Handle both string content and array content [{type: "text", text: "..."}]
      const c = msg.content;
      if (typeof c === 'string') {
        total += estimateTokensFromText(c);
      } else if (Array.isArray(c)) {
        // Batch all text parts into a single string to avoid per-part inflation
        const textParts = c.filter((p: any) => p.type === 'text' && typeof p.text === 'string');
        const combined = textParts.map((tp: any) => tp.text).join('');
        if (combined.length > 0) {
          total += estimateTokensFromText(combined);
        }
      } else {
        total += estimateTokensFromText(String(c));
      }
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


/**
 * Retrieve all summaries for a conversation, sorted by earliestAt (oldest original message first).
 * Used for pressure-based message assembly.
 */
export function getConversationSummaries(conversationId: number): Array<{
  summaryId: string;
  content: string;
  tokenCount: number;
  earliestAt: string | null;
}> {
  try {
    const db = getDb();
    if (!db) return [];
    const rows = db.prepare(
      "SELECT summary_id, content, token_count, earliest_at " +
      "FROM summaries WHERE conversation_id = ? ORDER BY earliest_at ASC",
    ).all(conversationId) as Array<Record<string, unknown>>;
    try { db.close(); } catch { /* ignore */ }
    return (rows ?? []).map((r: any) => ({
      summaryId: r.summary_id as string,
      content: r.content as string,
      tokenCount: Number(r.token_count) || 0,
      earliestAt: r.earliest_at as string | null,
    }));
  } catch {
    return [];
  }
}

/**
 * Count messages not yet covered by any summary.
 * Returns the number of uncompressed (pending compaction) messages.
 */
export function getUncompressedMessageCount(conversationId: number): number {
  try {
    const db = getDb();
    if (!db) return -1;

    // Count messages whose created_at is NOT within any summary range
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ? " +
      "AND created_at > (SELECT COALESCE(MAX(latest_at),0) FROM summaries WHERE conversation_id = ?)",
    ).get(conversationId, conversationId);

    try { db.close(); } catch { /* ignore */ }

    return row?.cnt ?? 0;
  } catch {
    return -1;
  }
}

/**
 * Check if there are messages not yet covered by summaries.
 * Returns true if there appear to be uncompressed messages.
 */
export function hasUncompressedMessages(conversationId: number): boolean {
  try {
    const db = getDb();
    if (!db) return true;
    
    // Count total tokens in raw messages for this conversation
    const msgRow = db.prepare(
      "SELECT COALESCE(SUM(token_count), 0) as t FROM messages WHERE conversation_id = ?",
    ).get(conversationId) as { t: number } | undefined;
    const msgTokens = msgRow?.t ?? 0;
    
    // Count total tokens in summaries for this conversation
    const sumRow = db.prepare(
      "SELECT COALESCE(SUM(token_count), 0) as t FROM summaries WHERE conversation_id = ?",
    ).get(conversationId) as { t: number } | undefined;
    const summaryTokens = sumRow?.t ?? 0;
    
    try { db.close(); } catch { /* ignore */ }
    
    // If summary tokens are a small fraction of message tokens, there's likely uncompressed content
    return msgTokens > 0 && summaryTokens < msgTokens * 0.3;
  } catch {
    return true;
  }
}

/**
 * Trim summaries from the oldest first until total token count fits within maxTokens.
 * Summaries must be sorted by earliestAt ASC (oldest first) before calling.
 */
export function trimSummariesToBudget(
  summaries: Array<{ summaryId: string; content: string; tokenCount: number }>,
  maxTokens: number,
): typeof summaries {
  const trimmed = [...summaries];
  let totalTokens = trimmed.reduce((sum, s) => sum + (s.tokenCount ?? 0), 0);
  
  while (totalTokens > maxTokens && trimmed.length > 1) {
    const removed = trimmed.shift();
    if (removed) {
      totalTokens -= (removed.tokenCount ?? 0);
    }
  }
  
  return trimmed;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test__ = {
  LCM_DB_PATH,
  getDb,
};
