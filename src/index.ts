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
import { UsageTracker } from "./async/usage-tracker"
import { onCompaction } from "./hooks/compaction";
import { LosslessClawAdapter } from "./middleware/lossless-claw-adapter";
import { resolveNeo4jConfig } from "./config/neo4j-helper";
import { disposeAfterTurn as disposeRetrievalSingletons } from "./hooks/before-turn";

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
/** Simple string hash for cross-turn dedup */
function quickHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}


function applyTotalControl(
  injected: string,
  maxChars: number,
  removedSections?: { label: string; chars: number }[],
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
  const removedStats: { label: string; chars: number }[] = [];
  for (let i = 0; i < sections.length && result.length > maxChars; i++) {
    // 只移除当前最低优先级的非最高优先级段
    const lowestPriority = sections[i].priority;
    const candidates = sections.filter(s => s.priority === lowestPriority);
    for (const candidate of candidates) {
      if (result.length <= maxChars) break;
      result = result.replace(candidate.content, '').replace(/\n{3,}/g, '\n\n').trim();
      removedStats.push({ label: candidate.label, chars: candidate.content.length });
    }
  }
  if (removedSections) {
    for (const rs of removedStats) removedSections.push(rs);
  }

  // 阶段2：如果还超，截断最后的保留内容
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n\n...（上下文字段过长，已裁剪）';
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tool-aware retrieval strategy helpers
// ---------------------------------------------------------------------------

/** Extract available tool names from params.availableTools (Set or array). */
function extractAvailableTools(params: any): string[] {
  const tools = params.availableTools;
  if (!tools) return [];
  if (tools instanceof Set) return [...tools].map((t: string) => t.toLowerCase());
  if (Array.isArray(tools)) return tools.map((t: string) => t.toLowerCase());
  return [];
}

/** Check if a tool category is available among the runtime tools. */
function hasToolCategory(availableTools: string[], category: string): boolean {
  switch (category) {
    case "graph":
      return availableTools.some(t => t.includes("graph"));
    case "experience":
      return availableTools.some(t => t.includes("experience"));
    case "qmd":
      return availableTools.some(t => t.includes("qmd") || t.includes("memory"));
    default:
      return false;
  }
}

/** Build tool guidance section for systemPromptAddition. */
function buildToolGuidance(availableTools: string[]): string {
  const hasGraph = hasToolCategory(availableTools, "graph");
  const hasExperience = hasToolCategory(availableTools, "experience");
  const hasQmd = hasToolCategory(availableTools, "qmd");
  const lines: string[] = [];
  lines.push("## 🛠️ 可用检索工具");
  if (hasQmd) {
    lines.push("- ✅ **记忆文件搜索** — 可通过 lcm-search/qmd 查询记忆文件");
  } else {
    lines.push("- ⏭️ **记忆文件搜索** — 已自动注入相关上下文（无需手动搜索）");
  }
  if (hasGraph) {
    lines.push("- ✅ **知识图谱查询** — 可通过 graph-search 查询实体关系");
  } else {
    lines.push("- ⏭️ **知识图谱查询** — 已自动注入相关实体（无需手动查询）");
  }
  if (hasExperience) {
    lines.push("- ✅ **经验检索** — 可通过 experience-search 查找历史经验");
  } else {
    lines.push("- ⏭️ **经验检索** — 已自动注入相关经验（无需手动搜索）");
  }
  if (!hasGraph && !hasExperience && !hasQmd) {
    lines.push("\n> 💡 提示：已根据上下文自动注入相关知识，如需更多信息可直接询问。");
  }
  return lines.join("\n");
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
    let tracker: any = null;
    let initialized = false;
    let initPromise: Promise<void> | null = null;
    let _losslessClawAdapter: any = null;
    let qmdClient: any = null;
    let graphAdapter: any = null;
    let expStore: any = null;
    let lastInjectHashes = new Set<string>();

    async function ensureInitialized() {
      if (initialized) return;
      if (initPromise) return initPromise;
      initPromise = (async () => {
      try {
        tracker = new UsageTracker(logger);
        _losslessClawAdapter = new LosslessClawAdapter();
        // P1-2 fix: await connection and log result
        try {
          const adapterConnected = await _losslessClawAdapter.connect();
          if (!adapterConnected) {
            logger?.warn?.({ err: _losslessClawAdapter.initError }, "init: lossless-claw adapter connection failed, compact will be backup-only");
          }
        } catch (adapterErr) {
          logger?.warn?.({ err: (adapterErr as Error).message }, "init: lossless-claw adapter connect threw");
        }
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
          resolveNeo4jConfig(pluginConfig),
          { enabled: true, searchLimit: 5 },
          logger,
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
        version: "2.1.7",
        ownsCompaction: true,
      },

      async ingest(_params: any) {
        // Forward to lossless-claw for actual message storage
        try {
          await _losslessClawAdapter?.ingest?.(_params);
        } catch {}
        return { ingested: true };
      },

      async ingestBatch(params: any) {
        const count = (params.messages ?? []).length;
        return { ingestedCount: count };
      },

      /**
       * Assemble — optimized: instances reused, L2/L3/L4 fully parallelized.
       */
      async assemble(params: any) {

          // AbortSignal support - early exit if cancelled
          const signal = (params as any).abortSignal || (params as any).signal;
          if (signal?.aborted) {
            return { messages: [] };
          }

        logger?.debug?.("[lcm-graph-extra] assemble called");
        const assembleStart = Date.now();
        let systemPromptAddition = "";

        try {
          const initStart = Date.now();
          await ensureInitialized();
          const initMs = Date.now() - initStart;

          // ==================================================================
          // 0. Tool-aware retrieval strategy — read availableTools
          // ==================================================================
          const availableTools = extractAvailableTools(params);
          const hasGraphTool = hasToolCategory(availableTools, "graph");
          const hasExperienceTool = hasToolCategory(availableTools, "experience");

          if (availableTools.length > 0) {
            logger?.debug?.(
              "[lcm-graph-extra] availableTools: " + JSON.stringify(availableTools) +
              ", hasGraph=" + hasGraphTool + ", hasExperience=" + hasExperienceTool
            );
          }

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
              // L2: qmd search (always executed — core memory retrieval, not tool-gated)
              (async () => {
                try {
                  if (!qmdQuery) return [];
                  return await qmdClient.query({
                    searches: [
                      { type: "lex", query: qmdQuery },
                      { type: "vec", query: qmdQuery }
                    ],
                    limit: retrievalLimits.qmd,
                    rerank: true
                  });
                } catch (e) {
                  logger?.warn?.({ err: (e as Error).message }, "L2 qmd query failed");
                  return [];
                }
              })(),
              // L3: Neo4j knowledge graph — skip if no graph tool available
              (async () => {
                try {
                  if (!hasGraphTool) {
                    logger?.debug?.("[lcm-graph-extra] L3 graph search skipped (no graph tool)");
                    return [];
                  }
                  return await graphAdapter.searchWithCache(qmdQuery, retrievalLimits.graph);
                } catch (e) {
                  logger?.warn?.({ err: (e as Error).message }, "L3 graph search failed");
                  return [];
                }
              })(),
              // L4: Experience search — skip if no experience tool available
              (async () => {
                try {
                  if (!hasExperienceTool) {
                    logger?.debug?.("[lcm-graph-extra] L4 experience search skipped (no experience tool)");
                    return [];
                  }
                  if (retrievalLimits.exp === 0) return [];
                  return await expStore.searchRelevant(0.6, retrievalLimits.exp);
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
            (qmdResults ?? []).slice(0, retrievalLimits.qmd).map((r: any) => r.file).filter(Boolean)
          )];

          let fullDocs: string[] = [];
          if (topFiles.length > 0) {
            try {
              fullDocs = await qmdClient.multiGet(topFiles.join(','));
            } catch {
              logger?.debug?.("assemble: qmd multiGet failed, returning empty");
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
            tier: tier,
            retrieval_limits: JSON.stringify(retrievalLimits),
            available_tools_count: availableTools.length,
            has_graph_tool: hasGraphTool,
            has_experience_tool: hasExperienceTool,
          }, "lcm-graph-extra assemble metrics");

          // ---- Merge results ----
          // Cross-turn dedup: snapshot last turn hashes, clear for this turn
          const prevInjectHashes = lastInjectHashes;
          lastInjectHashes = new Set<string>();

          function dedupInject(s: string): void {
            const h = quickHash(s);
            if (prevInjectHashes.has(h)) return;
            lastInjectHashes.add(h);
            injections.push(s);
          }
          const injections: string[] = [];

          // Layer 2: qmd search snippet results
          if (qmdResults && Array.isArray(qmdResults)) {
            dedupInject("## 📄 记忆文件\n" + qmdResults.slice(0, retrievalLimits.qmd).map((r: any) => `- ${r.content ?? ""}`).join("\n"));
          }

          // Batch-enriched full document content
          if (Array.isArray(fullDocs) && fullDocs.length > 0) {
            const docBlock = fullDocs
              .filter(Boolean)
              .slice(0, retrievalLimits.qmd)
              .map((doc: string) => {
                if (doc.length > 2000) return doc.slice(0, 2000) + "...(截断)";
                return doc;
              })
              .join("\n\n---\n\n");
            if (docBlock) {
              dedupInject("## 📄 完整文档已加载\n" + docBlock);
            }
          }

          // Layer 3: Neo4j knowledge graph
          if (graphResults && Array.isArray(graphResults)) {
            dedupInject("## 🔗 知识图谱\n" + graphResults.slice(0, retrievalLimits.graph).map((r: any) => `- ${r.content ?? r.id ?? ""}`).join("\n"));
          }

          // Layer 4: Experience
          if (expResults.length > 0) {
            dedupInject("## 💡 经验总结\n" + expResults.map((e: any) => `- [${e.experience.type}] ${e.experience.summary}`).join("\n"));
            for (const e of expResults) expStore.incrementMatchCount(e.experience.id).catch(() => {});
          }

          // ==================================================================
          // 3. Tool guidance — inject into systemPromptAddition
          // ==================================================================
          {
            const toolGuidance = buildToolGuidance(availableTools);
            dedupInject(toolGuidance);
          }

          if (injections.length > 0) {
            systemPromptAddition = "\n# Injected Context\n" + injections.join("\n\n");

          // ==================================================================
          // Final: apply total control trim if Window Monitor enabled
          // ==================================================================
          if (systemPromptAddition && wm) {
            const removedSections: { label: string; chars: number }[] = [];
            const trimmed = applyTotalControl(systemPromptAddition, maxContextChars, removedSections);
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

          // Track usage (non-blocking)
          try {
            const model = params.model ?? "unknown";
            const sessionId = params.sessionId ?? params.session_id ?? "unknown";
            tracker?.onContextReady?.(sessionId, model, systemPromptAddition);
          } catch { logger?.debug?.("assemble: usage tracking failed (non-fatal)"); }

          return {
            messages: msgs,
            estimatedTokens: msgs.reduce((sum: number, m: any) => sum + (m.content.length / 4), 0),
            systemPromptAddition: systemPromptAddition || undefined,
          };
        } catch (normErr) {
          const ne = normErr instanceof Error ? normErr : new Error(String(normErr));
          logger?.error?.({ err: ne }, "assemble: normalize error")
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
        const afterTurnStart = Date.now();

          // AbortSignal support - early exit if cancelled
          const signal = (params as any).abortSignal || (params as any).signal;
          if (signal?.aborted) {
            return;
          }

        try {
          // Split messages into prior (history) and recent (this turn)
          const splitIdx = params.prePromptMessageCount ?? 0;
          const allMsgs = params.messages ?? [];
          const priorMessages = splitIdx > 0 ? allMsgs.slice(0, splitIdx) : allMsgs;
          const recentMessages = splitIdx > 0 ? allMsgs.slice(splitIdx) : [];
          const msgs = allMsgs;
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
        // Track response tokens (non-blocking)
        try {
          const model = params.model ?? "unknown";
          const sessionId = params.sessionId ?? params.session_id ?? "unknown";
          if (assistantContent) {
            tracker?.onResponseReceived?.(sessionId, model, Math.ceil(assistantContent.length / 4), "completed", Date.now() - afterTurnStart);
          }
        } catch {}
      } catch (err) {
          logger?.error?.({ err }, '[lcm-graph-extra] afterTurn error');
        }
      },

      async compact(params: any) {

          // AbortSignal support - early exit if cancelled
          const signal = (params as any).abortSignal || (params as any).signal;
          if (signal?.aborted) {
            return { ok: false, reason: 'aborted' };
          }

        try {
          // Delegate to onCompaction hook (backup + Neo4j marker + debt write)
          await onCompaction({
            config: api.config,
            logger: logger,
            context: {} as any,
            unregister: () => {},
            _losslessClawAdapter: _losslessClawAdapter,
          });
          // Return real status: check if lossless-claw adapter was connected
          const _adapterConnected = !!(_losslessClawAdapter?.connected);
          if (!_adapterConnected) {
            logger?.warn?.("compact: LosslessClawAdapter not connected, DAG compaction NOT performed");
          }
          return { ok: true, compacted: _adapterConnected };
        } catch (err) {
          logger?.warn?.({ err }, "compact: onCompaction failed (non-fatal)");
          return { ok: false, reason: String(err) };
        }
      },

      dispose() {
        // Close Neo4j driver pool before resetting to avoid "Pool is closed" errors
        try { (graphAdapter as any)?.close?.(); } catch {}
        try { (disposeRetrievalSingletons as any)?.(); } catch {}
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


export const VERSION = '2.1.7';
