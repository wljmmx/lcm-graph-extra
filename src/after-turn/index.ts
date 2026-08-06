/**
 * afterTurn 主入口。
 *
 * 组合 quality / experience 子模块，实现完整的 afterTurn 生命周期。
 */

import { createHash } from 'crypto';
import { backgroundTasks } from '../async/task-registry.js';
import { extractTopKeywords } from '../plugin/keywords.js';
import { llmTimeout } from '../config/defaults.js';
import { callLlm } from '../utils/llm-call.js';
import { serializeError } from '../utils/logger.js';
import { shouldUpdateGoal, getGoal } from '../plugin/goal-cache.js';
import { evaluateOutputQuality } from './quality.js';
import { extractTriplets, extractExperiences } from './experience.js';
import type { AfterTurnContext } from './types.js';

/** v2.7.0 P7: 简单 hash，与 retrieval.ts 中 hashKey 保持一致 */
function hashKey(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
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
    } catch { /* non-fatal */ }

    // S-7': 用户画像
    try {
      ctx.userProfile.observe(userContent);
    } catch (e) { /* non-fatal */
      ctx.logger?.debug?.("userProfile.observe failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }

    const wordRatio = (userContent.match(/[\w]+/g) || []).length / userContent.trim().length;
    if (wordRatio < 0.3) return;

    // Triplet extraction
    await extractTriplets(ctx, userContent, assistantContent, autoSummary, params);

    // Experience extraction pipeline
    extractExperiences(ctx, recentMessages, priorMessages, msgs, params);

    // G-8: LLM 异步验证回路
    {
      const g8SessionKey = typeof params.sessionKey === 'string'
        ? params.sessionKey
        : typeof params.session_id === 'string'
          ? params.session_id
          : 'default';
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
                  const { withGmProFallback } = await import('../adapters/gm-pro-fallback.js');
                  await withGmProFallback(
                    'upsertFeedback',
                    async (mod) => {
                      await mod.upsertFeedback({
                        nodeId: exp.id,
                        query: exp.query,
                        relevant: score >= 0.5,
                        score,
                        delta,
                      });
                      await store.updateQualityScore(exp.id, score, delta, 'gm-pro');
                    },
                    async () => {
                      await store.updateQualityScore(exp.id, score, delta, 'local');
                    },
                    { logger: ctx.logger, label: 'G-8 upsertFeedback' },
                  );
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
                  const consolidated = await withGmProFallback<{ consolidatedIds: string[] } | null>(
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
                      return await mod.consolidateBuffer({ nodes: bufferNodes, sessionId: _sessionId });
                    },
                    async () => null,
                    { label: 'S-9 consolidateBuffer' },
                  );
                  if (!consolidated || !consolidated.consolidatedIds?.length) {
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
    // v2.7.0 P7: L2 检索预取 — 基于用户输入预测下一轮查询，预取 vec 结果
    // ==================================================================
    if (ctx.l2QueryCache && ctx.qmdClient && userContent) {
      try {
        const keywords = extractTopKeywords([{ role: 'user', content: userContent }], 10);
        if (keywords.length >= 2) {
          // 构造 1-3 个预测 query：完整消息 + Top 关键词组合
          const predictedQueries: string[] = [];
          predictedQueries.push(userContent.slice(0, 200)); // 截断后的原始消息
          if (keywords.length >= 3) {
            predictedQueries.push(keywords.slice(0, 3).join(' '));
          }
          if (keywords.length >= 5) {
            predictedQueries.push(keywords.slice(0, 5).join(' '));
          }

          const prefetchLimit = 5;
          const deduped = [...new Set(predictedQueries.filter(q => q.length > 5))];
          ctx.logger?.debug?.('[afterTurn] P7: L2 prefetch starting', {
            queryCount: deduped.length,
            keywords: keywords.slice(0, 5),
          });

          // 异步预取 vec 结果，写入 l2QueryCache
          backgroundTasks.register('p7:l2-prefetch', (async () => {
            for (const q of deduped) {
              try {
                const cacheKey = `vec:l2:${hashKey(q.toLowerCase().trim())}:${prefetchLimit}`;
                // 跳过已有缓存（TTL 内）
                const cached = ctx.l2QueryCache!.get(cacheKey);
                if (cached && Date.now() - cached.ts < 900_000) {
                  ctx.logger?.debug?.('[afterTurn] P7: L2 prefetch skip (cached)', { key: cacheKey.slice(0, 32) });
                  continue;
                }
                const vecRes = await ctx.qmdClient.query({
                  searches: [{ type: 'vec', query: q }],
                  limit: prefetchLimit,
                  rerank: false,
                });
                if (vecRes && vecRes.length > 0) {
                  ctx.l2QueryCache!.set(cacheKey, { results: vecRes as any[], ts: Date.now() });
                  ctx.logger?.debug?.('[afterTurn] P7: L2 prefetch cached', { key: cacheKey.slice(0, 32), count: vecRes.length });
                }
              } catch (prefetchErr) {
                ctx.logger?.debug?.('[afterTurn] P7: L2 prefetch query failed (non-fatal)', {
                  err: (prefetchErr as Error).message,
                });
              }
            }
          })());
        }
      } catch (prefetchErr) {
        ctx.logger?.debug?.('[afterTurn] P7: L2 prefetch setup failed (non-fatal)', {
          err: (prefetchErr as Error).message,
        });
      }
    }

    // ==================================================================
    // v2.7.0 G-U: 目标切换智能卸载 — 检测 goal switch 后写入高优先级 compaction debt
    // ==================================================================
    try {
      const sessionKey = typeof params.sessionKey === 'string'
        ? params.sessionKey
        : typeof params.session_id === 'string'
          ? params.session_id
          : '';
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
            const convId = getConversationId(sessionKey);
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