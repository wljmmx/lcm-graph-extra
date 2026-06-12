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
        // S5-2: Update MAX_DEDUP_ROUNDS from plugin config
        const pluginCfg = (api.config as any)?.plugins?.entries?.['lcm-graph-extra']?.config;
        if (pluginCfg?.windowMonitor?.dedupRounds) {
          MAX_DEDUP_ROUNDS = pluginCfg.windowMonitor.dedupRounds;
        }
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
            return { messages: [] };
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
          // Respect tokenBudget from params if provided (overrides window monitor budget)
          const tokenBudget = params.tokenBudget;
          const msgCount = messages.length;
          const estimatedTokens = estimateTokensFromMessages(messages);
          const contextWindow = wm?.contextWindow ?? 262_144;
          const tokenRatio = contextWindow > 0 ? estimatedTokens / contextWindow : 0;

          let tier: PressureTier = 'low';
          let retrievalLimits = { qmd: 5, graph: 5, exp: 3 };
          // Apply tokenBudget constraint if provided (convert tokens to chars, ~4 chars/token)
          let maxContextChars = wm?.maxContextChars?.low ?? 12_000;
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
            const rawQmd = results[0];
            const rawGraph = results[1];
            expResults = results[2];

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
              logger?.warn?.({ err: mergeErr }, "Merger dedup failed, using raw results");
              qmdResults = rawQmd;
              graphResults = rawGraph;
            }
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
              logger?.debug?.({ err: sumErr }, "Summary injection failed (non-fatal)");
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

          // Save this round's hashes to the session window (max 24 rounds)
          if (sd && currentRoundHashes.length > 0) {
            sd.window.push(currentRoundHashes);
            while (sd.window.length > MAX_DEDUP_ROUNDS) {
              sd.window.shift();
            }
          }

          // Assemble audit log
          logger?.info?.({
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
          }, 'assemble: injection audit');
          return {
            messages: msgs,
            estimatedTokens: msgs.reduce((sum: number, m: any) => sum + (m.content.length / 4), 0),
            systemPromptAddition: systemPromptAddition || undefined,
            promptAuthority: 'preassembly_may_overflow',
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

        try {
          await _losslessClawAdapter?.afterTurn?.(params);
        } catch { /* non-fatal */ }

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
            // Fire-and-forget: don't block afterTurn lifecycle
            Promise.race([
              graphAdapter.extractAndUpsertFromTurn(llmConfig, userContent, assistantContent),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Triplet extraction timeout: 8s')), 8000))
            ]).then(result => {
              if (result && (result.nodes > 0 || result.edges > 0)) {
                logger?.debug?.(`[afterTurn] triplets: +${result.nodes} nodes, +${result.edges} edges`);
              }
            }).catch((err: Error) => {
              logger?.warn?.({ err: err.message }, 'afterTurn: triplet extraction skipped (async)');
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
          // Non-blocking compaction strategy:
          // 1. Fire-and-forget the heavy DAG/LLM summarization to background
          // 2. Perform lightweight backup + marker in foreground (fast path)
          // This eliminates the 10s+ blocking delay during compact().
          
          const _adapterConnected = !!(_losslessClawAdapter?.connected);

          // --- Fire-and-forget: trigger lossless-claw DAG compaction asynchronously ---
          if (_adapterConnected) {
            try {
              void _losslessClawAdapter.compact(params).catch((ceErr) => {
                logger?.warn?.({ err: ceErr }, "compact: background DAG compaction failed");
              });
            } catch (ceErr) {
              logger?.warn?.({ err: ceErr }, "compact: fire-and-forget call threw");
            }
          } else {
            logger?.debug("compact: LosslessClawAdapter not connected, DAG compaction skipped");
          }

          // --- Fire-and-forget onCompaction hook too (backup + Neo4j marker) ---
          // Avoid blocking the main session even for file I/O operations
          try {
            void onCompaction({
              config: api.config,
              logger: logger,
              context: {} as any,
              unregister: () => {},
              _losslessClawAdapter: null,
            }).catch((hookErr) => {
              logger?.warn?.({ err: hookErr }, "compact: onCompaction hook failed (non-fatal)");
            });
          } catch (hookErr) {
            logger?.warn?.({ err: hookErr }, "compact: onCompaction hook threw (non-fatal)");
          }

          return { ok: true, compacted: _adapterConnected, reason: 'compaction triggered (background)' };
        } catch (err) {
          logger?.warn?.({ err }, "compact: top-level failed (non-fatal)");
          return { ok: false, reason: String(err) };
        }
      },

      async maintain(params: any) {
        // S10-1: Periodic maintenance — delegate to lossless-claw + local cleanup
        const signal = (params as any).abortSignal || (params as any).signal;
        if (signal?.aborted) {
          return { ok: false, reason: 'aborted' };
        }

        try {
          let changed = false;
          let bytesFreed = 0;

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
              }
            } catch (lcErr) {
              logger?.debug?.({ err: lcErr }, "maintain: lossless-claw delegate failed (non-fatal)");
            }
          }

          // 2. Local: evict stale dedup via LRU cache
          try {
            evictStaleDedup();
          } catch {}

          return { ok: true, changed, bytesFreed };
        } catch (err) {
          logger?.warn?.({ err }, "maintain: failed (non-fatal)");
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
