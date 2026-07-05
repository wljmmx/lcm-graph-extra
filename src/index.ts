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
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
// @ts-ignore - plugin-sdk types only available at runtime
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";
import { registerOperationalToolsWithDashboard, closeNeo4jDriver, type DashboardToolContext } from './tools.js';
import { startDashboardSnapshotServer, type SnapshotProviders } from './dashboard-snapshot.js';
import { getSchedulerStats } from './core/debt-manager.js';
import { UsageTracker } from "./async/usage-tracker"
import { backgroundTasks } from "./async/task-registry.js"
import { cleanBaseURL, isOllamaEndpoint, withKeepAliveIfOllama } from "./utils/url.js"
import { onCompaction } from "./hooks/compaction";
import { LosslessClawAdapter } from "./middleware/lossless-claw-adapter";
import { resolveNeo4jConfig, resolveEmbeddingConfig } from "./config/neo4j-helper";
import { withCircuitBreaker } from "./circuit-breaker.js";
import { resolveContextProfile, PluginConfigSchema } from "./config.js";
import { setGlobalLogger, adaptLogger, createLogger, serializeError } from "./utils/logger.js";
import { DEFAULTS } from "./config/defaults.js";

import {
  type PressureInfo,
  type PressureTier,
  determinePressureTier,
  shouldTriggerCompact,
  getRetrievalLimitsForTier,
  getMaxContextCharsForTier,
  detectScenarioAndAdjustLimits,
  getConversationId,
  writeCompactionDebt,
  estimateTokensFromMessages,
  estimateTokensFromText,
  getConversationSummaries,
  hasUncompressedMessages,
  getUncompressedMessageCount,
  trimSummariesToBudget,
} from "./lcm-bridge.js";

// ---------------------------------------------------------------------------
// S-9': 关键词提取（轻量版）
// ---------------------------------------------------------------------------

const TOPIC_STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','can','this','that','these','those','it','its','for',
  'with','from','into','through','during','before','after','by','about',
  'and','or','but','not','no','yes','so','if','then','else','when',
  'what','which','who','whom','how','why','where','there','here',
  '的','了','在','是','我','有','和','就','不','人','都','一','一个','上',
  '也','很','到','说','要','去','你','会','着','没有','看','好','自己','这',
  '他','她','它','们','那','些','什么','怎么','吗','呢','吧','啊','哦',
  'please','just','need','want','like','get','make','use','using','used',
  'help','know','think','还是','可以','已经','现在','因为','所以','但是',
]);

/**
 * S-9': 从消息列表中提取 top-N 关键词，用于话题漂移检测。
 * 简单的词频统计 + 停用词过滤，零延迟。
 */
function extractTopKeywords(messages: any[], topN: number = 15): string[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const freq = new Map<string, number>();
  for (const msg of messages) {
    const content = msg?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.map((c: any) => typeof c === 'string' ? c : c?.text ?? '').join(' ');
    }
    if (!text) continue;
    const tokens = text
      .replace(/[\s,;.，；。.、:：!?！？\\/\\[\\](){}|~`@#$%^&*=+<>-]+/g, ' ')
      .split(/\s+/)
      .filter((t) => {
        const w = t.toLowerCase();
        return !TOPIC_STOP_WORDS.has(w) && w.length >= 2;
      });
    for (const tok of tokens) {
      const w = tok.toLowerCase();
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

/** Simple string hash for cross-turn dedup */
function quickHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
// P0-1: 静态导入经验提取函数，供 afterTurn 中直接调用。
import { detectExperienceTrigger, extractRawExperience } from './experience/index.js';
import { UserProfileTracker } from './experience/user-profile.js';

// S-7': 用户画像轻量版 —— 全局单例，带时间衰减
// 用于经验搜索的个性化加权，不持久化（重启重置）
const userProfile = new UserProfileTracker();

// N-4: 健康指标收集器 —— 全局单例
import { healthMetrics } from './health-metrics.js';

// G-8: 记录最近一轮 assemble 返回的经验 ID + query，供 afterTurn 异步验证
// B-1 修复: 原为模块级 let 变量，多 session 并发时 G-8 验证回路会串数据
// （session A 的 assemble 写入，session B 的 afterTurn 读取）。
// 改为 per-sessionKey Map，每个 session 独立追踪。
const lastAssembleExpIdsBySession = new Map<string, Array<{ id: string; summary: string; query: string }>>();
const LAST_EXP_MAP_MAX = 200; // 防止无界增长，LRU 上限

// R-2: 成本感知级联管理器 —— 全局单例
import { cascadeManager, CascadeManager } from './cascade-manager.js';

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
      // SEC-L: 修复前用 result.replace(candidate.content, '') —— String.replace 首个出现
      // 不一定是目标段（若段内容在多处重复会误删）。改为 indexOf 精确定位 + slice 移除。
      const idx = result.indexOf(candidate.content);
      if (idx !== -1) {
        result = (result.slice(0, idx) + result.slice(idx + candidate.content.length))
          .replace(/\n{3,}/g, '\n\n').trim();
      }
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

/** Extract available tool names from assemble params. Hardcoded fallback for Tool Search mode. */
function extractAvailableTools(params: any): string[] {
  const tools = params.availableTools;
  // P2-14: 修复拼写错误 lcmg_batch_get_documents → lcmg_batch_get，
  // 并补全遗漏的 lcmg_diagnose（与 SELF_REGISTERED_TOOLS 保持一致）。
  if (!tools) return ["lcmg_search","lcmg_experience_report","lcmg_backup","lcmg_restore","lcmg_import","lcmg_pin","lcmg_sync","lcmg_qmd_status","lcmg_get_document","lcmg_batch_get","lcmg_maintain","lcmg_diagnose"];
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

const pluginEntry: any = definePluginEntry({
  id: "lcm-graph-extra",
  name: "LCM Graph Extra",
  description: "Coordinates lossless-claw, qmd, and graph-memory-pro for enhanced context assembly",
  configSchema: buildJsonPluginConfigSchema(PluginConfigSchema as any),
  register(api: any): void {
    const logger = api.logger;
    // P3-B1: 注入全局 logger，供 retrieval-gateway、qmd-client、tools 等无注入路径的模块使用。
    // 宿主 api.logger 通常是 pino 实例；用 adaptLogger 适配为统一 Logger 接口。
    // 若宿主未注入 logger，降级到 createLogger()（按 LOG_LEVEL 环境变量控制级别）。
    setGlobalLogger(logger ? adaptLogger(logger) : createLogger());

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
    // Dashboard 快照服务停止函数（register 时启动，dispose 时调用）；null 表示未启动
    let snapshotServerStop: (() => Promise<void>) | null = null;
    // 最近一次 assemble 的检索 query，供 dashboard /internal/snapshot 只读访问
    let lastRetrievalQuery: string = '';
    // Session-isolated dedup: LRU cache, max 500 sessions, 1h TTL
// Each session tracks hashes for up to 24 rounds of conversation
// P2-3 H-16: dedup 容量/TTL/轮次常量改接 DEFAULTS，单一来源，避免魔术数字散落。
const MAX_DEDUP_CAPACITY = DEFAULTS.dedup.maxCapacity;
const DEDUP_TTL_MS = DEFAULTS.dedup.ttlMs;
const sessionDedupCache = new Map<string, { window: string[][]; maxRounds: number; lastAccess: number }>();
const dedupAccessOrder: string[] = [];
let MAX_DEDUP_ROUNDS = DEFAULTS.dedup.maxRounds;  // S5-2: updated from config during init()
// P1-4 M-6: _sessionOverheadCache 加 LRU 淘汰。修复前是无界 Map，随 session 数线性增长。
// 容量/TTL 与 sessionDedupCache 对齐，避免活跃 session 长期堆积。
const MAX_OVERHEAD_CAPACITY = DEFAULTS.dedup.maxCapacity;
const OVERHEAD_TTL_MS = DEFAULTS.dedup.ttlMs;
const _sessionOverheadCache = new Map<string, { tokens: number; lastAccess: number }>();
const _overheadAccessOrder: string[] = [];

function evictStaleOverhead(): void {
  const now = Date.now();
  while (_overheadAccessOrder.length > 0) {
    const key = _overheadAccessOrder[0];
    const entry = _sessionOverheadCache.get(key);
    if (!entry || (now - entry.lastAccess) > OVERHEAD_TTL_MS) {
      _overheadAccessOrder.shift();
      _sessionOverheadCache.delete(key);
    } else {
      break;
    }
  }
  while (_sessionOverheadCache.size > MAX_OVERHEAD_CAPACITY) {
    // SEC-L2: 修复前用 `shift()!` 非空断言，显式 if-break 更稳健。
    const lru = _overheadAccessOrder.shift();
    if (lru === undefined) break;
    _sessionOverheadCache.delete(lru);
  }
}

function touchOverhead(sessionKey: string): void {
  const idx = _overheadAccessOrder.indexOf(sessionKey);
  if (idx !== -1) _overheadAccessOrder.splice(idx, 1);
  _overheadAccessOrder.push(sessionKey);
}

function getOverhead(sessionKey: string): number {
  const entry = _sessionOverheadCache.get(sessionKey);
  if (!entry) return 0;
  entry.lastAccess = Date.now();
  touchOverhead(sessionKey);
  return entry.tokens;
}

function setOverhead(sessionKey: string, tokens: number): void {
  const existing = _sessionOverheadCache.get(sessionKey);
  if (existing) {
    existing.tokens = tokens;
    existing.lastAccess = Date.now();
  } else {
    evictStaleOverhead();
    _sessionOverheadCache.set(sessionKey, { tokens, lastAccess: Date.now() });
  }
  touchOverhead(sessionKey);
}

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
    // SEC-L2: 修复前用 `shift()!` 非空断言，显式 if-break 更稳健。
    const lru = dedupAccessOrder.shift();
    if (lru === undefined) break;
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
        _losslessClawAdapter = new LosslessClawAdapter(logger);
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
        const qmdConfig = api.pluginConfig?.retrieval?.qmd ?? {};
        const qmdBaseUrl = typeof qmdConfig.mcpEndpoint === 'string'
          ? qmdConfig.mcpEndpoint.replace(/\/mcp$/, '')
          : undefined;

        // -- 插件自有参数 (来自 plugins.lcm-graph-extra) --
        const pluginConfig = api.pluginConfig ?? {};
        const cliFallbackSearchType = pluginConfig.cliFallbackSearchType ?? 'search';
        const cliTimeout = pluginConfig.cliTimeout ?? 30_000;

        qmdClient = new QmdClient({
          mcpBaseUrl: qmdBaseUrl,
          cliTimeout: cliTimeout,
          cliFallbackSearchType: cliFallbackSearchType,
        });
        graphAdapter = new GraphAdapter(
          resolveNeo4jConfig(pluginConfig),
          { enabled: true, searchLimit: 5, embedding: resolveEmbeddingConfig(pluginConfig) ?? undefined },
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
          maxResults: (api.pluginConfig?.retrieval?.limits ?? {}).qmd
            ? (api.pluginConfig.retrieval.limits.qmd + (api.pluginConfig.retrieval.limits.graph ?? 5))
            : 10,
          fuzzyMatchThreshold: 0.85,
          decayHalfLifeDays: 30,
        });
        // S5-2: Update MAX_DEDUP_ROUNDS from plugin config
        // WindowMonitor config is at api.pluginConfig.lcmMonitor (not nested under plugins.entries)
        if (api.pluginConfig?.lcmMonitor?.dedupRounds) {
          MAX_DEDUP_ROUNDS = api.pluginConfig.lcmMonitor.dedupRounds;
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
        // SEC-4 H-10: rethrow 让调用方感知初始化失败，避免静默继续导致后续空指针/未初始化访问。
        throw err;
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
        version: "2.1.10",
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
          logger?.error?.('[lcm-graph-extra] ingest failed', { err: serializeError(err) });
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
        let contextWindow = 0;

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
          const wmConfig = api.pluginConfig?.lcmMonitor;
          logger?.info?.("[DEBUG] wmConfig keys: " + (wmConfig ? Object.keys(wmConfig).join(",") : "NULL/UNDEFINED"));
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
          contextWindow = resolvedCtx.contextWindow;
          // Factor in systemPromptAddition overhead from previous round
          _overheadCacheKey = (params as any).sessionKey ?? (params as any).conversationId ?? "default";
          const overheadTokens = getOverhead(_overheadCacheKey);
          const effectiveTokenCount = estimatedTokens + overheadTokens;
          const tokenRatio = contextWindow > 0 ? effectiveTokenCount / contextWindow : 0;

          tier = 'low';
          retrievalLimits = resolvedCtx.retrievalLimits;
          // Apply tokenBudget constraint if provided (convert tokens to chars, ~4 chars/token)
          maxContextChars = resolvedCtx.maxContextChars.low;
          if (tokenBudget != null && typeof tokenBudget === 'number') {
            maxContextChars = Math.min(maxContextChars, Math.floor(tokenBudget * 4));
          }
          const _wmConvId = getConversationId(typeof params.sessionKey === "string" ? params.sessionKey : (typeof params.session_id === "string" ? params.session_id : ""));
          let uncompressedMsgs = -1;
          let needsCompact = false;

          if (wm) {
            uncompressedMsgs = _wmConvId != null ? getUncompressedMessageCount(_wmConvId) : -1;
            const activeMsgCount = uncompressedMsgs >= 0 ? uncompressedMsgs : msgCount;
            tier = determinePressureTier(activeMsgCount, tokenRatio, {
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

            needsCompact = shouldTriggerCompact(activeMsgCount, tokenRatio, {
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
                // BUG-AUDIT: sessionId 必须是 OpenClaw 会话 ID（字符串，SDK 注入），
                // 不是 conversationId（SQLite 主键 number）。lossless-claw 用 sessionId 查
                // conversations.session_id 列，传 number 主键会永远查不到。
                const _lcSid = typeof params.sessionId === 'string' ? params.sessionId
                  : (typeof params.session_id === 'string' ? params.session_id : String(preCompactConversationId));
                backgroundTasks.register('compact:pre-emptive', _losslessClawAdapter.compact({
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
              // M-9: fallback 与 schema 默认值 (60_000) 保持一致，避免误导
              const compactTimeout = (parseInt(process.env.LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS || '0') || ((wm as any)?.compactTimeout as number)) ?? 60_000;
              const maxSummaryRatio = (wm as any)?.maxSummaryTokenRatio ?? 0.45;
              const sessionFile = typeof params.sessionFile === 'string' ? params.sessionFile : '';

              // Design: <=dedupRounds -> pass through; medium -> summaries+raw+debt; high -> blocking compact+trim
              const convSummaries = getConversationSummaries(conversationId);
              const hasExistingSummary = convSummaries.length > 0;
              const rawCount = messages.length;
              const dedupLimit = (wm as any)?.dedupRounds ?? 24;

              if (tier === 'medium') {
                // Medium: fire-and-forget compact, assemble summaries + all raw msgs, write debt if needed
                // BUG-AUDIT: sessionId 用 SDK 字符串会话 ID，不是 conversationId（number 主键）
                const _lcSid = typeof params.sessionId === 'string' ? params.sessionId
                  : (typeof params.session_id === 'string' ? params.session_id : String(conversationId));
                backgroundTasks.register('compact:medium-tier', _losslessClawAdapter.compact({
                  sessionId: _lcSid, sessionKey, sessionFile, force: true,
                  tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
                  compactionTarget: 'threshold',
                }).then(() => {}, () => {}));

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
                // BUG-AUDIT: sessionId 用 SDK 字符串会话 ID，不是 conversationId（number 主键）
                const _lcSid = typeof params.sessionId === 'string' ? params.sessionId
                  : (typeof params.session_id === 'string' ? params.session_id : String(conversationId));
                try {
                  await Promise.race([
                    _losslessClawAdapter.compact({
                      sessionId: _lcSid, sessionKey, sessionFile, force: true,
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
                  logger?.warn?.('High pressure compact failed, writing debt', { err: serializeError(err) });
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
                backgroundTasks.register('compact:low-tier', _losslessClawAdapter.compact({
                  // BUG-AUDIT: sessionId 用 SDK 字符串会话 ID，不是 conversationId（number 主键）
                  sessionId: typeof params.sessionId === 'string' ? params.sessionId
                    : (typeof params.session_id === 'string' ? params.session_id : String(conversationId)),
                  sessionKey, sessionFile, force: true,
                  tokenBudget: resolvedCtx.compactTokenBudget, currentTokenCount: effectiveTokenCount,
                  compactionTarget: 'threshold',
                }).then(() => {}, () => {}));
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
          // ── Async-compaction fallback: use existing summaries if available ──
          if (finalMessages === messages && _losslessClawAdapter?.connected) {
            const _sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
              : typeof params.session_id === 'string' ? params.session_id : '';
            const _convId = getConversationId(_sessionKey);
            if (_convId != null) {
              const _existingSummaries = getConversationSummaries(_convId);
              if (_existingSummaries.length > 0) {
                const _summaryMsgs = _existingSummaries.map((s) => ({
                  role: 'user', content: s.content, token_count: s.tokenCount,
                }));
                const _lastOriginalMsg = messages.at(-1);
                finalMessages = _lastOriginalMsg
                  ? [..._summaryMsgs, _lastOriginalMsg]
                  : _summaryMsgs;
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
          // 记录最近一次 assemble 的检索 query，供 dashboard /internal/snapshot 只读访问
          lastRetrievalQuery = qmdQuery;

          // ---- Parallel Phase 1: L2 + L3 + L4 all fire together (with per-layer timing) ----
          const parallelStart = Date.now();
          qmdResults = [];
          graphResults = [];
          expResults = [];
          // Per-module latency tracking
          let l2_ms = 0, l3_ms = 0, l4_ms = 0;

          // R-5': 动态混合简化 —— 按 scenario 调整 retrievalLimits 比例
          // 不同场景对各层（QMD/Graph/Experience）依赖程度不同：
          //   - bug-fix/config-debug/performance-opt: QMD 权重高
          //   - feature-dev/refactor: Graph 权重稍高
          //   - code-review/security-audit: Experience 权重高
          const scenarioAdjust = detectScenarioAndAdjustLimits(qmdQuery, retrievalLimits);
          retrievalLimits = scenarioAdjust.limits;
          if (scenarioAdjust.scenario) {
            logger?.debug?.("R-5 scenario-adjusted retrieval limits", { scenario: scenarioAdjust.scenario, limits: retrievalLimits });
          }

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
                  // S-6': 使用 searchByQuery 以支持项目名软过滤
                  // 从 query 中提取 projects 用于场景隔离
                  const expProjects: string[] = (() => {
                    try {
                      // 简单的路径/项目名提取（避免在 assemble 主路径引入完整 context-inference）
                      const found = new Set<string>();
                      const pathRe = /(?:^|[\s(,.;:!?'"\[])([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9._-]+)+)/g;
                      let m: RegExpExecArray | null;
                      while ((m = pathRe.exec(qmdQuery)) !== null) {
                        const parts = m[1].split('/').filter(Boolean);
                        if (parts.length >= 2) {
                          if (parts[0].startsWith('@')) found.add(parts[0] + '/' + parts[1]);
                          else found.add(parts[0]);
                        }
                      }
                      const stops = new Set(['src','lib','dist','build','test','tests','node_modules','public','assets','components','pages','app','apps','packages','config','scripts','utils','hooks','api','docs','styles']);
                      return [...found].map(s => s.toLowerCase()).filter(s => !stops.has(s) && s.length >= 2).slice(0, 5);
                    } catch { return []; }
                  })();
                  const res = await withCircuitBreaker("neo4j", "L4 expStore.search", () =>
                    expStore.searchByQuery({
                      query: qmdQuery,
                      projects: expProjects,
                      minScore: 0.6,
                      limit: retrievalLimits.exp,
                    }),
                  );
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
                let merged = merger.merge(rawQmd, rawGraph);

                // N-2: Merger LLM 重排 —— 低压力 tier（token 充裕）时启用，
                // 中高压跳过以避免 LLM 调用延迟影响响应速度。
                // 复用 distillation 的 LLM 配置（Ollama 本地模型优先，避免 GPU 切换）。
                // B-3 修复: 原 tier === 'low' 仍会在对话深入后阻塞 assemble 主路径
                // （8s timeout）。收紧为 tokenRatio < 0.25，即仅 context 几乎空时
                // （对话初期，用户可承受短暂延迟）才同步调用 LLM。
                if (tier === 'low' && tokenRatio < 0.25 && merged.length >= 3 && typeof merger.llmRerank === 'function') {
                  try {
                    // 复用 resolveDistillationLlm 统一处理 baseURL 清洗 + keepAlive
                    const llmCfg = resolveDistillationLlm(api);
                    if (llmCfg?.model) {
                      const llmFn = async (prompt: string): Promise<string> => {
                        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                        if (llmCfg!.apiKey) headers['Authorization'] = 'Bearer ' + llmCfg!.apiKey;
                        // 仅 Ollama 端点注入 keep_alive，避免冷启动延迟
                        const body = withKeepAliveIfOllama(
                          llmCfg!.baseURL,
                          { model: llmCfg!.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 256 },
                          llmCfg!.keepAlive,
                        );
                        const resp = await fetch(llmCfg!.baseURL + '/chat/completions', {
                          method: 'POST', headers,
                          body: JSON.stringify(body),
                          signal: AbortSignal.timeout(8000),
                        });
                        if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
                        const data: any = await resp.json();
                        return data?.choices?.[0]?.message?.content || '';
                      };
                      const reranked = await merger.llmRerank(merged, qmdQuery, llmFn);
                      if (reranked.length > 0) merged = reranked;
                    }
                  } catch (rerankErr) {
                    logger?.debug?.("Merger LLM rerank skipped/failed, using entity sort", { err: String(rerankErr) });
                  }
                }

                qmdResults = merged;
                graphResults = merged;  // same entity-deduped results for both
              } else {
                qmdResults = rawQmd;
                graphResults = rawGraph;
              }
            } catch (mergeErr) {
              logger?.warn?.("Merger dedup failed, using raw results", { err: serializeError(mergeErr) });
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
logger?.info?.(`⚡ assemble=${Date.now()-assembleStart}ms | init=${initMs}ms | parallel=${parallelMs}(L2_qmd=${l2_ms},L3_graph=${l3_ms},L4_exp=${l4_ms}) | mg=${mgMs}ms | estimatedTokens=${finalEstimate}/${contextWindow}(${(finalEstimate/contextWindow*100).toFixed(1)}%) | overhead=${overheadTokens} | effectiveTokenCount=${effectiveTokenCount} | msgCount=${msgCount} | uncomp=${uncompressedMsgs} | tier=${tier}`, {
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
          // N-4: 记录 assemble 性能指标到健康收集器
          try {
            healthMetrics.recordAssemble(tier, Date.now() - assembleStart, l2_ms, l3_ms, l4_ms);
          } catch { /* non-fatal */ }

          // R-2: 成本感知级联 —— Tier 1 置信度评估 + Thompson 采样重排
          // 仅在 low tier（token 充裕）时启用，避免中高压下的额外延迟
          try {
            // BUG 修复: qmdResults 与 graphResults 在 merger 路径下可能指向同一引用，
            // 直接展开会导致 allResults 重复计数、置信度系统性偏高。
            // 用 Set 按 id 去重（无 id 的项保留，按内容哈希区分）。
            const seenIds = new Set<string>();
            const deduped: any[] = [];
            const pushUnique = (arr: any) => {
              if (!Array.isArray(arr)) return;
              for (const r of arr) {
                const rid = r?.id ?? r?.metadata?.nodeId ?? r?.experience?.id;
                const key = rid ? `id:${rid}` : `obj:${(r?.content ?? r?.summary ?? '').slice(0, 60)}`;
                if (seenIds.has(key)) continue;
                seenIds.add(key);
                deduped.push(r);
              }
            };
            pushUnique(qmdResults);
            pushUnique(graphResults);
            pushUnique(expResults);
            const allResults = deduped;

            if (allResults.length > 0) {
              const confidence = cascadeManager.evaluateTier1(
                allResults.map((r: any) => ({
                  score: r?.score ?? r?.pagerank,
                  pagerank: r?.pagerank ?? r?.experience?.relevanceScore,
                  matchCount: r?.matchCount ?? r?.experience?.matchCount,
                  content: r?.content ?? r?.summary ?? r?.experience?.summary,
                  type: r?.type ?? r?.experience?.type,
                })),
              );

              // 低置信度时用 Thompson 采样重排，引入探索性
              if (confidence.needsTier2 && tier === 'low') {
                // 对经验结果应用 Thompson 重排（探索新经验）
                const scenarioTag = scenarioAdjust?.scenario ?? 'default';
                const rerankedIds = cascadeManager.thompsonRerank(
                  expResults.map((e: any) => ({
                    id: e.experience?.id,
                    matchCount: e.experience?.matchCount,
                    score: e.score,
                  })),
                  scenarioTag,
                );
                // 用 id → 原对象 Map 反查，避免 duplicate/undefined id 导致 find 塌缩
                const expById = new Map<string, any>();
                for (const e of expResults) {
                  const eid = e?.experience?.id;
                  if (eid && !expById.has(eid)) expById.set(eid, e);
                }
                expResults = rerankedIds
                  .map((idx: any) => idx.id ? expById.get(idx.id) : undefined)
                  .filter((e: any): e is typeof expResults[number] => Boolean(e)) as typeof expResults;

                logger?.debug?.("R-2 cascade: low confidence, Thompson rerank applied", {
                  tier1Score: confidence.tier1Score.toFixed(3),
                  needsTier3: confidence.needsTier3,
                  hasFactual: confidence.hasFactualClaim,
                });

                // 异步 Tier 2: LLM 判断（不阻塞主路径）
                const tier2Query = qmdQuery;
                const tier2Scenario = scenarioTag;
                const tier2Results = [...allResults].slice(0, 5);
                backgroundTasks.register('r2:tier2-llm', (async () => {
                  try {
                    const llm = resolveDistillationLlm(api);
                    if (!llm?.model) return;
                    const llmFn = async (prompt: string): Promise<string> => {
                      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                      if (llm.apiKey) headers['Authorization'] = 'Bearer ' + llm.apiKey;
                      const resp = await fetch(llm.baseURL + '/chat/completions', {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: llm.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 256 }),
                        signal: AbortSignal.timeout(8000),
                      });
                      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
                      const data: any = await resp.json();
                      return data?.choices?.[0]?.message?.content || '';
                    };
                    const judgments = await cascadeManager.evaluateTier2(tier2Query, tier2Results, llmFn);
                    // BUG 修复: armKey 必须用 makeArmKey 构造，与 thompsonRerank 保持一致
                    for (const j of judgments) {
                      if (j.id) {
                        const armKey = CascadeManager.makeArmKey(tier2Scenario, j.id);
                        cascadeManager.recordFeedback(armKey, j.relevant);
                      }
                    }
                    if (judgments.length > 0) {
                      logger?.debug?.("R-2 Tier 2 LLM judgment completed", { judged: judgments.length, relevant: judgments.filter(j => j.relevant).length });
                    }
                  } catch { /* Tier 2 failed, non-fatal */ }
                })().then(() => {}, () => {}));
              }
            }
          } catch (r2Err) {
            logger?.debug?.("R-2 cascade evaluation skipped", { err: String(r2Err) });
          }

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
            // S-7': 用户画像轻量版 —— 个性化加权重排
            // 对经验搜索结果按用户偏好（techStack/scenario）小幅 boost，
            // boost 系数 1.0-1.3，避免过度偏置。
            let personalizedResults = expResults;
            try {
              const topTech = userProfile.getTopTechStack(3);
              const topScenario = userProfile.getTopScenario(2);
              if (topTech.length > 0 || topScenario.length > 0) {
                personalizedResults = [...expResults]
                  .map((e: any) => {
                    const boost = userProfile.computeBoost(e.experience?.tags);
                    return { ...e, score: (e.score ?? 0.5) * boost, _personalizedBoost: boost };
                  })
                  .sort((a: any, b: any) => b.score - a.score);
                const boostedCount = personalizedResults.filter((r: any) => (r._personalizedBoost ?? 1) > 1.0).length;
                if (boostedCount > 0) {
                  logger?.debug?.("S-7 personalized experience rerank", { boosted: boostedCount, topTech: topTech.map(t => t.name), topScenario: topScenario.map(s => s.name) });
                }
              }
            } catch { /* non-fatal */ }

            const expBody = personalizedResults.map((e: any) => '- [' + e.experience.type + '] ' + e.experience.summary).join('\n');
            addSection('## \ud83d\udca1 经验总结', expBody, 5);
            for (const e of personalizedResults) backgroundTasks.register('exp:increment-match', expStore.incrementMatchCount(e.experience.id).then(() => {}, () => {}));

            // G-8: 记录本轮 assemble 返回的经验，供 afterTurn 异步验证
            // B-1 修复: 使用 sessionKey-scoped Map，避免多 session 竞态
            lastAssembleExpIdsBySession.set(sessionKey, personalizedResults.map((e: any) => ({
              id: e.experience.id,
              summary: e.experience.summary ?? '',
              query: qmdQuery,
            })));
            // LRU 淘汰：超过上限时删除最早插入的 session 条目
            if (lastAssembleExpIdsBySession.size > LAST_EXP_MAP_MAX) {
              const oldest = lastAssembleExpIdsBySession.keys().next().value;
              if (oldest !== undefined) lastAssembleExpIdsBySession.delete(oldest);
            }
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
              const convStore = _losslessClawAdapter.getConversationStore?.();
              if (convStore) {
                const recentSummaries = typeof convStore.getRecentSummaries === 'function'
                  ? convStore.getRecentSummaries(sessionKey, 3)
                  : [];
                if (Array.isArray(recentSummaries) && recentSummaries.length > 0) {
                  const summaryText = recentSummaries.map((s: any, i: number) =>
                    '- [摘要' + String(i+1) + '] '  + (s?.content ?? s?.summary ?? String(s)).slice(0, 500)
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
          // Apply total control: priority-based truncation to prevent overflow
          if (systemPromptAddition.length > maxContextChars) { systemPromptAddition = applyTotalControl(systemPromptAddition, maxContextChars, removedSections); }
          }

          // ==================================================================
          // Final: Priority-based token budget trim (protect L4 > L3 > L2 > L1)
          // Trim from sections array, then rebuild systemPromptAddition
          // ==================================================================
          if (wm && sections.length > 0) {
            // P0-4 H-5: finalMessages 在此循环内不变，把 estimateTokensFromMessages(finalMessages)
            // 提到循环外只算一次。修复前 estimateTotal() 每次迭代都做 O(C) charCodeAt 全量遍历，
            // S 个 section 时整体 O(S×C)，且 finalMessages 在高压下体量很大，纯属重复浪费。
            const finalMsgTokens = estimateTokensFromMessages(finalMessages);
            const estimateTotal = () => finalMsgTokens + Math.floor(systemPromptAddition.length / 4);
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

          // Hard guard: final budget enforcement after priority trim
          if (systemPromptAddition.length > maxContextChars) {
            systemPromptAddition = applyTotalControl(systemPromptAddition, maxContextChars);
            logger?.warn?.('[wm] Hard truncation after priority trim');
          }
          }
          // ── Cleanup: strip reasoning/thinking from assistant messages ──
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
          // ── Dedup: remove consecutive identical messages (guard against DAG double-storage) ──
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
              logger?.debug?.('[assemble] removed ' + String(finalMessages.length - _deduped.length) + ' consecutive duplicate message(s)');
              finalMessages = _deduped;
            }
          }
          // ── Local model: inject available tool names into systemPromptAddition ──
          if (typeof modelFullId === 'string' && (modelFullId.startsWith('ollama/') || modelFullId.startsWith('ollama-256k/'))
              && availableTools.length > 0 && !systemPromptAddition.includes('## 当前可用工具')) {
            const toolSection = '\n\n## 当前可用工具\n' +
              availableTools.map((t: string) => '- `' + t + '`').join('\n');
            systemPromptAddition += toolSection;
          }

          // A方案：追加记忆系统工具分工说明，帮助 Agent 选择正确工具
          if (systemPromptAddition.length > 0 && !systemPromptAddition.includes('## 记忆系统分工')) {
            systemPromptAddition += '\n\n## 记忆系统分工\n' +
              '- **自动注入**（无需调用）：知识图谱（Neo4j）+ 经验层（EXPERIENCE）+ qmd 全文索引，已通过 systemPromptAddition 自动加载\n' +
              '- **memory_search**：搜索 Markdown 记忆（MEMORY.md + daily log）+ 知识图谱节点（由 graph-memory-pro 提供 Corpus Supplement）\n' +
              '- **memory_get**：读取指定 Markdown 记忆文件\n' +
              '- **gm_record**：手动写入知识图谱节点（SKILL/TASK/EVENT）\n' +
              '- **gm_maintain**：手动触发图谱维护（去重+PageRank+社区检测）+ 查看统计\n' +
              '- **gm_reembed**：批量重新向量化缺失 embedding 的节点\n' +
              '- **lcmg_search**：跨引擎搜索（qmd+graph+experience 混合召回）\n' +
              '- **lcmg_diagnose**：诊断 5 个子系统健康状态\n';
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
          setOverhead(_overheadCacheKey, additionTokens);
          // P0: Final hard-truncation safety net
          // P2-15: 重写 minified 风格代码（var te=.../var bf/while splice）为可读形式。
          // 当总 token 超过 contextWindow 的 85% 时，从非 system 消息头部移除直到达标。
          {
            const totalEst = messageTokens + additionTokens;
            if (contextWindow > 0 && totalEst > contextWindow * 0.85) {
              const buffer: any[] = [...finalMessages];
              const systemCount = buffer.filter((m: any) => m.role === 'system').length;
              while (buffer.length > systemCount + 1) {
                const idx = buffer.findIndex((m: any) => m.role !== 'system');
                if (idx < 0) break;
                buffer.splice(idx, 1);
                if (estimateTokensFromMessages(buffer) + additionTokens <= contextWindow * 0.85) {
                  finalMessages = buffer;
                  break;
                }
              }
              // Fallback: if while loop exited without hitting budget target, assign stripped buffer anyway
              if (estimateTokensFromMessages(finalMessages) + additionTokens > contextWindow * 0.85) {
                finalMessages = buffer;
              }
            }
          }
          return {
            messages: finalMessages,
            estimatedTokens: messageTokens + additionTokens,
            systemPromptAddition: systemPromptAddition || undefined,
            promptAuthority: typeof systemPromptAddition == "string" && systemPromptAddition.length > 0 ? "preassembly_may_overflow" : "assembled",
          };
        } catch (finalErr) {
          const fe = finalErr instanceof Error ? finalErr : new Error(String(finalErr));
          logger?.error?.("assemble: return error", { err: fe.message, stack: fe.stack });
          // P0: Final hard-truncation safety net (error path)
          // P2-15: 重写 minified 风格代码为可读形式（与成功路径对称）
          {
            const totalEst = estimateTokensFromMessages(finalMessages);
            if (contextWindow > 0 && totalEst > contextWindow * 0.85) {
              const buffer: any[] = [...finalMessages];
              const systemCount = buffer.filter((m: any) => m.role === 'system').length;
              while (buffer.length > systemCount + 1) {
                const idx = buffer.findIndex((m: any) => m.role !== 'system');
                if (idx < 0) break;
                buffer.splice(idx, 1);
                if (estimateTokensFromMessages(buffer) <= contextWindow * 0.85) {
                  finalMessages = buffer;
                  break;
                }
              }
              // Fallback: if while loop exited without hitting budget target, assign stripped buffer anyway
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

        // === Auto-bootstrap: ensure conversation has bootstrapped_at before afterTurn ===
        // If lossless-claw bootstrap was skipped (e.g., Gateway restart), transcript reconcile
        // will fail (hasOverlap=false) and all messages will be discarded.
        // Auto-trigger bootstrap here to ensure message persistence works.
        if (_losslessClawAdapter?.ensureBootstrapped) {
          try {
            await _losslessClawAdapter.ensureBootstrapped(params);
            logger?.debug?.('[lcm-graph-extra] auto-bootstrap ensured for conversation');
          } catch (e: any) {
            logger?.warn?.('[lcm-graph-extra] auto-bootstrap failed, continuing afterTurn anyway', { err: e.message });
          }
        }

        const lcAfterTurnStart = Date.now();
        try {
          await _losslessClawAdapter?.afterTurn?.({
            ...params,
            prePromptMessageCount: params.prePromptMessageCount ?? 0,
          });
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

          // S-7': 用户画像轻量版 —— 从用户消息中提取偏好信号
          // 用于后续经验搜索的个性化加权（零延迟，纯规则）
          try {
            userProfile.observe(userContent);
          } catch { /* non-fatal */ }
          // Skip if content is mostly whitespace or repetitive
          const wordRatio = (userContent.match(/[\w]+/g) || []).length / userContent.trim().length;
          if (wordRatio < 0.3) return;

          // Prefer runtimeContext.llm (SDK-provided LLM config), fallback to custom config
          // 复用 resolveDistillationLlm 统一处理：
          //   - 主会话是 Ollama 模型 → 沿用主会话模型，避免 GPU 切换
          //   - 主会话不是 Ollama → 用 distillationLlm 配置（环境变量/openclaw.json/pluginConfig）
          //   - 自动清洗 baseURL + 注入 keepAlive（仅 Ollama 端点）
          const distillLlm = resolveDistillationLlm(api);
          // graphAdapter.extractAndUpsertFromTurn 期望 { apiKey, baseURL, model } 结构，
          // 这里附加 keepAlive 让 buildLlmFn 能读到
          const llmConfig = (distillLlm?.model || distillLlm?.apiKey)
            ? {
                model: distillLlm.model,
                apiKey: distillLlm.apiKey,
                baseURL: distillLlm.baseURL,
                keepAlive: distillLlm.keepAlive,
              }
            : api.pluginConfig?.llm || (() => {
          try {
            const p = homedir() + '/.openclaw/openclaw.json';
            if (!existsSync(p)) return undefined;
            const d = JSON.parse(readFileSync(p, 'utf8'));
            return d?.plugins?.entries?.['graph-memory-pro']?.config?.llm;
          } catch { return undefined }
        })() || {
                apiKey: process.env.OPENAI_API_KEY || '',
                baseURL: cleanBaseURL(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              };

          if (graphAdapter) {
            // A方案：写入提取队列供 graph-memory-pro 后台服务消费（推荐路径）
            // 同时保留原 fire-and-forget 调用作为兼容（旧路径，待 graph-memory-pro
            // 后台服务稳定后可移除）。两条路径的 extractor 都是幂等的（upsert by name+type）。
            try {
              const { appendFile, mkdir } = await import('node:fs/promises');
              const { join } = await import('node:path');
              const queueDir = join(
                process.env.HOME || process.env.USERPROFILE || '.',
                '.openclaw', 'graph-memory-pro'
              );
              const queuePath = join(queueDir, 'extract-queue.jsonl');
              await mkdir(queueDir, { recursive: true }).catch(() => {});
              const queueItem = JSON.stringify({
                user: autoSummary ? `${userContent}\n\n[Compaction Context]\n${autoSummary}` : userContent,
                assistant: assistantContent,
                sessionId: params.sessionId ?? params.session_id,
                ts: Date.now(),
              }) + '\n';
              await appendFile(queuePath, queueItem).catch(() => {});
            } catch { /* 队列写入失败不影响 afterTurn */ }

            // Fire-and-forget with latency tracking: don't block afterTurn lifecycle
            // 注册到 backgroundTasks 以便 dispose 时等待
            const tripletStart = Date.now();
            backgroundTasks.register('afterturn:triplet-extract', Promise.race([
              graphAdapter.extractAndUpsertFromTurn(llmConfig, autoSummary ? `${userContent}\n\n[Compaction Context]\n${autoSummary}` : userContent, assistantContent),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Triplet extraction timeout')), (api.pluginConfig?.tripletTimeoutMs ?? 8000)))
            ]).then(result => {
              const tripletMs = Date.now() - tripletStart;
              if (result && (result.nodes > 0 || result.edges > 0)) {
                logger?.debug?.(`[afterTurn] triplets: +${result.nodes} nodes, +${result.edges} edges (${tripletMs}ms)`);
              } else {
                logger?.debug?.(`[afterTurn] triplets: no extraction needed (${tripletMs}ms)`);
              }
            }).catch((err: Error) => {
              logger?.warn?.('afterTurn: triplet extraction skipped (async)', { err: err.message });
            }));
          }

          // P0-1: 接入经验提取管道。修复前 detectExperienceTrigger/extractRawExperience
          // 虽已实现并 re-export，但 afterTurn 从未调用，导致 PENDING 队列恒空，
          // 蒸馏心跳（step 3）永远空转，L4 经验层完全不可用。
          // 现在在每轮结束后检测触发条件，命中则写入 PENDING 原始经验节点，供后续蒸馏消费。
          if (expStore && typeof detectExperienceTrigger === 'function') {
            try {
              const sessionId = String(params.sessionId ?? params.session_id ?? 'unknown');
              // 对最近一轮的每条消息做触发检测（user/assistant/toolResult 均可能触发）
              const recent = recentMessages.length > 0 ? recentMessages : msgs.slice(-2);
              for (const msg of recent) {
                try {
                  const trigger = detectExperienceTrigger(msg, priorMessages);
                  if (!trigger) continue;
                  const raw = extractRawExperience(trigger, msg, sessionId);
                  // saveRaw 是 async，但此处 fire-and-forget，不阻塞 afterTurn
                  backgroundTasks.register('exp:save-raw', expStore.saveRaw(raw).then(() => {}, (saveErr: any) => {
                    logger?.warn?.('[afterTurn] experience saveRaw failed', { err: String(saveErr) });
                  }));
                  logger?.debug?.(`[afterTurn] experience extracted: source=${trigger}, id=${raw.id}`);
                } catch { /* single message extraction failure, non-fatal */ }
              }
            } catch (expErr) {
              logger?.warn?.('[afterTurn] experience extraction pipeline failed (non-fatal)', { err: String(expErr) });
            }
          }

          // G-8: LLM 异步验证回路 —— 评估上一轮 assemble 返回的经验是否被有效使用
          // 通过比较用户查询与经验内容的语义相关性，判断召回是否有效。
          // 成功 → relevanceScore +0.05, 失败 → relevanceScore -0.05（不低于 0.3）
          // 不主动询问用户，纯 LLM 异步判断，权重 ≤ 0.3（避免过度偏置）。
          // B-1 修复: 从 per-sessionKey Map 读取，避免多 session 竞态
          {
            const g8SessionKey = typeof params.sessionKey === 'string'
              ? params.sessionKey
              : typeof params.session_id === 'string'
                ? params.session_id
                : 'default';
            const lastAssembleExpIds = lastAssembleExpIdsBySession.get(g8SessionKey) ?? [];
            if (lastAssembleExpIds.length > 0) {
              const expIdsToValidate = [...lastAssembleExpIds];
              lastAssembleExpIdsBySession.delete(g8SessionKey); // 清空，避免重复验证
              backgroundTasks.register('afterturn:g8-validate', (async () => {
              try {
                // 防御：异步执行期间 expStore 可能已被 dispose 置 null
                const store = expStore;
                if (!store) return;
                const llm = resolveDistillationLlm(api);
                if (!llm?.model) return; // 无 LLM 配置则跳过

                // 只验证前 3 条，避免过多 LLM 调用
                for (const exp of expIdsToValidate.slice(0, 3)) {
                  try {
                    // 用 LLM 判断经验与查询的相关性
                    const prompt = `Rate the relevance of this experience to the user's query on a scale of 0 to 1.\nQuery: "${exp.query.slice(0, 500)}"\nExperience: "${exp.summary.slice(0, 300)}"\nReturn ONLY a number between 0 and 1 (e.g., 0.8). 1 means highly relevant, 0 means completely irrelevant.`;
                    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                    if (llm.apiKey) headers['Authorization'] = 'Bearer ' + llm.apiKey;
                    // 仅 Ollama 端点注入 keep_alive
                    const body = withKeepAliveIfOllama(
                      llm.baseURL,
                      { model: llm.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 10 },
                      llm.keepAlive,
                    );
                    const resp = await fetch(llm.baseURL + '/chat/completions', {
                      method: 'POST', headers,
                      body: JSON.stringify(body),
                      signal: AbortSignal.timeout(5000),
                    });
                    if (!resp.ok) continue;
                    const data: any = await resp.json();
                    const text = data?.choices?.[0]?.message?.content?.trim() || '';
                    const score = parseFloat(text);
                    if (isNaN(score) || score < 0 || score > 1) continue;

                    // 相关性 ≥ 0.5 视为有效召回 → +0.05
                    // 相关性 < 0.5 视为无效召回 → -0.05
                    const delta = score >= 0.5 ? 0.05 : -0.05;
                    await store.updateQualityScore(exp.id, score, delta);
                    logger?.debug?.("G-8 quality validation", { id: exp.id, score, delta });
                  } catch { /* skip individual validation */ }
                }
              } catch (g8Err) {
                logger?.debug?.("[afterTurn] G-8 validation loop skipped", { err: String(g8Err) });
              }
            })());
          }
          }

          // S-9': 情节缓冲扩展 —— 语义边界检测 → 触发 compact
          // 基于最近消息关键词与上一周期关键词的 Jaccard 相似度判断话题漂移。
          // 话题漂移超过阈值 + 消息数达到最小周期 → 异步触发 compact。
          // 零延迟：纯规则关键词提取，不调用 LLM。
          try {
            const _sessionId = params.sessionId ?? params.session_id ?? '';
            if (_sessionId && _losslessClawAdapter?.connected && typeof _losslessClawAdapter.compact === 'function') {
              const allMsgs = params.messages ?? [];
              const preCount = params.prePromptMessageCount ?? 0;
              const uncompressedCount = allMsgs.length - preCount;
              const MIN_EPISODE_MSGS = 12; // 至少 12 条消息才考虑话题边界触发
              const TOPIC_SHIFT_THRESHOLD = 0.35; // Jaccard < 0.35 视为话题漂移

              if (uncompressedCount >= MIN_EPISODE_MSGS) {
                const recentKeywords = extractTopKeywords(
                  allMsgs.slice(-Math.floor(uncompressedCount * 0.3)),
                  15,
                );
                const priorKeywords = extractTopKeywords(
                  allMsgs.slice(preCount, preCount + Math.floor(uncompressedCount * 0.3)),
                  15,
                );
                if (recentKeywords.length >= 5 && priorKeywords.length >= 5) {
                  const intersection = recentKeywords.filter((k) => priorKeywords.includes(k));
                  const union = new Set([...recentKeywords, ...priorKeywords]);
                  const jaccard = union.size > 0 ? intersection.length / union.size : 1;
                  if (jaccard < TOPIC_SHIFT_THRESHOLD) {
                    logger?.info?.("[afterTurn] S-9 topic shift detected, triggering async compact", {
                      jaccard: jaccard.toFixed(3),
                      recentTop: recentKeywords.slice(0, 5),
                      priorTop: priorKeywords.slice(0, 5),
                      uncompressedCount,
                    });
                    const sk = typeof params.sessionKey === 'string' ? params.sessionKey : '';
                    // BUG-AUDIT: sessionId 用 SDK 字符串会话 ID（_sessionId），
                    // 不是 getConversationId() 返回的 number 主键。
                    // 原代码 `getConversationId(sk) ?? _sessionId` 优先用 number 主键，
                    // lossless-claw 用它查 conversations.session_id 列永远查不到。
                    // 同时移除接口不存在的 reason 字段。
                    backgroundTasks.register('afterturn:s9-topic-shift', _losslessClawAdapter.compact({
                      sessionId: _sessionId,
                      sessionKey: sk,
                      sessionFile: typeof params.sessionFile === 'string' ? params.sessionFile : '',
                      force: false,
                    }));
                  }
                }
              }
            }
          } catch (topicErr) {
            logger?.debug?.("[afterTurn] S-9 topic shift detection skipped", { err: String(topicErr) });
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
          logger?.error?.('[lcm-graph-extra] afterTurn error', { err: serializeError(err) });
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

          // FIX: ensure adapter + deps are initialized before compacting
          // SEC-4 H-10: ensureInitialized 现会 rethrow，此处捕获并返回 init failed，
          // 避免 compact 静默继续导致后续 _losslessClawAdapter 等空指针。
          try {
            await ensureInitialized();
          } catch (initErr) {
            const errMsg = initErr instanceof Error ? initErr.message : String(initErr);
            logger?.error?.("compact: init failed", { err: errMsg });
            return { ok: false, compacted: false, reason: 'init failed: ' + errMsg };
          }

        try {
          // Non-blocking compaction strategy:
          // 1. Fire-and-forget the heavy DAG/LLM summarization to background
          // 2. Perform lightweight backup + marker in foreground (fast path)
          // This eliminates the 10s+ blocking delay during compact().
          
          const _adapterConnected = !!(_losslessClawAdapter?.connected);

          // --- Promise.race + 900s (15min) timeout: trigger lossless-claw DAG compaction ---
          let summaryContent: string | undefined;
          let adapterCompacted = false;
          if (_adapterConnected) {
            // P0-3b H-4 + SEC-10 M-16: 捕获 timer/abort listener handle，finally 中清理，
            // 避免高压超时后定时器与 abort listener 泄漏；并对未决的 timeout/abort promise 预吞 reject。
            let compactTimer: ReturnType<typeof setTimeout> | undefined;
            const compactTimeoutPromise = new Promise<never>((_, reject) => {
              compactTimer = setTimeout(() => reject(new Error('compact: 300s timeout reached')), 300_000);
            });
            compactTimeoutPromise.catch(() => {});
            let abortListener: (() => void) | null = null;
            const abortOnCompact = signal ? new Promise<never>((_, reject) => {
              if (signal.aborted) reject(new Error('compaction aborted'));
              else {
                abortListener = () => reject(new Error('compaction aborted'));
                signal.addEventListener('abort', abortListener, { once: true });
              }
            }) : null;
            if (abortOnCompact) abortOnCompact.catch(() => {});
            try {
              const compactResult: any = await Promise.race([
                _losslessClawAdapter.compact(params),
                compactTimeoutPromise,
                ...(abortOnCompact ? [abortOnCompact] : []),
              ]);
              // Extract summary from adapter result: prefer result.summary (SDK format), fallback to summaryId
              summaryContent = compactResult?.result?.summary || compactResult?.summary;
              // Preserve adapter's actionTaken/compacted flag for accurate success detection
              // ActionTaken may be false even if summary was created (no DAG reduction needed)
              // Use createdSummaryId as the authoritative indicator of compaction success
              adapterCompacted = !!compactResult?.createdSummaryId || compactResult?.result?.actionTaken === true || compactResult?.compacted === true;
            } catch (ceErr) {
              const msg = String(ceErr);
              if (msg.includes('aborted')) {
                logger?.warn?.("compact: DAG compaction aborted by host", { err: serializeError(ceErr) });
              } else if (msg.includes('timeout')) {
                logger?.warn?.("compact: DAG compaction timed out after 30s", { err: serializeError(ceErr) });
              } else {
                logger?.warn?.("compact: background DAG compaction failed", { err: serializeError(ceErr) });
              }
            } finally {
              if (compactTimer !== undefined) clearTimeout(compactTimer);
              if (abortListener && signal) { try { signal.removeEventListener('abort', abortListener); } catch {} }
            }
          } else {
            logger?.debug?.("[lcm-graph-extra] LosslessClawAdapter not connected, skipping DAG compact");
          }

          // --- Promise.race + 900s (15min) timeout: onCompaction hook (backup + Neo4j marker) ---
          // P0-3b H-4 + SEC-10 M-16: 同 DAG compact 块，捕获 timer/abort listener handle 并在 finally 清理。
          let hookTimer: ReturnType<typeof setTimeout> | undefined;
          const hookTimeoutPromise = new Promise<never>((_, reject) => {
            hookTimer = setTimeout(() => reject(new Error('onCompaction: 300s timeout reached')), 300_000);
          });
          hookTimeoutPromise.catch(() => {});
          let hookAbortListener: (() => void) | null = null;
          const abortOnHook = signal ? new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error('onCompaction aborted'));
            else {
              hookAbortListener = () => reject(new Error('onCompaction aborted'));
              signal.addEventListener('abort', hookAbortListener, { once: true });
            }
          }) : null;
          if (abortOnHook) abortOnHook.catch(() => {});
          try {
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
                  // 修复：sessionId 可能是 number（SDK conversationId），强制 String 化
                  // 避免 lossless-claw 内部 sessionId.trim() 抛 TypeError
                  sessionId: params.sessionId != null
                    ? String(params.sessionId)
                    : (params.session_id != null ? String(params.session_id) : undefined),
                } as any,
                unregister: () => {},
                _losslessClawAdapter: _losslessClawAdapter,
              }),
              hookTimeoutPromise,
              ...(abortOnHook ? [abortOnHook] : []),
            ]);
          } catch (hookErr) {
            const msg = String(hookErr);
            if (msg.includes('aborted')) {
              logger?.warn?.("compact: onCompaction hook aborted by host", { err: serializeError(hookErr) });
            } else if (msg.includes('timeout')) {
              logger?.warn?.("compact: onCompaction hook timed out after 30s", { err: serializeError(hookErr) });
            } else {
              logger?.warn?.("compact: onCompaction hook failed (non-fatal)", { err: serializeError(hookErr) });
            }
          } finally {
            if (hookTimer !== undefined) clearTimeout(hookTimer);
            if (hookAbortListener && signal) { try { signal.removeEventListener('abort', hookAbortListener); } catch {} }
          }

          const tokensBefore = params.currentTokenCount ?? 0;
          // Check adapter's actionTaken OR summary content (race condition: DB write may lag)
          const compacted = !!summaryContent || adapterCompacted;
          // FIX: if not compacted, return ok: false so SDK retries instead of considering it done
          if (!compacted) {
            return {
              ok: false,
              compacted: false,
              reason: 'DAG compaction did not produce a summary — session tokens unchanged, will retry',
              result: {
                tokensBefore,
                tokensAfter: tokensBefore,
              },
            };
          }
          return {
            ok: true,
            compacted,
            reason: 'compaction completed',
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
          logger?.warn?.("compact: top-level failed (non-fatal)", { err: serializeError(err) });
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

          // 1. Delegate to lossless-claw adapter.maintain if connected
          if (_losslessClawAdapter?.connected) {
            try {
              // P0-2: maintain 也需 String 化 sessionId，与 compact 一致
              // （lossless-claw maintain 内部同样调用 sessionId?.trim()）
              const _maintainSid = params.sessionId ?? params.session_id;
              const lcResult = await _losslessClawAdapter.maintain({
                sessionId: _maintainSid != null ? String(_maintainSid) : '',
                sessionFile: typeof params.sessionFile === 'string' ? params.sessionFile : '',
                sessionKey: params.sessionKey ?? '',
                runtimeContext: {},
              });
              if (lcResult) {
                changed = changed || (lcResult.changed ?? false);
                bytesFreed += lcResult.bytesFreed ?? 0;
                rewrittenEntries += lcResult.rewrittenEntries ?? 0;
              }
            } catch (lcErr) {
              logger?.debug?.("maintain: lossless-claw delegate failed (non-fatal)", { err: serializeError(lcErr) });
            }
          }

          // 2. Local: evict stale dedup via LRU cache
          try {
            evictStaleDedup();
          } catch {}

          return { changed, bytesFreed, rewrittenEntries };
        } catch (err) {
          logger?.warn?.("maintain: failed (non-fatal)", { err: serializeError(err) });
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: String(err) };
        }
      },

      async dispose() {
        // 1. 先停止 heartbeat timer，避免新任务进入
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
        // 关闭 dashboard 快照 HTTP 服务（幂等，可多次调用）
        if (snapshotServerStop) {
          const stopFn = snapshotServerStop;
          snapshotServerStop = null;
          stopFn().catch(() => {});
        }

        // 2. 等待在途的 fire-and-forget 任务（heartbeat / afterTurn 启动的），
        //    超时 5s 后强制放行，避免 dispose 卡死。
        //    这一步必须在关闭 DB/driver 之前完成，否则在途任务会写入已关闭的资源。
        try {
          if (backgroundTasks.pendingCount > 0) {
            logger?.info?.(`dispose: waiting for ${backgroundTasks.pendingCount} background tasks`, {
              names: backgroundTasks.pendingNames,
            });
          }
          await backgroundTasks.awaitAll(5000);
        } catch { /* 超时或异常，继续清理 */ }

        // 3. 停止 debt scheduler（等待活跃任务完成）
        try { const { stopScheduler } = await import('./core/debt-manager.js'); await stopScheduler(); } catch {}

        // 4. Close SQLite DB 连接（healthMetrics / debt-manager / lcm-bridge）
        //    必须在 Neo4j driver 之前或同时关闭，避免 dispose 后被 fire-and-forget 写入
        try { healthMetrics.close(); } catch {}
        try { const { closeDebtDb } = await import('./core/debt-manager.js'); closeDebtDb(); } catch {}
        try { const { closeLcmDb } = await import('./lcm-bridge.js'); closeLcmDb(); } catch {}

        // 4. Close Neo4j driver pool before resetting to avoid "Pool is closed" errors
        try { (graphAdapter as any)?.close?.(); } catch {}
        tracker?.close?.();
        try { await closeNeo4jDriver(); } catch {}
        // 6. M-2: 重置熔断器状态（避免热重载/测试复用进程时残留旧 state）
        try { const { resetAllCircuitBreakers } = await import('./circuit-breaker.js'); resetAllCircuitBreakers(); } catch {}
        initialized = false;
        initPromise = null;
        qmdClient = null;
        graphAdapter = null;
        expStore = null;
        lastRetrievalQuery = '';
      },
    }));

    // -------------------------------------------------------------------
    // Dashboard 工具上下文 + 快照服务
    // 注入 register() 闭包内的单例引用，供 lcmg_distill / lcmg_compact / lcmg_reset_breaker
    // 三个 MCP 工具手动触发维护操作。所有回调延迟访问闭包变量，确保 dispose 后安全。
    // -------------------------------------------------------------------
    const dashboardContext: DashboardToolContext = {
      expStore: undefined, // expStore 在闭包内延迟访问，由 runDistillation 回调内部读取
      runDistillation: async (limit: number) => {
        // 包装内部 runDistillation(expStoreRef, apiRef, log, limit?)，延迟读取 expStore 当前值
        const storeRef = expStore;
        if (!storeRef) throw new Error('expStore not initialized');
        await runDistillation(storeRef, api, logger, limit);
        return { limit };
      },
      triggerCompact: async (conversationId?: number) => {
        // 写入 compact 债务（若指定会话）并立即触发调度器处理
        const { triggerNow } = await import('./core/debt-manager.js');
        if (conversationId != null) {
          const P = DEFAULTS.heartbeat.pressure;
          writeCompactionDebt(conversationId, P.tokenBudget, P.tokenBudget, 'dashboard_manual_trigger');
        }
        await triggerNow();
        return true;
      },
      resetBreaker: (name: string) => {
        // 仅 neo4j 需要额外重置 graphAdapter 连接标志（circuit-breaker 状态由 tools.ts 内重置）
        try {
          if (name === 'neo4j') {
            graphAdapter?.resetConnectFlag?.();
          }
          return true;
        } catch {
          return false;
        }
      },
    };

    registerOperationalToolsWithDashboard(api, dashboardContext);

    // -------------------------------------------------------------------
    // Dashboard /internal/snapshot 快照服务（默认 :7423 仅 127.0.0.1）
    // 端口规划：dashboard 后端 :7421 / 前端 dev :7422 / 插件 snapshot :7423
    // 聚合 cascadeManager / userProfile / graphAdapter / debt / retrieval / health 内存态
    // providers 全部用函数形式延迟访问闭包变量，每次请求读取最新状态
    // -------------------------------------------------------------------
    try {
      const dashCfg = api.pluginConfig?.dashboardSnapshot;
      const enabled = dashCfg?.enabled !== false; // 默认启用，显式 false 关闭
      if (enabled) {
        const port = dashCfg?.port ?? 7423;
        const host = dashCfg?.host ?? '127.0.0.1';
        const providers: SnapshotProviders = {
          getCascadeSnapshot: () => ({
            armsCount: cascadeManager.getArmsCount(),
            topArms: cascadeManager.getArmsSnapshot(),
            // confidenceThreshold 为私有字段，用 any 读取（只读访问，不修改内部状态）
            confidenceThreshold: (cascadeManager as any).confidenceThreshold ?? 0.7,
          }),
          getUserProfile: () => ({
            techStack: userProfile.getTopTechStack(5),
            scenario: userProfile.getTopScenario(5),
            language: userProfile.getLanguage(),
          }),
          getGraphAdapterState: () => {
            // graphAdapter 可能为 null（未初始化）或已 dispose；用 any 读取私有连接状态
            const a = graphAdapter as any;
            if (!a) return { connected: false, connectFailed: false };
            return {
              connected: !!a.driver,
              connectFailed: !!a._connectFailed,
            };
          },
          getDebtStats: () => {
            // getSchedulerStats 是同步函数，读取当前调度器状态
            try {
              return getSchedulerStats();
            } catch {
              return { running: 0, pendingCount: 0, pollIntervalMs: 60000, maxConcurrent: 2 };
            }
          },
          getRetrievalState: () => ({
            lastQuery: lastRetrievalQuery,
            // 无全局 gateway 单例，perfSummary 暂返回空串（dashboard 显示为空）
            perfSummary: '',
          }),
          getHealthLatest: () => healthMetrics.getLatest(),
        };
        const snapshotHandle = startDashboardSnapshotServer({ port, host, providers });
        snapshotServerStop = snapshotHandle.stop;
        // 启动是异步的（含端口探测 + listen），不能立即 log "listening"。
        // 用一个延迟检查：500ms 后读取 handle.started 判断最终状态。
        setTimeout(() => {
          if (snapshotHandle.started) {
            logger?.info?.(`[lcm-graph-extra] dashboard snapshot server listening on ${host}:${port}`);
          } else {
            logger?.warn?.(`[lcm-graph-extra] dashboard snapshot server NOT started on ${host}:${port}: ${snapshotHandle.failureReason || 'unknown reason'} (non-fatal, plugin continues)`);
          }
        }, 600);
      }
    } catch (snapErr) {
      logger?.warn?.('[lcm-graph-extra] dashboard snapshot server failed to start (non-fatal)', { err: String(snapErr) });
    }
    // -------------------------------------------------------------------
    // Heartbeat - periodic async maintenance (every 5 minutes)
    //   1. Compaction pressure check + predictive pre-compaction
    //   2. qmd MCP health check
    //   3. Experience distillation (every ~2h) + TTL cleanup (every ~24h)
    //   4. Neo4j TTL weight decay + expired cleanup (every ~24h)
    //   5. Debt table reconcile — orphan/tombstone cleanup (every ~24h)
    // -------------------------------------------------------------------
    const HB_INTERVAL_MS = DEFAULTS.heartbeat.intervalMs;
    let hbTimer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;
    let lastDistillationRun = 0;
    let lastExperienceTtlRun = 0;  // N-3: EXPERIENCE TTL 清理节流（默认 24h）
    let hbDedupCleanupCounter = 0;  // Clean dedup cache every 15 heartbeats (~75min)
    // P0-2: TTL 清理节流。默认 24h 一次（与 DEFAULT_TTL_CONFIG.cleanupIntervalHours 对齐）。
    let lastTtlRun = 0;
    const TTL_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // P0-3: 债务表对账节流。默认 24h 一次，与 TTL 同 cadence。
    // 清理孤儿债务（会话已删除）与 7 天前墓碑，防止 conversation_compaction_maintenance 无限增长。
    let lastDebtReconcileRun = 0;
    const DEBT_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // Distillation helpers

    function isOllamaModel(model: string): boolean {
      // 判断主会话模型是否为 Ollama 本地模型。
      // 识别依据：
      //   1. 显式 provider 前缀：`ollama/...`、`ollama-256k/...`
      //   2. Ollama 默认 tag 后缀：`:latest`
      // 注意：原逻辑 `!model.includes('/')` 会把 `gpt-4o-mini`、`claude-3-5-sonnet`
      // 等不含 `/` 的远程模型名误判为 Ollama，导致错误地走 Ollama baseURL。
      // 已去除该过宽分支。
      return model.startsWith('ollama/') || model.startsWith('ollama-256k/') || model.endsWith(':latest');
    }

    function resolveDistillationLlm(apiRef: any) {
      const runtimeLlm = apiRef.runtimeContext?.llm;
      // 默认 keepAlive（可被 distillationLlm.keepAlive 覆盖）
      const defaultKeepAlive = (apiRef.config as any)?.distillationLlm?.keepAlive
        || (apiRef.config as any)?.embedding?.keepAlive
        || '1h';
      // Session model is local Ollama → reuse it to avoid GPU model swapping
      if (runtimeLlm?.model && isOllamaModel(runtimeLlm.model)) {
        return {
          model: runtimeLlm.model,
          apiKey: runtimeLlm.apiKey || '',
          baseURL: cleanBaseURL(runtimeLlm.baseURL || 'http://127.0.0.1:18789/v1'),
          keepAlive: defaultKeepAlive,
        };
      }
      const dLlm = (apiRef.config as any)?.distillationLlm;
      if (dLlm?.provider === 'openclaw_hooks') return {
        model: dLlm.model || 'ollama/qwen3.6:27b',
        apiKey: '',
        baseURL: cleanBaseURL('http://127.0.0.1:18789/v1'),
        keepAlive: dLlm.keepAlive || defaultKeepAlive,
      };
      return {
        model: process.env.LLM_MODEL || dLlm?.model || 'gpt-4o-mini',
        apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
        baseURL: cleanBaseURL(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
        keepAlive: defaultKeepAlive,
      };
    }

    async function distillOne(raw: { id: string; source: string; context: string; detail: string }, llm: { model: string; apiKey: string; baseURL: string; keepAlive?: string }): Promise<any | null> {
      // P1-4: prompt 增加 tags 字段，让 LLM 同时产出多维度标签（scenario/techStack/severity/freeTags）。
      // S-11': Zettelkasten 增强 — 增加 relatedConcepts 字段，提取 2-5 个相关概念/关键词，
      // 用于后续在经验网络中建立 RELATED_TO 边，形成知识图谱连接。
      const prompt = 'Summarize the following experience into a concise lesson.' + '\nSource: ' + raw.source + '\nContext: ' + raw.context + '\nDetail: ' + raw.detail
        + '\nReturn a JSON with: title, summary, type (lesson|failure|correction|fix|best_practice), relevanceScore (0-1),'
        + ' scenario (array, subset of: bug-fix|feature-dev|code-review|config-debug|deployment|performance-opt|security-audit|refactor),'
        + ' techStack (array, subset of: frontend|backend|devops|database|mobile|ai-ml|infrastructure|general),'
        + ' severity (one of: critical|major|minor), freeTags (array of short strings),'
        + ' relatedConcepts (array of 2-5 short keywords/phrases representing closely related topics or concepts for cross-linking).'
        + ' Return ONLY JSON.';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (llm.apiKey) headers['Authorization'] = 'Bearer ' + llm.apiKey;
        // 仅 Ollama 端点注入 keep_alive，避免模型 5 分钟后卸载导致冷启动延迟
        const body = withKeepAliveIfOllama(
          llm.baseURL,
          { model: llm.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 512 },
          llm.keepAlive,
        );
        const resp = await fetch(llm.baseURL + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const data: any = await resp.json();
        const text = data?.choices?.[0]?.message?.content;
        if (!text) return null;
        const parsed = JSON.parse(text);
        // P1-4: 校验并收敛 tags，防止 LLM 返回非法值写入 Neo4j。
        const SCENARIO_SET = new Set(['bug-fix', 'feature-dev', 'code-review', 'config-debug', 'deployment', 'performance-opt', 'security-audit', 'refactor']);
        const TECH_SET = new Set(['frontend', 'backend', 'devops', 'database', 'mobile', 'ai-ml', 'infrastructure', 'general']);
        const SEVERITY_SET = new Set(['critical', 'major', 'minor']);
        const filterArr = (v: any, allowed: Set<string>): string[] | undefined => {
          if (!Array.isArray(v)) return undefined;
          const out = v.map(String).filter((x) => allowed.has(x));
          return out.length > 0 ? out : undefined;
        };
        let severity: 'critical' | 'major' | 'minor' | undefined;
        if (typeof parsed.severity === 'string' && SEVERITY_SET.has(parsed.severity)) severity = parsed.severity as any;
        let freeTags: string[] | undefined;
        if (Array.isArray(parsed.freeTags)) {
          const ft = parsed.freeTags.map(String).filter((s: string) => s.trim().length > 0 && s.length <= 40).slice(0, 10);
          freeTags = ft.length > 0 ? ft : undefined;
        }
        const tags = (parsed.scenario || parsed.techStack || severity || freeTags)
          ? {
              scenario: filterArr(parsed.scenario, SCENARIO_SET) as any,
              techStack: filterArr(parsed.techStack, TECH_SET) as any,
              severity,
              freeTags,
            }
          : undefined;
        // S-11': 提取 relatedConcepts（Zettelkasten 关联概念）
        let relatedConcepts: string[] | undefined;
        if (Array.isArray(parsed.relatedConcepts)) {
          const rc = parsed.relatedConcepts
            .map(String)
            .filter((s: string) => s.trim().length > 0 && s.length <= 50)
            .slice(0, 5);
          relatedConcepts = rc.length > 0 ? rc : undefined;
        }

        // 校验 relevanceScore 范围 [0,1]，越界回退 0.5
        let rs = typeof parsed.relevanceScore === 'number' ? parsed.relevanceScore : 0.5;
        if (!isFinite(rs) || rs < 0) rs = 0; else if (rs > 1) rs = 1;
        return { id: 'exp_dist_' + randomUUID(), rawIds: [raw.id], type: parsed.type || 'lesson', title: parsed.title || raw.source, summary: parsed.summary || '(no summary)', detail: (raw.detail || '').slice(0, 2000), context: raw.context || '', relevanceScore: rs, createdAt: new Date(), matchCount: 0, tags, relatedConcepts };
      } catch { clearTimeout(timer); return null; }
    }

    async function runDistillation(expStoreRef: any, apiRef: any, log: any, limit?: number): Promise<void> {
      try {
        // limit 控制单批拉取数量，默认 5（与历史行为一致），dashboard lcmg_distill 可传入更大值
        const fetchLimit = limit && limit > 0 ? limit : 5;
        const pending = await expStoreRef.fetchPending(fetchLimit);
        if (!pending.length) return;
        log?.info?.('distillation: processing ' + String(pending.length) + ' pending');
        const llm = resolveDistillationLlm(apiRef);
        for (const raw of pending) {
          try {
            const distilled = await distillOne(raw, llm);
            if (distilled) {
              await expStoreRef.saveDistilled(distilled);
              await expStoreRef.deleteById(raw.id);

              // S-11': Zettelkasten evolve — 建立 RELATED_TO 关联
              // 用 LLM 提取的 relatedConcepts 搜索已有经验并建立关联，
              // 让经验网络自组织生长（类似卡片盒笔记法）。
              const concepts: string[] | undefined = distilled.relatedConcepts;
              if (concepts?.length && typeof expStoreRef.linkRelated === 'function') {
                try {
                  const linked = await expStoreRef.linkRelated(distilled.id, concepts, 3);
                  if (linked > 0) {
                    log?.debug?.("distillation: zettelkasten evolve linked", { id: distilled.id, linked, concepts: concepts.slice(0, 3) });
                  }
                } catch (linkErr) {
                  log?.debug?.("distillation: zettelkasten evolve skipped", { err: String(linkErr) });
                }
              }
            }
          } catch (e) { log?.warn?.("distillation item failed", { err: String(e) }); }
        }
      } catch (e) { log?.warn?.("distillation batch failed", { err: String(e) }); }
    }

    async function runHeartbeat() {
      if (!initialized) return;
      const t0 = Date.now();
      // N-4: 提升到函数作用域，供 health metrics 收集使用
      let pendingMessages = 0;
      let summaryFragments = 0;
      let maxTokenRatio = 0;
      try {
        // --- 1. Compaction pressure check (scan .lossless/ directories) ---
        // P2-4 M-8: 原 readdirSync/readFileSync/existsSync 同步阻塞事件循环；
        // 且 sessionDir 在阈值检测与超限写 debt 两处各扫描一次。改为 fs/promises 异步，
        // 并用 sessionDataCache 缓存 sessionDir 的 files 与解析结果，超限分支复用，不再二次扫描。
        try {
          const { readdir, readFile, stat } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const dirExists = async (p: string): Promise<boolean> => {
            try { const s = await stat(p); return s.isDirectory(); } catch { return false; }
          };
          const wsDir = process.env.OPENCLAW_WORKSPACE ||
            (typeof api?.config?.workspace === "string" ? api.config.workspace :
             (typeof process?.cwd === "function" ? process.cwd() : null));
          if (wsDir) {
            const losslessDir = join(wsDir, ".lossless");

            // pending messages count + cache parsed session data for reuse
            pendingMessages = 0;
            const sessionDir = join(losslessDir, "sessions");
            // sessionDataCache: 缓存 sessionDir 文件名与解析结果，超限写 debt 分支直接复用
            const sessionDataCache: { file: string; data: any }[] = [];
            if (await dirExists(sessionDir)) {
              const files = (await readdir(sessionDir)).filter((f) => f.endsWith(".json"));
              for (const sf of files) {
                try {
                  const data = JSON.parse(await readFile(join(sessionDir, sf), "utf8"));
                  pendingMessages += Array.isArray(data.messages) ? data.messages.length : 0;
                  sessionDataCache.push({ file: sf, data });
                } catch { /* skip */ }
              }
            }

            // summary fragments count
            summaryFragments = 0;
            const summaryDir = join(losslessDir, "summaries");
            if (await dirExists(summaryDir)) {
              summaryFragments = (await readdir(summaryDir)).filter((f) => f.endsWith(".json")).length;
            }

            // token ratio from debt files
            maxTokenRatio = 0;
            const debtDir = join(losslessDir, "debt");
            if (await dirExists(debtDir)) {
              const debtFiles = (await readdir(debtDir)).filter((f) => f.endsWith(".json"));
              for (const df of debtFiles) {
                try {
                  const debt = JSON.parse(await readFile(join(debtDir, df), "utf8"));
                  if (debt.currentTokenCount) {
                    maxTokenRatio = Math.max(maxTokenRatio, debt.currentTokenCount / 262144);
                  }
                } catch { /* skip */ }
              }
            }

            // Check thresholds
            // P2-9: 阈值与窗口预算改引用 DEFAULTS.heartbeat.pressure，消除魔术数字
            const P = DEFAULTS.heartbeat.pressure;
            const signals = [];
            if (pendingMessages >= P.pendingMessagesThreshold) signals.push("pending_msgs>=" + pendingMessages);
            if (summaryFragments >= P.summaryFragmentsThreshold) signals.push("summary_frags>=" + summaryFragments);
            if (maxTokenRatio > P.maxTokenRatio) signals.push("token_ratio>" + maxTokenRatio.toFixed(3));
            if (signals.length > 0) {
              logger?.warn?.("heartbeat: pressure threshold(s) exceeded, writing debt for affected sessions", { signals });
              // writeCompactionDebt is already imported at top; use it directly
              try {
                // 复用 sessionDataCache，不再二次扫描 sessionDir
                for (const { data } of sessionDataCache) {
                  try {
                    const convId = getConversationId(data.sessionKey, String(data.sessionId || ''));
                    if (!convId) continue;
                    const tokenCount = Math.round((maxTokenRatio || 0.5) * P.contextWindowChars);
                    writeCompactionDebt(convId, P.tokenBudget, tokenCount, "hb_pressure_" + signals.length + "dims");
                  } catch { /* skip bad session file */ }
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
        const distillIntervalMs = api.pluginConfig?.distillationIntervalMs ?? 2 * 60 * 60 * 1000;
        if (expStore && typeof expStore.fetchPending === "function") {
          const elapsed = Date.now() - lastDistillationRun;
          if (elapsed >= distillIntervalMs) {
            lastDistillationRun = Date.now();
            // 注册到 backgroundTasks 以便 dispose 时等待
            backgroundTasks.register('hb:distillation', runDistillation(expStore, api, logger).catch((e: any) => {
              logger?.warn?.("distillation batch failed", { err: String(e) });
            }));
          }

          // --- N-3: EXPERIENCE TTL cleanup (every ~24h) ---
          // 检索时已按 expiresAt 过滤，但过期节点仍留在图中占用空间。
          // 与蒸馏共享 24h 节流，批量删除过期 EXPERIENCE 节点。
          const expTtlIntervalMs = api.pluginConfig?.experienceTtlIntervalMs ?? 24 * 60 * 60 * 1000;
          const expTtlElapsed = Date.now() - lastExperienceTtlRun;
          if (expTtlElapsed >= expTtlIntervalMs && typeof expStore.cleanupExpired === "function") {
            lastExperienceTtlRun = Date.now();
            backgroundTasks.register('hb:experience-ttl', (async () => {
              try {
                let totalDeleted = 0;
                let round = 0;
                // 分批删除，每次最多 100 个，最多 10 轮（防止单次心跳删除过多）
                while (round < 10) {
                  const deleted = await expStore.cleanupExpired(100);
                  if (deleted === 0) break;
                  totalDeleted += deleted;
                  round++;
                  if (deleted < 100) break;
                }
                if (totalDeleted > 0) {
                  logger?.info?.(`heartbeat: expired EXPERIENCE nodes cleaned up (deleted=${totalDeleted}, rounds=${round})`);
                }
              } catch (ttlErr) {
                logger?.warn?.("heartbeat: experience TTL cleanup failed (non-fatal)", { err: String(ttlErr) });
              }
            })());
          }
        }

        // --- 4. P0-2: Neo4j-backed TTL weight decay + expired cleanup (every ~24h) ---
        // 修复前 TTL 调度器从未启动，节点永不衰减/过期，lcmg_pin 的豁免语义无意义。
        // 现在在心跳中按 24h 节流运行 Neo4j 原生 Cypher 衰减与清理。
        if (graphAdapter && typeof graphAdapter.query === "function") {
          const ttlElapsed = Date.now() - lastTtlRun;
          if (ttlElapsed >= TTL_INTERVAL_MS) {
            lastTtlRun = Date.now();
            backgroundTasks.register('hb:neo4j-ttl', (async () => {
              try {
                const { applyNeo4jWeightDecay, cleanupNeo4jExpiredNodes, DEFAULT_TTL_CONFIG } = await import("./core/ttl.js");
                const decayed = await applyNeo4jWeightDecay(graphAdapter);
                const deleted = await cleanupNeo4jExpiredNodes(graphAdapter, DEFAULT_TTL_CONFIG);
                if (decayed > 0 || deleted > 0) {
                  logger?.info?.(`heartbeat: TTL applied (decayed=${decayed}, deleted=${deleted})`);
                }
              } catch (ttlErr) {
                logger?.warn?.("heartbeat: TTL cleanup failed (non-fatal)", { err: String(ttlErr) });
              }
            })());
          }
        }

        // --- 5. P0-3: 债务表对账清理 (every ~24h) ---
        // 删除孤儿债务（会话已删除但债务行残留）与 7 天前墓碑（pending=0/running=0），
        // 防止 conversation_compaction_maintenance 表无限增长导致 getPendingDebts 查询退化。
        {
          const reconcileElapsed = Date.now() - lastDebtReconcileRun;
          if (reconcileElapsed >= DEBT_RECONCILE_INTERVAL_MS) {
            lastDebtReconcileRun = Date.now();
            backgroundTasks.register('hb:debt-reconcile', (async () => {
              try {
                const { reconcileDebtTable } = await import("./core/debt-manager.js");
                const r = reconcileDebtTable();
                if (r.orphaned > 0 || r.tombstones > 0) {
                  logger?.info?.(`heartbeat: debt table reconciled (orphans=${r.orphaned}, tombstones=${r.tombstones})`);
                }
              } catch (reconcileErr) {
                logger?.warn?.("heartbeat: debt reconcile failed (non-fatal)", { err: String(reconcileErr) });
              }
            })());
          }
        }

        try { logger?.debug?.("heartbeat: cycle completed in " + String(Date.now() - t0) + "ms"); } catch { /* logger crash, non-fatal */ }

        // N-4: 收集健康指标快照
        try {
          const { getHealthSnapshot } = await import('./circuit-breaker.js');
          const cbStates = getHealthSnapshot();
          healthMetrics.collect({
            pendingMessages: (pendingMessages ?? 0) as number,
            summaryFragments: (summaryFragments ?? 0) as number,
            maxTokenRatio: (maxTokenRatio ?? 0) as number,
            cbLcmAvailable: cbStates?.lcm?.available ?? true,
            cbQmdAvailable: cbStates?.qmd?.available ?? true,
            cbNeo4jAvailable: cbStates?.neo4j?.available ?? true,
            cbLcmFailures: cbStates?.lcm?.failures ?? 0,
            cbQmdFailures: cbStates?.qmd?.failures ?? 0,
            cbNeo4jFailures: cbStates?.neo4j?.failures ?? 0,
          });
        } catch { /* health metrics collection failed, non-fatal */ }

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
    backgroundTasks.register('debt-scheduler-start', (async () => {
      try {
        const { startScheduler } = await import("./core/debt-manager.js");
        await startScheduler(
          async (instance) => {
            const { onCompaction } = await import("./hooks/compaction.js");
            await onCompaction(instance);
          },
          { config: api.pluginConfig, logger: logger },
          { pollIntervalMs: 60_000, maxConcurrent: 2, urgentThreshold: 0.7 }
        );
        logger?.info?.("debt-manager: resident scheduler started");
      } catch (schedErr) {
        logger?.warn?.("debt-manager: failed to start scheduler", { err: String(schedErr) });
      }
    })().then(() => {}, () => {}));

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

export default pluginEntry;

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


export const VERSION = '2.1.10';
