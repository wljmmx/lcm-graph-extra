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
import { llmTimeout } from '../config/defaults.js';
import { callLlm } from '../utils/llm-call.js';
import { CascadeManager } from '../cascade-manager.js';
import { backgroundTasks } from '../async/task-registry.js';
import { serializeError } from '../utils/logger.js';
// P0-6: 热路径 healthMetrics 静态导入
import { healthMetrics } from '../health-metrics.js';
import type { AssembleContext, RetrievalOutput } from './types.js';
import type { RetrievalResult } from '../types.js';

import { randomUUID } from 'node:crypto';
import { extractEntities, matchEntityScore } from '../entity-extract.js';
import { needsQueryRewrite, rewriteQuery } from './query-rewrite.js';

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

  // Extract query text from params.prompt (SDK field for retrieval queries), fallback to last message content
  const lastMsg = params.messages?.at(-1);
  let qmdQuery = typeof params.prompt === 'string' && params.prompt
    ? params.prompt
    : "";
  if (!qmdQuery && lastMsg?.content) {
    const c = lastMsg.content;
    if (typeof c === 'string') {
      qmdQuery = c;
    } else if (Array.isArray(c)) {
      const textPart = c.find((p: any) => p.type === "text");
      qmdQuery = textPart?.text ?? "";
    }
  }
  ctx.setLastRetrievalQuery(qmdQuery);

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

  // Session key for prefetch cache lookup
  const sessionKey = typeof params.sessionKey === 'string'
    ? params.sessionKey
    : typeof params.session_id === 'string'
      ? params.session_id
      : '';

  const PREFETCH_CACHE_TTL = 10 * 60 * 1000; // 10min
  const cached = sessionKey ? ctx.prefetchCache?.get(sessionKey) : undefined;
  const cacheHit = cached && (Date.now() - cached.ts < PREFETCH_CACHE_TTL);

  let rawQmd: any[] = [];
  let rawGraph: any[] = [];

  if (cacheHit && cached) {
    // 使用上一轮 afterTurn 预取的全量结果
    rawQmd = cached.qmdResults || [];
    rawGraph = cached.graphResults || [];
    expResults = cached.expResults || [];
    ctx.prefetchCache?.delete(sessionKey); // 消费后清除，避免重复使用

    ctx.logger?.info?.('[assemble] O7: using prefetch cache', {
      sessionKey: sessionKey.slice(0, 16),
      qmdCount: rawQmd.length,
      graphCount: rawGraph.length,
      expCount: expResults.length,
      cacheAgeMs: Date.now() - cached.ts,
      cachedQuery: cached.query?.slice(0, 60),
    });
  } else {
    // 首轮或缓存过期：返回空结果，afterTurn 预取后下一轮才有数据
    ctx.logger?.debug?.('[assemble] O7: prefetch cache miss, next turn will have data', {
      sessionKey: sessionKey.slice(0, 16),
      hasCache: !!cached,
      cacheAgeMs: cached ? Date.now() - cached.ts : -1,
    });
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

  // ---- Phase 1: 实体匹配过滤（三层主题锚定） ----
  // 对每层检索结果按实体匹配度过滤，过滤无关结果，保留高相关结果
  const ENTITY_FILTER_THRESHOLD = 0.15; // 至少匹配到 0.15 分才认为相关
  let filteredQmdCount = 0, filteredGraphCount = 0, filteredExpCount = 0;
  if (extractedEntities.tokens.length > 0) {
    // QMD: filter by content match
    const beforeCount = qmdResults.length;
    qmdResults = qmdResults.filter((r: any) => {
      const content = r.content ?? r.title ?? '';
      const { match, score } = matchEntityScore(content, extractedEntities);
      return match;
    });
    filteredQmdCount = beforeCount - qmdResults.length;

    // Graph: filter by content/matchCount
    const beforeGraphCount = graphResults.length;
    graphResults = graphResults.filter((r: any) => {
      const content = r.content ?? r.name ?? r.summary ?? r.id ?? '';
      const { match, score } = matchEntityScore(content, extractedEntities);
      return match;
    });
    filteredGraphCount = beforeGraphCount - graphResults.length;

    // Experience: filter by summary/tags
    const beforeExpCount = expResults.length;
    expResults = expResults.filter((e: any) => {
      const content = e.experience?.summary ?? e.experience?.content ?? e.summary ?? '';
      const { match, score } = matchEntityScore(content, extractedEntities);
      return match;
    });
    filteredExpCount = beforeExpCount - expResults.length;

    if (filteredQmdCount > 0 || filteredGraphCount > 0 || filteredExpCount > 0) {
      ctx.logger?.info?.('[assemble] Phase 1: entity-filtered irrelevant results', {
        qmd: { before: beforeCount, after: qmdResults.length, filtered: filteredQmdCount },
        graph: { before: beforeGraphCount, after: graphResults.length, filtered: filteredGraphCount },
        exp: { before: beforeExpCount, after: expResults.length, filtered: filteredExpCount },
      });
    }
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

  return {
    qmdResults,
    graphResults,
    expResults,
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
    filteredQmdCount,
    filteredGraphCount,
    filteredExpCount,
  };
}