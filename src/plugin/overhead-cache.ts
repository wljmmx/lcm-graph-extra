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
const _overheadAccessOrder: string[] = [];

function evictStaleOverhead(): void {
  const now = Date.now();
  while (_overheadAccessOrder.length > 0) {
    const key = _overheadAccessOrder[0];
    const entry = _sessionOverheadCache.get(key);
    if (!entry || (now - entry.lastAccess) > OVERHEAD_TTL_MS) {
      _overheadAccessOrder.shift();
      _sessionOverheadCache.delete(key);
    } else {
      break;
    }
  }
  while (_sessionOverheadCache.size > MAX_OVERHEAD_CAPACITY) {
    const lru = _overheadAccessOrder.shift();
    if (lru === undefined) break;
    _sessionOverheadCache.delete(lru);
  }
}

function touchOverhead(sessionKey: string): void {
  const idx = _overheadAccessOrder.indexOf(sessionKey);
  if (idx !== -1) _overheadAccessOrder.splice(idx, 1);
  _overheadAccessOrder.push(sessionKey);
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
