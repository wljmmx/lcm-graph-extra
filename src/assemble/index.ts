/**
 * assemble 主入口。
 *
 * 组合 retrieval / injection / guidance 三个子模块，实现完整的 assemble 生命周期。
 */

import { extractAvailableTools, hasToolCategory, beginToolGuidanceRound, buildSmartToolGuidance } from '../plugin/tool-guidance.js';
import { getOverhead, setOverhead } from '../plugin/overhead-cache.js';
import { extractFirstUserGoal, cacheGoal, getGoal } from '../plugin/goal-cache.js';
// P0-6: 热路径 healthMetrics 静态导入，消除主路径反复 await import 开销
import { healthMetrics } from '../health-metrics.js';
import {
  type PressureTier,
  determinePressureTier,
  shouldTriggerCompact,
  getRetrievalLimitsForTier,
  getMaxContextCharsForTier,
  getConversationId,
  writeCompactionDebt,
  estimateTokensFromMessages,
  estimateTokensFromText,
  getConversationSummaries,
  hasUncompressedMessages,
  getUncompressedMessageCount,
  trimSummariesToBudget,
} from '../lcm-bridge.js';
import { resolveContextProfile } from '../config.js';
import { backgroundTasks } from '../async/task-registry.js';
import { serializeError } from '../utils/logger.js';
import { performRetrieval } from './retrieval.js';
import { injectContext } from './injection.js';
import type { AssembleContext, AssembleResult } from './types.js';

export async function assemble(ctx: AssembleContext, params: any): Promise<AssembleResult> {
  // AbortSignal support - early exit if cancelled
  const signal = (params as any).abortSignal || (params as any).signal;
  if (signal?.aborted) {
    return { messages: [], estimatedTokens: 0, systemPromptAddition: undefined, promptAuthority: "assembled", degraded: false, degradedReasons: undefined };
  }

  const citationsMode = params.citationsMode ?? 'never';
  ctx.logger?.debug?.("[lcm-graph-extra] assemble called");
  const assembleStart = Date.now();
  let systemPromptAddition = "";

  let estimatedTokens = 0;
  let tier: PressureTier = 'low';
  let retrievalLimits = { qmd: 5, graph: 5, exp: 3 };
  let maxContextChars = 12000;
  let finalMessages = params.messages ?? [];
  let qmdResults: any = [];
  let graphResults: any = [];
  let expResults: any = [];
  let _overheadCacheKey = "";
  let contextWindow = 0;
  const degradedReasons: string[] = [];
  const markDegraded = (reason: string): void => {
    if (!degradedReasons.includes(reason)) degradedReasons.push(reason);
  };

  try {
    const initStart = Date.now();
    await ctx.ensureInitialized();
    const initMs = Date.now() - initStart;

    // ==================================================================
    // 0. Tool-aware retrieval strategy
    // ==================================================================
    const availableTools = extractAvailableTools(params);
    const hasGraphTool = hasToolCategory(availableTools, "graph");
    const hasExperienceTool = hasToolCategory(availableTools, "experience");

    if (availableTools.length > 0) {
      ctx.logger?.debug?.(
        "[lcm-graph-extra] availableTools: " + JSON.stringify(availableTools) +
        ", hasGraph=" + hasGraphTool + ", hasExperience=" + hasExperienceTool
      );
    }

    // Smart Tool Guidance: 会话级工具追踪（L1-L4 策略），在每轮 assemble 开头调用
    const _toolSessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
      : typeof params.session_id === 'string' ? params.session_id : '';
    beginToolGuidanceRound(_toolSessionKey, params.messages ?? []);

    // Goal Anchoring: 提取首轮用户目标并缓存，防止长对话注意力漂移
    // 仅在首轮（无缓存）时提取，后续轮次直接读取缓存
    if (_toolSessionKey && !getGoal(_toolSessionKey)) {
      const goal = extractFirstUserGoal(params.messages ?? []);
      if (goal) {
        cacheGoal(_toolSessionKey, goal);
        ctx.logger?.debug?.('[assemble] goal anchored', { goal: goal.slice(0, 80) });
      }
    }

    // ==================================================================
    // 1. Window Monitor — pressure check + tier determination
    // ==================================================================
    const wmConfig = ctx.api.pluginConfig?.lcmMonitor;
    ctx.logger?.info?.("[DEBUG] wmConfig keys: " + (wmConfig ? Object.keys(wmConfig).join(",") : "NULL/UNDEFINED"));
    const wm = wmConfig?.enabled !== false ? wmConfig : null;
    const messages = params.messages ?? [];
    const tokenBudget = params.tokenBudget;
    const msgCount = messages.length;
    estimatedTokens = estimateTokensFromMessages(messages);
    const modelFullId = typeof params.model === "string" ? params.model : "";
    let providerModelCtx = ctx.modelRegistry ? ctx.modelRegistry[modelFullId] : undefined;
    ctx.logger.info(`[TOKEN-BUDGET] tokenBudget=${tokenBudget}, estimatedTokens=${estimatedTokens}, model=${modelFullId}`);
    if (providerModelCtx === undefined && ctx.modelRegistry && modelFullId) {
      const shortId = modelFullId.includes('/') ? modelFullId.split('/').pop() : modelFullId;
      for (const [key, val] of Object.entries(ctx.modelRegistry)) {
        if (key.endsWith(shortId)) {
          providerModelCtx = val;
          ctx.logger?.debug?.("model context fallback: " + modelFullId + " -> " + key + " (" + val + ")");
          break;
        }
      }
    }
    const resolvedCtx = resolveContextProfile(providerModelCtx, wm || undefined);
    contextWindow = resolvedCtx.contextWindow;
    _overheadCacheKey = (params as any).sessionKey ?? (params as any).conversationId ?? "default";
    const overheadTokens = getOverhead(_overheadCacheKey);
    const effectiveTokenCount = estimatedTokens + overheadTokens;
    let tokenRatio = contextWindow > 0 ? effectiveTokenCount / contextWindow : 0;

    tier = 'low';
    retrievalLimits = resolvedCtx.retrievalLimits;
    maxContextChars = resolvedCtx.maxContextChars.low;
    if (tokenBudget != null && typeof tokenBudget === 'number') {
      maxContextChars = Math.min(maxContextChars, Math.floor(tokenBudget * 4));
    }
    const _wmConvId = getConversationId(typeof params.sessionKey === "string" ? params.sessionKey : (typeof params.session_id === "string" ? params.session_id : ""));
    let uncompressedMsgs = -1;
    let needsCompact = false;

    if (wm) {
      uncompressedMsgs = _wmConvId != null ? getUncompressedMessageCount(_wmConvId) : -1;
      const activeMsgCount = uncompressedMsgs >= 0 ? uncompressedMsgs : msgCount;
      tier = determinePressureTier(activeMsgCount, tokenRatio, {
        dedupRounds: wm.dedupRounds ?? 24,
        highPressureThreshold: wm.highPressureThreshold ?? 0.85,
        mediumPressureThreshold: wm.mediumPressureThreshold ?? 0.70,
      });
      retrievalLimits = getRetrievalLimitsForTier(tier, {
        low: resolvedCtx.retrievalLimits,
        medium: { qmd: Math.max(1, Math.round(resolvedCtx.retrievalLimits.qmd * 0.6)), graph: Math.max(1, Math.round(resolvedCtx.retrievalLimits.graph * 0.6)), exp: Math.max(0, Math.round(resolvedCtx.retrievalLimits.exp * 0.3)) },
        high: { qmd: 1, graph: 1, exp: 0 },
      });

      maxContextChars = getMaxContextCharsForTier(tier, {
        low: resolvedCtx.maxContextChars.low,
        medium: resolvedCtx.maxContextChars.medium,
        high: wm?.maxContextChars?.high ?? 1_600,
      });

      needsCompact = shouldTriggerCompact(activeMsgCount, tokenRatio, {
        dedupRounds: wm.dedupRounds ?? 24,
        proactiveThreshold: wm.proactiveThreshold ?? 0.65,
      });
    }

    // ==================================================================
    // 1b. Token ratio > 0.65 warning + async pre-compaction trigger
    // ==================================================================
    if (tokenRatio > 0.65 && !needsCompact) {
      ctx.logger?.warn?.(
        "window monitor: token ratio above 0.65, triggering async pre-compaction",
        { tokenRatio: Number(tokenRatio.toFixed(3)), effectiveTokenCount, estimatedTokens, contextWindow },
      );
      if (ctx.losslessClawAdapter?.connected) {
        const preCompactSessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
          : typeof params.session_id === 'string' ? params.session_id
          : '';
        const preCompactConversationId = getConversationId(preCompactSessionKey);
        if (preCompactConversationId != null) {
          const _lcSid = typeof params.sessionId === 'string' ? params.sessionId
            : (typeof params.session_id === 'string' ? params.session_id : String(preCompactConversationId));
          backgroundTasks.register('compact:pre-emptive', ctx.losslessClawAdapter.compact({
            sessionId: _lcSid,
            sessionKey: preCompactSessionKey,
            sessionFile: typeof params.sessionFile === 'string' ? params.sessionFile : '',
            force: true,
            currentTokenCount: effectiveTokenCount,
            compactionTarget: 'threshold',
          }).then(() => {}, () => {}));
        }
      }
    }

    // ==================================================================
    // 2. Pressure-tier message assembly
    // ==================================================================
    finalMessages = messages;

    if (needsCompact && ctx.losslessClawAdapter?.connected) {
      const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
        : typeof params.session_id === 'string' ? params.session_id
        : '';
      const conversationId = getConversationId(sessionKey);
      if (conversationId != null) {
        const compactTimeout = (parseInt(process.env.LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS || '0') || ((wm as any)?.compactTimeout as number)) ?? 60_000;
        const maxSummaryRatio = (wm as any)?.maxSummaryTokenRatio ?? 0.45;
        const sessionFile = typeof params.sessionFile === 'string' ? params.sessionFile : '';

        const convSummaries = getConversationSummaries(conversationId);
        const hasExistingSummary = convSummaries.length > 0;
        const rawCount = messages.length;
        const dedupLimit = (wm as any)?.dedupRounds ?? 24;

        if (tier === 'medium') {
          const _lcSid = typeof params.sessionId === 'string' ? params.sessionId
            : (typeof params.session_id === 'string' ? params.session_id : String(conversationId));
          backgroundTasks.register('compact:medium-tier', ctx.losslessClawAdapter.compact({
            sessionId: _lcSid, sessionKey, sessionFile, force: true,
            tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
            compactionTarget: 'threshold',
          }).then(() => {}, () => {}));

          if (hasExistingSummary) {
            const summaryMsgs = convSummaries.map((s) => ({
              role: 'user', content: s.content, token_count: s.tokenCount,
            }));
            // Goal Anchoring: 中压压缩时也保留原始目标
            const goalMsg = getGoal(sessionKey);
            const goalAnchorMsgs = goalMsg
              ? [{ role: 'user', content: '## 原始任务目标\n' + goalMsg + '\n\n请继续完成以上任务，不要偏离。' }]
              : [];
            finalMessages = [...goalAnchorMsgs, ...summaryMsgs, ...messages];
          }

          const hasPendingUncompressed = hasUncompressedMessages(conversationId);
          if (rawCount > dedupLimit || hasPendingUncompressed) {
            writeCompactionDebt(
              conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
              'medium_pressure_uncompressed_' + rawCount + '_exceeds_' + dedupLimit,
            );
          }
        } else if (tier === 'high') {
          const _lcSid = typeof params.sessionId === 'string' ? params.sessionId
            : (typeof params.session_id === 'string' ? params.session_id : String(conversationId));

          // ── 压缩降级工具函数：用已有摘要 + 最近消息构建注入上下文 ──
          const buildDegradedContext = (reason: string) => {
            const existingSummaries = getConversationSummaries(conversationId);
            const goalMsg = getGoal(sessionKey);
            const goalAnchorMsgs = goalMsg
              ? [{ role: 'user', content: '## 原始任务目标\n' + goalMsg + '\n\n请继续完成以上任务，不要偏离。' }]
              : [];
            if (existingSummaries.length > 0) {
              const trimmed = trimSummariesToBudget(
                existingSummaries.map((s) => ({ summaryId: s.summaryId, content: s.content, tokenCount: s.tokenCount })),
                resolvedCtx.compactTokenBudget * maxSummaryRatio,
              ).map((s) => ({ role: 'user', content: s.content, token_count: s.tokenCount }));
              const recentCount = Math.min(messages.length, 6);
              return [...goalAnchorMsgs, ...trimmed, ...messages.slice(-recentCount)];
            }
            // 无摘要时只用最近消息
            const fallbackCount = Math.min(messages.length, 12);
            return [...goalAnchorMsgs, ...messages.slice(-fallbackCount)];
          };

          // ── P0: 输入超限保护 —— 当 raw token 超过 LLM 上下文窗口 90% 时，compact 必然失败 ──
          const inputOverflowThreshold = Math.floor(contextWindow * 0.90) - resolvedCtx.compactTokenBudget;
          if (effectiveTokenCount > inputOverflowThreshold && effectiveTokenCount > 0) {
            ctx.logger?.warn?.('[assemble] compact input overflow — skipping sync compact, using degraded context', {
              effectiveTokenCount,
              inputOverflowThreshold,
              contextWindow,
              compactTokenBudget: resolvedCtx.compactTokenBudget,
            });
            writeCompactionDebt(
              conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
              'high_pressure_input_overflow_' + effectiveTokenCount + '_gt_' + inputOverflowThreshold,
            );
            finalMessages = buildDegradedContext('input_overflow');
            markDegraded('high_pressure_input_overflow');

            // 异步触发 compact 处理未压缩部分（lossless-claw 内部自行分段）
            const _asyncSid = typeof params.sessionId === 'string' ? params.sessionId
              : (typeof params.session_id === 'string' ? params.session_id : String(conversationId));
            backgroundTasks.register('compact:overflow-retry', ctx.losslessClawAdapter.compact({
              sessionId: _asyncSid, sessionKey, sessionFile, force: true,
              tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
              compactionTarget: 'threshold',
            }).then(() => {}, () => {}));
          } else {
            try {
              let compactTimer: ReturnType<typeof setTimeout> | undefined;
              const compactTimeoutPromise = new Promise<never>((_, reject) => {
                compactTimer = setTimeout(() => reject(new Error('Compact timeout')), compactTimeout);
              });
              compactTimeoutPromise.catch(() => {});
              await Promise.race([
                ctx.losslessClawAdapter.compact({
                  sessionId: _lcSid, sessionKey, sessionFile, force: true,
                  tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
                  compactionTarget: 'threshold',
                }),
                compactTimeoutPromise,
              ]);
              if (compactTimer) clearTimeout(compactTimer);
              const freshSummaries = getConversationSummaries(conversationId);
              if (freshSummaries.length > 0) {
                const trimmedSummaryMsgs = trimSummariesToBudget(
                  freshSummaries.map((s) => ({ summaryId: s.summaryId, content: s.content, tokenCount: s.tokenCount })),
                  resolvedCtx.compactTokenBudget * maxSummaryRatio,
                ).map((s) => ({ role: 'user', content: s.content, token_count: s.tokenCount }));

                // Goal Anchoring: 压缩时保留原始用户目标，防止任务丢失
                const goalMsg = getGoal(sessionKey);
                const goalAnchorMsgs = goalMsg
                  ? [{ role: 'user', content: '## 原始任务目标\n' + goalMsg + '\n\n请继续完成以上任务，不要偏离。' }]
                  : [];

                const recentRawCount = Math.min(messages.length, 8);
                const recentRawMsgs = messages.slice(-recentRawCount);
                finalMessages = [...goalAnchorMsgs, ...trimmedSummaryMsgs, ...recentRawMsgs];

                // Re-evaluate pressure tier after successful compaction
                if (wm) {
                  const postCompactTokens = estimateTokensFromMessages(finalMessages);
                  const postCompactTokenRatio = contextWindow > 0 ? postCompactTokens / contextWindow : 0;
                  const postCompactUncompressed = getUncompressedMessageCount(conversationId);
                  const postCompactActive = postCompactUncompressed >= 0 ? postCompactUncompressed : finalMessages.length;

                  const newTier = determinePressureTier(postCompactActive, postCompactTokenRatio, {
                    dedupRounds: wm.dedupRounds ?? 24,
                    highPressureThreshold: wm.highPressureThreshold ?? 0.85,
                    mediumPressureThreshold: wm.mediumPressureThreshold ?? 0.70,
                  });

                  if (newTier !== tier) {
                    ctx.logger?.info?.('[assemble] tier re-evaluated after compaction', {
                      oldTier: tier,
                      newTier,
                      oldTokenRatio: Number(tokenRatio.toFixed(3)),
                      newTokenRatio: Number(postCompactTokenRatio.toFixed(3)),
                    });
                    tier = newTier;
                    estimatedTokens = postCompactTokens;
                    tokenRatio = postCompactTokenRatio;
                    retrievalLimits = getRetrievalLimitsForTier(tier, {
                      low: resolvedCtx.retrievalLimits,
                      medium: { qmd: Math.max(1, Math.round(resolvedCtx.retrievalLimits.qmd * 0.6)), graph: Math.max(1, Math.round(resolvedCtx.retrievalLimits.graph * 0.6)), exp: Math.max(0, Math.round(resolvedCtx.retrievalLimits.exp * 0.3)) },
                      high: { qmd: 1, graph: 1, exp: 0 },
                    });
                    maxContextChars = getMaxContextCharsForTier(tier, {
                      low: resolvedCtx.maxContextChars.low,
                      medium: resolvedCtx.maxContextChars.medium,
                      high: wm?.maxContextChars?.high ?? 1_600,
                    });
                  }

                  // ── P1: 迭代压缩 —— 一次 compact 不够时，异步触发二次压缩 ──
                  // 当 compact 后 tier 仍为 high 或 medium，说明还有大量未压缩内容
                  if (newTier === 'high' || newTier === 'medium') {
                    ctx.logger?.info?.('[assemble] iterative compaction triggered', {
                      tier: newTier,
                      tokenRatio: Number(postCompactTokenRatio.toFixed(3)),
                      uncompressedCount: postCompactUncompressed,
                    });
                    const _iterSid = typeof params.sessionId === 'string' ? params.sessionId
                      : (typeof params.session_id === 'string' ? params.session_id : String(conversationId));
                    backgroundTasks.register('compact:iterative-' + newTier, ctx.losslessClawAdapter.compact({
                      sessionId: _iterSid, sessionKey, sessionFile, force: true,
                      tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: postCompactTokens,
                      compactionTarget: 'threshold',
                    }).then(() => {}, () => {}));
                  }
                }
              } else {
                writeCompactionDebt(
                  conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
                  'high_pressure_no_summary_after_compact',
                );
                // 无摘要产出 → 降级注入
                finalMessages = buildDegradedContext('no_summary');
                markDegraded('high_pressure_no_summary');
              }
            } catch (err) {
              ctx.logger?.warn?.('High pressure compact failed, using degraded context', { err: serializeError(err) });
              writeCompactionDebt(
                conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
                'high_pressure_compact_failed',
              );
              // ── P0: 压缩失败降级 —— 用已有摘要 + 最近消息，而非全量继续 ──
              finalMessages = buildDegradedContext('compact_failed');
              markDegraded('high_pressure_compact_failed');
            }
          }
        } else {
          writeCompactionDebt(
            conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
            'proactive_' + tier + '_pressure',
          );
          backgroundTasks.register('compact:low-tier', ctx.losslessClawAdapter.compact({
            sessionId: typeof params.sessionId === 'string' ? params.sessionId
              : (typeof params.session_id === 'string' ? params.session_id : String(conversationId)),
            sessionKey, sessionFile, force: true,
            tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
            compactionTarget: 'threshold',
          }).then(() => {}, () => {}));
        }
      }
    } else if (needsCompact) {
      const sk = typeof params.sessionKey === 'string' ? params.sessionKey
        : typeof params.session_id === 'string' ? params.session_id : '';
      const cid = getConversationId(sk);
      if (cid != null) {
        writeCompactionDebt(
          cid, resolvedCtx.compactTokenBudget, effectiveTokenCount,
          'proactive_' + tier + '_pressure_no_adapter',
        );
      }
    }

    if (finalMessages === messages && ctx.losslessClawAdapter?.connected) {
      const _sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
        : typeof params.session_id === 'string' ? params.session_id : '';
      const _convId = getConversationId(_sessionKey);
      if (_convId != null) {
        const _existingSummaries = getConversationSummaries(_convId);
        if (_existingSummaries.length > 0) {
          const _summaryMsgs = _existingSummaries.map((s) => ({
            role: 'user', content: s.content, token_count: s.tokenCount,
          }));
          // Goal Anchoring: 摘要注入时也保留原始目标
          const _goalMsg = getGoal(_sessionKey);
          const _goalAnchorMsgs = _goalMsg
            ? [{ role: 'user', content: '## 原始任务目标\n' + _goalMsg + '\n\n请继续完成以上任务，不要偏离。' }]
            : [];
          const _recentCount = Math.min(messages.length, 8);
          const _recentRawMsgs = messages.slice(-_recentCount);
          finalMessages = [..._goalAnchorMsgs, ..._summaryMsgs, ..._recentRawMsgs];
        }
      }
    }

    // ==================================================================
    // 3. Perform retrieval (L2/L3/L4 + cascade)
    // ==================================================================
    const retrievalOutput = await performRetrieval(
      ctx, params, tier, tokenRatio, retrievalLimits,
      hasGraphTool, hasExperienceTool, availableTools,
      estimatedTokens, contextWindow, effectiveTokenCount, overheadTokens,
      msgCount, uncompressedMsgs, initMs, degradedReasons,
    );

    qmdResults = retrievalOutput.qmdResults;
    graphResults = retrievalOutput.graphResults;
    expResults = retrievalOutput.expResults;
    const fullDocs = retrievalOutput.fullDocs;
    const l2_ms = retrievalOutput.l2_ms;
    const l3_ms = retrievalOutput.l3_ms;
    const l4_ms = retrievalOutput.l4_ms;
    const mgMs = retrievalOutput.mgMs;
    const parallelMs = retrievalOutput.parallelMs;

    // ---- Metrics log ----
    const finalEstimate = estimateTokensFromMessages(finalMessages);
    ctx.logger?.info?.(`⚡ assemble=${Date.now()-assembleStart}ms | init=${initMs}ms | parallel=${parallelMs}(L2_qmd=${l2_ms},L3_graph=${l3_ms},L4_exp=${l4_ms}) | mg=${mgMs}ms | estimatedTokens=${finalEstimate}/${contextWindow}(${(finalEstimate/contextWindow*100).toFixed(1)}%) | overhead=${overheadTokens} | effectiveTokenCount=${effectiveTokenCount} | msgCount=${msgCount} | uncomp=${uncompressedMsgs} | tier=${tier}`, {
      elapsed: Date.now() - assembleStart,
      init_ms: initMs,
      parallel_ms: parallelMs,
      multiget_ms: mgMs,
      l2_qmd_ms: l2_ms,
      l3_graph_ms: l3_ms,
      l4_experience_ms: l4_ms,
      multiGet_ms: mgMs,
      l2_count: Array.isArray(qmdResults) ? qmdResults.length : 0,
      l3_count: Array.isArray(graphResults) ? graphResults.length : 0,
      l4_count: expResults.length,
      doc_count: fullDocs?.length ?? 0,
      tokenRatio: Number(tokenRatio.toFixed(3)),
      overheadTokens,
      effectiveTokenCount,
      msgCount,
      finalEstimate,
      contextWindow,
      tier: tier,
      retrieval_limits: JSON.stringify(retrievalLimits),
      available_tools_count: availableTools.length,
      has_graph_tool: hasGraphTool,
      has_experience_tool: hasExperienceTool,
    });

    // N-4: 记录 assemble 性能指标
    try {
      // P0-6: 已改为静态导入
      healthMetrics.recordAssemble(tier, Date.now() - assembleStart, l2_ms, l3_ms, l4_ms);
    } catch (e) { /* non-fatal */
      ctx.logger?.debug?.("recordAssemble failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }

    // ==================================================================
    // 4. Inject context (layers + conflict detection + systemPromptAddition)
    // ==================================================================
    const injectionOutput = await injectContext(
      ctx, params, tier,
      qmdResults, graphResults, expResults,
      fullDocs, retrievalLimits, finalMessages,
      availableTools, maxContextChars, contextWindow,
      citationsMode, modelFullId,
      retrievalOutput.qmdQuery,
      retrievalOutput.scenario ?? null,
    );

    systemPromptAddition = injectionOutput.systemPromptAddition;
    expResults = injectionOutput.expResults;

    // ==================================================================
    // 4.5 MoA (Mixture of Agents) 管道
    // 仅复杂任务 + 启用 tiers 时触发
    // 参考模型并行发散 → 聚合模型收敛裁决 → 结果存入缓存供 lcmg_moa_reply 工具读取
    // ==================================================================
    try {
      const moaConfig = (ctx.api?.pluginConfig as any)?.moa;

      // 延迟导入避免循环依赖
      const { computeTaskComplexity } = await import('../moa/complexity.js');
      const { recordAllComplexity } = await import('../moa/perf-tracker.js');

      // 提取查询文本
      const queryText = (() => {
        const lastMsg = finalMessages[finalMessages.length - 1];
        if (lastMsg?.role === 'user') {
          if (typeof lastMsg.content === 'string') return lastMsg.content;
          if (Array.isArray(lastMsg.content)) {
            return lastMsg.content
              .filter((p: any) => p?.type === 'text')
              .map((p: any) => p.text)
              .join('\n');
          }
        }
        return '';
      })();

      // 构建检索上下文
      const retrievalContext = (() => {
        const parts: string[] = [];
        if (qmdResults?.length) {
          parts.push('## 知识库检索 (L2 qmd)\n' + qmdResults.slice(0, 3).map((r: any) => r?.text || r?.content || '').filter(Boolean).join('\n---\n'));
        }
        if (graphResults?.length) {
          parts.push('## 知识图谱检索 (L3 Neo4j)\n' + graphResults.slice(0, 3).map((r: any) => r?.text || r?.content || '').filter(Boolean).join('\n---\n'));
        }
        if (expResults?.length) {
          parts.push('## 经验检索 (L4 Experience)\n' + expResults.slice(0, 2).map((r: any) => r?.summary || r?.title || '').filter(Boolean).join('\n'));
        }
        return parts.join('\n\n');
      })();

      const complexity = computeTaskComplexity(
        queryText,
        finalMessages,
        retrievalOutput.scenario ?? null,
        tier,
      );

      // 记录全量复杂度评分（每轮 assemble 都记录，无论 MoA 是否启用/触发）
      recordAllComplexity(complexity.score);

      ctx.logger?.debug?.('[assemble] MoA complexity check', {
        score: complexity.score,
        threshold: moaConfig?.complexityThreshold ?? 0.6,
        reasons: complexity.reasons,
        tier,
      });

      if (moaConfig?.enabled
          && Array.isArray(moaConfig?.referenceModels)
          && moaConfig.referenceModels.length >= 2
          && moaConfig.referenceModels.length <= 4
          && moaConfig.enabledTiers?.includes(tier)) {

        const { runMoaPipeline, buildMoaToolInstruction } = await import('../moa/orchestrator.js');

        if (complexity.score >= moaConfig.complexityThreshold) {
          ctx.logger?.info?.('[assemble] MoA triggered', {
            complexity: complexity.score,
            reasons: complexity.reasons,
            mode: moaConfig.mode,
            refCount: moaConfig.referenceModels?.length ?? 0,
          });

          // 构建对话上下文（最近 3 轮用户/助手消息，帮助聚合模型理解讨论背景）
          const conversationContext = (() => {
            const recent = finalMessages.slice(-6); // 最近 3 轮（用户 + 助手）
            return recent
              .filter((m: any) => m?.role === 'user' || m?.role === 'assistant')
              .map((m: any) => {
                const content = typeof m.content === 'string' ? m.content
                  : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ') : '';
                const preview = content.slice(0, 300);
                return `[${m.role}] ${preview}`;
              })
              .join('\n');
          })();

          const moaResult = await runMoaPipeline({
            query: queryText,
            retrievalContext,
            conversationContext,
            config: moaConfig,
            api: ctx.api,
            logger: ctx.logger,
            signal,
            complexityScore: complexity.score,
          });

          if (moaResult?.finalResponse) {
            // 注入 MoA 工具调用指令
            systemPromptAddition = buildMoaToolInstruction() + '\n\n' + systemPromptAddition;

            ctx.logger?.info?.('[assemble] MoA pipeline completed', {
              totalMs: moaResult.totalMs,
              estimatedTokens: moaResult.estimatedTokens,
              responseLen: moaResult.finalResponse.length,
              refCount: moaResult.referenceOutputs.length,
            });
          } else {
            ctx.logger?.warn?.('[assemble] MoA pipeline returned no result, falling back to normal flow');
          }
        }
      }
    } catch (moaErr) {
      // MoA 失败不影响主流程，降级到正常推理
      ctx.logger?.warn?.('[assemble] MoA pipeline failed, falling back to normal flow', {
        err: moaErr instanceof Error ? moaErr.message : String(moaErr),
      });
    }

    // ==================================================================
    // 5. Cleanup: strip reasoning, dedup, local model tool injection
    // ==================================================================
    finalMessages = finalMessages.map((msg: any) => {
      if (msg?.role === 'assistant') {
        const cleaned = { ...msg };
        delete cleaned.reasoning;
        delete cleaned.thinking;
        delete cleaned.reasoning_content;
        if (Array.isArray(cleaned.content)) {
          cleaned.content = cleaned.content.filter(
            (p: any) => p?.type !== 'thinking' && p?.type !== 'reasoning'
          );
        }
        return cleaned;
      }
      return msg;
    });

    {
      const _deduped: any[] = [];
      const _extractText = (c: any): string => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((item: any) => typeof item === 'string' ? item : (item?.text ?? '')).join('');
        return String(c ?? '');
      };
      for (const _msg of finalMessages) {
        const _last = _deduped[_deduped.length - 1];
        if (_last && _last.role === _msg.role && _extractText(_last.content) === _extractText(_msg.content)) {
          continue;
        }
        _deduped.push(_msg);
      }
      if (_deduped.length < finalMessages.length) {
        ctx.logger?.debug?.('[assemble] removed ' + String(finalMessages.length - _deduped.length) + ' consecutive duplicate message(s)');
        finalMessages = _deduped;
      }
    }

    if (typeof modelFullId === 'string' && (modelFullId.startsWith('ollama/') || modelFullId.startsWith('ollama-256k/'))
        && availableTools.length > 0) {
      const smartGuidance = buildSmartToolGuidance(
        tier, retrievalOutput.scenario ?? null, availableTools, _toolSessionKey,
      );
      if (smartGuidance) {
        systemPromptAddition += '\n\n' + smartGuidance;
      }
    }

    // Smart Tool Guidance: 通用模型（非 ollama）也使用场景驱动工具注入
    if (typeof modelFullId !== 'string' || (!modelFullId.startsWith('ollama/') && !modelFullId.startsWith('ollama-256k/'))) {
      if (availableTools.length > 0) {
        const smartGuidance = buildSmartToolGuidance(
          tier, retrievalOutput.scenario ?? null, availableTools, _toolSessionKey,
        );
        if (smartGuidance && systemPromptAddition.length > 0) {
          systemPromptAddition += '\n\n' + smartGuidance;
        }
      }
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    ctx.logger?.warn?.("assemble: retrieval failed", { err: e.message, stack: e.stack, name: e.name });
  }

  // ==================================================================
  // Final return block
  // ==================================================================
  try {
    // P0-5: 缓存 messageTokens，避免对同一 finalMessages 数组重复计算
    let messageTokens = estimateTokensFromMessages(finalMessages);
    let additionTokens = 0;
    if (typeof systemPromptAddition === "string" && systemPromptAddition.length > 0) {
      additionTokens = estimateTokensFromText(systemPromptAddition);
    }
    setOverhead(_overheadCacheKey, additionTokens);

    {
      const totalEst = messageTokens + additionTokens;
      if (contextWindow > 0 && totalEst > contextWindow * 0.85) {
        const buffer: any[] = [...finalMessages];
        const systemCount = buffer.filter((m: any) => m.role === 'system').length;
        // P0-5: per-message token 估算只算一次，trimming 循环中减去即可
        const msgTokenEst: number[] = buffer.map((m: any) => estimateTokensFromMessages([m]));
        let runningTokens = messageTokens;
        while (buffer.length > systemCount + 1) {
          const idx = buffer.findIndex((m: any) => m.role !== 'system');
          if (idx < 0) break;
          runningTokens -= msgTokenEst[idx];
          buffer.splice(idx, 1);
          msgTokenEst.splice(idx, 1);
          if (runningTokens + additionTokens <= contextWindow * 0.85) {
            finalMessages = buffer;
            messageTokens = runningTokens; // P0-5: 复用 trimming 后的 token 数
            break;
          }
        }
        // P0-5: 仅在 finalMessages 被替换为 buffer 时才需要重算
        if (finalMessages === buffer && runningTokens + additionTokens > contextWindow * 0.85) {
          finalMessages = buffer;
          // buffer 未变，messageTokens 已是 runningTokens，无需重算
        }
      }
    }

    const degraded = degradedReasons.length > 0;
    if (degraded) {
      ctx.logger?.warn?.("[assemble] degraded paths triggered", { reasons: degradedReasons });
    }
    const validatedMessages = Array.isArray(finalMessages) && finalMessages.length > 0
      ? finalMessages
      : (params.messages ?? []);
    // P0-5: 仅在 validatedMessages 不是 finalMessages 时重算
    if (validatedMessages !== finalMessages) {
      messageTokens = estimateTokensFromMessages(validatedMessages);
    }
    const validatedAddition = (typeof systemPromptAddition === "string" && systemPromptAddition.trim().length > 0)
      ? systemPromptAddition
      : undefined;

    try {
      // P0-6: 已改为静态导入
      healthMetrics.recordUxMetrics({
        degraded,
        degradedReasons: degraded ? degradedReasons : undefined,
        estimatedTokens: messageTokens + additionTokens,
        maxContextChars,
        experienceHit: Array.isArray(expResults) && expResults.length > 0,
        experienceQueried: hasToolCategory(extractAvailableTools(params), "experience"),
      });
    } catch (e) { /* non-fatal */
      ctx.logger?.debug?.("recordUxMetrics failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }
    return {
      messages: validatedMessages,
      estimatedTokens: messageTokens + additionTokens,
      systemPromptAddition: validatedAddition,
      promptAuthority: validatedAddition ? "preassembly_may_overflow" : "assembled",
      degraded,
      degradedReasons: degraded ? degradedReasons : undefined,
    };
  } catch (finalErr) {
    const fe = finalErr instanceof Error ? finalErr : new Error(String(finalErr));
    ctx.logger?.error?.("assemble: return error", { err: fe.message, stack: fe.stack });
    markDegraded("assemble_final_error");
    {
      const totalEst = estimateTokensFromMessages(finalMessages);
      if (contextWindow > 0 && totalEst > contextWindow * 0.85) {
        const buffer: any[] = [...finalMessages];
        const systemCount = buffer.filter((m: any) => m.role === 'system').length;
        let currentEst = totalEst;
        while (buffer.length > systemCount + 1) {
          const idx = buffer.findIndex((m: any) => m.role !== 'system');
          if (idx < 0) break;
          const removedMsg = buffer[idx];
          const removedTokens = estimateTokensFromMessages([removedMsg]);
          buffer.splice(idx, 1);
          currentEst -= removedTokens;
          if (currentEst <= contextWindow * 0.85) {
            finalMessages = buffer;
            break;
          }
        }
        if (estimateTokensFromMessages(finalMessages) > contextWindow * 0.85) {
          finalMessages = buffer;
        }
      }
    }
    return {
      messages: finalMessages,
      estimatedTokens: estimateTokensFromMessages(finalMessages),
      systemPromptAddition: undefined,
      promptAuthority: "assembled",
      degraded: true,
      degradedReasons: degradedReasons.length > 0 ? degradedReasons : ["assemble_final_error"],
    };
  }
}