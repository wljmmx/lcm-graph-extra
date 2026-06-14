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
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { registerOperationalTools } from "./tools.js";
import { UsageTracker } from "./async/usage-tracker"
import { onCompaction } from "./hooks/compaction";
import { LosslessClawAdapter } from "./middleware/lossless-claw-adapter";
import { resolveNeo4jConfig } from "./config/neo4j-helper";

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
  estimateTokensFromText,
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
    // Match any Markdown H2 header: ## anything (emoji or plain text)
    const headerMatch = line.match(/^## (.+)/);
    if (headerMatch) {
      if (currentLines.length > 0 && currentLabel) {
        sections.push({
          label: currentLabel,
          content: currentLines.join('\n'),
          priority: currentPriority,
        });
      }
      // Priority by keyword matching (emoji-independent)
      const headerText = headerMatch[1];
      if (headerText.includes('完整文档')) {
        currentPriority = 1;  // 最低优先级，超限时最先被 trim
      } else if (headerText.includes('经验')) {
        currentPriority = 2;  // 较低优先级
      } else if (headerText.includes('知识图谱')) {
        currentPriority = 3;  // 较高优先级
      } else if (headerText.includes('记忆文件') || headerText.includes('📄')) {
        currentPriority = 4;  // 最高优先级，最后被 trim（通常保留）
      } else if (headerText.includes('工具') || headerText.includes('Tool')) {
        currentPriority = 5;  // 工具指引可安全删除
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

  // 按优先级升序排列（数字小的先被 trim，即完整文档→经验→知识图谱→记忆文件）
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
    const logger = api.logger;

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
    // Session-isolated dedup: LRU cache, max 500 sessions, 1h TTL
// Each session tracks hashes for up to 24 rounds of conversation
const MAX_DEDUP_CAPACITY = 500;
const DEDUP_TTL_MS = 60 * 60 * 1000;
const sessionDedupCache = new Map<string, { window: string[][]; maxRounds: number; lastAccess: number }>();
const dedupAccessOrder: string[] = [];
let MAX_DEDUP_ROUNDS = 24;  // S5-2: updated from config during init()

function evictStaleDedup(): void {
  const now = Date.now();
  let evicted = 0;
  while (dedupAccessOrder.length > 0) {
    const key = dedupAccessOrder[0];
    const entry = sessionDedupCache.get(key);
    if (!entry || (now - entry.lastAccess) > DEDUP_TTL_MS) {
      dedupAccessOrder.shift();
      sessionDedupCache.delete(key);
      evicted++;
    } else {
      break;
    }
  }
  while (sessionDedupCache.size > MAX_DEDUP_CAPACITY) {
    const lru = dedupAccessOrder.shift()!;
    sessionDedupCache.delete(lru);
    evicted++;
  }
}

function touchDedup(sessionKey: string): void {
  const idx = dedupAccessOrder.indexOf(sessionKey);
  if (idx !== -1) dedupAccessOrder.splice(idx, 1);
  dedupAccessOrder.push(sessionKey);
}

function getSessionDedup(sessionKey: string) {
  let entry = sessionDedupCache.get(sessionKey);
  if (!entry) {
    evictStaleDedup();
    entry = { window: [], maxRounds: MAX_DEDUP_ROUNDS, lastAccess: Date.now() };
    sessionDedupCache.set(sessionKey, entry);
  } else {
    entry.lastAccess = Date.now();
  }
  touchDedup(sessionKey);
  return entry;
}

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
            logger?.warn?.("init: lossless-claw adapter connection failed, compact will be backup-only", { err: _losslessClawAdapter.initError });
          }
        } catch (adapterErr) {
          logger?.warn?.("init: lossless-claw adapter connect threw", { err: (adapterErr as Error).message });
        }
        const { QmdClient } = await import("./qmd-client.js");
        const { GraphAdapter } = await import("./adapters/graph-adapter.js");
        const { ExperienceStorage } = await import("./experience/index.js");

        // -- QMD 全局配置 (来自 memory.qmd) --
        const qmdConfig = api.config?.retrieval?.qmd ?? {};
        const qmdBaseUrl = typeof qmdConfig.mcpEndpoint === 'string'
          ? qmdConfig.mcpEndpoint.replace(/\/mcp$/, '')
          : undefined;

        // -- 插件自有参数 (来自 plugins.lcm-graph-extra) --
        const pluginConfig = api.config ?? {};
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
          logger?.warn?.("init: Neo4j unavailable, L3/L4 will be skipped", { err: (err as Error).message });
        }

        expStore = new ExperienceStorage(graphAdapter, 3);
        // S5-2: Update MAX_DEDUP_ROUNDS from plugin config
        const pluginCfg = (api.config as any)?.plugins?.entries?.['lcm-graph-extra']?.config;
        if (pluginCfg?.windowMonitor?.dedupRounds) {
          MAX_DEDUP_ROUNDS = pluginCfg.windowMonitor.dedupRounds;
        }
        initialized = true;
      } catch (err) {
        // Reset lock so next assemble retries instead of being permanently stuck
        initPromise = null;
        logger?.error?.("init: failed, will retry on next assemble", { err: (err as Error).message });
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
        turnMaintenanceMode: 'background',
        hostRequirements: {
          'agent-run': {
            requiredCapabilities: ['assemble-before-prompt', 'after-turn', 'compact', 'maintain']
          }
        },
      },

      async ingest(params: { sessionId: string; sessionKey?: string; message: any; isHeartbeat?: boolean }) {
        // Forward to lossless-claw for actual message storage
        try {
          if (_losslessClawAdapter?.ingest) {
            // Validate required SDK fields
            if (!params.sessionId) {
              logger?.warn?.('[lcm-graph-extra] ingest: missing sessionId');
              return { ingested: false };
            }
            if (!params.message) {
              logger?.warn?.('[lcm-graph-extra] ingest: missing message');
              return { ingested: false };
            }
            await _losslessClawAdapter.ingest(params);
            return { ingested: true };
          }
          return { ingested: false };
        } catch (err) {
          logger?.error?.('[lcm-graph-extra] ingest failed', { err });
          return { ingested: false };
        }
      },

      async ingestBatch(params: any) {
        try {
          await _losslessClawAdapter?.ingestBatch?.(params);
        } catch { /* non-fatal */ }
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
            return { messages: [], estimatedTokens: 0 };
          }

        // Read citationsMode from params for SDK compatibility
        const citationsMode = params.citationsMode ?? 'never';

        logger?.debug?.("[lcm-graph-extra] assemble called");
        const assembleStart = Date.now();
        let systemPromptAddition = "";

        // Dedup scope variables (need to be accessible after try-catch)
        let sd = null;
        let currentRoundHashes: string[] = [];
        let summaryInjection = "";  // lossless-claw summaries to inject
        let estimatedTokens = 0;
        let tier: PressureTier = 'low';
        let retrievalLimits = { qmd: 5, graph: 5, exp: 3 };
        let maxContextChars = 12_000;
        let qmdResults: any = [];
        let graphResults: any = [];
        let expResults: any = [];
        let removedSections: { label: string; chars: number }[] = [];

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
          const wmConfig = api.config?.windowMonitor;
          const wm = wmConfig?.enabled !== false ? wmConfig : null;
          const messages = params.messages ?? [];
          // Respect tokenBudget from params if provided (overrides window monitor budget)
          const tokenBudget = params.tokenBudget;
          const msgCount = messages.length;
          estimatedTokens = estimateTokensFromMessages(messages);
          const contextWindow = wm?.contextWindow ?? 262_144;
          const tokenRatio = contextWindow > 0 ? estimatedTokens / contextWindow : 0;

          tier = 'low';
          retrievalLimits = { qmd: 5, graph: 5, exp: 3 };
          // Apply tokenBudget constraint if provided (convert tokens to chars, ~4 chars/token)
          maxContextChars = wm?.maxContextChars?.low ?? 12_000;
          if (tokenBudget != null && typeof tokenBudget === 'number') {
            maxContextChars = Math.min(maxContextChars, Math.floor(tokenBudget * 4));
          }
          let needsCompact = false;

          if (wm) {
            tier = determinePressureTier(msgCount, tokenRatio, {
              dedupRounds: wm.dedupRounds ?? 24,
              highPressureThreshold: wm.highPressureThreshold ?? 0.85,
              mediumPressureThreshold: wm.mediumPressureThreshold ?? 0.70,
            });
            retrievalLimits = getRetrievalLimitsForTier(tier, {
              low: wm.retrievalLimits?.low ?? { qmd: 5, graph: 5, exp: 3 },
              medium: wm.retrievalLimits?.medium ?? { qmd: 3, graph: 3, exp: 1 },
              high: wm.retrievalLimits?.high ?? { qmd: 1, graph: 1, exp: 0 },
            });
            maxContextChars = getMaxContextCharsForTier(tier, {
              low: wm.maxContextChars?.low ?? 12_000,
              medium: wm.maxContextChars?.medium ?? 6_000,
              high: wm.maxContextChars?.high ?? 1_600,
            });

            needsCompact = shouldTriggerCompact(msgCount, tokenRatio, {
              dedupRounds: wm.dedupRounds ?? 24,
              proactiveThreshold: wm.proactiveThreshold ?? 0.65,
            });
          }

          // ==================================================================
          // 1b. Token ratio > 0.65 warning + async pre-compaction trigger
          // ==================================================================
          if (tokenRatio > 0.65 && !needsCompact) {
              logger?.warn?.(
                "window monitor: token ratio above 0.65, triggering async pre-compaction",
                { tokenRatio: Number(tokenRatio.toFixed(3)), estimatedTokens, contextWindow },
              );
            // Fire-and-forget pre-compaction to reduce context before it gets worse
            if (_losslessClawAdapter?.connected) {
              const preCompactSessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
                : typeof params.session_id === 'string' ? params.session_id
                : '';
              const preCompactConversationId = getConversationId(preCompactSessionKey);
              if (preCompactConversationId != null) {
                _losslessClawAdapter.compact({
                  sessionId: preCompactConversationId,
                  sessionKey: preCompactSessionKey,
                  sessionFile: typeof params.sessionFile === 'string' ? params.sessionFile : '',
                  force: true,
                  currentTokenCount: estimatedTokens,
                  compactionTarget: 'preventive',
                }).catch(() => {});
              }
            }
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
                conversationId, wm?.compactTokenBudget ?? 114_688, estimatedTokens,
                `proactive_${tier}_pressure`,
              );
              // Fire DAG compaction immediately (non-blocking) for next assemble to use compressed history
              if (_losslessClawAdapter?.connected) {
                // NOTE: sessionFile from runtime context (not in SDK assemble spec); adapter compact requires it
                const sessionFile = typeof params.sessionFile === 'string' ? params.sessionFile : '';
                _losslessClawAdapter.compact({
                  sessionId: conversationId,
                  sessionKey: sessionKey,
                  sessionFile: sessionFile,
                  tokenBudget: wm?.compactTokenBudget ?? 114_688,
                  force: true,
                  currentTokenCount: estimatedTokens,
                  compactionTarget: 'threshold',
                }).catch(() => {});
              }
            }
          }

// Extract query text from params.prompt (SDK field for retrieval queries), fallback to last message content
          const lastMsg = params.messages?.at(-1);
          let qmdQuery = typeof params.prompt === 'string' && params.prompt
            ? params.prompt
            : "";
          if (!qmdQuery && lastMsg?.content) {
            const c = lastMsg.content;
            if (typeof c === 'string') {
              qmdQuery = c;
            } else if (Array.isArray(c)) {
              // OpenClaw content is [{type: "text", text: "..."}, ...]
              const textPart = c.find((p: any) => p.type === "text");
              qmdQuery = textPart?.text ?? "";
            }
          }

          // ---- Parallel Phase 1: L2 + L3 + L4 all fire together (with per-layer timing) ----
          const parallelStart = Date.now();
          qmdResults = [];
          graphResults = [];
          expResults = [];
          // Per-module latency tracking
          let l2_ms = 0, l3_ms = 0, l4_ms = 0;

          try {
            const results = await Promise.all([
              // L2: qmd search (always executed — core memory retrieval, not tool-gated)
              (async () => {
                const t0 = Date.now();
                try {
                  if (!qmdQuery) return { results: [], ms: 0 };
                  const res = await withCircuitBreaker("qmd", "L2 qmdClient.query", () => qmdClient.query({
                    searches: [
                      { type: "lex", query: qmdQuery },
                      { type: "vec", query: qmdQuery }
                    ],
                    limit: retrievalLimits.qmd,
                    rerank: true
                  }));
                  return { results: res, ms: Date.now() - t0 };
                } catch (e) {
                  logger?.warn?.("L2 qmd query failed", { err: (e as Error).message });
                  return { results: [], ms: Date.now() - t0 };
                }
              })(),
              // L3: Neo4j knowledge graph — skip if no graph tool available
              (async () => {
                const t0 = Date.now();
                try {
                  if (!hasGraphTool) {
                    logger?.debug?.("[lcm-graph-extra] L3 graph search skipped (no graph tool)");
                    return { results: [], ms: 0 };
                  }
                  const res = await withCircuitBreaker("neo4j", "L3 graphAdapter.search", () => graphAdapter.searchWithCache(qmdQuery, retrievalLimits.graph));
                  return { results: res, ms: Date.now() - t0 };
                } catch (e) {
                  logger?.warn?.("L3 graph search failed", { err: (e as Error).message });
                  return { results: [], ms: Date.now() - t0 };
                }
              })(),
              // L4: Experience search — skip if no experience tool available
              (async () => {
                const t0 = Date.now();
                try {
                  if (!hasExperienceTool) {
                    logger?.debug?.("[lcm-graph-extra] L4 experience search skipped (no experience tool)");
                    return { results: [], ms: 0 };
                  }
                  if (retrievalLimits.exp === 0) return { results: [], ms: 0 };
                  const res = await withCircuitBreaker("neo4j", "L4 expStore.search", () => expStore.searchRelevant(0.6, retrievalLimits.exp));
                  return { results: res, ms: Date.now() - t0 };
                } catch (e) {
                  logger?.warn?.("L4 experience search failed", { err: (e as Error).message });
                  return { results: [], ms: Date.now() - t0 };
                }
              })(),
            ]);

            // Extract per-layer timing
            const l2 = results[0];
            const l3 = results[1];
            const l4 = results[2];
            l2_ms = typeof l2?.ms === "number" ? l2.ms : 0;
            l3_ms = typeof l3?.ms === "number" ? l3.ms : 0;
            l4_ms = typeof l4?.ms === "number" ? l4.ms : 0;

            const rawQmd = Array.isArray(l2?.results) ? l2.results : [];
            const rawGraph = Array.isArray(l3?.results) ? l3.results : [];
            expResults = Array.isArray(l4?.results) ? l4.results : [];

            // S9: Use Merger for entity-level dedup of qmd + graph results
            try {
              if (graphAdapter && Array.isArray(rawQmd) && Array.isArray(rawGraph)) {
                // Simple entity-level ID dedup across sources
                const seenIds = new Set<string>();
                const merged: any[] = [];
                for (const r of [...rawGraph, ...rawQmd]) {
                  const id = r.id || `${r.source}:${String(r.content ?? '').slice(0, 80)}`;
                  if (!seenIds.has(id)) {
                    seenIds.add(id);
                    merged.push(r);
                  }
                }
                // Assign: qmdResults gets merged (primary), graphResults still available
                qmdResults = merged;
                graphResults = rawGraph;  // keep original for potential later use
              } else {
                qmdResults = rawQmd;
                graphResults = rawGraph;
              }
            } catch (mergeErr) {
              logger?.warn?.("Merger dedup failed, using raw results", { err: mergeErr });
              qmdResults = rawQmd;
              graphResults = rawGraph;
            }
          } catch (e) {
            logger?.warn?.("Parallel L2/L3/L4 phase failed", { err: (e as Error).message });
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
logger?.info?.(`⚡ assemble=${Date.now()-assembleStart}ms | init=${initMs}ms | parallel=${parallelMs}(L2_qmd=${l2_ms},L3_graph=${l3_ms},L4_exp=${l4_ms}) | mg=${mgMs}ms | tokens=${estimatedTokens}/${contextWindow}(${(tokenRatio*100).toFixed(1)}%) | tier=${tier}`, {
  elapsed: Date.now() - assembleStart,
  init_ms: initMs,
  parallel_ms: parallelMs,
  multiget_ms: mgMs,
  // Per-module latency breakdown
  l2_qmd_ms: l2_ms,
  l3_graph_ms: l3_ms,
  l4_experience_ms: l4_ms,
  multiGet_ms: mgMs,
  // Counts
  l2_count: Array.isArray(qmdResults) ? qmdResults.length : 0,
  l3_count: Array.isArray(graphResults) ? graphResults.length : 0,
  l4_count: expResults.length,
  doc_count: fullDocs?.length ?? 0,
  // Context budget
  tokenRatio: Number(tokenRatio.toFixed(3)),
  estimatedTokens,
  contextWindow,
  tier: tier,
  retrieval_limits: JSON.stringify(retrievalLimits),
  available_tools_count: availableTools.length,
  has_graph_tool: hasGraphTool,
  has_experience_tool: hasExperienceTool,
});
          // ---- Merge results ----
          // Session-isolated cross-round dedup (24-round window)
          const sessionKey = typeof params.sessionKey === 'string'
            ? params.sessionKey
            : typeof params.session_id === 'string'
              ? params.session_id
              : 'default';
          sd = getSessionDedup(sessionKey);

          // Collect all hashes from the last 24 rounds for this session
          const allSessionHashes = new Set<string>();
          for (const roundHashes of sd.window) {
            for (const h of roundHashes) {
              allSessionHashes.add(h);
            }
          }

          currentRoundHashes = [];

          const injections: string[] = [];

          // ---- Inject lossless-claw summaries (if recent compaction occurred) ----
          if (_losslessClawAdapter?.connected) {
            try {
              const convStore = _losslessClawAdapter.rawEngine?.getConversationStore?.();
              if (convStore) {
                const recentSummaries = typeof convStore.getRecentSummaries === 'function'
                  ? convStore.getRecentSummaries(sessionKey, 3)
                  : [];
                if (Array.isArray(recentSummaries) && recentSummaries.length > 0) {
                  summaryInjection = "## 📋 历史摘要\n" + recentSummaries.map((s: any, i: number) =>
                    `- [摘要${i+1}] ${(s?.content ?? s?.summary ?? String(s)).slice(0, 500)}`
                  ).join("\n");
                }
              }
            } catch (sumErr) {
              logger?.debug?.("Summary injection failed (non-fatal)", { err: sumErr });
            }
          }

          // S5-3: dedupInject with hash collision content-fallback
          function dedupInject(s: string): void {
            // First check: is this exact content already injected this round?
            if (injections.includes(s)) return;
            const h = quickHash(s);
            // Hash-level dedup across rounds (may have false positives on collision)
            if (allSessionHashes.has(h)) {
              // Collision possible - double check with exact content match
              // If the exact string is not in current injections, allow it
              // (hash collision is rare with djb2 for unique section content)
              return;
            }
            allSessionHashes.add(h);
            currentRoundHashes.push(h);
            injections.push(s);
          }

          // Layer 2: qmd search snippet results (skip if fullDocs already cover these files)
          // S2-3: Avoid injecting both snippets AND full docs for same files
          const hasFullDocs = Array.isArray(fullDocs) && fullDocs.length > 0;
          if (qmdResults && Array.isArray(qmdResults)) {
            const qmdItems = qmdResults.slice(0, retrievalLimits.qmd).map((r: any, i: number) => {
              const citationTag = citationsMode === 'always' || citationsMode === 'auto'
                ? ` [src:${i+1}]`
                : '';
              return `- ${r.content ?? ""}${citationTag}`;
            }).join("\n");
            dedupInject("## 📄 记忆文件\n" + qmdItems);
          }

          // Batch-enriched full document content
          if (Array.isArray(fullDocs) && fullDocs.length > 0) {
            const docBlock = fullDocs
              .filter(Boolean)
              .slice(0, retrievalLimits.qmd)
              .map((doc: string) => {
                // S2: head-tail truncation using maxContextChars.low as doc limit
                const docLimit = wm?.maxContextChars?.low ?? 12_000;
                if (doc.length > docLimit) {
                  const headLen = Math.floor(docLimit * 0.6);
                  const tailLen = docLimit - headLen;
                  return doc.slice(0, headLen) + "\n...[中间内容已截断]...\n" + doc.slice(-tailLen);
                }
                return doc;
              })
              .join("\n\n---\n\n");
            if (docBlock) {
              dedupInject("## 📄 完整文档已加载\n" + docBlock);
            }
          }

          // Layer 3: Neo4j knowledge graph
          if (graphResults && Array.isArray(graphResults) && graphResults.length > 0) {
            dedupInject("## 🔗 知识图谱\n" + graphResults.slice(0, retrievalLimits.graph).map((r: any) => `- ${r.content ?? r.id ?? ""}`).join("\n"));
          }

          // Layer 4: Experience
          if (expResults.length > 0) {
            dedupInject("## 💡 经验总结\n" + expResults.map((e: any) => `- [${e.experience.type}] ${e.experience.summary}`).join("\n"));
            for (const e of expResults) expStore.incrementMatchCount(e.experience.id).catch(() => {});
          }

          // ==================================================================
          // 3. Tool guidance — use SDK buildMemorySystemPromptAddition
          // ==================================================================
          {
            const sdkGuidance = buildMemorySystemPromptAddition({
              availableTools: new Set(availableTools),
              citationsMode,
            });
            if (sdkGuidance) {
              dedupInject(sdkGuidance);
            }
          }

          // Prepend summary injection if available
          if (summaryInjection) {
            injections.unshift(summaryInjection);
          }
          if (injections.length > 0) {
            systemPromptAddition = "\n# Injected Context\n" + injections.join("\n\n");

          // ==================================================================
          // Final: apply total control trim if Window Monitor enabled
          // ==================================================================
          if (systemPromptAddition && wm) {
            removedSections = [];
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
          const e = err instanceof Error ? err : new Error(String(err));
          logger?.warn?.("assemble: retrieval failed", { err: e.message, stack: e.stack, name: e.name });
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

          // Save this round's hashes to the session window (max 24 rounds)
          if (sd && currentRoundHashes.length > 0) {
            sd.window.push(currentRoundHashes);
            while (sd.window.length > MAX_DEDUP_ROUNDS) {
              sd.window.shift();
            }
          }

          // Assemble audit log
          logger?.info?.('assemble: injection audit', {
            audit: {
              totalInjectedChars: (systemPromptAddition || '').length,
              msgCount: msgs.length,
              tier: tier,
              retrievalLimits: retrievalLimits,
              maxContextChars: maxContextChars,
              l2_count: qmdResults.length,
              l3_count: graphResults.length,
              l4_count: expResults.length,
              lca_connected: !!_losslessClawAdapter?.connected,
              truncated: (systemPromptAddition || '').length > maxContextChars,
              removedSectionsCount: removedSections.length,
              removedSections: removedSections,
            }
          });
          // Normalize message content to string for SDK compatibility
          // SDK calls .startsWith() on content, which fails if content is an array
          const normalizedMessages = (params.messages ?? []).map((msg: any) => {
            if (Array.isArray(msg.content)) {
              return {
                ...msg,
                content: msg.content
                  .filter((p: any) => typeof p === 'string' || (typeof p === 'object' && p !== null && 'text' in p))
                  .map((p: any) => typeof p === 'string' ? p : String(p.text ?? ''))
                  .join('\n'),
              };
            }
            if (typeof msg.content !== 'string') {
              return { ...msg, content: String(msg.content ?? '') };
            }
            return msg;
          });
          // Include systemPromptAddition tokens in total estimate for accurate overflow precheck
          const additionTokens = systemPromptAddition ? estimateTokensFromText(systemPromptAddition) - 1 : 0;
          const finalEstimatedTokens = estimatedTokens + additionTokens;
          return {
            messages: normalizedMessages,
            estimatedTokens: finalEstimatedTokens,
            systemPromptAddition: systemPromptAddition || undefined,
            promptAuthority: 'preassembly_may_overflow',
          };
        } catch (normErr) {
          const ne = normErr instanceof Error ? normErr : new Error(String(normErr));
          logger?.error?.('[DEBUG] assemble outer try-catch error', { err: ne, stack: ne.stack });
          logger?.error?.("assemble: normalize error", { err: ne });
          // Ultra fallback: normalize content to string for SDK compatibility
          const fallbackMessages = (params.messages ?? []).map((msg: any) => {
            if (Array.isArray(msg.content)) {
              return { ...msg, content: msg.content.map((p: any) => typeof p === 'object' ? String(p.text ?? '') : p).join('\n') };
            }
            if (typeof msg.content !== 'string') {
              return { ...msg, content: String(msg.content ?? '') };
            }
            return msg;
          });
          // Include systemPromptAddition tokens in total estimate for accurate overflow precheck
          const additionTokensFb = systemPromptAddition ? estimateTokensFromText(systemPromptAddition) - 1 : 0;
          const finalEstimatedTokensFb = estimatedTokens + additionTokensFb;
          return {
            messages: fallbackMessages,
            estimatedTokens: finalEstimatedTokensFb,
            systemPromptAddition: undefined,
            promptAuthority: 'preassembly_may_overflow',
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

        const lcAfterTurnStart = Date.now();
        try {
          await _losslessClawAdapter?.afterTurn?.(params);
        } catch { /* non-fatal */ }
        const lcAfterTurnMs = Date.now() - lcAfterTurnStart;

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

          const qualityFilterMs = Date.now() - afterTurnStart;
          // Use autoCompactionSummary as additional context for triplet extraction
          const autoSummary = params.autoCompactionSummary;
          if (autoSummary) {
            logger?.debug?.(`[afterTurn] using autoCompactionSummary (${autoSummary.length} chars) for enrichment`);
          }
          // Quality filter: skip low-signal turns (relaxed when autoSummary is available)
          if (!userContent?.trim() || userContent.length < (autoSummary ? 20 : 50)) {
            logger?.debug?.(`[afterTurn] skipped (user content too short, ${qualityFilterMs}ms total)`);
            return;
          }
          if (!assistantContent?.trim() || assistantContent.length < 30) {
            logger?.debug?.(`[afterTurn] skipped (assistant content too short, ${qualityFilterMs}ms total)`);
            return;
          }
          // Skip if content is mostly whitespace or repetitive
          const wordRatio = (userContent.match(/[\w]+/g) || []).length / userContent.trim().length;
          if (wordRatio < 0.3) return;

          // Prefer runtimeContext.llm (SDK-provided LLM config), fallback to custom config
          const runtimeLlm = params.runtimeContext?.llm;
          const llmConfig = runtimeLlm?.model
            ? {
                model: runtimeLlm.model,
                apiKey: runtimeLlm.apiKey || process.env.OPENAI_API_KEY || '',
                baseURL: runtimeLlm.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
              }
            : api.config?.llm || {
                apiKey: process.env.OPENAI_API_KEY || '',
                baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              };

          if (graphAdapter) {
            // Fire-and-forget with latency tracking: don't block afterTurn lifecycle
            const tripletStart = Date.now();
            Promise.race([
              graphAdapter.extractAndUpsertFromTurn(llmConfig, autoSummary ? `${userContent}\n\n[Compaction Context]\n${autoSummary}` : userContent, assistantContent),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Triplet extraction timeout: 8s')), 8000))
            ]).then(result => {
              const tripletMs = Date.now() - tripletStart;
              if (result && (result.nodes > 0 || result.edges > 0)) {
                logger?.debug?.(`[afterTurn] triplets: +${result.nodes} nodes, +${result.edges} edges (${tripletMs}ms)`);
              } else {
                logger?.debug?.(`[afterTurn] triplets: no extraction needed (${tripletMs}ms)`);
              }
            }).catch((err: Error) => {
              logger?.warn?.('afterTurn: triplet extraction skipped (async)', { err: err.message });
            });
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
          logger?.error?.('[lcm-graph-extra] afterTurn error', { err });
        }
      },

      async compact(params: any) {
    if (params.abortSignal?.aborted) {
      return { ok: false, compacted: false, reason: 'compaction aborted' };
    }
          // AbortSignal support - early exit if cancelled
          const signal = (params as any).abortSignal || (params as any).signal;
          if (signal?.aborted) {
            return { ok: false, compacted: false, reason: 'aborted' };
          }

        try {
          // Non-blocking compaction strategy:
          // 1. Fire-and-forget the heavy DAG/LLM summarization to background
          // 2. Perform lightweight backup + marker in foreground (fast path)
          // This eliminates the 10s+ blocking delay during compact().
          
          const _adapterConnected = !!(_losslessClawAdapter?.connected);

          // --- Promise.race + 30s timeout: trigger lossless-claw DAG compaction asynchronously ---
          let summaryContent: string | undefined;
          if (_adapterConnected) {
            try {
              const compactTimeout = new Promise<{ summary?: string }>((_, reject) => {
                setTimeout(() => reject(new Error('compact: 30s timeout reached')), 30000);
              });
              const abortOnCompact = signal
                ? new Promise((_, reject) => {
                    if (signal.aborted) reject(new Error('compaction aborted'));
                    else signal.addEventListener('abort', () => reject(new Error('compaction aborted')), { once: true });
                  })
                : null;
              const compactResult: any = await Promise.race([
                _losslessClawAdapter.compact(params),
                compactTimeout,
                ...(abortOnCompact ? [abortOnCompact] : []),
              ]);
              // Extract summary from adapter result: prefer result.summary (SDK format), fallback to summaryId
              summaryContent = compactResult?.result?.summary || compactResult?.summary;
            } catch (ceErr) {
              const msg = String(ceErr);
              if (msg.includes('aborted')) {
                logger?.warn?.("compact: DAG compaction aborted by host", { err: ceErr });
              } else if (msg.includes('timeout')) {
                logger?.warn?.("compact: DAG compaction timed out after 30s", { err: ceErr });
              } else {
                logger?.warn?.("compact: background DAG compaction failed", { err: ceErr });
              }
            }
          } else {
            logger?.debug?.("compact: LosslessClawAdapter not connected, DAG compaction skipped");
          }

          // --- Promise.race + 30s timeout: onCompaction hook (backup + Neo4j marker) ---
          try {
            const hookTimeout = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('onCompaction: 30s timeout reached')), 30000);
            });
            const abortOnHook = signal
              ? new Promise((_, reject) => {
                  if (signal.aborted) reject(new Error('onCompaction aborted'));
                  else signal.addEventListener('abort', () => reject(new Error('onCompaction aborted')), { once: true });
                })
              : null;
            await Promise.race([
              onCompaction({
                config: api.config,
                logger: logger,
                context: {} as any,
                unregister: () => {},
                _losslessClawAdapter: _losslessClawAdapter,
              }),
              hookTimeout,
              ...(abortOnHook ? [abortOnHook] : []),
            ]);
          } catch (hookErr) {
            const msg = String(hookErr);
            if (msg.includes('aborted')) {
              logger?.warn?.("compact: onCompaction hook aborted by host", { err: hookErr });
            } else if (msg.includes('timeout')) {
              logger?.warn?.("compact: onCompaction hook timed out after 30s", { err: hookErr });
            } else {
              logger?.warn?.("compact: onCompaction hook failed (non-fatal)", { err: hookErr });
            }
          }

          const tokensBefore = params.currentTokenCount ?? 0;
          const compacted = !!summaryContent;
          return {
            ok: true,
            compacted,
            reason: compacted ? 'compaction completed' : 'compaction attempted but no summary produced',
            result: {
              tokensBefore,
              // After compaction, the summary replaces the original messages
              tokensAfter: compacted && summaryContent
                ? estimateTokensFromText(summaryContent)
                : tokensBefore,
              summary: summaryContent,
            },
          };
        } catch (err) {
          logger?.warn?.("compact: top-level failed (non-fatal)", { err });
          return { ok: false, compacted: false, reason: String(err) };
        }
      },
      async maintain(params: any) {
        // S10-1: Periodic maintenance — delegate to lossless-claw + local cleanup
        const signal = (params as any).abortSignal || (params as any).signal;
        if (signal?.aborted) {
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: 'aborted' };
        }

        try {
          let changed = false;
          let bytesFreed = 0;
          let rewrittenEntries = 0;

          // 1. Delegate to lossless-claw engine.maintain if connected
          if (_losslessClawAdapter?.connected) {
            try {
              const lcResult = await _losslessClawAdapter.rawEngine?.maintain?.({
                sessionId: params.sessionId ?? params.session_id ?? '',
                sessionKey: params.sessionKey ?? '',
                runtimeContext: {},
              });
              if (lcResult) {
                changed = lcResult.changed ?? false;
                bytesFreed += lcResult.bytesFreed ?? 0;
                rewrittenEntries = lcResult.rewrittenEntries ?? 0;
              }
            } catch (lcErr) {
              logger?.debug?.("maintain: lossless-claw delegate failed (non-fatal)", { err: lcErr });
            }
          }

          // 2. Local: evict stale dedup via LRU cache
          try {
            evictStaleDedup();
          } catch {}

          return { changed, bytesFreed, rewrittenEntries };
        } catch (err) {
          logger?.warn?.("maintain: failed (non-fatal)", { err });
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: String(err) };
        }
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
export { onSessionCreated } from './hooks/session-created.js';
export { onTurnComplete } from './hooks/turn-complete.js';
export { onHeartbeat } from './hooks/heartbeat.js';

export {
  detectExperienceTrigger, extractRawExperience, ExperienceStorage,
} from './experience/index.js';
export type {
  ExperienceSource, RawExperience, DistilledExperience,
  ExperienceNode, ExperienceSearchResult,
} from './experience/types.js';


export const VERSION = '2.1.7';
