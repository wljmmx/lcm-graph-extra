/**
 * afterTurn 主入口。
 *
 * 组合 quality / experience 子模块，实现完整的 afterTurn 生命周期。
 */

import { backgroundTasks } from '../async/task-registry.js';
// O7+: 跨轮预取队列 + 共享拉取/覆盖合并/时间衰减辅助
import { retrievalPrefetchQueue } from '../async/retrieval-prefetch-queue.js';
import { runRetrievalPrefetch, writePrefetchCache } from '../assemble/retrieval-prefetch.js';
import { extractTopKeywords } from '../plugin/keywords.js';
import { llmTimeout } from '../config/defaults.js';
import { callLlm } from '../utils/llm-call.js';
import { compressToolResultsAsync } from './tool-result-compressor.js';
import { serializeError } from '../utils/logger.js';
import { shouldUpdateGoal, getGoal } from '../plugin/goal-cache.js';
import { resolveSessionCacheKey } from '../utils/session-key.js';
import { evaluateOutputQuality } from './quality.js';
import { extractTriplets, extractExperiences } from './experience.js';
import type { AfterTurnContext } from './types.js';

/**
 * 判断某个会话是否应参与在线学习（关联矩阵 M 的 processFeedback）。
 * 定时任务（cron）、心跳、系统级会话不应喂入反馈闭环，否则会用无真实用户意图的
 * 批量召回污染 M 矩阵（学到垃圾关联）。仅真实用户对话参与学习。
 */
export function isLearningEligibleSession(sessionKey: string): boolean {
  if (!sessionKey) return false;
  if (
    sessionKey.includes(':cron:') ||
    sessionKey.includes('agent:main:cron') ||
    /heartbeat/i.test(sessionKey) ||
    /(^|:)system($|:)/i.test(sessionKey) ||
    /(^|:)auto($|:)/i.test(sessionKey)
  ) {
    return false;
  }
  return true;
}

export async function afterTurn(ctx: AfterTurnContext, params: any): Promise<void> {
  const afterTurnStart = Date.now();

  // AbortSignal support - early exit if cancelled
  const signal = (params as any).abortSignal || (params as any).signal;
  if (signal?.aborted) {
    return;
  }

  // === Auto-bootstrap ===
  if (ctx.losslessClawAdapter?.ensureBootstrapped) {
    try {
      await ctx.losslessClawAdapter.ensureBootstrapped(params);
      ctx.logger?.debug?.('[lcm-graph-extra] auto-bootstrap ensured for conversation');
    } catch (e: any) {
      ctx.logger?.warn?.('[lcm-graph-extra] auto-bootstrap failed, continuing afterTurn anyway', { err: e.message });
    }
  }

  try {
    await ctx.losslessClawAdapter?.afterTurn?.({
      ...params,
      prePromptMessageCount: params.prePromptMessageCount ?? 0,
    });
  } catch (e) { /* non-fatal */
    ctx.logger?.debug?.("lossless-claw afterTurn failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
  }
  // lossless-claw afterTurn completed

  // 异步压缩本轮新增的工具结果（下一轮 assemble 生效）
  try {
    const _compressSessionKey = typeof params.sessionKey === 'string'
      ? params.sessionKey
      : typeof params.session_id === 'string' ? params.session_id : '';
    if (_compressSessionKey && (params.messages?.length ?? 0) > 0) {
      compressToolResultsAsync({
        messages: params.messages,
        prePromptMessageCount: params.prePromptMessageCount ?? 0,
        sessionKey: _compressSessionKey,
        logger: ctx.logger,
      });
    }
  } catch (e) { ctx.logger?.debug?.("[afterTurn] compressToolResultsAsync failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) }); }

  try {
    // Split messages into prior (history) and recent (this turn)
    const splitIdx = params.prePromptMessageCount ?? 0;
    const allMsgs = params.messages ?? [];
    const priorMessages = splitIdx > 0 ? allMsgs.slice(0, splitIdx) : allMsgs;
    const recentMessages = splitIdx > 0 ? allMsgs.slice(splitIdx) : [];
    const msgs = allMsgs;
    if (msgs.length < 2) return;

    let userContent = '', assistantContent = '';
    const extractText = (c: any): string => {
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((item: any) => typeof item === 'string' ? item : (item?.text ?? JSON.stringify(item))).join('');
      return JSON.stringify(c);
    };

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const role = m.role ?? '';
      if (!userContent && role === 'user') {
        userContent = extractText(m.content);
      } else if (!assistantContent && role === 'assistant') {
        assistantContent = extractText(m.content);
      }
      if (userContent && assistantContent) break;
    }

    const qualityFilterMs = Date.now() - afterTurnStart;
    const autoSummary = params.autoCompactionSummary;
    if (autoSummary) {
      ctx.logger?.debug?.(`[afterTurn] using autoCompactionSummary (${autoSummary.length} chars) for enrichment`);
    }
    if (!userContent?.trim() || userContent.length < (autoSummary ? 20 : 50)) {
      ctx.logger?.debug?.(`[afterTurn] skipped (user content too short, ${qualityFilterMs}ms total)`);
      return;
    }
    if (!assistantContent?.trim() || assistantContent.length < 30) {
      ctx.logger?.debug?.(`[afterTurn] skipped (assistant content too short, ${qualityFilterMs}ms total)`);
      return;
    }

    // H-5: 模型输出质量自动评估
    try {
      const qualityMetrics = evaluateOutputQuality(
        assistantContent,
        null,
        '',
      );
      ctx.logger?.debug?.("[afterTurn] H-5 output quality", {
        overallScore: qualityMetrics.overallScore,
        outputLengthOk: qualityMetrics.outputLengthOk,
        isRepetitive: qualityMetrics.isRepetitive,
        referencesUsed: qualityMetrics.referencesUsed,
        referencesAvailable: qualityMetrics.referencesAvailable,
      });
      if (qualityMetrics.isRepetitive) {
        ctx.logger?.warn?.("[afterTurn] H-5 repetitive output detected");
      }
      // R-5: 存储质量评分，供下一轮 assemble 调整检索策略
      if (ctx.sessionQualityScores) {
        const sk = typeof params.sessionKey === 'string'
          ? params.sessionKey
          : typeof params.session_id === 'string'
            ? params.session_id
            : '';
        if (sk) ctx.sessionQualityScores.set(sk, qualityMetrics.overallScore);
      }
    } catch (e) { ctx.logger?.debug?.("[afterTurn] quality metrics computation failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) }); }

    // ==================================================================
    // v2.3.6 链路 2（agent_end 自动反馈采集 → 反馈闭环）
    //
    // 对应 gm-pro 方案 A 的 agent_end 钩子：consume 上一轮预取时录入的 L3 召回节点，
    // 用本轮 assistant 回复作为判定依据，调 processFeedback 完成
    //   JudgeManager 判定 → upsertFeedback → incrementFeedback → updateAssociationMatrix(M 更新)
    //
    // 时序说明：
    //   - afterTurn(N-1) 预取 L3 时 recordRecall(sessionKey, ...)   ← 采集
    //   - assemble(N) 使用预取结果注入上下文                            ← 使用
    //   - afterTurn(N) 此处 consume(sessionKey) → processFeedback    ← 消费
    // 全程 fire-and-forget，不阻塞会话；无召回/无回复则跳过。
    // ==================================================================
    if (ctx.graphAdapter?.consumeAndProcessFeedback && ctx.graphAdapter?.mod?.getSessionRecallCache) {
      const fbSessionKey = typeof params.sessionKey === 'string'
        ? params.sessionKey
        : typeof params.session_id === 'string'
          ? params.session_id
          : '';
      const fbSessionId = typeof params.sessionId === 'string' ? params.sessionId : fbSessionKey;
      // 仅真实用户对话参与在线学习，定时任务(cron)/心跳/系统会话不喂入 processFeedback，
      // 避免无真实意图的批量召回污染关联矩阵 M。
      if (fbSessionKey && isLearningEligibleSession(fbSessionKey) && assistantContent?.trim()) {
        (async () => {
          try {
            await ctx.graphAdapter.consumeAndProcessFeedback(fbSessionKey, assistantContent, fbSessionId);
          } catch (fbErr) {
            ctx.logger?.debug?.('[afterTurn] v2.3.6 feedback loop skipped (non-fatal)', { err: fbErr instanceof Error ? fbErr.message : String(fbErr) });
          }
        })().catch(() => { /* swallow unhandled */ });
      }
    }

    // S-7': 用户画像
    try {
      ctx.userProfile.observe(userContent);
    } catch (e) { /* non-fatal */
      ctx.logger?.debug?.("userProfile.observe failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }

    // "有意义字符"占比过滤：排除纯标点/emoji/符号的垃圾内容。
    // 原实现仅统计 ASCII 词 (\w)，对纯中文内容占比恒为 0，导致 afterTurn 在
    // triplet/experience/O7 预取 L2-L4 等 enrichment 之前提前 return，整条链路静默无日志。
    // 改用 Unicode 字母(\p{L}，含 CJK) + 数字(\p{N}) 统计，中文查询可正常通过。
    const meaningfulChars = userContent.match(/[\p{L}\p{N}]/gu) || [];
    const contentLen = userContent.trim().length;
    const wordRatio = contentLen > 0 ? meaningfulChars.length / contentLen : 0;
    if (wordRatio < 0.3) return;

    // Triplet extraction
    await extractTriplets(ctx, userContent, assistantContent, autoSummary, params);

    // Experience extraction pipeline
    extractExperiences(ctx, recentMessages, priorMessages, msgs, params);

    // G-8: LLM 异步验证回路
    {
      // FIX-SK2: 与写入侧（assemble/injection.ts 用 resolveSessionCacheKey，sessionId 优先）统一。
      // 修复前：此处取 raw sessionKey，写入侧取 sessionId → G-8 验证回路永远读不到
      // 本轮 assemble 写入的经验 ID 列表，异步质量验证形同虚设。
      const g8SessionKey = resolveSessionCacheKey(params) || 'default';
      const LAST_EXP_MAP_TTL_MS = 30 * 60 * 1000;
      const cached = ctx.lastAssembleExpIdsBySession.get(g8SessionKey);
      const lastAssembleExpIds = (cached && (Date.now() - cached.ts < LAST_EXP_MAP_TTL_MS)) ? cached.ids : [];
      if (cached && lastAssembleExpIds.length === 0) {
        ctx.lastAssembleExpIdsBySession.delete(g8SessionKey);
      }
      if (lastAssembleExpIds.length > 0) {
        const expIdsToValidate = [...lastAssembleExpIds];
        ctx.lastAssembleExpIdsBySession.delete(g8SessionKey);
        backgroundTasks.register('afterturn:g8-validate', (async () => {
          try {
            const store = ctx.expStore;
            if (!store) return;
            const llm = ctx.resolveDistillationLlm(ctx.api);
            if (!llm?.model) return;

            // P0-2: 改为 Promise.all 并行验证，避免串行 LLM 调用（最坏 3 × 8s = 24s → ~8s）
            const validateOne = async (exp: { id: string; query: string; summary: string }) => {
              try {
                const prompt = `Rate the relevance of this experience to the user's query on a scale of 0 to 1.\nQuery: "${exp.query.slice(0, 500)}"\nExperience: "${exp.summary.slice(0, 300)}"\nReturn ONLY a number between 0 and 1 (e.g., 0.8). 1 means highly relevant, 0 means completely irrelevant.`;
                const result = await callLlm({
                  baseURL: llm.baseURL,
                  apiKey: llm.apiKey,
                  model: llm.model,
                  prompt,
                  temperature: 0.1,
                  maxTokens: 10,
                  keepAlive: llm.keepAlive,
                  signal: AbortSignal.timeout(llmTimeout('validateTimeoutMs')),
                });
                const text = result.text?.trim() || '';
                const score = parseFloat(text);
                if (isNaN(score) || score < 0 || score > 1) return;

                const delta = score >= 0.5 ? 0.05 : -0.05;
                try {
                  // v2.3.2 compat: graph-memory-pro 的 upsertFeedback 签名已变更为
                  // (driver, GmFeedback)，与旧版 {nodeId, query, relevant, score, delta} 不兼容。
                  // 改用本地 store.updateQualityScore 直接持久化，避免静默错误。
                  await store.updateQualityScore(exp.id, score, delta, 'local');
                } catch {
                  await store.updateQualityScore(exp.id, score, delta);
                }
                ctx.logger?.debug?.("G-8 quality validation", { id: exp.id, score, delta });
              } catch (e) { /* skip individual validation */
                ctx.logger?.debug?.("G-8 quality validation skipped (non-fatal)", { id: exp.id, err: e instanceof Error ? e.message : String(e) });
              }
            };
            // 并行验证最多 3 条经验
            await Promise.all(expIdsToValidate.slice(0, 3).map(validateOne));
          } catch (g8Err) {
            ctx.logger?.debug?.("[afterTurn] G-8 validation loop skipped", { err: String(g8Err) });
          }
        })());
      }
    }

    // S-9': 情节缓冲扩展 —— 语义边界检测 → 触发 compact
    try {
      const _sessionId = params.sessionId ?? params.session_id ?? '';
      if (_sessionId && ctx.losslessClawAdapter?.connected && typeof ctx.losslessClawAdapter.compact === 'function') {
        const allMsgs = params.messages ?? [];
        const preCount = params.prePromptMessageCount ?? 0;
        const uncompressedCount = allMsgs.length - preCount;
        const MIN_EPISODE_MSGS = 12;
        const TOPIC_SHIFT_THRESHOLD = 0.35;

        if (uncompressedCount >= MIN_EPISODE_MSGS) {
          const recentKeywords = extractTopKeywords(
            allMsgs.slice(-Math.floor(uncompressedCount * 0.3)),
            15,
          );
          const priorKeywords = extractTopKeywords(
            allMsgs.slice(preCount, preCount + Math.floor(uncompressedCount * 0.3)),
            15,
          );
          if (recentKeywords.length >= 5 && priorKeywords.length >= 5) {
            const intersection = recentKeywords.filter((k) => priorKeywords.includes(k));
            const union = new Set([...recentKeywords, ...priorKeywords]);
            const jaccard = union.size > 0 ? intersection.length / union.size : 1;
            if (jaccard < TOPIC_SHIFT_THRESHOLD) {
              ctx.logger?.info?.("[afterTurn] S-9 topic shift detected, triggering async compact", {
                jaccard: jaccard.toFixed(3),
                recentTop: recentKeywords.slice(0, 5),
                priorTop: priorKeywords.slice(0, 5),
                uncompressedCount,
              });
              const sk = typeof params.sessionKey === 'string' ? params.sessionKey : '';
              backgroundTasks.register('afterturn:s9-topic-shift', (async () => {
                try {
                  const { withGmProFallback } = await import("../adapters/gm-pro-fallback.js");
                  const consolidated = await withGmProFallback<string[] | null>(
                    'consolidateBuffer',
                    async (mod) => {
                      const bufferNodes = allMsgs
                        .slice(preCount)
                        .map((m: any, i: number) => ({
                          id: `buf_${_sessionId}_${i}`,
                          type: 'EPISODE',
                          name: (m.content ?? '').slice(0, 100),
                          description: '',
                          content: m.content ?? '',
                        }));
                      // 上游 v2.4.2 签名：consolidateBuffer(nodes: GmNode[]) => Promise<string[]>
                      return await mod.consolidateBuffer(bufferNodes);
                    },
                    async () => null,
                    { label: 'S-9 consolidateBuffer' },
                  );
                  if (!consolidated?.length) {
                    // 本地主模型时，LosslessClawAdapter.compact 内部会统一注入本地 llm.complete
                    await ctx.losslessClawAdapter.compact({
                      sessionId: _sessionId,
                      sessionKey: sk,
                      sessionFile: typeof params.sessionFile === 'string' ? params.sessionFile : '',
                      force: false,
                    });
                  }
                } catch {
                  await ctx.losslessClawAdapter.compact({
                    sessionId: _sessionId,
                    sessionKey: sk,
                    sessionFile: typeof params.sessionFile === 'string' ? params.sessionFile : '',
                    force: false,
                  });
                }
              })());
            }
          }
        }
      }
    } catch (topicErr) {
      ctx.logger?.debug?.("[afterTurn] S-9 topic shift detection skipped", { err: String(topicErr) });
    }

    // Track response tokens
    try {
      const model = params.model ?? "unknown";
      const sessionId = params.sessionId ?? params.session_id ?? "unknown";
      if (assistantContent) {
        ctx.tracker?.onResponseReceived?.(sessionId, model, Math.ceil(assistantContent.length / 4), "completed", Date.now() - afterTurnStart);
      }
    } catch (e) {
      ctx.logger?.debug?.("tracker.onResponseReceived failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }

    // ==================================================================
    // v2.8.0 O7 + O7+: 全量检索预取 — L2/L3/L4 + 官方记忆
    // O7 原设计：当前轮永远只使用上一轮预取的结果。
    // O7+ 升级：改为跨轮预取队列——按 sessionKey+查询相似度合并去重，有界并发执行，
    //      结果覆盖式合并（保留 TTL + 时间衰减 TOP-K）写回缓存，跨轮复用。
    //      不再"每次 afterTurn 盲跑整套 L2/L3"；查询未变的轮直接命中队列，减少重复检索、
    //      避免占满 Ollama 槽位、消除异步期间的时序卡点。
    // ==================================================================
    if (ctx.prefetchCache && userContent) {
      try {
        const sessionKey = resolveSessionCacheKey(params);

        if (!sessionKey) {
          ctx.logger?.debug?.('[afterTurn] O7: prefetch skipped (no sessionKey)');
        } else {
          const query = userContent.slice(0, 500); // 截断查询，避免过长
          const retrievalLimits = { qmd: 5, graph: 5, exp: 3 };

          ctx.logger?.info?.('[afterTurn] O7: full prefetch enqueue', {
            sessionKey: sessionKey.slice(0, 16),
            queryLen: query.length,
            limits: retrievalLimits,
          });

          const deps = {
            logger: ctx.logger,
            qmdClient: ctx.qmdClient,
            graphAdapter: ctx.graphAdapter,
            expStore: ctx.expStore,
          } as const;

          // v2.3.6 链路 2 采集端：L3 召回节点录入 SessionRecallCache，供下一轮
          // processFeedback 自动判定（仅真实用户对话采集，避免污染 M 矩阵）。
          const onGraph = (nodeIds: string[], sk: string, q: string): void => {
            try {
              if (ctx.graphAdapter?.recordRecallToSessionCache && isLearningEligibleSession(sk)) {
                ctx.graphAdapter.recordRecallToSessionCache(sk, q, nodeIds);
              }
            } catch (rrErr) {
              ctx.logger?.debug?.('[afterTurn] O7: recordRecallToSessionCache failed (non-fatal)', {
                err: rrErr instanceof Error ? rrErr.message : String(rrErr),
              });
            }
          };

          const status = retrievalPrefetchQueue.enqueue({
            sessionKey,
            query,
            run: (async () => {
              try {
                const now = Date.now();
                const results = await runRetrievalPrefetch(deps, sessionKey, query, retrievalLimits, { onGraph });
                // 覆盖式写缓存（last-known-good + LRU + 时间衰减 overlay 合并）
                writePrefetchCache(ctx.prefetchCache, sessionKey, results, query, now, ctx.logger);
              } catch (e) {
                ctx.logger?.debug?.('[afterTurn] O7: prefetch run failed (non-fatal)', {
                  err: (e as Error).message,
                });
              }
            })(),
          });

          if (status === 'merged') {
            ctx.logger?.info?.('[afterTurn] O7: prefetch merged into in-flight job (query similar, no duplicate ran)', {
              sessionKey: sessionKey.slice(0, 16),
              query: query.slice(0, 60),
            });
          }
        }
      } catch (prefetchErr) {
        ctx.logger?.debug?.('[afterTurn] O7: prefetch setup failed (non-fatal)', {
          err: (prefetchErr as Error).message,
        });
      }
    }

    // ==================================================================
    // v2.7.0 G-U: 目标切换智能卸载 — 检测 goal switch 后写入高优先级 compaction debt
    // ==================================================================
    try {
      const sessionKey = resolveSessionCacheKey(params);
      if (sessionKey && userContent) {
        const oldGoal = getGoal(sessionKey);
        const switched = shouldUpdateGoal(userContent, sessionKey);
        if (switched && oldGoal) {
          ctx.logger?.info?.('[afterTurn] G-U: goal switch detected, writing high-priority compaction debt', {
            oldGoal: oldGoal.slice(0, 80),
            newGoal: userContent.slice(0, 80),
          });
          // 写入高优先级债务，触发 debt-manager 对旧目标内容进行异步压缩
          try {
            const { getConversationId, writeCompactionDebt } = await import('../lcm-bridge.js');
            // FIX-SK3: getConversationId(sessionKey, sessionId) 双参正确传递。
            // 修复前：把 resolveSessionCacheKey 的结果（sessionId 优先，通常是 sessionId 值）
            // 当 sessionKey 实参传入 → 缓存 key 变成 `sk:<sessionId值>`、DB 按
            // session_key 列查不到 → convId 恒为 null → goal_switch 债务永远写不进去，
            // 旧目标内容得不到压缩，上下文持续膨胀。
            // 修复后：raw sessionKey 与 sessionId 各自按语义传入（缓存 key sessionKey 优先，
            // DB 查询先 session_key 后 session_id），与 assemble 侧调用（raw sessionKey）一致。
            const rawSk = typeof params.sessionKey === 'string' ? params.sessionKey : '';
            const rawSid = typeof params.sessionId === 'string' ? params.sessionId
              : typeof params.session_id === 'string' ? params.session_id : '';
            const convId = getConversationId(rawSk || undefined, rawSid || undefined);
            if (convId != null) {
              writeCompactionDebt(
                convId,
                114688, // DEFAULT_TOKEN_BUDGET
                (params.messages?.length ?? 0) * 200, // 粗略估算
                'goal_switch_unload',
              );
              ctx.logger?.info?.('[afterTurn] G-U: compaction debt written for goal switch', {
                conversationId: convId,
              });
            }
          } catch (debtErr) {
            ctx.logger?.debug?.('[afterTurn] G-U: write debt failed (non-fatal)', {
              err: (debtErr as Error).message,
            });
          }
        }
      }
    } catch (goalErr) {
      ctx.logger?.debug?.('[afterTurn] G-U: goal unload check failed (non-fatal)', {
        err: (goalErr as Error).message,
      });
    }
  } catch (err) {
    ctx.logger?.error?.('[lcm-graph-extra] afterTurn error', { err: serializeError(err) });
  }
}