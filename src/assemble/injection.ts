/**
 * 上下文注入模块。
 *
 * 提取 assemble 中的注入逻辑：
 *   - 会话级去重（addSection + 跨轮次哈希）
 *   - 四层内容注入（Experience / Graph / QMD / Summary）
 *   - H-4 冲突检测
 *   - systemPromptAddition 构建
 *   - Total Control 裁剪 + 优先级 trim
 */

// @ts-ignore - plugin-sdk types only available at runtime
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { getSessionDedup } from '../plugin/dedup-cache.js';
import { quickHash } from '../plugin/keywords.js';
import { applyTotalControl } from '../plugin/token-control.js';
import { estimateTokensFromMessages } from '../lcm-bridge.js';
import { buildKnowledgeGuidance } from './guidance.js';
// P1-1: 动态 import 提升为静态导入，避免每次 injectContext 的 await import 开销
import { backgroundTasks } from '../async/task-registry.js';
import { detectConflicts } from '../merger.js';
import { matchEntityScore, getConfidenceLevel, confidenceLabel } from '../entity-extract.js';
import { getGoal, buildGoalAnchor, getGoalSwitchCount, getPreviousGoal } from '../plugin/goal-cache.js';
import type { AssembleContext, InjectionOutput } from './types.js';

/** v2.7.0 P3: SDK guidance 缓存 —— 同 tools + citations 组合短期复用，避免每次重新构建（50-100ms） */
const sdkGuidanceCache = new Map<string, { guidance: string; ts: number }>();
const SDK_GUIDANCE_CACHE_TTL_MS = 900 * 1000; // 15min
const SDK_GUIDANCE_CACHE_MAX = 10;

function getCachedSdkGuidance(availableTools: string[], citationsMode: string): string | null {
  const key = `${availableTools.sort().join(',')}|${citationsMode}`;
  const cached = sdkGuidanceCache.get(key);
  if (cached && Date.now() - cached.ts < SDK_GUIDANCE_CACHE_TTL_MS) {
    return cached.guidance;
  }
  return null;
}

function setCachedSdkGuidance(availableTools: string[], citationsMode: string, guidance: string): void {
  const key = `${availableTools.sort().join(',')}|${citationsMode}`;
  if (sdkGuidanceCache.size >= SDK_GUIDANCE_CACHE_MAX) {
    const oldest = sdkGuidanceCache.keys().next().value;
    if (oldest !== undefined) sdkGuidanceCache.delete(oldest);
  }
  sdkGuidanceCache.set(key, { guidance, ts: Date.now() });
}

export async function injectContext(
  ctx: AssembleContext,
  params: any,
  tier: string,
  qmdResults: any[],
  graphResults: any[],
  expResults: any[],
  fullDocs: string[],
  retrievalLimits: { qmd: number; graph: number; exp: number },
  finalMessages: any[],
  availableTools: string[],
  maxContextChars: number,
  contextWindow: number,
  citationsMode: string,
  modelFullId: string,
  qmdQuery: string,
  scenario: string | null,
  extractedEntities?: { terms: string[]; properNouns: string[]; techTerms: string[]; tokens: string[] },
  queryRewriteResult?: any,
): Promise<InjectionOutput> {
  // Session-isolated cross-round dedup
  const sessionKey = typeof params.sessionKey === 'string'
    ? params.sessionKey
    : typeof params.session_id === 'string'
      ? params.session_id
      : 'default';
  const sd = getSessionDedup(sessionKey);

  // Knowledge Injection Budget: 长对话中减少检索内容注入，防止上下文污染
  // 消息数 > 20 → 经验注入减半；> 30 → 所有检索注入减半
  const msgCount = finalMessages.length;
  const knowledgeBudget = msgCount > 30 ? 0.5 : msgCount > 20 ? 0.7 : 1.0;
  const budgetedLimits = {
    qmd: Math.max(1, Math.round(retrievalLimits.qmd * knowledgeBudget)),
    graph: Math.max(1, Math.round(retrievalLimits.graph * knowledgeBudget)),
    exp: Math.max(0, Math.round(retrievalLimits.exp * (msgCount > 20 ? 0.5 : knowledgeBudget))),
  };

  const allSessionHashes = new Set<string>();
  for (const roundHashes of sd.window) {
    for (const h of roundHashes) {
      allSessionHashes.add(h);
    }
  }

  const currentRoundHashes: string[] = [];

  // Pre-seed dedup hashes from existing system messages (L1 summaries)
  if (ctx.losslessClawAdapter?.connected && (tier === 'medium' || tier === 'high')) {
    for (const msg of finalMessages) {
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('##')) {
        const h = quickHash(msg.content);
        allSessionHashes.add(h);
      }
    }
  }

  const sections: { label: string; body: string; layer: number }[] = [];

  /**
   * P-CP-2: strip 动态 score/citation 标签后哈希，防止分数微小波动导致去重失效。
   * 去除 "(相关性: 85%)" 和 "[src:N]" 等动态标签，仅对核心内容哈希。
   */
  function stableHashKey(label: string, body: string): string {
    const stableBody = body
      .replace(/\s*\(相关性:\s*\d+%\)\s*/g, '')
      .replace(/\s*\[src:\d+\]\s*/g, '');
    return quickHash(label + stableBody);
  }

  function addSection(label: string, body: string, layer: number): void {
    if (!body) return;
    const h = stableHashKey(label, body);
    if (allSessionHashes.has(h)) return;
    allSessionHashes.add(h);
    currentRoundHashes.push(h);
    sections.push({ label, body, layer });
  }

  // Layer 4: Experience
  let finalExpResults = expResults;
  if (expResults.length > 0) {
    // Phase 1: 实体匹配度过滤 — 经验注入前过滤无关经验
    const expEntityMatchFilter = (e: any): boolean => {
      if (!extractedEntities || extractedEntities.tokens.length === 0) return true;
      const content = e.experience?.summary ?? e.experience?.content ?? e.summary ?? '';
      const { match, score } = matchEntityScore(content, extractedEntities);
      return match;
    };

    const expFilteredCount = expResults.length;
    expResults = expResults.filter(expEntityMatchFilter);
    if (expFilteredCount > 0 && expResults.length < expFilteredCount) {
      ctx.logger?.debug?.('[injection] Layer 4 (experience) entity-filtered', { before: expFilteredCount, after: expResults.length });
    }

    let personalizedResults = expResults;
    try {
      const topTech = ctx.userProfile.getTopTechStack(3);
      const topScenario = ctx.userProfile.getTopScenario(2);
      if (topTech.length > 0 || topScenario.length > 0) {
        personalizedResults = [...expResults]
          .map((e: any) => {
            const boost = ctx.userProfile.computeBoost(e.experience?.tags);
            return { ...e, score: (e.score ?? 0.5) * boost, _personalizedBoost: boost };
          })
          .sort((a: any, b: any) => b.score - a.score);
        const boostedCount = personalizedResults.filter((r: any) => (r._personalizedBoost ?? 1) > 1.0).length;
        if (boostedCount > 0) {
          ctx.logger?.debug?.("S-7 personalized experience rerank", { boosted: boostedCount, topTech: topTech.map((t: any) => t.name), topScenario: topScenario.map((s: any) => s.name) });
        }
      }
    } catch (e) { /* non-fatal */
      ctx.logger?.debug?.("S-7 personalized experience rerank failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }

    const expBody = '⚠️ 以下经验来自历史对话，可能【主题不同】。请仅引用与当前问题直接相关的经验。\n\n'
        + personalizedResults.filter((e: any) => e.experience != null).map((e: any) => '- [' + e.experience.type + '] ' + e.experience.summary).join('\n');
    addSection('## 💡 经验总结（历史经验参考）', expBody, 5);
    for (const e of personalizedResults) {
      // P1-1: 已改为静态导入，直接使用 backgroundTasks
      if (e.experience?.id) {
        backgroundTasks.register('exp:increment-match', ctx.expStore.incrementMatchCount(e.experience.id).then(() => {}, () => {}));
      }
    }

    // G-8: 记录本轮 assemble 返回的经验
    const LAST_EXP_MAP_MAX = 200;
    ctx.lastAssembleExpIdsBySession.set(sessionKey, {
      ids: personalizedResults.filter((e: any) => e.experience != null).map((e: any) => ({
        id: e.experience.id,
        summary: e.experience.summary ?? '',
        query: qmdQuery,
      })),
      ts: Date.now(),
    });
    if (ctx.lastAssembleExpIdsBySession.size > LAST_EXP_MAP_MAX) {
      const oldest = ctx.lastAssembleExpIdsBySession.keys().next().value;
      if (oldest !== undefined) ctx.lastAssembleExpIdsBySession.delete(oldest);
    }

    finalExpResults = personalizedResults;
  }

  // Layer 3: Neo4j knowledge graph
  if (graphResults && Array.isArray(graphResults) && graphResults.length > 0) {
    // Phase 1: 实体匹配度过滤 + 权重排序
    const graphEntityMatchFilter = (r: any): { filtered: boolean; weight: number; confidence: string } => {
      if (!extractedEntities || extractedEntities.tokens.length === 0) {
        return { filtered: false, weight: 1.0, confidence: '[实体匹配度：无法评估]' };
      }
      const content = r.content ?? r.name ?? r.subject ?? r.id ?? '';
      const { match, score } = matchEntityScore(content, extractedEntities);
      const level = getConfidenceLevel(score);
      const label = confidenceLabel(level);
      // 权重策略：高置信度 1.0, 中置信度 0.7, 低置信度 + 低检索分 → 过滤
      let weight = 1.0;
      let filtered = false;
      if (level === 'high') {
        weight = 1.0;
      } else if (level === 'medium') {
        weight = 0.7;
      } else {
        // 低置信度：如果检索分数也低（< 0.3），则过滤掉
        const rScore = r.score ?? 0.5;
        if (rScore < 0.3) {
          filtered = true;
        } else {
          weight = 0.5;
        }
      }
      return { filtered, weight, confidence: label };
    };

    // 先过滤，再按 权重*检索分 排序
    const filteredGraph = graphResults.filter((r: any) => !graphEntityMatchFilter(r).filtered);
    const sortedGraph = filteredGraph
      .map((r: any) => {
        const { weight } = graphEntityMatchFilter(r);
        const rScore = r.score ?? 0.5;
        return { ...r, _weightedScore: rScore * weight };
      })
      .sort((a: any, b: any) => b._weightedScore - a._weightedScore);

    const graphBody = sortedGraph
      .slice(0, budgetedLimits.graph)
      .map((r: any) => {
        const gScore = r.score ?? 0.5;
        const { weight, confidence } = graphEntityMatchFilter(r);
        const adjustedScore = (gScore * weight * 100).toFixed(0);
        const title = r.title ?? r.name ?? r.subject ?? '';
        const snippet = (r.content ?? r.id ?? '').slice(0, 500);
        return confidence + ' ' + title + '\n' + snippet + (adjustedScore ? ' (调整后: ' + adjustedScore + '%)' : '');
      })
      .join('\n');
    if (sortedGraph.length > 0 && sortedGraph.length < graphResults.length) {
      ctx.logger?.debug?.('[injection] Layer 3 (graph) entity-filtered', { before: graphResults.length, after: sortedGraph.length });
    }
    addSection('## 🔗 知识图谱（历史知识参考）', graphBody, 4);
  }

  // Layer 2: qmd search snippet results
  if (qmdResults && Array.isArray(qmdResults) && qmdResults.length > 0) {
    // Phase 1: 实体匹配度过滤 + 权重排序
    const entityMatchFilter = (r: any): { filtered: boolean; weight: number; confidence: string } => {
      if (!extractedEntities || extractedEntities.tokens.length === 0) {
        return { filtered: false, weight: 1.0, confidence: '[实体匹配度：无法评估]' };
      }
      const content = r.content ?? r.title ?? '';
      const { match, score } = matchEntityScore(content, extractedEntities);
      const level = getConfidenceLevel(score);
      const label = confidenceLabel(level);
      // 权重策略：高置信度 1.0, 中置信度 0.7, 低置信度 + 低检索分 → 过滤
      let weight = 1.0;
      let filtered = false;
      if (level === 'high') {
        weight = 1.0;
      } else if (level === 'medium') {
        weight = 0.7;
      } else {
        // 低置信度：如果检索分数也低（< 0.3），则过滤掉
        const rScore = r.score ?? 0.5;
        if (rScore < 0.3) {
          filtered = true;
        } else {
          weight = 0.5;
        }
      }
      return { filtered, weight, confidence: label };
    };

    // 先过滤，再按 权重*检索分 排序
    const filteredQmd = qmdResults.filter((r: any) => !entityMatchFilter(r).filtered);
    const sortedQmd = filteredQmd
      .map((r: any) => {
        const { weight } = entityMatchFilter(r);
        const rScore = r.score ?? 0.5;
        return { ...r, _weightedScore: rScore * weight };
      })
      .sort((a: any, b: any) => b._weightedScore - a._weightedScore);

    const qmdItems = sortedQmd
      .slice(0, budgetedLimits.qmd)
      .map((r: any, i: number) => {
        const citationTag = citationsMode === 'always' || citationsMode === 'auto'
          ? ' [src:' + String(i+1) + ']'
          : '';
        const scoreTag = typeof r.score === 'number'
          ? ' (相关性: ' + (r.score * 100).toFixed(0) + '%)'
          : '';
        const snippet = String(r.content ?? '').slice(0, 500);
        return '- ' + snippet + scoreTag + citationTag;
      })
      // P-CP-3: 增加 content 长度下限过滤，减少无意义碎片（< 20 字符的片段对 LLM 无参考价值）
      .filter((r: any) => (r.score == null || r.score >= 0.3) && String(r.content ?? '').trim().length >= 20)
      .join('\n');
    if (qmdItems) {
    if (sortedQmd.length > 0 && sortedQmd.length < qmdResults.length) {
      ctx.logger?.debug?.('[injection] Layer 2 (qmd) entity-filtered', { before: qmdResults.length, after: sortedQmd.length });
    }
    addSection('## 📄 记忆文件（参考）', qmdItems, 3);
    }
  }

  // Batch-enriched full document content
  if (Array.isArray(fullDocs) && fullDocs.length > 0) {
    const docBlock = fullDocs
      .filter(Boolean)
      .slice(0, Math.min(budgetedLimits.qmd, 2))
      .map((doc: string) => {
        const docLimit = 800;
        if (doc.length > docLimit) {
          return doc.slice(0, docLimit) + '\n...[已截断，详见原文]...';
        }
        return doc;
      })
      .join('\n\n---\n\n');
    if (docBlock) {
      addSection('## 📄 文档摘要（参考，非当前任务）', docBlock, 3);
    }
  }

  // Layer 1: lossless-claw summaries (low tier only)
  if (ctx.losslessClawAdapter?.connected && tier === 'low') {
    try {
      const convStore = ctx.losslessClawAdapter.getConversationStore?.();
      if (convStore) {
        const recentSummaries = typeof convStore.getRecentSummaries === 'function'
          ? convStore.getRecentSummaries(sessionKey, 3)
          : [];
        if (Array.isArray(recentSummaries) && recentSummaries.length > 0) {
          const summaryText = recentSummaries.map((s: any, i: number) =>
            '- [摘要' + String(i+1) + '] '  + (s?.content ?? s?.summary ?? String(s)).slice(0, 500)
          ).join('\n');
          addSection('## 📋 历史摘要', summaryText, 0);
        }
      }
    } catch (sumErr) {
      ctx.logger?.debug?.('Summary injection failed (non-fatal)', { err: sumErr });
    }
  }

  // H-4: 上下文冲突检测 — v2.7.0 P4: 异步化，当前轮使用上一轮缓存结果，避免阻塞 200-400ms
  // 冲突检测不依赖最新 results 的精确性，延迟一轮不影响用户体验
  // 复用上方已声明的 sessionKey

  // 注入上一轮异步检测的冲突结果
  if (sessionKey) {
    const cachedConflicts = ctx.conflictCache?.get(sessionKey);
    if (cachedConflicts && cachedConflicts.conflicts.length > 0) {
      const conflictText = cachedConflicts.conflicts.map((c: any, i: number) =>
        `⚠️ 冲突 ${i + 1} [${c.severity === 'high' ? '严重' : '中等'}]: ${c.description}`
      ).join('\n');
      addSection('## ⚠️ 内容冲突提示', conflictText, 6);
      ctx.logger?.debug?.("[assemble] H-4: injected cached conflict results", { count: cachedConflicts.conflicts.length });
    }
  }

  // 启动异步冲突检测，结果缓存供下一轮使用
  if (sessionKey && ctx.conflictCache) {
    const expForConflict = finalExpResults.map((e: any) => ({ content: e.experience?.summary ?? e.experience?.detail ?? '', source: 'experience' as const, type: 'raw' as const, id: e.experience?.id ?? '', score: e.score ?? 0 }));
    const graphForConflict = (Array.isArray(graphResults) ? graphResults : []).map((r: any) => ({ ...r, source: 'graph' as const }));
    const qmdForConflict = (Array.isArray(qmdResults) ? qmdResults : []).map((r: any) => ({ ...r, source: 'qmd' as const }));
    backgroundTasks.register('h4:conflict-detection', (async () => {
      try {
        const conflicts = detectConflicts(expForConflict as any, graphForConflict as any, qmdForConflict as any);
        ctx.conflictCache.set(sessionKey, { conflicts, ts: Date.now() });
        if (conflicts.length > 0) {
          ctx.logger?.debug?.("[assemble] H-4: async conflict detection completed", { count: conflicts.length });
        }
      } catch { /* non-fatal */ }
    })().then(() => {}, () => {}));
  }

  // Build systemPromptAddition
  let systemPromptAddition = '';
  const removedSections: { label: string; chars: number }[] = [];

  {
    // Goal Anchoring: 注入目标任务提醒，防止长对话注意力漂移
    const sessionKey = typeof params.sessionKey === 'string'
      ? params.sessionKey
      : typeof params.session_id === 'string'
        ? params.session_id
        : '';
    const goalAnchor = buildGoalAnchor(
      getGoal(sessionKey),
      getGoalSwitchCount(sessionKey) > 0,
      getPreviousGoal(sessionKey),
    );

    // v2.7.0 P3: SDK guidance 缓存 —— 同 tools + citations 组合复用，避免每次重建
    let sdkGuidance = getCachedSdkGuidance(availableTools, citationsMode);
    if (sdkGuidance === null) {
      sdkGuidance = buildMemorySystemPromptAddition({
        availableTools: new Set(availableTools),
        citationsMode: citationsMode as any,
      }) ?? null;
      setCachedSdkGuidance(availableTools, citationsMode, sdkGuidance ?? '');
    }
    let addition = goalAnchor ? goalAnchor + '\n' : '';
    if (sdkGuidance) {
      addition += '\n# Tool Guidance\n' + sdkGuidance;
    }
    if (sections.length > 0) {
      addition += buildKnowledgeGuidance(tier, true);
    }
    for (const sec of sections) {
      addition += '\n---\n' + sec.label + '\n' + sec.body;
    }
    systemPromptAddition = addition || '';
    if (systemPromptAddition.length > maxContextChars) {
      systemPromptAddition = applyTotalControl(systemPromptAddition, maxContextChars, removedSections);
    }
  }

  // Priority-based token budget trim
  const wm = ctx.api.pluginConfig?.lcmMonitor;
  if (wm && sections.length > 0) {
    const finalMsgTokens = estimateTokensFromMessages(finalMessages);
    // v2.7.0 P3: 复用缓存的 SDK guidance，避免重复构建
    const sdkGuidance2 = getCachedSdkGuidance(availableTools, citationsMode) ?? buildMemorySystemPromptAddition({
      availableTools: new Set(availableTools),
      citationsMode: citationsMode as any,
    });
    const sdkLen = sdkGuidance2 ? ('\n# Tool Guidance\n' + sdkGuidance2).length : 0;
    let additionLen = sdkLen;
    const sectionLens: number[] = sections.map((s: any) => ('\n---\n' + s.label + '\n' + s.body).length);
    for (const sl of sectionLens) additionLen += sl;
    const budgetCeiling = contextWindow * 0.85;
    const estimateTotal = () => finalMsgTokens + Math.floor(additionLen / 4);

    let trimmed = 0;
    while (estimateTotal() > budgetCeiling && sections.length > 0) {
      let worstIdx = -1;
      let worstLayer = Infinity;
      for (let j = 0; j < sections.length; j++) {
        if (sections[j].layer < worstLayer) {
          worstLayer = sections[j].layer;
          worstIdx = j;
        }
      }
      if (worstIdx < 0) break;
      additionLen -= sectionLens[worstIdx];
      sectionLens.splice(worstIdx, 1);
      sections.splice(worstIdx, 1);
      trimmed++;
    }
    if (trimmed > 0) {
      ctx.logger?.debug?.('[wm] priority-trimmed ' + String(trimmed) + ' injected section(s), remaining: ' + sections.map(function(s) { return s.label; }).join(','));
    }
    let rebuilt = '';
    // Goal Anchoring: 在 token 预算裁剪后也保留目标提醒
    const sessionKeyForRebuild = typeof params.sessionKey === 'string'
      ? params.sessionKey
      : typeof params.session_id === 'string'
        ? params.session_id
        : '';
    const goalAnchorRebuild = buildGoalAnchor(
      getGoal(sessionKeyForRebuild),
      getGoalSwitchCount(sessionKeyForRebuild) > 0,
      getPreviousGoal(sessionKeyForRebuild),
    );
    if (goalAnchorRebuild) {
      rebuilt += goalAnchorRebuild + '\n';
    }
    if (sdkGuidance2) {
      rebuilt += '\n# Tool Guidance\n' + sdkGuidance2;
    }
    for (const sec of sections) {
      rebuilt += '\n---\n' + sec.label + '\n' + sec.body;
    }
    systemPromptAddition = rebuilt || '';

    if (systemPromptAddition.length > maxContextChars) {
      systemPromptAddition = applyTotalControl(systemPromptAddition, maxContextChars);
      ctx.logger?.warn?.('[wm] Hard truncation after priority trim');
    }
  }

  return { systemPromptAddition, currentRoundHashes, removedSections, expResults: finalExpResults, scenario,
    filteredQmdCount: qmdResults.length,
    filteredGraphCount: graphResults.length,
    filteredExpCount: finalExpResults.length,
  };
}