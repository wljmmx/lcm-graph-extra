/**
 * Session overhead cache (LRU)
 *
 * 缓存每 session 上一轮的两类 token 开销：
 *   1. additionTokens — 我们注入的 systemPromptAddition
 *   2. sdkOverhead    — SDK 注入但 assemble 不可见的开销
 *                       （system prompt + tool catalog + workspace 文件 + skills 列表）
 *
 * 容量/TTL 与 sessionDedupCache 对齐，避免活跃 session 长期堆积。
 */
import { DEFAULTS } from "../config/defaults.js";
import { SDK_OVERHEAD_TOKENS } from "../config.js";

const MAX_OVERHEAD_CAPACITY = DEFAULTS.dedup.maxCapacity;
const OVERHEAD_TTL_MS = DEFAULTS.dedup.ttlMs;
const _sessionOverheadCache = new Map<string, {
  additionTokens: number;
  sdkOverhead: number;
  lastAccess: number;
}>();
// perf: 直接用 Map 的插入顺序维护 LRU（O(1) move-to-end），替代原 indexOf+splice O(N=500)

function evictStaleOverhead(): void {
  const now = Date.now();
  // Map 迭代顺序 = 插入顺序 = LRU 顺序
  for (const [key, entry] of _sessionOverheadCache) {
    if ((now - entry.lastAccess) > OVERHEAD_TTL_MS) {
      _sessionOverheadCache.delete(key);
    } else {
      break;
    }
  }
  while (_sessionOverheadCache.size > MAX_OVERHEAD_CAPACITY) {
    const firstKey = _sessionOverheadCache.keys().next().value;
    if (firstKey === undefined) break;
    _sessionOverheadCache.delete(firstKey);
  }
}

// perf: O(1) move-to-end —— delete + re-set
function touchOverhead(sessionKey: string): void {
  const entry = _sessionOverheadCache.get(sessionKey);
  if (entry) {
    _sessionOverheadCache.delete(sessionKey);
    _sessionOverheadCache.set(sessionKey, entry);
  }
}

/** 获取上一轮 systemPromptAddition 的 token 开销 */
export function getOverhead(sessionKey: string): number {
  const entry = _sessionOverheadCache.get(sessionKey);
  if (!entry) return 0;
  entry.lastAccess = Date.now();
  touchOverhead(sessionKey);
  return entry.additionTokens;
}

/** 设置上一轮 systemPromptAddition 的 token 开销 */
export function setOverhead(sessionKey: string, tokens: number): void {
  const existing = _sessionOverheadCache.get(sessionKey);
  if (existing) {
    existing.additionTokens = tokens;
    existing.lastAccess = Date.now();
  } else {
    evictStaleOverhead();
    _sessionOverheadCache.set(sessionKey, { additionTokens: tokens, sdkOverhead: SDK_OVERHEAD_TOKENS, lastAccess: Date.now() });
  }
  touchOverhead(sessionKey);
}

/**
 * 获取 SDK untracked overhead（动态值）。
 *
 * 计算方式：SDK 每轮实际使用的总 token 减去 assemble 可见的 token（消息 + systemPromptAddition），
 * 差值即为 SDK 额外注入的 overhead。首轮或无历史数据时返回默认值。
 *
 * @returns SDK overhead tokens（保守取：历史值的 max 或默认值）
 */
export function getSdkOverhead(sessionKey: string): number {
  const entry = _sessionOverheadCache.get(sessionKey);
  if (!entry) return SDK_OVERHEAD_TOKENS;
  entry.lastAccess = Date.now();
  touchOverhead(sessionKey);
  // 返回历史记录值与默认值的较大者，避免欠估
  return Math.max(entry.sdkOverhead, SDK_OVERHEAD_TOKENS * 0.5);
}

/**
 * 更新 SDK overhead 预估。
 *
 * 由 assemble 在每轮结束时调用，传入本轮实际观察到的 token 值，
 * 反推 SDK overhead = contextUsage - messageTokens - additionTokens。
 * 首次记录时直接使用，后续取 EMA（指数移动平均）平滑波动。
 *
 * @param sessionKey 会话标识
 * @param contextUsage SDK 报告的实际上下文使用量（来自 overflow 日志或 usage 回调）
 * @param messageTokens assemble 返回的消息 token 估算
 * @param additionTokens assemble 返回的 systemPromptAddition token 估算
 */
export function updateSdkOverhead(
  sessionKey: string,
  contextUsage: number,
  messageTokens: number,
  additionTokens: number,
): void {
  const observed = Math.max(0, contextUsage - messageTokens - additionTokens);
  if (observed <= 0) return;

  const existing = _sessionOverheadCache.get(sessionKey);
  if (existing) {
    // EMA α=0.3：新观察占 30%，历史占 70%，平滑波动
    existing.sdkOverhead = Math.round(existing.sdkOverhead * 0.7 + observed * 0.3);
    existing.lastAccess = Date.now();
  } else {
    evictStaleOverhead();
    _sessionOverheadCache.set(sessionKey, {
      additionTokens: additionTokens,
      sdkOverhead: observed,
      lastAccess: Date.now(),
    });
  }
  touchOverhead(sessionKey);
}

/** 清除指定会话的 overhead 缓存（/new 等会话重置场景） */
export function clearOverheadCache(sessionKey: string): void {
  _sessionOverheadCache.delete(sessionKey);
}
