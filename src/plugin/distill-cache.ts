/**
 * Harnessing P4: 蒸馏内容寻址缓存（对齐 Harness² 的 content-addressed cache 思路）。
 *
 * 键 = hash(prompt 版本 + 模型 + 经验源内容) → 值 = LLM 派生字段（title/summary/type/
 * relevanceScore/tags/relatedConcepts）。同一内容重复蒸馏（重试/重跑/跨会话重复经验）
 * 直接命中缓存跳过 LLM 调用，且内容地址即审计键。
 *
 * 语义边界：
 *   - 只缓存 LLM 派生字段；身份字段（id/rawIds/createdAt/matchCount）每次重新生成，
 *     与实时蒸馏产物同构。
 *   - prompt 结构变更时 bump DISTILL_PROMPT_VERSION，旧缓存自然失效。
 *   - 开关：LCMG_DISTILL_CACHE=off 关闭（默认开启，opt-out，对齐 P4 转录改写风格）。
 */

import { createHash, randomUUID } from 'node:crypto';

/** prompt 结构版本：distillOne 的 prompt 字段变更时必须 bump，否则旧缓存语义漂移 */
export const DISTILL_PROMPT_VERSION = 'v1';

/** 蒸馏派生字段（可被内容寻址缓存的部分） */
export interface CachedDistillFields {
  type: string;
  title: string;
  summary: string;
  relevanceScore: number;
  tags?: any;
  relatedConcepts?: string[];
}

interface CacheEntry {
  fields: CachedDistillFields;
  ts: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES = 500;

const _cache = new Map<string, CacheEntry>();
const _stats = { hits: 0, misses: 0, stores: 0, evictions: 0 };

/** 开关：默认开启，仅显式 LCMG_DISTILL_CACHE=off 关闭（大小写/空白容忍） */
export function isDistillCacheEnabled(): boolean {
  return (process.env.LCMG_DISTILL_CACHE ?? '').trim().toLowerCase() !== 'off';
}

/**
 * 计算内容寻址键。
 * \u241f（符号分隔符）拼接头几段降低偶发拼接歧义；内容含分隔符时哈希仍唯一（顺序固定）。
 */
export function computeDistillContentAddress(parts: {
  source: string;
  context: string;
  detail: string;
  model: string;
}): string {
  return createHash('sha1')
    .update(
      DISTILL_PROMPT_VERSION + '\u241f' +
      parts.model + '\u241f' +
      parts.source + '\u241f' +
      parts.context + '\u241f' +
      parts.detail,
    )
    .digest('hex');
}

/** 命中缓存返回派生字段；过期/缺失返回 undefined（并惰性清理过期项） */
export function getCachedDistill(key: string): CachedDistillFields | undefined {
  const entry = _cache.get(key);
  if (!entry) {
    _stats.misses++;
    return undefined;
  }
  if (Date.now() - entry.ts > TTL_MS) {
    _cache.delete(key);
    _stats.misses++;
    return undefined;
  }
  // LRU touch：重新插入到末尾
  _cache.delete(key);
  _cache.set(key, entry);
  _stats.hits++;
  return { ...entry.fields, tags: entry.fields.tags ? JSON.parse(JSON.stringify(entry.fields.tags)) : undefined };
}

/** 写入缓存；超上限时驱逐最旧条目 */
export function setCachedDistill(key: string, fields: CachedDistillFields): void {
  while (_cache.size >= MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
    _stats.evictions++;
  }
  // 深拷贝隔离，防调用方后续篡改缓存内容
  _cache.set(key, {
    ts: Date.now(),
    fields: JSON.parse(JSON.stringify(fields)),
  });
  _stats.stores++;
}

/** 用缓存的派生字段 + 当前 raw 身份组装蒸馏产物（与 distillOne 实时产物同构） */
export function buildDistillArtifactFromCache(
  fields: CachedDistillFields,
  rawId: string,
  rawDetail: string,
  rawContext: string,
): any {
  return {
    id: 'exp_dist_' + randomUUID(),
    rawIds: [rawId],
    type: fields.type,
    title: fields.title,
    summary: fields.summary,
    detail: (rawDetail || '').slice(0, 2000),
    context: rawContext || '',
    relevanceScore: fields.relevanceScore,
    createdAt: new Date(),
    matchCount: 0,
    tags: fields.tags ? JSON.parse(JSON.stringify(fields.tags)) : undefined,
    relatedConcepts: fields.relatedConcepts
      ? [...fields.relatedConcepts]
      : undefined,
  };
}

/** 清空缓存与统计（测试/运维用） */
export function clearDistillCache(): void {
  _cache.clear();
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.stores = 0;
  _stats.evictions = 0;
}

/** 缓存统计（命中/未命中/写入/驱逐）—— 供诊断与 dashboard 读取 */
export function getDistillCacheStats(): { size: number; hits: number; misses: number; stores: number; evictions: number } {
  return { size: _cache.size, ..._stats };
}
