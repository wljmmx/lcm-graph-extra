/**
 * 检索预取缓存辅助模块（leaf，零依赖，避免循环引用）
 *
 * 目的：把 O7 预取从"单轮、消费即删"升级为"跨轮、覆盖式复用 + 时间衰减 TOP-K"。
 *
 * 设计：
 * - PREFETCH_TTL_MS: 缓存有效期（保留原 10min）。
 * - prefetchEntryId: 层内条目的稳定身份键，用于跨轮 overlay 合并（刷新 _retrAt）。
 * - mergePrefetchLayer: 新结果与历史结果按身份键合并。新/更新条目 _retrAt 刷新为 now，
 *   未再召回的历史条目保留但随 age 逼近 TTL 衰减；超期条目淘汰。
 * - decayedScore / decayTopK: 时间维度衰减排序。freshness bonus 让"新召回/刚更新"的
 *   结果在 TOP-K 竞争中略高于同分桶的陈旧结果，避免旧数据长期占高位、新更新被历史覆盖。
 * - runRetrievalPrefetch: 统一的 L2/L3/L4 + 官方记忆拉取（afterTurn 与 assemble miss 共用）。
 * - writePrefetchCache: 覆盖式写缓存（含 LRU 上限 + last-known-good 保留）。
 *
 * 消费侧：assemble 读缓存后不再 delete；对层应用 decayTopK 选出注入 TOP-K。
 * 写侧：afterTurn / assemble-miss 通过 retrieval-prefetch-queue 入队，执行完后走 writePrefetchCache。
 */

/** 预取缓存有效期（与既有 prefetchCache TTL 保持一致） */
export const PREFETCH_TTL_MS = 10 * 60 * 1000;

/** 默认各层每次预取条数 */
export const DEFAULT_PREFETCH_LIMITS = { qmd: 5, graph: 5, exp: 3 } as const;

/** 层内最大保留条数（写入侧 overlay 合并后的上限，防无界增长） */
const LAYER_CAP = 20;

/** 新鲜度加成幅度：越新 max bonus 越大，用于打破同分桶的 TOP-K 竞争 */
const FRESHNESS_BONUS = 0.06;

/** 最小可读的 logger 接口（结构化任意，避免强耦合日志模块） */
type PrefetchLogger = { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; debug?: (...a: any[]) => void };

/** 预取所需的适配器依赖（afterTurn ctx 与 assemble ctx 的公共子集） */
export interface RetrievalPrefetchDeps {
  logger?: PrefetchLogger;
  qmdClient?: any;
  graphAdapter?: any;
  expStore?: any;
}

export interface PrefetchLayers {
  qmd: any[];
  graph: any[];
  exp: any[];
  openclaw: any[];
}

/** 预取拉取完成后的钩子（如 afterTurn 的 L3 召回闭环记录） */
export interface PrefetchHooks {
  onGraph?: (nodeIds: string[], sessionKey: string, query: string) => void;
}

// ---------------------------------------------------------------------------
// 查询相似度（从 retrieval.ts 迁移，避免队列与 assemble 循环引用）
// ---------------------------------------------------------------------------
export function prefetchQuerySimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const norm = (s: string) => s.toLowerCase().trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  // 拉丁/空格分词
  const split = (s: string) => s.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  const tokensA = split(x);
  if (tokensA.length > 0 && split(y).length > 0) {
    const setB = new Set(split(y));
    let inter = 0;
    for (const t of tokensA) if (setB.has(t)) inter++;
    return inter / Math.max(Math.max(tokensA.length, split(y).length), 1);
  }
  // 纯 CJK 等无空格文本: 用字符二元组重叠
  const big = (s: string) => { const out = new Set<string>(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; };
  const ba = big(x), bb = big(y);
  if (ba.size === 0 || bb.size === 0) return 0;
  let bi = 0;
  for (const c of ba) if (bb.has(c)) bi++;
  return bi / Math.max(ba.size, bb.size);
}

// ---------------------------------------------------------------------------
// 层内条目身份键
// ---------------------------------------------------------------------------
export function prefetchEntryId(r: any): string {
  if (!r) return '';
  if (typeof r.id === 'string' && r.id) return 'id:' + r.id;
  const nested = r?.metadata?.nodeId || r?.experience?.id || r?.docid;
  if (nested) return 'id:' + nested;
  const c = String(r?.content || r?.summary || r?.title || '');
  return 'h:' + (c || r).toString().slice(0, 80);
}

// ---------------------------------------------------------------------------
// Overlay 合并 + 时间衰减
// ---------------------------------------------------------------------------
/** 合并一层：新结果刷新 _retrAt；历史保留（base score 原样，不叠加时间衰减，防多次写叠加）；
 *  超期淘汰；仅按 base score 截断防无界堆积。新鲜度加成只在读取（assemble 消费）时应用。 */
export function mergePrefetchLayer(existing: any[] | undefined, incoming: any[], now: number): any[] {
  const out = new Map<string, any>();
  const prune = (arr: any[] | undefined) =>
    (Array.isArray(arr) ? arr : []).filter(
      (r) => r && (typeof r._retrAt !== 'number' || now - r._retrAt < PREFETCH_TTL_MS),
    );
  for (const r of prune(existing)) {
    out.set(prefetchEntryId(r), { ...r });
  }
  for (const r of prune(incoming)) {
    const k = prefetchEntryId(r);
    const prev = out.get(k);
    // 刷新 _retrAt（时间衰减的"新近"依据），但保留各源原始 score —— 不在写时叠加新鲜度
    out.set(k, { ...(prev || {}), ...r, _retrAt: now });
  }
  const merged = [...out.values()];
  // 仅按 base score 收敛上限，避免旧条目无界堆积（不在这里做时间衰减排序，留给读取侧）
  return merged
    .sort((a, b) => (typeof (b as any)?.score === 'number' ? (b as any).score : 0) - (typeof (a as any)?.score === 'number' ? (a as any).score : 0))
    .slice(0, LAYER_CAP)
    .map((r) => ({ ...r }));
}

/** 时间衰减分数：base + 新鲜度加成；越新加成越高，超期归档自然回落 */
export function decayedScore(r: any, now: number, ttlMs: number = PREFETCH_TTL_MS): number {
  const base = typeof r?.score === 'number' ? r.score : 0.5;
  const at = typeof r?._retrAt === 'number' ? r._retrAt : now;
  const age = Math.max(0, now - at);
  const t = Math.max(0, 1 - age / ttlMs); // 0..1
  const boosted = base + FRESHNESS_BONUS * t;
  return Math.min(1, Math.max(0, boosted));
}

/** 时间衰减 TOP-K：按衰减分排序取前 K，并把衰减分回写 score（让注入层感知新鲜度） */
export function decayTopK(layer: any[], k: number, now: number, ttlMs: number = PREFETCH_TTL_MS): any[] {
  if (!Array.isArray(layer) || layer.length === 0) return [];
  const kk = Math.max(0, Math.floor(k));
  return [...layer]
    .map((r) => ({ r, s: decayedScore(r, now, ttlMs) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, kk)
    .map(({ r, s }) => ({ ...r, score: s }));
}

// ---------------------------------------------------------------------------
// 统一四层拉取（afterTurn 与 assemble miss 共用）
// ---------------------------------------------------------------------------
export async function runRetrievalPrefetch(
  deps: RetrievalPrefetchDeps,
  sessionKey: string,
  query: string,
  limits: { qmd: number; graph: number; exp: number } = DEFAULT_PREFETCH_LIMITS,
  hooks?: PrefetchHooks,
): Promise<PrefetchLayers> {
  const results: PrefetchLayers = { qmd: [], graph: [], exp: [], openclaw: [] };
  const logger = deps.logger;

  // L2: qmd 检索（lex + vec 单次结构化调用，rerank=false 免 LLM rerank 延迟）
  if (deps.qmdClient) {
    try {
      const qmdRes = await deps.qmdClient.query({
        searches: [
          { type: 'lex', query },
          { type: 'vec', query },
        ],
        limit: limits.qmd,
        rerank: false,
      });
      if (Array.isArray(qmdRes)) results.qmd.push(...qmdRes);
      logger?.info?.('[prefetch] L2 qmd fetched', { sessionKey: sessionKey.slice(0, 16), count: results.qmd.length });
    } catch (l2Err) {
      logger?.warn?.('[prefetch] L2 failed (non-fatal)', { err: (l2Err as Error).message });
    }
  } else {
    logger?.info?.('[prefetch] L2 skipped (qmdClient not present)', { sessionKey: sessionKey.slice(0, 16) });
  }

  // L3: Neo4j 知识图谱
  if (deps.graphAdapter) {
    try {
      const graphRes = await deps.graphAdapter.searchWithCache(query, limits.graph);
      if (Array.isArray(graphRes)) results.graph = graphRes;
      logger?.info?.('[prefetch] L3 graph fetched', { sessionKey: sessionKey.slice(0, 16), count: results.graph.length });
      if (graphRes?.length && hooks?.onGraph) {
        const nodeIds = graphRes.map((r: any) => r?.metadata?.nodeId).filter(Boolean);
        if (nodeIds.length) {
          try { hooks.onGraph(nodeIds, sessionKey, query); } catch { /* non-fatal */ }
        }
      }
    } catch (l3Err) {
      logger?.warn?.('[prefetch] L3 failed (non-fatal)', { err: (l3Err as Error).message });
    }
  } else {
    logger?.info?.('[prefetch] L3 skipped (graphAdapter not present)', { sessionKey: sessionKey.slice(0, 16) });
  }

  // L4: Experience
  if (deps.expStore) {
    try {
      const expRes = await deps.expStore.searchByQuery({ query, limit: limits.exp, minScore: 0.3 });
      if (Array.isArray(expRes)) results.exp = expRes;
      logger?.info?.('[prefetch] L4 experience fetched', { sessionKey: sessionKey.slice(0, 16), count: results.exp.length });
    } catch (l4Err) {
      logger?.warn?.('[prefetch] L4 failed (non-fatal)', { err: (l4Err as Error).message });
    }
  } else {
    logger?.info?.('[prefetch] L4 skipped (expStore not present)', { sessionKey: sessionKey.slice(0, 16) });
  }

  // L1.5: OpenClaw 官方记忆（本地 per-agent SQLite 快查）
  if (query.trim().length > 0) {
    try {
      const { searchAgentMemory } = await import('../adapters/openclaw-agent-db.js');
      const memRes = searchAgentMemory(query.slice(0, 300), { maxChunksPerAgent: 3 });
      if (Array.isArray(memRes)) results.openclaw = memRes;
      logger?.info?.('[prefetch] openclaw memory fetched', { sessionKey: sessionKey.slice(0, 16), count: results.openclaw.length });
    } catch (memErr) {
      logger?.debug?.('[prefetch] openclaw memory failed (non-fatal)', { err: (memErr as Error)?.message ?? String(memErr) });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 覆盖式写缓存
// ---------------------------------------------------------------------------
export function writePrefetchCache(
  cache: Map<string, any> | undefined,
  sessionKey: string,
  results: PrefetchLayers,
  query: string,
  now: number,
  logger?: PrefetchLogger,
): void {
  if (!cache || !sessionKey) return;
  const existing = cache.get(sessionKey);
  const hasAnyData =
    results.qmd.length > 0 || results.graph.length > 0 || results.exp.length > 0 || results.openclaw.length > 0;

  if (!hasAnyData) {
    // 各层全空（检索失败）：保留上一份非空条目（last-known-good），避免空结果"毒化"缓存
    if (existing && now - existing.ts < PREFETCH_TTL_MS) {
      logger?.warn?.('[prefetch] empty, retaining last-known-good cache', {
        sessionKey: sessionKey.slice(0, 16),
        qmd: existing.qmdResults?.length,
        graph: existing.graphResults?.length,
        exp: existing.expResults?.length,
        openclaw: existing.openclawResults?.length ?? 0,
      });
    } else {
      logger?.warn?.('[prefetch] empty (all layers failed), no cache written', { sessionKey: sessionKey.slice(0, 16) });
    }
    return;
  }

  // LRU 上限保护
  if (cache.size >= 200) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  // Overlay 合并：新结果刷新 _retrAt，历史保留（带时间衰减），超期淘汰
  cache.set(sessionKey, {
    qmdResults: mergePrefetchLayer(existing?.qmdResults, results.qmd, now),
    graphResults: mergePrefetchLayer(existing?.graphResults, results.graph, now),
    expResults: mergePrefetchLayer(existing?.expResults, results.exp, now),
    openclawResults: mergePrefetchLayer(existing?.openclawResults || [], results.openclaw, now),
    query,
    ts: now,
  });
  logger?.info?.('[prefetch] cache written (overlay merge)', {
    sessionKey: sessionKey.slice(0, 16),
    qmd: cache.get(sessionKey)?.qmdResults?.length,
    graph: cache.get(sessionKey)?.graphResults?.length,
    exp: cache.get(sessionKey)?.expResults?.length,
    openclaw: cache.get(sessionKey)?.openclawResults?.length,
  });
}