/**
 * assemble 主入口。
 *
 * 组合 retrieval / injection / guidance 三个子模块，实现完整的 assemble 生命周期。
 */

import { extractAvailableTools, hasToolCategory, beginToolGuidanceRound, buildSmartToolGuidance } from '../plugin/tool-guidance.js';
import { detectScenario, SCENARIO_LABELS, detectToolSearchMode, buildModeAwareGuidance } from '../tools/tool-catalog.js';
import { getOverhead, setOverhead, getSdkOverhead, updateSdkOverhead } from '../plugin/overhead-cache.js';
import { extractLatestUserGoal, cacheGoal, getGoal, shouldUpdateGoal, buildGoalAnchor, getGoalSwitchCount, getPreviousGoal } from '../plugin/goal-cache.js';
// P0-6: 热路径 healthMetrics 静态导入，消除主路径反复 await import 开销
import { healthMetrics } from '../health-metrics.js';
import {
  type PressureTier,
  determinePressureTier,
  shouldTriggerCompact,
  getRetrievalLimitsForTier,
  getMaxContextCharsForTier,
  getConversationId,
  invalidateConvIdCache,
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
import { stubLargeToolPayloads, resolveStubConfig } from './tool-payload-stub.js';
import type { AssembleContext, AssembleResult } from './types.js';

/**
 * BUGFIX: 根据 summary 覆盖范围计算应保留的原始消息数。
 *
 * 修复前：上下文替换用粗粒度 "prepend 所有 summary + keep last N" 策略，
 * 不知道每个 summary 具体覆盖了哪些消息，导致：
 *   1. 已覆盖的消息在 summary 和原始消息中重复出现（token 浪费）
 *   2. 多个 summary 时全部 prepend 导致上下文膨胀
 *
 * 修复后：综合 summary.entryCount 和 DB 的 getUncompressedMessageCount
 * 计算实际未被覆盖的消息数，仅保留这些消息作为原始上下文。
 *
 * @param summaries          摘要列表（含 entryCount 覆盖范围）
 * @param totalMessages      当前消息总数
 * @param uncompressedFromDb DB 报告的未压缩消息数（-1 表示不可用）
 * @returns 应保留的原始消息数（最少 2 条，最多 totalMessages）
 */
function computeKeepCount(
  summaries: Array<{ entryCount?: number }>,
  totalMessages: number,
  uncompressedFromDb: number,
): number {
  // Priority 1: 使用 summary entryCount（DAG 直接提供的覆盖消息数）
  const totalCovered = summaries.reduce((sum, s) => sum + ((s as any).entryCount || 0), 0);
  if (totalCovered > 0 && totalCovered < totalMessages) {
    const uncovered = totalMessages - totalCovered;
    return Math.max(2, Math.min(uncovered, totalMessages));
  }
  // Priority 2: 使用 DB 的 getUncompressedMessageCount
  if (uncompressedFromDb >= 0) {
    return Math.max(2, Math.min(uncompressedFromDb, totalMessages));
  }
  // Priority 3: 回退到默认值 8
  return Math.min(totalMessages, 8);
}

/**
 * 根据 dedupRounds 构建时序上下文，严格按消息时间顺序交错排列 summary 和原始消息。
 *
 * 设计原则：
 *   - dedupRounds 是 PRIMARY 控制参数，超出最近 dedupRounds 条消息范围的 summary 和原始消息
 *     都会被主动移除，避免累积挤占上下文窗口。
 *   - 上下文按实际时间顺序排列：可能呈现 [summary] [raw] [summary] [raw] ... 的交错模式。
 *   - trimSummariesToBudget（token 预算裁剪）和级联降级是 SECONDARY 兜底策略。
 *
 * 算法：
 *   1. 如果有 startOrdinal，用其精确构建时序段列表
 *   2. 否则回退：假定所有 summary 覆盖最旧消息，原始消息全在末尾
 *   3. 从最新段向前累加消息数，>= dedupRounds 时停止，丢弃更旧的段
 *   4. 按时间顺序输出最终上下文
 *
 * @param summaries      按 earliestAt ASC 排序的摘要列表
 * @param messages       原始消息数组（按时间顺序）
 * @param dedupRounds    保留的最近消息窗口大小
 * @returns 按时序排列的上下文消息数组
 */
function buildChronologicalContext(
  summaries: Array<{ summaryId: string; content: string; tokenCount: number; entryCount: number; startOrdinal: number | null }>,
  messages: any[],
  dedupRounds: number,
): any[] {
  if (summaries.length === 0) {
    // 无摘要：直接保留最近 dedupRounds 条消息
    return messages.slice(-Math.min(messages.length, dedupRounds));
  }

  const totalMessages = messages.length;

  // 检查是否有 startOrdinal 可用于精确构建时序段
  const hasOrdinals = summaries.every((s) => s.startOrdinal != null);

  type Segment = { type: 'summary'; summary: typeof summaries[0] } | { type: 'raw'; messages: any[]; count: number };

  let segments: Segment[];

  if (hasOrdinals) {
    // ── 精确路径：使用 startOrdinal 构建时序段 ──
    segments = [];
    // 按 startOrdinal 排序确保顺序正确
    const sorted = [...summaries].sort((a, b) => (a.startOrdinal ?? 0) - (b.startOrdinal ?? 0));
    let cursor = 0;

    for (const summary of sorted) {
      const start = summary.startOrdinal!;
      const end = start + summary.entryCount;

      // startOrdinal 之前的原始消息
      if (start > cursor && cursor < totalMessages) {
        const rawSlice = messages.slice(cursor, Math.min(start, totalMessages));
        if (rawSlice.length > 0) {
          segments.push({ type: 'raw', messages: rawSlice, count: rawSlice.length });
        }
      }

      // summary 段
      segments.push({ type: 'summary', summary });
      cursor = Math.min(end, totalMessages);
    }

    // 最后一个 summary 之后的原始消息
    if (cursor < totalMessages) {
      const rawSlice = messages.slice(cursor);
      if (rawSlice.length > 0) {
        segments.push({ type: 'raw', messages: rawSlice, count: rawSlice.length });
      }
    }
  } else {
    // ── 回退路径：假定所有 summary 覆盖最旧消息，原始消息在末尾 ──
    segments = [];
    const totalCovered = summaries.reduce((sum, s) => sum + s.entryCount, 0);
    const uncovered = Math.max(0, totalMessages - totalCovered);

    // 所有 summary 段（按 earliestAt ASC 顺序，即最旧在前）
    for (const summary of summaries) {
      segments.push({ type: 'summary', summary });
    }

    // 末尾的原始消息
    if (uncovered > 0) {
      const rawSlice = messages.slice(-uncovered);
      segments.push({ type: 'raw', messages: rawSlice, count: rawSlice.length });
    }
  }

  // ── 从最新段向前裁剪：保留最近 dedupRounds 条消息 ──
  let cumulative = 0;
  const kept: Segment[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const segCount = seg.type === 'summary' ? seg.summary.entryCount : seg.count;
    const nextCumulative = cumulative + segCount;

    if (nextCumulative < dedupRounds) {
      // 整个段都在窗口内
      cumulative = nextCumulative;
      kept.unshift(seg);
    } else if (cumulative < dedupRounds) {
      // 段跨越 dedupRounds 边界 — 需要部分保留
      if (seg.type === 'raw') {
        // raw 段：只保留落在窗口内的尾部消息
        const overflow = nextCumulative - dedupRounds;
        const trimmedMessages = seg.messages.slice(overflow);
        if (trimmedMessages.length > 0) {
          kept.unshift({ type: 'raw', messages: trimmedMessages, count: trimmedMessages.length });
        }
      } else {
        // summary 段：原子单位，整体保留
        kept.unshift(seg);
      }
      break; // 已到达边界，停止
    }
    // cumulative >= dedupRounds：段已完全在窗口外，停止
    if (cumulative >= dedupRounds) break;
  }

  // ── 按时序输出最终上下文 ──
  const result: any[] = [];
  for (const seg of kept) {
    if (seg.type === 'summary') {
      result.push({
        role: 'user',
        content: seg.summary.content,
        token_count: seg.summary.tokenCount,
      });
    } else {
      result.push(...seg.messages);
    }
  }

  return result;
}

/**
 * v2.7.0 G-U: 构建目标锚定用户消息。
 * 当目标切换后使用防漂移锚点，防止 LLM 回到旧任务。
 * 用户无感知，纯上下文注入。
 */
function buildGoalAnchorMsg(sessionKey: string): Array<{ role: string; content: string }> {
  const goal = getGoal(sessionKey);
  if (!goal) return [];
  const switched = getGoalSwitchCount(sessionKey) > 0;
  const prev = getPreviousGoal(sessionKey);
  const anchor = buildGoalAnchor(goal, switched, prev);
  return [{ role: 'user', content: anchor }];
}

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
  // O2: 缓存 finalMessages token 估算，避免在同一 assemble 内重复计算（节省 2 次 O(n) 遍历）
  let cachedMsgTokens = 0;
  let tier: PressureTier = 'low';
  let retrievalLimits = { qmd: 5, graph: 5, exp: 3 };
  let maxContextChars = 12000;
  let finalMessages = params.messages ?? [];
  // S-12: 大工具负载外部分片 + 存根替换（stubLargeToolPayloads）
  // lossless-claw 兼容：传入 conversationId 以写入 large_files 表，使 lcm_describe / lcm_expand 可检索
  const _stubConfig = resolveStubConfig(ctx.api?.pluginConfig);
  if (_stubConfig.enabled && finalMessages.length > 0) {
    const _stubStart = Date.now();
    const _stubSessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
      : typeof params.session_id === 'string' ? params.session_id : '';
    const _stubConvId = getConversationId(_stubSessionKey);
    const _stubResult = stubLargeToolPayloads(finalMessages, _stubConfig, ctx.logger, _stubConvId);
    finalMessages = _stubResult.messages;
    const _stubMs = Date.now() - _stubStart;
    if (_stubResult.stubbedCount > 0) {
      ctx.logger?.info?.('[assemble] stubLargeToolPayloads done', {
        stubbed: _stubResult.stubbedCount,
        tokensSaved: _stubResult.tokensSaved,
        ms: _stubMs,
        conversationId: _stubConvId ?? 'none',
      });
    }
  }
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

    // Goal Anchoring: 跟踪最新用户意图，防止长对话注意力漂移
    // 评分模型判定：仅明确新问题时更新缓存，续问不覆盖目标
    if (_toolSessionKey) {
      const latestGoal = extractLatestUserGoal(params.messages ?? []);
      if (latestGoal && shouldUpdateGoal(latestGoal, _toolSessionKey)) {
        cacheGoal(_toolSessionKey, latestGoal);
        ctx.logger?.debug?.('[assemble] goal updated', { goal: latestGoal.slice(0, 80) });
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
    ctx.logger.debug?.(`[TOKEN-BUDGET] tokenBudget=${tokenBudget}, estimatedTokens=${estimatedTokens}, model=${modelFullId}`);
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
    const retrievalBase = (ctx.api?.pluginConfig?.retrieval?.limits) as { qmd?: number; graph?: number; exp?: number } | undefined;
    const retrievalBaseLimits = retrievalBase && typeof retrievalBase === 'object'
      ? { qmd: retrievalBase.qmd ?? 5, graph: retrievalBase.graph ?? 5, exp: retrievalBase.exp ?? 3 }
      : undefined;

    // v2.5.2: 接入当前 capability profile 的 retrievalLimits（热更新档次切换）
    // 档次切换走 /internal/capability-profile → setCurrentProfile() → 内存态 _currentProfileId 更新。
    // 每轮 assemble 动态读取 getCurrentProfile()，避免缓存 profile 设置后仍走旧档。
    let profileTierLimits: {
      low: { qmd: number; graph: number; exp: number };
      medium: { qmd: number; graph: number; exp: number };
      high: { qmd: number; graph: number; exp: number };
    } | undefined;
    try {
      const { getCurrentProfile } = await import('../capability-profiles.js');
      profileTierLimits = getCurrentProfile().retrievalLimits;
    } catch { /* module not bundled in some environments, ignore */ }

    const resolvedCtx = resolveContextProfile(providerModelCtx, wm || undefined, retrievalBaseLimits, profileTierLimits);
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
    const _wmConvId = getConversationId(
      typeof params.sessionKey === "string" ? params.sessionKey : "",
      typeof params.session_id === "string" ? params.session_id : "",
    );
    let uncompressedMsgs = -1;
    let needsCompact = false;

    if (wm) {
      uncompressedMsgs = _wmConvId != null ? getUncompressedMessageCount(_wmConvId) : -1;

      // 安全检查：如果 DB 报告的 uncompressed 远大于当前消息数，
      // 可能是 _convIdCache 返回了旧会话的 conversation_id。
      // 失效缓存后重查，确保新会话不被误判为高压。
      if (uncompressedMsgs > msgCount + 10 && msgCount <= 3) {
        const _sk = typeof params.sessionKey === "string" ? params.sessionKey : "";
        const _sid = typeof params.session_id === "string" ? params.session_id : "";
        if (_sk || _sid) {
          invalidateConvIdCache(_sk, _sid);
          const _freshConvId = getConversationId(_sk, _sid);
          if (_freshConvId != null && _freshConvId !== _wmConvId) {
            uncompressedMsgs = getUncompressedMessageCount(_freshConvId);
            ctx.logger?.warn?.('[assemble] detected stale convId cache, invalidated and re-queried', {
              oldConvId: _wmConvId, newConvId: _freshConvId,
              oldUncomp: uncompressedMsgs, msgCount,
            });
          }
        }
      }

      const activeMsgCount = uncompressedMsgs >= 0 ? uncompressedMsgs : msgCount;
      tier = determinePressureTier(activeMsgCount, tokenRatio, {
        dedupRounds: wm.dedupRounds ?? 24,
        highPressureThreshold: wm.highPressureThreshold ?? 0.85,
        mediumPressureThreshold: wm.mediumPressureThreshold ?? 0.70,
      });

      // v2.5.1: 低压基于 retrievalBase（retrieval.limits）→ 中/高压由 config 的
      // retrievalLimits.{medium,high} 覆盖，未显式配时按 resolveContextProfile
      // 给出的默认折扣回退（不再硬编码基于 resolvedCtx.retrievalLimits.low）。
      const tierMedium = wm?.retrievalLimits?.medium
        ? {
          qmd: wm.retrievalLimits.medium.qmd,
          graph: wm.retrievalLimits.medium.graph,
          exp: wm.retrievalLimits.medium.exp,
        }
        : (resolvedCtx as any)._tierMediumDefaultsFromLow;
      const tierHigh = wm?.retrievalLimits?.high
        ? {
          qmd: wm.retrievalLimits.high.qmd,
          graph: wm.retrievalLimits.high.graph,
          exp: wm.retrievalLimits.high.exp,
        }
        : (resolvedCtx as any)._tierHighDefaultsFromLow;
      retrievalLimits = getRetrievalLimitsForTier(tier, {
        low: (resolvedCtx as any)._tierLowDefaults ?? resolvedCtx.retrievalLimits,
        medium: tierMedium,
        high: tierHigh,
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
    // 1b. Token ratio > 0.55 warning + async pre-compaction trigger
    // ==================================================================
    if (tokenRatio > 0.55 && !needsCompact) {
      ctx.logger?.warn?.(
        "window monitor: token ratio above 0.55, triggering async pre-compaction",
        { tokenRatio: Number(tokenRatio.toFixed(3)), effectiveTokenCount, estimatedTokens, contextWindow },
      );
      if (ctx.losslessClawAdapter?.connected) {
        const preCompactSessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
          : typeof params.session_id === 'string' ? params.session_id
          : '';
        const preCompactConversationId = getConversationId(preCompactSessionKey);
        if (preCompactConversationId != null) {
          const _lcSid = params.sessionId != null ? String(params.sessionId)
            : (params.session_id != null ? String(params.session_id) : String(preCompactConversationId));
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

        // 从 lossless-claw adapter 获取摘要（替代本地 SQLite DB）
        // lossless-claw 的 DAG 是单一真相源，本地 DB 的 summaries 表从未被写入
        const _lcSid = params.sessionId != null ? String(params.sessionId)
          : (params.session_id != null ? String(params.session_id) : String(conversationId));
        const _losslessSummaries = await ctx.losslessClawAdapter.getSummaries(_lcSid, 10);
        // 回退：如果 lossless-claw 未返回摘要，尝试本地 DB（兼容旧数据）
        const convSummaries = _losslessSummaries.length > 0
          ? _losslessSummaries
          : getConversationSummaries(conversationId);
        const hasExistingSummary = convSummaries.length > 0;
        const rawCount = messages.length;
        const dedupLimit = (wm as any)?.dedupRounds ?? 24;

        if (tier === 'medium') {
          const _lcSid = params.sessionId != null ? String(params.sessionId)
            : (params.session_id != null ? String(params.session_id) : String(conversationId));
          backgroundTasks.register('compact:medium-tier', ctx.losslessClawAdapter.compact({
            sessionId: _lcSid, sessionKey, sessionFile, force: true,
            tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
            compactionTarget: 'threshold',
          }).then(() => {}, () => {}));

          if (hasExistingSummary) {
            // SECONDARY: token 预算裁剪 — 先裁剪 summary 的 token 总量
            const budgetTrimmed = trimSummariesToBudget(
              convSummaries.map((s) => ({ summaryId: s.summaryId, content: s.content, tokenCount: s.tokenCount })),
              resolvedCtx.compactTokenBudget * maxSummaryRatio,
            );
            // 从原始 convSummaries 中保留 matching 的 summary（保留 entryCount/startOrdinal）
            const budgetSummaries = convSummaries.filter((s) =>
              budgetTrimmed.some((t) => t.summaryId === s.summaryId),
            );
            // PRIMARY: dedupRounds 控制 — 构建时序上下文，自动交错排列 summary + 原始消息
            const chronologicalMsgs = buildChronologicalContext(
              budgetSummaries, messages, dedupLimit,
            );
            // Goal Anchoring
            const goalAnchorMsgs = buildGoalAnchorMsg(sessionKey);
            finalMessages = [...goalAnchorMsgs, ...chronologicalMsgs];
            ctx.logger?.info?.('[assemble:medium] messages replaced with chronological context', {
              originalMsgCount: messages.length,
              keptMsgCount: chronologicalMsgs.length,
              summaryCountBeforeDedup: convSummaries.length,
              summaryCountAfterBudget: budgetSummaries.length,
              dedupRounds: dedupLimit,
            });
          }

          const hasPendingUncompressed = hasUncompressedMessages(conversationId);
          if (rawCount > dedupLimit || hasPendingUncompressed) {
            writeCompactionDebt(
              conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
              'medium_pressure_uncompressed_' + rawCount + '_exceeds_' + dedupLimit,
            );
          }
        } else if (tier === 'high') {
          const _lcSid = params.sessionId != null ? String(params.sessionId)
            : (params.session_id != null ? String(params.session_id) : String(conversationId));

          // ── 压缩降级工具函数：用已有摘要 + 最近消息构建注入上下文 ──
          // aggressiveLevel:
          //   0 (默认) — 摘要 + range-aware 最近消息, 摘要预算 = maxSummaryRatio
          //   1        — 摘要 + range-aware 最近消息, 摘要预算减半
          //   2        — 丢弃摘要, 仅保留 8 条最近消息
          //   3        — 丢弃摘要, 仅保留 4 条最近消息
          const buildDegradedContext = (reason: string, aggressiveLevel: number = 0) => {
            const existingSummaries = convSummaries;
            const goalAnchorMsgs = buildGoalAnchorMsg(sessionKey);

            // Level 2+: 丢弃摘要，仅保留最近消息（硬编码，激进降级）
            if (aggressiveLevel >= 2) {
              const keepCount = aggressiveLevel === 2 ? 8 : 4;
              const recentCount = Math.min(messages.length, keepCount);
              return [...goalAnchorMsgs, ...messages.slice(-recentCount)];
            }

            if (existingSummaries.length > 0) {
              const summaryBudgetRatio = aggressiveLevel === 1
                ? maxSummaryRatio * 0.50
                : maxSummaryRatio;
              // SECONDARY: token 预算裁剪
              const budgetTrimmed = trimSummariesToBudget(
                existingSummaries.map((s) => ({ summaryId: s.summaryId, content: s.content, tokenCount: s.tokenCount })),
                resolvedCtx.compactTokenBudget * summaryBudgetRatio,
              );
              const budgetSummaries = existingSummaries.filter((s) =>
                budgetTrimmed.some((t) => t.summaryId === s.summaryId),
              );
              // PRIMARY: dedupRounds 控制 — 构建时序上下文
              const chronologicalMsgs = buildChronologicalContext(
                budgetSummaries, messages, dedupLimit,
              );
              return [...goalAnchorMsgs, ...chronologicalMsgs];
            }
            // 无摘要时只用最近消息
            const fallbackCount = Math.min(messages.length, aggressiveLevel === 1 ? 8 : 12);
            return [...goalAnchorMsgs, ...messages.slice(-fallbackCount)];
          };

          // ── 级联降级校验：裁剪后估算 token，若仍超安全阈值则逐级升级 ──
          // 安全阈值 = contextWindow - SDK overhead（动态获取，SDK 注入但 assemble 不可见的开销）
          // 预留 20% 给下轮增量 + reserveTokens（原为 30%，过于保守导致频繁降级）
          const safeThreshold = Math.floor((contextWindow - getSdkOverhead(_overheadCacheKey)) * 0.80);
          const applyCascadingDegradation = (baseReason: string): any[] => {
            let result = buildDegradedContext(baseReason, 0);
            for (let level = 0; level < 4; level++) {
              const est = estimateTokensFromMessages(result);
              if (est <= safeThreshold || est <= 0 || level === 3) break;
              ctx.logger?.warn?.(`[assemble] degraded context exceeds safe threshold, escalating to level ${level + 1}`, {
                reason: baseReason,
                estimate: est,
                safeThreshold,
                fromLevel: level,
                toLevel: level + 1,
              });
              result = buildDegradedContext(baseReason, level + 1);
            }
            return result;
          };

          // ── P0: 输入超限保护 —— 当 raw token 超过 LLM 上下文窗口 80% 时，同步 compact 可能超时 ──
          // 原公式 contextWindow * 0.90 - compactTokenBudget 存在逻辑错误：
          // compactTokenBudget 是压缩目标预算（约 59%），不是压缩过程的额外开销。
          // 对于 128K 窗口，原公式得到 41K（仅 32%）就触发降级，过于保守。
          // 修复：直接用 contextWindow 的 80% 作为阈值，消息超过 80% 才跳过同步 compact。
          const inputOverflowThreshold = Math.floor(contextWindow * 0.80);
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
            finalMessages = applyCascadingDegradation('input_overflow');
            markDegraded('high_pressure_input_overflow');

            // 异步触发分段压缩：用渐进式 budget 多次尝试，而非单次调用（单次用相同参数必然再次 overflow）
            const _asyncSid = params.sessionId != null ? String(params.sessionId)
              : (params.session_id != null ? String(params.session_id) : String(conversationId));
            const _overflowBudgets = [
              resolvedCtx.compactTokenBudget,
              Math.floor(resolvedCtx.compactTokenBudget * 0.50),
              Math.floor(resolvedCtx.compactTokenBudget * 0.25),
              Math.floor(resolvedCtx.compactTokenBudget * 0.10),
            ];
            backgroundTasks.register('compact:overflow-retry', (async () => {
              for (const _budget of _overflowBudgets) {
                try {
                  const _r = await ctx.losslessClawAdapter.compact({
                    sessionId: _asyncSid, sessionKey, sessionFile, force: true,
                    tokenBudget: _budget, currentTokenCount: effectiveTokenCount,
                    compactionTarget: 'budget',
                  });
                  if (_r.ok && _r.compacted) {
                    ctx.logger?.info?.('[assemble] overflow retry compact succeeded', { budget: _budget });
                    return;
                  }
                } catch { /* continue to next budget */ }
              }
              ctx.logger?.warn?.('[assemble] overflow retry: all budgets exhausted');
            })().then(() => {}, () => {}));
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
              const freshSummaries = await ctx.losslessClawAdapter.getSummaries(_lcSid, 10);
              if (freshSummaries.length > 0) {
                // SECONDARY: token 预算裁剪
                const budgetTrimmed = trimSummariesToBudget(
                  freshSummaries.map((s) => ({ summaryId: s.summaryId, content: s.content, tokenCount: s.tokenCount })),
                  resolvedCtx.compactTokenBudget * maxSummaryRatio,
                );
                const budgetSummaries = freshSummaries.filter((s) =>
                  budgetTrimmed.some((t) => t.summaryId === s.summaryId),
                );
                // PRIMARY: dedupRounds 控制 — 构建时序上下文
                const chronologicalMsgs = buildChronologicalContext(
                  budgetSummaries, messages, dedupLimit,
                );

                // Goal Anchoring: 压缩时保留原始用户目标，防止任务丢失
                const goalAnchorMsgs = buildGoalAnchorMsg(sessionKey);

                finalMessages = [...goalAnchorMsgs, ...chronologicalMsgs];
                ctx.logger?.info?.('[assemble:high] messages replaced with chronological context', {
                  originalMsgCount: messages.length,
                  keptMsgCount: chronologicalMsgs.length,
                  summaryCountBeforeDedup: freshSummaries.length,
                  summaryCountAfterBudget: budgetSummaries.length,
                  dedupRounds: dedupLimit,
                });

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
                    // 复用 resolveContextProfile 的中/高压默认（已包含 capability profile tier limits 的回退）
                    retrievalLimits = getRetrievalLimitsForTier(tier, {
                      low: (resolvedCtx as any)._tierLowDefaults ?? resolvedCtx.retrievalLimits,
                      medium: (resolvedCtx as any)._tierMediumDefaultsFromLow ?? {
                        qmd: Math.max(1, Math.round(resolvedCtx.retrievalLimits.qmd * 0.6)),
                        graph: Math.max(1, Math.round(resolvedCtx.retrievalLimits.graph * 0.6)),
                        exp: Math.max(0, Math.round(resolvedCtx.retrievalLimits.exp * 0.3)),
                      },
                      high: (resolvedCtx as any)._tierHighDefaultsFromLow ?? { qmd: 1, graph: 1, exp: 0 },
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
                    const _iterSid = params.sessionId != null ? String(params.sessionId)
                      : (params.session_id != null ? String(params.session_id) : String(conversationId));
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
                finalMessages = applyCascadingDegradation('no_summary');
                markDegraded('high_pressure_no_summary');
              }
            } catch (err) {
              ctx.logger?.warn?.('High pressure compact failed, using degraded context', { err: serializeError(err) });
              writeCompactionDebt(
                conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
                'high_pressure_compact_failed',
              );
              // ── P0: 压缩失败降级 —— 用已有摘要 + 最近消息，而非全量继续 ──
              finalMessages = applyCascadingDegradation('compact_failed');
              markDegraded('high_pressure_compact_failed');
            }
          }
        } else {
          writeCompactionDebt(
            conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
            'proactive_' + tier + '_pressure',
          );
          backgroundTasks.register('compact:low-tier', ctx.losslessClawAdapter.compact({
            sessionId: params.sessionId != null ? String(params.sessionId)
              : (params.session_id != null ? String(params.session_id) : String(conversationId)),
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
      ctx.logger?.info?.('[assemble:low-tier] entering low-tier summary path', {
        sessionKey: _sessionKey,
        adapterConnected: ctx.losslessClawAdapter?.connected,
        finalMessagesIdentity: finalMessages === messages,
      });
      const _convId = getConversationId(_sessionKey);
      if (_convId != null) {
        // BUGFIX: 使用与 compact 方法一致的 sessionId 转换逻辑（始终 String()），
        // 避免 SDK 传 number 类型时 typeof === 'string' 检查失败导致 fallthrough
        // 到 getConversationId 返回的本地 DB ID，与 DAG 中存储的 session_id 不匹配，
        // 进而 getConversationForSession 返回 null → getSummaries 永远返回空数组。
        const _lcSid2 = params.sessionId != null ? String(params.sessionId)
          : (params.session_id != null ? String(params.session_id) : String(_convId));
        const _existingSummaries = await ctx.losslessClawAdapter.getSummaries(_lcSid2, 10);
        ctx.logger?.info?.('[assemble:low-tier] getSummaries result', {
          lcSid2: _lcSid2,
          convId: _convId,
          summaryCount: _existingSummaries.length,
          hasSummaries: _existingSummaries.length > 0,
        });
        if (_existingSummaries.length > 0) {
          const _dedupRounds = (wm as any)?.dedupRounds ?? 24;
          // PRIMARY: dedupRounds 控制 — 构建时序上下文，自动交错排列 summary + 原始消息
          const _chronologicalMsgs = buildChronologicalContext(
            _existingSummaries, messages, _dedupRounds,
          );
          // Goal Anchoring: 摘要注入时也保留原始目标
          const _goalAnchorMsgs = buildGoalAnchorMsg(_sessionKey);
          finalMessages = [..._goalAnchorMsgs, ..._chronologicalMsgs];
          ctx.logger?.info?.('[assemble:low-tier] messages replaced with chronological context', {
            originalMsgCount: messages.length,
            keptMsgCount: _chronologicalMsgs.length,
            summaryCountBeforeDedup: _existingSummaries.length,
            dedupRounds: _dedupRounds,
            goalAnchorCount: _goalAnchorMsgs.length,
            finalMsgCount: finalMessages.length,
          });

          // ── 低压力路径裁剪后校验 ──
          // SDK precheck 会追加 system prompt + tools 等大量额外开销（可达 60-90K tokens），
          // 仅看消息 token 不足以判断是否会溢出。当消息 token 超安全阈值时，
          // 级联降级：丢弃摘要 → 减少最近消息数，确保总 prompt 不超模型窗口。
          // 原阈值 0.25 过于保守：system prompt + tools + overhead 通常只占 15-25%，
          // 消息应该能占到 50-60%。提高到 0.50 以充分利用上下文窗口。
          const _fullEstimate = estimateTokensFromMessages(finalMessages);
          const _safeThreshold = Math.floor((contextWindow - getSdkOverhead(_overheadCacheKey)) * 0.50);
          if (_fullEstimate > _safeThreshold || msgCount > 100) {
            ctx.logger?.warn?.('[assemble] low-tier context exceeds safe threshold, applying cascading trim', {
              fullEstimate: _fullEstimate,
              safeThreshold: _safeThreshold,
              msgCount,
              contextWindow,
              summaryCount: _existingSummaries.length,
            });

            // 级联降级：丢弃摘要，仅保留最近消息
            const _cascadeLevels = [8, 4, 2];
            let _trimmed = false;
            for (const _keepCount of _cascadeLevels) {
              const _recentMsgs = messages.slice(-Math.min(messages.length, _keepCount));
              const _testMessages = [..._goalAnchorMsgs, ..._recentMsgs];
              const _testEstimate = estimateTokensFromMessages(_testMessages);
              if (_testEstimate <= _safeThreshold || _keepCount === _cascadeLevels[_cascadeLevels.length - 1]) {
                finalMessages = _testMessages;
                _trimmed = true;
                ctx.logger?.info?.('[assemble] low-tier cascading trim applied', {
                  keepCount: _keepCount,
                  estimate: _testEstimate,
                  safeThreshold: _safeThreshold,
                });
                break;
              }
              ctx.logger?.warn?.('[assemble] low-tier cascading trim: still too large, reducing further', {
                keepCount: _keepCount,
                estimate: _testEstimate,
                safeThreshold: _safeThreshold,
              });
            }
            if (_trimmed) {
              markDegraded('low_tier_cascading_trim');
            }
          }
        } else {
          // BUGFIX: 当 DAG 中无 summary 但消息数较多时（如 DAG 已压缩但无 summary、
          // 或 sessionId 类型不匹配导致 getSummaries 返回空），不能原样发送全部消息。
          // 否则 SDK 会因为上下文过大触发 auto-compaction → 死循环 → "could not recover"。
          // 降级策略：保留最近消息 + 目标锚定，丢弃旧消息防止上下文溢出。
          const _msgCountForFallback = messages.length;
          if (_msgCountForFallback > 20) {
            const _goalAnchorMsgs = buildGoalAnchorMsg(_sessionKey);
            const _fallbackKeep = Math.min(_msgCountForFallback, 8);
            finalMessages = [..._goalAnchorMsgs, ...messages.slice(-_fallbackKeep)];
            // BUGFIX: low_tier_no_summary_fallback 是低压力路径的正常行为
            // （summaries 尚未生成时采用消息裁剪兜底），不应计入降级率。
            // 修复前 markDegraded 导致每次无 summary 的 assemble 都被计为降级，
            // 多轮对话中降级率恒为 100%。
            ctx.logger?.warn?.('[assemble:low-tier] no summaries available, applying message trimming fallback', {
              originalMsgCount: _msgCountForFallback,
              keptMsgCount: _fallbackKeep,
              goalAnchorCount: _goalAnchorMsgs.length,
              finalMsgCount: finalMessages.length,
              lcSessionId: _lcSid2,
              convId: _convId,
            });
          }
        }
      }
    } else {
      ctx.logger?.info?.('[assemble:low-tier] skipped — conditions not met', {
        finalMessagesSameObject: finalMessages === messages,
        adapterConnected: ctx.losslessClawAdapter?.connected,
        hasAdapter: !!ctx.losslessClawAdapter,
      });
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
    // O2: 缓存 finalMessages token 估算，后续步骤复用（节省 2 次 O(n) 遍历，各 30-50ms）
    cachedMsgTokens = estimateTokensFromMessages(finalMessages);
    ctx.logger?.info?.(`⚡ assemble=${Date.now()-assembleStart}ms | init=${initMs}ms | parallel=${parallelMs}(L2_qmd=${l2_ms},L3_graph=${l3_ms},L4_exp=${l4_ms}) | mg=${mgMs}ms | estimatedTokens=${cachedMsgTokens}/${contextWindow}(${(cachedMsgTokens/contextWindow*100).toFixed(1)}%) | overhead=${overheadTokens} | effectiveTokenCount=${effectiveTokenCount} | msgCount=${msgCount} | uncomp=${uncompressedMsgs} | tier=${tier}`, {
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
      finalEstimate: cachedMsgTokens,
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
    retrievalOutput.extractedEntities,
    retrievalOutput.queryRewriteResult,
    );

    systemPromptAddition = injectionOutput.systemPromptAddition;
    expResults = injectionOutput.expResults;

    // ==================================================================
    // 4.5 MoA (Mixture of Agents) 管道
    // 仅复杂任务 + 启用 tiers 时触发
    // 参考模型并行发散 → 聚合模型收敛裁决 → 结果存入缓存供 lcmg_moa_reply 工具读取
    //
    // 注意：复杂度评估和记录在 try 块外执行，确保每轮都记录，不因 MoA 失败而丢失
    // ==================================================================

    // ── 复杂度评估（始终执行，与 MoA 启用/失败无关） ──
    let complexityScore = 0;
    let complexityReasons: string[] = [];

    // ── /moa 命令变量（在 try 块外声明，供 MoA pipeline 使用） ──
    let forceMoa = false;
    let cleanedQuery = '';
    let moaPresetOverride: string | undefined;
    let classificationContext = '';
    // MoA 收益基准决策结果（在复杂度评估阶段计算，供触发判断与日志使用）
    let moaDecision: import('../moa/complexity.js').MoaDecision | undefined;

    try {
      const moaConfig = (ctx.api?.pluginConfig as any)?.moa;
      const { computeTaskComplexity, decideMoa, DEFAULT_BENEFIT_THRESHOLD, DEFAULT_COST_SENSITIVITY } = await import('../moa/complexity.js');
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

      // ── /moa 命令：显式强制触发 MoA（跳过复杂度阈值） ──
      // 支持 /moa、/moa force、/moa <preset-name>
      forceMoa = false;
      cleanedQuery = queryText;
      moaPresetOverride = undefined;
      const moaCmdMatch = queryText.match(/^\/moa(?:\s+(\S+))?/i);
      if (moaCmdMatch) {
        forceMoa = true;
        const subCmd = (moaCmdMatch[1] || '').trim().toLowerCase();
        if (subCmd === 'force' || subCmd === 'status') {
          // /moa force 或 /moa status — 不切预设
          cleanedQuery = queryText.replace(/^\/moa\s+\S+\s*/i, '').trim();
          if (!cleanedQuery) cleanedQuery = queryText;
        } else if (subCmd && subCmd !== '') {
          // /moa <preset-name> — 切换到指定预设
          moaPresetOverride = subCmd;
          cleanedQuery = queryText.replace(/^\/moa\s+\S+\s*/i, '').trim();
          if (!cleanedQuery) cleanedQuery = queryText;
        } else {
          // /moa — 用当前预设强制触发
          cleanedQuery = queryText.replace(/^\/moa\s*/i, '').trim();
          if (!cleanedQuery) cleanedQuery = queryText;
        }
        ctx.logger?.info?.('[assemble] /moa command detected, forcing MoA', {
          preset: moaPresetOverride ?? 'current',
          originalLen: queryText.length,
          cleanedLen: cleanedQuery.length,
        });
      }

      const complexity = computeTaskComplexity(
        queryText,
        finalMessages,
        retrievalOutput.scenario ?? null,
        tier,
      );
      complexityScore = complexity.score;
      complexityReasons = complexity.reasons;

      // 记录全量复杂度评分（每轮 assemble 都记录，无论 MoA 是否启用/触发）
      recordAllComplexity(complexity.score);

      // ── 自动分类：根据用户输入确定任务领域，生成分类上下文补充到参考模型 prompt ──
      // 注意：自动分类不覆盖模型选择，仅补充领域上下文帮助参考模型聚焦分析方向；
      // 分类结果同时用于收益基准决策的 domainFit（任务适配度）
      classificationContext = '';
      let moaTask: string | undefined;
      if (!moaPresetOverride && moaConfig?.enabled) {
        try {
          const { classifyTaskType } = await import('../moa/classifier.js');
          const classification = classifyTaskType(queryText);
          if (classification.preset && classification.confidence >= 0.5) {
            moaTask = classification.preset;
            classificationContext = classification.context ?? '';
            if (classificationContext) {
              ctx.logger?.info?.('[assemble] Auto-classified task domain, context injected', {
                preset: classification.preset,
                confidence: classification.confidence,
                reasons: classification.reasons,
              });
            }
          }
        } catch {
          // 分类器加载失败，不影响主流程
        }
      }

      // ── 收益基准决策：结合主模型能力 + 聚合后能力 + 复杂度 + 本地/远程成本，判断 MoA 是否值得 ──
      // 只有当 MoA 相较"直接主模型单次回答"能带来 ≥benefitThreshold 的净质量提升时才触发，
      // 避免 MoA 的模型消耗与时间开销反而超过非 MoA 场景。
      moaDecision = undefined;
      if (moaConfig?.enabled
          && Array.isArray(moaConfig?.referenceModels)
          && moaConfig.referenceModels.length >= 2) {
        try {
          moaDecision = decideMoa({
            complexity,
            mainModel: modelFullId || (ctx.api?.pluginConfig as any)?.llmProvider?.model || 'default',
            mainModelProvider: (ctx.api?.pluginConfig as any)?.llmProvider?.provider,
            mainModelBaseURL: (ctx.api?.pluginConfig as any)?.llmProvider?.baseURL,
            referenceModels: (moaConfig.referenceModels ?? []).map((r: any) => ({ model: r?.model, provider: r?.provider, baseURL: r?.baseURL })),
            aggregatorModel: moaConfig.aggregatorModel ? { model: moaConfig.aggregatorModel.model, provider: moaConfig.aggregatorModel.provider, baseURL: moaConfig.aggregatorModel.baseURL } : null,
            task: moaTask,
            tokenCosts: moaConfig?.tokenCosts,
            configThreshold: moaConfig?.complexityThreshold ?? 0.6,
            referenceModelCount: moaConfig.referenceModels.length,
            baseBenefitThreshold: moaConfig?.benefitThreshold ?? DEFAULT_BENEFIT_THRESHOLD,
            thresholdCostSensitivity: moaConfig?.thresholdCostSensitivity ?? DEFAULT_COST_SENSITIVITY,
          });
        } catch {
          // 决策模块异常时回退到旧阈值逻辑（不阻断 MoA pipeline）
          moaDecision = undefined;
        }
      }

      ctx.logger?.info?.('[assemble] MoA complexity check', {
        score: complexity.score,
        threshold: moaConfig?.complexityThreshold ?? 0.6,
        benefitThreshold: moaConfig?.benefitThreshold ?? DEFAULT_BENEFIT_THRESHOLD,
        reasons: complexity.reasons,
        tier,
        triggerMoA: moaDecision?.trigger ?? (complexity.score >= (moaConfig?.complexityThreshold ?? 0.6)),
        decision: moaDecision ? {
          mainModelStrength: moaDecision.mainModelStrength.toFixed(3),
          aggregateStrength: moaDecision.aggregateStrength.toFixed(3),
          capabilityGap: moaDecision.capabilityGap.toFixed(3),
          effectiveThreshold: moaDecision.effectiveThreshold.toFixed(3),
          expectedUplift: moaDecision.expectedUplift.toFixed(3),
          costPenalty: moaDecision.costPenalty.toFixed(3),
          netValue: moaDecision.netValue.toFixed(3),
        } : undefined,
      });
    } catch {
      // 复杂度评估模块加载失败，不影响主流程
    }

    // ── MoA pipeline 执行（仅启用时） ──
    // v2.3.0: 拆分同步参考层 + 异步聚合层，避免对话超时
    // Phase 1: runMoaRefsSync（同步，带时间预算）
    // Phase 2: dispatchMoaAggregator（异步后台执行）
    // 结果通过 lcmg_moa_reply 工具在当前轮或下一轮返回
    try {
      const moaConfig = (ctx.api?.pluginConfig as any)?.moa;

      if (moaConfig?.enabled
          && Array.isArray(moaConfig?.referenceModels)
          && moaConfig.referenceModels.length >= 2
          && moaConfig.referenceModels.length <= 4
          && moaConfig.enabledTiers?.includes(tier)) {

        const { runMoaRefsSync, dispatchMoaAggregator, buildMoaToolInstruction, peekMoaResultCache } = await import('../moa/orchestrator.js');

        // 检查是否有上一轮异步聚合的缓存结果
        const cachedResult = peekMoaResultCache();

        // 注入上一轮的缓存结果（如果有）—— 与当前轮 MoA 独立，互不阻塞
        if (cachedResult) {
          ctx.logger?.info?.('[assemble] MoA cached result available from previous round');
          systemPromptAddition = buildMoaToolInstruction() + '\n\n' + systemPromptAddition;
        }

        // 当前轮触发 MoA（收益基准决策达标；/moa 命令强制触发不受阈值约束）
        const shouldTriggerMoa = forceMoa || (moaDecision?.trigger ?? (complexityScore >= moaConfig.complexityThreshold));
        if (shouldTriggerMoa) {
          ctx.logger?.info?.('[assemble] MoA triggered (async split)', {
            complexity: complexityScore,
            reasons: forceMoa ? ['/moa command'] : (moaDecision?.reasons ?? complexityReasons),
            forceMoa,
            mode: moaConfig.mode,
            refCount: moaConfig.referenceModels?.length ?? 0,
            syncBudgetMs: moaConfig.syncBudgetMs ?? 240_000,
            decision: moaDecision ? {
              mainModelStrength: moaDecision.mainModelStrength,
              effectiveThreshold: moaDecision.effectiveThreshold,
              expectedUplift: moaDecision.expectedUplift,
              costPenalty: moaDecision.costPenalty,
              netValue: moaDecision.netValue,
            } : undefined,
          });

            // 提取查询文本（/moa 命令时使用清理后的文本）
            const queryText = forceMoa ? cleanedQuery : (() => {
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

            // 构建对话上下文（最近 3 轮用户/助手消息，帮助聚合模型理解讨论背景）
            const conversationContext = (() => {
              const recent = finalMessages.slice(-6);
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

            // 获取 sessionKey
            const moaSessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
              : typeof params.session_id === 'string' ? params.session_id
              : `moa-${Date.now()}`;

            // Phase 1: 同步执行参考模型层（带时间预算）
            const refsResult = await runMoaRefsSync({
              query: queryText,
              retrievalContext,
              conversationContext,
              config: moaConfig,
              api: ctx.api,
              logger: ctx.logger,
              signal,
              complexityScore,
              classificationContext,
            }, moaSessionKey, moaConfig.syncBudgetMs ?? 240_000);

            if (refsResult.completed) {
              // Phase 2: 异步调度聚合模型层
              dispatchMoaAggregator(moaSessionKey, ctx.logger, signal);

              // 注入 MoA 工具调用指令（主模型会尝试调用 lcmg_moa_reply）
              // 如果聚合已完成 → 直接返回结果
              // 如果聚合未完成 → 返回 pending 状态，提示用户稍后继续
              systemPromptAddition = buildMoaToolInstruction() + '\n\n' + systemPromptAddition;

              ctx.logger?.info?.('[assemble] MoA refs completed, aggregator dispatched async', {
                sessionKey: moaSessionKey,
              });
            } else {
              ctx.logger?.warn?.('[assemble] MoA refs sync failed, falling back to normal flow', {
                error: refsResult.error,
              });
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

    // Smart Tool Guidance: 仅当上下文有足够余量时才注入
    // SDK 的 compact prompt surface 已占用 ~55K tok，额外注入会加剧溢出风险
    // O2: 复用 cachedMsgTokens（cleanup 仅移除 reasoning 字段，token 差异 <1%）
    const _msgTokens = cachedMsgTokens;
    const _hasBudgetForGuidance = _msgTokens < (contextWindow - getSdkOverhead(_overheadCacheKey)) * 0.50;

    if (_hasBudgetForGuidance && typeof modelFullId === 'string' && (modelFullId.startsWith('ollama/') || modelFullId.startsWith('ollama-256k/'))
        && availableTools.length > 0) {
      const smartGuidance = buildSmartToolGuidance(
        tier, retrievalOutput.scenario ?? null, availableTools, _toolSessionKey,
      );
      if (smartGuidance) {
        systemPromptAddition += '\n\n' + smartGuidance;
      }
    }

    // Smart Tool Guidance: 通用模型（非 ollama）也使用场景驱动工具注入
    if (_hasBudgetForGuidance && (typeof modelFullId !== 'string' || (!modelFullId.startsWith('ollama/') && !modelFullId.startsWith('ollama-256k/')))) {
      if (availableTools.length > 0) {
        const smartGuidance = buildSmartToolGuidance(
          tier, retrievalOutput.scenario ?? null, availableTools, _toolSessionKey,
        );
        if (smartGuidance && systemPromptAddition.length > 0) {
          systemPromptAddition += '\n\n' + smartGuidance;
        }
      }
    }

    // CE Scene Guidance: 场景感知引导（配合 SDK toolSearch 机制）
    // 仅当上下文有足够余量 + 非高压力时才注入
    if (tier !== 'high' && _hasBudgetForGuidance) {
      try {
        const scenario = detectScenario({
          messages: finalMessages,
          tier,
          availableTools,
        });
        const mode = detectToolSearchMode(availableTools);
        const result = buildModeAwareGuidance(mode, scenario, availableTools);
        if (result) {
          const label = SCENARIO_LABELS[scenario] ?? scenario;
          systemPromptAddition += `\n\n[CE] 场景: ${label} | 模式: ${result.modeLabel}\n${result.guidance}`;
        }
      } catch (err) {
        // 场景引导注入失败不阻塞 assemble
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
    // O2: 复用 cachedMsgTokens（cleanup 仅移除 reasoning 字段，token 差异 <1%）
    let messageTokens = cachedMsgTokens;
    let additionTokens = 0;
    if (typeof systemPromptAddition === "string" && systemPromptAddition.length > 0) {
      additionTokens = estimateTokensFromText(systemPromptAddition);
    }
    setOverhead(_overheadCacheKey, additionTokens);

    // 反推 SDK overhead 并缓存，供下一轮 safeThreshold 计算使用
    // 优先级：SDK 传入 > reserveTokens 反推 > 跳过（使用默认值/历史值）
    const _contextUsage = (params as any).contextUsage
      ?? (params as any).promptTokens
      ?? (params as any).estimatedPromptTokens;
    if (_contextUsage != null && typeof _contextUsage === 'number' && _contextUsage > 0) {
      updateSdkOverhead(_overheadCacheKey, _contextUsage, messageTokens, additionTokens);
    } else if (contextWindow > 0) {
      // 备用方案：SDK 未传 contextUsage 时，用 contextWindow 减去 reserveTokens
      // 反推 SDK 可用预算 = contextWindow - reserveTokens，
      // 如果 assemble 输出（消息+addition）仍远小于 SDK 报的 overflow 值，
      // 说明 SDK 有大量隐含开销。用 conservative 估算：
      // SDK overhead ≈ contextWindow * 0.45（根据实测 ~58K/131K ≈ 44%）
      // 此值仅为首轮使用，后续轮次会被 updateSdkOverhead 覆盖
    }

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