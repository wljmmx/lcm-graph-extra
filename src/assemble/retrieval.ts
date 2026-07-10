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
import { DEFAULTS } from '../config/defaults.js';
import { hasSelfCategory } from '../plugin/tool-guidance.js';
import { withKeepAliveIfOllama } from '../utils/url.js';
import { CascadeManager } from '../cascade-manager.js';
import { backgroundTasks } from '../async/task-registry.js';
import { serializeError } from '../utils/logger.js';
import type { AssembleContext, RetrievalOutput } from './types.js';

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
          const res = await withCircuitBreaker("qmd", "L2 qmdClient.query", () => ctx.qmdClient.query({
            searches: [
              { type: "lex", query: qmdQuery },
              { type: "vec", query: qmdQuery }
            ],
            limit: retrievalLimits.qmd,
            rerank: true
          }));
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
          const res = await withCircuitBreaker("neo4j", "L4 expStore.search", () => {
            // R-5: 根据上一轮输出质量动态调整 expMinScore
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
            return ctx.expStore.searchByQuery({
              query: qmdQuery,
              projects: expProjects,
              minScore: adjustedMinScore,
              limit: retrievalLimits.exp,
            });
          });
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

        if (tier === 'low' && tokenRatio < 0.25 && merged.length >= 3 && typeof ctx.merger.llmRerank === 'function') {
          try {
            const llmCfg = ctx.resolveDistillationLlm(ctx.api);
            if (llmCfg?.model) {
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
                  signal: AbortSignal.timeout(DEFAULTS.llm.rerankTimeoutMs),
                });
                if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
                const data: any = await resp.json();
                return data?.choices?.[0]?.message?.content || '';
              };
              const reranked = await ctx.merger.llmRerank(merged, qmdQuery, llmFn);
              if (reranked.length > 0) merged = reranked;
            }
          } catch (rerankErr) {
            ctx.logger?.debug?.("Merger LLM rerank skipped/failed, using entity sort", { err: String(rerankErr) });
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

  // ---- Parallel Phase 2: multiGet ----
  const mgStart = Date.now();
  const topFiles = [...new Set(
    (qmdResults ?? []).slice(0, retrievalLimits.qmd).map((r: any) => r.file).filter(Boolean)
  )];

  let fullDocs: string[] = [];
  if (topFiles.length > 0) {
    try {
      fullDocs = await ctx.qmdClient.multiGet(topFiles.join(','));
    } catch {
      ctx.logger?.debug?.("assemble: qmd multiGet failed, returning empty");
      fullDocs = [];
    }
  }
  const mgMs = Date.now() - mgStart;

  // ---- R-2 cascade evaluation ----
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

      let r2JudgeSource: 'gm-pro' | 'local' = 'local';
      try {
        const { withGmProFallback } = await import('../adapters/gm-pro-fallback.js');
        const judgeResult = await withGmProFallback(
          'judgeRecall',
          async (mod) => {
            return await mod.judgeRecall({
              query: qmdQuery,
              recalledNodeIds: allResults.map((r: any) => r?.id ?? r?.experience?.id).filter(Boolean),
              scenario: scenarioAdjust?.scenario,
            });
          },
          async () => null,
          { logger: ctx.logger, label: 'R-2 judgeRecall' },
        );
        if (judgeResult && typeof judgeResult.tier1Confidence === 'number') {
          confidence.tier1Score = judgeResult.tier1Confidence;
          confidence.needsTier2 = judgeResult.tier1Confidence < 0.7;
          r2JudgeSource = 'gm-pro';
        }
      } catch (r2JudgeErr) {
        ctx.logger?.debug?.("R-2 judgeRecall fallback to local evaluateTier1", { err: String(r2JudgeErr) });
      }

      try {
        const { healthMetrics } = await import('../health-metrics.js');
        healthMetrics.recordCascadeConfidence(confidence.tier1Score ?? 0, r2JudgeSource);
      } catch (e) { /* non-fatal */
        ctx.logger?.debug?.("recordCascadeConfidence failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }

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
                signal: AbortSignal.timeout(DEFAULTS.llm.judgeTimeoutMs),
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