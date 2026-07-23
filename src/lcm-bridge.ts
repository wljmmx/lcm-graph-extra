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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

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
// perf: 启用 WAL + synchronous=NORMAL + 内存缓存，消除写并发锁竞争
//       （assemble 每次调用 4-6 次 sqlite 查询，缺 WAL 时写操作互斥阻塞）
function getDb(): any {
  if (_lcmDb) return _lcmDb;
  try {
    const { DatabaseSync } = _lcmRequire('node:sqlite');
    _lcmDb = new DatabaseSync(LCM_DB_PATH);
    // PRAGMA 仅在首次创建连接时执行一次（连接生命周期内有效）
    // WAL：读写不互斥，显著降低写并发锁竞争
    // synchronous=NORMAL：WAL 模式下安全且更快（相比 FULL 减少 fsync 次数）
    // cache_size=-65536：64MB 内存缓存（负数=KB）
    // mmap_size=268435456：256MB mmap（提升大表扫描性能）
    // temp_store=MEMORY：临时表与排序在内存中
    try {
      _lcmDb.exec('PRAGMA journal_mode = WAL');
      _lcmDb.exec('PRAGMA synchronous = NORMAL');
      _lcmDb.exec('PRAGMA cache_size = -65536');
      _lcmDb.exec('PRAGMA mmap_size = 268435456');
      _lcmDb.exec('PRAGMA temp_store = MEMORY');
    } catch {
      /* PRAGMA 失败不阻塞主路径（可能是只读场景） */
    }
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
  _convIdCache.clear();
}

// ---------------------------------------------------------------------------
// Large Files — lossless-claw large_files 表写入（兼容 lcm_describe / lcm_expand）
// ---------------------------------------------------------------------------

/** large_files 表插入参数 */
export interface LargeFileInsertParams {
  fileId: string;
  conversationId: number;
  fileName: string;
  mimeType: string;
  byteSize: number;
  lineCount: number;
  storageUri: string;
  explorationSummary: string;
}

/**
 * 向 lossless-claw 的 large_files 表插入记录。
 *
 * 写入后 lcm_describe(id="file_xxx", expandFile=true) 即可从外部存储取回完整内容。
 * 表结构由 lossless-claw 的 migration 管理，此处仅 INSERT。
 *
 * @returns true 表示插入成功，false 表示 DB 不可用或插入失败
 */
export function insertLargeFile(params: LargeFileInsertParams): boolean {
  try {
    const stmt = getStmt('insertLargeFile',
      `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, line_count, storage_uri, exploration_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    if (!stmt) return false;
    stmt.run(
      params.fileId,
      params.conversationId,
      params.fileName,
      params.mimeType,
      params.byteSize,
      params.lineCount,
      params.storageUri,
      params.explorationSummary,
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 获取当前会话的 conversation_id
 *
 * perf: 加 LRU 缓存（capacity=50, TTL=10min），避免每次 assemble 都查 sqlite。
 *       sessionKey/sessionId → conversation_id 在会话生命周期内基本不变。
 */
const _convIdCache = new Map<string, { convId: number | null; ts: number }>();
const CONV_ID_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const CONV_ID_CACHE_MAX = 50;

export function getConversationId(sessionKey?: string, sessionId?: string): number | null {
  if (!sessionKey && !sessionId) return null;
  // 缓存 key：sessionKey 优先，无则用 sessionId
  const cacheKey = sessionKey ? `sk:${sessionKey}` : `si:${sessionId}`;
  const now = Date.now();
  const cached = _convIdCache.get(cacheKey);
  if (cached && (now - cached.ts) < CONV_ID_CACHE_TTL_MS) {
    // O(1) move-to-end：delete + re-set 维护 LRU 顺序
    _convIdCache.delete(cacheKey);
    _convIdCache.set(cacheKey, cached);
    return cached.convId;
  }
  // P1-9 BUG-6: 把 db 引用提到 try 外，close 移到 finally，防止 prepare 抛错时连接泄漏
  // P0-2 H-1: 改为单例 DB + 预编译 statement，不再每次 open/close
  let convId: number | null = null;
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
    convId = row?.conversation_id ?? null;
  } catch {
    convId = null;
  }
  // 写入缓存（含 LRU 淘汰）
  if (_convIdCache.size >= CONV_ID_CACHE_MAX) {
    const firstKey = _convIdCache.keys().next().value;
    if (firstKey !== undefined) _convIdCache.delete(firstKey);
  }
  _convIdCache.set(cacheKey, { convId, ts: now });
  return convId;
}

/**
 * 失效 conversation_id 缓存。
 *
 * 在 /new 等会话重置场景下调用，确保下次 getConversationId 重新查库，
 * 而不是返回旧会话的 conversation_id（可能导致 uncomp 统计错误、压力等级偏高）。
 *
 * @param sessionKey 会话 key（可选，不传则清空全部缓存）
 * @param sessionId 会话 ID（可选）
 */
export function invalidateConvIdCache(sessionKey?: string, sessionId?: string): void {
  if (!sessionKey && !sessionId) {
    _convIdCache.clear();
    return;
  }
  if (sessionKey) {
    _convIdCache.delete(`sk:${sessionKey}`);
  }
  if (sessionId) {
    _convIdCache.delete(`si:${sessionId}`);
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
 * 用 conversation_id 反查 OpenClaw 会话标识（session_id / session_key）。
 *
 * BUG-AUDIT: debt-manager 后台调度触发 compact 时没有 SDK 上下文，无法直接拿到
 * OpenClaw 注入的 sessionId（字符串）。原代码用 `String(debt.conversationId)`
 * 当 sessionId 传给 lossless-claw，但 lossless-claw 用 sessionId 查
 * conversations.session_id 列，永远查不到 number 主键。此函数用于反查正确的
 * session_id / session_key 供 debt-manager 使用。
 */
export function getSessionInfoByConversationId(conversationId: number): {
  sessionId: string | null;
  sessionKey: string | null;
} {
  try {
    const stmt = getStmt('getSessionInfoByConversationId',
      'SELECT session_id, session_key FROM conversations WHERE conversation_id = ?');
    if (!stmt) return { sessionId: null, sessionKey: null };
    const row = stmt.get(conversationId) as { session_id: string; session_key: string | null } | undefined;
    return {
      sessionId: row?.session_id ?? null,
      sessionKey: row?.session_key ?? null,
    };
  } catch {
    return { sessionId: null, sessionKey: null };
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
  /** C-3: 分类置信度 [0, 1]，加权关键词原始分数 */
  confidence: number;
}

/**
 * C-3: 场景感知检索 — 加权关键词匹配 + 置信度门控 + 平局打破。
 *
 * 核心改进（v2.2.0）：
 *   1. 关键词加权：不同关键词有不同权重（如 "crash" 1.0 > "error" 0.3）
 *   2. 置信度门控：原始加权分数 < CONFIDENCE_THRESHOLD(0.5) → 不调整
 *   3. 平局打破：score 相同时按场景优先级排序（bug-fix > config-debug > ...）
 *   4. security-audit 独立分类（与 code-review 有不同的检索偏好）
 *
 * 设计原则：零延迟（纯规则匹配，不用 LLM），只在 tier 基础上微调比例。
 * 总 token 量不变（避免突破压力预算），只改各层分配比例。
 */
export function detectScenarioAndAdjustLimits(
  query: string,
  baseLimits: RetrievalLimits,
): ScenarioAdjustResult {
  if (!query || !query.trim()) {
    return { scenario: null, limits: baseLimits, confidence: 0 };
  }

  const q = query.toLowerCase();

  // ---- C-3: 加权关键词（权重越高越能指示场景） ----
  // 1.0 = 强信号词，单一命中即可确认场景
  // 0.6 = 正常信号词
  // 0.3 = 弱信号词，需组合命中
  const patterns: Record<string, { keywords: Array<[string, number]>; priority: number }> = {
    'bug-fix': {
      keywords: [
        ['crash', 1.0], ['segfault', 1.0], ['panic', 1.0], ['fatal', 1.0],
        ['exception', 0.6], ['修复', 0.6], ['报错', 0.6], ['崩溃', 0.6],
        ['bug', 0.6], ['error', 0.3], ['fail', 0.3], ['错误', 0.3], ['异常', 0.3],
      ],
      priority: 1, // 最高优先级（最紧急）
    },
    'config-debug': {
      keywords: [
        ['配置', 0.6], ['config', 0.6], ['setting', 0.6], ['设置', 0.6],
        ['deploy', 0.6], ['部署', 0.6], ['env', 0.6], ['环境变量', 0.6],
        ['环境', 0.3],
      ],
      priority: 2,
    },
    'performance-opt': {
      keywords: [
        ['perf', 0.6], ['性能', 0.6], ['优化', 0.6], ['optim', 0.6],
        ['slow', 0.6], ['慢', 0.6], ['latency', 0.6],
        ['提速', 0.3],
      ],
      priority: 3,
    },
    'security-audit': {
      keywords: [
        ['安全', 0.6], ['security', 0.6], ['vuln', 0.6], ['漏洞', 0.6],
        ['attack', 0.6], ['攻击', 0.6], ['inject', 0.6], ['注入', 0.6],
        ['auth', 0.6], ['认证', 0.6], ['permission', 0.6], ['权限', 0.6],
      ],
      priority: 4, // C-3: 独立分类，不同于 code-review
    },
    'code-review': {
      keywords: [
        ['review', 0.6], ['审查', 0.6], ['评审', 0.6],
        ['检查', 0.3], ['check', 0.3], ['audit', 0.3],
      ],
      priority: 5,
    },
    'deployment': {
      keywords: [
        ['deploy', 0.6], ['release', 0.6], ['发布', 0.6], ['上线', 0.6],
        ['ci', 0.6], ['pipeline', 0.6], ['流水线', 0.6],
        ['cd', 0.3],
      ],
      priority: 6,
    },
    'feature-dev': {
      keywords: [
        ['feature', 0.6], ['新功能', 0.6], ['implement', 0.6],
        ['add', 0.3], ['create', 0.3], ['build', 0.3], ['实现', 0.3], ['添加', 0.3], ['开发', 0.3],
      ],
      priority: 7,
    },
    'refactor': {
      keywords: [
        ['refactor', 0.6], ['重构', 0.6], ['rework', 0.6],
        ['改造', 0.3], ['整理', 0.3], ['restructure', 0.3],
      ],
      priority: 8, // 最低优先级（最宽泛）
    },
  };

  // 计算加权原始分数
  const scores: Array<{ scenario: string; score: number; priority: number }> = [];
  for (const [scenario, { keywords, priority }] of Object.entries(patterns)) {
    let weightedScore = 0;
    for (const [kw, weight] of keywords) {
      if (q.includes(kw)) {
        weightedScore += weight;
      }
    }
    scores.push({ scenario, score: weightedScore, priority });
  }

  // 按 score 降序 → priority 升序（score 相同时，优先级高（数字小）的胜出）
  scores.sort((a, b) => b.score - a.score || a.priority - b.priority);

  const best = scores[0];

  // C-3: 置信度门控 — 加权分数低于阈值 → 不使用场景分类
  const CONFIDENCE_THRESHOLD = 0.5;
  if (!best || best.score < CONFIDENCE_THRESHOLD) {
    return { scenario: null, limits: baseLimits, confidence: best?.score ?? 0 };
  }

  // 高压力模式下（high tier）不做调整（已经是最低限度）
  if (baseLimits.qmd <= 1 && baseLimits.graph <= 1) {
    return { scenario: best.scenario, limits: baseLimits, confidence: best.score };
  }

  // 按场景调整比例 —— 保持总量接近，只重新分配
  const totalBase = baseLimits.qmd + baseLimits.graph + baseLimits.exp;
  let qmdRatio = 0.45;
  let graphRatio = 0.35;
  let expRatio = 0.20;

  switch (best.scenario) {
    case 'bug-fix':
    case 'config-debug':
    case 'performance-opt':
      qmdRatio = 0.55; graphRatio = 0.30; expRatio = 0.15;
      break;
    case 'feature-dev':
    case 'refactor':
      qmdRatio = 0.40; graphRatio = 0.45; expRatio = 0.15;
      break;
    case 'code-review':
      qmdRatio = 0.30; graphRatio = 0.30; expRatio = 0.40;
      break;
    case 'security-audit':
      // C-3: 安全审计独立分类 — QMD 优先（漏洞模式/安全配置），Experience 次之
      qmdRatio = 0.50; graphRatio = 0.20; expRatio = 0.30;
      break;
    case 'deployment':
      qmdRatio = 0.55; graphRatio = 0.20; expRatio = 0.25;
      break;
  }

  const adjusted: RetrievalLimits = {
    qmd: Math.max(1, Math.round(totalBase * qmdRatio)),
    graph: Math.max(0, Math.round(totalBase * graphRatio)),
    exp: Math.max(0, Math.round(totalBase * expRatio)),
  };

  return { scenario: best.scenario, limits: adjusted, confidence: best.score };
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

// ---------------------------------------------------------------------------
// Backfill: 获取所有会话及消息（供经验回溯工具使用）
// ---------------------------------------------------------------------------

/** 会话消息（简化版，仅经验提取所需字段） */
export interface ConversationMessage {
  seq: number;
  role: string;
  content: string;
}

/** 会话及消息 */
export interface ConversationWithMessages {
  conversationId: number;
  sessionId: string;
  messages: ConversationMessage[];
}

/**
 * 从 LCM DB 中获取所有活跃会话及其消息。
 * 用于经验回溯工具（lcmg_backfill）重新扫描历史对话。
 *
 * @param limit 最多返回多少条会话
 * @returns 会话列表（按 conversation_id 降序，最新会话在前）
 */
export function getAllConversations(limit: number): ConversationWithMessages[] {
  const db = openLcmDbDirect();
  if (!db) return [];

  try {
    const convs = db.prepare(
      'SELECT conversation_id, session_id FROM conversations WHERE active = 1 ORDER BY conversation_id DESC LIMIT ?'
    ).all(limit) as Array<{ conversation_id: number; session_id: string }>;

    const results: ConversationWithMessages[] = [];
    for (const conv of convs) {
      try {
        const msgs = db.prepare(
          'SELECT seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq ASC'
        ).all(conv.conversation_id) as Array<{ seq: number; role: string; content: string }>;

        if (msgs.length >= 2) {
          results.push({
            conversationId: conv.conversation_id,
            sessionId: conv.session_id,
            messages: msgs.map((m) => ({
              seq: m.seq,
              role: m.role,
              content: m.content ?? '',
            })),
          });
        }
      } catch {
        // 单条会话读取失败，跳过
      }
    }

    return results;
  } finally {
    // 不关闭 DB（共享单例）
  }
}

/**
 * 打开 LCM DB 的单例连接（与 lcm-bridge 内部共用）。
 * 不暴露给外部，仅内部使用。
 */
function openLcmDbDirect(): any {
  if (_lcmDb) {
    try { _lcmDb.prepare('SELECT 1').get(); return _lcmDb; } catch { _lcmDb = null; }
  }
  try {
    const { DatabaseSync } = _lcmRequire('node:sqlite');
    _lcmDb = new DatabaseSync(LCM_DB_PATH);
    return _lcmDb;
  } catch {
    _lcmDb = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backfill state: 已处理会话记录（避免重复回溯）
// ---------------------------------------------------------------------------

const BACKFILL_STATE_PATH = join(homedir(), '.openclaw', 'backfill-state.json');

interface BackfillState {
  /** 已处理过的 conversation_id 列表 */
  processedConversations: number[];
  /** 最近一次回溯运行时间（ISO 字符串） */
  lastRunAt?: string;
}

/** 读取 backfill state 文件；不存在或损坏时返回空 state */
export function getBackfillState(): BackfillState {
  try {
    if (!existsSync(BACKFILL_STATE_PATH)) {
      return { processedConversations: [] };
    }
    const raw = readFileSync(BACKFILL_STATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.processedConversations)) {
      return { processedConversations: [] };
    }
    return {
      processedConversations: data.processedConversations.filter(
        (n: unknown) => typeof n === 'number' && Number.isFinite(n),
      ),
      lastRunAt: typeof data.lastRunAt === 'string' ? data.lastRunAt : undefined,
    };
  } catch {
    return { processedConversations: [] };
  }
}

/**
 * 标记会话为已处理，并持久化到 state 文件。
 * 多次调用同一 conversationId 是幂等的（数组去重）。
 */
export function markConversationsBackfilled(conversationIds: number[]): void {
  if (conversationIds.length === 0) return;
  const state = getBackfillState();
  const existing = new Set(state.processedConversations);
  for (const id of conversationIds) {
    if (typeof id === 'number' && Number.isFinite(id)) existing.add(id);
  }
  const newState: BackfillState = {
    processedConversations: Array.from(existing).sort((a, b) => a - b),
    lastRunAt: new Date().toISOString(),
  };
  try {
    mkdirSync(join(homedir(), '.openclaw'), { recursive: true });
    writeFileSync(BACKFILL_STATE_PATH, JSON.stringify(newState, null, 2), 'utf8');
  } catch {
    // 写入失败不影响回溯流程，下次会重新处理
  }
}

/**
 * 重置 backfill state（清空已处理记录），允许重新回溯所有会话。
 */
export function resetBackfillState(): void {
  try {
    if (existsSync(BACKFILL_STATE_PATH)) {
      writeFileSync(BACKFILL_STATE_PATH, JSON.stringify({ processedConversations: [] }, null, 2), 'utf8');
    }
  } catch {
    // ignore
  }
}
