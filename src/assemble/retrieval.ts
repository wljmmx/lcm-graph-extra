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
import { withCircuitBreaker } from '../circuit-breaker.js';
import { DEFAULTS, llmTimeout } from '../config/defaults.js';
import { hasSelfCategory } from '../plugin/tool-guidance.js';
import { withKeepAliveIfOllama } from '../utils/url.js';
import { CascadeManager } from '../cascade-manager.js';
import { backgroundTasks } from '../async/task-registry.js';
import { serializeError } from '../utils/logger.js';
// P0-6: 热路径 healthMetrics 静态导入
import { healthMetrics } from '../health-metrics.js';
import type { AssembleContext, RetrievalOutput } from './types.js';

/** P2-1: L2/L4 检索结果缓存 TTL（与 L3 searchWithCache 5min 一致） */
const QUERY_CACHE_TTL_MS = 300 * 1000;
/** P2-1: L2/L4 缓存 LRU 容量上限 */
const QUERY_CACHE_MAX = 50;

/** P2-1: 简单字符串 hash（djb2 变体），用于缓存 key */
function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
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

  // ---- Parallel Phase 1: L2 + L3 + L4 all fire together (with per-layer timing) ----
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

  try {
    const results = await Promise.all([
      // L2: qmd search
      (async () => {
        const t0 = Date.now();
        try {
          if (!qmdQuery) return { results: [], ms: 0 };
          // P2-1: L2 检索结果缓存 —— 同 query+limit 短期复用
          const l2CacheKey = `l2:${hashKey(qmdQuery.toLowerCase().trim())}:${retrievalLimits.qmd}`;
          const l2Cached = ctx.l2QueryCache.get(l2CacheKey);
          if (l2Cached && Date.now() - l2Cached.ts < QUERY_CACHE_TTL_MS) {
            return { results: l2Cached.results, ms: Date.now() - t0 };
          }
          const res = await withCircuitBreaker("qmd", "L2 qmdClient.query", () => ctx.qmdClient.query({
            searches: [
              { type: "lex", query: qmdQuery },
              { type: "vec", query: qmdQuery }
            ],
            limit: retrievalLimits.qmd,
            rerank: true
          }));
          // P2-1: 写入缓存（LRU 上限保护）
          if (ctx.l2QueryCache.size >= QUERY_CACHE_MAX) {
            const oldest = ctx.l2QueryCache.keys().next().value;
            if (oldest !== undefined) ctx.l2QueryCache.delete(oldest);
          }
          ctx.l2QueryCache.set(l2CacheKey, { results: res as any[], ts: Date.now() });
          return { results: res, ms: Date.now() - t0 };
        } catch (e) {
          const _l2e = e as Error; const _l2m = _l2e.message;
          if (_l2m.includes("circuit breaker")) {
            ctx.logger?.warn?.("L2 qmd: circuit breaker OPEN, skipping", { err: _l2m });
            markDegraded("L2_circuit_breaker");
          } else if (_l2m.includes("MCP HTTP")) {
            ctx.logger?.warn?.("L2 qmd: MCP service error (" + _l2m + "), falling back to CLI");
            markDegraded("L2_mcp_http_error");
          } else if (_l2m.includes("empty response")) {
            ctx.logger?.warn?.("L2 qmd: MCP returned empty result, falling back to CLI");
            markDegraded("L2_mcp_empty");
          } else if (_l2m.includes("CLI output")) {
            ctx.logger?.warn?.("L2 qmd: CLI fallback also failed (" + _l2m + ")");
            markDegraded("L2_cli_failed");
          } else {
            ctx.logger?.warn?.("L2 qmd: error - " + _l2m);
            markDegraded("L2_unknown_error");
          }
          return { results: [], ms: Date.now() - t0 };
        }
      })(),
      // L3: Neo4j knowledge graph
      (async () => {
        const t0 = Date.now();
        try {
          const selfHasGraph = hasSelfCategory("graph");
          if (!selfHasGraph) {
            ctx.logger?.debug?.("[lcm-graph-extra] L3 graph search skipped (no graph tool)");
            return { results: [], ms: 0 };
          }
          const res = await withCircuitBreaker("neo4j", "L3 graphAdapter.search", () => ctx.graphAdapter.searchWithCache(qmdQuery, retrievalLimits.graph));
          return { results: res, ms: Date.now() - t0 };
        } catch (e) {
          ctx.logger?.warn?.("L3 graph search failed", { err: (e as Error).message });
          markDegraded("L3_graph_search_failed");
          return { results: [], ms: Date.now() - t0 };
        }
      })(),
      // L4: Experience search
      (async () => {
        const t0 = Date.now();
        try {
          const selfHasExp = hasSelfCategory("experience");
          if (!selfHasExp) {
            ctx.logger?.debug?.("[lcm-graph-extra] L4 experience search skipped (no experience tool)");
            return { results: [], ms: 0 };
          }
          if (retrievalLimits.exp === 0) return { results: [], ms: 0 };
          const expProjects: string[] = (() => {
            try {
              const found = new Set<string>();
              const pathRe = /(?:^|[\s(,.;:!?'"\[])([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9._-]+)+)/g;
              let m: RegExpExecArray | null;
              while ((m = pathRe.exec(qmdQuery)) !== null) {
                const parts = m[1].split('/').filter(Boolean);
                if (parts.length >= 2) {
                  if (parts[0].startsWith('@')) found.add(parts[0] + '/' + parts[1]);
                  else found.add(parts[0]);
                }
              }
              const stops = new Set(['src','lib','dist','build','test','tests','node_modules','public','assets','components','pages','app','apps','packages','config','scripts','utils','hooks','api','docs','styles']);
              return [...found].map(s => s.toLowerCase()).filter(s => !stops.has(s) && s.length >= 2).slice(0, 5);
            } catch { return []; }
          })();
          // R-5: 根据上一轮输出质量动态调整 expMinScore（提取到 withCircuitBreaker 外，供 P2-1 缓存 key 使用）
          let adjustedMinScore = DEFAULTS.retrieval.expMinScore;
          const sk = typeof params.sessionKey === 'string'
            ? params.sessionKey
            : typeof params.session_id === 'string'
              ? params.session_id
              : '';
          if (sk && ctx.sessionQualityScores) {
            const lastScore = ctx.sessionQualityScores.get(sk);
            if (lastScore != null) {
              if (lastScore < 0.3) {
                adjustedMinScore += 0.2; // 严重低质量 → 大幅提高门槛
              } else if (lastScore < 0.5) {
                adjustedMinScore += 0.1; // 低质量 → 提高门槛
              }
              // lastScore >= 0.5 → 保持默认
              ctx.logger?.debug?.("[assemble] R-5 quality-adjusted expMinScore", {
                original: DEFAULTS.retrieval.expMinScore,
                adjusted: adjustedMinScore,
                lastQualityScore: lastScore,
              });
            }
          }
          // P2-1: L4 检索结果缓存 —— 同 query+projects+minScore+limit 短期复用
          const l4CacheKey = `l4:${hashKey(qmdQuery.toLowerCase().trim())}:${hashKey(expProjects.join(','))}:${adjustedMinScore.toFixed(3)}:${retrievalLimits.exp}`;
          const l4Cached = ctx.l4QueryCache.get(l4CacheKey);
          if (l4Cached && Date.now() - l4Cached.ts < QUERY_CACHE_TTL_MS) {
            return { results: l4Cached.results, ms: Date.now() - t0 };
          }
          const res = await withCircuitBreaker("neo4j", "L4 expStore.search", () => {
            return ctx.expStore.searchByQuery({
              query: qmdQuery,
              projects: expProjects,
              minScore: adjustedMinScore,
              limit: retrievalLimits.exp,
            });
          });
          // P2-1: 写入缓存（LRU 上限保护）
          if (ctx.l4QueryCache.size >= QUERY_CACHE_MAX) {
            const oldest = ctx.l4QueryCache.keys().next().value;
            if (oldest !== undefined) ctx.l4QueryCache.delete(oldest);
          }
          ctx.l4QueryCache.set(l4CacheKey, { results: res as any[], ts: Date.now() });
          return { results: res, ms: Date.now() - t0 };
        } catch (e) {
          ctx.logger?.warn?.("L4 experience search failed", { err: (e as Error).message });
          markDegraded("L4_experience_search_failed");
          return { results: [], ms: Date.now() - t0 };
        }
      })(),
    ]);

    const l2 = results[0];
    const l3 = results[1];
    const l4 = results[2];
    l2_ms = typeof l2?.ms === "number" ? l2.ms : 0;
    l3_ms = typeof l3?.ms === "number" ? l3.ms : 0;
    l4_ms = typeof l4?.ms === "number" ? l4.ms : 0;

    const rawQmd = Array.isArray(l2?.results) ? l2.results : [];
    const rawGraph = Array.isArray(l3?.results) ? l3.results : [];
    expResults = Array.isArray(l4?.results) ? l4.results : [];

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
        let merged = ctx.merger.merge(rawQmd, rawGraph);

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
                  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                  if (llmCfg!.apiKey) headers['Authorization'] = 'Bearer ' + llmCfg!.apiKey;
                  const body = withKeepAliveIfOllama(
                    llmCfg!.baseURL,
                    { model: llmCfg!.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 256 },
                    llmCfg!.keepAlive,
                  );
                  const resp = await fetch(llmCfg!.baseURL + '/chat/completions', {
                    method: 'POST', headers,
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(llmTimeout('rerankTimeoutMs')),
                  });
                  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
                  const data: any = await resp.json();
                  return data?.choices?.[0]?.message?.content || '';
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
  } catch (e) {
    ctx.logger?.warn?.("Parallel L2/L3/L4 phase failed", { err: (e as Error).message });
    markDegraded("parallel_phase_failed");
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

      const r2JudgeQuery = qmdQuery;
      const r2JudgeNodeIds = allResults.map((r: any) => r?.id ?? r?.experience?.id).filter(Boolean);
      const r2JudgeScenario = scenarioAdjust?.scenario;
      backgroundTasks.register('r2:judgeRecall', (async () => {
        try {
          const { withGmProFallback } = await import('../adapters/gm-pro-fallback.js');
          const judgeResult = await withGmProFallback(
            'judgeRecall',
            async (mod) => {
              return await mod.judgeRecall({
                query: r2JudgeQuery,
                recalledNodeIds: r2JudgeNodeIds,
                scenario: r2JudgeScenario,
              });
            },
            async () => null,
            { logger: ctx.logger, label: 'R-2 judgeRecall (async)' },
          );
          if (judgeResult && typeof judgeResult.tier1Confidence === 'number') {
            try {
              // P0-6: 已改为静态导入
              healthMetrics.recordCascadeConfidence(judgeResult.tier1Confidence, 'gm-pro');
            } catch { /* non-fatal */ }
            // 反馈到 cascade arms（gm-pro 高置信 → 正反馈，影响下一轮采样）
            if (judgeResult.tier1Confidence >= 0.7) {
              for (const nid of r2JudgeNodeIds) {
                ctx.cascadeManager.recordFeedback(
                  CascadeManager.makeArmKey(r2JudgeScenario ?? 'default', nid),
                  true,
                );
              }
            }
          }
        } catch (r2JudgeErr) {
          ctx.logger?.debug?.("R-2 judgeRecall async failed (non-fatal)", { err: String(r2JudgeErr) });
        }
      })().then(() => {}, () => {}));

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
              const headers: Record<string, string> = { 'Content-Type': 'application/json' };
              if (llm.apiKey) headers['Authorization'] = 'Bearer ' + llm.apiKey;
              const body = withKeepAliveIfOllama(
                llm.baseURL,
                { model: llm.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 256 },
                llm.keepAlive,
              );
              const resp = await fetch(llm.baseURL + '/chat/completions', {
                method: 'POST', headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(llmTimeout('judgeTimeoutMs')),
              });
              if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
              const data: any = await resp.json();
              return data?.choices?.[0]?.message?.content || '';
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
  };
}