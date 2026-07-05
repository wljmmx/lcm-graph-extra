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
// Internal — 单例 DB 连接 + prepared statement 缓存（P0-2 H-1）
// ---------------------------------------------------------------------------

const _lcmRequire = createRequire(import.meta.url);

// P0-2 H-1: 单例 DB 连接，避免每次操作都 open/close
let _lcmDb: any = null;

// P0-2 H-1: 预编译 statement 缓存，按 key 复用
const _lcmStmts = new Map<string, any>();

// P0-2 H-1: 获取单例 DB 连接，若不存在则创建；创建失败返回 null
function getDb(): any {
  if (_lcmDb) return _lcmDb;
  try {
    const { DatabaseSync } = _lcmRequire('node:sqlite');
    _lcmDb = new DatabaseSync(LCM_DB_PATH);
    return _lcmDb;
  } catch {
    _lcmDb = null;
    return null;
  }
}

// P0-2 H-1: 从缓存取或新建 prepared statement；失败返回 null
function getStmt(key: string, sql: string): any {
  const cached = _lcmStmts.get(key);
  if (cached) return cached;
  const db = getDb();
  if (!db) return null;
  try {
    const stmt = db.prepare(sql);
    _lcmStmts.set(key, stmt);
    return stmt;
  } catch {
    return null;
  }
}

// P0-2 H-1: 关闭单例连接并清空缓存（用于测试隔离 + 插件 dispose）
export function closeLcmDb(): void {
  if (_lcmDb) {
    try { _lcmDb.close(); } catch { /* already closed or close failed */ }
  }
  _lcmDb = null;
  _lcmStmts.clear();
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
  // P0-2 H-1: 改为单例 DB + 预编译 statement，不再每次 open/close
  try {
    let row: { conversation_id: number } | undefined;
    if (sessionKey) {
      const stmt = getStmt('getConversationId_bySessionKey',
        'SELECT conversation_id FROM conversations WHERE session_key = ? AND active = 1 ORDER BY conversation_id DESC LIMIT 1');
      if (stmt) row = stmt.get(sessionKey) as { conversation_id: number } | undefined;
    }
    if (!row && sessionId) {
      const stmt = getStmt('getConversationId_bySessionId',
        'SELECT conversation_id FROM conversations WHERE session_id = ? AND active = 1 ORDER BY conversation_id DESC LIMIT 1');
      if (stmt) row = stmt.get(sessionId) as { conversation_id: number } | undefined;
    }
    return row?.conversation_id ?? null;
  } catch {
    return null;
  }
}

/**
 * 查询指定会话的消息数和总 token
 */
export function getMessageStats(conversationId: number): { count: number; totalTokens: number } {
  // P0-2 H-1: 复用单例 DB + 预编译 statement（不再每次 open/close）
  try {
    const stmt = getStmt('getMessageStats',
      'SELECT COUNT(*) as cnt, COALESCE(SUM(token_count), 0) as total_tok FROM messages WHERE conversation_id = ?');
    if (!stmt) return { count: 0, totalTokens: 0 };
    const row = stmt.get(conversationId) as { cnt: number; total_tok: number } | undefined;
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
  // P0-2 H-1: 复用单例 DB + 预编译 statement（不再每次 open/close）
  try {
    const stmt = getStmt('writeCompactionDebt',
      `INSERT OR REPLACE INTO conversation_compaction_maintenance
       (conversation_id, pending, requested_at, reason, running, token_budget, current_token_count, updated_at)
       VALUES (?, 1, datetime('now'), ?, 0, ?, ?, datetime('now'))`);
    if (!stmt) return false;
    stmt.run(conversationId, reason, tokenBudget, currentTokenCount);
    return true;
  } catch {
    return false;
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

// ---------------------------------------------------------------------------
// R-5': 场景化 retrievalLimits 动态调整
// ---------------------------------------------------------------------------

/** 场景检测结果 */
export interface ScenarioAdjustResult {
  scenario: string | null;
  limits: RetrievalLimits;
}

/**
 * R-5': 从 query 中快速检测场景，并按场景调整 retrievalLimits 比例。
 *
 * 设计原则：零延迟（纯规则匹配，不用 LLM），只在 tier 基础上微调比例。
 * 总 token 量不变（避免突破压力预算），只改各层分配比例。
 *
 * 场景 → 权重调整：
 *   - bug-fix / config-debug / performance-opt: QMD ↑  Graph →  Exp ↓
 *     （代码/配置优先，经验层只做辅助）
 *   - feature-dev / refactor: QMD →  Graph ↑  Exp →
 *     （结构优先，图谱关联更重要）
 *   - code-review / security-audit: QMD ↓  Graph →  Exp ↑
 *     （经验优先，历史经验更有参考价值）
 *   - deployment / devops: QMD ↑  Graph ↓  Exp →
 *     （配置/文档优先）
 */
export function detectScenarioAndAdjustLimits(
  query: string,
  baseLimits: RetrievalLimits,
): ScenarioAdjustResult {
  if (!query || !query.trim()) {
    return { scenario: null, limits: baseLimits };
  }

  const q = query.toLowerCase();

  // 场景关键词匹配（优先级从高到低）
  let detected: string | null = null;

  const bugPatterns = ['bug', 'error', 'fail', 'crash', 'exception', '修复', '错误', '报错', '崩溃', '异常'];
  const configPatterns = ['config', 'setting', '配置', '设置', 'deploy', '部署', 'env', '环境变量'];
  const perfPatterns = ['perf', 'slow', 'latency', 'optim', '性能', '慢', '优化', '提速'];
  const featurePatterns = ['feature', 'implement', 'add', 'create', 'build', '新功能', '实现', '添加', '开发'];
  const refactorPatterns = ['refactor', 'rework', 'restructure', '重构', '改造', '整理'];
  const reviewPatterns = ['review', 'audit', 'check', '审查', '评审', '检查', '安全'];
  const deployPatterns = ['deploy', 'release', 'ci', 'cd', 'pipeline', '发布', '上线', '流水线'];

  const matchCount = (patterns: string[]): number =>
    patterns.filter((p) => q.includes(p)).length;

  const scores: Record<string, number> = {
    'bug-fix': matchCount(bugPatterns),
    'config-debug': matchCount(configPatterns),
    'performance-opt': matchCount(perfPatterns),
    'feature-dev': matchCount(featurePatterns),
    'refactor': matchCount(refactorPatterns),
    'code-review': matchCount(reviewPatterns),
    'deployment': matchCount(deployPatterns),
  };

  let maxScore = 0;
  for (const [scenario, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      detected = scenario;
    }
  }

  // 至少命中 1 个关键词才算检测到场景
  if (maxScore < 1 || !detected) {
    return { scenario: null, limits: baseLimits };
  }

  // 按场景调整比例 —— 保持总量接近，只重新分配
  const totalBase = baseLimits.qmd + baseLimits.graph + baseLimits.exp;
  let qmdRatio = 0.45;
  let graphRatio = 0.35;
  let expRatio = 0.20;

  switch (detected) {
    case 'bug-fix':
    case 'config-debug':
    case 'performance-opt':
      // QMD 优先，Experience 降低
      qmdRatio = 0.55; graphRatio = 0.30; expRatio = 0.15;
      break;
    case 'feature-dev':
    case 'refactor':
      // Graph 稍高，结构关联更重要
      qmdRatio = 0.40; graphRatio = 0.45; expRatio = 0.15;
      break;
    case 'code-review':
    case 'security-audit':
      // Experience 优先，历史经验参考价值高
      qmdRatio = 0.30; graphRatio = 0.30; expRatio = 0.40;
      break;
    case 'deployment':
      // QMD 优先（配置/文档），Graph 降低
      qmdRatio = 0.55; graphRatio = 0.20; expRatio = 0.25;
      break;
  }

  const adjusted: RetrievalLimits = {
    qmd: Math.max(1, Math.round(totalBase * qmdRatio)),
    graph: Math.max(0, Math.round(totalBase * graphRatio)),
    exp: Math.max(0, Math.round(totalBase * expRatio)),
  };

  // 高压力模式下（high tier）不做调整（已经是最低限度）
  if (baseLimits.qmd <= 1 && baseLimits.graph <= 1) {
    return { scenario: detected, limits: baseLimits };
  }

  return { scenario: detected, limits: adjusted };
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
  // P3-8: 统一 fail-open 语义 —— db.close 移入 finally，防止 prepare 抛错时连接泄漏
  // P0-2 H-1: 改为单例 DB + 预编译 statement，不再每次 open/close
  try {
    const stmt = getStmt('getConversationSummaries',
      "SELECT summary_id, content, token_count, earliest_at " +
      "FROM summaries WHERE conversation_id = ? ORDER BY earliest_at ASC");
    if (!stmt) return [];
    const rows = stmt.all(conversationId) as Array<Record<string, unknown>>;
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
  // P3-8: 统一 fail-open 语义 —— db.close 移入 finally
  // P0-2 H-1: 复用单例 DB + 预编译 statement（不再每次 open/close）
  try {
    const stmt = getStmt('getUncompressedMessageCount',
      "SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ? " +
      "AND created_at > (SELECT COALESCE(MAX(latest_at),0) FROM summaries WHERE conversation_id = ?)");
    if (!stmt) return -1;
    const row = stmt.get(conversationId, conversationId) as { cnt: number } | undefined;
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
  // P3-8: 统一 fail-open 语义 —— db.close 移入 finally
  // P0-2 H-1: 复用单例 DB + 预编译 statement，用 2 个独立 statement 分别统计
  try {
    const msgStmt = getStmt('hasUncompressedMessages_msgTokens',
      "SELECT COALESCE(SUM(token_count), 0) as t FROM messages WHERE conversation_id = ?");
    if (!msgStmt) return true;
    const msgRow = msgStmt.get(conversationId) as { t: number } | undefined;
    const msgTokens = msgRow?.t ?? 0;
    const sumStmt = getStmt('hasUncompressedMessages_sumTokens',
      "SELECT COALESCE(SUM(token_count), 0) as t FROM summaries WHERE conversation_id = ?");
    if (!sumStmt) return true;
    const sumRow = sumStmt.get(conversationId) as { t: number } | undefined;
    const summaryTokens = sumRow?.t ?? 0;
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
// P3-8: 原 __test__ 导出（LCM_DB_PATH, getDb）无任何测试引用，属死代码，已收敛移除。
// 如未来测试需要内部钩子，应通过 vitest 的 vi.mock 或独立 test-utils 模块注入，而非污染生产导出。
