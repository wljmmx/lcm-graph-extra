/**
 * afterTurn 主入口。
 *
 * 组合 quality / experience 子模块，实现完整的 afterTurn 生命周期。
 */

import { backgroundTasks } from '../async/task-registry.js';
import { extractTopKeywords } from '../plugin/keywords.js';
import { llmTimeout } from '../config/defaults.js';
import { callLlm } from '../utils/llm-call.js';
import { serializeError } from '../utils/logger.js';
import { evaluateOutputQuality } from './quality.js';
import { extractTriplets, extractExperiences } from './experience.js';
import type { AfterTurnContext } from './types.js';

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
  } catch (err) {
    ctx.logger?.error?.('[lcm-graph-extra] afterTurn error', { err: serializeError(err) });
  }
}