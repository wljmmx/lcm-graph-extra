/**
 * 四层检索编排模块。
 *
 * 提取 assemble 中的检索逻辑：
 *   - detectScenarioAndAdjustLimits 调用（场景分类）
 *   - 并行 L2 qmd + L3 Neo4j + L4 exp 检索
 *   - merger 去重
 *   - qmd multiGet 拉取全文
 *   - R-2 级联评估
 */

import { detectScenarioAndAdjustLimits } from '../lcm-bridge.js';
import { llmTimeout, DEFAULTS } from '../config/defaults.js';
import { callLlm } from '../utils/llm-call.js';
import { CascadeManager } from '../cascade-manager.js';
import { backgroundTasks } from '../async/task-registry.js';
import { resolveSessionCacheKey } from '../utils/session-key.js';
import { serializeError } from '../utils/logger.js';
// P0-6: 热路径 healthMetrics 静态导入
import { healthMetrics } from '../health-metrics.js';
import type { AssembleContext, RetrievalOutput } from './types.js';
import type { RetrievalResult } from '../types.js';

import { randomUUID } from 'node:crypto';
import { extractEntities, matchEntityScore } from '../entity-extract.js';
import { needsQueryRewrite, rewriteQuery } from './query-rewrite.js';
import { extractLatestUserGoal, getGoal } from '../plugin/goal-cache.js';
// P0-7: 话题切换检测（防止跨话题复用旧缓存/旧压测统计/旧场景分类）
import { detectTopicSwitch } from '../topic-switch.js';
// O7+: 跨轮预取辅助（相似度/时间衰减 TOP-K/统一拉取/覆盖式写缓存）
import {
  prefetchQuerySimilarity,
  decayTopK,
  PREFETCH_TTL_MS,
  runRetrievalPrefetch,
  writePrefetchCache,
} from './retrieval-prefetch.js';
// O7+: 跨轮预取队列 —— cache miss 时入队后台补水，避免话题切换当轮裸奔
import { retrievalPrefetchQueue } from '../async/retrieval-prefetch-queue.js';

/** querySimilarity / 时间衰减 TOP-K 已迁至 ./retrieval-prefetch.ts（供跨轮队列复用，避免循环引用） */

/** 将 QMD 原始结果 (QmdSearchResult) 转换为 RetrievalResult，供 Merger 使用 */
function toRetrievalResult(r: any): RetrievalResult {
  return {
    id: typeof r.docid === 'string' && r.docid ? r.docid : `qmd_${randomUUID().slice(0, 8)}`,
    content: `File: ${r.file ?? '?'}:${r.line ?? 0}\nTitle: ${r.title ?? ''}\n${r.snippet ?? ''}`,
    source: 'qmd' as const,
    type: 'raw' as const,
    score: typeof r.score === 'number' ? r.score : 0,
    metadata: { file: r.file, line: r.line, docid: r.docid, title: r.title },
  };
}

export async function performRetrieval(
  ctx: AssembleContext,
  params: any,
  tier: string,
  tokenRatio: number,
  retrievalLimits: { qmd: number; graph: number; exp: number },
  hasGraphTool: boolean,
  hasExperienceTool: boolean,
  availableTools: string[],
  estimatedTokens: number,
  contextWindow: number,
  effectiveTokenCount: number,
  overheadTokens: number,
  msgCount: number,
  uncompressedMsgs: number,
  initMs: number,
  degradedReasons: string[],
): Promise<RetrievalOutput> {
  const markDegraded = (reason: string): void => {
    if (!degradedReasons.includes(reason)) degradedReasons.push(reason);
  };

  // FIX-SK1: 与写入侧（after-turn O7 用 resolveSessionCacheKey，sessionId 优先）统一。
  // 修复前：此处取 raw sessionKey（稳定路由桶），写入侧取 sessionId → /new 后
  // 两个 key 永不相等 → O7 预取缓存永远 miss，每轮 assemble 都走全量检索
  // （含 embedding Ollama 调用），加剧主生成与检索的本地 LLM 串行排队。
  const sessionKey = resolveSessionCacheKey(params);

  // ---- v2.9 FIX: 检索查询源加固 ----
  // 原逻辑：params.prompt 为空时直接取 params.messages.at(-1)（不校验 role）。
  // CE/Agent 循环中最后一条消息常为模型自己的输出（role='assistant'）或工具结果
  // （role='user' 的 tool_result 块/存根），会把"模型上一轮的话/工具输出"当作检索查询
  // → 拉回同主题旧经验 → 注入 → 模型继续 → 经验回声室自增强（目标偏移根因之一）。
  // 新优先级：params.prompt（SDK 显式检索查询）> 目标缓存（getGoal）> 最后一条真实
  // user 消息（extractLatestUserGoal，已过滤 assistant / tool_result）。
  const goalText = sessionKey ? getGoal(sessionKey) : '';
  let qmdQuery = typeof params.prompt === 'string' && params.prompt.trim()
    ? params.prompt.trim()
    : "";
  if (!qmdQuery) {
    qmdQuery = goalText || extractLatestUserGoal(params.messages ?? []);
  }
  ctx.setLastRetrievalQuery(qmdQuery);
  ctx.logger?.debug?.('[assemble] retrieval query source', {
    source: typeof params.prompt === 'string' && params.prompt.trim() ? 'params.prompt' : (goalText ? 'goal' : 'last-user'),
    len: qmdQuery.length,
  });

  // ---- Phase 1: 实体提取（三层主题锚定） ----
  // 从查询中提取关键实体，用于后续检索结果的主题一致性过滤
  let extractedEntities: ReturnType<typeof extractEntities> = { terms: [], properNouns: [], techTerms: [], tokens: [] };
  try {
    extractedEntities = extractEntities(qmdQuery);
    if (extractedEntities.tokens.length > 0) {
      ctx.logger?.debug?.('[assemble] Phase 1: extracted entities', {
        terms: extractedEntities.terms.slice(0, 5),
        properNouns: extractedEntities.properNouns.slice(0, 5),
        techTerms: extractedEntities.techTerms.slice(0, 5),
        totalTokens: extractedEntities.tokens.length,
      });
    }
  } catch (e) {
    ctx.logger?.debug?.('[assemble] Phase 1: entity extraction failed (non-fatal)', { err: String(e) });
  }

  // ---- Phase 3: 查询重构（可选） ----
  // 当实体提取质量差时，用 LLM 将模糊查询改写为更精确的查询
  let queryRewriteResult = null;
  try {
    if (needsQueryRewrite(extractedEntities, qmdQuery)) {
      ctx.logger?.debug?.('[assemble] Phase 3: query rewrite triggered, entities empty, rewriting query', { original: qmdQuery });
      queryRewriteResult = await rewriteQuery(qmdQuery, ctx);
      if (queryRewriteResult.wasRewritten) {
        qmdQuery = queryRewriteResult.rewrittenQuery;
        // 用改写后的查询重新提取实体
        try {
          extractedEntities = extractEntities(qmdQuery);
          if (extractedEntities.tokens.length > 0) {
            ctx.logger?.debug?.('[assemble] Phase 3: re-extracted entities from rewritten query', {
              terms: extractedEntities.terms.slice(0, 5),
              totalTokens: extractedEntities.tokens.length,
            });
          }
        } catch (reExtractErr) {
          ctx.logger?.debug?.('[assemble] Phase 3: re-extraction failed (non-fatal)', { err: String(reExtractErr) });
        }
      }
    }
  } catch (rwErr) {
    ctx.logger?.debug?.('[assemble] Phase 3: query rewrite failed (non-fatal)', { err: String(rwErr) });
  }

  // ---- v2.8.0 O7: 异步预取架构 ----
  // 当前轮永远只使用上一轮 afterTurn 预取的结果，不再发起同步检索。
  // 检索耗时（L2 7-30s, L3 9-18s, L4 50-200ms）完全从用户感知路径移除。
  const parallelStart = Date.now();
  let qmdResults: any[] = [];
  let graphResults: any[] = [];
  let expResults: any[] = [];
  let openclawResults: any[] = [];
  let l2_ms = 0, l3_ms = 0, l4_ms = 0;

  // R-5': 动态混合简化 —— 按 scenario 调整 retrievalLimits 比例
  const scenarioAdjust = detectScenarioAndAdjustLimits(qmdQuery, retrievalLimits);
  retrievalLimits = scenarioAdjust.limits;
  if (scenarioAdjust.scenario) {
    ctx.logger?.debug?.("R-5 scenario-adjusted retrieval limits", {
      scenario: scenarioAdjust.scenario,
      confidence: Number(scenarioAdjust.confidence?.toFixed(3) ?? 0),
      limits: retrievalLimits,
    });
  }

  // Session key for prefetch cache lookup（声明已上移至查询源提取处，避免重复声明）

  const PREFETCH_CACHE_TTL = PREFETCH_TTL_MS; // 10min
  const cached = sessionKey ? ctx.prefetchCache?.get(sessionKey) : undefined;
  // v2.8.1 非MoA 修复: 查询一致性校验 —— 预取结果仅当生成查询与本轮 qmdQuery 主题相关时
  // 才可消费(相似度 >= 0.3), 否则视为 miss。修复前按 sessionKey 无条件消费, 会把
  // "上一问的预取"喂给"本问", 导致检索错位、模型反复"我再查"。
  const cacheUsable = !!cached
    && (Date.now() - cached.ts < PREFETCH_CACHE_TTL)
    && prefetchQuerySimilarity(cached.query, qmdQuery) >= 0.3;

  // P0-7: 话题切换检测 —— 上一轮查询与当前查询重叠度极低时，即使 querySimilarity
  // 通过（如两问都含公共词"问题"），也判定为话题切换：不消费预取缓存，并记录
  // 日志供排查。防止旧话题的预取结果/压测统计污染新话题。
  const topicSwitch = detectTopicSwitch(cached?.query ?? '', qmdQuery);
  const topicSwitched = !!cached && topicSwitch.switched;

  let rawQmd: any[] = [];
  let rawGraph: any[] = [];
  // O7+: 标记本轮是否消费缓存层。仅缓存来源的结果应用时间衰减 TOP-K（新鲜度排序），
  // 新鲜同步检索结果不受影响。
  let fromCache = false;

  if (cacheUsable && !topicSwitched && cached) {
    // 使用上一轮 afterTurn 预取的全量结果（跨轮复用：不删除，时间衰减 TOP-K 控制注入，新查询自然覆盖）
    rawQmd = cached.qmdResults || [];
    rawGraph = cached.graphResults || [];
    expResults = cached.expResults || [];
    openclawResults = cached.openclawResults || [];
    fromCache = true;

    ctx.logger?.info?.('[assemble] O7: using prefetch cache', {
      sessionKey: sessionKey.slice(0, 16),
      qmdCount: rawQmd.length,
      graphCount: rawGraph.length,
      expCount: expResults.length,
      openclawCount: openclawResults.length,
      cacheAgeMs: Date.now() - cached.ts,
      cachedQuery: cached.query?.slice(0, 60),
    });
  } else {
    if (cached && (!cacheUsable || topicSwitched)) {
      ctx.logger?.debug?.('[assemble] O7: prefetch cache rejected (query mismatch, expired, or topic switch)', {
        sessionKey: sessionKey.slice(0, 16),
        cachedQuery: cached.query?.slice(0, 60),
        currentQuery: qmdQuery.slice(0, 60),
        sim: prefetchQuerySimilarity(cached.query, qmdQuery).toFixed(2),
        overlap: topicSwitch.overlap.toFixed(2),
        topicSwitched,
        cacheAgeMs: Date.now() - cached.ts,
      });
    } else {
      // 首轮或缓存过期：返回空结果，后台队列补水，避免话题切换当轮裸奔
      ctx.logger?.debug?.('[assemble] O7: prefetch cache miss, background fill queued', {
        sessionKey: sessionKey.slice(0, 16),
        hasCache: !!cached,
        cacheAgeMs: cached ? Date.now() - cached.ts : -1,
      });
    }

    // O7+: 后台补水 —— 立即入队一次全量预取（走跨轮队列 + Ollama 槽位），不阻塞主轮。
    // 结果写回 prefetchCache，供紧随其后/后续轮消费；比"等本轮 afterTurn 预取、下一轮才
    // 用"的旧行为更快注入，消除话题切换当轮的 L2/L3 空窗。
    try {
      if (sessionKey && qmdQuery.trim().length > 0) {
        const deps = { logger: ctx.logger, qmdClient: ctx.qmdClient, graphAdapter: ctx.graphAdapter, expStore: ctx.expStore };
        const enqStatus = retrievalPrefetchQueue.enqueue({
          sessionKey,
          query: qmdQuery,
          run: (async () => {
            try {
              const now = Date.now();
              const res = await runRetrievalPrefetch(deps, sessionKey, qmdQuery, retrievalLimits);
              writePrefetchCache(ctx.prefetchCache, sessionKey, res, qmdQuery, now, ctx.logger);
            } catch (e) {
              ctx.logger?.debug?.('[assemble] O7: background prefetch run failed (non-fatal)', { err: (e as Error).message });
            }
          })(),
        });
        ctx.logger?.info?.('[assemble] O7: background prefetch enqueued', {
          sessionKey: sessionKey.slice(0, 16),
          status: enqStatus,
          query: qmdQuery.slice(0, 60),
        });
      }
    } catch (bgErr) {
      ctx.logger?.debug?.('[assemble] O7: background prefetch setup failed (non-fatal)', { err: String(bgErr) });
    }

    // v2.8.1 非MoA 修复: 保持异步(慢速 L2/L3 仍由 afterTurn 预取), 但保证不空结果 ——
    // cache miss 时用快速 L4 经验检索挡底(50-200ms, 带 800ms 超时), 避免模型在无任何
    // 上下文时反复"承诺再查"。MoA 场景有 reference 层兜底, 此处主要护住非 MoA 主模型。
    if (ctx.expStore) {
      try {
        const expStart = Date.now();
        // C-1: matchCount 时间衰减半衰期 —— 读用户配置（retrieval.expHalfLifeDays），
        // 未配置时用 DEFAULTS.retrieval.expHalfLifeDays，与 storage.ts searchByQuery 默认对齐。
        const expHalfLifeDays = ((ctx.api?.pluginConfig?.retrieval) as any)?.expHalfLifeDays
          ?? DEFAULTS.retrieval.expHalfLifeDays;
        const expRes = await Promise.race([
          ctx.expStore.searchByQuery({ query: qmdQuery, limit: retrievalLimits.exp, minScore: 0.3, halfLifeDays: expHalfLifeDays }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
        ]);
        l4_ms = Date.now() - expStart;
        if (Array.isArray(expRes) && expRes.length > 0) expResults = expRes;
      } catch { /* non-fatal */ }
    }

    // OpenClaw 官方记忆：本地 per-agent SQLite 同步快查（几 ms 级），cache miss 时兜底
    if (openclawResults.length === 0 && qmdQuery.trim().length > 0) {
      try {
        const { searchAgentMemory } = await import('../adapters/openclaw-agent-db.js');
        const memRes = searchAgentMemory(qmdQuery.slice(0, 300), { maxChunksPerAgent: 3 });
        if (Array.isArray(memRes) && memRes.length > 0) openclawResults = memRes;
      } catch { /* non-fatal */ }
    }
  }

  // 同步更新 RetrievalGateway.stats，确保 Dashboard 检索性能摘要反映真实数据
  const gw = ctx.retrievalGateway;
  ctx.logger?.info?.('[perf-stats] performRetrieval stats update check', {
    hasGateway: !!gw,
    hasStats: !!gw?.stats,
    l2_ms,
    l3_ms,
    l4_ms,
    qmdResults: rawQmd.length,
    graphResults: rawGraph.length,
    expResults: expResults.length,
  });
  if (gw?.stats) {
    if (l2_ms > 0) {
      const s = gw.stats.qmd;
      if (s) {
        s.searches++;
        s.totalDurationMs += l2_ms;
        if (l2_ms > s.maxDurationMs) s.maxDurationMs = l2_ms;
        s.lastQueryTime = l2_ms;
        if (rawQmd.length === 0) s.failures++;
      }
    }
    if (l3_ms > 0) {
      const s = gw.stats.graph;
      if (s) {
        s.searches++;
        s.totalDurationMs += l3_ms;
        if (l3_ms > s.maxDurationMs) s.maxDurationMs = l3_ms;
        s.lastQueryTime = l3_ms;
        if (rawGraph.length === 0) s.failures++;
      }
    }
    if (l4_ms > 0) {
      // L4 is distilled experience search; also update experience bucket for backward compat
      for (const key of ['experience', 'distilledExp'] as const) {
        const s = gw.stats[key];
        if (s) {
          s.searches++;
          s.totalDurationMs += l4_ms;
          if (l4_ms > s.maxDurationMs) s.maxDurationMs = l4_ms;
          s.lastQueryTime = l4_ms;
          if (expResults.length === 0) s.failures++;
        }
      }
    }
    ctx.logger?.info?.('[perf-stats] after update', {
      qmd: gw.stats.qmd,
      graph: gw.stats.graph,
      experience: gw.stats.experience,
      distilledExp: gw.stats.distilledExp,
    });
  } else {
    ctx.logger?.warn?.('[perf-stats] stats update skipped - no gateway or no stats', {
      hasGateway: !!gw,
      hasStats: !!gw?.stats,
    });
  }

  // H-6: 上下文预热
  if (tier === 'low' && expResults.length === 0) {
    const sk = typeof params.sessionKey === 'string' ? params.sessionKey : (typeof params.session_id === 'string' ? params.session_id : '');
    const warmup = ctx.sessionWarmupCache.get(sk);
    if (warmup && warmup.length > 0) {
      expResults = warmup;
      ctx.logger?.debug?.("[assemble] H-6: injected warmup experiences", { count: expResults.length });
      ctx.sessionWarmupCache.delete(sk);
    }
  }

  // S1-1: Merger for entity-level cross-engine dedup
  try {
    if (ctx.merger && Array.isArray(rawQmd) && Array.isArray(rawGraph)) {
      // 将 QMD 原始结果 (QmdSearchResult) 转换为 RetrievalResult 再传给 Merger
      // Merger 期望 RetrievalResult[] 有 id/content/source/type/score/metadata 字段
      const qmdRetrieval = rawQmd.map(toRetrievalResult);
      let merged = ctx.merger.merge(qmdRetrieval, rawGraph);

      // P0-1: LLM Rerank 异步化 — 当前轮使用 Merger 默认排序，LLM 结果写入 session 缓存供下一轮使用
      // 原 await ctx.merger.llmRerank 同步阻塞 3s 超时，改为 fire-and-forget
      if (tier === 'low' && tokenRatio < 0.25 && merged.length >= 3 && typeof ctx.merger.llmRerank === 'function') {
        const sessionKey = typeof params.sessionKey === 'string'
          ? params.sessionKey
          : typeof params.session_id === 'string'
            ? params.session_id
            : '';
        // 检查上一轮异步 Rerank 的结果
        if (sessionKey && ctx.llmRerankCache) {
          const cached = ctx.llmRerankCache.get(sessionKey);
          if (cached && cached.query === qmdQuery && cached.results.length > 0) {
            merged = cached.results;
            ctx.llmRerankCache.delete(sessionKey);
            ctx.logger?.debug?.("[P0-1] applied cached LLM rerank results", { sessionKey, count: merged.length });
          }
        }

        // 启动异步 Rerank（fire-and-forget），结果存入 session 缓存供下一轮使用
        if (sessionKey && ctx.llmRerankCache) {
          (async () => {
            try {
              const llmCfg = ctx.resolveDistillationLlm(ctx.api);
              if (!llmCfg?.model) return;
              const llmFn = async (prompt: string): Promise<string> => {
                const result = await callLlm({
                  baseURL: llmCfg!.baseURL,
                  apiKey: llmCfg!.apiKey,
                  model: llmCfg!.model,
                  prompt,
                  temperature: 0.1,
                  maxTokens: 256,
                  keepAlive: llmCfg!.keepAlive,
                  signal: AbortSignal.timeout(llmTimeout('rerankTimeoutMs')),
                });
                return result.text || '';
              };
              const reranked = await ctx.merger.llmRerank(merged, qmdQuery, llmFn);
              if (reranked.length > 0) {
                ctx.llmRerankCache.set(sessionKey, { query: qmdQuery, results: reranked, ts: Date.now() });
              }
            } catch (rerankErr) {
              ctx.logger?.debug?.("[P0-1] async LLM rerank failed (non-fatal)", { err: String(rerankErr) });
            }
          })().catch(() => { /* swallow unhandled */ });
        }
      }

      qmdResults = merged.filter((r: any) => r.source === 'qmd');
      graphResults = merged.filter((r: any) => r.source === 'graph');
    } else {
      qmdResults = rawQmd;
      graphResults = rawGraph;
    }
  } catch (mergeErr) {
    ctx.logger?.warn?.("Merger dedup failed, using raw results", { err: serializeError(mergeErr) });
    qmdResults = rawQmd;
    graphResults = rawGraph;
  }

  // ---- Phase 1: 实体相关度打分（一次计算，多处消费） ----
  // 架构根治（see docstring）：不再硬删结果，而是为每条结果统一计算一次 _entityScore，
  // 交由 injection L2/L3/L4 消费。检索是尽力而为，宁可给候选、按来源融合权重排序，
  // 也不做"词法硬删"——尤其是 graph 通道，其 score 已含 M/embedding 语义分，
  // 词法硬删会误丢 M 认为相关的节点（原 P0-7 全空回退的直接诱因）。
  const ENTITY_FILTER_THRESHOLD = 0.15; // 仅用于观测：低于该分视为"低实体命中"
  const attachEntityScore = (r: any, getContent: () => string, getName?: () => string | undefined): any => {
    if (!extractedEntities || extractedEntities.tokens.length === 0) {
      return { ...r, _entityScore: 1.0 };
    }
    const { score } = matchEntityScore(getContent(), extractedEntities, getName?.());
    return { ...r, _entityScore: score };
  };

  // QMD
  qmdResults = qmdResults.map((r: any) =>
    attachEntityScore(r, () => r.content ?? r.title ?? '', () => r.title),
  );
  // Graph：结构化实体名参与模糊相似度；语义相关由 graph 自身 score(M/embedding) 提供
  graphResults = graphResults.map((r: any) =>
    attachEntityScore(
      r,
      () => r.content ?? r.name ?? r.summary ?? r.id ?? '',
      () => r.name ?? r.title ?? r.subject ?? undefined,
    ),
  );
  // Experience
  expResults = expResults.map((e: any) =>
    attachEntityScore(e, () => e.experience?.summary ?? e.experience?.content ?? e.summary ?? ''),
  );
  // OpenClaw 官方记忆：同样以 Phase 1 实体做主题一致性软打分（不做硬删）
  openclawResults = openclawResults.map((r: any) =>
    attachEntityScore(r, () => r.text ?? r.path ?? '', () => r.path ?? undefined),
  );

  // 观测（S3）：统计低实体命中数，用于评估"信任 graph 语义分"的效果，不做过滤
  if (extractedEntities.tokens.length > 0) {
    const lowEntity = (arr: any[]) => arr.filter((r: any) => (r._entityScore ?? 1) < ENTITY_FILTER_THRESHOLD).length;
    const lowQmd = lowEntity(qmdResults);
    const lowGraph = lowEntity(graphResults);
    const lowExp = lowEntity(expResults);
    const lowMem = lowEntity(openclawResults);
    if (lowQmd > 0 || lowGraph > 0 || lowExp > 0 || lowMem > 0) {
      ctx.logger?.debug?.('[assemble] Phase 1: low-entity results kept (soft scoring, trust semantic source)', {
        qmd: { total: qmdResults.length, lowEntity: lowQmd },
        graph: { total: graphResults.length, lowEntity: lowGraph },
        exp: { total: expResults.length, lowEntity: lowExp },
        openclaw: { total: openclawResults.length, lowEntity: lowMem },
      });
    }
  } else {
    // P0-7 语义：仅当某来源检索结果**天然真空**（非被过滤清空）才回退到 raw 候选。
    // 经验无独立 raw 副本（expResults 即结果本身），且经验不再被过滤，无需回退。
    if (qmdResults.length === 0 && rawQmd.length > 0) qmdResults = rawQmd;
    if (graphResults.length === 0 && rawGraph.length > 0) graphResults = rawGraph;
  }

  const parallelMs = Date.now() - parallelStart;

  // P1-4: multiGet 与 cascade evaluation 并行化。
  // multiGet 只依赖 qmdResults，cascade 的重活（judgeRecall/Tier2/Tier3）是 fire-and-forget，
  // 本地 evaluateTier1 + thompsonRerank 很快。让 multiGet 先启动，cascade 本地部分并行执行，
  // 最后 await multiGet。原串行 multiGet(50-300ms) + cascade 本地(1-10ms) → 并行 max(300ms, 10ms)。
  const mgStart = Date.now();
  const topFiles = [...new Set(
    (qmdResults ?? []).slice(0, retrievalLimits.qmd).map((r: any) => r.file).filter(Boolean)
  )];

  // P1-4: multiGet 启动为 Promise，不立即 await
  const fullDocsPromise: Promise<string[]> = (async () => {
    if (topFiles.length === 0) return [];
    try {
      return await ctx.qmdClient.multiGet(topFiles.join(','));
    } catch {
      ctx.logger?.debug?.("assemble: qmd multiGet failed, returning empty");
      return [];
    }
  })();

  // ---- R-2 cascade evaluation (与 multiGet 并行) ----
  let cascadeConfidence = { tier1Score: 0.5, needsTier2: false, needsTier3: false, hasFactualClaim: false };
  try {
    const seenIds = new Set<string>();
    const deduped: any[] = [];
    const pushUnique = (arr: any) => {
      if (!Array.isArray(arr)) return;
      for (const r of arr) {
        const rid = r?.id ?? r?.metadata?.nodeId ?? r?.experience?.id;
        const key = rid ? `id:${rid}` : `obj:${(r?.content ?? r?.summary ?? '').slice(0, 60)}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        deduped.push(r);
      }
    };
    pushUnique(qmdResults);
    pushUnique(graphResults);
    pushUnique(expResults);
    const allResults = deduped;

    if (allResults.length > 0) {
      const confidence = ctx.cascadeManager.evaluateTier1(
        allResults.map((r: any) => ({
          score: r?.score ?? r?.pagerank,
          pagerank: r?.pagerank ?? r?.experience?.relevanceScore,
          matchCount: r?.matchCount ?? r?.experience?.matchCount,
          content: r?.content ?? r?.summary ?? r?.experience?.summary,
          type: r?.type ?? r?.experience?.type,
        })),
      );

      // P2-3: judgeRecall 改为 fire-and-forget 异步，不阻塞主路径。
      // 主路径直接使用 evaluateTier1 的本地 confidence；judgeRecall 结果异步反馈
      // 到 healthMetrics + cascade arms，影响下一轮 thompsonRerank。
      try {
        // P0-6: 已改为静态导入
        healthMetrics.recordCascadeConfidence(confidence.tier1Score ?? 0, 'local');
      } catch (e) { /* non-fatal */
        ctx.logger?.debug?.("recordCascadeConfidence failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }

      // P2-3: 原 judgeRecall 异步任务已移除 —— gm-pro 2.3.6 彻底删除了 judgeRecall API，
      // 对应的 L3 反馈闭环改由 v2.3.6 统一链路承担：
      //   afterTurn 预取 L3 时 recordRecall → agent_end 时 consumeAndProcessFeedback
      //   （JudgeManager 判定 → upsertFeedback → incrementFeedback → M 更新）
      // 此处不再重复录入 SessionRecallCache，避免与预取采集端重复记录。

      if (confidence.needsTier2 && tier === 'low') {
        const scenarioTag = scenarioAdjust?.scenario ?? 'default';
        const rerankedIds = ctx.cascadeManager.thompsonRerank(
          expResults.map((e: any) => ({
            id: e.experience?.id,
            matchCount: e.experience?.matchCount,
            score: e.score,
          })),
          scenarioTag,
        );
        const expById = new Map<string, any>();
        for (const e of expResults) {
          const eid = e?.experience?.id;
          if (eid && !expById.has(eid)) expById.set(eid, e);
        }
        expResults = rerankedIds
          .map((idx: any) => idx.id ? expById.get(idx.id) : undefined)
          .filter((e: any): e is typeof expResults[number] => Boolean(e)) as typeof expResults;

        ctx.logger?.debug?.("R-2 cascade: low confidence, Thompson rerank applied", {
          tier1Score: confidence.tier1Score.toFixed(3),
          needsTier3: confidence.needsTier3,
          hasFactual: confidence.hasFactualClaim,
        });

        // Async Tier 2
        const tier2Query = qmdQuery;
        const tier2Scenario = scenarioTag;
        const tier2Results = [...allResults].slice(0, 5);
        backgroundTasks.register('r2:tier2-llm', (async () => {
          try {
            const llm = ctx.resolveDistillationLlm(ctx.api);
            if (!llm?.model) return;
            const llmFn = async (prompt: string): Promise<string> => {
              const result = await callLlm({
                baseURL: llm.baseURL,
                apiKey: llm.apiKey,
                model: llm.model,
                prompt,
                temperature: 0.1,
                maxTokens: 256,
                keepAlive: llm.keepAlive,
                signal: AbortSignal.timeout(llmTimeout('judgeTimeoutMs')),
              });
              return result.text || '';
            };
            const judgments = await ctx.cascadeManager.evaluateTier2(tier2Query, tier2Results, llmFn);
            for (const j of judgments) {
              if (j.id) {
                const armKey = CascadeManager.makeArmKey(tier2Scenario, j.id);
                ctx.cascadeManager.recordFeedback(armKey, j.relevant);
              }
            }
            if (judgments.length > 0) {
              ctx.logger?.debug?.("R-2 Tier 2 LLM judgment completed", { judged: judgments.length, relevant: judgments.filter((j: any) => j.relevant).length });
            }
          } catch (e) { /* Tier 2 failed, non-fatal */
            ctx.logger?.debug?.("Tier 2 LLM judgment failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
          }
        })().then(() => {}, () => {}));

        // Async Tier 3
        if (confidence.needsTier3 && confidence.hasFactualClaim) {
          const tier3Query = qmdQuery;
          const tier3Results = [...allResults].slice(0, 5);
          backgroundTasks.register('r2:tier3-verify', (async () => {
            try {
              const verdicts = await ctx.cascadeManager.evaluateTier3(tier3Query, tier3Results, {
                searchFn: async (q: string) => {
                  try {
                    const searchResults = await ctx.graphAdapter?.search?.({ query: q, limit: 3 });
                    return searchResults?.nodes?.map((n: any) => n.content ?? n.name ?? '').join('\n') ?? '';
                  } catch { return ''; }
                },
              });
              for (const v of verdicts) {
                if (v.id) {
                  const armKey = CascadeManager.makeArmKey(scenarioTag, v.id);
                  ctx.cascadeManager.recordFeedback(armKey, v.verified);
                }
              }
              if (verdicts.length > 0) {
                ctx.logger?.debug?.("R-2 Tier 3 tool verification completed", {
                  verified: verdicts.filter((v: any) => v.verified).length,
                  total: verdicts.length,
                  methods: verdicts.map((v: any) => v.method),
                });
              }
            } catch (e) { /* Tier 3 failed, non-fatal */
              ctx.logger?.debug?.("Tier 3 verification failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
            }
          })().then(() => {}, () => {}));
        }
      }

      cascadeConfidence = confidence;
    }
  } catch (r2Err) {
    ctx.logger?.debug?.("R-2 cascade evaluation skipped", { err: String(r2Err) });
  }

  // P1-4: await multiGet Promise（cascade 本地部分已并行完成）
  let fullDocs: string[] = [];
  try {
    fullDocs = await fullDocsPromise;
  } catch {
    fullDocs = [];
  }
  const mgMs = Date.now() - mgStart;

  // O7+: 时间衰减 TOP-K —— 仅对缓存来源的结果应用（带 _retrAt，跨轮复用）。
  // 新鲜度加成让"新召回/刚更新"的结果在 TOP-K 竞争中胜过同分的陈旧历史条目，
  // 并把衰减分回写 score 供注入层（injection）感知，防止旧数据长期占高位。
  if (fromCache) {
    const decayNow = Date.now();
    const before = { qmd: qmdResults.length, graph: graphResults.length, exp: expResults.length, mem: openclawResults.length };
    qmdResults = decayTopK(qmdResults, retrievalLimits.qmd, decayNow, PREFETCH_TTL_MS);
    graphResults = decayTopK(graphResults, retrievalLimits.graph, decayNow, PREFETCH_TTL_MS);
    expResults = decayTopK(expResults, retrievalLimits.exp, decayNow, PREFETCH_TTL_MS);
    openclawResults = decayTopK(openclawResults, 3, decayNow, PREFETCH_TTL_MS);
    ctx.logger?.info?.('[assemble] O7: time-decay TOP-K applied (cache layer)', {
      sessionKey: sessionKey.slice(0, 16),
      before,
      after: {
        qmd: qmdResults.length, graph: graphResults.length, exp: expResults.length, mem: openclawResults.length,
      },
    });
  }

  return {
    qmdResults,
    graphResults,
    expResults,
    openclawResults,
    fullDocs,
    l2_ms,
    l3_ms,
    l4_ms,
    mgMs,
    scenario: scenarioAdjust.scenario ?? null,
    confidence: cascadeConfidence,
    tier: tier as any,
    retrievalLimits,
    tokenRatio,
    degradedReasons,
    estimatedTokens,
    contextWindow,
    effectiveTokenCount,
    overheadTokens,
    msgCount,
    uncompressedMsgs,
    initMs,
    parallelMs,
    hasGraphTool,
    hasExperienceTool,
    availableTools,
    qmdQuery,
    extractedEntities,
    queryRewriteResult,
  };
}