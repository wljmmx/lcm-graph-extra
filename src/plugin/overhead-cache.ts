/**
 * Session overhead cache (LRU)
 *
 * 缓存每 session 上一轮 systemPromptAddition 的 token 开销，
 * 供下一轮 pressure tier 判定时纳入有效 token 数。
 *
 * 容量/TTL 与 sessionDedupCache 对齐，避免活跃 session 长期堆积。
 */
import { DEFAULTS } from "../config/defaults.js";

const MAX_OVERHEAD_CAPACITY = DEFAULTS.dedup.maxCapacity;
const OVERHEAD_TTL_MS = DEFAULTS.dedup.ttlMs;
const _sessionOverheadCache = new Map<string, { tokens: number; lastAccess: number }>();
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

export function getOverhead(sessionKey: string): number {
  const entry = _sessionOverheadCache.get(sessionKey);
  if (!entry) return 0;
  entry.lastAccess = Date.now();
  touchOverhead(sessionKey);
  return entry.tokens;
}

export function setOverhead(sessionKey: string, tokens: number): void {
  const existing = _sessionOverheadCache.get(sessionKey);
  if (existing) {
    existing.tokens = tokens;
    existing.lastAccess = Date.now();
  } else {
    evictStaleOverhead();
    _sessionOverheadCache.set(sessionKey, { tokens, lastAccess: Date.now() });
  }
  touchOverhead(sessionKey);
}

/** 清除指定会话的 overhead 缓存（/new 等会话重置场景） */
export function clearOverheadCache(sessionKey: string): void {
  _sessionOverheadCache.delete(sessionKey);
}
