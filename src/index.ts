/**
 * lcm-graph-extra
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
 *   afterTurn → usage tracking + experience extraction, entity upsert
 *   compact → delegated to lossless-claw (returns ok=true)
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerOperationalTools } from "./tools.js";

export default definePluginEntry({
  id: "lcm-graph-extra",
  name: "LCM Graph Extra",
  description: "Coordinates lossless-claw, qmd, and graph-memory-pro for enhanced context assembly",

  register(api: any) {
    const logger = (api as any).logger || console;

    // ═══════════════════════════════════════════════════════════════
    // UsageTracker — non-blocking token usage statistics
    // ═══════════════════════════════════════════════════════════════
    let usageTracker: any = null;
    setImmediate(async () => {
      const { UsageTracker } = await import("./async/usage-tracker.js");
      usageTracker = new UsageTracker(logger);
      logger.info("[lcm-graph-extra] UsageTracker initialized");
    });

    // ═══════════════════════════════════════════════════════════════
    // Context Engine
    // ═══════════════════════════════════════════════════════════════
    api.registerContextEngine("lcm-graph-extra", () => ({
      info: {
        id: "lcm-graph-extra",
        name: "LCM Graph Extra",
        version: "0.2.0",
        ownsCompaction: true,        // CE decides compaction strategy
      },

      /**
       * Ingest — lossless-claw handles actual storage.
       * We forward for any lightweight local indexing if needed.
       */
      async ingest(_params: any) {
        return { ingested: true };
      },

      /**
       * Ingest batch — called after a turn completes.
       * Trigger experience extraction here (delegated to hooks/turn-complete).
       */
      async ingestBatch(_params: any) {
        return { ingested: true };
      },

      /**
       * Assemble — lossless-claw has already built the message DAG.
       * We supplement with Layer 2~4 context via systemPromptAddition.
       */
      async assemble(params: any) {
        let systemPromptAddition = "";

        try {
          const { RetrievalGateway } = await import("./retrieval-gateway.js");
          const { QmdClient } = await import("./qmd-client.js");
          const { GraphAdapter } = await import("./adapters/graph-adapter.js");
          const { ExperienceStorage } = await import("./experience/index.js");

          const qmd = new QmdClient();
          const graph = new GraphAdapter(
            { uri: "bolt://192.168.50.89:7687", user: "neo4j", password: "pro-gm-2.1.0" },
            { enabled: true, searchLimit: 5 },
          );
          const gateway = new RetrievalGateway(qmd, graph, {
            maxResults: 10, fuzzyMatchThreshold: 0.85, decayHalfLifeDays: 30,
          });
          const expStore = new ExperienceStorage(graph, 3);

          // L2: qmd
          const lastMsg = Array.isArray(params.messages) ? params.messages.at(-1) : undefined;
          const lastContent = lastMsg?.content;
          const queryText = typeof lastContent === "string" ? lastContent
            : Array.isArray(lastContent) ? lastContent.map((cb) => typeof cb.text === "string" ? cb.text : "").join(" ")
            : "";
          const qmdResults = await qmd.query({
            searches: [{ type: "lex", query: queryText }],
            limit: 5,
          });
          // L3: Neo4j
          const graphResults = await graph.search(params.messages?.at(-1)?.content ?? "");
          // L4: Experience
          const expResults = await expStore.searchRelevant(0.6, 3);

          // Merge
          const injections: string[] = [];
          if (qmdResults && Array.isArray(qmdResults)) {
            injections.push("## 📄 记忆文件\n" + qmdResults.slice(0, 3).map((r: any) => `- ${r.content ?? ""}`).join("\n"));
          }
          if (graphResults && Array.isArray(graphResults)) {
            injections.push("## 🔗 知识图谱\n" + graphResults.slice(0, 5).map((r: any) => `- ${r.content ?? r.id ?? ""}`).join("\n"));
          }
          if (expResults.length > 0) {
            injections.push("## 💡 经验总结\n" + expResults.map((e: any) => `- [${e.experience.type}] ${e.experience.summary}`).join("\n"));
            for (const e of expResults) expStore.incrementMatchCount(e.experience.id).catch(() => {});
          }

          if (injections.length > 0) {
            systemPromptAddition = "\n# Injected Context\n" + injections.join("\n\n");
          }

          await graph.close().catch(() => {});
        } catch (err) {
          logger?.warn?.({ err: (err as Error).message }, "assemble: retrieval failed");
        }

        // ═══ UsageTracker: count input tokens (non-blocking) ═══
        if (usageTracker && (systemPromptAddition || params.prompt)) {
          const textToCount = [params.systemPromptAddition, params.prompt].filter(Boolean).join('\n');
          usageTracker.onContextReady(params.sessionId || 'unknown', 'deepseek-v4-flash', textToCount);
        }

        // Pass through lossless-claw's assembled messages, add systemPromptAddition
        return {
          messages: params.messages,
          estimatedTokens: params.messages.reduce((sum: number, m: any) => sum + ((m.content?.length ?? 0) / 4), 0),
          systemPromptAddition: systemPromptAddition || undefined,
        };
      },

      /**
       * After turn — usage tracking + experience extraction + entity upsert.
       */
      async afterTurn(params: any) {
        // ═══ UsageTracker: capture output tokens from response ═══
        if (usageTracker && params.messages && Array.isArray(params.messages)) {
          const lastAssistantMsg = [...params.messages].reverse().find(
            (m: any) => m.role === 'assistant' && m.usage,
          );
          if (lastAssistantMsg?.usage) {
            const output = parseInt(lastAssistantMsg.usage.output) || 0;
            const duration = parseInt(lastAssistantMsg.usage.totalTokens) || 0;
            usageTracker.onResponseReceived(
              params.sessionId || 'unknown',
              'deepseek-v4-flash',
              output,
              lastAssistantMsg.stopReason === 'aborted' ? 'aborted'
                : lastAssistantMsg.stopReason === 'error' ? 'error' : 'completed',
              duration,
            );
          }
        }
      },

      /**
       * Compact — CE strategy: delegated to lossless-claw.
       * lossless-claw's built-in compact runs independently.
       */
      async compact(_params: any) {
        return { ok: true, compacted: true };
      },

      /**
       * Dispose — release resources on shutdown.
       */
      dispose() {
        if (usageTracker) {
          try { usageTracker.close(); } catch {}
        }
      },
    }));

    // --- Register operational tools ---
    registerOperationalTools(api);
  },
});

// -----------------------------------------------------------------------
// Backward-compatible named exports (for existing importers)
// -----------------------------------------------------------------------
export { GraphMemoryManager } from './core/graph.js';
export { createDAG, mergeDAG, archiveDAG } from './core/lifecycle.js';
export {
  validateConfig, loadConfig, isConfigValid, DEFAULT_CONFIG,
  PluginConfigSchema, BackupConfigSchema, ExperienceConfigSchema,
  CompactionConfigSchema,
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

// —— async
export { UsageTracker } from './async/usage-tracker.js';

export const VERSION = '0.2.0';
