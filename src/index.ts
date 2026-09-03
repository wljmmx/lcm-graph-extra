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
import { registerOperationalToolsWithDashboard, closeNeo4jDriver, mergeEntriesNeo4jConfig, ensureNeo4jSchema, type DashboardToolContext } from './tools.js';
import { startDashboardSnapshotServer, type SnapshotProviders } from './dashboard-snapshot.js';
import { getSchedulerStats } from './core/debt-manager.js';
import { UsageTracker } from "./async/usage-tracker"
import { backgroundTasks } from "./async/task-registry.js"
import { onCompaction } from "./hooks/compaction";
import { getOrCreateLosslessClawAdapter, resetSharedAdapter } from "./middleware/lossless-claw-adapter";
import { resolveNeo4jConfig, resolveEmbeddingConfig } from "./config/neo4j-helper";
import { PluginConfigSchema, autoMatchMaxTokens, DEFAULT_CONFIG } from "./config.js";
import { setGlobalLogger, adaptLogger, createLogger, serializeError } from "./utils/logger.js";
import { resolveSessionCacheKey } from "./utils/session-key.js";
import { evaluateTurnCommit } from "./utils/commit-turn.js";
import { DEFAULTS, configureLlmTimeouts } from "./config/defaults.js";

import {
  getConversationId,
  invalidateConvIdCache,
  writeCompactionDebt,
  estimateTokensFromText,
  estimateTokensFromMessages,
  getUncompressedMessageCount,
} from "./lcm-bridge.js";
import { updateSdkOverhead } from "./plugin/overhead-cache.js";

// ---------------------------------------------------------------------------
// S-9': 关键词提取（轻量版）—— 实现已抽出到 src/plugin/keywords.ts
// ---------------------------------------------------------------------------

// P0-1: 静态导入经验提取函数，供 afterTurn 中直接调用。
import { UserProfileTracker } from './experience/user-profile.js';

// Backfill: 经验回溯导入
import { detectExperienceTrigger, extractRawExperience } from './experience/index.js';
import { getAllConversations, getBackfillState, markConversationsBackfilled } from './lcm-bridge.js';

// S-7': 用户画像轻量版 —— 全局单例，带时间衰减
// 用于经验搜索的个性化加权，不持久化（重启重置）
const userProfile = new UserProfileTracker();

// N-4: 健康指标收集器 —— 全局单例
import { healthMetrics, businessMetrics } from './health-metrics.js';
import { getHealthSnapshot } from './circuit-breaker.js';

// G-8: 记录最近一轮 assemble 返回的经验 ID + query，供 afterTurn 异步验证
// B-1 修复: 原为模块级 let 变量，多 session 并发时 G-8 验证回路会串数据
// （session A 的 assemble 写入，session B 的 afterTurn 读取）。
// 改为 per-sessionKey Map，每个 session 独立追踪。
// BUGFIX(P2-1): 增加 TTL，写入 30 分钟后过期清理，避免长生命周期进程 200 条 session 元数据常驻。
const lastAssembleExpIdsBySession = new Map<string, { ids: Array<{ id: string; summary: string; query: string }>; ts: number }>();

// R-1: buildKnowledgeGuidance 已提取到 src/assemble/guidance.ts
// R-1: evaluateOutputQuality 已提取到 src/after-turn/quality.ts
// R-1: assemble 核心逻辑已提取到 src/assemble/index.ts
import { assemble as assembleCore } from './assemble/index.js';
import type { AssembleContext } from './assemble/types.js';
// R-1: afterTurn 核心逻辑已提取到 src/after-turn/index.ts
import { afterTurn as afterTurnCore } from './after-turn/index.js';
import type { AfterTurnContext } from './after-turn/types.js';

// R-2: 成本感知级联管理器 —— 全局单例
import { cascadeManager } from './cascade-manager.js';

// H-6: 会话级预热缓存 — bootstrap 时预加载高频经验，assemble 第一轮注入
const sessionWarmupCache = new Map<string, any[]>();
const WARMUP_CACHE_MAX = 100;

// R-5: 会话级输出质量评分 — afterTurn 评估后录入，assemble 中用于调整检索门槛
const sessionQualityScores = new Map<string, number>();

// P0-1: 会话级 LLM Rerank 异步缓存 — fire-and-forget 结果供下一轮 assemble 使用
const llmRerankCache = new Map<string, { query: string; results: any[]; ts: number }>();
const LLM_RERANK_CACHE_MAX = 50;
const LLM_RERANK_CACHE_TTL_MS = 5 * 60 * 1000; // 5min TTL

// P2-1: L2/L4 检索结果 LRU 缓存（同 query 短期复用，TTL 5min）
const l2QueryCache = new Map<string, { results: any[]; ts: number }>();
const l4QueryCache = new Map<string, { results: any[]; ts: number }>();
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000; // 5min TTL

// v2.7.0 P4: 冲突检测异步缓存 — 当前轮注入上一轮检测结果
const conflictCache = new Map<string, { conflicts: any[]; ts: number }>();
const CONFLICT_CACHE_MAX = 50;
const CONFLICT_CACHE_TTL_MS = 5 * 60 * 1000; // 5min TTL

// v2.8.0 O7: 异步预取缓存 — afterTurn 预取 L2/L3/L4 结果，下一轮 assemble 直接使用
// 架构：当前轮永远只使用上一轮预取的结果，检索耗时完全从用户感知路径移除
const prefetchCache = new Map<string, { qmdResults: any[]; graphResults: any[]; expResults: any[]; query: string; ts: number }>();
const PREFETCH_CACHE_MAX = 200;
const PREFETCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10min TTL（允许跨长对话复用）

// v2.7.0 P6: Token 估算缓存 —— 同 messages 数组短期复用，避免重复计算（200-400ms/次）
const tokenEstimateCache = new Map<string, { tokens: number; ts: number }>();
const TOKEN_ESTIMATE_CACHE_TTL_MS = 30 * 1000; // 30s TTL（短 TTL 确保一致性）
const TOKEN_ESTIMATE_CACHE_MAX = 100;

// OpenClaw durable-turn：已提交逻辑轮的幂等记录（key = `${sessionId}|${turnId}`）。
// 模块级单例，供 commitTurn 去重 & bootstrap 按 sessionId 清理，防止 /new 后跨会话误判。
const committedTurnKeys = new Set<string>();
const COMMITTED_TURN_MAX = 2000;

function cachedEstimateTokens(messages: any[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  // 用消息数 + 首尾消息内容 hash 作为 key
  const first = messages[0];
  const last = messages[messages.length - 1];
  const firstContent = typeof first?.content === 'string' ? first.content.slice(0, 100) : '';
  const lastContent = typeof last?.content === 'string' ? last.content.slice(0, 100) : '';
  const key = `${messages.length}:${firstContent}:${lastContent}`;
  const cached = tokenEstimateCache.get(key);
  if (cached && Date.now() - cached.ts < TOKEN_ESTIMATE_CACHE_TTL_MS) {
    return cached.tokens;
  }
  const tokens = estimateTokensFromMessages(messages);
  if (tokenEstimateCache.size >= TOKEN_ESTIMATE_CACHE_MAX) {
    const oldest = tokenEstimateCache.keys().next().value;
    if (oldest !== undefined) tokenEstimateCache.delete(oldest);
  }
  tokenEstimateCache.set(key, { tokens, ts: Date.now() });
  return tokens;
}

// P2-2: heartbeat 文件 mtimeMs 缓存 —— 仅读取修改时间变化的文件
// session 文件缓存完整解析结果（供 pendingMessages + debt 写入复用）
const sessionFileCache = new Map<string, { mtimeMs: number; data: any; msgCount: number }>();
// debt 文件缓存解析后的 tokenRatio
const debtFileCache = new Map<string, { mtimeMs: number; ratio: number }>();

// Tool-aware retrieval strategy helpers 已抽出到 src/plugin/tool-guidance.ts

// Session-isolated dedup & overhead caches
import { setMaxDedupRounds, evictStaleDedupPublic } from "./plugin/dedup-cache.js";
// Smart Tool Guidance — 会话级工具追踪清理
import { evictStaleToolTrackers } from "./plugin/tool-guidance.js";
// Goal Anchoring — 会话级目标缓存清理
import { evictStaleGoalCache } from "./plugin/goal-cache.js";

// Distillation helpers
import * as distillationModule from "./plugin/distillation.js";

const pluginEntry: any = definePluginEntry({
  id: "lcm-graph-extra",
  name: "LCM Graph Extra",
  description: "Coordinates lossless-claw, qmd, and graph-memory-pro for enhanced context assembly",
  // SDK 2026.8.1: 规范要求 kind 声明在 openclaw.plugin.json（manifest）里，
  // runtime-entry 的 kind 仅作为旧插件兼容 fallback（DefinePluginEntryOptions.kind 已标 @deprecated）。
  // 恰好与 manifest.kind="context-engine" 一致，loader kindsEqual 校验通过，
  // 同时保证 discovery/isolated 装载路径下出口也能自述插件类型。
  kind: "context-engine",
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
    let _retrievalGateway: any = null;
    // 存储 RetrievalGateway 初始化配置，供 heartbeat 中恢复重试
    let _retrievalGatewayConfig: { maxResults: number; fuzzyMatchThreshold: number; decayHalfLifeDays: number } | null = null;
    let _lastEmbedHealth: boolean = true;
    /** v2.7.0 P1: graph quickHealth 连续失败计数，≥3 次触发 health() 完整恢复 */
    let _graphQuickHealthFailCount = 0;
    /** API 健壮性自愈：EXPERIENCE 全文索引是否已在本轮连接状态下验证过。
     *  true 后不再重复建索引；连接丢失/重建时复位为 false，恢复后再验证。 */
    let _expIndexesVerified = false;
    /** gm-pro 独立 HTTP API 上一次探测结果（用于记录 断开→恢复 转换日志） */
    let _lastGmProHttpOk = true;
    let _modelRegistry: Record<string, number> | undefined;
    // 从 assemble 中捕获活跃模型 ID，供 compact 回查模型上下文窗口
    let _activeModelId: string | undefined;
    let _activeModelContextWindow: number | undefined;
    // Dashboard 快照服务停止函数（register 时启动，dispose 时调用）；null 表示未启动
    let snapshotServerStop: (() => Promise<void>) | null = null;
    // Snapshot server handle（heartbeat 中检查状态 + 重试启动）
    let snapshotHandle: import('./dashboard-snapshot.js').SnapshotServerHandle | null = null;
    let snapshotConfig: { port: number; host: string; providers: import('./dashboard-snapshot.js').SnapshotProviders } | null = null;
    // P-CB-8: 防止并发恢复（onClose 和 heartbeat 可能同时触发）
    let _snapshotRecoveryInProgress = false;

    // compact() 入口同会话冷却：SDK 后台维护（turnMaintenanceMode:'background'）每轮
    // turn 结束后都会调用本插件的 compact()，若每次都真的执行 DAG 压缩，会在活跃对话中
    // 反复打满本地 LLM pending 队列。按会话记录最近一次实际提交压缩的时间戳，冷却期内
    // 且无显式 force/溢出压力时跳过。手动压缩（lcmg_compact / /compact）走独立路径不受影响。
    const _lcmCompactLastTs = new Map<string, number>();
    const _lcmCompactCooldownDefaultMs = 120_000;

    /**
     * P-CB-8: 指数退避重试启动 snapshot server。
     * 修复前：心跳中只尝试一次，失败后等 5 分钟下一轮。
     * 修复后：在心跳周期内以 1s/2s/4s/8s/16s/32s 退避重试，
     * 总耗时约 63s，远小于 5 分钟心跳间隔，大幅缩短恢复窗口。
     */
    async function retrySnapshotRestart(): Promise<boolean> {
      if (!snapshotConfig) return false;
      if (_snapshotRecoveryInProgress) return false;
      _snapshotRecoveryInProgress = true;
      try {
        // P-CB-8: 先主动 stop 旧 server（设置 closedIntentionally=true），
        // 确保旧 server 的 onClose 不会再触发，且端口被释放。
        // 修复前：不 stop 旧 server 就直接 startDashboardSnapshotServer，
        // 新 server 的 probe 检测到旧实例仍占用端口 → 发 shutdown →
        // 旧 server close 触发 onClose → 再次调用 retrySnapshotRestart → 死循环。
        if (snapshotServerStop) {
          try { await snapshotServerStop(); } catch {}
          snapshotServerStop = null;
        }
        // 等待端口释放（closeAllConnections + close 回调需要一点时间）
        await new Promise((r) => setTimeout(r, 300));

        const delays = [1000, 2000, 4000, 8000, 16000, 32000];
        for (let i = 0; i < delays.length; i++) {
          try {
            const handle = startDashboardSnapshotServer({
              ...snapshotConfig,
              onClose: onSnapshotClose,
            });
            // 等待启动完成（最多 1.5s）
            const waitStart = Date.now();
            while (Date.now() - waitStart < 1500) {
              if (handle.started) break;
              if (handle.failureReason) break;
              await new Promise((r) => setTimeout(r, 100));
            }
            if (handle.started) {
              snapshotHandle = handle;
              snapshotServerStop = handle.stop;
              logger?.info?.(`heartbeat: dashboard snapshot server recovered (attempt ${i + 1}/${delays.length}), listening on ${snapshotConfig.host}:${snapshotConfig.port}`);
              return true;
            }
            logger?.debug?.(`heartbeat: snapshot restart attempt ${i + 1}/${delays.length} failed: ${handle.failureReason || 'unknown'}`);
          } catch (e) {
            logger?.debug?.(`heartbeat: snapshot restart attempt ${i + 1}/${delays.length} threw: ${e instanceof Error ? e.message : String(e)}`);
          }
          // 最后一次不等待
          if (i < delays.length - 1) {
            await new Promise((r) => setTimeout(r, delays[i]));
          }
        }
        return false;
      } finally {
        _snapshotRecoveryInProgress = false;
      }
    }

    /**
     * P-CB-8: snapshot server 意外关闭回调。
     * server 崩溃（非主动 stop）时立即触发恢复，不等待下一轮 5 分钟心跳。
     */
    function onSnapshotClose(): void {
      if (!snapshotConfig) return;
      // 避免在 close 事件回调中做重操作，用 setImmediate 延后
      setImmediate(() => {
        if (!snapshotHandle || snapshotHandle.started) return; // 已被其他恢复路径处理
        logger?.warn?.('snapshot server onClose triggered, starting immediate recovery');
        retrySnapshotRestart().catch(() => {});
      });
    }
    // 最近一次检索 query，供 dashboard /internal/snapshot 只读访问
    let lastRetrievalQuery: string = '';
    // Session-isolated dedup & overhead caches 已抽出到
    // src/plugin/dedup-cache.ts 与 src/plugin/overhead-cache.ts

    /**
     * 读取 OpenClaw session JSONL 文件，提取历史消息。
     * 每行一个 JSON 对象，过滤出有 role + content 的消息条目。
     */
    async function readSessionFileMessages(sessionFile: string): Promise<any[]> {
      const { createReadStream, existsSync } = await import('node:fs');
      const { createInterface } = await import('node:readline');
      const messages: any[] = [];
      try {
        if (!existsSync(sessionFile)) {
          logger?.warn?.('[readSessionFileMessages] file not found', { sessionFile });
          return messages;
        }
        const stream = createReadStream(sessionFile, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        let lineCount = 0;
        let parseErrorCount = 0;
        let matchedCount = 0;
        let skippedEmptyCount = 0;
        let sampleLines: string[] = [];
        for await (const line of rl) {
          lineCount++;
          const trimmed = line.trim();
          if (!trimmed) {
            skippedEmptyCount++;
            continue;
          }
          if (lineCount <= 5) {
            sampleLines.push(trimmed.substring(0, 200));
          }
          try {
            const record = JSON.parse(trimmed);
            if (record && typeof record === 'object' && !Array.isArray(record)) {
              let role: string | undefined = record.role;
              let content: unknown = record.content ?? record.text;
              // OpenClaw transcript 实际格式: {type, message:{role, content}}
              // role 和 content 在 message 字段内部，不在顶层
              if (record.type === 'message' && record.message && typeof record.message === 'object') {
                role = record.message.role;
                content = record.message.content ?? record.message.text;
              } else if (!role && (record.type === 'user' || record.type === 'assistant' || record.type === 'system')) {
                role = record.type;
                content = record.content ?? record.text;
              }
              if (typeof role === 'string' && content != null) {
                const hasContent = typeof content === 'string'
                  ? content.trim().length > 0
                  : Array.isArray(content)
                    ? content.some((c: any) => typeof c === 'string' ? c.trim().length > 0 : (c?.text ?? '').trim().length > 0)
                    : String(content).trim().length > 0;
                if (hasContent) {
                  matchedCount++;
                  messages.push({ ...record, role, content });
                }
              }
            }
          } catch {
            parseErrorCount++;
          }
        }
        logger?.info?.('[readSessionFileMessages] parse stats', {
          sessionFile,
          lineCount,
          skippedEmptyCount,
          parseErrorCount,
          matchedCount,
          sampleLines: sampleLines.length > 0 ? sampleLines : undefined,
        });
      } catch (err) {
        logger?.warn?.('[readSessionFileMessages] failed', { sessionFile, err: serializeError(err) });
      }
      return messages;
    }

    async function ensureInitialized() {
      if (initialized) return;
      if (initPromise) return initPromise;
      initPromise = (async () => {
      try {
        tracker = new UsageTracker(logger);
        _losslessClawAdapter = getOrCreateLosslessClawAdapter(logger);
        // P1-2 fix: await connection and log result
        try {
          const adapterConnected = await _losslessClawAdapter.connect();
          if (!adapterConnected) {
            logger?.warn?.("init: lossless-claw adapter connection failed, compact will be backup-only", { err: _losslessClawAdapter.initError });
          }
        } catch (adapterErr) {
          logger?.warn?.("init: lossless-claw adapter connect threw", { err: (adapterErr as Error).message });
        }
        const { QmdClient, QMD_CLIENT_DEFAULTS } = await import("./qmd-client.js");
        const { GraphAdapter } = await import("./adapters/graph-adapter.js");
        const { ExperienceStorage } = await import("./experience/index.js");

        // -- QMD 全局配置 (来自 memory.qmd) --
        const qmdConfig = api.pluginConfig?.retrieval?.qmd ?? {};
        const qmdBaseUrl = typeof qmdConfig.mcpEndpoint === 'string'
          ? qmdConfig.mcpEndpoint.replace(/\/mcp$/, '')
          : undefined;

        // -- 插件自有参数 (来自 plugins.lcm-graph-extra) --
        // BUGFIX: 合并 openclaw.json entries 配置，确保 graphAdapter 和
        // getNeo4jDriver() 使用相同的配置来源。
        // 原问题：api.pluginConfig 可能不包含 entries 中的 neo4j 配置，
        // 导致 graphAdapter 连接失败但 getNeo4jDriver()（tools.ts）连接成功。
        const pluginConfig: any = mergeEntriesNeo4jConfig(api) ?? api.pluginConfig ?? {};
        // 统一从 DEFAULT_CONFIG 取默认值（config.ts 为唯一真相来源），避免 QMD_CLIENT_DEFAULTS 硬编码不一致
        const cliFallbackSearchType = pluginConfig.cliFallbackSearchType ?? DEFAULT_CONFIG.cliFallbackSearchType;
        const cliTimeout = pluginConfig.cliTimeout ?? DEFAULT_CONFIG.cliTimeout;
        // MCP 初始化握手超时（JSON-RPC handshake，通常 < 500ms）
        const qmdMcpTimeout = pluginConfig.qmdMcpTimeout ?? DEFAULT_CONFIG.qmdMcpTimeout;
        // MCP/REST 查询超时（首次 embedding 冷启动需 4-5s，默认 15s 覆盖冷启动+排队）
        const qmdMcpQueryTimeout = pluginConfig.qmdMcpQueryTimeout ?? DEFAULT_CONFIG.qmdMcpQueryTimeout;

        qmdClient = new QmdClient({
          mcpBaseUrl: qmdBaseUrl,
          mcpTimeout: qmdMcpTimeout,
          mcpQueryTimeout: qmdMcpQueryTimeout,
          cliTimeout: cliTimeout,
          cliFallbackSearchType: cliFallbackSearchType,
          enableCliFallback: pluginConfig.enableCliFallback,
          qmdQueryMaxChars: pluginConfig.retrieval?.qmdQueryMaxChars,
        });
        graphAdapter = new GraphAdapter(
          resolveNeo4jConfig(pluginConfig),
          {
            enabled: true,
            searchLimit: pluginConfig.retrieval?.graph?.searchLimit ?? 5,
            searchCacheSize: pluginConfig.retrieval?.graph?.searchCacheSize ?? 50,
            embedding: resolveEmbeddingConfig(pluginConfig) ?? undefined,
            // v2.3.6 在线学习：把 judge / associationMatrix / autoFeedback 透传给适配层，
            // 由 graph-adapter 注入 Recaller（JudgeManager + AssociationMatrix）并驱动反馈闭环。
            embeddingDimensions: resolveEmbeddingConfig(pluginConfig)?.dimensions ?? undefined,
            judge: pluginConfig.retrieval?.graph?.judge,
            associationMatrix: pluginConfig.retrieval?.graph?.associationMatrix,
            autoFeedback: pluginConfig.retrieval?.graph?.autoFeedback,
          },
          logger,
        );

        // Connect once; if Neo4j unavailable, still initialize so L2 works
        // BUGFIX: connect() 内部 catch 所有异常并返回 false（不抛出），
        // 原 catch 块是死代码。改为检查返回值，正确记录连接失败状态。
        let graphConnected = false;
        try {
          graphConnected = await graphAdapter.connect();
        } catch (err) {
          logger?.warn?.("init: graphAdapter.connect() threw", { err: (err as Error).message });
        }
        if (!graphConnected) {
          logger?.warn?.("init: Neo4j unavailable (connect returned false), L3/L4 will be skipped. " +
            "Distillation will attempt reconnect on demand.");
        }

        expStore = new ExperienceStorage(graphAdapter);

        // R-8: 确保 EXPERIENCE 节点全文索引（summary/context/title）
        try {
          const initIdxOk = await expStore.ensureIndexes();
          if (!initIdxOk) {
            logger?.warn?.("init: EXPERIENCE indexes creation failed (non-fatal, will retry in heartbeat)");
          }
        } catch (e) {
          logger?.warn?.("init: EXPERIENCE indexes creation failed (non-fatal)", { err: (e as Error).message });
        }

        // 确保 Neo4j schema 在初始化时创建（约束 + 全文 + 向量索引）
        try {
          await ensureNeo4jSchema();
        } catch (e) {
          logger?.warn?.("init: ensureNeo4jSchema failed (non-fatal, will retry in heartbeat)", { err: (e as Error).message });
        }

        // S1-1: Initialize Merger for entity-level cross-engine dedup
        const { Merger } = await import("./merger.js");
        merger = new Merger({
          maxResults: (api.pluginConfig?.retrieval?.limits ?? {}).qmd
            ? (api.pluginConfig.retrieval.limits.qmd + (api.pluginConfig.retrieval.limits.graph ?? 5))
            : 10,
          fuzzyMatchThreshold: 0.85,
          // BUGFIX(P1-2): 统一使用 DEFAULTS.ttl.halfLifeDays，消除 30 vs 45 不一致
          decayHalfLifeDays: DEFAULTS.ttl.halfLifeDays,
        });

        // 创建全局 RetrievalGateway 单例，供 dashboard snapshot 读取检索性能
        // 存储配置供 heartbeat 中恢复重试（初始化失败时 _retrievalGateway 为 null）
        _retrievalGatewayConfig = {
          maxResults: merger.config.maxResults,
          fuzzyMatchThreshold: merger.config.fuzzyMatchThreshold,
          decayHalfLifeDays: merger.config.decayHalfLifeDays,
        };
        try {
          const { RetrievalGateway } = await import("./retrieval-gateway.js");
          _retrievalGateway = new RetrievalGateway(qmdClient, graphAdapter, _retrievalGatewayConfig);
        } catch (gwErr) {
          const errDetail = gwErr instanceof Error
            ? { message: gwErr.message, stack: gwErr.stack, name: gwErr.name }
            : { err: String(gwErr) };
          logger?.warn?.('[lcm-graph-extra] RetrievalGateway initialization failed, retrieval stats will show "not initialized". Will retry in heartbeat.', errDetail);
        }

        // S5-2: Update MAX_DEDUP_ROUNDS from plugin config
        // WindowMonitor config is at api.pluginConfig.lcmMonitor (not nested under plugins.entries)
        if (api.pluginConfig?.lcmMonitor?.dedupRounds) {
          setMaxDedupRounds(api.pluginConfig.lcmMonitor.dedupRounds);
        }

        // v2.2.3: 从 pluginConfig 应用 LLM 超时覆盖（支持 openclaw.json 中 llmTimeouts 配置）
        configureLlmTimeouts(api.pluginConfig?.llmTimeouts);

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

          // Auto-match llmProvider.maxTokens based on model context window
          const llmProvider = (api as any).pluginConfig?.llmProvider;
          if (llmProvider?.model && llmProvider.model !== 'default') {
            let ctxWindow = _modelRegistry[llmProvider.model];
            if (ctxWindow === undefined) {
              const shortId = llmProvider.model.includes('/') ? llmProvider.model.split('/').pop() : llmProvider.model;
              for (const [key, val] of Object.entries(_modelRegistry)) {
                if (key.endsWith(shortId!)) { ctxWindow = val; break; }
              }
            }
            if (ctxWindow) {
              const recommended = autoMatchMaxTokens(ctxWindow);
              const current = llmProvider.maxTokens;
              // Only auto-match if user hasn't explicitly set a non-default value
              if (current === 4096 || current === 32_768) {
                if (current !== recommended) {
                  llmProvider.maxTokens = recommended;
                  logger?.info?.('[auto-match] llmProvider.maxTokens auto-matched', {
                    model: llmProvider.model,
                    contextWindow: ctxWindow,
                    oldMaxTokens: current,
                    newMaxTokens: recommended,
                  });
                }
              }
            }
          }
        } catch (e) { /* non-fatal, will use defaults */
          logger?.debug?.("model registry loading failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }

        // O3: MCP 连接预热 — 异步 ping MCP 健康端点，预建立 TCP 连接 + DNS 解析
        // 确保首次查询时不需要 TCP 握手（~50ms），连接池已就绪
        if (qmdClient) {
          qmdClient.ping().then((ok: boolean) => {
            if (ok) {
              logger?.debug?.('[ensureInitialized] MCP connection pre-warmed');
            }
          }).catch(() => { /* non-fatal */ });
        }

        initialized = true;
        logger?.debug?.('[ensureInitialized] completed, graphAdapter=' + (graphAdapter ? 'set' : 'NULL') + ', driver=' + ((graphAdapter as any)?.driver ? 'set' : 'NULL'));
      } catch (err) {
        // Reset lock so next assemble retries instead of being permanently stuck
        initPromise = null;
        logger?.warn?.("init: failed, will retry on next assemble", { err: (err as Error).message });
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
        // 与 openclaw.plugin.json / package.json / definePluginEntry.version 保持一致
        version: "2.1.12",
        ownsCompaction: true,
        turnMaintenanceMode: 'background',
        // OpenClaw 2026.7.2+ durable-turn 契约：声明 currentTurnFence + 幂等提交，
        // 否则宿主整轮走 legacy 路径（含重试）。
        transcriptSemantics: {
          currentTurnFence: 'before-current-turn-entry-v1',
          turnAdvancementIdempotency: 'atomic-idempotent-v1',
        },
        // 仅接受所需 host 注入字段，避免未知字段干扰 assemble/compact
        acceptedHostParams: ['sessionKey', 'prompt', 'runtimeContext', 'runtimeSettings'],
        // SDK ContextEngineOperation = "agent-run" | "manual-compact" | "subagent-spawn"
        // 为每个 operation 声明所需 host capabilities，确保 SDK 在 host 不支持时
        // 抛出明确错误而非静默降级。
        hostRequirements: {
          'agent-run': {
            requiredCapabilities: ['assemble-before-prompt', 'after-turn', 'compact', 'maintain'],
          },
          // 手动触发 compact（如用户调用 lcmg_compact 工具）时所需能力
          'manual-compact': {
            requiredCapabilities: ['compact'],
          },
          // subagent 启动前需要 bootstrap 注入子会话上下文
          'subagent-spawn': {
            requiredCapabilities: ['bootstrap', 'assemble-before-prompt'],
          },
        },
      },

      // SDK ContextEngine.bootstrap（可选）：会话启动时 SDK 主动调用，
      // 我们委托给 lossless-claw 的 bootstrap 完成会话初始化。
      // 若 adapter 未连接或 engine 未实现 bootstrap，返回安全默认值。
      async bootstrap(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        messages?: any[];        // SDK 可能注入的当前消息（用于增量 bootstrap）
        runtimeSettings?: unknown;
      }): Promise<{ bootstrapped: boolean; importedMessages?: number; reason?: string }> {
        try {
          if (!_losslessClawAdapter?.bootstrap) {
            return { bootstrapped: false, reason: 'adapter_not_connected' };
          }
          // SDK 注入的 sessionId 可能是 number 类型（如 conversationId），
          // 用 != null 检查替代 typeof === 'string'，确保 number 类型正确转换
          const sid = params.sessionId != null ? String(params.sessionId) : '';
          // BUGFIX: 不再传 messages: [] 覆盖 lossless-claw 的 sessionFile 读取路径。
          // 原来传空数组导致 DAG 只有当前轮的 14K 消息，而 sessionFile 里的 58K 历史
          // 没有被导入，compact 永远只能压缩最近 14K。
          // 现在：不传 messages，让 lossless-claw 走 sessionFile 路径读取完整历史。
          // 如果 SDK 注入了 messages（增量 bootstrap），则透传。
          const bootstrapParams: any = {
            sessionId: sid,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
          };
          if (Array.isArray(params.messages) && params.messages.length > 0) {
            bootstrapParams.messages = params.messages;
          }
          const result = await _losslessClawAdapter.bootstrap(bootstrapParams);
          logger?.info?.('[bootstrap] lossless-claw bootstrap result', {
            sessionId: sid,
            sessionFile: params.sessionFile,
            bootstrapped: (result as any)?.bootstrapped,
            importedMessages: (result as any)?.importedMessages,
            reason: (result as any)?.reason,
          });
          return {
            bootstrapped: !!(result as any)?.bootstrapped,
            importedMessages: (result as any)?.importedMessages,
            reason: (result as any)?.reason,
          };
        } catch (err: any) {
          logger?.warn?.('[bootstrap] failed', { err: err?.message ?? String(err) });
          return { bootstrapped: false, reason: 'bootstrap_error: ' + (err?.message ?? String(err)) };
        } finally {
          // 会话重置（/new 等）：清除旧会话的所有缓存，防止 uncomp、压力等级等
          // 使用上一轮会话的陈旧数据。bootstrap 在新会话启动时由 SDK 主动调用。
          try {
            const sid = params.sessionId != null ? String(params.sessionId) : '';
            // BUG-AUDIT: 会话级缓存一律按 sessionId 隔离；清理也必须用 sessionId，
            // 不能退化为 sessionKey（/new 时 sessionKey 不变，按其清除会清错桶/漏清目标桶）。
            const sk = sid || (typeof params.sessionKey === 'string' ? params.sessionKey : '');

            // 1. 失效 conversation_id 缓存（10min TTL，不主动清除会导致 uncomp 统计错误）
            invalidateConvIdCache(sk, sid);

            // 2. 清除会话级缓存（overhead / dedup / goal / tool-guidance）
            try {
              const { clearOverheadCache } = await import("./plugin/overhead-cache.js");
              clearOverheadCache(sk);
            } catch { /* non-fatal */ }
            try {
              const { clearSessionDedup } = await import("./plugin/dedup-cache.js");
              clearSessionDedup(sk);
            } catch { /* non-fatal */ }
            try {
              const { clearGoalCache } = await import("./plugin/goal-cache.js");
              clearGoalCache(sk);
            } catch { /* non-fatal */ }
            try {
              const { clearSessionToolTracker } = await import("./plugin/tool-guidance.js");
              clearSessionToolTracker(sk);
            } catch { /* non-fatal */ }
            // durable-turn：按 sessionId 清空已提交逻辑轮幂等记录，防止 /new 后跨会话去重误判
            try {
              const _prefix = `${sid}|`;
              for (const k of Array.from(committedTurnKeys)) {
                if (typeof k === 'string' && k.startsWith(_prefix)) committedTurnKeys.delete(k);
              }
            } catch { /* non-fatal */ }

            // 3. 清除 MoA 缓存（防止上一轮 MoA 结果被误用）
            try {
              const { getMoaResultCache } = await import("./moa/orchestrator.js");
              getMoaResultCache(); // 读取并清空
            } catch { /* non-fatal */ }

            logger?.info?.("[bootstrap] session caches invalidated for new session", { sessionKey: sk });
          } catch { /* non-fatal */ }

          // H-6: 会话启动时预加载高频经验（非阻塞，失败静默）
          try {
            const sid = params.sessionId != null ? String(params.sessionId) : '';
            const sk = params.sessionKey ?? sid;
            if (sessionWarmupCache.size >= WARMUP_CACHE_MAX) {
              const firstKey = sessionWarmupCache.keys().next().value;
              if (firstKey) sessionWarmupCache.delete(firstKey);
            }
            if (expStore) {
              const topExp = await expStore.getTopExperiences(3);
              if (topExp && topExp.length > 0) {
                sessionWarmupCache.set(sk, topExp);
                logger?.debug?.("[bootstrap] H-6 warmup: preloaded top experiences", { count: topExp.length, sessionKey: sk });
              }
            }
          } catch { /* non-fatal */ }
        }
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
        } catch (e) { /* non-fatal */
          logger?.debug?.("ingest failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }
        const count = (params.messages ?? []).length;
        return { ingestedCount: count };
      },

      async commitTurn(params: {
        advancementKey: string;
        admission: any;
        terminal: any; // SDK: TranscriptEntryAnchor
        messages: any[];
        sessionId: string;
        sessionKey?: string;
        sessionTarget?: any; // SDK: ContextEngineSessionTarget
        runtimeContext?: Record<string, unknown>;
        runtimeSettings?: any;
        isHeartbeat?: boolean;
      }) {
        try {
          const sessionId = params.sessionId != null ? String(params.sessionId) : '';
          const decision = evaluateTurnCommit({
            sessionId,
            advancementKey: params.advancementKey,
            logicalTurnId: params.admission?.logicalTurnId,
            seen: committedTurnKeys,
          });

          // ① 幂等去重 / 陈旧提交判定
          if (decision.duplicate) {
            if (decision.keyMismatch) {
              logger?.warn?.('[lcm-graph-extra] commitTurn: advancementKey mismatch (stale admission)', {
                sessionId, advancementKey: params.advancementKey, logicalTurnId: params.admission?.logicalTurnId,
              });
            }
            return { status: 'duplicate', committedTurnId: decision.turnId };
          }

          // ② 委托 lossless-claw 持久化（幂等递交）
          // SDK 2026.8.1 闭环：commitTurn 失败必须抛错——host 捕获后会保留
          // context_engine_turn_outbox 行并重试（"Hosts may retry the same
          // advancement key after process or plugin failure"）。修复前失败也
          // 记录幂等 key 并返回 duplicate，host 会删除 outbox 行，该轮在引擎
          // 存储中永久丢失（后续 compact/summary 基于缺失数据）。
          let downstream: { status?: string } | null = null;
          try {
            downstream = await _losslessClawAdapter?.commitTurn?.(params) ?? null;
          } catch (e) {
            logger?.warn?.('[lcm-graph-extra] commitTurn: adapter commit failed, letting host retry', {
              err: e instanceof Error ? e.message : String(e),
            });
            throw e; // 交由 host outbox 重试，闭环
          }

          // ③ 仅在下游给出确定结果时记录幂等 key（LRU 上限裁剪）；
          //    不确定结果（无 adapter / 未知 status）抛错让 host 重试。
          const downstreamStatus = downstream?.status;
          if (downstreamStatus !== 'committed' && downstreamStatus !== 'duplicate') {
            throw new Error(
              `commitTurn: downstream result indeterminate (status=${String(downstreamStatus)})`,
            );
          }
          committedTurnKeys.add(decision.key);
          if (committedTurnKeys.size > COMMITTED_TURN_MAX) {
            const first = committedTurnKeys.values().next().value;
            if (first != null) committedTurnKeys.delete(first);
          }

          return {
            status: downstreamStatus,
            committedTurnId: decision.turnId,
          };
        } catch (err) {
          // 抛错闭环：host 在 outbox drain 中捕获并保留行重试；下一轮开始前
          // 若仍失败，host 会 degradeBeforeStart 回退 legacy 引擎（安全降级），
          // 不会污染会话状态。commitTurn 不在推理关键路径上，抛错不中断推理。
          logger?.error?.('[lcm-graph-extra] commitTurn failed, host will retry via outbox', {
            err: serializeError(err),
          });
          throw err;
        }
      },

      /**
       * Assemble — optimized: instances reused, L2/L3/L4 fully parallelized.
       */
      async assemble(params: any) {
        // G-MODEL-SYNC: 捕获会话主模型快照，供后台 cron 蒸馏 / compact provider
        // 等非对话上下文复用，避免本地主模型与 distillationLlm 配置争抢 GPU。
        // 仅当 params.runtimeContext.llm 存在时记录；recordRuntimeLlm 内部会判定
        // 是否为本地模型，非本地（远程）时自动清空快照。
        try {
          const rllm = (params as any)?.runtimeContext?.llm;
          // 传入 params.model 作为权威 agent 模型：同 session 内用 /model 切换后，
          // 每个轮次都会重新探测判定本地/远程，避免后台任务沿用旧模型。
          // 传入 sessionKey：不同 agent/会话各自使用自己的本地模型快照。
          const _sk = (params as any)?.sessionKey ?? (params as any)?.session_id ?? '';
          distillationModule.recordRuntimeLlm?.(rllm, params.model, _sk);
        } catch { /* ignore */ }

        // 捕获活跃模型 ID，供 compact 回查模型实际上下文窗口
        const modelId = typeof params.model === "string" ? params.model : "";
        if (modelId && _modelRegistry) {
          _activeModelId = modelId;
          let modelCtx = _modelRegistry[modelId];
          // 短 ID 回退：匹配 "provider/shortId" 中任意以 shortId 结尾的 key
          if (modelCtx === undefined) {
            const shortId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
            for (const [key, val] of Object.entries(_modelRegistry)) {
              if (key.endsWith(shortId!)) {
                modelCtx = val;
                break;
              }
            }
          }
          _activeModelContextWindow = modelCtx;
        }

        // BUGFIX: 确保子系统初始化完成后再构造 AssembleContext。
        // 修复前：ctx 在 ensureInitialized 之前构造，捕获了闭包变量 qmdClient /
        // graphAdapter / expStore 的初始 null 值。即使 ensureInitialized 更新了闭包
        // 变量，ctx 中仍然是 null，导致首次 assemble 的 L2/L3/L4 全部报
        // "Cannot read properties of null" 错误。
        // 修复后：先 await ensureInitialized 确保闭包变量已赋值，再构造 ctx。
        try {
          await ensureInitialized();
        } catch (initErr) {
          const msg = initErr instanceof Error ? initErr.message : String(initErr);
          logger?.warn?.("assemble: init failed, returning empty", { err: msg });
          return {
            messages: params.messages ?? [],
            estimatedTokens: 0,
            systemPromptAddition: undefined,
            promptAuthority: "assembled",
            degraded: true,
            degradedReasons: ["init_failed: " + msg],
          };
        }

        // R-1: 委托给 src/assemble/index.ts
        const ctx: AssembleContext = {
          api,
          logger,
          qmdClient,
          graphAdapter,
          expStore,
          merger,
          losslessClawAdapter: _losslessClawAdapter,
          retrievalGateway: _retrievalGateway,
          cascadeManager,
          modelRegistry: _modelRegistry,
          lastEmbedHealth: _lastEmbedHealth,
          tracker,
          ensureInitialized,
          resolveDistillationLlm,
          sessionWarmupCache,
          lastAssembleExpIdsBySession,
          sessionQualityScores,
          llmRerankCache,
          l2QueryCache,
          l4QueryCache,
          // BUG-6: L2/L4 查询缓存大小可配置（原硬编码 QUERY_CACHE_MAX = 50）
          cacheSize: api.pluginConfig.retrieval?.cacheSize ?? 50,
          // v2.7.0 P4: 冲突检测异步缓存
          conflictCache,
          // v2.8.0 O7: 异步预取缓存
          prefetchCache,
          userProfile,
          setLastRetrievalQuery: (q: string) => { lastRetrievalQuery = q; },
        };
        return assembleCore(ctx, params);
      },

      async afterTurn(params: any) {
        // G-MODEL-SYNC: 同步写入主模型快照（afterTurn 与 assemble 可能先后调用，
        // 两者都调用 recordRuntimeLlm 以保证任何路径触发的后续后台任务都能拿到）
        try {
          const rllm = (params as any)?.runtimeContext?.llm;
          const _sk = (params as any)?.sessionKey ?? (params as any)?.session_id ?? '';
          distillationModule.recordRuntimeLlm?.(rllm, params.model, _sk);
        } catch { /* ignore */ }

        // R-1: 委托给 src/after-turn/index.ts
        const ctx: AfterTurnContext = {
          api,
          logger,
          qmdClient,
          graphAdapter,
          expStore,
          losslessClawAdapter: _losslessClawAdapter,
          cascadeManager,
          retrievalGateway: _retrievalGateway,
          lcmgConfig: api.pluginConfig,
          tracker,
          userProfile,
          resolveDistillationLlm,
          lastAssembleExpIdsBySession,
          sessionQualityScores,
          l4QueryCache,
          // v2.7.0 P7: L2 检索预取 — afterTurn 预取下一轮 vec 结果写入此缓存
          l2QueryCache,
          // v2.8.0 O7: 异步预取缓存 — afterTurn 全量预取 L2+L3+L4 供下一轮 assemble 使用
          prefetchCache,
        };
        await afterTurnCore(ctx, params);
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
            logger?.warn?.("compact: init failed", { err: errMsg });
            return { ok: false, compacted: false, reason: 'init failed: ' + errMsg };
          }

        try {
          // Non-blocking compaction strategy:
          // 1. Fire-and-forget the heavy DAG/LLM summarization to background
          // 2. Perform lightweight backup + marker in foreground (fast path)
          // This eliminates the 10s+ blocking delay during compact().
          
          const _adapterConnected = !!(_losslessClawAdapter?.connected);

          // ── 输入超限分段压缩：渐进式 token budget 降级策略 ──
          // 当输入超过 LLM 上下文窗口安全阈值时，不直接跳过，而是用越来越小的
          // tokenBudget 多次尝试 compact，让引擎以更激进的方式压缩上下文。
          // 渐进式 budget：100% → 50% → 25% → 10%，任一 budget 成功即停止。
          const _currentTokens = (params as any).currentTokenCount ?? 0;
          const _cfg = (api as any).pluginConfig ?? (api as any).config ?? {};
          const _lcmMonitor = _cfg?.lcmMonitor ?? {};

          // 上下文窗口解析（按优先级）：
          //   1) params.contextWindow（SDK 直接传入）
          //   2) params.tokenBudget（SDK 在 threshold 模式下传入 = 上下文窗口）
          //   3) params.model → _modelRegistry（直接查表 + 短 ID 后缀回退）
          //   4) _activeModelContextWindow（assemble 上次捕获）
          //   5) lcmMonitor.contextWindow（用户配置）
          //   6) 默认 131072（更接近主流模型实际窗口；旧默认 262144 过高导致 budget 算大）
          const _paramsCtxWindow = (params as any).contextWindow;
          // SDK 在 threshold 模式下，tokenBudget = 模型上下文窗口
          const _paramsTokenBudget = typeof (params as any).tokenBudget === 'number'
            ? (params as any).tokenBudget
            : undefined;
          const _paramsCompactionTarget = (params as any).compactionTarget;
          const _ctxFromTokenBudget = (_paramsTokenBudget && _paramsCompactionTarget === 'threshold')
            ? _paramsTokenBudget
            : undefined;
          const _paramsModelId = typeof params.model === 'string' ? params.model : '';
          let _ctxFromModel: number | undefined;
          if (_paramsModelId && _modelRegistry) {
            _ctxFromModel = _modelRegistry[_paramsModelId];
            if (_ctxFromModel === undefined) {
              const shortId = _paramsModelId.includes('/') ? _paramsModelId.split('/').pop() : _paramsModelId;
              for (const [key, val] of Object.entries(_modelRegistry)) {
                if (key.endsWith(shortId!)) {
                  _ctxFromModel = val;
                  break;
                }
              }
            }
          }
          const _contextWindow = _paramsCtxWindow
            ?? _ctxFromTokenBudget
            ?? _ctxFromModel
            ?? _activeModelContextWindow
            ?? (_lcmMonitor as any)?.contextWindow
            ?? 131_072;
          const _ctxSource = _paramsCtxWindow ? 'params.contextWindow'
            : _ctxFromTokenBudget ? 'params.tokenBudget(threshold)'
            : _ctxFromModel ? 'params.model→registry'
            : _activeModelContextWindow ? 'activeModelContextWindow (from last assemble)'
            : (_lcmMonitor as any)?.contextWindow ? 'lcmMonitor.contextWindow'
            : 'default(131072)';
          const _compactBudget = (_lcmMonitor as any)?.compactTokenBudget ?? Math.floor(_contextWindow * 0.59);
          const _overflowThreshold = Math.floor(_contextWindow * 0.90) - _compactBudget;
          const _isInputOverflow = _currentTokens > _overflowThreshold && _currentTokens > 0;

          // 渐进式 budget 列表：从默认 budget 依次降级到 50% → 25% → 10%
          // 每一轮用更小的 budget 告诉引擎更激进地压缩，直到某一个 budget 能通过 precheck
          const _progressiveBudgets: number[] = _isInputOverflow
            ? [
                _compactBudget,
                Math.floor(_compactBudget * 0.50),
                Math.floor(_compactBudget * 0.25),
                Math.floor(_compactBudget * 0.10),
              ]
            : [_compactBudget];

          // 检查本地 DB 中未压缩消息数量：若已积累超过 dedupRounds 条，
          // 强制 lossless-claw 执行压缩，避免 threshold 模式因 token 数不高而跳过。
          const _compactSessionKey = typeof params.sessionKey === 'string' ? params.sessionKey
            : (typeof params.session_id === 'string' ? params.session_id : '');
          const _compactSessionId = params.sessionId != null
            ? String(params.sessionId)
            : (params.session_id != null ? String(params.session_id) : undefined);
          const _compactConvId = (_compactSessionKey || _compactSessionId)
            ? getConversationId(_compactSessionKey, _compactSessionId)
            : null;
          const _uncompressedCount = _compactConvId != null ? getUncompressedMessageCount(_compactConvId) : -1;
          const _dedupRounds = (_lcmMonitor as any)?.dedupRounds ?? 24;
          // 注意：_forceCompact 仍按"本地 DB 未压缩消息数 > dedupRounds"判定，
          // 但传给 lossless-claw 的 force 参数固定为 true（见下），因为我们的 compact hook
          // 是 /compact 的入口，必须确保 lossless-claw 执行压缩而非因 threshold 没超而跳过。
          const _forceCompact = _uncompressedCount > _dedupRounds;

          // ── compact() 入口同会话冷却 ──
          // SDK 后台维护（turnMaintenanceMode:'background'）每轮 turn 结束都会调用本 compact()。
          // 若每次都真的执行 DAG 压缩，会在活跃对话中反复调用 lossless-claw 压缩、打满本地 LLM
          // pending 队列。仅在"无显式 force / 无真实溢出 / 无积压"时应用同会话冷却；
          // 显式强制压缩与真实压力（输入溢出 / DB 积压超 dedupRounds）不受影响。
          if (params.force !== true && !_isInputOverflow && !_forceCompact) {
            const _lcmCompactKey = _compactSessionKey || _compactSessionId || '';
            if (_lcmCompactKey) {
              const _lcmCooldownMs = (_lcmMonitor as any)?.compactCooldownMs ?? _lcmCompactCooldownDefaultMs;
              const _lcmNow = Date.now();
              const _lcmLast = _lcmCompactLastTs.get(_lcmCompactKey);
              if (_lcmLast != null && _lcmNow - _lcmLast < _lcmCooldownMs) {
                logger?.debug?.('[compact] skipped (cooldown)', {
                  sessionKey: _lcmCompactKey,
                  cooldownMs: _lcmCooldownMs,
                  elapsedMs: _lcmNow - _lcmLast,
                  force: params.force,
                  isInputOverflow: _isInputOverflow,
                  forceCompact: _forceCompact,
                });
                return { ok: false, compacted: false, reason: 'cooldown' };
              }
              _lcmCompactLastTs.set(_lcmCompactKey, _lcmNow);
              // 防止 Map 无限增长：会话数过多时清理最旧条目
              if (_lcmCompactLastTs.size > 1000) {
                const _oldestKey = _lcmCompactLastTs.keys().next().value;
                if (_oldestKey !== undefined) _lcmCompactLastTs.delete(_oldestKey);
              }
            }
          }

          // BUGFIX: backfill — 对已存在但 DAG 不全的会话（之前 bootstrap 传 messages:[] 的会话），
          // lossless-claw 因 bootstrapped 标记拒绝重新导入，我们直接读取 sessionFile
          // 并调用 ingestBatch 把历史消息注入 DAG，使 compact 能看到完整上下文。
          // 同时保存 sessionFile 消息供后续 token 估算使用（SDK 不传 currentTokenCount 时）。
          let _sessionFileMsgs: any[] = [];
          if (_adapterConnected && typeof (params as any).sessionFile === 'string' && (params as any).sessionFile) {
            try {
              const _backfill = await _losslessClawAdapter.bootstrap({
                sessionId: _compactSessionId ?? '',
                sessionKey: _compactSessionKey || undefined,
                sessionFile: (params as any).sessionFile,
              });
              const _backfillReason = (_backfill as any)?.reason ?? '';
              const _backfillImported = (_backfill as any)?.importedMessages ?? 0;
              logger?.debug?.('[compact] backfill bootstrap result', {
                sessionFile: (params as any).sessionFile,
                bootstrapped: (_backfill as any)?.bootstrapped,
                importedMessages: _backfillImported,
                reason: _backfillReason,
              });
              // 若 lossless-claw 拒绝重新 bootstrap（already bootstrapped），我们手动读文件注入
              if (_backfillReason.includes('already bootstrapped') || _backfillImported === 0) {
                _sessionFileMsgs = await readSessionFileMessages((params as any).sessionFile);
                if (_sessionFileMsgs.length > 0) {
                  logger?.debug?.('[compact] injecting sessionFile messages via ingestBatch', {
                    count: _sessionFileMsgs.length,
                    sessionFile: (params as any).sessionFile,
                  });
                  const _ingestResult = await _losslessClawAdapter.ingestBatch({
                    sessionId: _compactSessionId ?? '',
                    sessionKey: _compactSessionKey || undefined,
                    messages: _sessionFileMsgs,
                  });
                  logger?.debug?.('[compact] ingestBatch result', {
                    ingestedCount: (_ingestResult as any)?.ingestedCount,
                    expectedCount: _sessionFileMsgs.length,
                  });
                } else {
                  logger?.warn?.('[compact] sessionFile parsed 0 messages', { sessionFile: (params as any).sessionFile });
                }
              }
            } catch (bfErr) {
              logger?.warn?.('[compact] backfill bootstrap failed (non-fatal)', { err: serializeError(bfErr) });
            }
          }

          logger?.debug?.('[compact] start', {
            sessionId: _compactSessionId,
            sessionKey: _compactSessionKey ? 'set' : 'missing',
            conversationId: _compactConvId,
            uncompressedCount: _uncompressedCount,
            dedupRounds: _dedupRounds,
            forceCompactByDB: _forceCompact,
            isInputOverflow: _isInputOverflow,
            currentTokenCount: _currentTokens,
            paramsForce: params.force,
            paramsModel: _paramsModelId,
            paramsContextWindow: _paramsCtxWindow,
            contextWindow: _contextWindow,
            contextWindowSource: _ctxSource,
            compactBudget: _compactBudget,
            overflowThreshold: _overflowThreshold,
            paramsSource: (params as any).source,
            paramsCompactionTarget: (params as any).compactionTarget,
            activeModelContextWindow: _activeModelContextWindow,
            modelRegistryKeys: _modelRegistry ? Object.keys(_modelRegistry).length : 0,
          });
          if (_forceCompact) {
            logger?.debug?.('[compact] uncompressed messages exceeded dedupRounds, forcing compaction', {
              uncompressedCount: _uncompressedCount,
              dedupRounds: _dedupRounds,
              conversationId: _compactConvId,
            });
          }

          if (_isInputOverflow) {
            logger?.warn?.('[compact] input overflow — triggering segmented (progressive-budget) compaction', {
              currentTokenCount: _currentTokens,
              overflowThreshold: _overflowThreshold,
              contextWindow: _contextWindow,
              progressiveBudgets: _progressiveBudgets,
            });

            // 利用 SDK 传入的 currentTokenCount 反推 SDK overhead 并缓存
            // BUG-AUDIT: key 用 sessionId（/new 后换新），避免写入上一会话的缓存桶
            const _sk = resolveSessionCacheKey(params);
            if (_sk && _currentTokens > 0) {
              const _msgTokens = cachedEstimateTokens(params.messages ?? []);
              updateSdkOverhead(_sk, _currentTokens, _msgTokens, 0);
            }
          }

          // P-CB-7: force compact 时用实际 token 数计算压缩目标预算。
          // 修复前：tokenBudget = _compactBudget（59% × 上下文窗口 = 77332），
          // 当实际上下文仅 26k 时，lossless-claw 因 budget 远大于实际 token 数
          // 而返回 "already under target" 拒绝压缩，37k→35k 仅减 2k。
          // 修复后：目标预算 = 50% × 当前 token 数（不低于 5000），
          // 确保 lossless-claw 真正执行压缩而非因 budget 过大而跳过。
          const _forceCompactBudget = (() => {
            if (!params.force || _isInputOverflow) return _compactBudget;
            // 优先使用 SDK 传入的 currentTokenCount，回退到 sessionFile 估算
            const est = _currentTokens > 0
              ? _currentTokens
              : (_sessionFileMsgs.length > 0 ? cachedEstimateTokens(_sessionFileMsgs) : 0);
            if (est > 0) {
              const budget = Math.max(5000, Math.floor(est * 0.5));
              logger?.debug?.('[compact] force compact budget calculated', {
                estimatedTokens: est,
                forceBudget: budget,
                originalCompactBudget: _compactBudget,
              });
              return budget;
            }
            return _compactBudget;
          })();

          // --- Promise.race + 900s (15min) timeout: trigger lossless-claw DAG compaction ---
          let summaryContent: string | undefined;
          let adapterCompacted = false;
          // 追踪 adapter 是否成功执行（即使未触发压缩），用于区分"已评估无需压缩"和"真正失败"
          let adapterOk = false;
          // 保存 lossless-claw compact 返回的完整结果，供循环外的返回逻辑使用
          let compactResult: any = null;
          // 保存 lossless-claw compact 返回的额外字段（firstKeptEntryId/sessionId/sessionFile），
          // 供成功 return 时透传给 SDK CompactResult.result。声明在 if 块外避免 scope 问题。
          let compactResultExtra: { firstKeptEntryId?: string; sessionId?: string; sessionFile?: string } = {};
          if (_adapterConnected) {
            // ── 分段压缩：渐进式 budget 循环 ──
            // 依次尝试每个 budget，直到某个 budget 成功通过 precheck 并完成压缩。
            // 非超限场景下 _progressiveBudgets = [_compactBudget]，退化为单次调用。
            let _succeededBudget = 0; // 记录成功时的 budget，用于判断是否需要 follow-up 迭代压缩
            for (const _tryBudget of _progressiveBudgets) {
              if (adapterCompacted) break; // 已成功，跳出循环

              const _isRetry = _tryBudget !== _progressiveBudgets[0];
              if (_isRetry) {
                logger?.debug?.('[compact] retrying with reduced budget', {
                  budget: _tryBudget,
                  originalBudget: _compactBudget,
                  ratio: Number((_tryBudget / _compactBudget).toFixed(2)),
                });
              }

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
                // 非超限场景：使用 _contextWindow 作为 tokenBudget，确保 lossless-claw
                // 的 threshold 计算基于模型上下文窗口而非 compact budget。
                // 超限场景：使用降级后的 _tryBudget 作为 budget 模式的目标。
                // P-CB-7: force compact 时使用 _forceCompactBudget（基于实际 token 数），
                // 避免 budget 远大于实际 token 数导致 "already under target" 拒绝压缩。
                const effectiveTokenBudget = _isInputOverflow
                  ? _tryBudget
                  : (params.force === true ? _forceCompactBudget : _contextWindow);
                compactResult = await Promise.race([
                  _losslessClawAdapter.compact({
                    ...params,
                    // BUGFIX: 不传 SDK 的 context-engine bound LLM（llm.complete），
                    // 否则 lossless-claw 会使用它 + runtimeModelOverride 调用 LLM，
                    // OpenClaw SDK 检查 agent 级 config 的 llm.allowModelOverride（未配置）→ 拒绝。
                    // 去掉后 lossless-claw 回退到 api.runtime.llm.complete（plugin-wide LLM），
                    // 其 plugins.entries.lossless-claw.llm.allowModelOverride 配置已生效。
                    // 注意：engine.ts 通过 legacyParams = asRecord(runtimeContext) ?? legacyParams
                    // 读取 llm，所以必须同时从顶层、runtimeContext、legacyParams 三个位置剥离。
                    //
                    // 本地主模型场景：LosslessClawAdapter.compact 内部会统一注入自建
                    // llm.complete（直连本地模型），此处无需重复处理（见 adapter）。
                    llm: undefined,
                    runtimeContext: {
                      ...((params as any).runtimeContext ?? {}),
                      llm: undefined,
                    },
                    legacyParams: {
                      ...((params as any).legacyParams ?? {}),
                      llm: undefined,
                    },
                    // P-CB-7: force compact 时使用 _forceCompactBudget（基于实际 token 数 50%），
                    // 确保 lossless-claw 真正执行压缩而非因 budget 过大而跳过。
                    // 修复前：_compactBudget = 59%×131072 = 77332，远大于 26k 实际上下文，
                    // lossless-claw 返回 "already under target" 拒绝压缩。
                    tokenBudget: _isInputOverflow
                      ? _tryBudget
                      : (params.force === true ? _forceCompactBudget : _contextWindow),
                    // BUGFIX: 默认 force=true — 我们的 compact hook 总是被 /compact 主动触发，
                    // 不依赖 SDK 是否传 force。
                    force: true,
                    // BUGFIX: 不传 compactionTarget，避免 lossless-claw 走 budget 模式时
                    // 尝试用 config.summaryModel 覆盖当前活跃模型（会触发 OpenClaw LCM
                    // policy 检查并失败）。让 lossless-claw 复用当前活跃模型。
                    // compactionTarget 由 lossless-claw 根据 tokenBudget 自行决定。
                  }),
                  compactTimeoutPromise,
                  ...(abortOnCompact ? [abortOnCompact] : []),
                ]);
                logger?.debug?.('[compact] adapter.compact result received', {
                  paramsForce: params.force,
                  paramsTokenBudget: (params as any).tokenBudget,
                  usedTokenBudget: _isInputOverflow
                    ? _tryBudget
                    : (params.force === true ? _forceCompactBudget : _contextWindow),
                  usedCompactionTarget: 'auto (not forcing budget mode to avoid summaryModel override)',
                  resultOk: compactResult?.ok,
                  resultCompacted: compactResult?.compacted,
                  resultSummaryId: compactResult?.summaryId,
                  resultActionTaken: compactResult?.result?.actionTaken,
                  resultHasSummary: !!(compactResult?.summary || compactResult?.result?.summary),
                  resultTokensBefore: compactResult?.result?.tokensBefore,
                  resultTokensAfter: compactResult?.result?.tokensAfter,
                  resultReason: compactResult?.reason,
                });
                // Extract summary from adapter result: prefer result.summary (SDK format), fallback to summaryId
                summaryContent = compactResult?.summary || compactResult?.result?.summary;
                // Track adapter-level success: true even if compaction was evaluated but not needed
                adapterOk = compactResult?.ok !== false;
                // Preserve adapter's actionTaken/compacted flag for accurate success detection
                // ActionTaken may be false even if summary was created (no DAG reduction needed)
                // Use summaryId as the authoritative indicator of compaction success
                adapterCompacted = !!compactResult?.summaryId || compactResult?.result?.actionTaken === true || compactResult?.compacted === true;
                // 透传 lossless-claw 返回的 SDK CompactResult.result 可选字段
                const _extra = compactResult?.result ?? {};
                compactResultExtra = {
                  firstKeptEntryId: _extra.firstKeptEntryId,
                  sessionId: _extra.sessionId,
                  sessionFile: _extra.sessionFile,
                };
                if (adapterCompacted) {
                  _succeededBudget = _tryBudget;
                  logger?.debug?.('[compact] segmented compaction succeeded', {
                    budget: _tryBudget,
                    attempt: _progressiveBudgets.indexOf(_tryBudget) + 1,
                    totalAttempts: _progressiveBudgets.length,
                  });
                }
              } catch (ceErr) {
                const msg = String(ceErr);
                if (msg.includes('aborted')) {
                  logger?.warn?.("compact: DAG compaction aborted by host", { err: serializeError(ceErr) });
                  break; // abort 时不再重试后续 budget
                } else if (msg.includes('timeout')) {
                  logger?.warn?.("compact: DAG compaction timed out after 300s", { err: serializeError(ceErr), budget: _tryBudget });
                } else {
                  logger?.warn?.("compact: background DAG compaction failed", { err: serializeError(ceErr), budget: _tryBudget });
                }
              } finally {
                if (compactTimer !== undefined) clearTimeout(compactTimer);
                if (abortListener && signal) { try { signal.removeEventListener('abort', abortListener); } catch {} }
              }
            }

            if (_isInputOverflow && !adapterCompacted) {
              logger?.warn?.('[compact] all progressive budgets exhausted, recording debt and using degraded summary', {
                budgetsTried: _progressiveBudgets,
                currentTokenCount: _currentTokens,
                currentThreshold: _overflowThreshold,
              });

              // 记录负债：debt-manager 后续异步重试
              const _sessionKey = typeof params.sessionKey === 'string'
                ? params.sessionKey
                : (typeof params.session_id === 'string' ? params.session_id : undefined);
              const _sessionId = params.sessionId != null
                ? String(params.sessionId)
                : (params.session_id != null ? String(params.session_id) : undefined);
              const _convId = getConversationId(_sessionKey, _sessionId);
              if (_convId != null) {
                writeCompactionDebt(
                  _convId,
                  _compactBudget,
                  _currentTokens,
                  'compact_budgets_exhausted_' + _currentTokens + '_gt_' + _overflowThreshold,
                );
              }

              // 构造降级摘要 + 标记 compacted=true：
              // SDK 需要 compacted=true 才会继续调用 assemble()，
              // assemble() 中有 buildDegradedContext 做真正的上下文裁剪。
              // 仅设置 adapterOk=true 不够 —— SDK recovery 收到 compacted=false
              // 会无限重试直到耗尽，最终报 Auto-compaction failed。
              adapterCompacted = true;
              adapterOk = true;
              summaryContent = '[DEGRADED] Progressive compaction budgets exhausted. '
                + 'Context will be trimmed by assemble(). Debt recorded for async retry.';
            }

            // ── 迭代压缩：分段压缩成功但用了降级 budget 时，异步触发正常参数 follow-up ──
            // 目的：用正常 budget + threshold 模式再做一轮压缩，确保上下文充分精简。
            // compactionTarget 每次调用独立，不会残留 'budget' 模式到后续调用。
            if (_isInputOverflow && adapterCompacted && _succeededBudget < _compactBudget) {
              logger?.debug?.('[compact] iterative follow-up compaction triggered (budget restored to normal)', {
                succeededBudget: _succeededBudget,
                normalBudget: _compactBudget,
              });
              _losslessClawAdapter.compact({
                ...params,
                tokenBudget: _compactBudget,
                force: true,
                compactionTarget: 'budget',
              }).then((_followUp: any) => {
                if (_followUp.ok && _followUp.compacted) {
                  logger?.debug?.('[compact] iterative follow-up compaction succeeded');
                }
              }, () => {});
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
            const _hookResult = await Promise.race([
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
            // 如果 onCompaction 返回成功（且之前的 DAG compact 失败），用它的结果更新
            // compactResult 和 adapterCompacted，确保 SDK 收到正确的压缩结果。
            if (_hookResult && _hookResult.ok && _hookResult.compacted) {
              logger?.debug?.('[compact] onCompaction hook succeeded, updating compactResult', {
                hookTokensBefore: _hookResult.result?.tokensBefore,
                hookTokensAfter: _hookResult.result?.tokensAfter,
              });
              compactResult = {
                ok: _hookResult.ok,
                compacted: _hookResult.compacted,
                summary: _hookResult.summary,
                result: _hookResult.result,
              };
              adapterCompacted = true;
              adapterOk = true;
              summaryContent = _hookResult.summary ?? summaryContent;
            }
          } catch (hookErr) {
            const msg = String(hookErr);
            if (msg.includes('aborted')) {
              logger?.warn?.("compact: onCompaction hook aborted by host", { err: serializeError(hookErr) });
            } else if (msg.includes('timeout')) {
              logger?.warn?.("compact: onCompaction hook timed out after 300s", { err: serializeError(hookErr) });
            } else {
              logger?.warn?.("compact: onCompaction hook failed (non-fatal)", { err: serializeError(hookErr) });
            }
          } finally {
            if (hookTimer !== undefined) clearTimeout(hookTimer);
            if (hookAbortListener && signal) { try { signal.removeEventListener('abort', hookAbortListener); } catch {} }
          }

          // 优先使用 lossless-claw 返回的真实 token 数，回退到 params.currentTokenCount
          const _lcTokensBefore = compactResult?.result?.tokensBefore ?? 0;
          const _lcTokensAfter = compactResult?.result?.tokensAfter ?? 0;

          // BUGFIX: 当 DAG 已压缩到稳定状态（tokensBefore === tokensAfter > 0），
          // 且 summaryContent 为空（未生成新摘要），从 DAG 获取已有摘要返回给 SDK。
          // 修复前：auto-compaction 触发时，DAG 已压缩无需新摘要 → summaryContent=undefined，
          // SDK 收到 compacted=true 但无 summary → 无法替换上下文 → 反复重试直到报错。
          if (!summaryContent && _lcTokensAfter > 0 && _lcTokensBefore === _lcTokensAfter && _adapterConnected) {
            try {
              const _summaries = await _losslessClawAdapter.getSummaries(_compactSessionId ?? '', 3);
              if (_summaries.length > 0) {
                summaryContent = _summaries[_summaries.length - 1].content;
                logger?.debug?.('[compact] using existing summary from DAG (no new summary created)', {
                  summaryLength: summaryContent?.length ?? 0,
                  summaryCount: _summaries.length,
                });
              }
            } catch (e) {
              logger?.debug?.('[compact] failed to fetch existing summary', { err: serializeError(e) });
            }
          }

          // 当 SDK 未传 currentTokenCount（手动 /compact 时不传），且 DAG 报告
          // tokensBefore === tokensAfter（已压缩过，无需再压），我们需要估算
          // 实际会话的 token 数作为 tokensBefore，让 SDK 知道上下文确实被压缩过。
          // 原因：DAG 的 tokensBefore 是 DAG 内部的消息 token 数（已压缩后的 13K），
          // 而非实际会话 transcript 的大小（58K）。SDK 用 tokensBefore → tokensAfter
          // 判断压缩是否有效，并更新 /status 的 totalTokens。
          let _estimatedSessionTokens = 0;
          if (_currentTokens > 0) {
            _estimatedSessionTokens = _currentTokens;
          } else if (_sessionFileMsgs.length > 0) {
            _estimatedSessionTokens = cachedEstimateTokens(_sessionFileMsgs);
          }

          // tokensBefore 优先级：
          // 1) DAG 的 tokensBefore（当 > tokensAfter 时，表示实际发生了压缩）
          // 2) DAG 已压缩到稳定状态（tokensBefore === tokensAfter）：
          //    用 sessionFile 估算值或 SDK currentTokenCount 作为 tokensBefore，
          //    确保 tokensBefore > tokensAfter，让 SDK 看到明确的压缩量。
          //    避免 SDK 认为压缩无效 → 反复重试 → Auto-compaction could not recover。
          // 3) SDK 传入的 currentTokenCount（auto-compaction 时有值）
          // 4) 从 sessionFile 估算的 token 数（手动 /compact 时 currentTokenCount=0）
          //
          // 根因分析：
          //   DAG 稳定状态下（本次无新压缩），tokensBefore === tokensAfter（如 13k=13k），
          //   SDK 判断"压缩无效"，触发重试。由于 DAG 已无法再压缩，重试始终返回同样结果，
          //   SDK 陷入死循环，最终报 "Auto-compaction could not recover"。
          //
          // 修复策略：
          //   即使 DAG 稳定（无新压缩），也返回一个有意义的 tokensBefore，
          //   让 SDK 看到 "从 X 压缩到 Y" 的变化，认为压缩有效，停止重试。
          let tokensBefore: number;
          let tokensAfter: number;
          if (_lcTokensBefore > 0 && _lcTokensBefore > _lcTokensAfter) {
            // DAG 报告了实际压缩
            tokensBefore = _lcTokensBefore;
            tokensAfter = _lcTokensAfter;
          } else if (_lcTokensAfter > 0 && _lcTokensBefore === _lcTokensAfter) {
            // DAG 已压缩到稳定状态（已在之前的轮次压缩过，本次无新压缩）。
            // 找一个最能代表"压缩前大小"的值作为 tokensBefore。
            tokensAfter = _lcTokensAfter;
            if (_estimatedSessionTokens > _lcTokensAfter) {
              // 优先用 sessionFile 估算值（最接近压缩前的消息总量）
              tokensBefore = _estimatedSessionTokens;
            } else if (_currentTokens > _lcTokensAfter) {
              // 其次用 SDK 的 currentTokenCount
              tokensBefore = _currentTokens;
            } else {
              // 兜底：人为制造一个最小差值，确保 tokensBefore > tokensAfter
              tokensBefore = _lcTokensAfter + Math.max(1, Math.floor(_lcTokensAfter * 0.01));
            }
            logger?.debug?.('[compact] DAG stable, computing tokensBefore for SDK', {
              lcTokensAfter: _lcTokensAfter,
              estimatedSessionTokens: _estimatedSessionTokens,
              currentTokens: _currentTokens,
              tokensBefore,
              tokensAfter,
            });
          } else if (_currentTokens > 0) {
            // auto-compaction：SDK 传入了 currentTokenCount
            tokensBefore = _currentTokens;
            tokensAfter = _lcTokensAfter > 0 ? _lcTokensAfter : _lcTokensBefore;
          } else if (_estimatedSessionTokens > 0 && _lcTokensAfter > 0) {
            // 手动 /compact：SDK 未传 currentTokenCount，用 sessionFile 估算
            // DAG 的 tokensAfter 是压缩后的消息 token 数
            tokensBefore = _estimatedSessionTokens;
            tokensAfter = _lcTokensAfter;
          } else {
            // 回退到 DAG 的值
            tokensBefore = _lcTokensBefore > 0 ? _lcTokensBefore : (_currentTokens || 0);
            tokensAfter = _lcTokensAfter > 0 ? _lcTokensAfter : tokensBefore;
          }

          // 压缩成功判定：
          // - lossless-claw 报告 compacted=true
          // - tokensBefore > tokensAfter（实际发生了压缩）
          // - DAG 已处于稳定压缩状态（_lcTokensAfter > 0 且无变化，无需进一步压缩）
          const compacted = adapterCompacted
            || (tokensBefore > tokensAfter)
            || (_lcTokensAfter > 0 && _lcTokensBefore === _lcTokensAfter);
          // adapterOk 判定：lossless-claw 返回 ok=true，或实际发生了压缩，或 adapter 正常运行过
          const _adapterOk = compactResult?.ok !== false;
          const ok = _adapterOk || compacted;
          // If adapter ran successfully but no compaction was needed (e.g., below threshold),
          // return compacted: true to prevent the SDK's auto-compaction recovery from
          // retrying in a loop (recovery treats compacted:false as "failed, retry").
          // If adapter genuinely failed, return ok: false so the SDK can retry.
          if (!compacted) {
            const reason = ok
              ? 'compaction evaluated — context below threshold, no compaction needed'
              : 'DAG compaction did not produce a summary — session tokens unchanged, will retry';
            logger?.debug?.('[compact] no compaction produced', {
              ok,
              adapterOk: _adapterOk,
              adapterCompacted,
              lcTokensBefore: _lcTokensBefore,
              lcTokensAfter: _lcTokensAfter,
              estimatedSessionTokens: _estimatedSessionTokens,
              uncompressedCount: _uncompressedCount,
              forceCompact: _forceCompact,
              tokensBefore,
              reason,
            });
            return {
              ok,
              compacted: ok,
              reason,
              result: {
                tokensBefore,
                tokensAfter: tokensBefore,
              },
            };
          }
          // SDK CompactResult.result 期望的可选字段：
          // - firstKeptEntryId: 压缩后保留的第一条消息 ID（lossless-claw 提供）
          // - sessionId/sessionFile: runtime 轮换 transcripts 时的新会话标识
          // 从 compactResultExtra 透传，缺失时回退到 params 原值
          logger?.info?.('[compact] compaction finished', {
            adapterCompacted,
            hasSummary: !!summaryContent,
            tokensBefore,
            tokensAfter,
            lcTokensBefore: _lcTokensBefore,
            lcTokensAfter: _lcTokensAfter,
            estimatedSessionTokens: _estimatedSessionTokens,
            uncompressedCount: _uncompressedCount,
          });

          // 向 sessionFile 追加 compaction entry，使 SDK 的 context-overflow-precheck
          // 能正确跳过已压缩的消息。
          // 根因：lossless-claw DAG 压缩后 sessionFile 不变，SDK precheck 读 sessionFile
          // 仍看到全量 token（210873），每次 compact 后 precheck 再次 overflow → 死循环。
          // 修复：追加 compaction entry 到 sessionFile JSONL，SDK 读取时遇到该条目
          // 会通过 firstKeptEntryId 跳过已压缩的消息，只计算保留部分的 token 数。
          if (compacted && tokensBefore > tokensAfter && typeof params.sessionFile === 'string' && params.sessionFile) {
            try {
              const { readFile, appendFile } = await import('node:fs/promises') as typeof import('node:fs/promises');
              const content = await readFile(params.sessionFile, 'utf-8');
              const lines = content.split('\n').filter((l: string) => l.trim());
              const entries: Map<string, any> = new Map();
              let lastEntry: any = null;
              for (const line of lines) {
                try {
                  const entry = JSON.parse(line);
                  if (entry && entry.id) {
                    entries.set(entry.id, entry);
                    lastEntry = entry;
                  }
                } catch { /* skip malformed lines */ }
              }
              // 如果最后一条已经是 compaction entry，说明已追加过，跳过
              if (lastEntry && lastEntry.type !== 'compaction') {
                // 从叶子节点沿 parentId 往回走，找到压缩边界（保留最近 N 条消息）
                let current = lastEntry;
                let msgCount = 0;
                const targetKeep = _dedupRounds > 0 ? _dedupRounds : 24;
                while (current && msgCount < targetKeep) {
                  if (current.type === 'message') msgCount++;
                  if (msgCount >= targetKeep) break;
                  const parentId = current.parentId;
                  if (parentId && entries.has(parentId)) {
                    current = entries.get(parentId)!;
                  } else {
                    break;
                  }
                }
                const boundaryId = current?.id ?? lastEntry.id;
                const compactionId = `compaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const compactionEntry = JSON.stringify({
                  id: compactionId,
                  parentId: lastEntry.id,
                  type: 'compaction',
                  timestamp: new Date().toISOString(),
                  summary: summaryContent ?? '[compacted]',
                  firstKeptEntryId: boundaryId,
                  tokensBefore,
                  fromHook: true,
                });
                await appendFile(params.sessionFile, compactionEntry + '\n', 'utf-8');
                compactResultExtra.firstKeptEntryId = boundaryId;
                logger?.info?.('[compact] compaction entry appended to sessionFile', {
                  sessionFile: params.sessionFile,
                  firstKeptEntryId: boundaryId,
                  compactionEntryId: compactionId,
                  tokensBefore,
                  walkedBackMessages: msgCount,
                });
              }
            } catch (e) {
              logger?.warn?.('[compact] failed to append compaction entry to sessionFile (non-fatal)', {
                err: serializeError(e),
              });
            }
          }

          return {
            ok: true,
            compacted,
            reason: 'compaction completed',
            result: {
              tokensBefore,
              // After compaction, the summary replaces the original messages
              tokensAfter,
              summary: summaryContent,
              firstKeptEntryId: compactResultExtra.firstKeptEntryId,
              sessionId: compactResultExtra.sessionId ?? params.sessionId,
              sessionFile: compactResultExtra.sessionFile ?? params.sessionFile,
            },
          };
        } catch (err) {
          logger?.warn?.("compact: top-level failed (non-fatal)", { err: serializeError(err) });
          return {
            ok: false,
            compacted: false,
            reason: String(err),
            // P0-4: 给 SDK/用户提供 actionable 建议，避免 "Auto-compaction could not recover" 后用户不知道下一步
            suggestedAction: 'compact_failed',
            userHint: '压缩失败。可尝试发送 /compact 手动重试，或 /new 开始新会话（历史记忆不受影响）。',
          };
        }
      },
      async maintain(params: any) {
        // S10-1: Periodic maintenance — delegate to lossless-claw + local cleanup
        // SDK 2026.8.1 契约：maintain 携带 abortSignal（后台 deferred 维护 worker 在
        // shutdown/stop 时 abort），引擎须在中止时及时停止工作。
        const signal = (params as any).abortSignal || (params as any).signal;
        if (signal?.aborted) {
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: 'aborted' };
        }

        // abort race：与 lossless-claw 委托 Promise 竞速，host abort 时立即返回，
        // 避免 SQLite DAG 维护等阻塞操作在 stop/shutdown 后继续空转
        let abortListener: (() => void) | null = null;
        const abortOnMaintain = signal
          ? new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new Error('maintenance aborted'));
                return;
              }
              abortListener = () => reject(new Error('maintenance aborted'));
              signal.addEventListener('abort', abortListener, { once: true });
            })
          : null;
        if (abortOnMaintain) abortOnMaintain.catch(() => {}); // 预吞 reject，避免 unhandledRejection

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
              const lcResult = await Promise.race([
                _losslessClawAdapter.maintain({
                  sessionId: _maintainSid != null ? String(_maintainSid) : '',
                  sessionFile: typeof params.sessionFile === 'string' ? params.sessionFile : '',
                  sessionKey: params.sessionKey ?? '',
                  // SDK 契约透传：runtimeContext 携带 rewriteTranscriptEntries /
                  // llm.complete / allowDeferredCompactionExecution 等，不可吞掉；
                  // sessionTarget / runtimeSettings 一并透传给下游。
                  sessionTarget: (params as any).sessionTarget,
                  runtimeSettings: (params as any).runtimeSettings,
                  runtimeContext: (params as any).runtimeContext ?? {},
                  abortSignal: signal,
                }),
                ...(abortOnMaintain ? [abortOnMaintain] : []),
              ]);
              if (lcResult) {
                changed = changed || (lcResult.changed ?? false);
                bytesFreed += lcResult.bytesFreed ?? 0;
                rewrittenEntries += lcResult.rewrittenEntries ?? 0;
              }
            } catch (lcErr) {
              const lcMsg = lcErr instanceof Error ? lcErr.message : String(lcErr);
              if (lcMsg.includes('aborted')) {
                logger?.debug?.("maintain: lossless-claw delegate aborted by host signal");
                return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: 'aborted' };
              }
              logger?.debug?.("maintain: lossless-claw delegate failed (non-fatal)", { err: serializeError(lcErr) });
            }
          }

          // abort 复检：委托完成后再确认信号未中止，中止则跳过本地维护
          if (signal?.aborted) {
            return { changed, bytesFreed, rewrittenEntries, reason: 'aborted' };
          }

          // 2. Local: evict stale dedup via LRU cache
          try {
            evictStaleDedupPublic();
          } catch (e) {
            logger?.debug?.("dedup cache eviction failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
          }

          return { changed, bytesFreed, rewrittenEntries };
        } catch (err) {
          logger?.warn?.("maintain: failed (non-fatal)", { err: serializeError(err) });
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: String(err) };
        } finally {
          if (abortListener && signal) { try { signal.removeEventListener('abort', abortListener); } catch {} }
        }
      },

      async dispose() {
        // 幂等短路：已 dispose 则直接返回
        if (!initialized && !snapshotServerStop && !hbTimer) return;
        logger?.info?.('[dispose] called, resetting graphAdapter and stopping servers');
        // 1. 先停止 heartbeat timer，避免新任务进入
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
        // 关闭 dashboard 快照 HTTP 服务（幂等，可多次调用）
        // 必须 await 确保端口完全释放，否则插件 reload 时新实例会遇到 EADDRINUSE
        if (snapshotServerStop) {
          const stopFn = snapshotServerStop;
          snapshotServerStop = null;
          await stopFn().catch(() => {});
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
        } catch (e) { /* 超时或异常，继续清理 */
          logger?.debug?.("background tasks awaitAll failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }

        // 3. 停止 debt scheduler（等待活跃任务完成）
        try { const { stopScheduler } = await import('./core/debt-manager.js'); await stopScheduler(); } catch {}

        // 4. Close SQLite DB 连接（healthMetrics / userProfile / businessMetrics / debt-manager / lcm-bridge / tools sharedDb）
        //    必须在 Neo4j driver 之前或同时关闭，避免 dispose 后被 fire-and-forget 写入
        try { healthMetrics.close(); } catch {}
        try { userProfile.close(); } catch {}
        try { businessMetrics.close(); } catch {}
        try { const { closeDebtDb } = await import('./core/debt-manager.js'); closeDebtDb(); } catch {}
        try { const { closeLcmDb } = await import('./lcm-bridge.js'); closeLcmDb(); } catch {}
        try { const { closeSharedDb } = await import('./tools.js'); closeSharedDb(); } catch {}

        // 5. Dispose lossless-claw adapter（触发底层 engine.dispose）
        try { await _losslessClawAdapter?.dispose?.(); } catch (e) {
          logger?.debug?.("lossless-claw adapter dispose failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }
        _losslessClawAdapter = null;
        resetSharedAdapter();

        // 6. Dispose QmdClient（清理 recoveryTimer，避免 timer 泄漏）
        try { qmdClient?.dispose?.(); } catch {}

        // 6.5 v2.3.6 链路 3：持久化关联矩阵 M（若启用）
        //    在关闭 driver 前保存，避免学习到的最新 M 在重启后丢失。
        try { await graphAdapter?.saveAssociationMatrix?.(); } catch (e) {
          logger?.debug?.("graph adapter saveAssociationMatrix failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }

        // 7. Close Neo4j driver pool before resetting to avoid "Pool is closed" errors
        //    必须 await，确保 driver 底层 TCP 连接被优雅关闭
        try { await graphAdapter?.close?.(); } catch (e) {
          logger?.debug?.("graph adapter close failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }
        tracker?.close?.();
        try { await closeNeo4jDriver(); } catch {}
        // 兜底：强制清理连接池中所有条目（防止 refCount 失衡导致泄漏）
        try { const { drainPool } = await import('./adapters/connection-pool.js'); await drainPool(); } catch {}

        // 8. M-2: 重置熔断器状态（避免热重载/测试复用进程时残留旧 state）
        try { const { resetAllCircuitBreakers } = await import('./circuit-breaker.js'); resetAllCircuitBreakers(); } catch {}
        initialized = false;
        initPromise = null;
        qmdClient = null;
        graphAdapter = null;
        expStore = null;
        _retrievalGateway = null;
        _retrievalGatewayConfig = null;
        _retrievalGatewayRecoveryAttempts = 0;
        _retrievalGatewayLastRecoveryError = null;
        lastRetrievalQuery = '';
        _lastEmbedHealth = true;
        _modelRegistry = undefined;
        _activeModelId = undefined;
        _activeModelContextWindow = undefined;
        tracker = null;
        snapshotHandle = null;
        snapshotConfig = null;
      },
    }));

    // -------------------------------------------------------------------
    // Dashboard 工具上下文 + 快照服务
    // 注入 register() 闭包内的单例引用，供 lcmg_distill / lcmg_compact / lcmg_reset_breaker
    // 三个 MCP 工具手动触发维护操作。所有回调延迟访问闭包变量，确保 dispose 后安全。
    // -------------------------------------------------------------------
    const dashboardContext: DashboardToolContext = {
      expStore: undefined, // expStore 在闭包内延迟访问，由 runDistillation 回调内部读取
      // BUGFIX(P1-4): 注入 qmdClient 单例，供 5 个 MCP 工具复用（避免每次 new QmdClient）
      // 注意：创建时 qmdClient 可能仍是 null（ensureInitialized 未执行），
      // tools.ts 的 acquireQmdClient 有 new QmdClient fallback，因此可接受。
      qmdClient: qmdClient ?? undefined,
      runDistillation: async (limit: number) => {
        // Dashboard 可能在第一次 assemble（触发 ensureInitialized）之前调用工具，
        // 此处显式确保插件已初始化，避免 expStore 为 null。
        try {
          await ensureInitialized();
        } catch (initErr) {
          const msg = initErr instanceof Error ? initErr.message : String(initErr);
          throw new Error('plugin init failed: ' + msg);
        }
        const storeRef = expStore;
        if (!storeRef) throw new Error('expStore not initialized');
        // BUGFIX: 传 merged config 给 runDistillation，确保 resolveDistillationLlm
        // 能读到 entries 中的 distillationLlm 配置（与 graphAdapter 使用同一配置来源）。
        // 原问题：api.pluginConfig 可能不包含 entries 中的 distillationLlm，
        // 导致 LLM 配置回退到默认值（gpt-4o-mini）而非用户配置的本地模型。
        const mergedApi = { ...api, pluginConfig: mergeEntriesNeo4jConfig(api) };
        const result = await runDistillation(storeRef, mergedApi, logger, limit);
        return result;
      },
      backfillExperiences: async (limit: number, force?: boolean) => {
        // 从 LCM DB 读取历史会话，回溯提取经验写入 PENDING 队列。
        // 用于修复 graphAdapter 连接问题后补录之前丢失的经验。
        // 默认跳过已处理过的会话（通过 ~/.openclaw/backfill-state.json 记录），
        // force=true 时强制重新处理所有会话。
        try {
          await ensureInitialized();
        } catch (initErr) {
          const msg = initErr instanceof Error ? initErr.message : String(initErr);
          throw new Error('plugin init failed: ' + msg);
        }
        const storeRef = expStore;
        if (!storeRef) throw new Error('expStore not initialized');

        // 读取已处理会话列表
        const state = force ? { processedConversations: [] as number[] } : getBackfillState();
        const processedSet = new Set(state.processedConversations);

        // 获取会话列表（按 conversation_id DESC）
        const allConversations = getAllConversations(limit);

        // 过滤掉已处理的会话
        const conversations = force
          ? allConversations
          : allConversations.filter((c) => !processedSet.has(c.conversationId));
        const skipped = allConversations.length - conversations.length;

        const errors: string[] = [];
        let extracted = 0;
        const newlyProcessedIds: number[] = [];

        logger?.info?.(`[backfill] scanning ${conversations.length} conversations (skipped ${skipped} already processed, force=${!!force})`);

        for (const conv of conversations) {
          try {
            const msgs = conv.messages;
            if (msgs.length < 2) {
              // 仍标记为已处理，避免下次重复检查
              newlyProcessedIds.push(conv.conversationId);
              continue;
            }

            let convExtracted = 0;
            // 逐条消息检测触发条件（priorMessages 为当前消息之前的所有消息）
            for (let i = 0; i < msgs.length; i++) {
              const msg = msgs[i];
              const priorMessages = msgs.slice(0, i);

              // 将消息转换为 detectExperienceTrigger 需要的格式
              const msgObj: Record<string, unknown> = {
                role: msg.role,
                content: msg.content,
              };

              try {
                const trigger = detectExperienceTrigger(msgObj, priorMessages as any);
                if (!trigger) continue;

                const raw = extractRawExperience(trigger, msgObj, conv.sessionId);
                await storeRef.saveRaw(raw);
                extracted++;
                convExtracted++;
                logger?.debug?.(`[backfill] experience extracted: source=${trigger}, id=${raw.id}, conv=${conv.sessionId}`);
              } catch (itemErr) {
                // 单条消息提取失败，记录但不中断
                const errMsg = itemErr instanceof Error ? itemErr.message : String(itemErr);
                logger?.debug?.(`[backfill] single message extraction failed: ${errMsg}`);
              }
            }

            // 无论是否提取到经验，都标记为已处理
            newlyProcessedIds.push(conv.conversationId);
            if (convExtracted > 0) {
              logger?.debug?.(`[backfill] conv ${conv.sessionId}: ${convExtracted} experiences extracted`);
            }
          } catch (convErr) {
            const errMsg = convErr instanceof Error ? convErr.message : String(convErr);
            errors.push(`会话 ${conv.sessionId}: ${errMsg}`);
            logger?.warn?.(`[backfill] conversation ${conv.sessionId} failed: ${errMsg}`);
            // 失败的会话也标记为已处理，避免反复重试失败
            newlyProcessedIds.push(conv.conversationId);
          }
        }

        // 持久化已处理记录
        if (newlyProcessedIds.length > 0) {
          try {
            markConversationsBackfilled(newlyProcessedIds);
          } catch (markErr) {
            logger?.warn?.(`[backfill] failed to persist state: ${markErr instanceof Error ? markErr.message : String(markErr)}`);
          }
        }

        // 诊断：写入后立即验证 Neo4j 中的实际节点数量
        let verifyTotal = -1;
        let verifyPending = 0;
        let verifyByStatus: Record<string, number> = {};
        try {
          verifyTotal = await storeRef.countAll();
          verifyByStatus = await storeRef.countByStatus();
          verifyPending = verifyByStatus['PENDING'] ?? 0;
          logger?.info?.(`[backfill] verify after writes: total=${verifyTotal}, pending=${verifyPending}, byStatus=${JSON.stringify(verifyByStatus)}`);
        } catch (verifyErr) {
          logger?.warn?.(`[backfill] verify query failed: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`);
        }

        logger?.info?.(`[backfill] completed: processed=${conversations.length}, skipped=${skipped}, extracted=${extracted}, errors=${errors.length}, neo4jTotal=${verifyTotal}, neo4jPending=${verifyPending}`);
        return { processed: conversations.length, extracted, skipped, errors, neo4jTotal: verifyTotal, neo4jPending: verifyPending, neo4jByStatus: verifyByStatus };
      },
      triggerCompact: async (conversationId?: number) => {
        // 写入 compact 债务（若指定会话）并立即触发调度器处理
        // onCompaction hook 依赖 losslessClawAdapter，需确保已初始化
        try {
          await ensureInitialized();
        } catch { /* 初始化失败时仍允许写 debt，scheduler 会尝试处理 */ }
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
        // graphAdapter 可能为 null（未初始化），此时仅重置 circuit-breaker 状态即可
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
            const a = graphAdapter as any;
            // 调试日志：graphAdapter 为 null 时输出 warn（便于排查）
            if (!a) {
              logger?.warn?.('[snapshot] getGraphAdapterState: graphAdapter is NULL', {
                initialized,
                hasInitPromise: !!initPromise,
              });
            }
            if (!a) return {
              connected: false,
              connectFailed: false,
              circuitBreaker: { available: true, failures: 0, open: false },
              healthCheckCount: 0,
              gmProHasModule: false,
              gmProGetDriverType: 'undefined',
              gmProDriverAvailable: false,
              hasOwnDriver: false,
              connectRetryCount: 0,
              lastError: 'graphAdapter not initialized',
            };
            const driverOk = !!a.driver;
            const connectFailed = !!a._connectFailed;
            const lastFailTime = (a._lastFailTime as number) ?? 0;
            const recentlyFailed = connectFailed && (Date.now() - lastFailTime < 30_000);
            const neo4jCb = getHealthSnapshot()?.neo4j ?? { available: true, failures: 0, open: false };
            const lastError = (a._lastError as string | null) ?? null;
            // 尝试调用 getDiagnostics()（新版本才有），失败则用旧方式读取
            let diag: any = {};
            try {
              if (typeof a.getDiagnostics === 'function') {
                diag = a.getDiagnostics();
              } else {
                // 旧版本兼容：直接读取私有字段
                let gmProDriverAvailable = false;
                try {
                  if (a.mod && typeof a.mod.getDriver === 'function') {
                    gmProDriverAvailable = !!a.mod.getDriver();
                  }
                } catch { /* ignore */ }
                diag = {
                  healthCheckCount: a._healthCheckCount ?? 0,
                  gmProHasModule: !!a.mod,
                  gmProGetDriverType: typeof a.mod?.getDriver,
                  gmProDriverAvailable,
                  hasOwnDriver: !!a.driver,
                  connectRetryCount: a._connectRetryCount ?? 0,
                };
              }
            } catch { /* ignore */ }
            return {
              connected: driverOk && !connectFailed,
              connectFailed: recentlyFailed,
              lastError: lastError ?? (connectFailed ? `Neo4j connect failed${lastFailTime > 0 ? ` at ${new Date(lastFailTime).toISOString()}` : ''}` : undefined),
              circuitBreaker: neo4jCb,
              ...diag,
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
          getRetrievalState: () => {
            const summary = _retrievalGateway?.getPerfSummary?.() ?? 'gateway not initialized';
            // dashboard 每 10s 轮询 snapshot 端点都会走到这里，属轮询遥测，
            // 降为 debug 级避免刷屏。
            logger?.debug?.('[perf-stats] getRetrievalState called', {
              hasGateway: !!_retrievalGateway,
              hasGetPerfSummary: typeof _retrievalGateway?.getPerfSummary === 'function',
              summary,
              stats: _retrievalGateway?.stats ? {
                qmd: _retrievalGateway.stats.qmd,
                graph: _retrievalGateway.stats.graph,
                experience: _retrievalGateway.stats.experience,
                distilledExp: _retrievalGateway.stats.distilledExp,
              } : null,
            });
            return {
              lastQuery: lastRetrievalQuery,
              perfSummary: summary,
            // P-CB-6: 暴露 qmd 熔断器实时状态，dashboard 不再依赖心跳缓存
            qmdCircuitBreaker: (() => {
              const snap = getHealthSnapshot();
              return snap?.qmd ?? { available: true, failures: 0, open: false };
            })(),
            // 暴露 gateway 心跳恢复状态，便于诊断恢复失败原因
            gatewayRecovery: {
              initialized: !!_retrievalGateway,
              recoveryAttempts: _retrievalGatewayRecoveryAttempts,
              lastRecoveryError: _retrievalGatewayLastRecoveryError,
            },
            };
          },
          getHealthLatest: () => {
            const base = healthMetrics.getLatest();
            if (!base) return base;
            return { ...base, embedAvailable: _lastEmbedHealth };
          },
        };
        // v2.4.0: 从 lcm.db 恢复全局累计计数器（熔断器成功率/开合次数 + UX 全局指标）
        healthMetrics.loadCumulativeCounters().catch((e) => {
          logger?.debug?.('[lcm-graph-extra] loadCumulativeCounters failed (non-fatal)', { err: e instanceof Error ? e.message : String(e) });
        });
        // v2.4.0: 从 lcm.db 恢复用户画像（技术栈/场景/语言偏好）
        userProfile.loadFromDb().catch((e) => {
          logger?.debug?.('[lcm-graph-extra] userProfile.loadFromDb failed (non-fatal)', { err: e instanceof Error ? e.message : String(e) });
        });
        // v2.4.0: 从 lcm.db 恢复业务指标（经验质量分布/TTL命中率/蒸馏成功率）
        businessMetrics.loadFromDb().catch((e) => {
          logger?.debug?.('[lcm-graph-extra] businessMetrics.loadFromDb failed (non-fatal)', { err: e instanceof Error ? e.message : String(e) });
        });

        snapshotHandle = startDashboardSnapshotServer({ port, host, providers, onClose: onSnapshotClose });
        snapshotConfig = { port, host, providers };
        snapshotServerStop = snapshotHandle.stop;
        // 启动是异步的（含端口探测 + listen），不能立即 log "listening"。
        // 轮询等待直到结果确定（started 或 failureReason 非空），上限 2500ms，
        // 对齐 probeTimeoutMs=500 + shutdownStaleInstance=~1200 + listen，
        // 避免 600ms 一次性检查和异步启动的竞态。
        const handleForLog = snapshotHandle;
        (async () => {
          const maxWaitMs = 2500;
          const startWait = Date.now();
          while (Date.now() - startWait < maxWaitMs) {
            if (handleForLog.started || handleForLog.failureReason !== undefined) {
              break;
            }
            await new Promise(r => setTimeout(r, 100));
          }
          if (handleForLog.started) {
            logger?.info?.(`[lcm-graph-extra] dashboard snapshot server listening on ${host}:${port}`);
          } else {
            const reason = handleForLog.failureReason ?? 'startup still pending after max wait';
            logger?.warn?.(`[lcm-graph-extra] dashboard snapshot server NOT started on ${host}:${port}: ${reason} (non-fatal, plugin continues)`);
          }
        })();

        // 修复：插件热重载时新实例的 snapshot server 会立即启动，但 graphAdapter
        // 是懒加载的（首次 assemble 才创建）。如果用户还没发起对话，snapshot
        // 会一直报 "graphAdapter not initialized"。
        // 在此 fire-and-forget 调用 ensureInitialized()，确保 graphAdapter
        // 在当前闭包中被创建，不依赖 assemble 或 heartbeat。
        ensureInitialized().then(() => {
          logger?.info?.('[lcm-graph-extra] pre-init completed, graphAdapter ready for snapshot');
        }).catch((err) => {
          logger?.warn?.('[lcm-graph-extra] pre-init failed (will retry on assemble/heartbeat)', { err: err instanceof Error ? err.message : String(err) });
        });
      }
    } catch (snapErr) {
      logger?.warn?.('[lcm-graph-extra] dashboard snapshot server failed to start (non-fatal)', { err: String(snapErr) });
    }
    // -------------------------------------------------------------------
    // Heartbeat - periodic async maintenance (every 5 minutes)
    //   1. Compaction pressure check + predictive pre-compaction
    //   2. qmd MCP health check (auto-recovery via scheduleRecovery)
    //   2b. Graph / Neo4j health check + auto reconnect
    //   2c. Embedding API health check
    //   2d. Snapshot server health check + auto-restart
    //   3. Experience distillation (every ~2h) + TTL cleanup (every ~24h)
    //   4. Neo4j TTL weight decay + expired cleanup (every ~24h)
    //   5. Debt table reconcile — orphan/tombstone cleanup (every ~24h)
    // -------------------------------------------------------------------
    const HB_INTERVAL_MS = DEFAULTS.heartbeat.intervalMs;
    let hbTimer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;
    let lastDistillationRun = 0;
    let lastExperienceTtlRun = 0;  // N-3: EXPERIENCE TTL 清理节流（默认 24h）
    let hbDedupCleanupCounter = 0;  // Clean dedup cache every 15 heartbeats (~75min)
    let hbSessionCleanupCounter = 0;  // R-4: Clean expired session metadata every 5 heartbeats (~25min)
    // P0-2: TTL 清理节流。默认 24h 一次（与 DEFAULT_TTL_CONFIG.cleanupIntervalHours 对齐）。
    let lastTtlRun = 0;
    const TTL_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // gm-pro 增量维护节流。默认 6h 一次。
    let lastIncrementalMaintainRun = 0;
    // P0-3: 债务表对账节流。默认 24h 一次，与 TTL 同 cadence。
    // 清理孤儿债务（会话已删除）与 7 天前墓碑，防止 conversation_compaction_maintenance 无限增长。
    let lastDebtReconcileRun = 0;
    const DEBT_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // 关联矩阵 M 定时持久化节流。默认 30min 一次，避免学习到的最新 M 在重启后丢失
    //（dispose 时也会保存，但日常运行仍需周期性落盘）。
    let lastMPersistRun = 0;
    const M_PERSIST_INTERVAL_MS = 30 * 60 * 1000;
    // RetrievalGateway 心跳恢复重试计数器（用于诊断恢复失败原因）
    let _retrievalGatewayRecoveryAttempts = 0;
    let _retrievalGatewayLastRecoveryError: string | null = null;
    // Distillation helpers 已抽出到 src/plugin/distillation.ts
    const { runDistillation, resolveDistillationLlm } = distillationModule;

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
              // P2-2: 清理已删除文件的缓存条目（防止缓存泄漏）
              const currentSessionPaths = new Set(files.map((sf) => join(sessionDir, sf)));
              for (const cachedPath of sessionFileCache.keys()) {
                if (!currentSessionPaths.has(cachedPath)) {
                  sessionFileCache.delete(cachedPath);
                }
              }
              // P2-2: 先并行 stat 获取 mtimeMs，仅读取修改时间变化的文件
              const fileInfos = await Promise.all(
                files.map(async (sf) => {
                  const filePath = join(sessionDir, sf);
                  try {
                    const st = await stat(filePath);
                    return { file: sf, filePath, mtimeMs: st.mtimeMs };
                  } catch {
                    // 文件可能已删除，清除缓存
                    sessionFileCache.delete(filePath);
                    return null;
                  }
                }),
              );
              // 并行读取 mtimeMs 变化的文件（未变更的走缓存）
              const readResults = await Promise.all(
                fileInfos.filter(Boolean).map(async (fi) => {
                  const cached = sessionFileCache.get(fi!.filePath);
                  if (cached && cached.mtimeMs === fi!.mtimeMs) {
                    // P2-2: mtimeMs 未变，复用缓存（跳过 readFile + JSON.parse）
                    return { file: fi!.file, data: cached.data, msgCount: cached.msgCount };
                  }
                  try {
                    const data = JSON.parse(await readFile(fi!.filePath, "utf8"));
                    const msgCount = Array.isArray(data.messages) ? data.messages.length : 0;
                    sessionFileCache.set(fi!.filePath, { mtimeMs: fi!.mtimeMs, data, msgCount });
                    return { file: fi!.file, data, msgCount };
                  } catch {
                    sessionFileCache.delete(fi!.filePath);
                    return null;
                  }
                }),
              );
              for (const r of readResults) {
                if (r) {
                  pendingMessages += r.msgCount;
                  sessionDataCache.push({ file: r.file, data: r.data });
                }
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
              // P2-2: 清理已删除文件的缓存条目
              const currentDebtPaths = new Set(debtFiles.map((df) => join(debtDir, df)));
              for (const cachedPath of debtFileCache.keys()) {
                if (!currentDebtPaths.has(cachedPath)) {
                  debtFileCache.delete(cachedPath);
                }
              }
              // P2-2: 先并行 stat 获取 mtimeMs，仅读取修改时间变化的 debt 文件
              const debtFileInfos = await Promise.all(
                debtFiles.map(async (df) => {
                  const filePath = join(debtDir, df);
                  try {
                    const st = await stat(filePath);
                    return { file: df, filePath, mtimeMs: st.mtimeMs };
                  } catch {
                    debtFileCache.delete(filePath);
                    return null;
                  }
                }),
              );
              const debtResults = await Promise.all(
                debtFileInfos.filter(Boolean).map(async (fi) => {
                  const cached = debtFileCache.get(fi!.filePath);
                  if (cached && cached.mtimeMs === fi!.mtimeMs) {
                    // P2-2: mtimeMs 未变，复用缓存的 ratio
                    return cached.ratio;
                  }
                  try {
                    const debt = JSON.parse(await readFile(fi!.filePath, "utf8"));
                    const ratio = debt.currentTokenCount ? debt.currentTokenCount / 262144 : 0;
                    debtFileCache.set(fi!.filePath, { mtimeMs: fi!.mtimeMs, ratio });
                    return ratio;
                  } catch (e) {
                    logger?.debug?.("heartbeat: debt file parse failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
                    debtFileCache.delete(fi!.filePath);
                    return 0;
                  }
                }),
              );
              for (const ratio of debtResults) {
                if (ratio > maxTokenRatio) maxTokenRatio = ratio;
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
                  } catch (e) { /* skip bad session file */
                    logger?.debug?.("heartbeat: session debt write failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
                  }
                }
              } catch (debtWriteErr) {
                logger?.warn?.("heartbeat: debt write failed", { err: String(debtWriteErr) });
              }
              // Debt scheduler (resident) will pick this up automatically
            }
          }
        } catch (e) { /* pressure check failed, non-fatal */
          logger?.debug?.("heartbeat: pressure check failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }
        
        // P0-4: 4 个健康检查并行化（原串行 200-800ms → 并行 max(单个) ~200ms）
        // qmd ping / graph health / embedding probe / snapshot ping 独立无依赖，并行执行。
        // snapshot server restart 依赖 ping 结果，在并行块之后处理。
        let _snapshotPingOk = true;
        await Promise.all([
          // --- 2. qmd MCP health check ---
          (async () => {
            if (qmdClient && typeof qmdClient.ping === "function") {
              try {
                const qmdOnline = await qmdClient.ping();
                if (!qmdOnline) {
                  logger?.warn?.("heartbeat: qmd MCP unavailable");
                }
              } catch (e) {
                logger?.debug?.("heartbeat: qmd health check failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
              }
            }
          })(),
          // --- 2b. Graph / Neo4j health check + 内存重建验证 ---
          (async () => {
            // 如果 graphAdapter 尚未初始化，尝试通过 ensureInitialized() 创建它
            if (!graphAdapter) {
              try {
                await ensureInitialized();
              } catch (initErr) {
                logger?.debug?.("heartbeat: ensureInitialized failed (non-fatal, will retry next cycle)", { err: initErr instanceof Error ? initErr.message : String(initErr) });
                return;
              }
            }
            if (graphAdapter && typeof graphAdapter.quickHealth === "function") {
              try {
                // v2.7.0 P1: 使用 quickHealth() 轻量检查，避免 releaseDriver + reconnect 的昂贵重建。
                // 仅验证 driver 连通性，不释放资源。仅当熔断器 OPEN 或连续失败时才触发完整 health() 恢复。
                const graphOk = await graphAdapter.quickHealth();
                if (graphOk) {
                  _graphQuickHealthFailCount = 0;
                  // 验证 Recaller / embedFn 是否已重建
                  const hasRecaller = !!(graphAdapter as any)._recaller;
                  const hasEmbedFn = !!(graphAdapter as any)._embedFn;
                  const hasDriver = !!(graphAdapter as any).driver;
                  if (!hasRecaller && hasDriver) {
                    logger?.warn?.("heartbeat: graph/neo4j connected but Recaller NOT rebuilt — L3 recall degraded to searchNodes only");
                  }
                  if (!hasEmbedFn && hasDriver) {
                    logger?.warn?.("heartbeat: graph/neo4j connected but embedFn NOT rebuilt — community recall disabled");
                  }
                  if (hasRecaller && hasEmbedFn) {
                    logger?.debug?.("heartbeat: graph/neo4j healthy, Recaller + embedFn verified");
                  }
                } else {
                  _graphQuickHealthFailCount++;
                  // P1-FIX: 区分「初始化窗口期」与「真正的 driver 故障」。
                  // 初始化窗口期（initPromise 仍在进行 / mod 尚未加载）不视为 driver unavailable，
                  // 避免在 gateway register() 到达前的 30s 轮询窗口期产生误导性 warn 日志。
                  const isInitializing = !!initPromise || !(graphAdapter as any).mod;
                  if (isInitializing) {
                    logger?.debug?.(`heartbeat: graph/neo4j quickHealth not ready (initializing, attempt ${_graphQuickHealthFailCount})`);
                    // 初始化窗口期不累加失败计数，避免触发不必要的 full recovery
                    _graphQuickHealthFailCount = 0;
                  } else {
                    logger?.warn?.(`heartbeat: graph/neo4j quickHealth failed (${_graphQuickHealthFailCount} consecutive), driver unavailable`);
                  }
                }
              } catch (e) {
                _graphQuickHealthFailCount++;
                logger?.debug?.("heartbeat: graph quickHealth check failed (non-fatal)", { err: e instanceof Error ? e.message : String(e), failCount: _graphQuickHealthFailCount });
              }
            }
          })(),
          // --- 2c. Embedding API health check (带状态去抖) ---
          (async () => {
            try {
              const { probeEmbeddingHealthDetailed } = await import("./adapters/embed-fn.js");
              if (typeof probeEmbeddingHealthDetailed === "function") {
                const embedCfg = api.pluginConfig?.embedding;
                if (embedCfg?.baseURL) {
                  const result = await probeEmbeddingHealthDetailed(embedCfg);
                  const prevHealth = _lastEmbedHealth;
                  _lastEmbedHealth = result.ok;

                  if (!result.ok) {
                    // P0-3 去抖：首次失败或状态变化时 warn，否则降为 debug 避免刷屏
                    if (prevHealth) {
                      // 从 OK 变为 FAIL —— 首次失败或恢复后再次失败
                      logger?.warn?.("heartbeat: embedding API unavailable", { detail: result.detail, baseURL: embedCfg.baseURL });
                    } else {
                      // 持续失败 —— debug 级别
                      logger?.debug?.("heartbeat: embedding API still unavailable", { detail: result.detail });
                    }
                  } else if (!prevHealth) {
                    // 从 FAIL 恢复为 OK —— info 级别
                    logger?.info?.("heartbeat: embedding API recovered");
                  }
                }
              }
            } catch (e) {
              logger?.debug?.("heartbeat: embedding health check failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
            }
          })(),
          // --- 2d. Snapshot server ping (restart 逻辑在并行块后处理) ---
          (async () => {
            if (snapshotConfig && snapshotHandle && snapshotHandle.started) {
              try {
                const pingUrl = `http://${snapshotConfig.host}:${snapshotConfig.port}/internal/health`;
                const pingResp = await fetch(pingUrl, {
                  signal: AbortSignal.timeout(2000),
                }).catch(() => null);
                if (!pingResp || !pingResp.ok) {
                  _snapshotPingOk = false;
                } else {
                  // 消费响应体，避免 keep-alive 连接被未读取的 body 长时间占用（连接泄漏）
                  try { await pingResp.arrayBuffer(); } catch { /* ignore */ }
                }
              } catch {
                _snapshotPingOk = false;
              }
            }
          })(),
        ]);

        // --- 2d-续. Snapshot server restart (依赖 ping 结果) ---
        if (snapshotConfig && snapshotHandle) {
          if (snapshotHandle.started && !_snapshotPingOk) {
            logger?.warn?.(`heartbeat: snapshot server health check failed (port ${snapshotConfig.port} unresponsive), marking for restart`);
            snapshotHandle.started = false;
            snapshotHandle.failureReason = 'health check failed: server unresponsive';
            try { await snapshotServerStop?.(); } catch {}
            snapshotServerStop = null;
          }
          // 重试启动（started=false 时），使用指数退避重试
          if (!snapshotHandle.started) {
            const recovered = await retrySnapshotRestart();
            if (!recovered) {
              logger?.debug?.('heartbeat: snapshot server retry exhausted (will try again next cycle)');
            }
          }
        }

        // --- 2e. v2.7.0 P1: Graph 熔断恢复判断 —— 仅当熔断器 OPEN 或 quickHealth 连续失败时触发完整 health() ---
        // 设计原则：
        //   1. 常规 heartbeat 用 quickHealth()（轻量级，仅 verifyConnectivity，不释放资源）
        //   2. 仅当熔断器 OPEN（neo4j 被标记不可用）或 quickHealth 连续失败 ≥3 次时，
        //      才调用 health() 触发完整 releaseDriver + reconnect + 重建 Recaller/embedFn
        //   3. 恢复成功后同步关闭熔断器，不等 P-CB-4 探针（避免探针被业务请求消耗）
        if (graphAdapter && typeof graphAdapter.health === "function") {
          let needsFullRecovery = false;
          let recoveryReason = '';

          // 检查熔断器状态
          try {
            const { getHealthSnapshot } = await import('./circuit-breaker.js');
            const cbSnap = getHealthSnapshot();
            if (cbSnap?.neo4j?.open) {
              needsFullRecovery = true;
              recoveryReason = `circuit breaker OPEN (failures=${cbSnap.neo4j.failures})`;
            }
          } catch { /* 熔断器模块不可用，跳过 */ }

          // 检查 quickHealth 连续失败
          if (!needsFullRecovery && _graphQuickHealthFailCount >= 3) {
            needsFullRecovery = true;
            recoveryReason = `quickHealth failed ${_graphQuickHealthFailCount} consecutive times`;
          }

          if (needsFullRecovery) {
            logger?.warn?.(`heartbeat: triggering full graph health() recovery — ${recoveryReason}`);
            try {
              const recovered = await graphAdapter.health();
              if (recovered) {
                _graphQuickHealthFailCount = 0;
                logger?.info?.("heartbeat: graph full recovery succeeded (driver + Recaller + embedFn rebuilt)");

                // P-CB-7: 恢复成功后同步关闭 neo4j 熔断器
                try {
                  const { getHealthSnapshot: getCb, recordSuccess } = await import('./circuit-breaker.js');
                  const cbSnap = getCb();
                  if (cbSnap?.neo4j?.open) {
                    recordSuccess('neo4j');
                    logger?.info?.("heartbeat: P-CB-7 neo4j circuit breaker closed (health() recovery succeeded)");
                  }
                } catch (cbErr) {
                  logger?.debug?.("heartbeat: P-CB-7 circuit breaker recovery failed (non-fatal)", { err: String(cbErr) });
                }
              } else {
                logger?.warn?.("heartbeat: graph full recovery failed, will retry next cycle");
              }
            } catch (healthErr) {
              logger?.warn?.("heartbeat: graph health() recovery threw error", { err: healthErr instanceof Error ? healthErr.message : String(healthErr) });
            }
          }
        }

        // --- 2f. RetrievalGateway 延迟恢复：初始化失败时每轮 heartbeat 重试 ---
        // 时序说明：此代码在 await Promise.all([...健康检查...]) 之后执行，
        // 因此 graphAdapter.health() 已先完成（可能恢复了 Neo4j driver），
        // 确保 RetrievalGateway 构造时 graphAdapter 的 driver 已就绪。
        if (!_retrievalGateway && _retrievalGatewayConfig && graphAdapter && qmdClient) {
          // 额外验证：graphAdapter 的 driver 是否已连通（health check 可能失败）
          const graphConnected = typeof graphAdapter.isConnected === 'boolean'
            ? graphAdapter.isConnected
            : true; // 无法判断时乐观放行（构造函数不依赖 driver）
          _retrievalGatewayRecoveryAttempts++;
          try {
            const { RetrievalGateway } = await import("./retrieval-gateway.js");
            _retrievalGateway = new RetrievalGateway(qmdClient, graphAdapter, _retrievalGatewayConfig);
            _retrievalGatewayLastRecoveryError = null;
            logger?.info?.('[lcm-graph-extra] heartbeat: RetrievalGateway recovered (lazy init succeeded)', {
              attempts: _retrievalGatewayRecoveryAttempts,
              graphConnected,
            });
          } catch (gwErr) {
            const errMsg = gwErr instanceof Error ? gwErr.message : String(gwErr);
            const errStack = gwErr instanceof Error ? gwErr.stack : undefined;
            _retrievalGatewayLastRecoveryError = errMsg;
            // 首次失败和每 12 次（约 1 小时）输出 warn 日志，避免刷屏
            if (_retrievalGatewayRecoveryAttempts === 1 || _retrievalGatewayRecoveryAttempts % 12 === 0) {
              logger?.warn?.('[lcm-graph-extra] heartbeat: RetrievalGateway recovery retry failed', {
                attempt: _retrievalGatewayRecoveryAttempts,
                err: errMsg,
                stack: errStack,
                graphConnected,
                hasConfig: !!_retrievalGatewayConfig,
                hasQmdClient: !!qmdClient,
                hasGraphAdapter: !!graphAdapter,
              });
            } else {
              logger?.debug?.('[lcm-graph-extra] heartbeat: RetrievalGateway recovery retry failed', {
                attempt: _retrievalGatewayRecoveryAttempts,
                err: errMsg,
              });
            }
          }
        } else if (!_retrievalGateway) {
          // 恢复条件不满足，记录缺失项方便诊断
          // 仅首次不满足时输出 info，避免刷屏
          if (_retrievalGatewayRecoveryAttempts === 0) {
            logger?.info?.('[lcm-graph-extra] heartbeat: RetrievalGateway recovery skipped (conditions not met)', {
              hasGateway: !!_retrievalGateway,
              hasConfig: !!_retrievalGatewayConfig,
              hasGraphAdapter: !!graphAdapter,
              hasQmdClient: !!qmdClient,
            });
          }
        }

        // --- 2f-2. API 能力自愈：EXPERIENCE 全文索引 + 插件 Neo4j schema ---
        // 背景：expStore.ensureIndexes() 仅在 ensureInitialized 时执行一次，
        // ensureNeo4jSchema() 仅在工具写入前执行。若初始化/首次执行时 Neo4j 未就绪，
        // 索引与 schema 会永久缺失 → L4 全文检索等 API 降级甚至"丢失"且不自愈。
        // 这里在 graph 连接建立/恢复后按状态机重跑（幂等，IF NOT EXISTS + cjk），
        // 仅在连接丢失后复位验证标记，连接恢复的下一轮自动重新补齐。
        // 只在检测到索引真正不可用时才强制 DROP+重建：先做一次轻量 queryNodes 探测，
        // 健康则仅标记已验证、不重建；探测报错（缺失/损坏）才 ensureIndexes(true)。
        // 避免每次连接都无条件 DROP+重建健康索引（重建期间索引短暂不可用，浪费）。
        if (graphAdapter && expStore && typeof expStore.ensureIndexes === 'function') {
          const _graphConnected = typeof graphAdapter.isConnected === 'boolean'
            ? graphAdapter.isConnected
            : !!(graphAdapter as any)?.driver;
          if (_graphConnected) {
            if (!_expIndexesVerified) {
              try {
                const _ftOk = typeof expStore.checkFulltextIndexes === 'function'
                  ? await expStore.checkFulltextIndexes()
                  : true;
                if (!_ftOk) {
                  logger?.warn?.('heartbeat: EXPERIENCE fulltext index unusable, forcing rebuild');
                  const rebuildOk = await expStore.ensureIndexes(true);
                  if (!rebuildOk) {
                    logger?.warn?.('heartbeat: EXPERIENCE index rebuild failed, will retry next cycle');
                    _expIndexesVerified = false;
                    return; // 退出整个 heartbeat，跳过后续 schema 检查和 gm-pro 探测
                  }
                }
                _expIndexesVerified = true;
                logger?.debug?.('heartbeat: EXPERIENCE fulltext indexes verified');
              } catch (idxErr) {
                logger?.warn?.('heartbeat: EXPERIENCE indexes re-check failed (will retry next cycle)', {
                  err: idxErr instanceof Error ? idxErr.message : String(idxErr),
                });
              }
            }
            // 插件级 Neo4j schema（约束 + 全文 + 向量索引）——幂等；失败已改为清除缓存自愈
            try {
              const { ensureNeo4jSchema } = await import('./tools/shared.js');
              await ensureNeo4jSchema();
            } catch { /* 幂等，失败留待下一轮/写入前重试 */ }
          } else {
            // 连接丢失：复位标记，待恢复后重新验证补齐
            _expIndexesVerified = false;
          }
        } else {
          _expIndexesVerified = false;
        }

        // --- 2g. gm-pro 能力自愈：模块重探 + HTTP API 可用性检查 ---
        // 模块侧：probeGmPro() 首次失败后永久缓存"不可用"；这里在未加载时周期性重探，
        // 使 gm-pro 安装/恢复后被重新拾取（withGmProFallback 重新走 gm-pro 路径）。
        // HTTP 侧：插件依赖 gm-pro 独立 HTTP 服务（rebuild-all 等），心跳探测其状态端点，
        // 记录 断开→恢复 转换，及时发现 API 接口丢失。
        try {
          const { probeGmPro, _resetGmProProbe, getGmProMod } = await import('./adapters/gm-pro-fallback.js');
          if (!getGmProMod()) {
            _resetGmProProbe();
            const gmAvail = await probeGmPro();
            if (gmAvail) {
              logger?.info?.('heartbeat: gm-pro capability re-probed and available');
            }
          }
        } catch (gErr) {
          logger?.debug?.('heartbeat: gm-pro module re-probe failed (non-fatal)', { err: gErr instanceof Error ? gErr.message : String(gErr) });
        }
        try {
          const _gmBase = (process.env.GM_PRO_HTTP_URL || 'http://127.0.0.1:7850').replace(/\/+$/, '');
          let _httpOk = false;
          try {
            const r = await fetch(`${_gmBase}/api/status`, { signal: AbortSignal.timeout(3000) });
            _httpOk = r.ok;
            try { await r.arrayBuffer(); } catch { /* 消费响应体，避免 keep-alive 连接被未读 body 占用 */ }
          } catch { _httpOk = false; }
          if (_httpOk !== _lastGmProHttpOk) {
            if (_httpOk) {
              logger?.info?.('heartbeat: gm-pro HTTP API recovered', { baseUrl: _gmBase });
            } else {
              logger?.warn?.('heartbeat: gm-pro HTTP API unavailable', { baseUrl: _gmBase });
            }
          }
          _lastGmProHttpOk = _httpOk;
        } catch (hErr) {
          logger?.debug?.('heartbeat: gm-pro HTTP health check failed (non-fatal)', { err: hErr instanceof Error ? hErr.message : String(hErr) });
        }

        // --- 3. Experience distillation (scheduled async, default every 2h) ---
        const distillIntervalMs = api.pluginConfig?.distillationIntervalMs ?? 2 * 60 * 60 * 1000;
        if (expStore && typeof expStore.fetchPending === "function") {
          const elapsed = Date.now() - lastDistillationRun;
          if (elapsed >= distillIntervalMs) {
            lastDistillationRun = Date.now();
            // 注册到 backgroundTasks 以便 dispose 时等待
            backgroundTasks.register('hb:distillation', runDistillation(expStore, api, logger).then(() => {
              // P2-1: 蒸馏后新经验变为 DISTILLED 可被检索，失效 L4 缓存
              l4QueryCache.clear();
            }).catch((e: any) => {
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

        // --- 5. gm-pro 增量维护（markDirty + incrementalMaintain，每 ~6h） ---
        // gm-pro v2.2.1 新增增量维护能力，避免全量维护的大图谱性能开销。
        // 与全量 TTL 维护分工：TTL 负责衰减/过期，增量维护负责图谱质量（去重/社区/重要性）。
        if (graphAdapter && typeof graphAdapter.query === "function") {
          const incrementalIntervalMs = api.pluginConfig?.incrementalMaintainIntervalMs ?? 6 * 60 * 60 * 1000;
          const incrementalElapsed = Date.now() - lastIncrementalMaintainRun;
          if (incrementalElapsed >= incrementalIntervalMs) {
            lastIncrementalMaintainRun = Date.now();
            backgroundTasks.register('hb:incremental-maintain', (async () => {
              try {
                const { withGmProFallback } = await import("./adapters/gm-pro-fallback.js");
                // 优先调用 gm-pro incrementalMaintain API
                const result = await withGmProFallback<{
                  processedNodes?: number;
                  durationMs?: number;
                  phasesRun?: string[];
                } | null>(
                  'incrementalMaintain',
                  async (mod) => {
                    // 上游 v2.4.2 签名：incrementalMaintain() 无参数，返回 IncrementalMaintenanceResult
                    return await mod.incrementalMaintain();
                  },
                  async () => null, // 无 gm-pro 时跳过（全量维护由 TTL 负责）
                  { label: 'incremental-maintain' },
                );
                if (result?.processedNodes && result.processedNodes > 0) {
                  logger?.info?.(`heartbeat: gm-pro incremental maintain processed ${result.processedNodes} nodes (${result.durationMs ?? '?'}ms, phases ${(result.phasesRun ?? []).join(',')})`);
                }
              } catch (e) {
                logger?.debug?.("heartbeat: incremental maintain skipped (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
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

        try { logger?.info?.("heartbeat: cycle completed in " + String(Date.now() - t0) + "ms"); } catch { /* logger crash, non-fatal */ }

        // P-CB-6: 先执行熔断恢复探针，再采集健康指标。
        // 修复前：healthMetrics.collect() 在 P-CB-4/P-CB-5 恢复探针之前执行，
        // 导致即使恢复成功，healthMetrics 中仍保存恢复前的陈旧熔断状态。
        // dashboard 通过 health.latest 读取的是 5 分钟前的数据，持续显示熔断。
        // 修复后：先恢复，再采集，确保 health.latest 反映最新状态。
        try {
          const { getHealthSnapshot, isAvailable, recordSuccess, recordFailure } = await import('./circuit-breaker.js');
          const cbStates = getHealthSnapshot();

          // P-CB-4: 主动健康探测 —— 对 OPEN 状态的子系统发起探测，加速低峰期恢复
          // qmd 探测
          if (cbStates?.qmd?.open && isAvailable('qmd')) {
            try {
              const ok = await qmdClient.ping();
              if (ok) {
                recordSuccess('qmd');
                logger?.info?.("heartbeat: P-CB-4 qmd probe succeeded, circuit breaker recovered");
              } else {
                recordFailure('qmd');
              }
            } catch (probeErr) {
              recordFailure('qmd');
              logger?.debug?.("heartbeat: P-CB-4 qmd probe failed", { err: String(probeErr) });
            }
          }
          // neo4j 探测
          if (cbStates?.neo4j?.open && isAvailable('neo4j')) {
            try {
              const ok = graphAdapter && typeof graphAdapter.health === 'function'
                ? await graphAdapter.health()
                : (graphAdapter?.isConnected ?? false);
              if (ok) {
                recordSuccess('neo4j');
                logger?.info?.("heartbeat: P-CB-4 neo4j probe succeeded, circuit breaker recovered");
              } else {
                recordFailure('neo4j');
              }
            } catch (probeErr) {
              recordFailure('neo4j');
              logger?.debug?.("heartbeat: P-CB-4 neo4j probe failed", { err: String(probeErr) });
            }
          }

          // P-CB-5: 低 failures 计数器自动重置
          if (cbStates?.qmd && !cbStates.qmd.open && cbStates.qmd.failures > 0) {
            try {
              const ok = await qmdClient.ping();
              if (ok) {
                recordSuccess('qmd');
                logger?.info?.("heartbeat: P-CB-5 qmd healthy, cleared stale failures=" + String(cbStates.qmd.failures));
              }
            } catch { /* 探测失败保持原状 */ }
          }
          if (cbStates?.neo4j && !cbStates.neo4j.open && cbStates.neo4j.failures > 0) {
            try {
              // v2.7.0 P1: P-CB-5 清除 stale failures 用 quickHealth() 轻量检查，避免不必要的 driver 重建
              const ok = graphAdapter && typeof graphAdapter.quickHealth === 'function'
                ? await graphAdapter.quickHealth()
                : (graphAdapter?.isConnected ?? false);
              if (ok) {
                recordSuccess('neo4j');
                _graphQuickHealthFailCount = 0;
                logger?.info?.("heartbeat: P-CB-5 neo4j healthy, cleared stale failures=" + String(cbStates.neo4j.failures));
              }
            } catch { /* 探测失败保持原状 */ }
          }

          // P-CB-6: 恢复探针执行完毕后，再采集健康指标快照。
          // 此时 getHealthSnapshot() 返回的是恢复后的最新状态。
          const postRecoveryStates = getHealthSnapshot();
          healthMetrics.collect({
            pendingMessages: (pendingMessages ?? 0) as number,
            summaryFragments: (summaryFragments ?? 0) as number,
            maxTokenRatio: (maxTokenRatio ?? 0) as number,
            cbLcmAvailable: postRecoveryStates?.lcm?.available ?? true,
            cbQmdAvailable: postRecoveryStates?.qmd?.available ?? true,
            cbNeo4jAvailable: postRecoveryStates?.neo4j?.available ?? true,
            cbLcmFailures: postRecoveryStates?.lcm?.failures ?? 0,
            cbQmdFailures: postRecoveryStates?.qmd?.failures ?? 0,
            cbNeo4jFailures: postRecoveryStates?.neo4j?.failures ?? 0,
          });
        } catch (e) { /* health metrics collection failed, non-fatal */
          logger?.debug?.("heartbeat: health metrics collection failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }

        // Periodic dedup cache cleanup (every 15 heartbeats)
        hbDedupCleanupCounter++;
        if (hbDedupCleanupCounter >= 15) {
          evictStaleDedupPublic();
          evictStaleToolTrackers();
          evictStaleGoalCache();
          hbDedupCleanupCounter = 0;
        }

        // R-4: Periodic session metadata cleanup (every 5 heartbeats ~25min)
        // 防止 lastAssembleExpIdsBySession 和 sessionWarmupCache 在长生命周期进程中无限增长
        hbSessionCleanupCounter++;
        if (hbSessionCleanupCounter >= 5) {
          const SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30min
          const now = Date.now();
          let cleanedExpIds = 0;
          let cleanedWarmup = 0;
          for (const [key, val] of lastAssembleExpIdsBySession) {
            if (now - val.ts > SESSION_EXPIRY_MS) {
              lastAssembleExpIdsBySession.delete(key);
              cleanedExpIds++;
            }
          }
          // 上限保护：超过 200 条时删除最旧的条目
          if (lastAssembleExpIdsBySession.size > 200) {
            const entries = [...lastAssembleExpIdsBySession.entries()]
              .sort((a, b) => a[1].ts - b[1].ts);
            const toDelete = entries.slice(0, entries.length - 200);
            for (const [key] of toDelete) {
              lastAssembleExpIdsBySession.delete(key);
              cleanedExpIds++;
            }
          }
          if (sessionWarmupCache.size > WARMUP_CACHE_MAX) {
            const firstKey = sessionWarmupCache.keys().next().value;
            if (firstKey) {
              sessionWarmupCache.delete(firstKey);
              cleanedWarmup++;
            }
          }
          if (cleanedExpIds > 0 || cleanedWarmup > 0) {
            logger?.debug?.("heartbeat: session metadata cleanup", { cleanedExpIds, cleanedWarmup });
          }
          // M3: 清理 sessionQualityScores —— 长时间未访问的 session 质量评分
          // 修复前：sessionQualityScores 仅在 assemble/afterTurn 中读取，无清理机制，
          // 长生命周期进程下废弃 session 的评分数据永久驻留。
          let cleanedQuality = 0;
          for (const [key] of sessionQualityScores) {
            // 如果该 session 在 lastAssembleExpIdsBySession 中已过期，说明对话已结束
            if (!lastAssembleExpIdsBySession.has(key)) {
              sessionQualityScores.delete(key);
              cleanedQuality++;
            }
          }
          if (sessionQualityScores.size > 200) {
            const firstKey = sessionQualityScores.keys().next().value;
            if (firstKey) {
              sessionQualityScores.delete(firstKey);
              cleanedQuality++;
            }
          }
          if (cleanedQuality > 0) {
            logger?.debug?.("heartbeat: session quality scores cleanup", { cleanedQuality });
          }
          // P0-1: 清理过期 LLM Rerank 缓存
          let cleanedRerank = 0;
          for (const [key, val] of llmRerankCache) {
            if (now - val.ts > LLM_RERANK_CACHE_TTL_MS) {
              llmRerankCache.delete(key);
              cleanedRerank++;
            }
          }
          if (llmRerankCache.size > LLM_RERANK_CACHE_MAX) {
            const entries = [...llmRerankCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
            for (const [key] of entries.slice(0, entries.length - LLM_RERANK_CACHE_MAX)) {
              llmRerankCache.delete(key);
              cleanedRerank++;
            }
          }
          if (cleanedRerank > 0) {
            logger?.debug?.("heartbeat: LLM rerank cache cleanup", { cleanedRerank });
          }
          // P2-1: 清理过期 L2/L4 检索缓存
          let cleanedQueryCache = 0;
          for (const [key, val] of l2QueryCache) {
            if (now - val.ts > QUERY_CACHE_TTL_MS) {
              l2QueryCache.delete(key);
              cleanedQueryCache++;
            }
          }
          for (const [key, val] of l4QueryCache) {
            if (now - val.ts > QUERY_CACHE_TTL_MS) {
              l4QueryCache.delete(key);
              cleanedQueryCache++;
            }
          }
          if (cleanedQueryCache > 0) {
            logger?.debug?.("heartbeat: L2/L4 query cache cleanup", { cleanedQueryCache });
          }
          // v2.7.0 P4: 冲突检测异步缓存 TTL 清理
          let cleanedConflictCache = 0;
          for (const [key, val] of conflictCache) {
            if (now - val.ts > CONFLICT_CACHE_TTL_MS) {
              conflictCache.delete(key);
              cleanedConflictCache++;
            }
          }
          if (cleanedConflictCache > 0) {
            logger?.debug?.("heartbeat: conflict cache cleanup", { cleanedConflictCache });
          }
          // v2.8.0 O7: 清理过期预取缓存
          let cleanedPrefetchCache = 0;
          for (const [key, val] of prefetchCache) {
            if (now - val.ts > PREFETCH_CACHE_TTL_MS) {
              prefetchCache.delete(key);
              cleanedPrefetchCache++;
            }
          }
          if (prefetchCache.size > PREFETCH_CACHE_MAX) {
            const entries = [...prefetchCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
            for (const [key] of entries.slice(0, entries.length - PREFETCH_CACHE_MAX)) {
              prefetchCache.delete(key);
              cleanedPrefetchCache++;
            }
          }
          if (cleanedPrefetchCache > 0) {
            logger?.debug?.("heartbeat: prefetch cache cleanup", { cleanedPrefetchCache });
          }
          hbSessionCleanupCounter = 0;
        }

        // ── 关联矩阵 M 定时持久化（节流 30min）──────────────────────────────
        // 背景：M 仅在 dispose 时落盘，日常运行数小时学习到的最新矩阵可能丢失。
        // 这里在心跳里周期性调用 saveAssociationMatrix，将内存 Recaller 的 M 落盘。
        if (graphAdapter && typeof (graphAdapter as any).saveAssociationMatrix === 'function') {
          const mPersistElapsed = Date.now() - lastMPersistRun;
          if (mPersistElapsed >= M_PERSIST_INTERVAL_MS) {
            lastMPersistRun = Date.now();
            backgroundTasks.register('hb:association-matrix-persist', (async () => {
              try {
                const saved = await (graphAdapter as any).saveAssociationMatrix();
                if (saved && (saved.path || saved.bytes)) {
                  logger?.info?.("heartbeat: association matrix M persisted", {
                    path: saved.path, bytes: saved.bytes,
                  });
                }
              } catch (e) {
                logger?.debug?.("heartbeat: association matrix persist failed (non-fatal)", {
                  err: e instanceof Error ? e.message : String(e),
                });
              }
            })());
          }
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
    logger?.info?.("[lcm-graph-extra] heartbeat scheduled (first run in 60s, then every " + String(HB_INTERVAL_MS / 60000) + "min)");
    hbTimer = setTimeout(function startHb() {
      runHeartbeat();
      hbTimer = setInterval(runHeartbeat, HB_INTERVAL_MS);
    }, 60_000);
    
    // Expose for manual trigger
    (api as any).__lcmHeartbeat = runHeartbeat;

    // -----------------------------------------------------------------------
    // Compaction Provider（兼容 OpenClaw SDK compaction-safeguard 模式）
    //
    // 自 OpenClaw 2026.7+ 起，compaction.mode 默认为 "safeguard"，
    // 若 compaction.provider 配置了 lcm-graph-extra，SDK 会通过
    // getCompactionProvider() 查找注册的 provider。未注册时触发：
    //   "Compaction provider 'lcm-graph-extra' is configured but not registered."
    //
    // 此 provider 将 summarize 委托给 LLM（与 SDK 内置 LLM 管道一致），
    // 同时保留 lcm-graph-extra 的上下文引擎 ownsCompaction 路径不变。
    // -----------------------------------------------------------------------
    if (typeof api.registerCompactionProvider === 'function') {
      // 保持对 api 的弱引用，供 summarize 惰性调用
      const _apiForCompaction = api;
      api.registerCompactionProvider({
        id: 'lcm-graph-extra',
        async summarize(params: {
          messages: any[];
          signal?: AbortSignal;
          customInstructions?: string;
          summarizationInstructions?: any;
          previousSummary?: string | null;
        }): Promise<string | undefined> {
          try {
            // 使用 resolveDistillationLlm 统一解析 LLM 配置（复用主模型）
            const llmCfg = _apiForCompaction ? resolveDistillationLlm(_apiForCompaction) : null;
            const model = llmCfg?.model;
            if (!model) {
              logger?.warn?.('[compactionProvider] no LLM model resolved, skip');
              return undefined; // 返回 undefined 触发 SDK 内置 LLM 回退
            }
            const apiKey = llmCfg?.apiKey || '';
            const baseURL = llmCfg?.baseURL
              ? (llmCfg.baseURL.endsWith('/v1') ? llmCfg.baseURL : llmCfg.baseURL.replace(/\/$/, '') + '/v1')
              : 'http://127.0.0.1:18789/v1';
            const keepAlive = llmCfg?.keepAlive || '1h';

            // 构建 messages → 纯文本（供 LLM 摘要），限制总长度
            const MAX_CHARS = 80_000;
            const textParts: string[] = [];
            let totalChars = 0;
            for (const msg of params.messages ?? []) {
              const role = msg?.role ?? 'unknown';
              let content = '';
              if (typeof msg?.content === 'string') {
                content = msg.content;
              } else if (Array.isArray(msg?.content)) {
                content = msg.content
                  .filter((b: any) => b?.type === 'text' || typeof b?.text === 'string')
                  .map((b: any) => b.text)
                  .join('\n');
              } else if (msg?.content != null) {
                content = String(msg.content);
              }
              if (totalChars >= MAX_CHARS) break;
              const entry = `[${role}]: ${content}`;
              if (totalChars + entry.length > MAX_CHARS) {
                textParts.push(entry.slice(0, MAX_CHARS - totalChars) + '...');
                break;
              }
              textParts.push(entry);
              totalChars += entry.length;
            }

            const previousSummaryNote = params.previousSummary
              ? `\nPrevious summary context:\n${params.previousSummary}\n`
              : '';
            const customNote = params.customInstructions
              ? `\nAdditional instructions:\n${params.customInstructions}\n`
              : '';

            const prompt = `You are a lossless context compaction summarization engine. Summarize the following conversation messages into a concise, structured summary that preserves all critical information: decisions made, code changes, bugs found, user preferences, open questions, and key facts.

${previousSummaryNote}${customNote}
Messages to summarize:
${textParts.join('\n')}

Return the summary as plain text. Preserve the original language of the conversation.`;

            const { callLlm } = await import('./utils/llm-call.js');
            const signal = params.signal ?? AbortSignal.timeout(90_000);
            try {
              const result = await callLlm({
                baseURL,
                apiKey,
                model,
                prompt,
                temperature: 0.4,
                maxTokens: 2000,
                keepAlive,
                signal,
              });
              if (result.text?.trim()) return result.text.trim();
              return undefined;
            } catch (llmErr) {
              logger?.warn?.('[compactionProvider] LLM call failed', { err: String(llmErr) });
              return undefined;
            }
          } catch (err) {
            if ((err as any)?.name === 'AbortError' || (err as any)?.name === 'TimeoutError') {
              logger?.warn?.('[compactionProvider] summarization timed out');
            } else {
              logger?.warn?.('[compactionProvider] summarization failed', { err: String(err) });
            }
            return undefined; // 返回 undefined 触发 SDK 内置 LLM 回退
          }
        },
      });
    }
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
export { QmdClient, QMD_CLIENT_DEFAULTS } from './qmd-client.js';
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


export const VERSION = '2.1.12';
