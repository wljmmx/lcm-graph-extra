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
import type { AssembleContext, InjectionOutput } from './types.js';

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
): Promise<InjectionOutput> {
  // Session-isolated cross-round dedup
  const sessionKey = typeof params.sessionKey === 'string'
    ? params.sessionKey
    : typeof params.session_id === 'string'
      ? params.session_id
      : 'default';
  const sd = getSessionDedup(sessionKey);

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

    const expBody = personalizedResults.map((e: any) => '- [' + e.experience.type + '] ' + e.experience.summary).join('\n');
    addSection('## 💡 经验总结（历史经验参考）', expBody, 5);
    for (const e of personalizedResults) {
      // P1-1: 已改为静态导入，直接使用 backgroundTasks
      backgroundTasks.register('exp:increment-match', ctx.expStore.incrementMatchCount(e.experience.id).then(() => {}, () => {}));
    }

    // G-8: 记录本轮 assemble 返回的经验
    const LAST_EXP_MAP_MAX = 200;
    ctx.lastAssembleExpIdsBySession.set(sessionKey, {
      ids: personalizedResults.map((e: any) => ({
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
    const graphBody = graphResults.slice(0, retrievalLimits.graph).map((r: any) => '- ' + (r.content ?? r.id ?? '')).join('\n');
    addSection('## 🔗 知识图谱（历史知识参考）', graphBody, 4);
  }

  // Layer 2: qmd search snippet results
  if (qmdResults && Array.isArray(qmdResults) && qmdResults.length > 0) {
    const qmdItems = qmdResults
      .slice(0, retrievalLimits.qmd)
      // P-CP-3: 增加 content 长度下限过滤，减少无意义碎片（< 20 字符的片段对 LLM 无参考价值）
      .filter((r: any) => (r.score == null || r.score >= 0.3) && String(r.content ?? '').trim().length >= 20)
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
      .join('\n');
    if (qmdItems) {
      addSection('## 📄 记忆文件（参考）', qmdItems, 3);
    }
  }

  // Batch-enriched full document content
  if (Array.isArray(fullDocs) && fullDocs.length > 0) {
    const docBlock = fullDocs
      .filter(Boolean)
      .slice(0, Math.min(retrievalLimits.qmd, 2))
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

  // H-4: 上下文冲突检测
  try {
    // P1-1: 已改为静态导入，直接使用 detectConflicts
    const expForConflict = finalExpResults.map((e: any) => ({ content: e.experience?.summary ?? e.experience?.detail ?? '', source: 'experience' as const, type: 'raw' as const, id: e.experience?.id ?? '', score: e.score ?? 0 }));
    const graphForConflict = (Array.isArray(graphResults) ? graphResults : []).map((r: any) => ({ ...r, source: 'graph' as const }));
    const qmdForConflict = (Array.isArray(qmdResults) ? qmdResults : []).map((r: any) => ({ ...r, source: 'qmd' as const }));
    const conflicts = detectConflicts(expForConflict as any, graphForConflict as any, qmdForConflict as any);
    if (conflicts.length > 0) {
      const conflictText = conflicts.map((c: any, i: number) =>
        `⚠️ 冲突 ${i + 1} [${c.severity === 'high' ? '严重' : '中等'}]: ${c.description}`
      ).join('\n');
      addSection('## ⚠️ 内容冲突提示', conflictText, 6);
      ctx.logger?.debug?.("[assemble] H-4: detected content conflicts", { count: conflicts.length });
    }
  } catch { /* non-fatal */ }

  // Build systemPromptAddition
  let systemPromptAddition = '';
  const removedSections: { label: string; chars: number }[] = [];

  {
    const sdkGuidance = buildMemorySystemPromptAddition({
      availableTools: new Set(availableTools),
      citationsMode: citationsMode as any,
    });
    let addition = '';
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
    const sdkGuidance2 = buildMemorySystemPromptAddition({
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

  return { systemPromptAddition, currentRoundHashes, removedSections, expResults: finalExpResults, scenario };
}