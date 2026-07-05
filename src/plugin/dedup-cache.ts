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
const dedupAccessOrder: string[] = [];
let MAX_DEDUP_ROUNDS: number = DEFAULTS.dedup.maxRounds;

export function getMaxDedupRounds(): number {
  return MAX_DEDUP_ROUNDS;
}

export function setMaxDedupRounds(n: number): void {
  MAX_DEDUP_ROUNDS = n;
}

function evictStaleDedup(): void {
  const now = Date.now();
  while (dedupAccessOrder.length > 0) {
    const key = dedupAccessOrder[0];
    const entry = sessionDedupCache.get(key);
    if (!entry || (now - entry.lastAccess) > DEDUP_TTL_MS) {
      dedupAccessOrder.shift();
      sessionDedupCache.delete(key);
    } else {
      break;
    }
  }
  while (sessionDedupCache.size > MAX_DEDUP_CAPACITY) {
    const lru = dedupAccessOrder.shift();
    if (lru === undefined) break;
    sessionDedupCache.delete(lru);
  }
}

function touchDedup(sessionKey: string): void {
  const idx = dedupAccessOrder.indexOf(sessionKey);
  if (idx !== -1) dedupAccessOrder.splice(idx, 1);
  dedupAccessOrder.push(sessionKey);
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
