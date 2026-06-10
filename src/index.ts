/**
 * @openclaw/lcm-graph-extra
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
    const logger = (api as any).logger;

    // -----------------------------------------------------------------------
    // Lazy singleton instances — created once, reused across all assemble calls
    // -----------------------------------------------------------------------
    let initialized = false;
    let initPromise: Promise<void> | null = null;
    let qmdClient: any = null;
    let graphAdapter: any = null;
    let expStore: any = null;

    async function ensureInitialized() {
      if (initialized) return;
      if (initPromise) return initPromise;
      initPromise = (async () => {
      try {
        const { QmdClient } = await import("./qmd-client.js");
        const { GraphAdapter } = await import("./adapters/graph-adapter.js");
        const { ExperienceStorage } = await import("./experience/index.js");

        // -- QMD 全局配置 (来自 memory.qmd) --
        const qmdConfig = (api as any).config?.retrieval?.qmd ?? {};
        const qmdBaseUrl = typeof qmdConfig.mcpEndpoint === 'string'
          ? qmdConfig.mcpEndpoint.replace(/\/mcp$/, '')
          : undefined;

        // -- 插件自有参数 (来自 plugins.lcm-graph-extra) --
        const pluginConfig = (api as any).config ?? {};
        const cliFallbackSearchType = pluginConfig.cliFallbackSearchType ?? 'search';
        const cliTimeout = pluginConfig.cliTimeout ?? 30_000;

        qmdClient = new QmdClient({
          mcpBaseUrl: qmdBaseUrl,
          cliTimeout: cliTimeout,
          cliFallbackSearchType: cliFallbackSearchType,
        });
        graphAdapter = new GraphAdapter(
          { uri: "bolt://192.168.50.89:7687", user: "neo4j", password: "pro-gm-2.1.0" },
          { enabled: true, searchLimit: 5 },
        );

        // Connect once; if Neo4j unavailable, still initialize so L2 works
        try {
          await graphAdapter.connect();
        } catch (err) {
          logger?.warn?.({ err: (err as Error).message }, "init: Neo4j unavailable, L3/L4 will be skipped");
        }

        expStore = new ExperienceStorage(graphAdapter, 3);
        initialized = true;
      } catch (err) {
        // Reset lock so next assemble retries instead of being permanently stuck
        initPromise = null;
        logger?.error?.({ err: (err as Error).message }, "init: failed, will retry on next assemble");
      }
    })();
    return initPromise;
  }

    // -----------------------------------------------------------------------
    // Context Engine
    // -----------------------------------------------------------------------
    api.registerContextEngine("lcm-graph-extra", () => ({
      info: {
        id: "lcm-graph-extra",
        name: "LCM Graph Extra",
        version: "0.2.0",
        ownsCompaction: true,
      },

      async ingest(_params: any) {
        return { ingested: true };
      },

      async ingestBatch(_params: any) {
        return { ingested: true };
      },

      /**
       * Assemble — optimized: instances reused, L2/L3/L4 fully parallelized.
       */
      async assemble(params: any) {
        console.log(`[lcm-graph-extra] assemble called`);
        const assembleStart = Date.now();
        let systemPromptAddition = "";

        try {
          const initStart = Date.now();
          await ensureInitialized();
          const initMs = Date.now() - initStart;

          
          // ==================================================================
          // 1. Window Monitor — pressure check + tier determination
          // ==================================================================
          const wmConfig = (api as any).config?.windowMonitor;
          const wm = wmConfig?.enabled !== false ? wmConfig : null;
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
          }

          // ==================================================================
          // 2. Fire-and-forget: write compaction debt if needed
          // ==================================================================
          if (needsCompact) {
            const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
              : typeof params.session_id === 'string' ? params.session_id
              : '';
            const conversationId = getConversationId(sessionKey);
            if (conversationId != null) {
              writeCompactionDebt(
                conversationId, wm?.compactTokenBudget ?? 57344, estimatedTokens,
                `proactive_${tier}_pressure`,
              );
            }
          }

// Extract query text - handle both string and {type, text}[] content formats
          const lastMsg = params.messages?.at(-1);
          let qmdQuery = "";
          if (lastMsg?.content) {
            const c = lastMsg.content;
            if (typeof c === 'string') {
              qmdQuery = c;
            } else if (Array.isArray(c)) {
              // OpenClaw content is [{type: "text", text: "..."}, ...]
              const textPart = c.find((p: any) => p.type === "text");
              qmdQuery = textPart?.text ?? "";
            }
          }

          // ---- Parallel Phase 1: L2 + L3 + L4 all fire together ----
          const parallelStart = Date.now();
          let qmdResults: any = [];
          let graphResults: any = [];
          let expResults: any = [];

          try {
            const results = await Promise.all([
              // L2: qmd search
              (async () => {
                try {
                  if (!qmdQuery) return [];
                  return await qmdClient.query({
                    searches: [
                      { type: "lex", query: qmdQuery },
                      { type: "vec", query: qmdQuery }
                    ],
                    limit: 5,
                    rerank: true
                  });
                } catch (e) {
                  logger?.warn?.({ err: (e as Error).message }, "L2 qmd query failed");
                  return [];
                }
              })(),
              // L3: Neo4j knowledge graph (independent of L2)
              (async () => {
                try {
                  return await graphAdapter.search(qmdQuery);
                } catch (e) {
                  logger?.warn?.({ err: (e as Error).message }, "L3 graph search failed");
                  return [];
                }
              })(),
              // L4: Experience search (independent of L2)
              (async () => {
                try {
                  return await expStore.searchRelevant(0.6, 3);
                } catch (e) {
                  logger?.warn?.({ err: (e as Error).message }, "L4 experience search failed");
                  return [];
                }
              })(),
            ]);
            qmdResults = results[0];
            graphResults = results[1];
            expResults = results[2];
          } catch (e) {
            logger?.warn?.({ err: (e as Error).message }, "Parallel L2/L3/L4 phase failed");
          }

          const parallelMs = Date.now() - parallelStart;

          // ---- Parallel Phase 2: multiGet (depends on L2 file paths) ----
          const mgStart = Date.now();
          const topFiles = [...new Set(
            (qmdResults ?? []).slice(0, 3).map((r: any) => r.file).filter(Boolean)
          )];

          let fullDocs: string[] = [];
          if (topFiles.length > 0) {
            try {
              fullDocs = await qmdClient.multiGet(topFiles.join(','));
            } catch {
              fullDocs = [];
            }
          }

          const mgMs = Date.now() - mgStart;

          // ---- Metrics log ----
          logger?.debug?.({
            elapsed: Date.now() - assembleStart,
            init_ms: initMs,
            parallel_ms: parallelMs,
            multiget_ms: mgMs,
            l2_count: Array.isArray(qmdResults) ? qmdResults.length : 0,
            l3_count: Array.isArray(graphResults) ? graphResults.length : 0,
            l4_count: expResults.length,
            doc_count: fullDocs?.length ?? 0,
          }, "lcm-graph-extra assemble metrics");

          // ---- Merge results ----
          const injections: string[] = [];

          // Layer 2: qmd search snippet results
          if (qmdResults && Array.isArray(qmdResults)) {
            injections.push("## 📄 记忆文件\n" + qmdResults.slice(0, 3).map((r: any) => `- ${r.content ?? ""}`).join("\n"));
          }

          // Batch-enriched full document content
          if (Array.isArray(fullDocs) && fullDocs.length > 0) {
            const docBlock = fullDocs
              .filter(Boolean)
              .slice(0, 3)
              .map((doc: string) => {
                if (doc.length > 2000) return doc.slice(0, 2000) + "...(截断)";
                return doc;
              })
              .join("\n\n---\n\n");
            if (docBlock) {
              injections.push("## 📄 完整文档已加载\n" + docBlock);
            }
          }

          // Layer 3: Neo4j knowledge graph
          if (graphResults && Array.isArray(graphResults)) {
            injections.push("## 🔗 知识图谱\n" + graphResults.slice(0, 5).map((r: any) => `- ${r.content ?? r.id ?? ""}`).join("\n"));
          }

          // Layer 4: Experience
          if (expResults.length > 0) {
            injections.push("## 💡 经验总结\n" + expResults.map((e: any) => `- [${e.experience.type}] ${e.experience.summary}`).join("\n"));
            for (const e of expResults) expStore.incrementMatchCount(e.experience.id).catch(() => {});
          }

          if (injections.length > 0) {
            systemPromptAddition = "\n# Injected Context\n" + injections.join("\n\n");

          // ==================================================================
          // Final: apply total control trim if Window Monitor enabled
          // ==================================================================
          if (systemPromptAddition && wm) {
            const trimmed = applyTotalControl(systemPromptAddition, maxContextChars);
            if (trimmed !== systemPromptAddition) {
              logger?.debug?.(
                `[wm] total control: ${systemPromptAddition.length} -> ${trimmed.length} chars (tier=${tier})`
              );
              systemPromptAddition = trimmed;
            }
          }

          }

        } catch (err) {
          logger?.warn?.({ err: (err as Error).message }, "assemble: retrieval failed");
        }

        // Normalize messages for OpenClaw SDK - content must be string
        try {
          const msgs = (params.messages ?? []).map((m: any) => ({
          seq: m.seq,
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p: any) => p.text ?? "").join("\n")
              : String(m.content ?? ""),
        }));

          return {
            messages: msgs,
            estimatedTokens: msgs.reduce((sum: number, m: any) => sum + (m.content.length / 4), 0),
            systemPromptAddition: systemPromptAddition || undefined,
          };
        } catch (normErr) {
          const ne = normErr instanceof Error ? normErr : new Error(String(normErr));
          console.error(`[lcm-graph-extra] NORMALIZE ERROR: ${ne.message}\n${ne.stack}`);
          // Ultra fallback: just strip runtime context and return raw messages
          const raw = (params.messages ?? []).map((m: any) => ({
            seq: m.seq,
            role: m.role,
            content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
          }));
          return {
            messages: raw,
            estimatedTokens: raw.reduce((s: number, m: any) => s + (m.content.length / 4), 0),
            systemPromptAddition: undefined,
          };
        }
      },

      async afterTurn(params: any) {
        try {
          const msgs = params.messages ?? [];
          if (msgs.length < 2) return;

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

          // Quality filter: skip low-signal turns
          if (!userContent?.trim() || userContent.length < 50) return;
          if (!assistantContent?.trim() || assistantContent.length < 30) return;
          // Skip if content is mostly whitespace or repetitive
          const wordRatio = (userContent.match(/[\w]+/g) || []).length / userContent.trim().length;
          if (wordRatio < 0.3) return;

          const llmConfig = (api as any).config?.llm || {
            apiKey: process.env.OPENAI_API_KEY || '',
            baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          };

          if (graphAdapter) {
            const result = await graphAdapter.extractAndUpsertFromTurn(
              llmConfig, userContent, assistantContent,
            );
            if (result.nodes > 0 || result.edges > 0) {
              logger?.debug?.(`[afterTurn] triplets: +${result.nodes} nodes, +${result.edges} edges`);
            }
          }
        } catch (err) {
          console.error(`[lcm-graph-extra] afterTurn error: ${err}`);
        }
      },

      async compact(_params: any) {
        return { ok: true, compacted: true };
      },

      dispose() {
        // Close Neo4j driver pool before resetting to avoid "Pool is closed" errors
        try { (graphAdapter as any)?.close?.(); } catch {}
        initialized = false;
        initPromise = null;
        qmdClient = null;
        graphAdapter = null;
        expStore = null;
      },
    }));

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
export type { PluginConfig, ExperienceTrigger } from './config.js';
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

export {
  detectExperienceTrigger, extractRawExperience, ExperienceStorage,
} from './experience/index.js';
export type {
  ExperienceSource, RawExperience, DistilledExperience,
  ExperienceNode, ExperienceSearchResult,
} from './experience/types.js';

export const VERSION = '2.1.5';
