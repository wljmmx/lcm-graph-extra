/**
 * @openclaw/lcm-graph-extra v2.1.0
 *
 * OpenClaw ContextEngine plugin (SDK entry point).
 *
 * Architecture:
 *   Layer 1. lossless-claw (built-in) — session message DAG + summaries
 *   Layer 2. qmd MCP — memory file BM25+vector search
 *   Layer 3. Neo4j/graph-memory-pro — knowledge graph entity/relationship
 *   Layer 4. EXPERIENCE nodes — async distilled experience (Layer 4)
 *
 * Lifecycle:
 *   ingest / ingestBatch → lightweight forward (lossless-claw handles actual store)
 *   assemble → Layer 2~4 results injected as systemPromptAddition
 *   afterTurn → experience extraction, entity upsert
 *   compact → delegated to lossless-claw (returns ok=true)
 *
 * Window Monitor (v2.1.0+):
 *   assemble() 中基于消息数+Token 比例判定压力等级，
 *   动态调整 L2~L4 注入量，高压时触发 lossless-claw 后台 DAG 压缩。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerOperationalTools } from "./tools.js";

import {
  type PressureInfo,
  type PressureTier,
  determinePressureTier,
  shouldTriggerCompact,
  getRetrievalLimitsForTier,
  getMaxContextCharsForTier,
  getConversationId,
  writeCompactionDebt,
  estimateTokensFromMessages,
} from "./lcm-bridge.js";

/**
 * 总控裁剪 — 按优先级逐级裁剪注入内容
 *
 * 优先级 (高→低): qmd > graph > experience > multiGet_full_doc
 * 裁剪策略:
 *   1. 从低优先级 section 整段移除
 *   2. 仍超则截断最低优先级保留 section
 */
function applyTotalControl(
  injected: string,
  maxChars: number,
): string {
  if (!injected || injected.length <= maxChars) return injected;

  // 按 section 标题分割
  const sections: { label: string; content: string; priority: number }[] = [];
  const lines = injected.split('\n');
  let currentLabel = '';
  let currentLines: string[] = [];
  let currentPriority = 0;

  for (const line of lines) {
    const headerMatch = line.match(/^## (📄|🔗|💡)/);
    if (headerMatch) {
      if (currentLines.length > 0 && currentLabel) {
        sections.push({
          label: currentLabel,
          content: currentLines.join('\n'),
          priority: currentPriority,
        });
      }
      if (line.includes('📄 完整文档')) {
        currentPriority = 1;  // 最低
      } else if (line.includes('💡 经验')) {
        currentPriority = 2;
      } else if (line.includes('🔗 知识图谱')) {
        currentPriority = 3;
      } else if (line.includes('📄 记忆文件')) {
        currentPriority = 4;  // 最高
      } else {
        currentPriority = 3;
      }
      currentLabel = line;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0 && currentLabel) {
    sections.push({
      label: currentLabel,
      content: currentLines.join('\n'),
      priority: currentPriority,
    });
  }

  if (sections.length === 0) return injected;

  // 按优先级升序排列（低优先级在前）
  sections.sort((a, b) => a.priority - b.priority);

  // 阶段1：从低优先级整段移除
  let result = injected;
  for (let i = 0; i < sections.length && result.length > maxChars; i++) {
    // 只移除当前最低优先级的非最高优先级段
    const lowestPriority = sections[i].priority;
    const candidates = sections.filter(s => s.priority === lowestPriority);
    for (const candidate of candidates) {
      if (result.length <= maxChars) break;
      result = result.replace(candidate.content, '').replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  // 阶段2：如果还超，截断最后的保留内容
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n\n...（上下文字段过长，已裁剪）';
  }

  return result;
}

export default definePluginEntry({
  id: "lcm-graph-extra",
  name: "LCM Graph Extra",
  description: "Coordinates lossless-claw, qmd, and graph-memory-pro for enhanced context assembly",

  register(api: any) {
    // -----------------------------------------------------------------------
    // Context Engine
    // -----------------------------------------------------------------------
    api.registerContextEngine("lcm-graph-extra", () => ({
      info: {
        id: "lcm-graph-extra",
        name: "LCM Graph Extra",
        version: "2.1.0",
        ownsCompaction: true,        // CE decides compaction strategy
      },

      /**
       * Ingest — lossless-claw handles actual storage.
       */
      async ingest(_params: any) {
        return { ingested: true };
      },

      /**
       * Ingest batch — called after a turn completes.
       */
      async ingestBatch(_params: any) {
        return { ingested: true };
      },

      /**
       * Assemble — lossless-claw has already built the message DAG.
       *
       * 流程:
       *   1. 压力检查: 基于消息数+Token比例 判定压力等级
       *   2. 按需触发: 超过阈值则 fire-and-forget 写入 lossless-claw compaction debt
       *   3. 动态召回: 根据压力等级调整 qmd/graph/exp 检索条数
       *   4. 总控裁剪: 按优先级 (qmd>graph>exp>multiGet) 逐级裁剪至上限
       */
      async assemble(params: any) {
        const logger = (api as any).logger;
        const wmConfig = (api as any).config?.windowMonitor;
        const wm = wmConfig?.enabled !== false ? wmConfig : null;
        let systemPromptAddition = "";

        try {
          const { RetrievalGateway } = await import("./retrieval-gateway.js");
          const { QmdClient } = await import("./qmd-client.js");
          const { GraphAdapter } = await import("./adapters/graph-adapter.js");
          const { ExperienceStorage } = await import("./experience/index.js");

          // ==================================================================
          // 1. 压力检查 + 等级判定
          // ==================================================================
          const messages = params.messages ?? [];
          const msgCount = messages.length;
          const estimatedTokens = estimateTokensFromMessages(messages);
          const contextWindow = wm?.contextWindow ?? 131072;
          const tokenRatio = contextWindow > 0 ? estimatedTokens / contextWindow : 0;

          let tier: PressureTier = 'low';
          let retrievalLimits = { qmd: 5, graph: 5, exp: 3 };
          let maxContextChars = 6000;
          let needsCompact = false;

          if (wm) {
            tier = determinePressureTier(msgCount, tokenRatio, {
              messageTriggerCount: wm.messageTriggerCount ?? 24,
              highPressureThreshold: wm.highPressureThreshold ?? 0.85,
              mediumPressureThreshold: wm.mediumPressureThreshold ?? 0.70,
            });
            retrievalLimits = getRetrievalLimitsForTier(tier, {
              low: wm.retrievalLimits?.low ?? { qmd: 5, graph: 5, exp: 3 },
              medium: wm.retrievalLimits?.medium ?? { qmd: 3, graph: 3, exp: 1 },
              high: wm.retrievalLimits?.high ?? { qmd: 1, graph: 1, exp: 0 },
            });
            maxContextChars = getMaxContextCharsForTier(tier, {
              low: wm.maxContextChars?.low ?? 6000,
              medium: wm.maxContextChars?.medium ?? 3000,
              high: wm.maxContextChars?.high ?? 800,
            });

            needsCompact = shouldTriggerCompact(msgCount, tokenRatio, {
              messageTriggerCount: wm.messageTriggerCount ?? 24,
              proactiveThreshold: wm.proactiveThreshold ?? 0.65,
            });

            logger?.debug?.(
              `[wm] pressure=${tier} msgs=${msgCount} tok=${estimatedTokens} ` +
              `ratio=${(tokenRatio * 100).toFixed(1)}% ` +
              `limits=[qmd:${retrievalLimits.qmd} graph:${retrievalLimits.graph} exp:${retrievalLimits.exp}] ` +
              `maxChars=${maxContextChars} needsCompact=${needsCompact}`
            );
          }

          // ==================================================================
          // 2. Fire-and-forget: 压力超阈值则写入 lossless-claw compact debt
          // ==================================================================
          if (needsCompact) {
            const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
              : typeof params.session_id === 'string' ? params.session_id
              : '';
            const conversationId = getConversationId(sessionKey);
            if (conversationId != null) {
              const compactBudget = wm?.compactTokenBudget ?? 57344;
              const wrote = writeCompactionDebt(
                conversationId, compactBudget, estimatedTokens,
                `proactive_${tier}_pressure`,
              );
              if (wrote) {
                logger?.info?.(
                  `[wm] compaction debt written: conv=${conversationId} ` +
                  `reason=proactive_${tier}_pressure msgs=${msgCount} tok=${estimatedTokens}`
                );
              }
            }
          }

          // ==================================================================
          // 3. 执行召回 (使用动态调整的检索限制)
          // ==================================================================
          const qmdBaseUrl = typeof (api as any).config?.retrieval?.qmd?.mcpEndpoint === 'string'
            ? (api as any).config.retrieval.qmd.mcpEndpoint.replace(/\/mcp$/, '')
            : undefined;
          const pluginConfig = (api as any).config ?? {};
          const qmd = new QmdClient({
            mcpBaseUrl: qmdBaseUrl,
            cliFallbackSearchType: pluginConfig.cliFallbackSearchType ?? 'search'
          });
          const graph = new GraphAdapter(
            { uri: "bolt://192.168.50.89:7687", user: "neo4j", password: "pro-gm-2.1.0" },
            { enabled: true, searchLimit: retrievalLimits.graph },
          );
          const gateway = new RetrievalGateway(qmd, graph, {
            maxResults: Math.max(10, retrievalLimits.qmd + retrievalLimits.graph),
            fuzzyMatchThreshold: 0.85,
            decayHalfLifeDays: 30,
          });
          const expStore = new ExperienceStorage(graph, retrievalLimits.exp);

          // L2: qmd — search
          const qmdQuery = messages?.at(-1)?.content ?? "";
          let qmdResults: any[] = [];
          if (qmdQuery && retrievalLimits.qmd > 0) {
            qmdResults = await qmd.query({
              searches: [
                { type: "lex", query: qmdQuery },
                { type: "vec", query: qmdQuery }
              ],
              limit: retrievalLimits.qmd,
              rerank: true,
            });
          }

          // Batch collect file paths for multi_get enrichment
          const multiGetCount = tier === 'high' ? 0 :
            tier === 'medium' ? Math.min(1, retrievalLimits.qmd) : 3;
          const topFiles = [...new Set(
            (qmdResults ?? []).slice(0, multiGetCount).map((r: any) => r.file).filter(Boolean)
          )];

          // L3: Neo4j + L4: Experience + batch enrich (parallel)
          const [, graphResults, expResults, fullDocs] = await Promise.all([
            Promise.resolve(null),
            retrievalLimits.graph > 0 ? graph.search(qmdQuery) : Promise.resolve([]),
            retrievalLimits.exp > 0
              ? expStore.searchRelevant(0.6, retrievalLimits.exp)
              : Promise.resolve([]),
            topFiles.length > 0
              ? qmd.multiGet(topFiles.join(',')).catch(() => [] as string[])
              : Promise.resolve([] as string[]),
          ]);

          // ==================================================================
          // PageRank re-ranking — structural importance boost
          // ==================================================================
          if (graphResults && Array.isArray(graphResults) && graphResults.length > 1) {
            const nodeIds = graphResults.map((r: any) => r.metadata?.nodeId).filter(Boolean);
            if (nodeIds.length >= 2) {
              try {
                const scoreMap = await graph.rerankByPageRank(nodeIds);
                if (scoreMap.size > 0) {
                  graphResults.sort((a: any, b: any) => {
                    return (scoreMap.get(b.metadata?.nodeId) ?? 0) - (scoreMap.get(a.metadata?.nodeId) ?? 0);
                  });
                }
              } catch (pprErr) {
                // PPR failed, fall through with original search results
              }
            }
          }

          // ==================================================================
          // 4. 注入组装 + 总控裁剪
          // ==================================================================
          const injections: string[] = [];

          // Layer 2: qmd search snippet results
          if (qmdResults && Array.isArray(qmdResults) && qmdResults.length > 0) {
            injections.push(
              "## 📄 记忆文件\n" +
              qmdResults.slice(0, retrievalLimits.qmd)
                .map((r: any) => `- ${r.content ?? ""}`)
                .join("\n")
            );
          }

          // Batch-enriched full document content (最低优先级，高压跳过)
          if (tier !== 'high' && Array.isArray(fullDocs) && fullDocs.length > 0) {
            const maxDocLength = tier === 'medium' ? 800 : 2000;
            const docBlock = fullDocs
              .filter(Boolean)
              .slice(0, multiGetCount)
              .map((doc: string) => {
                if (doc.length > maxDocLength) return doc.slice(0, maxDocLength) + "...(截断)";
                return doc;
              })
              .join("\n\n---\n\n");
            if (docBlock) {
              injections.push("## 📄 完整文档已加载\n" + docBlock);
            }
          }

          // Layer 3: Neo4j knowledge graph
          if (graphResults && Array.isArray(graphResults) && graphResults.length > 0) {
            injections.push(
              "## 🔗 知识图谱\n" +
              graphResults.slice(0, retrievalLimits.graph)
                .map((r: any) => `- ${r.content ?? r.id ?? ""}`)
                .join("\n")
            );
          }

          // Layer 4: Experience
          if (expResults.length > 0) {
            injections.push(
              "## 💡 经验总结\n" +
              expResults.map((e: any) => `- [${e.experience.type}] ${e.experience.summary}`).join("\n")
            );
            for (const e of expResults) expStore.incrementMatchCount(e.experience.id).catch(() => {});
          }

          if (injections.length > 0) {
            systemPromptAddition = "\n# Injected Context\n" + injections.join("\n\n");
          }

          // ==================================================================
          // 5. 最终总控裁剪
          // ==================================================================
          if (systemPromptAddition && wm) {
            const trimmed = applyTotalControl(systemPromptAddition, maxContextChars);
            if (trimmed !== systemPromptAddition) {
              logger?.debug?.(
                `[wm] total control: ${systemPromptAddition.length} → ${trimmed.length} chars (tier=${tier})`
              );
              systemPromptAddition = trimmed;
            }
          }

        } catch (err) {
          logger?.warn?.({ err: (err as Error).message }, "assemble: retrieval failed");
        }

        // Pass through lossless-claw's assembled messages, add systemPromptAddition
        return {
          messages: params.messages ?? [],
          estimatedTokens: (params.messages ?? []).reduce(
            (sum: number, m: any) => sum + ((m.content?.length ?? 0) / 4), 0,
          ),
          systemPromptAddition: systemPromptAddition || undefined,
        };
      },

      /**
       * After turn — Triplet LLM extraction + graph upsert.
       * Extracts knowledge triplets (nodes/edges) from conversation and persists to Neo4j.
       */
      async afterTurn(params: any) {
        try {
          // Only process non-empty turns with meaningful content
          const msgs = params.messages ?? [];
          if (msgs.length < 2) return;

          // Find last user + assistant pair
          let userContent = '', assistantContent = '';
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            const role = m.role ?? '';
            if (!userContent && role === 'user') {
              userContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            } else if (!assistantContent && role === 'assistant') {
              assistantContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            }
            if (userContent && assistantContent) break;
          }

          // Skip if too short or empty — not worth an LLM call
          if (!userContent?.trim() || userContent.length < 20) return;

          // Build graph adapter for upsert
          const { GraphAdapter } = await import("./adapters/graph-adapter.js");
          const graphForUpsert = new GraphAdapter(
            { uri: "bolt://192.168.50.89:7687", user: "neo4j", password: "pro-gm-2.1.0" },
            { enabled: true, searchLimit: 5 },
          );

          // LLM config from plugin config or environment
          const llmConfig = (api as any).config?.llm || {
            apiKey: process.env.OPENAI_API_KEY || '',
            baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          };

          const result = await graphForUpsert.extractAndUpsertFromTurn(
            llmConfig, userContent, assistantContent,
          );

          if (result.nodes > 0 || result.edges > 0) {
            const logger = (api as any).logger;
            logger?.debug?.(`[afterTurn] triplets: +${result.nodes} nodes, +${result.edges} edges`);
          }

        } catch (err) {
          // Non-blocking — extraction failure should not affect normal operation
          console.error(`[lcm-graph-extra] afterTurn error: ${err}`);
        }
      },

      /**
       * Compact — CE strategy: delegated to lossless-claw.
       */
      async compact(_params: any) {
        return { ok: true, compacted: true };
      },

      /**
       * Dispose — release resources on shutdown.
       */
      dispose() {
        // Neo4j connections are managed by graph-memory-pro; no-op here.
      },
    }));

    // --- Register operational tools ---
    registerOperationalTools(api);
  },
});

// -----------------------------------------------------------------------
// Backward-compatible named exports
// -----------------------------------------------------------------------
export { GraphMemoryManager } from './core/graph.js';
export { createDAG, mergeDAG, archiveDAG } from './core/lifecycle.js';
export {
  validateConfig, loadConfig, isConfigValid, DEFAULT_CONFIG,
  PluginConfigSchema, BackupConfigSchema, ExperienceConfigSchema,
  CompactionConfigSchema, WindowMonitorConfigSchema,
} from './config.js';
export type { PluginConfig, ExperienceTrigger, WindowMonitorConfig } from './config.js';
export {
  determinePressureTier,
  shouldTriggerCompact,
  getRetrievalLimitsForTier,
  getMaxContextCharsForTier,
  getConversationId,
  writeCompactionDebt,
  estimateTokensFromMessages,
} from './lcm-bridge.js';
export type { PressureTier, PressureInfo, RetrievalLimits, MaxContextChars } from './lcm-bridge.js';
export { QmdClient } from './qmd-client.js';
export type { QmdSearchResult, SearchParams } from './qmd-client.js';
export { RetrievalGateway } from './retrieval-gateway.js';
export { GraphAdapter } from './adapters/graph-adapter.js';
export { Merger } from './merger.js';
export { onCompaction } from './hooks/compaction.js';
export { onBeforeTurn } from './hooks/before-turn.js';
export { onSessionCreated } from './hooks/session-created.js';
export { onTurnComplete } from './hooks/turn-complete.js';
export { onHeartbeat } from './hooks/heartbeat.js';

// register.ts — legacy hooks + registry
export {
  info, bootstrap, assemble, afterTurn, maintain, compact,
  register, getRegisteredPlugin, listRegisteredPlugins,
} from './register.js';
export type {
  PluginInstance, OpenClawContext,
  ContextEngineInfo, ContextEngineAssemblyResult,
  ContextEngineIngestResult, ContextEngineBootstrapResult,
  ContextEngineMaintenanceResult,
} from './register.js';

// experience layer
export {
  detectExperienceTrigger, extractRawExperience, ExperienceStorage,
} from './experience/index.js';
export type {
  ExperienceSource, RawExperience, DistilledExperience,
  ExperienceNode, ExperienceSearchResult,
} from './experience/types.js';

export const VERSION = '2.1.0';
