/**
 * tools/shared.ts — 共享工具函数和基础设施
 *
 * 从 tools.ts 提取，供所有工具子模块导入。
 * 避免循环依赖：本模块不导入任何工具子模块。
 */

import { Type } from "typebox";
import * as neo4jDriver from 'neo4j-driver';
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { resolveNeo4jConfig, resolveEmbeddingConfig } from '../config/neo4j-helper';
import { getGlobalLogger } from '../utils/logger.js';
import { cleanBaseURL } from '../utils/url.js';
import { callLlm } from '../utils/llm-call.js';
import { llmTimeout } from '../config/defaults.js';
import { resolveDistillationLlm } from '../plugin/distillation.js';

const _lcmRequire = createRequire(import.meta.url);

// ── Module-level state ──

let _pluginNeo4jConfig: Record<string, unknown> | undefined;
let _pluginQmdUrl = "http://127.0.0.1:8081";
let _sharedQmdClient: any = null;
let _pluginApiRef: any = null;  // SDK api reference，用于 resolveDistillationLlm

export function setPluginNeo4jConfig(cfg: Record<string, unknown> | undefined): void {
  _pluginNeo4jConfig = cfg;
}

export function setPluginApiRef(apiRef: any): void {
  _pluginApiRef = apiRef;
}

// ── 三级节点重建：完全复用 gm-pro HTTP API ──
// 本地不再自建重建逻辑，改为触发 graph-memory-pro 的 POST /api/extract/rebuild-all。
// 供 lcmg_import 导入后自动调度（默认 heuristic 快速提取）复用。

/**
 * 触发 gm-pro 批量重建全部会话（POST /api/extract/rebuild-all）。
 * 返回是否成功；失败不抛错（调用方 fire-and-forget）。
 */
export async function triggerGmProRebuildAll(
  opts: {
    mode?: 'llm' | 'heuristic';
    sessionConcurrency?: number;
    progressPath?: string;
    limitSessions?: number;
  } = {},
): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = (process.env.GM_PRO_HTTP_URL || 'http://127.0.0.1:7850').replace(/\/+$/, '');
  // 鉴权令牌：与 dashboard gm-pro 代理同一来源（openclaw.json graph-memory-pro 配置段 apiServer.authToken）
  let authToken = '';
  try {
    const p = homedir() + '/.openclaw/openclaw.json';
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      authToken = d?.plugins?.entries?.['graph-memory-pro']?.config?.apiServer?.authToken ?? '';
    }
  } catch { /* 读不到令牌则不带鉴权头 */ }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['x-auth-token'] = authToken;
  const body: Record<string, unknown> = {
    mode: opts.mode ?? 'heuristic',
    sessionConcurrency: opts.sessionConcurrency ?? 2,
  };
  if (opts.progressPath) body.progressPath = opts.progressPath;
  if (opts.limitSessions != null && opts.limitSessions > 0) body.limitSessions = opts.limitSessions;
  try {
    const resp = await fetch(`${baseUrl}/api/extract/rebuild-all`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { ok: false, error: `gm-pro HTTP ${resp.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function getPluginNeo4jConfig(): Record<string, unknown> | undefined {
  return _pluginNeo4jConfig;
}

export function setSharedQmdClient(client: any): void {
  _sharedQmdClient = client;
}

// ── QMD ──

export function getQmdBaseUrl(): string {
  return _pluginQmdUrl;
}

export async function acquireQmdClient(): Promise<{ client: any; owned: boolean }> {
  if (_sharedQmdClient && typeof _sharedQmdClient.query === 'function') {
    return { client: _sharedQmdClient, owned: false };
  }
  const { QmdClient } = await import("../qmd-client.js");
  return { client: new QmdClient({ mcpBaseUrl: getQmdBaseUrl() }), owned: true };
}

// ── SQLite DB ──

export const LCM_DB = resolve(homedir(), '.openclaw', 'lcm.db');

let _sharedDb: any = null;

export function openDb(): any {
  if (_sharedDb) {
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

export function closeSharedDb(): void {
  if (_sharedDb) {
    try { _sharedDb.close(); } catch {}
    _sharedDb = null;
  }
}

// ── Path validation ──

export function validateBackupPath(p: string): string {
  const allowedRoot = resolve(homedir(), '.openclaw');
  const abs = resolve(p);
  if (abs !== allowedRoot && !abs.startsWith(allowedRoot + sep)) {
    throw new Error(`path must be under ${allowedRoot}`);
  }
  return abs;
}

// ── FTS5 ──

export function escapeFts5Query(q: string): string {
  return '"' + q.replace(/"/g, '""') + '"';
}

// ── Time range ──

export function parseTimeRange(from?: string, to?: string): { fromTs: number | null; toTs: number | null } {
  const now = Date.now();
  const parseOne = (val: string | undefined, isFrom: boolean): number | null => {
    if (!val || !val.trim()) return null;
    const v = val.trim().toLowerCase();
    const relMatch = v.match(/^(\d+)([dhm])$/);
    if (relMatch) {
      const num = parseInt(relMatch[1], 10);
      const unit = relMatch[2];
      const ms = unit === 'd' ? num * 24 * 60 * 60 * 1000 : unit === 'h' ? num * 60 * 60 * 1000 : num * 60 * 1000;
      return isFrom ? now - ms : now;
    }
    if (v === '今天' || v === 'today') return isFrom ? new Date(now).setHours(0, 0, 0, 0) : now;
    if (v === '昨天' || v === 'yesterday') {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return isFrom ? y.setHours(0, 0, 0, 0) : y.setHours(23, 59, 59, 999);
    }
    if (v === '本周' || v === 'this week') {
      const d = new Date(now); const day = d.getDay() || 7;
      d.setDate(d.getDate() - day + 1);
      return isFrom ? d.setHours(0, 0, 0, 0) : now;
    }
    if (v === '本月' || v === 'this month') {
      const d = new Date(now); d.setDate(1);
      return isFrom ? d.setHours(0, 0, 0, 0) : now;
    }
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) return parsed;
    return null;
  };
  return { fromTs: parseOne(from, true), toTs: parseOne(to, false) };
}

// ── LLM summary helper ──

export async function generateExperienceSummary(
  records: any[],
  usedExperienceNodes: boolean,
  timeFilter: { fromTs: number | null; toTs: number | null },
): Promise<string> {
  const experiences = records.slice(0, 30).map((rec: any) => ({
    name: rec.get("e.name") ?? "Unknown",
    type: usedExperienceNodes ? (rec.get("e.communityId") ?? "lesson") : "event",
    desc: (rec.get("e.description") ?? "").slice(0, 200),
    seen: neo4jToNumber(rec.get("e.validatedCount")),
    confidence: ((Number(rec.get("e.pagerank") ?? 0)) * 100).toFixed(0) + "%",
  }));
  const total = records.length;
  const fromStr = timeFilter.fromTs ? new Date(timeFilter.fromTs).toLocaleDateString() : "beginning";
  const toStr = timeFilter.toTs ? new Date(timeFilter.toTs).toLocaleDateString() : "now";

  try {
    // 使用 resolveDistillationLlm 统一解析 LLM 配置，优先复用主模型（避免 GPU 竞争）
    const llmCfg = _pluginApiRef ? resolveDistillationLlm(_pluginApiRef) : null;
    const model = llmCfg?.model;
    const apiKey = llmCfg?.apiKey || '';
    const baseURL = llmCfg?.baseURL ? cleanBaseURL(llmCfg.baseURL) : cleanBaseURL('http://127.0.0.1:18789/v1');
    const keepAlive = llmCfg?.keepAlive || '1h';
    if (model) {
      const expList = experiences.map((e, i) => `${i + 1}. [${e.type}] ${e.name} (${e.confidence}, seen ${e.seen}) - ${e.desc}`).join('\n');
      const prompt = `Based on the following ${total} experiences (time range: ${fromStr} to ${toStr}), write a concise natural language summary in the user's language. Group by theme, highlight key lessons learned, and note patterns. Keep it under 500 words.\n\nExperiences:\n${expList}`;
      try {
        const result = await callLlm({
          baseURL,
          apiKey,
          model,
          prompt,
          temperature: 0.4,
          maxTokens: 800,
          keepAlive,
          signal: AbortSignal.timeout(llmTimeout('summarizeTimeoutMs')),
        });
        if (result.text?.trim()) {
          return `## 经验回顾摘要\n\n**时间范围**: ${fromStr} → ${toStr}\n**总数**: ${total} 条经验\n\n${result.text.trim()}`;
        }
      } catch {
        /* non-fatal, fall through to text summary */
      }
    }
  } catch (e) {
    getGlobalLogger()?.debug?.("experience review LLM summary failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
  }

  const lines: string[] = [`## 经验回顾摘要`, ``, `**时间范围**: ${fromStr} → ${toStr}`, `**总数**: ${total} 条经验`, ``];
  const byType: Record<string, typeof experiences> = {};
  for (const e of experiences) { const t = e.type || "other"; if (!byType[t]) byType[t] = []; byType[t].push(e); }
  for (const [type, exps] of Object.entries(byType)) {
    lines.push(`### ${type} (${exps.length} 条)`);
    for (const e of exps.slice(0, 5)) lines.push(`- ${e.name} (${e.confidence}) — ${e.desc.slice(0, 100)}`);
    if (exps.length > 5) lines.push(`- ... 及其他 ${exps.length - 5} 条`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Neo4j ──

export function neo4jToNumber(val: any): number {
  if (val === null || val === undefined) return 0;
  if (typeof val?.toNumber === 'function') return val.toNumber();
  if (typeof val === 'number') return val;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

let _neo4jDriver: any = null;
let _neo4jDriverReady: Promise<any> | null = null;

export async function getNeo4jDriver(): Promise<any> {
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
      _neo4jDriverReady = null;
      throw e;
    }
  })();
  return _neo4jDriverReady;
}

export async function neo4jSession(): Promise<{ driver: any; session: any }> {
  const driver = await getNeo4jDriver();
  return { driver, session: driver.session() };
}

export async function closeNeo4j(driver: any, session: any): Promise<void> {
  try { await session.close(); } catch {}
}

export async function closeNeo4jDriver(): Promise<void> {
  if (_neo4jDriver) {
    try { await _neo4jDriver.close(); } catch {}
    _neo4jDriver = null;
    _neo4jDriverReady = null;
  }
}

// ── Config merging ──

export function mergeEntriesNeo4jConfig(api: any): Record<string, unknown> {
  const config = { ...(api.config || {}), ...(api.pluginConfig || {}) } as Record<string, unknown>;
  if (config && 'neo4j' in config && (config.neo4j as any)?.uri) return config;
  const openclawPath = join(homedir(), '.openclaw/openclaw.json');
  if (existsSync(openclawPath)) {
    try {
      const raw = readFileSync(openclawPath, 'utf8');
      const data = JSON.parse(raw);
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

// ── Neo4j 版别检测 + Schema 自动初始化 ──
// 对齐 gm-pro v2.4.1 的版本适配逻辑：
//   - 企业版：自动启用多数据库物理隔离 (withDatabase) + 精细 HNSW/量化向量索引参数
//   - 社区版/未知：自动跳过多库切库、跳过不可用的量化/HNSW 精细选项，走逻辑隔离 + 基础索引
// 所有 Neo4j 工具（lcmg_import / lcmg_restore / lcmg_sync 等）写入前调 ensureNeo4jSchema()，
// 幂等自动建索引与约束，无需手动执行。

export type Neo4jEdition = "Enterprise" | "Community" | null;

let _cachedEdition: Neo4jEdition = null;
let _schemaReady: Promise<void> | null = null;

export function getCachedEdition(): Neo4jEdition { return _cachedEdition; }
export function setCachedEdition(edition: Neo4jEdition): void { _cachedEdition = edition; }

/** 判断缓存的 edition 是否支持多数据库物理隔离（仅 Enterprise） */
export function cachedEditionSupportsMultiDb(): boolean {
  return _cachedEdition === "Enterprise";
}

/**
 * 检测连接的 Neo4j 版本代号（CALL dbms.components() YIELD edition）。
 * 返回 "Enterprise" / "Community"，检测失败返回 null（不阻塞，调用方按保守处理）。
 */
export async function detectNeo4jEdition(): Promise<Neo4jEdition> {
  try {
    const driver = await getNeo4jDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        "CALL dbms.components() YIELD name, edition WHERE name = 'Neo4j Kernel' RETURN edition",
      );
      const edition = result.records[0]?.get("edition");
      const s = edition ? String(edition).toLowerCase() : "";
      if (s.includes("enterprise")) return "Enterprise";
      if (s.includes("community")) return "Community";
      return null;
    } finally { await session.close(); }
  } catch {
    // dbms.components() 可能因权限或版本不可用，静默失败
    return null;
  }
}

/**
 * 幂等建立 Neo4j schema（约束 + 全文索引 + 向量索引）。
 * 对齐 gm-pro v2.4.1：按版别选用向量索引精细参数。
 *  - Enterprise：m=16 / ef_construction=128 / ef_search=64 / scalar 量化
 *  - Community/未知：跳过量化和 HNSW 精细选项，仅基础 multi-label 向量索引
 * 任一语句失败仅吞掉（IF NOT EXISTS 幂等；老版本不支持时回落过程化调用），不阻塞调用方。
 */
export async function ensureNeo4jSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    try {
      const driver = await getNeo4jDriver();
      const session = driver.session();
      try {
        // 版别检测（缓存，供多库隔离 / 向量索引选参）
        if (_cachedEdition === null) {
          _cachedEdition = await detectNeo4jEdition();
        }
        const isEnterprise = _cachedEdition === "Enterprise";
        const log = getGlobalLogger();
        log?.info?.(`[lcm-graph-extra] Neo4j edition: ${_cachedEdition ?? "unknown"} (multi-db isolation: ${isEnterprise ? "enabled" : "not available — logical isolation"})`);

        // 约束：各业务标签 id 唯一（自动建索引，消除 MERGE/MATCH 全图扫描）
        const idConstraints: Array<[string, string]> = [
          ["ConversationMessage", "lcm_msg_id"],
          ["MemoryFile", "lcm_mem_id"],
          ["Task", "lcm_task_id"],
          ["Skill", "lcm_skill_id"],
          ["Event", "lcm_event_id"],
          ["GmMessage", "lcm_gm_msg_id"],
        ];
        for (const [label, name] of idConstraints) {
          try {
            await session.run(`CREATE CONSTRAINT ${name} IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
          } catch { /* may exist */ }
        }

        // 全文索引：全文搜索（cjk 分析器，中文友好）
        const fulltext: Array<[string, string, string]> = [
          ["task_search", "Task", "[n.name, n.description, n.content]"],
          ["skill_search", "Skill", "[n.name, n.description, n.content]"],
          ["event_search", "Event", "[n.name, n.description, n.content]"],
          ["conversation_search", "ConversationMessage", "[n.content]"],
        ];
        for (const [name, label, props] of fulltext) {
          try {
            await session.run(`CREATE FULLTEXT INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON EACH ${props} OPTIONS { analyzer: "cjk" }`);
          } catch { /* may exist */ }
        }

        // 向量索引（Neo4j 5.11+）：跨 Task|Skill|Event 单索引
        // 企业版启用精细 HNSW + 量化（针对 NAS/内存有限场景）；社区版仅基础参数
        const dim = resolveEmbeddingConfig(getPluginNeo4jConfig())?.dimensions ?? 1024;
        try {
          if (isEnterprise) {
            await session.run(`
              CREATE VECTOR INDEX gm_node_embedding IF NOT EXISTS
              FOR (n:Task|Skill|Event) ON n.embedding
              OPTIONS {
                indexConfig: {
                  \`vector.dimensions\`: ${dim},
                  \`vector.similarity_function\`: 'cosine',
                  \`vector.quantization.type\`: 'scalar',
                  \`vector.hnsw.m\`: 16,
                  \`vector.hnsw.ef_construction\`: 128,
                  \`vector.hnsw.ef_search\`: 64
                }
              }
            `);
          } else {
            await session.run(`
              CREATE VECTOR INDEX gm_node_embedding IF NOT EXISTS
              FOR (n:Task|Skill|Event) ON n.embedding
              OPTIONS {
                indexConfig: {
                  \`vector.dimensions\`: ${dim},
                  \`vector.similarity_function\`: 'cosine'
                }
              }
            `);
          }
        } catch {
          // 老版本不支持 CREATE VECTOR INDEX / 多 label 选项 → 回落过程化调用
          try {
            await session.run(
              `CALL db.index.vector.createNodeIndex('gm_node_embedding', ['Task', 'Skill', 'Event'], 'embedding', ${dim}, 'cosine')`,
            );
          } catch { /* may exist or version < 5.11 */ }
        }
      } finally { await session.close(); }
    } catch (e) {
      // schema 初始化失败不阻塞工具主体（仅降低后续查询性能）
      getGlobalLogger()?.warn?.("[lcm-graph-extra] ensureNeo4jSchema failed", { err: e instanceof Error ? e.message : String(e) });
    }
  })();
  return _schemaReady;
}

// ── Tool handler registry ──

const _registeredToolHandlers = new Map<string, (toolCallId: string, params: any, signal?: AbortSignal) => Promise<any>>();

export function getRegisteredToolHandler(name: string): ((toolCallId: string, params: any, signal?: AbortSignal) => Promise<any>) | undefined {
  return _registeredToolHandlers.get(name);
}

export function _resetRegisteredToolHandlers(): void {
  _registeredToolHandlers.clear();
}

export function registerToolHandler(name: string, handler: (toolCallId: string, params: any, signal?: AbortSignal) => Promise<any>): void {
  _registeredToolHandlers.set(name, handler);
}

// ── DashboardToolContext ──

export interface DashboardToolContext {
  expStore?: any;
  runDistillation?: (limit: number) => Promise<any>;
  backfillExperiences?: (limit: number, force?: boolean) => Promise<{ processed: number; extracted: number; skipped: number; errors: string[]; neo4jTotal?: number; neo4jPending?: number; neo4jByStatus?: Record<string, number> }>;
  triggerCompact?: (conversationId?: number) => Promise<boolean>;
  resetBreaker?: (name: string) => boolean;
  qmdClient?: any;
}

// ── Audit wrapper factory ──

export function createAuditWrapper(originalRegisterTool: any) {
  return (toolDef: any, opts?: any) => {
    if (!toolDef || !toolDef.name || typeof toolDef.execute !== 'function') {
      return originalRegisterTool(toolDef, opts);
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
        if (result?.isError === true) status = 'failure';
      } catch (e) {
        status = 'failure';
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        try {
          let appendOperationLog: ((entry: any) => void) | null = null;
          for (const candidate of [
            '../packages/dashboard/server/lib/operation-logs.js',
            '../packages/dashboard/dist-server/lib/operation-logs.js',
          ]) {
            try {
              const mod = _lcmRequire(candidate);
              if (typeof mod?.appendOperationLog === 'function') { appendOperationLog = mod.appendOperationLog; break; }
            } catch { /* next */ }
          }
          if (appendOperationLog) {
            appendOperationLog({
              ts: startTs, tool: toolName, params: params ?? {}, result: result ?? null,
              status, durationMs: Date.now() - startTs, error,
              user: params?.user ?? params?._user ?? undefined,
              sessionId: toolCallId ?? params?._sessionId ?? undefined,
            });
          }
        } catch { /* silent */ }
      }
      return result;
    };
    registerToolHandler(toolName, toolDef.execute);
    return originalRegisterTool(toolDef, opts);
  };
}