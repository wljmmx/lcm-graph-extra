/**
 * lcm-graph-extra — Operational tools
 *
 * 全部自包含，不依赖 LcmStore/QmdAdapter 遗留接口。
 * 通过注册函数由 definePluginEntry 调用。
 */

import { Type } from "typebox";
import * as neo4jDriver from 'neo4j-driver';
import { createRequire } from "node:module";
const _lcmRequire = createRequire(import.meta.url);
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join, basename, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { resolveNeo4jConfig } from './config/neo4j-helper';
import { getGlobalLogger } from './utils/logger.js';
import { cleanBaseURL, withKeepAliveIfOllama } from './utils/url.js';
import { exportMarkdownToPdf, exportMarkdownToFile } from './utils/pdf-export.js';
// P2-9: 接入集中化 LLM 超时常量
import { DEFAULTS, llmTimeout } from './config/defaults.js';

// Module-level Neo4j config, initialized by registerOperationalTools
let _pluginNeo4jConfig: Record<string, unknown> | undefined;

// Module-level QMD URL helper
let _pluginQmdUrl = "http://127.0.0.1:8081";

// BUGFIX(P1-4): 由 index.ts 注入的共享 QmdClient 单例。
// 5 个 MCP 工具（lcmg_search/qmd_status/get_document/batch_get/diagnose）复用此实例，
// 避免每次调用 new QmdClient 重建 MCP 连接 + recoveryTimer。未注入时回退到 new QmdClient。
let _sharedQmdClient: any = null;

function getQmdBaseUrl() {
  return _pluginQmdUrl;
}

/**
 * 获取 QmdClient：优先复用 index.ts 注入的单例，否则按需 new 一个。
 * 调用方需在 finally 中判断是否需要 dispose：只有自建的实例才需 dispose，
 * 注入的单例由 index.ts 统一管理生命周期（register 闭包 dispose 时释放）。
 */
async function acquireQmdClient(): Promise<{ client: any; owned: boolean }> {
  if (_sharedQmdClient && typeof _sharedQmdClient.query === 'function') {
    return { client: _sharedQmdClient, owned: false };
  }
  const { QmdClient } = await import("./qmd-client.js");
  return { client: new QmdClient({ mcpBaseUrl: getQmdBaseUrl() }), owned: true };
}

function getPluginNeo4jConfig(): Record<string, unknown> | undefined {
  return _pluginNeo4jConfig;
}

// P1-AUDIT: 统一使用 homedir() 解析路径，与 lcm-bridge.ts 保持一致，
// 避免 process.env.HOME 被篡改或与系统 passwd 不一致导致访问不同数据库。
const LCM_DB = resolve(homedir(), '.openclaw', 'lcm.db');
// Neo4j credentials resolved at runtime via neo4j-helper
// Neo4j user resolved at runtime via neo4j-helper
// Neo4j credentials resolved at runtime via neo4j-helper

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// P2-AUDIT: 单例 DB 连接，与 lcm-bridge.ts / debt-manager.ts 保持一致，
// 避免 lcmg_diagnose 等工具连续查询时多次 open/close。
// node:sqlite 延迟加载（兼容未启用 --experimental-sqlite 的环境）
let _sharedDb: any = null;
function openDb(): any {
  if (_sharedDb) {
    // 验证连接仍可用
    try { _sharedDb.prepare("SELECT 1").get(); return _sharedDb; } catch { _sharedDb = null; }
  }
  try {
    const { DatabaseSync } = _lcmRequire('node:sqlite');
    _sharedDb = new DatabaseSync(LCM_DB);
    return _sharedDb;
  } catch {
    _sharedDb = null;
    return null;
  }
}

/** 关闭共享 DB 连接（dispose 时调用，避免热重载后 SQLite 连接泄漏） */
export function closeSharedDb(): void {
  if (_sharedDb) {
    try { _sharedDb.close(); } catch {}
    _sharedDb = null;
  }
}

/**
 * SEC-5 M-11/M-12: 校验 backup/restore 路径必须在 ~/.openclaw 之下，
 * 防止用户提供的路径穿越到任意文件系统位置。
 */
function validateBackupPath(p: string): string {
  const allowedRoot = resolve(homedir(), '.openclaw');
  const abs = resolve(p);
  if (abs !== allowedRoot && !abs.startsWith(allowedRoot + sep)) {
    throw new Error(`path must be under ${allowedRoot}`);
  }
  return abs;
}

/**
 * SEC-L: 转义 FTS5 MATCH 查询字符串。
 * FTS5 对 `"`、`*`、`(`、`)`、`-` 等字符有特殊语法含义，未转义会导致语法错误或意外匹配。
 * 将整个查询用双引号包裹为短语，并转义内部双引号（"" 表示字面量 "）。
 */
function escapeFts5Query(q: string): string {
  return '"' + q.replace(/"/g, '""') + '"';
}

// ---------------------------------------------------------------------------
// S-8': Time range parsing + LLM summary helpers
// ---------------------------------------------------------------------------

/**
 * S-8': 解析时间范围参数。
 * 支持格式：
 *   - ISO 8601: "2024-01-01", "2024-01-01T00:00:00Z"
 *   - 相对时间: "7d" (7天前), "24h" (24小时前), "30m" (30分钟前)
 *   - 中文: "本周", "今天", "昨天"
 * 返回 { fromTs, toTs } 毫秒时间戳（Neo4j timestamp() 同单位）
 */
export function parseTimeRange(from?: string, to?: string): { fromTs: number | null; toTs: number | null } {
  const now = Date.now();
  const parseOne = (val: string | undefined, isFrom: boolean): number | null => {
    if (!val || !val.trim()) return null;
    const v = val.trim().toLowerCase();

    // 相对时间: "7d", "24h", "30m"
    const relMatch = v.match(/^(\d+)([dhm])$/);
    if (relMatch) {
      const num = parseInt(relMatch[1], 10);
      const unit = relMatch[2];
      const ms = unit === 'd' ? num * 24 * 60 * 60 * 1000 : unit === 'h' ? num * 60 * 60 * 1000 : num * 60 * 1000;
      return isFrom ? now - ms : now;
    }

    // 中文关键词
    if (v === '今天' || v === 'today') return isFrom ? new Date(now).setHours(0, 0, 0, 0) : now;
    if (v === '昨天' || v === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return isFrom ? y.setHours(0, 0, 0, 0) : y.setHours(23, 59, 59, 999);
    }
    if (v === '本周' || v === 'this week') {
      const d = new Date(now);
      const day = d.getDay() || 7; // Sunday=0 → 7
      d.setDate(d.getDate() - day + 1); // Monday
      return isFrom ? d.setHours(0, 0, 0, 0) : now;
    }
    if (v === '本月' || v === 'this month') {
      const d = new Date(now);
      d.setDate(1);
      return isFrom ? d.setHours(0, 0, 0, 0) : now;
    }

    // ISO 8601 / Date string
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) return parsed;

    return null;
  };

  return {
    fromTs: parseOne(from, true),
    toTs: parseOne(to, false),
  };
}

/**
 * S-8': 用 LLM 生成经验回顾的自然语言摘要。
 * 失败时回退到简单的文本摘要。
 */
async function generateExperienceSummary(records: any[], usedExperienceNodes: boolean, timeFilter: { fromTs: number | null; toTs: number | null }): Promise<string> {
  // 提取经验数据
  const experiences = records.slice(0, 30).map((rec: any) => ({
    name: rec.get("e.name") ?? "Unknown",
    type: usedExperienceNodes ? (rec.get("e.communityId") ?? "lesson") : "event",
    desc: (rec.get("e.description") ?? "").slice(0, 200),
    seen: rec.get("e.validatedCount") ?? 0,
    confidence: ((Number(rec.get("e.pagerank") ?? 0)) * 100).toFixed(0) + "%",
  }));

  const total = records.length;
  const fromStr = timeFilter.fromTs ? new Date(timeFilter.fromTs).toLocaleDateString() : "beginning";
  const toStr = timeFilter.toTs ? new Date(timeFilter.toTs).toLocaleDateString() : "now";

  // 尝试调用 LLM 生成摘要（如果有配置）
  try {
    const llmCfg = _pluginNeo4jConfig?.distillationLlm || _pluginNeo4jConfig?.llm;
    const model = (llmCfg as any)?.model;
    const apiKey = (llmCfg as any)?.apiKey || '';
    // 清洗 baseURL：去掉反引号/引号/首尾空格/尾斜杠
    const baseURL = cleanBaseURL((llmCfg as any)?.baseURL || 'http://127.0.0.1:18789/v1');
    const keepAlive = (llmCfg as any)?.keepAlive || '1h';
    if (model) {
      const expList = experiences.map((e, i) => `${i + 1}. [${e.type}] ${e.name} (${e.confidence}, seen ${e.seen}) - ${e.desc}`).join('\n');
      const prompt = `Based on the following ${total} experiences (time range: ${fromStr} to ${toStr}), write a concise natural language summary in the user's language. Group by theme, highlight key lessons learned, and note patterns. Keep it under 500 words.\n\nExperiences:\n${expList}`;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
      // 仅 Ollama 端点注入 keep_alive
      const body = withKeepAliveIfOllama(
        baseURL,
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 800 },
        keepAlive,
      );
      const resp = await fetch(baseURL + '/chat/completions', {
        method: 'POST', headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(llmTimeout('summarizeTimeoutMs')),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text?.trim()) return `## 经验回顾摘要\n\n**时间范围**: ${fromStr} → ${toStr}\n**总数**: ${total} 条经验\n\n${text.trim()}`;
      }
    }
  } catch (e) { /* LLM unavailable, fall back to text summary */
    getGlobalLogger()?.debug?.("experience review LLM summary failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
  }

  // 回退：简单的文本摘要
  const lines: string[] = [`## 经验回顾摘要`, ``, `**时间范围**: ${fromStr} → ${toStr}`, `**总数**: ${total} 条经验`, ``];

  // 按类型分组
  const byType: Record<string, typeof experiences> = {};
  for (const e of experiences) {
    const t = e.type || "other";
    if (!byType[t]) byType[t] = [];
    byType[t].push(e);
  }

  for (const [type, exps] of Object.entries(byType)) {
    lines.push(`### ${type} (${exps.length} 条)`);
    for (const e of exps.slice(0, 5)) {
      lines.push(`- ${e.name} (${e.confidence}) — ${e.desc.slice(0, 100)}`);
    }
    if (exps.length > 5) lines.push(`- ... 及其他 ${exps.length - 5} 条`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Neo4j connection pool — single shared driver, per-call sessions only
// ---------------------------------------------------------------------------
let _neo4jDriver: any = null;
let _neo4jDriverReady: Promise<any> | null = null;

async function getNeo4jDriver(): Promise<any> {
  if (_neo4jDriver) return _neo4jDriver;
  if (_neo4jDriverReady) return _neo4jDriverReady;
  _neo4jDriverReady = (async () => {
    try {
      const neo4j = await import("neo4j-driver").then((m) => m.default);
      const config = resolveNeo4jConfig(getPluginNeo4jConfig());
      if (!config || !config.uri) throw new Error("Neo4j not configured");
      _neo4jDriver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
      _neo4jDriverReady = null;
      return _neo4jDriver;
    } catch (e) {
      // SEC-1 H-7: 初始化失败后必须重置 ready promise，
      // 否则后续调用会永久锁定在 rejected promise 上，无法重试。
      _neo4jDriverReady = null;
      throw e;
    }
  })();
  return _neo4jDriverReady;
}

async function neo4jSession() {
  const driver = await getNeo4jDriver();
  return { driver, session: driver.session() };
}

async function closeNeo4j(driver: any, session: any) {
  try { await session.close(); } catch {}
}

export async function closeNeo4jDriver(): Promise<void> {
  if (_neo4jDriver) {
    try { await _neo4jDriver.close(); } catch {}
    _neo4jDriver = null;
    _neo4jDriverReady = null;
  }
}

/**
 * Try to merge neo4j config from entries if not present in api.config.
 * OpenClaw may place plugin config under entries instead of plugins,
 * so we read openclaw.json and merge it in.
 */
function mergeEntriesNeo4jConfig(api: any): Record<string, unknown> {
  const config = (api.config || {}) as Record<string, unknown>;
  // If neo4j already present AND has a valid URI, use as-is
  if (config && 'neo4j' in config && (config.neo4j as any)?.uri) {
    return config;
  }
  // Always try to load from openclaw.json entries as final source of truth
  const openclawPath = join(homedir(), '.openclaw/openclaw.json');
  if (existsSync(openclawPath)) {
    try {
      const raw = readFileSync(openclawPath, 'utf8');
      const data = JSON.parse(raw);
      // Check plugins.entries first, then top-level entries
      const entriesSection = (data.plugins?.entries || data.entries || {});
      const lcmConfig = entriesSection['lcm-graph-extra']?.config;
      if (lcmConfig && 'neo4j' in lcmConfig && lcmConfig.neo4j.uri) {
        const merged = { ...config, ...lcmConfig };
        getGlobalLogger().info('[lcm-graph-extra] Neo4j config loaded from entries', { uri: merged.neo4j.uri });
        return merged;
      }
    } catch (e) {
      getGlobalLogger().warn('[lcm-graph-extra] Failed to read openclaw.json', { err: String(e) });
    }
  }
  return config;
}

export function registerOperationalTools(api: any): void {
  _pluginNeo4jConfig = mergeEntriesNeo4jConfig(api) as Record<string, unknown>;
  _registerOperationalToolsImpl(api, undefined);
}

/**
 * Dashboard 工具上下文 —— 由 index.ts 注入，供 lcmg_distill / lcmg_compact / lcmg_reset_breaker
 * 访问 register() 闭包内的单例（expStore / runDistillation / triggerCompact / resetBreaker）。
 * 可选参数：未注入时三个工具返回 "dashboard context not available"（向后兼容旧调用方）。
 *
 * BUGFIX(P1-4): 新增 qmdClient 字段，让 lcmg_search / lcmg_qmd_status /
 * lcmg_get_document / lcmg_batch_get / lcmg_diagnose 复用 register() 闭包内
 * 已配置好 mcpTimeout / cliTimeout 的 QmdClient 单例，而非每次 new QmdClient。
 */
export interface DashboardToolContext {
  expStore?: any;
  runDistillation?: (limit: number) => Promise<any>;
  triggerCompact?: (conversationId?: number) => Promise<boolean>;
  resetBreaker?: (name: string) => boolean;
  /** 共享的 QmdClient 单例（由 index.ts 注入）；未注入时工具回退到 new QmdClient */
  qmdClient?: any;
}

/**
 * 带 dashboard 上下文的工具注册入口。
 * dashboardContext 可选，未注入时不注册三个 dashboard 工具（向后兼容）。
 */
export function registerOperationalToolsWithDashboard(api: any, dashboardContext?: DashboardToolContext): void {
  _pluginNeo4jConfig = mergeEntriesNeo4jConfig(api) as Record<string, unknown>;
  _registerOperationalToolsImpl(api, dashboardContext);
}

function _registerOperationalToolsImpl(api: any, dashboardContext: DashboardToolContext | undefined): void {
  // BUGFIX(P1-4): 缓存注入的 qmdClient 单例供所有 MCP 工具复用
  _sharedQmdClient = dashboardContext?.qmdClient ?? null;
  // v1.0.1-5: 包装 api.registerTool —— 为每个 lcmg_* 工具注入操作审计日志
  const originalRegisterTool = api.registerTool.bind(api);
  api.registerTool = (toolDef: any) => {
    if (!toolDef || !toolDef.name || typeof toolDef.execute !== 'function') {
      return originalRegisterTool(toolDef);
    }
    const toolName: string = toolDef.name;
    const originalExecute = toolDef.execute;
    toolDef.execute = async function (toolCallId: string, params: any, signal?: AbortSignal) {
      const startTs = Date.now();
      let result: any;
      let error: string | undefined;
      let status: 'success' | 'failure' = 'success';
      try {
        result = await originalExecute.call(this, toolCallId, params, signal);
        // 检测 execute 返回的 isError 标志
        if (result?.isError === true) {
          status = 'failure';
        }
      } catch (e) {
        status = 'failure';
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        // 异步写入操作日志（fire-and-forget，不阻塞工具返回）
        try {
          // v1.0.1-5: 尝试多个候选路径解析 operation-logs 模块
          // 开发态: packages/dashboard/server/lib/operation-logs.js (ts 编译到原位)
          // 生产态: packages/dashboard/dist-server/lib/operation-logs.js (Docker 构建产物)
          let appendOperationLog: ((entry: any) => void) | null = null;
          for (const candidate of [
            '../packages/dashboard/server/lib/operation-logs.js',
            '../packages/dashboard/dist-server/lib/operation-logs.js',
          ]) {
            try {
              const mod = _lcmRequire(candidate);
              if (typeof mod?.appendOperationLog === 'function') {
                appendOperationLog = mod.appendOperationLog;
                break;
              }
            } catch { /* 尝试下一个路径 */ }
          }
          if (appendOperationLog) {
            // v1.0.1-6: user/session_id 从 toolCallId 或 params 提取
            const user = params?.user ?? params?._user ?? undefined;
            const sessionId = toolCallId ?? params?._sessionId ?? undefined;
            appendOperationLog({
              ts: startTs,
              tool: toolName,
              params: params ?? {},
              result: result ?? null,
              status,
              durationMs: Date.now() - startTs,
              error,
              user,
              sessionId,
            });
          }
        } catch {
          /* operation-logs 模块不可用或写入失败 —— 静默，不阻塞工具 */
        }
      }
      return result;
    };
    return originalRegisterTool(toolDef);
  };
  // ===================================================================
  // 1. lcmg_experience_report
  // ===================================================================
  api.registerTool({
    name: "lcmg_experience_report",
    label: "经验报告",
    description: "Retrieve past troubleshooting experiences from Neo4j knowledge graph. Finds EVENT nodes with SOLVED_BY relationships (fix patterns, lessons learned). format=text (default), json (structured array), markdown, summary (LLM natural language summary), markdown-file (落盘到 ~/.openclaw/reports/), pdf-file (先存 md，需 pandoc 转 PDF). default limit=20. tag filters by community label. S-8': supports from/to time range filtering (ISO 8601 or natural language like '7d', '24h')." +
      "Searches for EVENT nodes with SOLVED_BY relationships and formats as a report.",
    parameters: Type.Object({
      format: Type.Optional(Type.String({ description: 'Output: "text", "json", "markdown", "summary", "markdown-file", "pdf-file"', default: "text" })),
      limit: Type.Optional(Type.Number({ description: "Max experiences (default 20)", minimum: 1, maximum: 100 })),
      tag: Type.Optional(Type.String({ description: "Filter by community tag" })),
      from: Type.Optional(Type.String({ description: "S-8': Start time (ISO 8601 or relative like '7d', '24h', '2024-01-01')" })),
      to: Type.Optional(Type.String({ description: "S-8': End time (ISO 8601 or relative, default now)" })),
      type: Type.Optional(Type.String({ description: "S-8': Filter by experience type (lesson|failure|correction|fix|best_practice)" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const format = params.format ?? "text";
      const limitParam = params.limit ?? 20;
      const { driver, session } = await neo4jSession();
      try {
        // S-8': 解析时间范围参数
        const timeFilter = parseTimeRange(params.from, params.to);
        const typeFilter = params.type?.trim();

        // S-8': 优先调用 graph-memory-pro getNodesByTimeRange API（按时间范围高效检索）
        // 失败/不可用时降级到原 Cypher 查询
        let gmProNodes: any[] | null = null;
        if (timeFilter.fromTs || timeFilter.toTs) {
          try {
            const { withGmProFallback } = await import("./adapters/gm-pro-fallback.js");
            gmProNodes = await withGmProFallback<any[] | null>(
              'getNodesByTimeRange',
              async (mod) => {
                const r = await mod.getNodesByTimeRange({
                  from: timeFilter.fromTs ?? 0,
                  to: timeFilter.toTs ?? Date.now(),
                  limit: Math.trunc(limitParam),
                  label: 'EXPERIENCE',
                });
                return Array.isArray(r) ? r : (r?.nodes ?? null);
              },
              async () => null, // fallback 走 Cypher
              { label: 'S-8 getNodesByTimeRange' },
            );
          } catch {
            gmProNodes = null;
          }
        }

        // 构建查询 —— 支持 EVENT 和 EXPERIENCE 双类型
        // EVENT: 图谱事件节点（原逻辑），EXPERIENCE: 经验层节点（S-8' 新增）
        const conditions: string[] = [];
        const queryParams: Record<string, any> = {
          limit: neo4jDriver.int(Math.trunc(limitParam)) as any,
          tag: params.tag ?? "",
        };

        if (params.tag) conditions.push("e.communityId = $tag");
        if (typeFilter) {
          conditions.push("e.type = $expType");
          queryParams.expType = typeFilter;
        }
        // S-8': 当 gm-pro 已返回时间过滤结果时，Cypher 不再叠加时间条件（避免双过滤）
        if (!gmProNodes) {
          if (timeFilter.fromTs) {
            conditions.push("coalesce(e.createdAt, e.updatedAt, 0) >= $fromTs");
            queryParams.fromTs = neo4jDriver.int(timeFilter.fromTs) as any;
          }
          if (timeFilter.toTs) {
            conditions.push("coalesce(e.createdAt, e.updatedAt, 0) <= $toTs");
            queryParams.toTs = neo4jDriver.int(timeFilter.toTs) as any;
          }
        }

        const whereClause = conditions.length > 0 ? " AND " + conditions.join(" AND ") : "";

        // 优先使用 gm-pro 时间范围结果（已过滤，跳过 Cypher 时间过滤）
        let result: any;
        let usedExperienceNodes = false;
        let usedGmProNodes = false;

        if (gmProNodes && gmProNodes.length > 0) {
          // gm-pro 返回的节点直接构造 records-like 对象供后续 format 处理
          usedGmProNodes = true;
          usedExperienceNodes = true;
          result = {
            records: gmProNodes.map((n: any) => ({
              get: (key: string) => {
                if (key === 'e.id') return n.id;
                if (key === 'e.name') return n.title ?? n.name ?? 'Unknown';
                if (key === 'e.description') return n.summary ?? n.description ?? '';
                if (key === 'e.pagerank') return n.pagerank ?? n.relevanceScore ?? 0;
                if (key === 'e.validatedCount') return n.matchCount ?? 0;
                if (key === 'e.communityId') return n.type ?? '';
                if (key === 'createdAt') return n.createdAt;
                if (key === 'solutions') return [];
                if (key === 'relatedIds') return n.relatedIds ?? [];
                return undefined;
              },
            })),
          };
        } else if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        } else {
        // 优先查 EXPERIENCE 节点（经验层），无结果时回退到 EVENT 节点
        try {
          const expQuery = `MATCH (e:EXPERIENCE)
            WHERE e.status = 'DISTILLED'
            AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())${whereClause}
            OPTIONAL MATCH (e)-[r:RELATED_TO]->(related:EXPERIENCE)
            WITH e, collect(DISTINCT related.id) AS relatedIds
            RETURN e.id AS \`e.id\`, e.title AS \`e.name\`, e.summary AS \`e.description\`,
                   e.relevanceScore AS \`e.pagerank\`, e.matchCount AS \`e.validatedCount\`,
                   e.type AS \`e.communityId\`, e.createdAt AS createdAt,
                   [ {fix: null, relation: null} ] AS solutions,
                   relatedIds AS relatedIds
            ORDER BY e.relevanceScore DESC, e.matchCount DESC LIMIT $limit`;
          result = await session.run(expQuery, queryParams);
          if (result.records.length > 0) usedExperienceNodes = true;
        } catch (e) { /* EXPERIENCE label may not exist, fall through to EVENT */
          getGlobalLogger()?.debug?.("EXPERIENCE label query failed, falling back to EVENT (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }

        if (!usedExperienceNodes) {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          let query = `MATCH (e:EVENT)
            OPTIONAL MATCH (e)-[r:SOLVED_BY]->(fix:SKILL)
            WITH e, collect({fix: fix, relation: r}) AS solutions
            WHERE size(solutions) > 0 AND ANY(s IN solutions WHERE s.fix IS NOT NULL)`;
          query += whereClause;
          query += ` RETURN e.id, e.name, e.description, e.pagerank, e.validatedCount, e.communityId, solutions
            ORDER BY e.pagerank DESC, e.validatedCount DESC LIMIT $limit`;
          result = await session.run(query, queryParams);
        }
        }

        if (!result || result.records.length === 0) {
          return { content: [{ type: "text" as const, text: "No experiences found." }], details: { ok: true } };
        }

        // S-8': summary 格式 —— LLM 生成自然语言摘要
        if (format === "summary") {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const summaryText = await generateExperienceSummary(result.records, usedExperienceNodes, timeFilter);
          return { content: [{ type: "text" as const, text: summaryText }], details: { ok: true } };
        }

        if (format === "json") {
          const data = result.records.map((rec: any) => ({
            id: rec.get("e.id"), name: rec.get("e.name"),
            confidence: (Number(rec.get("e.pagerank") ?? 0) * 100).toFixed(0) + "%",
            occurrences: rec.get("e.validatedCount"),
            solutions: usedExperienceNodes ? [] : (rec.get("solutions") as any[])
              .filter((s: any) => s.fix)
              .map((s: any) => ({ name: s.fix.properties.name, instruction: s.relation?.properties?.instruction })),
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: { ok: true } };
        }

        const lines: string[] = [format === "markdown" ? "# Experience Report\n" : "Experience Report\n"];
        // S-8': 时间范围标签
        if (timeFilter.fromTs || timeFilter.toTs) {
          const fromStr = timeFilter.fromTs ? new Date(timeFilter.fromTs).toLocaleDateString() : "beginning";
          const toStr = timeFilter.toTs ? new Date(timeFilter.toTs).toLocaleDateString() : "now";
          lines.push(`Time range: ${fromStr} → ${toStr}\n`);
        }
        for (const rec of result.records) {
          const name = rec.get("e.name") ?? "Unknown";
          const conf = ((Number(rec.get("e.pagerank") ?? 0)) * 100).toFixed(0);
          const seen = rec.get("e.validatedCount") ?? 0;
          const desc = rec.get("e.description") ?? "";
          const sols: any[] = usedExperienceNodes ? [] : (rec.get("solutions") ?? []).filter((s: any) => s.fix);
          if (format === "markdown") {
            lines.push(`## ${name}`);
            lines.push(`- Confidence: ${conf}% | Occurrences: ${seen}`);
            if (desc) lines.push(`\n${desc}\n`);
            if (sols.length) {
              lines.push("### Solutions");
              for (const s of sols) {
                const sn = s.fix.properties.name ?? "Unknown";
                lines.push(`- **${sn}**${s.relation?.properties?.instruction ? " (" + s.relation.properties.instruction + ")" : ""}`);
              }
            }
          } else {
            lines.push(`[${name}]  ${conf}% (seen ${seen})`);
            if (desc) lines.push(`  ${desc}`);
            if (sols.length) {
              lines.push("  Solutions:");
              for (const s of sols) lines.push(`    - ${s.fix.properties.name ?? "Unknown"}`);
            }
          }
          lines.push("");
        }
        lines.push(`---\nTotal: ${result.records.length} experiences`);
        const finalText = lines.join("\n");

        // 阶段 3-2: 报告导出 — markdown-file / pdf-file 格式落盘到 ~/.openclaw/reports/
        if (format === "markdown-file" || format === "pdf-file") {
          try {
            if (format === "pdf-file") {
              const result = await exportMarkdownToPdf(finalText, 'experience-report');
              const methodInfo = result.method === 'pandoc' ? '' : ' (fallback: 内置 PDF 生成器，无外部依赖)';
              const msg = result.ok
                ? `PDF 报告已保存到 ${result.path}${methodInfo}`
                : `PDF 生成失败: ${result.error}，已保存为 markdown`;
              if (!result.ok) {
                const mdResult = exportMarkdownToFile(finalText, 'experience-report');
                return { content: [{ type: "text" as const, text: `${msg}\nMarkdown 路径: ${mdResult.path}` }], details: { ok: false, error: result.error, markdownPath: mdResult.path } };
              }
              return { content: [{ type: "text" as const, text: msg }], details: { ok: true, path: result.path, format: 'pdf', method: result.method } };
            } else {
              const result = exportMarkdownToFile(finalText, 'experience-report');
              return { content: [{ type: "text" as const, text: `报告已保存到 ${result.path}` }], details: { ok: true, path: result.path, format: 'markdown' } };
            }
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Failed to save report: ${String(err)}` }], details: { ok: false, error: String(err) } };
          }
        }

        return { content: [{ type: "text" as const, text: finalText }], details: { ok: true } };
      } finally {
        await closeNeo4j(driver, session);
      }
    },
  });

  // ===================================================================
  // 2. lcmg_backup — 导出全量数据到 JSON
  // ===================================================================
  api.registerTool({
    name: "lcmg_backup",
    label: "全量备份",
    description: "Full system backup: exports Neo4j nodes+relationships, lossless-claw conversations, and all workspace memory/*.md into a single JSON file. Default output: /tmp/lcm-backup-<timestamp>.json. Use before destructive operations.",
    parameters: Type.Object({
      outputPath: Type.Optional(Type.String({ description: "Output directory" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const outDir = params.outputPath ?? join(homedir(), ".openclaw", "lcm-graph-extra", "backup");
      // SEC-5 M-11: 校验输出路径必须在 ~/.openclaw 之下，防止路径穿越
      let safeOutDir: string;
      try {
        safeOutDir = validateBackupPath(outDir);
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { ok: false, error: `Error: ${e.message}` }, isError: true };
      }
      // BUGFIX(P1-5): 异步 I/O 替代同步 fs 调用，避免阻塞事件循环
      await fsp.mkdir(safeOutDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = join(safeOutDir, `memory-full-backup-${stamp}.json`);

      const backup: Record<string, unknown> = {
        version: "2.0", createdAt: new Date().toISOString(),
        neo4j: { entities: [], relationships: [] },
        lcm: { conversations: [] }, files: [],
      };

      // Neo4j — BUGFIX(P1-5): 全表扫描加 LIMIT 防止超大图库 OOM
      try {
        const { driver, session } = await neo4jSession();
        try {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const nodes = await session.run("MATCH (n) RETURN n LIMIT 50000");
          (backup.neo4j as any).entities = nodes.records.map((r: any) => {
            const p = r.get("n").properties; return { id: p.id, name: p.name, labels: r.get("n").labels };
          });
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const rels = await session.run("MATCH ()-[r]->() RETURN r LIMIT 100000");
          (backup.neo4j as any).relationships = rels.records.map((r: any) => {
            const p = r.get("r").properties;
            return { fromId: p.fromId ?? "", toId: p.toId ?? "", type: r.get("r").type };
          });
        } finally { await closeNeo4j(driver, session); }
      } catch (e) { /* Neo4j unavailable */
        getGlobalLogger()?.debug?.("backup: Neo4j unavailable (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }

      // lossless-claw DB
      let db: any = null;
      try {
        db = openDb();
        const convs = db.prepare("SELECT conversation_id, session_id, session_key FROM conversations ORDER BY conversation_id").all() as any[];
        for (const conv of convs) {
          const msgs = db.prepare("SELECT seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq").all(conv.conversation_id) as any[];
          (backup.lcm as any).conversations.push({
            sessionId: conv.session_id,
            messages: msgs.map((m) => ({ seq: m.seq, role: m.role, content: (m.content ?? "").slice(0, 10000) })),
          });
        }
      } catch (e) { /* DB unavailable */
        getGlobalLogger()?.debug?.("backup: lossless-claw DB unavailable (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }
      finally { if (db) { try { db.close(); } catch {} } }

      // Memory files — BUGFIX(P1-5): readFileSync/readdirSync/statSync → fsp 异步
      try {
        const memDir = join(homedir(), ".openclaw", "workspace", "main");
        const candidates = [
          join(memDir, "MEMORY.md"), join(memDir, "memory"),
        ];
        for (const c of candidates) {
          if (existsSync(c) && (await fsp.stat(c)).isFile()) {
            (backup.files as any[]).push({ path: basename(c), content: (await fsp.readFile(c, "utf-8")).slice(0, 100000) });
          } else if (existsSync(c)) {
            const entries = (await fsp.readdir(c)).filter((f) => f.endsWith(".md"));
            for (const entry of entries) {
              (backup.files as any[]).push({ path: `memory/${entry}`, content: (await fsp.readFile(join(c, entry), "utf-8")).slice(0, 50000) });
            }
          }
        }
      } catch (e) { /* File read unavailable */
        getGlobalLogger()?.debug?.("backup: memory files read unavailable (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }

      // BUGFIX(P1-5): writeFileSync → fsp.writeFile（大 JSON 同步写会长时间阻塞事件循环）
      await fsp.writeFile(backupPath, JSON.stringify(backup, null, 2), "utf-8");
      const msgCount = (backup.lcm as any).conversations.reduce((a: number, c: any) => a + (c.messages?.length ?? 0), 0);
      return {
        content: [{
          type: "text" as const,
          text: [
            `✅ Backup saved to: ${backupPath}`,
            `  Neo4j: ${(backup.neo4j as any).entities.length} entities, ${(backup.neo4j as any).relationships.length} relationships`,
            `  lossless-claw: ${(backup.lcm as any).conversations.length} conversations, ${msgCount} messages`,
            `  Files: ${(backup.files as any[]).length} files`,
            `  Size: ${(JSON.stringify(backup).length / 1024).toFixed(0)} KB`,
          ].join("\n"),
        }],
        details: { ok: true },
      };
    },
  });

  // ===================================================================
  // 3. lcmg_restore — 从备份 JSON 恢复到三处
  // ===================================================================
  api.registerTool({
    name: "lcmg_restore",
    label: "数据恢复",
    description: "Restore from lcmg_backup JSON file. targets=all (default), neo4j_only, lcm_only, files_only. dryRun=true previews without writing. NOTE: Neo4j restore uses MERGE (does NOT delete existing nodes).",
    parameters: Type.Object({
      backupPath: Type.String({ description: "Path to backup JSON file" }),
      targets: Type.Optional(Type.String({
        description: "'all' (default), 'neo4j_only', 'lcm_only', 'files_only'",
        default: "all",
      })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing (default false)" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // SEC-5 M-12: 校验备份路径必须在 ~/.openclaw 之下，防止路径穿越
      let safeBackupPath: string;
      try {
        safeBackupPath = validateBackupPath(params.backupPath);
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { ok: false, error: `Error: ${e.message}` }, isError: true };
      }
      if (!existsSync(safeBackupPath)) {
        return { content: [{ type: "text" as const, text: `Backup not found: ${safeBackupPath}` }], details: { ok: false, error: `Backup not found: ${safeBackupPath}` }, isError: true };
      }
      const data = JSON.parse(readFileSync(safeBackupPath, "utf-8"));
      const targets = params.targets ?? "all";
      const dryRun = params.dryRun ?? false;
      const report: string[] = [];

      report.push(`Restore from: ${safeBackupPath}`);
      report.push(`Dry run: ${dryRun ? "YES" : "NO"}\n`);

      // Neo4j
      if ((targets === "all" || targets === "neo4j_only") && !dryRun) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        try {
          const { driver, session } = await neo4jSession();
          try {
            let nCount = 0, rCount = 0;
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const ent of (data.neo4j as any)?.entities ?? []) {
              await session.run("MERGE (n {id: $id}) SET n.name = $name, n.labels = $labels", { id: ent.id, name: ent.name ?? "", labels: ent.labels ?? [] });
              nCount++;
            }
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const rel of (data.neo4j as any)?.relationships ?? []) {
              await session.run("MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:SOLVED_BY]->(b)", { from: rel.fromId, to: rel.toId });
              rCount++;
            }
            report.push(`✅ Neo4j: Restored ${nCount} entities, ${rCount} relationships`);
          } finally { await closeNeo4j(driver, session); }
        } catch (e: any) { report.push(`❌ Neo4j: ${e.message}`); }
      }

      // lossless-claw DB
      if ((targets === "all" || targets === "lcm_only") && !dryRun) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let db: any = null;
        try {
          db = openDb();
          let msgCount = 0;
          const insertMsg = db.prepare("INSERT OR IGNORE INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?)");
          for (const conv of (data.lcm as any)?.conversations ?? []) {
            let convId = 1;
            const exists = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(conv.sessionId ?? "") as any;
            if (exists) {
              convId = exists.conversation_id;
            } else {
              db.prepare("INSERT INTO conversations (session_id, session_key, active, created_at) VALUES (?, 'restored', 1, datetime('now'))").run(conv.sessionId ?? "unknown");
              convId = Number(db.prepare("SELECT last_insert_rowid() as id").get()?.id ?? 1);
            }
            for (const msg of (conv.messages ?? [])) {
              insertMsg.run(convId, msg.seq ?? 0, msg.role ?? "user", msg.content ?? "", (msg.content?.length ?? 0), Date.now());
              msgCount++;
            }
          }
          report.push(`✅ lossless-claw: Restored ${msgCount} messages`);
        } catch (e: any) { report.push(`❌ lossless-claw: ${e.message}`); }
        finally { if (db) { try { db.close(); } catch {} } }
      }

      // Files
      if ((targets === "all" || targets === "files_only") && !dryRun) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        try {
          const memDir = resolve(join(homedir(), ".openclaw", "workspace", "main"));
          let fCount = 0;
          let skipped = 0;
          for (const file of (data.files as any[]) ?? []) {
            // P0-5 SEC-4: 路径穿越防护。备份 JSON 中的 file.path 不可信，
            // 必须是相对路径且不含 ..，realpath 必须仍在 memDir 之下。
            const relPath = file.path;
            if (typeof relPath !== 'string' || relPath === '' || relPath.startsWith('/')) {
              skipped++; continue;
            }
            if (relPath.includes('..') || relPath.includes('\0')) {
              skipped++; continue;
            }
            const fp = resolve(join(memDir, relPath));
            // 二次校验：resolve 后的绝对路径必须以 memDir 为前缀
            if (fp !== memDir && !fp.startsWith(memDir + sep)) {
              skipped++; continue;
            }
            mkdirSync(fp.substring(0, fp.lastIndexOf(sep)), { recursive: true });
            writeFileSync(fp, file.content, "utf-8");
            fCount++;
          }
          report.push(`✅ Files: Restored ${fCount} files${skipped > 0 ? ` (skipped ${skipped} unsafe paths)` : ''}`);
        } catch (e: any) { report.push(`❌ Files: ${e.message}`); }
      }

      if (dryRun) {
        const n = (data.neo4j as any)?.entities?.length ?? 0;
        const r = (data.neo4j as any)?.relationships?.length ?? 0;
        const m = (data.lcm as any)?.conversations?.reduce((a: number, c: any) => a + (c.messages?.length ?? 0), 0) ?? 0;
        const f = (data.files as any[])?.length ?? 0;
        report.push(`📋 Would restore: Neo4j ${n}e/${r}r, lossless-claw ${m}msgs, ${f} files`);
      }

      report.push("\n✅ Restore complete.");
      return { content: [{ type: "text" as const, text: report.join("\n") }], details: { ok: true } };
    },
  });

  // ===================================================================
  // 4. lcmg_import — 历史数据导入到 Neo4j（无 LLM 提取时可运行降级模式）
  // ===================================================================
  api.registerTool({
    name: "lcmg_import",
    label: "历史导入",
    description: "One-time import of historical data into Neo4j knowledge graph. source=lcm_messages imports chat history, source=memory_files imports *.md files, source=all does both. Uses LLM entity extraction when configured." +
      " Uses LLM entity extraction when configured.",
    parameters: Type.Object({
      source: Type.String({ description: '"lcm_messages", "memory_files", or "all"' }),
      limit: Type.Optional(Type.Number({ description: "Max items to process (default 50)", minimum: 1, maximum: 500 })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const limit = params.limit ?? 50;
      const lines: string[] = [];
      let total = 0;

      // lossless-claw 消息导入
      if (params.source === "lcm_messages" || params.source === "all") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let db: any = null;
        try {
          db = openDb();
          const convs = db.prepare("SELECT conversation_id, session_id FROM conversations WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM messages) ORDER BY conversation_id DESC LIMIT ?").all(limit) as any[];
          const { driver, session } = await neo4jSession();
          try {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const conv of convs) {
              const msgs = db.prepare("SELECT seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 5").all(conv.conversation_id) as any[];
              for (const msg of msgs) {
                await session.run(
                  "MERGE (n:ConversationMessage {id: $id}) SET n.role = $role, n.content = $content, n.sessionId = $sid, n.tokens = $tokens",
                  { id: `${conv.session_id}-${msg.seq}`, role: msg.role, content: (msg.content ?? "").slice(0, 5000), sid: conv.session_id, tokens: msg.content?.length ?? 0 }
                );
                total++;
              }
            }
          } finally { await closeNeo4j(driver, session); }
          lines.push(`✅ Imported ${total} messages from lossless-claw DB`);
        } catch (e: any) { lines.push(`❌ lossless-claw import: ${e.message}`); }
        finally { if (db) { try { db.close(); } catch {} } }
      }

      // 记忆文件导入
      if (params.source === "memory_files" || params.source === "all") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let fCount = 0;
        try {
          const memDir = join(homedir(), ".openclaw", "workspace", "main", "memory");
          const { driver, session } = await neo4jSession();
          try {
            const files = existsSync(memDir) ? readdirSync(memDir).filter((f) => f.endsWith(".md")).slice(0, limit) : [];
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const file of files) {
              const content = readFileSync(join(memDir, file), "utf-8").slice(0, 5000);
              await session.run("MERGE (n:MemoryFile {id: $id}) SET n.name = $name, n.content = $content", { id: `file-${file}`, name: file, content });
              fCount++;
            }
          } finally { await closeNeo4j(driver, session); }
          lines.push(`✅ Imported ${fCount} memory files into Neo4j`);
        } catch (e: any) { lines.push(`❌ memory files import: ${e.message}`); }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") || "No data imported." }], details: { ok: true } };
    },
  });

  // ===================================================================
  // 5. lcmg_diagnose — 自行诊断
  // ===================================================================
  api.registerTool({
    name: "lcmg_diagnose",
    label: "系统诊断",
    description: "Full system diagnostics: checks Neo4j connectivity + node/rel counts, lossless-claw DB size, QMD MCP health, and all circuit breaker states. Returns structured JSON with per-subsystem status (healthy/degraded/down). Use when troubleshooting memory or recall issues.",
    parameters: Type.Object({}),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const L: string[] = [];
      const p = (s: string) => L.push(s);
      const sep = () => p("");
      const H = "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501";
      const ok = (label: string, d?: string) => p("  [OK] " + label + (d ? " - " + d : ""));
      const warn = (label: string, d: string) => p("  [!] " + label + " - " + d);
      const fail = (label: string, d: string) => p("  [X] " + label + " - " + d);
      let pass = 0, fails = 0, warns = 0;

      p("lcm-graph-extra - Health Report");
      p("Generated: " + new Date().toISOString());
      sep();

      // 1. lossless-claw
      p(H);
      p("1. lossless-claw (SQLite DAG)");
      p(H);
      let db: any = null;
      try {
        db = openDb();
        const msgs = db.prepare("SELECT COUNT(*) as c FROM messages").get().c;
        const sms = db.prepare("SELECT COUNT(*) as c FROM summaries").get().c;
        const ctx = db.prepare("SELECT COUNT(*) as c FROM context_items").get().c;
        const conv = db.prepare("SELECT COUNT(*) as c FROM conversations").get().c;
        const totalT = db.prepare("SELECT SUM(token_count) as t FROM messages").get().t ?? 0;
        const smT = db.prepare("SELECT SUM(token_count) as t FROM summaries").get().t ?? 0;
        ok("Messages", msgs.toLocaleString() + " (" + (totalT/1000).toFixed(0) + "K tokens)");
        ok("Summaries", sms + " (compression: " + ((smT/totalT)*100).toFixed(2) + "%)");
        ok("Context items", ctx.toLocaleString());
        ok("Conversations", conv.toString());
        const depths = db.prepare("SELECT depth, COUNT(*) as c FROM summaries GROUP BY depth ORDER BY depth").all();
        ok("DAG depths", depths.map((d: any) => "depth=" + d.depth + ":" + d.c).join(" | "));

        // P1-AUDIT: FTS5 索引为空或不含 'test' 时 .get() 返回 undefined，
        // 直接访问 .c 会抛 TypeError。加空值保护，未命中时显示 0。
        const ftsRow = db.prepare("SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'test'").get();
        const fts = ftsRow?.c ?? 0;
        ok("FTS5 index", "searchable (test -> " + fts + " hits)");
        pass += 6;
      } catch (e: any) { fail("lossless-claw", e.message); fails++; }
      finally { if (db) { try { db.close(); } catch {} } }

      // 2. qmd
      sep();
      p(H);
      p("2. qmd (Memory File Engine)");
      p(H);
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const r = await fetch(getQmdBaseUrl() + "/health", { signal: AbortSignal.timeout(2000) });
        ok("MCP 8081", "HTTP " + r.status); pass++;
      } catch { warn("MCP 8081", "unreachable"); warns++; }
      // SEC-2 H-8: QmdClient 使用 try/finally 确保 dispose 释放 recoveryTimer
      // BUGFIX(P1-4): 复用注入的单例（owned=false 时不 dispose）
      let qmd: any = null;
      let qmdOwned = false;
      try {
        const acquired = await acquireQmdClient();
        qmd = acquired.client; qmdOwned = acquired.owned;
        if (await qmd.ping()) { ok("QmdClient", "MCP available (CLI fallback ready)"); pass++; }
        else { warn("QmdClient", "MCP down, running in CLI fallback mode"); warns++; }
        const stat = await qmd.status();
        if (stat) { ok("Qmd status", stat.slice(0, 100).replace(/\n/g, " ")); pass++; }
        else { warn("Qmd status", "status() returned no data"); warns++; }
        const r2 = await qmd.query({ searches: [{ type: "lex", query: "test" }], limit: 1 });
        ok("Search test", r2.length > 0 ? r2.length + " results" : "0 results (empty index)"); pass++;
      } catch (e: any) { warn("qmd", "unavailable: " + e.message); warns++; }
      finally { if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} } }

      // 3. Neo4j
      sep();
      p(H);
      p("3. graph-memory-pro (Neo4j)");
      p(H);
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const { driver, session } = await neo4jSession();
        try {
          const info = await driver.getServerInfo();
          ok("Connection", info.address + " v" + (info.protocolVersion as any).major + "." + (info.protocolVersion as any).minor); pass++;
          const labels = await session.run("MATCH (n) RETURN labels(n)[0] AS l, count(n) AS c ORDER BY c DESC");
          let totalN = 0;
          const lb: string[] = [];
          for (const r of labels.records) { const c = r.get("c").toNumber(); lb.push(r.get("l") + ":" + c); totalN += c; }
          ok("Nodes", totalN + " (" + lb.join(", ") + ")"); pass++;
          const rel = await session.run("MATCH ()-[r]->() RETURN count(r) AS c");
          ok("Relationships", rel.records[0].get("c").toNumber().toString()); pass++;
          const exp = await session.run("MATCH (n:EXPERIENCE) RETURN count(n) AS c");
          const ec = exp.records[0].get("c").toNumber();
          if (ec > 0) ok("EXPERIENCE", ec + " nodes"); else warn("EXPERIENCE", "0 (no extractions yet)"); (ec > 0 ? pass++ : warns++);
          const pin = await session.run("MATCH (n {pinned: true}) RETURN count(n) AS c");
          const pc = pin.records[0].get("c").toNumber();
          // P1-7: pass++ 原在 if 块外，pinned=0 时仍递增 pass 导致计数虚高。移入 else 分支。
          if (pc > 0) { ok("Pinned", pc + " nodes"); pass++; }
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { fail("Neo4j", e.message); fails++; }

      // 4. Circuit Breaker
      sep();
      p(H);
      p("4. Circuit Breakers");
      p(H);
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const cb = await import("./circuit-breaker.js");
        const h = cb.getHealthSnapshot();
        if (Object.keys(h).length === 0) { warn("Breaker state", "no data yet"); warns++; }
        for (const [name, st] of Object.entries(h)) {
          const label = { lcm: "lossless-claw", qmd: "qmd", neo4j: "Neo4j" }[name] || name;
          if (st.available) { ok(label, st.failures + " failures"); pass++; }
          else { fail(label, "OPEN (" + st.failures + " failures)"); fails++; }
        }
      } catch { warn("Circuit breaker", "not loaded"); warns++; }

      // 5. Health Metrics (N-4)
      sep();
      p(H);
      p("5. Health Metrics (N-4)");
      p(H);
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const { healthMetrics } = await import('./health-metrics.js');
        const latest = healthMetrics.getLatest();
        if (latest) {
          const ago = Math.round((Date.now() - latest.timestamp) / 60000);
          ok("Last snapshot", ago + " min ago");
          ok("Pending msgs", String(latest.pendingMessages));
          ok("Summary frags", String(latest.summaryFragments));
          ok("Token ratio", latest.maxTokenRatio.toFixed(3));
          if (latest.lastAssembleMs > 0) {
            ok("Last assemble", latest.lastAssembleMs + "ms (L2:" + latest.lastL2Ms + "ms L3:" + latest.lastL3Ms + "ms L4:" + latest.lastL4Ms + "ms)");
          }
          if (latest.tierLow + latest.tierMedium + latest.tierHigh > 0) {
            ok("Tier distribution", "low:" + latest.tierLow + " med:" + latest.tierMedium + " high:" + latest.tierHigh);
          }
          pass++;
        } else {
          warn("Health metrics", "no snapshots yet (heartbeat may not have run)");
          warns++;
        }

        // 从 lcm.db 读取历史趋势
        const dbRows = await healthMetrics.readFromDb(5);
        if (dbRows.length > 0) {
          p("  Recent history:");
          for (const r of dbRows.slice(0, 5)) {
            const ts = new Date(r.ts).toLocaleTimeString();
            p("    " + ts + " | msgs:" + r.pending_msgs + " frags:" + r.summary_frags + " ratio:" + (typeof r.token_ratio === 'number' ? r.token_ratio.toFixed(3) : '0.000') +
              " | cb:" + (r.cb_lcm_ok ? "✓" : "✗") + (r.cb_qmd_ok ? "✓" : "✗") + (r.cb_neo4j_ok ? "✓" : "✗"));
          }
        }
      } catch (e: any) { warn("Health metrics", "collection failed: " + e.message); warns++; }

      // 6. Summary
      sep();
      p(H);
      p("6. Summary");
      p(H);
      p("  Pass: " + pass + "  Warnings: " + warns + "  Failures: " + fails);
      p(fails === 0 ? "  Status: OK" : "  Status: DEGRADED (" + fails + " issues)");

      return { content: [{ type: "text" as const, text: L.join("\n") }], details: { ok: true } };
    },
  });
// ===================================================================
  // 6. lcmg_search — 跨引擎联合搜索
  // ===================================================================
  api.registerTool({
    name: "lcmg_search",
    label: "联合检索",
    description: "Unified search across all three memory backends: (1) lossless-claw FTS5 (conversation messages), (2) QMD BM25/vector (code/docs retrieval), (3) Neo4j knowledge graph (entities/relationships). Returns merged, deduplicated results with source-tagged entries. " +
      "Returns merged & deduplicated results across all three memory stores.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 30 })),
      engines: Type.Optional(Type.String({
        description: '"all" (default), "lcm_only", "qmd_only", "neo4j_only"',
        default: "all",
      })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const query = params.query.trim();
      if (!query) return { content: [{ type: "text" as const, text: "Error: query required" }], details: { ok: false, error: "Error: query required" }, isError: true };
      const limit = params.limit ?? 10;
      const engines = params.engines ?? "all";

      const results: string[] = [];
      results.push(`# Cross-Engine Search: "${query}"\n`);

      // --- lossless-claw FTS5 ---
      if (engines === "all" || engines === "lcm_only") {
        let db: any = null;
        try {
          db = openDb();
          const rows = db.prepare(
            `SELECT rowid, rank, substr(content, 1, 300) as preview FROM messages_fts
             WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`
          ).all(escapeFts5Query(query), limit) as any[];
          if (rows.length > 0) {
            results.push(`## 📇 lossless-claw (${rows.length} hits)`);
            for (const r of rows) results.push(`- [score ${r.rank.toFixed(2)}] ${r.preview}...`);
            results.push("");
          }
        } catch (e: any) { results.push(`❌ lossless-claw search: ${e.message}\n`); }
        finally { if (db) { try { db.close(); } catch {} } }
      }

      // --- qmd ---
      // P2-10: 改用 QmdClient（MCP 优先 + CLI 降级 + 熔断器），与其他 qmd 工具保持一致。
      // 旧实现直接 execFile("qmd", ["query", ...]) 绕过 QmdClient 的 MCP 通道、
      // 熔断器、统一日志和 session 管理，导致：(1) 失去 MCP 性能优势；
      // (2) MCP 故障时无法自动降级到 CLI；(3) 与 retrieval-gateway 行为不一致。
      if (engines === "all" || engines === "qmd_only") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let qmd: any = null;
        let qmdOwned = false;
        try {
          // BUGFIX(P1-4): 复用注入的 QmdClient 单例
          const acquired = await acquireQmdClient();
          qmd = acquired.client; qmdOwned = acquired.owned;
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const qmdResults = await qmd.query({
            searches: [
              { type: "lex", query },
              { type: "vec", query },
            ],
            limit,
            rerank: true,
          });
          if (qmdResults.length > 0) {
            results.push(`## 📄 qmd memory (${qmdResults.length} hits)`);
            for (const r of qmdResults) {
              const title = r.title || r.file || r.docid || "(untitled)";
              const score = typeof r.score === "number" ? r.score.toFixed(2) : "0.00";
              const snippet = (r.snippet || "").replace(/\s+/g, " ").slice(0, 200);
              const lineTag = r.line ? `:${r.line}` : "";
              results.push(`- [score ${score}] ${title}${lineTag} — ${snippet}`);
            }
            results.push("");
          }
        } catch (e: any) {
          results.push(`❌ qmd search: ${e?.message ?? String(e)}\n`);
        } finally {
          if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} }
        }
      }

      // --- Neo4j ---
      if (engines === "all" || engines === "neo4j_only") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        try {
          const { driver, session } = await neo4jSession();
          try {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            // BUGFIX(P2-4): 去掉冗余 toLower 扫描（与 n.name CONTAINS $k 重复），
            // CONTAINS 无法走 B-tree 索引，未来可考虑创建 full-text index 优化：
            //   CREATE INDEX node_search_fts IF NOT EXISTS FOR (n:Entity) ON (n.name, n.content)
            const rows = await session.run(
              `MATCH (n)
               WHERE (n.name CONTAINS $k OR n.content CONTAINS $k)
               AND (n.state IS NULL OR n.state <> 'superseded')
               RETURN n.name, labels(n)[0] AS type, n.content, n.pagerank
               ORDER BY n.pagerank DESC LIMIT $limit`,
              { k: query, limit: neo4jDriver.int(Math.trunc(limit)) as any }
            );
            if (rows.records.length > 0) {
              results.push(`## 🔗 Neo4j graph (${rows.records.length} hits)`);
              for (const r of rows.records) {
                const type = r.get("type") ?? "Node";
                const name = r.get("n.name") ?? "(unnamed)";
                results.push(`- [${type}] ${name}`);
              }
              results.push("");
            }
          } finally { await closeNeo4j(driver, session); }
        } catch (e: any) { results.push(`❌ Neo4j search: ${e.message}\n`); }
      }

      if (results.length === 1) results.push("(no results found)");
      return { content: [{ type: "text" as const, text: results.join("\n") }], details: { ok: true } };
    },
  });

  // ===================================================================
  // 7. lcmg_pin — 标记 Neo4j 节点为永久保留
  // ===================================================================
  api.registerTool({
    name: "lcmg_pin",
    label: "节点置顶",
    description: "Pin/unpin a Neo4j knowledge graph node. Pinned nodes are excluded from TTL-based memory decay and will never be auto-deleted. Use when a piece of knowledge should never be forgotten. " +
      "Use when a piece of knowledge should never be forgotten.",
    parameters: Type.Object({
      id: Type.String({ description: "Node ID to pin" }),
      unpin: Type.Optional(Type.Boolean({ description: "Set true to unpin instead of pin (default false)" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const { driver, session } = await neo4jSession();
        try {
          const pinned = params.unpin !== true;
          await session.run("MATCH (n {id: $id}) SET n.pinned = $pinned", { id: params.id, pinned });
          return {
            content: [{
              type: "text" as const,
              text: `✅ Node "${params.id}" ${pinned ? "pinned" : "unpinned"}`,
            }],
            details: { ok: true },
          };
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Pin error: ${e.message}` }], details: { ok: false, error: `❌ Pin error: ${e.message}` }, isError: true };
      }
    },
  });

  // ===================================================================
  // 7.5 lcmg_forget — G-10: 主动遗忘命令（与 lcmg_pin 反向）
  // ===================================================================
  api.registerTool({
    name: "lcmg_forget",
    label: "主动遗忘",
    description: "Actively forget/supersede a knowledge graph node or experience. mode=soft: reduce relevanceScore/pagerank (node stays searchable but deprioritized). mode=hard: mark node as 'superseded' (excluded from search results, retained for audit). " +
      "G-10: Use when a piece of knowledge is outdated or incorrect and should be deprioritized or removed from active recall.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Node ID to forget" })),
      query: Type.Optional(Type.String({ description: "Query to find nodes to forget (if id not provided)" })),
      mode: Type.Optional(Type.String({ description: "'soft' (default): reduce weight. 'hard': mark as superseded", default: "soft" })),
      confirm: Type.Optional(Type.Boolean({ description: "Required true for hard mode (safety check)", default: false })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const mode = params.mode ?? "soft";
      const isHard = mode === "hard";

      // Safety: hard mode requires explicit confirmation
      if (isHard && params.confirm !== true) {
        return {
          content: [{
            type: "text" as const,
            text: "❌ Hard forget requires confirm=true. This is a safety check to prevent accidental data loss.",
          }],
          details: { ok: true },
        };
      }

      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const { driver, session } = await neo4jSession();
        try {
          let nodeIds: string[] = [];

          if (params.id) {
            // Single node by ID
            nodeIds = [params.id];
          } else if (params.query) {
            // Search for nodes by query
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            const searchResult = await session.run(
              `MATCH (n) WHERE (n.name CONTAINS $q OR n.description CONTAINS $q OR n.title CONTAINS $q OR n.summary CONTAINS $q)
               AND NOT n.pinned = true
               RETURN n.id AS id LIMIT 10`,
              { q: params.query },
            );
            nodeIds = searchResult.records.map((r: any) => r.get("id")).filter(Boolean);
            if (nodeIds.length === 0) {
              return { content: [{ type: "text" as const, text: "No matching nodes found (pinned nodes are protected)." }], details: { ok: true } };
            }
          } else {
            return { content: [{ type: "text" as const, text: "Provide either id or query parameter." }], details: { ok: false, error: "Provide either id or query parameter." }, isError: true };
          }

          let affected = 0;
          if (isHard) {
            // G-10: 优先调用 graph-memory-pro evolveNode API（与 S-2 软替换 + G-3 重要性评分协同）
            // 失败降级到原 Cypher 直接 SET（保留原行为）
            const { withGmProFallback } = await import("./adapters/gm-pro-fallback.js");
            type EvolveResult = { evolved: boolean; previousState?: string; newState?: string; reason?: string } | null;
            const gmProEvolvedSet = new Set<string>(); // 已成功 evolve 的节点 ID（去重）
            for (const nodeId of nodeIds) {
              const result = await withGmProFallback<EvolveResult>(
                'evolveNode',
                async (mod) => {
                  const r = await mod.evolveNode(nodeId, {
                    state: 'superseded',
                    supersededAt: Date.now(),
                    relevanceScore: 0,
                    pagerank: 0,
                  });
                  return r as EvolveResult;
                },
                async () => null, // fallback 不做（由后续 Cypher 处理）
                { label: 'G-10 evolveNode' },
              );
              if (result?.evolved) gmProEvolvedSet.add(nodeId);
            }

            // Fallback: Cypher 直接 SET（仅处理 gm-pro 未成功的节点，避免双重处理）
            const remainingIds = nodeIds.filter((id: string) => !gmProEvolvedSet.has(id));
            if (remainingIds.length > 0) {
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              const result = await session.run(
                `UNWIND $ids AS nodeId
                 MATCH (n {id: nodeId})
                 WHERE NOT n.pinned = true
                 SET n.state = 'superseded',
                     n.supersededAt = timestamp(),
                     n.relevanceScore = 0,
                     n.pagerank = 0
                 RETURN count(n) AS cnt`,
                { ids: remainingIds },
              );
              const cypherAffected = result.records[0]?.get("cnt")?.toNumber() ?? 0;
              affected = gmProEvolvedSet.size + cypherAffected; // 精确求和，不重复计数
            } else {
              affected = gmProEvolvedSet.size;
            }
          } else {
            // Soft: reduce weight (relevanceScore * 0.3, pagerank * 0.3)
            // G10-P2 修复: 加 0.05 下限，避免多次软遗忘后权重无限趋近 0（隐式硬遗忘）
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            const result = await session.run(
              `UNWIND $ids AS nodeId
               MATCH (n {id: nodeId})
               WHERE NOT n.pinned = true
               SET n.relevanceScore = greatest(coalesce(n.relevanceScore, 0.5) * 0.3, 0.05),
                   n.pagerank = greatest(coalesce(n.pagerank, 0.5) * 0.3, 0.05),
                   n.forgottenAt = timestamp()
               RETURN count(n) AS cnt`,
              { ids: nodeIds },
            );
            affected = result.records[0]?.get("cnt")?.toNumber() ?? 0;
          }

          const modeText = isHard ? "hard-forgotten (superseded)" : "soft-forgotten (weight reduced)";
          return {
            content: [{
              type: "text" as const,
              text: affected > 0
                ? `✅ ${affected} node(s) ${modeText}.\nIDs: ${nodeIds.slice(0, 5).join(", ")}${nodeIds.length > 5 ? ` ... (+${nodeIds.length - 5})` : ""}\n${isHard ? "Nodes are retained for audit but excluded from search." : "Nodes remain searchable but deprioritized."}`
                : `⚠️ No nodes affected (they may be pinned or not found).`,
            }],
            details: { ok: true },
          };
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Forget error: ${e.message}` }], details: { ok: false, error: `❌ Forget error: ${e.message}` }, isError: true };
      }
    },
  });

  // ===================================================================
  // 8. lcmg_sync — 三端数据同步修复
  // ===================================================================
  api.registerTool({
    name: "lcmg_sync",
    label: "数据同步",
    description: "Cross-store consistency check and repair for lossless-claw, Neo4j, and memory files. mode=check: read-only audit (reports orphaned entities and missing refs). mode=repair: actively prunes orphans and re-imports missing data. " +
      "Detects stale Neo4j entities (orphaned after compaction), missing entities, and cross-reference drift.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({
        description: '"check" (default, read-only), "repair" (prune orphans + re-import)',
        default: "check",
      })),
      // P0-5 SEC-4: dryRun 默认 true。原代码 repair 模式默认 false，用户不显式传 dryRun 时
      // 直接执行 DETACH DELETE 批量删除。改为默认 true，强制用户显式 dryRun:false 才执行删除。
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing (default true). Set to false only after reviewing the dry-run report.", default: true })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const mode = params.mode ?? "check";
      const isDryRun = params.dryRun ?? true;
      const lines: string[] = [];
      const push = (s: string) => lines.push(s);

      push(`# Data Sync: mode=${mode} dryRun=${isDryRun}\n`);

      // --- Phase 1: Compare lossless-claw conversation IDs with Neo4j ---
      push("## Phase 1: Conversation ↔ Neo4j entity cross-reference\n");
      let lcmConvIds = new Set<number>();
      let neo4jMsgNodes = 0;
      let orphanNodes = 0;
      let orphanedIds: string[] = [];

      let db: any = null;
      try {
        db = openDb();
        const convs = db.prepare("SELECT DISTINCT conversation_id FROM messages").all() as any[];
        lcmConvIds = new Set(convs.map((c: any) => c.conversation_id));
        push(`  lossless-claw: ${convs.length} active conversations\n`);
      } catch (e: any) { push(`  ❌ lossless-claw: ${e.message}\n`); }
      finally { if (db) { try { db.close(); } catch {} } }

      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const { driver, session } = await neo4jSession();
        try {
          // Find Neo4j nodes with sessionId property
          const allMsgNodes = await session.run(
            `MATCH (n:ConversationMessage) RETURN n.id AS id, n.sessionId AS sid LIMIT 5000`
          );
          neo4jMsgNodes = allMsgNodes.records.length;
          push(`  Neo4j: ${neo4jMsgNodes} ConversationMessage nodes\n`);

          // BUGFIX(P1-6): 批量 IN 查询替代逐行 COUNT，消除 N 次 SQLite 往返
          // SEC-3 H-6: db2 嵌套在 neo4j session 内，需独立 finally 清理
          let db2: any = null;
          try {
            db2 = openDb();
            const allSids = allMsgNodes.records
              .map((r: any) => r.get("sid"))
              .filter((s: any) => s && String(s).trim())
              .map((s: any) => String(s));
            const existingSids = new Set<string>();
            const BATCH = 500; // SQLite IN 参数分批，避免超 999 限制
            for (let i = 0; i < allSids.length; i += BATCH) {
              const batch = allSids.slice(i, i + BATCH);
              const placeholders = batch.map(() => '?').join(',');
              const rows = db2.prepare(
                `SELECT session_id FROM conversations WHERE session_id IN (${placeholders})`
              ).all(...batch) as any[];
              for (const row of rows) existingSids.add(String(row.session_id));
            }
            for (const rec of allMsgNodes.records) {
              const sid = rec.get("sid") ?? "";
              if (sid && !existingSids.has(String(sid))) {
                orphanNodes++;
                orphanedIds.push(rec.get("id") ?? sid);
              }
            }
          } finally { if (db2) { try { db2.close(); } catch {} } }
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { push(`  ❌ Neo4j: ${e.message}\n`); }

      if (orphanNodes > 0) {
        push(`  ⚠️ ${orphanNodes} orphaned Neo4j nodes (session no longer in lcm.db)\n`);
        if (orphanedIds.length <= 5) {
          for (const id of orphanedIds) push(`    - ${id}\n`);
        } else {
          push(`    First 5: ${orphanedIds.slice(0, 5).join(", ")}...\n`);
        }
      } else {
        push(`  ✅ No orphaned nodes found\n`);
      }

      // --- N-1 Phase 1.5: updatedAt timestamp drift detection ---
      // 跨端时间戳一致性校验：对比 lcm.db messages.created_at 与 Neo4j ConversationMessage.updatedAt。
      // 不一致 → 在 repair 模式下增量 MERGE 更新到 Neo4j（以 lcm.db 为权威源）。
      push("\n## Phase 1.5: updatedAt timestamp drift (N-1)\n");
      let driftCount = 0;
      const driftIds: string[] = [];
      let lcmDb2: any = null;
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const { driver, session } = await neo4jSession();
        try {
          // 取 Neo4j 中所有 ConversationMessage 的 updatedAt 与 sessionId
          const neo4jTsResult = await session.run(
            `MATCH (n:ConversationMessage)
             WHERE n.sessionId IS NOT NULL AND n.updatedAt IS NOT NULL
             RETURN n.id AS id, n.sessionId AS sid, n.updatedAt AS updatedAt, n.content AS content
             LIMIT 5000`
          );
          const neo4jRows = neo4jTsResult.records.map((r: any) => ({
            id: r.get("id"),
            sid: r.get("sid"),
            updatedAt: typeof r.get("updatedAt")?.toNumber === 'function'
              ? r.get("updatedAt").toNumber()
              : Number(r.get("updatedAt") ?? 0),
            content: r.get("content") ?? '',
          }));

          // BUGFIX(P1-6): 批量 GROUP BY 查询替代逐行 SELECT，消除 N 次 SQLite 往返
          // 一次性查出每个 conversation_id 的最新 created_at，内存中对比检测 drift
          const sidToLatestTs = new Map<string, number>();
          try {
            lcmDb2 = openDb();
            const allSids = neo4jRows.filter((r: any) => r.sid).map((r: any) => String(r.sid));
            const BATCH = 500; // SQLite IN 参数分批，避免超 999 限制
            for (let i = 0; i < allSids.length; i += BATCH) {
              const batch = allSids.slice(i, i + BATCH);
              const placeholders = batch.map(() => '?').join(',');
              const rows = lcmDb2.prepare(
                `SELECT conversation_id, MAX(created_at) AS ca FROM messages WHERE conversation_id IN (${placeholders}) GROUP BY conversation_id`
              ).all(...batch) as any[];
              for (const row of rows) {
                if (!row.ca) continue;
                // lcm.db created_at 是 'YYYY-MM-DD HH:MM:SS' 格式，转毫秒时间戳
                const ts = new Date(String(row.ca).replace(' ', 'T') + 'Z').getTime() || 0;
                if (ts > 0) sidToLatestTs.set(String(row.conversation_id), ts);
              }
            }
          } finally { if (lcmDb2) { try { lcmDb2.close(); } catch {} } }

          // 内存中检测 drift（时间戳差异超过 60s 视为 drift，容忍写延迟）
          const driftRows: Array<{ id: string; ts: number }> = [];
          for (const row of neo4jRows) {
            if (!row.sid) continue;
            const lcmTs = sidToLatestTs.get(String(row.sid));
            if (!lcmTs) continue;
            const diffMs = Math.abs(lcmTs - row.updatedAt);
            if (diffMs > 60_000) {
              driftCount++;
              if (driftIds.length < 10) driftIds.push(row.id);
              driftRows.push({ id: row.id, ts: lcmTs });
            }
          }

          push(`  Neo4j ConversationMessage with updatedAt: ${neo4jRows.length}\n`);
          push(`  Timestamp drift > 60s: ${driftCount}\n`);
          if (driftIds.length > 0) {
            push(`  Sample drift IDs: ${driftIds.join(", ")}\n`);
          }

          // N-1 Phase 1.5 repair: 增量 MERGE updatedAt（以 lcm.db 为权威源）
          // BUGFIX(P1-6): UNWIND 批量 MERGE 替代逐条 session.run，复用 check 阶段的 driftRows 无需再查 SQLite
          if (mode === "repair" && !isDryRun && driftCount > 0) {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            push(`\n  Repairing ${driftCount} drifted nodes via MERGE...\n`);
            let merged = 0;
            try {
              const updates = driftRows.map(d => ({ id: d.id, ts: neo4jDriver.int(d.ts) as any }));
              const BATCH = 500;
              for (let i = 0; i < updates.length; i += BATCH) {
                const batch = updates.slice(i, i + BATCH);
                const result = await session.run(
                  `UNWIND $updates AS u
                   MATCH (n:ConversationMessage {id: u.id})
                   SET n.updatedAt = u.ts, n.syncSource = 'lcm-db-merge', n.syncedAt = timestamp()
                   RETURN count(*) AS c`,
                  { updates: batch }
                );
                merged += result.records[0]?.get("c")?.toNumber?.() ?? batch.length;
              }
            } catch (e: any) { push(`  ⚠️ MERGE error: ${e.message}\n`); }
            push(`  ✅ MERGE'd ${merged} nodes with corrected updatedAt\n`);
          } else if (mode === "repair" && isDryRun && driftCount > 0) {
            push(`  (Dry run) Would MERGE ${driftCount} nodes with corrected updatedAt\n`);
          } else if (driftCount === 0) {
            push(`  ✅ No timestamp drift detected\n`);
          }
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { push(`  ❌ updatedAt drift check error: ${e.message}\n`); }

      // --- Phase 2: Check TTL-expired nodes (pinned? expired?) ---
      push("\n## Phase 2: TTL & pin status\n");
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const { driver, session } = await neo4jSession();
        try {
          const pinned = await session.run("MATCH (n {pinned: true}) RETURN count(n) AS c");
          push(`  Pinned nodes: ${pinned.records[0].get("c").toNumber()}\n`);
          const expiring = await session.run("MATCH (n) WHERE n.pinned IS NULL OR n.pinned = false RETURN count(n) AS c");
          push(`  Non-pinned (eligible for cleanup): ${expiring.records[0].get("c").toNumber()}\n`);
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { push(`  ❌ Neo4j: ${e.message}\n`); }

      // --- Phase 3: Repair if requested ---
      if (mode === "repair" && !isDryRun && orphanNodes > 0) {
        push("\n## Phase 3: Repairing\n");
        // P0-5 SEC-4: 删除数量上限保护，防止误删大量数据
        const MAX_DELETE = 1000;
        if (orphanNodes > MAX_DELETE) {
          push(`  ❌ Aborted: ${orphanNodes} orphan nodes exceed safety limit (${MAX_DELETE}). Re-run with explicit smaller scope or contact admin.\n`);
        } else {
          try {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            const { driver, session } = await neo4jSession();
            try {
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              for (const id of orphanedIds) {
                await session.run("MATCH (n {id: $id}) DETACH DELETE n", { id });
              }
              const deleted = orphanedIds.length;
              // P1-6: 批量清理查询逻辑修复。
              // 原查询 `NOT EXISTS { MATCH (m:ConversationMessage) WHERE m.id = n.id } AND n:ConversationMessage`
              // 中，子查询用同一 label 匹配同 id，节点自身即满足 EXISTS，NOT EXISTS 恒为 false，导致清理永远 0 删除。
              // 正确语义：删除那些 id 在 lossless-claw 会话消息表中已不存在的 ConversationMessage 节点。
              // 此处 orphanedIds 已在上面逐个删除，批量清理作为补充：删除剩余无任何关系的孤立 ConversationMessage。
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              const relCleanup = await session.run(
                `MATCH (n:ConversationMessage) WHERE NOT (n)--() DELETE n`
              );
              // P1-AUDIT: 批量清理结果从 Neo4j result summary 中提取实际删除数，
              // 修复前硬编码 moreDeleted=0，用户无法知道额外清理了多少节点。
              const moreDeleted = (relCleanup?.summary?.counters?.nodesDeleted?.() ?? 0) as number;
              push(`  ✅ Pruned ${deleted} orphan nodes, ${moreDeleted} additional via batch cleanup\n`);
            } finally { await closeNeo4j(driver, session); }
          } catch (e: any) { push(`  ❌ Repair error: ${e.message}\n`); }
        }
      } else if (mode === "repair" && orphanNodes === 0) {
        push("\n## Phase 3: No repair needed — all consistent\n");
      } else if (mode === "repair" && isDryRun) {
        push("\n## Phase 3: Dry run — would prune " + orphanNodes + " orphan nodes\n");
      }

      push("\n✅ Sync check complete.");
      return { content: [{ type: "text" as const, text: lines.join("") }], details: { ok: true } };
    },
  });
  // ===================================================================
  // 9. lcmg_qmd_status — QMD index health and collection info
  // ===================================================================
  api.registerTool({
    name: "lcmg_qmd_status",
    label: "QMD 状态",
    description: "Query QMD MCP service health: returns index stats (document count, vector dim), collection metadata, and service uptime. " +
      "Calls the 'status' tool on QMD's MCP server.",
    parameters: Type.Object({}),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // SEC-2 H-8: QmdClient 使用 try/finally 确保 dispose 释放 recoveryTimer
      // BUGFIX(P1-4): 复用注入的单例
      let qmd: any = null;
      let qmdOwned = false;
      try {
        const acquired = await acquireQmdClient();
        qmd = acquired.client; qmdOwned = acquired.owned;
        const [pingOk, statusText] = await Promise.all([
          qmd.ping().catch(() => false),
          qmd.status().catch(() => null),
        ]);
        const lines: string[] = [];
        lines.push("# QMD MCP Status\n");
        lines.push(`Health: ${pingOk ? "✅ OK" : "❌ Down"}`);
        if (statusText) {
          lines.push(`\nStatus output:\n${statusText}`);
        } else {
          lines.push("\nStatus: unavailable");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], details: { ok: false, error: `❌ Error: ${e.message}` }, isError: true };
      } finally {
        if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} }
      }
    },
  });

  // ===================================================================
  // 10. lcmg_get_document — Retrieve a document by path or docid
  // ===================================================================
  api.registerTool({
    name: "lcmg_get_document",
    label: "文档获取",
    description: "Fetch a single document from QMD document index. Accepts absolute file path or QMD docid. Returns full content with fuzzy matching suggestions when exact path is not found. " +
      "Returns full document content with fuzzy matching suggestions when exact path is not found.",
    parameters: Type.Object({
      file: Type.String({ description: "File path or docid to retrieve" }),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // SEC-2 H-8: QmdClient 使用 try/finally 确保 dispose 释放 recoveryTimer
      // BUGFIX(P1-4): 复用注入的单例
      let qmd: any = null;
      let qmdOwned = false;
      try {
        const acquired = await acquireQmdClient();
        qmd = acquired.client; qmdOwned = acquired.owned;
        const content = await qmd.get(params.file);
        if (content) {
          return { content: [{ type: "text" as const, text: content }], details: { ok: true } };
        }
        return { content: [{ type: "text" as const, text: `Document not found: ${params.file}` }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], details: { ok: false, error: `❌ Error: ${e.message}` }, isError: true };
      } finally {
        if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} }
      }
    },
  });

  // ===================================================================
  // 11. lcmg_batch_get — Batch retrieve documents by glob pattern
  // ===================================================================
  api.registerTool({
    name: "lcmg_batch_get",
    label: "批量获取",
    description: "Batch fetch documents from QMD index. Input formats: glob patterns (e.g. **/memory/*.md), comma-separated paths, or docid list. Max 50 docs per call. Returns array of {path, content, size}. " +
      "Returns multiple documents' content.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, comma-separated paths, or docid list" }),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // SEC-2 H-8: QmdClient 使用 try/finally 确保 dispose 释放 recoveryTimer
      // BUGFIX(P1-4): 复用注入的单例
      let qmd: any = null;
      let qmdOwned = false;
      try {
        const acquired = await acquireQmdClient();
        qmd = acquired.client; qmdOwned = acquired.owned;
        const results = await qmd.multiGet(params.pattern);
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No documents found for: ${params.pattern}` }], details: { ok: true } };
        }
        const lines = results.map((doc: string, i: number) => `--- Document ${i + 1} ---\n${doc}`);
        return { content: [{ type: "text" as const, text: lines.join("\n\n") }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], details: { ok: false, error: `❌ Error: ${e.message}` }, isError: true };
      } finally {
        if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} }
      }
    },
  });



  // ===================================================================
  // 12. lcmg_maintain - Trigger graph maintenance pipeline
  // ===================================================================
  api.registerTool({
    name: "lcmg_maintain",
    label: "图谱维护",
    description: "Trigger knowledge graph maintenance: dedup, PageRank, community detection. Also reconciles the compaction debt table (deletes orphaned debts for deleted conversations and tombstones older than 7 days).",
    parameters: Type.Object({}),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const driver = await getNeo4jDriver();
        // P3-3: 复用 graph-adapter 的统一路径解析（去除重复逻辑），并记录实际路径
        const { resolveGmProPath } = await import("./adapters/graph-adapter.js");
        const _resolved = resolveGmProPath();
        getGlobalLogger().info('[lcm-graph-extra] lcmg_maintain loading graph-memory-pro', { path: _resolved.path, source: _resolved.source });
        const GM_PRO_PATH = _resolved.path;

        const gm = await import(GM_PRO_PATH + "/dist/index.js");
        // P2-17: 用 buildGmConfig 统一构建，保留工具的特殊 override
        // (recallMaxNodes:10, pagerankIterations:20 与 GraphAdapter 默认不同)
        const { buildGmConfig } = await import("./adapters/graph-adapter.js");
        const cfg = buildGmConfig(
          resolveNeo4jConfig(getPluginNeo4jConfig()),
          { recallMaxNodes: 10, pagerankIterations: 20 },
        );
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const result = await gm.runMaintenance(driver, cfg);
        const lines = [];
        lines.push("# Graph Maintenance Report");
        lines.push("");
        lines.push("Duration: " + (result?.durationMs ?? 0) + "ms");
        lines.push("Dedup merged: " + (result?.dedup?.mergedCount ?? 0) + " nodes");
        lines.push("PageRank top: " + (result?.pagerank?.topK?.length ?? 0) + " nodes");
        lines.push("Communities detected: " + (result?.community?.communities?.size ?? 0));
        lines.push("Community summaries: " + (result?.communitySummaries ?? 0));

        // P0-3: 顺带对账债务表 —— 删除孤儿债务与过期墓碑，避免表无限增长。
        // lcmg_maintain 是手动维护入口，应覆盖债务表清理而不仅是图分析。
        try {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const { reconcileDebtTable } = await import("./core/debt-manager.js");
          const r = reconcileDebtTable();
          lines.push("");
          lines.push("Debt table reconciled:");
          lines.push("  Orphans deleted: " + r.orphaned);
          lines.push("  Tombstones deleted: " + r.tombstones);
        } catch (debtErr) {
          lines.push("");
          lines.push("Debt reconcile skipped: " + (debtErr instanceof Error ? debtErr.message : String(debtErr)));
        }

        lines.push("");
        lines.push("[OK] Maintenance complete.");

        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { ok: true } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: "Maintenance failed: " + msg }], details: { ok: false, error: "Maintenance failed: " + msg }, isError: true };
      }
    },
  });

  // ===================================================================
  // 13. lcmg_distill —— 手动触发经验蒸馏（PENDING → DISTILLED）
  // ===================================================================
  api.registerTool({
    name: "lcmg_distill",
    label: "经验蒸馏",
    description: "手动触发经验蒸馏。从 PENDING 经验中批量蒸馏为 DISTILLED，调用 LLM 提取结构化经验。limit 控制单次处理数量。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({
        description: "最大蒸馏数量，默认 50",
        minimum: 1,
        maximum: 200,
      })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      if (!dashboardContext?.runDistillation) {
        return {
          content: [{ type: "text" as const, text: "Error: dashboard context not available" }],
          details: { ok: false, error: "Error: dashboard context not available" },
          isError: true,
        };
      }
      const limit = params.limit ?? 50;
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        await dashboardContext.runDistillation(limit);
        return {
          content: [{
            type: "text" as const,
            text: `✅ Distillation triggered for up to ${limit} pending experience(s).`,
          }],
          details: { ok: true },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ Distillation failed: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ Distillation failed: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  });

  // ===================================================================
  // 14. lcmg_compact —— 手动触发指定会话的 compact
  // ===================================================================
  api.registerTool({
    name: "lcmg_compact",
    label: "上下文压缩",
    description: "手动触发指定会话的 compact。无 conversationId 时触发最紧急的债务。用于手动控制上下文压缩。",
    parameters: Type.Object({
      conversationId: Type.Optional(Type.Number({
        description: "目标会话 ID，省略则处理最紧急债务",
      })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      if (!dashboardContext?.triggerCompact) {
        return {
          content: [{ type: "text" as const, text: "Error: dashboard context not available" }],
          details: { ok: false, error: "Error: dashboard context not available" },
          isError: true,
        };
      }
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const ok = await dashboardContext.triggerCompact(params.conversationId);
        const target = params.conversationId != null
          ? `conversation ${params.conversationId}`
          : 'most urgent debt';
        return {
          content: [{
            type: "text" as const,
            text: ok
              ? `✅ Compact completed for ${target}.`
              : `⚠️ Compact triggered for ${target} but did not produce a summary (may retry).`,
          }],
          details: { ok: true },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ Compact failed: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ Compact failed: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  });

  // ===================================================================
  // 15. lcmg_reset_breaker —— 重置指定子系统的熔断器状态
  // ===================================================================
  api.registerTool({
    name: "lcmg_reset_breaker",
    label: "熔断重置",
    description: "重置指定子系统的熔断器状态。name: lcm/qmd/neo4j。neo4j 还会重置 GraphAdapter 连接失败标志，允许立即重试连接。",
    parameters: Type.Object({
      name: Type.String({ description: "子系统名: lcm | qmd | neo4j" }),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const name = params.name;
      if (!['lcm', 'qmd', 'neo4j'].includes(name)) {
        return {
          content: [{ type: "text" as const, text: `Error: 无效的子系统名: ${name}（支持 lcm/qmd/neo4j）` }],
          details: { ok: false, error: `Error: 无效的子系统名: ${name}（支持 lcm/qmd/neo4j）` },
          isError: true,
        };
      }
      try {
        // resetCircuitBreaker 是模块级函数，动态导入避免循环依赖
        const { resetCircuitBreaker } = await import('./circuit-breaker.js');
        const reset = resetCircuitBreaker(name);
        // neo4j 额外重置 graphAdapter 连接标志（通过注入的回调，graphAdapter 在 index.ts 闭包内）
        let adapterReset = false;
        if (name === 'neo4j' && dashboardContext?.resetBreaker) {
          adapterReset = dashboardContext.resetBreaker(name);
        }
        return {
          content: [{
            type: "text" as const,
            text: reset
              ? `✅ Circuit breaker reset for "${name}"${name === 'neo4j' ? (adapterReset ? ' + GraphAdapter connect flag reset' : '') : ''}.`
              : `❌ Failed to reset circuit breaker for "${name}".`,
          }],
          details: { ok: true },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ Reset breaker failed: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ Reset breaker failed: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  });

  // ===================================================================
  // 16. lcmg_config_get —— 查看运行时配置（脱敏）
  // v1.1.0-6: 提供 MCP 工具读取 openclaw.json 配置
  // ===================================================================
  api.registerTool({
    name: "lcmg_config_get",
    label: "配置查看",
    description: "查看 lcm-graph-extra 运行时配置（从 ~/.openclaw/openclaw.json 读取，敏感字段已脱敏）。可选指定 path 参数获取特定字段，例如 'neo4j' 或 'lcmMonitor.contextWindow'。",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "点分路径，例如 'neo4j' 或 'lcmMonitor.contextWindow'。省略则返回全部配置" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const configPath = join(homedir(), '.openclaw', 'openclaw.json');
        if (!existsSync(configPath)) {
          return {
            content: [{ type: "text" as const, text: `⚠️ 配置文件不存在: ${configPath}` }],
            details: { ok: false, error: 'config file not found' },
          };
        }
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        // 提取 lcm-graph-extra 配置段
        let config: Record<string, unknown>;
        const entriesConfig = parsed?.plugins?.entries?.['lcm-graph-extra']?.config;
        if (entriesConfig && typeof entriesConfig === 'object') {
          config = entriesConfig as Record<string, unknown>;
        } else {
          config = parsed as Record<string, unknown>;
        }

        // 脱敏敏感字段
        const redacted = redactConfigSecrets(config) as Record<string, unknown>;

        // 按路径提取子字段
        let result: unknown = redacted;
        if (params.path) {
          result = getByPathConfig(redacted, params.path);
          if (result === undefined) {
            return {
              content: [{ type: "text" as const, text: `❌ 字段不存在: ${params.path}` }],
              details: { ok: false, error: `field not found: ${params.path}` },
              isError: true,
            };
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: `📋 运行时配置${params.path ? ` (${params.path})` : ''}:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
          }],
          details: { ok: true, config: result, configPath },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ 读取配置失败: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ 读取配置失败: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  });

  // ===================================================================
  // 17. lcmg_config_set —— 更新配置字段（白名单）
  // v1.1.0-6: 提供 MCP 工具热更新 openclaw.json 中的白名单字段
  // ===================================================================
  api.registerTool({
    name: "lcmg_config_set",
    label: "配置更新",
    description: "更新 lcm-graph-extra 运行时配置（写入 ~/.openclaw/openclaw.json）。仅允许白名单内的性能/行为参数，禁止修改安全相关字段。path 用点分路径如 'lcmMonitor.contextWindow'，value 为新值。部分字段需重启插件进程生效。",
    parameters: Type.Object({
      path: Type.String({ description: "点分路径，如 'maxTokens'、'lcmMonitor.contextWindow'、'compaction.triggerThreshold'、'experience.enabled'" }),
      value: Type.Any({ description: "新值（类型需匹配字段：number/boolean/string）" }),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const { path: fieldPath, value } = params;
      if (!fieldPath || typeof fieldPath !== 'string') {
        return {
          content: [{ type: "text" as const, text: '❌ path 参数必填' }],
          details: { ok: false, error: 'path is required' },
          isError: true,
        };
      }

      // 白名单校验
      const allowed = CONFIG_UPDATABLE_WHITELIST[fieldPath];
      if (!allowed) {
        const available = Object.keys(CONFIG_UPDATABLE_WHITELIST).sort();
        return {
          content: [{
            type: "text" as const,
            text: `❌ 字段 "${fieldPath}" 不在可更新白名单中。\n\n可更新字段:\n${available.map((p) => `  - ${p}: ${CONFIG_UPDATABLE_WHITELIST[p].description}`).join('\n')}`,
          }],
          details: { ok: false, error: `field not updatable: ${fieldPath}`, allowed: available },
          isError: true,
        };
      }

      // 类型校验
      if (!validateConfigValue(value, allowed.type)) {
        return {
          content: [{ type: "text" as const, text: `❌ 值类型错误: 期望 ${allowed.type}, 实际 ${typeof value}` }],
          details: { ok: false, error: `type mismatch: expected ${allowed.type}, got ${typeof value}` },
          isError: true,
        };
      }

      try {
        const configPath = join(homedir(), '.openclaw', 'openclaw.json');
        // 读取现有配置
        let root: Record<string, unknown> = {};
        if (existsSync(configPath)) {
          root = JSON.parse(readFileSync(configPath, 'utf-8'));
        }
        // 确保路径结构
        if (!root.plugins) root.plugins = {};
        if (!(root.plugins as Record<string, unknown>).entries) {
          (root.plugins as Record<string, unknown>).entries = {};
        }
        const entries = (root.plugins as Record<string, unknown>).entries as Record<string, unknown>;
        if (!entries['lcm-graph-extra']) entries['lcm-graph-extra'] = {};
        const pluginEntry = entries['lcm-graph-extra'] as Record<string, unknown>;
        if (!pluginEntry.config) pluginEntry.config = {};
        const config = pluginEntry.config as Record<string, unknown>;

        // 设置嵌套值
        setByPathConfig(config, fieldPath, value);
        writeFileSync(configPath, JSON.stringify(root, null, 2), 'utf-8');

        return {
          content: [{
            type: "text" as const,
            text: `✅ 配置已更新: ${fieldPath} = ${JSON.stringify(value)}\n\n⚠️ 部分字段需重启插件进程才能生效。`,
          }],
          details: { ok: true, path: fieldPath, value, configPath },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ 更新配置失败: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ 更新配置失败: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// v1.1.0-6: 配置工具辅助函数
// ---------------------------------------------------------------------------

/** 敏感字段 key 模式（与 operation-logs.ts redactSensitive 保持一致） */
const CONFIG_SENSITIVE_KEYS = [
  'password', 'passwd', 'pwd',
  'apikey', 'api_key', 'api-key',
  'token', 'secret',
  'credential', 'auth',
];

/** 递归脱敏配置中的敏感字段 */
function redactConfigSecrets(value: unknown, depth: number = 0): unknown {
  if (depth > 10) return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactConfigSecrets(v, depth + 1));
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = CONFIG_SENSITIVE_KEYS.some((p) => lowerKey.includes(p));
    if (isSensitive) {
      result[key] = '***REDACTED***';
    } else {
      result[key] = redactConfigSecrets(obj[key], depth + 1);
    }
  }
  return result;
}

/** 按点分路径获取嵌套值 */
function getByPathConfig(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 按点分路径设置嵌套值 */
function setByPathConfig(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!(p in cur) || typeof cur[p] !== 'object' || cur[p] === null) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** 验证值类型 */
function validateConfigValue(value: unknown, expected: 'number' | 'boolean' | 'string'): boolean {
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'string') return typeof value === 'string';
  return false;
}

/** v1.1.0-6: 可热更新字段白名单 */
const CONFIG_UPDATABLE_WHITELIST: Record<string, { type: 'number' | 'boolean' | 'string'; description: string }> = {
  'summaryStrategy': { type: 'string', description: '摘要策略：strategy | hybrid | full' },
  'maxGraphDepth': { type: 'number', description: '图谱最大遍历深度' },
  'maxNodeCount': { type: 'number', description: '单次检索最大节点数' },
  'maxTokens': { type: 'number', description: '上下文 token 预算' },
  'budgetRatio': { type: 'number', description: '上下文预算占比（0-1）' },
  'distillationIntervalMs': { type: 'number', description: '蒸馏间隔（毫秒）' },
  'cliTimeout': { type: 'number', description: 'CLI 超时（毫秒）' },
  'compaction.triggerThreshold': { type: 'number', description: '触发压缩的消息阈值' },
  'compaction.softThresholdTokens': { type: 'number', description: '软阈值 token 数' },
  'compaction.keepRecentTokens': { type: 'number', description: '保留近期 token 数' },
  'experience.enabled': { type: 'boolean', description: '是否启用经验提取' },
  'experience.relevanceThreshold': { type: 'number', description: '经验相关性阈值（0-1）' },
  'ttl.enabled': { type: 'boolean', description: '是否启用 TTL 清理' },
  'ttl.retentionDays': { type: 'number', description: 'TTL 保留天数' },
  'ttl.cleanupIntervalHours': { type: 'number', description: '清理间隔（小时）' },
  'retrieval.limits.qmd': { type: 'number', description: 'QMD 检索条数' },
  'retrieval.limits.graph': { type: 'number', description: '图谱检索条数' },
  'retrieval.limits.exp': { type: 'number', description: '经验检索条数' },
  'lcmMonitor.contextWindow': { type: 'number', description: '上下文窗口大小（tokens）' },
  'lcmMonitor.highPressureThreshold': { type: 'number', description: '高压阈值（0-1）' },
  'lcmMonitor.mediumPressureThreshold': { type: 'number', description: '中压阈值（0-1）' },
  'lcmMonitor.proactiveThreshold': { type: 'number', description: '主动触发阈值（0-1）' },
};