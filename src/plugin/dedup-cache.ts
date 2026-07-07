/**
 * Session-isolated dedup cache (LRU)
 *
 * - max 500 sessions, 1h TTL
 * - each session tracks hashes for up to 24 rounds of conversation
 */
import { DEFAULTS } from "../config/defaults.js";

const MAX_DEDUP_CAPACITY = DEFAULTS.dedup.maxCapacity;
const DEDUP_TTL_MS = DEFAULTS.dedup.ttlMs;
const sessionDedupCache = new Map<string, { window: string[][]; maxRounds: number; lastAccess: number }>();
// perf: 直接用 Map 的插入顺序维护 LRU（delete + re-set 实现 O(1) move-to-end），
//       替代原 indexOf+splice 的 O(N=500) 操作
let MAX_DEDUP_ROUNDS: number = DEFAULTS.dedup.maxRounds;

export function getMaxDedupRounds(): number {
  return MAX_DEDUP_ROUNDS;
}

export function setMaxDedupRounds(n: number): void {
  MAX_DEDUP_ROUNDS = n;
}

function evictStaleDedup(): void {
  const now = Date.now();
  // Map 迭代顺序 = 插入顺序 = LRU 顺序（最旧在最前）
  for (const [key, entry] of sessionDedupCache) {
    if ((now - entry.lastAccess) > DEDUP_TTL_MS) {
      sessionDedupCache.delete(key);
    } else {
      break;
    }
  }
  while (sessionDedupCache.size > MAX_DEDUP_CAPACITY) {
    // 删除最旧项（Map 第一个 key）
    const firstKey = sessionDedupCache.keys().next().value;
    if (firstKey === undefined) break;
    sessionDedupCache.delete(firstKey);
  }
}

// perf: O(1) move-to-end —— delete + re-set 让 key 移到 Map 末尾（最新）
function touchDedup(sessionKey: string): void {
  const entry = sessionDedupCache.get(sessionKey);
  if (entry) {
    sessionDedupCache.delete(sessionKey);
    sessionDedupCache.set(sessionKey, entry);
  }
}

export function getSessionDedup(sessionKey: string) {
  let entry = sessionDedupCache.get(sessionKey);
  if (!entry) {
    evictStaleDedup();
    entry = { window: [], maxRounds: MAX_DEDUP_ROUNDS, lastAccess: Date.now() };
    sessionDedupCache.set(sessionKey, entry);
  } else {
    entry.lastAccess = Date.now();
  }
  touchDedup(sessionKey);
  return entry;
}

/** Public eviction trigger for heartbeat/maintain cycles. */
export function evictStaleDedupPublic(): void {
  evictStaleDedup();
}
