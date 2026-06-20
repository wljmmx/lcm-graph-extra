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

// @ts-ignore - plugin-sdk types only available at runtime
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// @ts-ignore - plugin-sdk types only available at runtime
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { registerOperationalTools, closeNeo4jDriver } from './tools.js';
import { UsageTracker } from "./async/usage-tracker"
import { onCompaction } from "./hooks/compaction";
import { LosslessClawAdapter } from "./middleware/lossless-claw-adapter";
import { resolveNeo4jConfig } from "./config/neo4j-helper";
import { withCircuitBreaker } from "./circuit-breaker.js";
import { resolveContextProfile } from "./config.js";

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
  getConversationSummaries,
  hasUncompressedMessages,
  trimSummariesToBudget,
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
/** Extract available tool names from assemble params. Hardcoded fallback for Tool Search mode. */
function extractAvailableTools(params: any): string[] {
  const tools = params.availableTools;
  if (!tools) return ["lcmg_search","lcmg_experience_report","lcmg_backup","lcmg_restore","lcmg_import","lcmg_pin","lcmg_sync","lcmg_qmd_status","lcmg_get_document","lcmg_batch_get_documents","lcmg_maintain"];
  if (tools instanceof Set) return [...tools].map((t: string) => t.toLowerCase());
  if (Array.isArray(tools)) return tools.map((t: string) => t.toLowerCase());
  return [];
}

/** Self-registered tool names — mirrors openclaw.plugin.json contracts.tools. */
const SELF_REGISTERED_TOOLS = new Set([
  "lcmg_search", "lcmg_pin", "lcmg_import",
  "lcmg_experience_report",
  "lcmg_qmd_status", "lcmg_get_document", "lcmg_batch_get",
  "lcmg_maintain", "lcmg_diagnose",
  "lcmg_backup", "lcmg_restore", "lcmg_sync",
]);

/** Tool category to tool name mapping. */
const TOOL_CATEGORIES_SELF: Record<string, Set<string>> = {
  graph: new Set(["lcmg_search"]),
  experience: new Set(["lcmg_experience_report"]),
  qmd: new Set(["lcmg_qmd_status", "lcmg_get_document", "lcmg_batch_get"]),
};

/** Check if a category tool is self-registered (independent of Tool Search). */
function hasSelfCategory(category: string): boolean {
  const names = TOOL_CATEGORIES_SELF[category];
  if (!names) return false;
  return [...names].some(n => SELF_REGISTERED_TOOLS.has(n));
}

/** Exact tool name sets per category — derived from contracts.tools. */
const TOOL_CATEGORIES: Record<string, ReadonlySet<string>> = {
  graph: new Set(["lcmg_search", "lcmg_pin", "lcmg_import"]),
  experience: new Set(["lcmg_experience_report"]),
  qmd: new Set(["lcmg_qmd_status", "lcmg_get_document", "lcmg_batch_get"]),
  maintenance: new Set(["lcmg_maintain", "lcmg_diagnose"]),
  lifecycle: new Set(["lcmg_backup", "lcmg_restore", "lcmg_sync"]),
};

/** Check if a tool category is available (exact match, no fallback). */
function hasToolCategory(availableTools: string[], category: string): boolean {
  const exactNames = TOOL_CATEGORIES[category];
  if (!exactNames) return false;
  return availableTools.some(t => exactNames.has(t));
}

function listActiveCategories(availableTools: string[]): string[] {
  const active: string[] = [];
  for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
    if (availableTools.some(t => names.has(t))) {
      active.push(cat);
    }
  }
  return active;
}

/** Build tool guidance section for systemPromptAddition. */
function buildToolGuidance(availableTools: string[]): string {
  const activeCategories = listActiveCategories(availableTools);
  if (activeCategories.length === 0 && availableTools.length === 0) {
    return "";
  }

  const categoryLabels: Record<string, { label: string; desc: string }> = {
    graph: { label: "知识图谱", desc: "实体关系查询" },
    experience: { label: "经验检索", desc: "历史解决方案检索" },
    qmd: { label: "记忆文件", desc: "QMD 文档管理" },
    maintenance: { label: "系统维护", desc: "健康检查与修复" },
    lifecycle: { label: "生命周期", desc: "备份/恢复/同步" },
  };

  const lines = ["## [Available Tools]"];
  for (const cat of Object.keys(TOOL_CATEGORIES)) {
    const info = categoryLabels[cat];
    if (!info) continue;
    if (activeCategories.includes(cat)) {
      lines.push("- [OK] **" + info.label + "** -- " + info.desc);
    } else {
      lines.push("- [AUTO] **" + info.label + "** -- auto-injected, no manual call needed");
    }
  }

  if (availableTools.length === 0) {
    lines.push("\n> Tip: no lcm-graph-extra tools available, context auto-injected.");
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
let merger: any = null;
let expStore: any = null;
let _modelRegistry: Record<string, number> | undefined;
    // Session-isolated dedup: LRU cache, max 500 sessions, 1h TTL
// Each session tracks hashes for up to 24 rounds of conversation
const MAX_DEDUP_CAPACITY = 500;
const DEDUP_TTL_MS = 60 * 60 * 1000;
const sessionDedupCache = new Map<string, { window: string[][]; maxRounds: number; lastAccess: number }>();
const dedupAccessOrder: string[] = [];
let MAX_DEDUP_ROUNDS = 24;  // S5-2: updated from config during init()
let _sessionOverheadCache = new Map<string, number>();  // per-session cached additionTokens for tier estimation

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

        // S1-1: Initialize Merger for entity-level cross-engine dedup
        const { Merger } = await import("./merger.js");
        merger = new Merger({
          maxResults: (api.config?.retrieval?.limits ?? {}).qmd
            ? (api.config.retrieval.limits.qmd + (api.config.retrieval.limits.graph ?? 5))
            : 10,
          fuzzyMatchThreshold: 0.85,
          decayHalfLifeDays: 30,
        });
        // S5-2: Update MAX_DEDUP_ROUNDS from plugin config
        // WindowMonitor config is at api.config.windowMonitor (not nested under plugins.entries)
        if (api.config?.windowMonitor?.dedupRounds) {
          MAX_DEDUP_ROUNDS = api.config.windowMonitor.dedupRounds;
        }

        // Read provider model context window from openclaw.json
        try {
          const { homedir } = await import("node:os");
          const defaultConfigPath = homedir() + "/.openclaw/openclaw.json";
          const { readFileSync } = await import("node:fs");
          const cfg = JSON.parse(readFileSync(defaultConfigPath, "utf8"));
          const modelRegistry: Record<string, number> = {};
          const providers = cfg?.models?.providers ?? {};
          for (const [providerKey, providerDef] of Object.entries(providers)) {
            const provider = providerDef as any;
            if (Array.isArray(provider.models)) {
              for (const m of provider.models) {
                if (m.contextWindow && typeof m.contextWindow === "number") {
                  modelRegistry[providerKey + "/" + m.id] = m.contextWindow;
                }
              }
            }
          }
          _modelRegistry = modelRegistry;
          logger?.debug?.("cached " + Object.keys(modelRegistry).length + " model context window(s)");
        } catch { /* non-fatal, will use defaults */ }

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
        let maxContextChars = 12000;
        let finalMessages = params.messages ?? [];
        let finalEstimate = 0;
        let qmdResults: any = [];
        let graphResults: any = [];
        let expResults: any = [];
        let removedSections: { label: string; chars: number }[] = [];
        let _overheadCacheKey = "";

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
          const modelFullId = typeof params.model === "string" ? params.model : "";
          // Exact match first, then fuzzy fallback if registry key not found
          let providerModelCtx = _modelRegistry ? _modelRegistry[modelFullId] : undefined;
          logger.info(`[TOKEN-BUDGET] tokenBudget=${tokenBudget}, estimatedTokens=${estimatedTokens}, model=${modelFullId}`);
          if (providerModelCtx === undefined && _modelRegistry && modelFullId) {
            const shortId = modelFullId.includes('/') ? modelFullId.split('/').pop() : modelFullId;
            for (const [key, val] of Object.entries(_modelRegistry)) {
              if (key.endsWith(shortId)) {
                providerModelCtx = val;
                logger?.debug?.("model context fallback: " + modelFullId + " -> " + key + " (" + val + ")");
                break;
              }
            }
          }
          const resolvedCtx = resolveContextProfile(providerModelCtx, wm || undefined);
          const contextWindow = resolvedCtx.contextWindow;
          // Factor in systemPromptAddition overhead from previous round
          _overheadCacheKey = (params as any).sessionKey ?? (params as any).conversationId ?? "default";
          const overheadTokens = _sessionOverheadCache.get(_overheadCacheKey) ?? 0;
          const effectiveTokenCount = estimatedTokens + overheadTokens;
          const tokenRatio = contextWindow > 0 ? effectiveTokenCount / contextWindow : 0;

          tier = 'low';
          retrievalLimits = resolvedCtx.retrievalLimits;
          // Apply tokenBudget constraint if provided (convert tokens to chars, ~4 chars/token)
          maxContextChars = resolvedCtx.maxContextChars.low;
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
              low: resolvedCtx.retrievalLimits,
              medium: { qmd: Math.max(1, Math.round(resolvedCtx.retrievalLimits.qmd * 0.6)), graph: Math.max(1, Math.round(resolvedCtx.retrievalLimits.graph * 0.6)), exp: Math.max(0, Math.round(resolvedCtx.retrievalLimits.exp * 0.3)) },
              high: { qmd: 1, graph: 1, exp: 0 },
            });
            maxContextChars = getMaxContextCharsForTier(tier, {
              low: resolvedCtx.maxContextChars.low,
              medium: resolvedCtx.maxContextChars.medium,
              high: wm?.maxContextChars?.high ?? 1_600,
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
                { tokenRatio: Number(tokenRatio.toFixed(3)), effectiveTokenCount, estimatedTokens, contextWindow },
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
                  currentTokenCount: effectiveTokenCount,
                  compactionTarget: 'preventive',
                }).catch(() => {});
              }
            }
          }

          // ==================================================================
          
          // ==================================================================
          // 2. Pressure-tier message assembly
          // ==================================================================
          finalMessages = messages;

          if (needsCompact && _losslessClawAdapter?.connected) {
            const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
              : typeof params.session_id === 'string' ? params.session_id
              : '';
            const conversationId = getConversationId(sessionKey);
            if (conversationId != null) {
              const compactTimeout = (parseInt(process.env.LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS || '0') || ((wm as any)?.compactTimeout as number)) ?? 300_000;
              const maxSummaryRatio = (wm as any)?.maxSummaryTokenRatio ?? 0.45;
              const sessionFile = typeof params.sessionFile === 'string' ? params.sessionFile : '';

              // Design: <=dedupRounds -> pass through; medium -> summaries+raw+debt; high -> blocking compact+trim
              const convSummaries = getConversationSummaries(conversationId);
              const hasExistingSummary = convSummaries.length > 0;
              const rawCount = messages.length;
              const dedupLimit = (wm as any)?.dedupRounds ?? 24;

              if (tier === 'medium') {
                // Medium: fire-and-forget compact, assemble summaries + all raw msgs, write debt if needed
                _losslessClawAdapter.compact({
                  sessionId: conversationId, sessionKey, sessionFile, force: true,
                  tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
                  compactionTarget: 'threshold',
                }).catch(() => {});

                if (hasExistingSummary) {
                  const summaryMsgs = convSummaries.map((s) => ({
                    role: 'user', content: s.content, token_count: s.tokenCount,
                  }));
                  finalMessages = summaryMsgs;
                }

                // Use hasUncompressedMessages to confirm there are messages needing compression
                const hasPendingUncompressed = hasUncompressedMessages(conversationId);
                if (rawCount > dedupLimit || hasPendingUncompressed) {
                  writeCompactionDebt(
                    conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
                    'medium_pressure_uncompressed_' + rawCount + '_exceeds_' + dedupLimit,
                  );
                }
              } else if (tier === 'high') {
                // High: BLOCKING emergency compaction + trim excess
                try {
                  await Promise.race([
                    _losslessClawAdapter.compact({
                      sessionId: conversationId, sessionKey, sessionFile, force: true,
                      tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
                      compactionTarget: 'threshold',
                    }),
                    new Promise((_, r) => setTimeout(() => r(new Error('Compact timeout')), compactTimeout)),
                  ]);
                  const freshSummaries = getConversationSummaries(conversationId);
                  if (freshSummaries.length > 0) {
                    const trimmedSummaryMsgs = trimSummariesToBudget(
                      freshSummaries.map((s) => ({ summaryId: s.summaryId, content: s.content, tokenCount: s.tokenCount })),
                      resolvedCtx.compactTokenBudget * maxSummaryRatio,
                    ).map((s) => ({ role: 'user', content: s.content, token_count: s.tokenCount }));
                    // Preserve last user message for context
                    const lastOriginalMsg = messages.at(-1);
                    finalMessages = lastOriginalMsg
                      ? [...trimmedSummaryMsgs, lastOriginalMsg]
                      : trimmedSummaryMsgs;
                  } else {
                    writeCompactionDebt(
                    conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
                      'high_pressure_no_summary_after_compact',
                    );
                  }
                } catch (err) {
                  logger?.warn?.('High pressure compact failed, writing debt', err);
                  writeCompactionDebt(
                    conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
                    'high_pressure_compact_failed',
                  );
                }
              } else {
                // Low pressure but needsCompact: write debt + fire-and-forget
                writeCompactionDebt(
                    conversationId, resolvedCtx.compactTokenBudget, effectiveTokenCount,
                  'proactive_' + tier + '_pressure',
                );
                _losslessClawAdapter.compact({
                  sessionId: conversationId, sessionKey, sessionFile, force: true,
                  tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
                  compactionTarget: 'threshold',
                }).catch(() => {});
              }
            }
          } else if (needsCompact) {
            // needsCompact but no adapter
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
                  const _l2e = e as Error; const _l2m = _l2e.message;
          if (_l2m.includes("circuit breaker")) {
            logger?.warn?.("L2 qmd: circuit breaker OPEN, skipping", { err: _l2m });
          } else if (_l2m.includes("MCP HTTP")) {
            logger?.warn?.("L2 qmd: MCP service error (" + _l2m + "), falling back to CLI");
          } else if (_l2m.includes("empty response")) {
            logger?.warn?.("L2 qmd: MCP returned empty result, falling back to CLI");
          } else if (_l2m.includes("CLI output")) {
            logger?.warn?.("L2 qmd: CLI fallback also failed (" + _l2m + ")");
          } else {
            logger?.warn?.("L2 qmd: error - " + _l2m);
          }
                  return { results: [], ms: Date.now() - t0 };
                }
              })(),
              // L3: Neo4j knowledge graph — skip if not self-registered
              (async () => {
                const t0 = Date.now();
                try {
                  const selfHasGraph = hasSelfCategory("graph");
                  if (!selfHasGraph) {
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
              // L4: Experience search — skip if not self-registered
              (async () => {
                const t0 = Date.now();
                try {
                  const selfHasExp = hasSelfCategory("experience");
                  if (!selfHasExp) {
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

            // S1-1: Use Merger for entity-level cross-engine dedup (replaces hand-written ID dedup)
            try {
              if (merger && Array.isArray(rawQmd) && Array.isArray(rawGraph)) {
                const merged = merger.merge(rawQmd, rawGraph);
                qmdResults = merged;
                graphResults = merged;  // same entity-deduped results for both
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
          // Final token estimate based on actual messages being returned
          const finalEstimate = estimateTokensFromMessages(finalMessages);
logger?.info?.(`⚡ assemble=${Date.now()-assembleStart}ms | init=${initMs}ms | parallel=${parallelMs}(L2_qmd=${l2_ms},L3_graph=${l3_ms},L4_exp=${l4_ms}) | mg=${mgMs}ms | estimatedTokens=${finalEstimate}/${contextWindow}(${(finalEstimate/contextWindow*100).toFixed(1)}%) | overhead=${overheadTokens} | effectiveTokenCount=${effectiveTokenCount} | msgCount=${msgCount} | tier=${tier}`, {
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
          // ---- Pre-seed dedup hashes from existing system messages (L1 summaries) ----
          // Medium/High pressure tiers may have already injected summary messages;
          // seed their hashes so L2/L3/L4 content won't duplicate them
          if (_losslessClawAdapter?.connected && (tier === 'medium' || tier === 'high')) {
            for (const msg of finalMessages) {
              if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('##')) {
                const h = quickHash(msg.content);
                allSessionHashes.add(h);
              }
            }
          }

          // S5-3: Inject L2/L3/L4 into systemPromptAddition (not finalMessages)
          // Layer priority (higher = harder to trim):
          //   L1(summary)=0  <  L2(docs)=3  <  L3(graph)=4  <  L4(experience)=5
          const sections: { label: string; body: string; layer: number }[] = [];

          function addSection(label: string, body: string, layer: number): void {
            if (!body) return;
            const h = quickHash(label + body);
            if (allSessionHashes.has(h)) return;
            allSessionHashes.add(h);
            currentRoundHashes.push(h);
            sections.push({ label, body, layer });
          }

          // Layer 4: Experience
          if (expResults.length > 0) {
            const expBody = expResults.map((e: any) => '- [' + e.experience.type + '] ' + e.experience.summary).join('\n');
            addSection('## \ud83d\udca1 经验总结', expBody, 5);
            for (const e of expResults) expStore.incrementMatchCount(e.experience.id).catch(() => {});
          }

          // Layer 3: Neo4j knowledge graph
          if (graphResults && Array.isArray(graphResults) && graphResults.length > 0) {
            const graphBody = graphResults.slice(0, retrievalLimits.graph).map((r: any) => '- ' + (r.content ?? r.id ?? '')).join('\n');
            addSection('## \ud83d\udd17 知识图谱', graphBody, 4);
          }

          // Layer 2: qmd search snippet results
          const hasFullDocs = Array.isArray(fullDocs) && fullDocs.length > 0;
          if (qmdResults && Array.isArray(qmdResults) && !hasFullDocs) {
            const qmdItems = qmdResults.slice(0, retrievalLimits.qmd).map((r: any, i: number) => {
              const citationTag = citationsMode === 'always' || citationsMode === 'auto'
                ? ' [src:' + String(i+1) + ']'
                : '';
              return '- ' + (r.content ?? '') + citationTag;
            }).join('\n');
            addSection('## \ud83d\udcc4 记忆文件', qmdItems, 3);
          }

          // Batch-enriched full document content
          if (Array.isArray(fullDocs) && fullDocs.length > 0) {
            const docBlock = fullDocs
              .filter(Boolean)
              .slice(0, retrievalLimits.qmd)
              .map((doc: string) => {
                const docLimit = resolvedCtx.maxContextChars.low;
                if (doc.length > docLimit) {
                  const headLen = Math.floor(docLimit * 0.6);
                  const tailLen = docLimit - headLen;
                  return doc.slice(0, headLen) + '\n...[中间内容已截断]...\n' + doc.slice(-tailLen);
                }
                return doc;
              })
              .join('\n\n---\n\n');
            if (docBlock) {
              addSection('## \ud83d\udcc4 完整文档已加载', docBlock, 3);
            }
          }

          // Layer 1: lossless-claw summaries (low tier only)
          if (_losslessClawAdapter?.connected && tier === 'low') {
            try {
              const convStore = _losslessClawAdapter.rawEngine?.getConversationStore?.();
              if (convStore) {
                const recentSummaries = typeof convStore.getRecentSummaries === 'function'
                  ? convStore.getRecentSummaries(sessionKey, 3)
                  : [];
                if (Array.isArray(recentSummaries) && recentSummaries.length > 0) {
                  const summaryText = recentSummaries.map((s: any, i: number) =>
                    '- [摘要' + String(i+1) + '] ' + '(s?.content ?? s?.summary ?? String(s)).slice(0, 500)'
                  ).join('\n');
                  addSection('## \ud83d\udccb 历史摘要', summaryText, 0);
                }
              }
            } catch (sumErr) {
              logger?.debug?.('Summary injection failed (non-fatal)', { err: sumErr });
            }
          }

          // ==================================================================
          // 3. Build systemPromptAddition: Tool Guidance + injected sections
          // ==================================================================
          {
            const sdkGuidance = buildMemorySystemPromptAddition({
              availableTools: new Set(availableTools),
              citationsMode,
            });
            let addition = '';
            if (sdkGuidance) {
              addition += '\n# Tool Guidance\n' + sdkGuidance;
            }
            for (const sec of sections) {
              addition += '\n---\n' + sec.label + '\n' + sec.body;
            }
            systemPromptAddition = addition || '';
          }

          // ==================================================================
          // Final: Priority-based token budget trim (protect L4 > L3 > L2 > L1)
          // Trim from sections array, then rebuild systemPromptAddition
          // ==================================================================
          if (wm && sections.length > 0) {
            const estimateTotal = () => estimateTokensFromMessages(finalMessages) + Math.floor(systemPromptAddition.length / 4);
            const budgetCeiling = contextWindow * 0.85;
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
              sections.splice(worstIdx, 1);
              trimmed++;
              const sdkGuidance2 = buildMemorySystemPromptAddition({
                availableTools: new Set(availableTools),
                citationsMode,
              });
              let rebuilt = '';
              if (sdkGuidance2) {
                rebuilt += '\n# Tool Guidance\n' + sdkGuidance2;
              }
              for (const sec of sections) {
                rebuilt += '\n---\n' + sec.label + '\n' + sec.body;
              }
              systemPromptAddition = rebuilt || '';
            }
            if (trimmed > 0) {
              logger?.debug?.('[wm] priority-trimmed ' + String(trimmed) + ' injected section(s), remaining: ' + sections.map(function(s) { return s.label; }).join(','));
            }
          }
        } catch (err) {

          const e = err instanceof Error ? err : new Error(String(err));
          logger?.warn?.("assemble: retrieval failed", { err: e.message, stack: e.stack, name: e.name });
        }

        // Pass through messages as-is (lossless-claw style, no normalization needed)
        // SDK handles content format natively; estimateTokensFromMessages supports both string and array content
        try {
          // Tokens: injected system messages are now part of finalMessages,
          // so estimateTokensFromMessages covers them. systemPromptAddition only has tool guidance (small).
          const messageTokens = estimateTokensFromMessages(finalMessages);
          let additionTokens = 0;
          if (typeof systemPromptAddition === "string" && systemPromptAddition.length > 0) {
            additionTokens = estimateTokensFromText(systemPromptAddition);
          }
          // Cache for next-round tier estimation (per-session)
          _sessionOverheadCache.set(_overheadCacheKey, additionTokens);
          return {
            messages: finalMessages,
            estimatedTokens: messageTokens + additionTokens,
            systemPromptAddition: systemPromptAddition || undefined,
            promptAuthority: typeof systemPromptAddition == "string" && systemPromptAddition.length > 0 ? "preassembly_may_overflow" : "assembled",
          };
        } catch (finalErr) {
          const fe = finalErr instanceof Error ? finalErr : new Error(String(finalErr));
          logger?.error?.("assemble: return error", { err: fe.message, stack: fe.stack });
          return {
            messages: finalMessages,
            estimatedTokens: estimateTokensFromMessages(finalMessages),
            systemPromptAddition: undefined,
            promptAuthority: "assembled",
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
          // S3-5 fix: extract actual text from content array (not JSON.stringify)
          const extractText = (c: any): string => {
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map((item: any) => typeof item === 'string' ? item : (item?.text ?? JSON.stringify(item))).join('');
            return JSON.stringify(c);
          };

          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            const role = m.role ?? '';
            if (!userContent && role === 'user') {
              userContent = extractText(m.content);
            } else if (!assistantContent && role === 'assistant') {
              assistantContent = extractText(m.content);
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
              new Promise((_, reject) => setTimeout(() => reject(new Error('Triplet extraction timeout')), (api.config?.tripletTimeoutMs ?? 8000)))
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

          // --- Promise.race + 300s (5min) timeout: trigger lossless-claw DAG compaction asynchronously ---
          let summaryContent: string | undefined;
          if (_adapterConnected) {
            try {
              const compactTimeout = new Promise<{ summary?: string }>((_, reject) => {
                setTimeout(() => reject(new Error('compact: 300s timeout reached')), (parseInt(process.env.LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS || '0') as number) || 300_000);
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
            logger?.debug?.("[lcm-graph-extra] LosslessClawAdapter not connected, skipping DAG compact");
          }

          // --- Promise.race + 300s (5min) timeout: onCompaction hook (backup + Neo4j marker) ---
          try {
            const hookTimeout = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('onCompaction: 300s timeout reached')), (parseInt(process.env.LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS || '0') as number) || 300_000);
            });
            const abortOnHook = signal
              ? new Promise((_, reject) => {
                  if (signal.aborted) reject(new Error('onCompaction aborted'));
                  else signal.addEventListener('abort', () => reject(new Error('onCompaction aborted')), { once: true });
                })
              : null;
            // Resolve memoryDir from params or api.config for onCompaction
            // Derive memoryDir from sessionFile provided by SDK (authoritative)
            const { resolveMemoryDir } = await import("./core/debt-manager.js");
            const _memoryDir = resolveMemoryDir(
              typeof params.sessionFile === "string" ? params.sessionFile : undefined,
              api.config
            );
            const _sessionKey = typeof params.sessionKey === "string" ? params.sessionKey
              : typeof params.session_id === "string" ? params.session_id : undefined;
            const _sessionFile = typeof params.sessionFile === "string" ? params.sessionFile : undefined;
            await Promise.race([
              onCompaction({
                config: api.config,
                logger: logger,
                context: {
                  memoryDir: _memoryDir,
                  sessionKey: _sessionKey,
                  sessionFile: _sessionFile,
                  sessionId: params.sessionId ?? params.session_id,
                } as any,
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
        // Stop debt scheduler and heartbeat timers on dispose
        (async () => { try { const { stopScheduler } = await import('./core/debt-manager.js'); await stopScheduler(); } catch {} })()
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
        // Close Neo4j driver pool before resetting to avoid "Pool is closed" errors
        try { (graphAdapter as any)?.close?.(); } catch {}
        tracker?.close?.();
        (async () => { try { await closeNeo4jDriver(); } catch {} })()
        try { (graphAdapter as any)?.close?.(); } catch {}
        initialized = false;
        initPromise = null;
        qmdClient = null;
        graphAdapter = null;
        expStore = null;
      },
    }));

    registerOperationalTools(api);
    // -------------------------------------------------------------------
    // Heartbeat - periodic async maintenance (every 5 minutes)
    //   1. Compaction pressure check + predictive pre-compaction
    //   2. qmd MCP health check
    //   3. (future) PENDING experience distillation
    // -------------------------------------------------------------------
    const HB_INTERVAL_MS = 5 * 60 * 1000;
    let hbTimer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;
    let lastDistillationRun = 0;
    let hbDedupCleanupCounter = 0;  // Clean dedup cache every 15 heartbeats (~75min)
    // Distillation helpers

    function resolveDistillationLlm(apiRef: any) {
      const runtimeLlm = apiRef.runtimeContext?.llm;
      if (runtimeLlm?.model) return { model: runtimeLlm.model, apiKey: runtimeLlm.apiKey || '', baseURL: runtimeLlm.baseURL || 'http://127.0.0.1:18789/v1' };
      const dLlm = (apiRef.config as any)?.distillationLlm;
      if (dLlm?.provider === 'openclaw_hooks') return { model: dLlm.model || 'ollama/qwen3.6:27b', apiKey: '', baseURL: 'http://127.0.0.1:18789/v1' };
      return { model: process.env.LLM_MODEL || dLlm?.model || 'gpt-4o-mini', apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '', baseURL: process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' };
    }

    async function distillOne(raw: { id: string; source: string; context: string; detail: string }, llm: { model: string; apiKey: string; baseURL: string }): Promise<any | null> {
      const prompt = 'Summarize the following experience into a concise lesson.' + '\nSource: ' + raw.source + '\nContext: ' + raw.context + '\nDetail: ' + raw.detail + '\nReturn a JSON with: title, summary, type (lesson|failure|correction|fix|best_practice), relevanceScore (0-1). Return ONLY JSON.';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (llm.apiKey) headers['Authorization'] = 'Bearer ' + llm.apiKey;
        const resp = await fetch(llm.baseURL + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: llm.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 512 }), signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const data: any = await resp.json();
        const text = data?.choices?.[0]?.message?.content;
        if (!text) return null;
        const parsed = JSON.parse(text);
        return { id: 'exp_dist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10), rawIds: [raw.id], type: parsed.type || 'lesson', title: parsed.title || raw.source, summary: parsed.summary || '(no summary)', detail: (raw.detail || '').slice(0, 2000), context: raw.context || '', relevanceScore: parsed.relevanceScore ?? 0.5, createdAt: new Date(), matchCount: 0 };
      } catch { clearTimeout(timer); return null; }
    }

    async function runDistillation(expStoreRef: any, apiRef: any, log: any): Promise<void> {
      try {
        const pending = await expStoreRef.fetchPending(5);
        if (!pending.length) return;
        log?.info?.('distillation: processing ' + String(pending.length) + ' pending');
        const llm = resolveDistillationLlm(apiRef);
        for (const raw of pending) {
          try {
            const distilled = await distillOne(raw, llm);
            if (distilled) { await expStoreRef.saveDistilled(distilled); await expStoreRef.deleteById(raw.id); }
          } catch (e) { log?.warn?.("distillation item failed", { err: String(e) }); }
        }
      } catch (e) { log?.warn?.("distillation batch failed", { err: String(e) }); }
    }

    async function runHeartbeat() {
      if (!initialized) return;
      const t0 = Date.now();
      try {
        // --- 1. Compaction pressure check (scan .lossless/ directories) ---
        try {
          const { readdirSync, readFileSync, existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          const wsDir = process.env.OPENCLAW_WORKSPACE || 
            (typeof api?.config?.workspace === "string" ? api.config.workspace : 
             (typeof process?.cwd === "function" ? process.cwd() : null));
          if (wsDir && existsSync) {
            const losslessDir = join(wsDir, ".lossless");
            
            // pending messages count
            let pendingMessages = 0;
            const sessionDir = join(losslessDir, "sessions");
            if (existsSync(sessionDir)) {
              const files = readdirSync(sessionDir).filter((f) => f.endsWith(".json"));
              for (const sf of files) {
                try {
                  const data = JSON.parse(readFileSync(join(sessionDir, sf), "utf8"));
                  pendingMessages += Array.isArray(data.messages) ? data.messages.length : 0;
                } catch { /* skip */ }
              }
            }
            
            // summary fragments count
            let summaryFragments = 0;
            const summaryDir = join(losslessDir, "summaries");
            if (existsSync(summaryDir)) {
              summaryFragments = readdirSync(summaryDir).filter((f) => f.endsWith(".json")).length;
            }
            
            // token ratio from debt files
            let maxTokenRatio = 0;
            const debtDir = join(losslessDir, "debt");
            if (existsSync(debtDir)) {
              const debtFiles = readdirSync(debtDir).filter((f) => f.endsWith(".json"));
              for (const df of debtFiles) {
                try {
                  const debt = JSON.parse(readFileSync(join(debtDir, df), "utf8"));
                  if (debt.currentTokenCount) {
                    maxTokenRatio = Math.max(maxTokenRatio, debt.currentTokenCount / 262144);
                  }
                } catch { /* skip */ }
              }
            }
            
            // Check thresholds
            const signals = [];
            if (pendingMessages >= 15) signals.push("pending_msgs>=" + pendingMessages);
            if (summaryFragments >= 8) signals.push("summary_frags>=" + summaryFragments);
            if (maxTokenRatio > 0.65) signals.push("token_ratio>" + maxTokenRatio.toFixed(3));
            if (signals.length > 0) {
              logger?.warn?.("heartbeat: pressure threshold(s) exceeded, writing debt for affected sessions", { signals });
              // writeCompactionDebt is already imported at top; use it directly
              try {
                if (existsSync(sessionDir)) {
                  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".json"));
                  for (const sf of files) {
                    try {
                      const data = JSON.parse(readFileSync(join(sessionDir, sf), "utf8"));
                      const convId = getConversationId(data.sessionKey, String(data.sessionId || ''));
                      if (!convId) continue;
                      const tokenCount = Math.round((maxTokenRatio || 0.5) * 262144);
                      writeCompactionDebt(convId, 114688, tokenCount, "hb_pressure_" + signals.length + "dims");
                    } catch { /* skip bad session file */ }
                  }
                }
              } catch (debtWriteErr) {
                logger?.warn?.("heartbeat: debt write failed", { err: String(debtWriteErr) });
              }
              // Debt scheduler (resident) will pick this up automatically
            }
          }
        } catch { /* pressure check failed, non-fatal */ }
        
        // --- 2. qmd MCP health check ---
        if (qmdClient && typeof qmdClient.ping === "function") {
          try {
            const qmdOnline = await qmdClient.ping();
            if (!qmdOnline) {
              logger?.warn?.("heartbeat: qmd MCP unavailable");
            }
          } catch { /* qmd health check failed, non-fatal */ }
        }
        
        // --- 3. Experience distillation (scheduled async, default every 2h) ---
        const distillIntervalMs = api.config?.distillationIntervalMs ?? 2 * 60 * 60 * 1000;
        if (expStore && typeof expStore.fetchPending === "function") {
          const elapsed = Date.now() - lastDistillationRun;
          if (elapsed >= distillIntervalMs) {
            lastDistillationRun = Date.now();
            runDistillation(expStore, api, logger).catch((e: any) => {
              logger?.warn?.("distillation batch failed", { err: String(e) });
            });
          }
        }
        try { logger?.debug?.("heartbeat: cycle completed in " + String(Date.now() - t0) + "ms"); } catch { /* logger crash, non-fatal */ }

        // Periodic dedup cache cleanup (every 15 heartbeats)
        hbDedupCleanupCounter++;
        if (hbDedupCleanupCounter >= 15 && typeof evictStaleDedup === "function") {
          evictStaleDedup();
          hbDedupCleanupCounter = 0;
        }
      } catch (hbErr) {
        logger?.error?.("heartbeat: cycle failed", { err: hbErr instanceof Error ? hbErr.message : String(hbErr) });
      }
    }
    
    // ── Start resident debt scheduler (fire-and-forget, picks up debts every 60s) ──
    (async () => {
      try {
        const { startScheduler } = await import("./core/debt-manager.js");
        await startScheduler(
          async (instance) => {
            const { onCompaction } = await import("./hooks/compaction.js");
            await onCompaction(instance);
          },
          { config: api.config, logger: logger },
          { pollIntervalMs: 60_000, maxConcurrent: 2, urgentThreshold: 0.7 }
        );
        logger?.info?.("debt-manager: resident scheduler started");
      } catch (schedErr) {
        logger?.warn?.("debt-manager: failed to start scheduler", { err: String(schedErr) });
      }
    })();

    lastDistillationRun = Date.now();

    // Start heartbeat 60s after plugin init, then every 5 minutes
    hbTimer = setTimeout(function startHb() {
      runHeartbeat();
      hbTimer = setInterval(runHeartbeat, HB_INTERVAL_MS);
    }, 60_000);
    
    // Expose for manual trigger
    (api as any).__lcmHeartbeat = runHeartbeat;
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

export {
  detectExperienceTrigger, extractRawExperience, ExperienceStorage,
} from './experience/index.js';
export type {
  ExperienceSource, RawExperience, DistilledExperience,
  ExperienceNode, ExperienceSearchResult,
} from './experience/types.js';


export const VERSION = '2.1.7';
