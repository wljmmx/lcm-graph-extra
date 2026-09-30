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
import { resolveNeo4jConfig, resolveEmbeddingConfig, resolveVectorIndexProvider } from '../config/neo4j-helper';
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
 *
 * 接口契约（graph-memory-pro v2.4.7 `src/routes/crud.ts` → `handleRebuildAll`）：
 *   - body: { mode?, sessionConcurrency?, concurrency?, limitSessions?, pageSize?,
 *            writeBatchSize?, progressPath?, includeMemorySessions?,
 *            excludeSessionKeySubstrings?, markProcessed? }
 *   - `sessionConcurrency` 默认 2、上限 64；`limitSessions` 默认 0 = **全部**（上限 100000）
 *   - 鉴权：POST 恒需 `x-auth-token`（当 gm-pro 配置了 apiServer.authToken）
 *   - 响应：**立即 202** `{ jobId, status: "running", message }`，进度轮询
 *     `GET /api/extract/rebuild-all/job/:jobId`
 *
 * 地址来源与令牌同源：均取 openclaw.json 中 graph-memory-pro 的 `apiServer` 段
 * （host/port/authToken），避免用户改端口后触发打到默认 7850。env `GM_PRO_HTTP_URL` 优先。
 *
 * 返回是否成功 + jobId（调用方 fire-and-forget，但需把 jobId 透出给用户轮询）。
 */
export async function triggerGmProRebuildAll(
  opts: {
    mode?: 'llm' | 'heuristic';
    sessionConcurrency?: number;
    progressPath?: string;
    /** 上游默认 0 = 全部会话；显式 >0 才限制数量 */
    limitSessions?: number;
    /** 调用方的取消信号（工具 AbortSignal），透传给 fetch */
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: boolean; error?: string; jobId?: string; status?: string }> {
  // 与令牌同源读取 apiServer.host/port（上游默认 127.0.0.1:7850）
  let apiServer: Record<string, unknown> | undefined;
  let authToken = '';
  try {
    const p = homedir() + '/.openclaw/openclaw.json';
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      apiServer = d?.plugins?.entries?.['graph-memory-pro']?.config?.apiServer;
      authToken = (apiServer?.authToken as string) ?? '';
    }
  } catch { /* 读不到配置则回退 env / 默认值 */ }
  const host = (apiServer?.host as string) || '127.0.0.1';
  const port = Number(apiServer?.port) > 0 ? Number(apiServer?.port) : 7850;
  const baseUrl = (process.env.GM_PRO_HTTP_URL || `http://${host}:${port}`).replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['x-auth-token'] = authToken;
  const body: Record<string, unknown> = {
    mode: opts.mode ?? 'heuristic',
    sessionConcurrency: opts.sessionConcurrency ?? 2,
  };
  if (opts.progressPath) body.progressPath = opts.progressPath;
  // 上游 0 = 全部；仅在显式给出正数时下传 limitSessions
  if (opts.limitSessions != null && opts.limitSessions > 0) body.limitSessions = opts.limitSessions;
  try {
    const resp = await fetch(`${baseUrl}/api/extract/rebuild-all`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!resp.ok) return { ok: false, error: `gm-pro HTTP ${resp.status}` };
    // 202 { jobId, status, message } —— jobId 透出给调用方供 GET .../job/:id 轮询
    const payload = await resp.json().catch(() => null) as { jobId?: string; status?: string } | null;
    return { ok: true, jobId: payload?.jobId, status: payload?.status };
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
      _neo4jDriver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), {
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 10_000,
      });
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
 * 向量索引目标参数（单一事实来源，建索引与建后校验共用）。
 *
 * HNSW / 量化参数在 2026.x 一类的发行版里**不再有全局默认配置**
 * （dbms.index.vector.default.* 已废弃），必须写在 CREATE VECTOR INDEX 的
 * OPTIONS { indexProvider, vectorConfig } 内 —— 但 `indexProvider` 的**注册名是
 * 版本相关的引擎标识符（有语义名，也有版本化命名），因此不在代码里写死**，
 * 由 ensureNeo4jSchema 在运行时解析（配置 → 既有索引 → 引擎错误自证 → 探测候选）。
 * `efSearch` 不在此列 —— 它是**查询期**参数，写在 db.index.vector.queryNodes 的第 4 个入参。
 */
const VECTOR_HNSW_M = 16;
const VECTOR_HNSW_EF_CONSTRUCTION = 96;
const VECTOR_SEARCH_EXPANSION_FACTOR = 2.0;
const VECTOR_QUANTIZATION_TYPE = 'SCALAR';

/** 本进程解析成功的向量索引 Provider 名（跨次 ensure 缓存，避免重复探测） */
let _resolvedVectorProvider: string | null = null;

/**
 * 幂等建立 Neo4j schema（约束 + 全文索引 + 向量索引）。
 *
 * 向量索引：目标参数 m=16 / efConstruction=96 / SCALAR 量化 / searchExpansionFactor=2.0
 * （见上方 VECTOR_* 常量），按"2026.x vector-2.0 → 5.x indexConfig(精细) →
 * 5.x indexConfig(基础) → <5.11 过程化"的顺序尝试，任一成功即视为建好；
 * 建后读回 SHOW VECTOR INDEXES 校验实际参数并告警不一致。
 * 其余语句任一失败仅吞掉（IF NOT EXISTS 幂等），不阻塞调用方。
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
          ["ConversationMessage", "gm_msg_id"],
          ["MemoryFile", "gm_node_id_memoryfile"],
          ["Task", "gm_node_id_task"],
          ["Skill", "gm_node_id_skill"],
          ["Event", "gm_node_id_event"],
          ["GmMessage", "gm_message_id"],
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
          // BUGFIX: 不同 Neo4j 版本对 FULLTEXT 的 CREATE 语法要求不同：
          //   - Neo4j 5.x / Cypher 5.x：OPTIONS { indexConfig: { `fulltext.analyzer`: "cjk" } }
          //     （键是带反引号的裸标识符 `fulltext.analyzer`，不能加引号；旧式 OPTIONS { analyzer: "cjk" } 会被拒）
          //   - 旧版 5.x：接受 OPTIONS { analyzer: "cjk" }
          //   - 极旧版本：两者都不接受 → 裸 CREATE（默认 analyzer）
          // 按优先级依次尝试，任一成功即视为建好。全部失败必须告警（而不是静默吞掉），
          // 否则索引缺失会让 queryNodes 每次调用都抛 "no such fulltext schema index"，
          // 图谱召回整体静默为 0（此前问题：catch{} 吞错 → 索引永远建不起来且无人察觉）。
          // BUGFIX(2026-08-19): Neo4j 5.x FULLTEXT 索引完整语法必须带 ON EACH（列表形式），
          // 且 indexConfig 键为裸标识符 `fulltext.analyzer`（反引号包裹，不能加引号）。
          // 此前三个变体全缺 ON EACH 且键名/引号错误 → 每次启动全部失败。
          // 实测（Neo4j 5.x）：`ON EACH [n.x] OPTIONS { indexConfig: { `fulltext.analyzer`: "cjk" } }` ✅
          // 回退顺序：cjk 精确 → 默认 analyzer（保底建索引，避免 queryNodes 抛 no such index）。
          const candidates = [
            `CREATE FULLTEXT INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON EACH ${props} OPTIONS { indexConfig: { \`fulltext.analyzer\`: "cjk" } }`,
            `CREATE FULLTEXT INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON EACH ${props}`,
          ];
          let ftErr: unknown = null;
          for (const ftCypher of candidates) {
            try {
              await session.run(ftCypher);
              ftErr = null;
              break;
            } catch (e) { ftErr = e; }
          }
          if (ftErr) {
            getGlobalLogger()?.warn?.(
              '[lcm-graph-extra] CREATE FULLTEXT INDEX failed for ALL syntax variants',
              { name, label, err: ftErr instanceof Error ? ftErr.message : String(ftErr) },
            );
          }
        }

        // 向量索引（Neo4j 5.11+）：跨 Task|Skill|Event 单索引。
        //
        // 目标参数：dimensions=配置值(默认 1024) / quantizationType=SCALAR /
        //           hnsw.m=16 / hnsw.efConstruction=96 / searchExpansionFactor=2.0。
        // 注意：efSearch(=48) 是**查询期**参数，只写在 db.index.vector.queryNodes 的第 4 个入参，
        //       建索引阶段不存在该参数（它是检索候选队列，不是索引存储参数）。
        //
        // ⚠ Provider 名（indexProvider）是**版本相关的引擎标识符，不可硬编码**：
        //   HNSW/量化参数在 2026.x 一类的版本里不再有全局默认配置，必须写在
        //   OPTIONS { indexProvider, vectorConfig } 内；而 Provider 的注册名在不同发行版/年份
        //   会变（既有语义名，也有版本化命名）。把某个字面量写死 = 换版本即建不出索引。
        //   因此这里按下面顺序**运行时解析**，以引擎自身为权威：
        //     1) 显式配置：plugin config `neo4j.vectorIndexProvider` 或环境变量 NEO4J_VECTOR_INDEX_PROVIDER
        //     2) 本进程上次解析成功的值（_resolvedVectorProvider 缓存）
        //     3) 该库既有向量索引的 indexProvider（SHOW VECTOR INDEXES，最权威）
        //     4) 引擎报错自证：CREATE 失败信息通常列出 "Available providers: [...]"，
        //        从中挑出向量类 Provider 再试一次
        //     5) 最后才用内置候选字面量兜底（失败也不致命，1~4 会补上）
        //
        // 语法变体链（与上面 FULLTEXT 同样思路：依次尝试，任一成功即视为建好）：
        //   A. vectorConfig + 解析出的 Provider（目标形态）
        //   B. 5.11~5.x Enterprise：OPTIONS { indexConfig: { `vector.*` } } + HNSW/量化（不需 Provider 名）
        //   C. 5.11~5.x Community：indexConfig 仅 dimensions + similarity
        //   D. <5.11：过程化 db.index.vector.createNodeIndex
        const dim = resolveEmbeddingConfig(getPluginNeo4jConfig())?.dimensions ?? 1024;
        const VECTOR_INDEX_NAME = 'gm_node_embedding';
        // Provider 名只允许安全字符，避免配置/错误文本被注入 Cypher
        const isSafeProviderName = (p: string): boolean => /^[A-Za-z0-9._-]+$/.test(p);
        const vectorConfigCypher = (provider: string): string => `
              CREATE VECTOR INDEX ${VECTOR_INDEX_NAME} IF NOT EXISTS
              FOR (n:Task|Skill|Event) ON (n.embedding)
              OPTIONS {
                indexProvider: '${provider}',
                vectorConfig: {
                  dimensions: ${dim},
                  quantizationType: '${VECTOR_QUANTIZATION_TYPE}',
                  hnsw: {
                    m: ${VECTOR_HNSW_M},
                    efConstruction: ${VECTOR_HNSW_EF_CONSTRUCTION}
                  },
                  searchExpansionFactor: ${VECTOR_SEARCH_EXPANSION_FACTOR}
                }
              }
            `;

        // Provider 候选（按权威度排序）
        const providerCandidates: string[] = [];
        const seenProviders = new Set<string>();
        const addProviderCandidate = (p: unknown): void => {
          const v = typeof p === 'string' ? p.trim() : '';
          if (!v || seenProviders.has(v)) return;
          if (!isSafeProviderName(v)) {
            getGlobalLogger()?.warn?.(`[lcm-graph-extra] 忽略非法向量 Provider 名：${v}`);
            return;
          }
          seenProviders.add(v);
          providerCandidates.push(v);
        };
        addProviderCandidate(resolveVectorIndexProvider(getPluginNeo4jConfig()));
        addProviderCandidate(_resolvedVectorProvider);
        try {
          const existing = await session.run('SHOW VECTOR INDEXES YIELD name, indexProvider');
          for (const rec of existing.records) {
            const p = rec.get('indexProvider');
            if (p) {
              getGlobalLogger()?.info?.(`[lcm-graph-extra] 从既有向量索引发现 Provider：${p}`);
              addProviderCandidate(p);
              break;
            }
          }
        } catch { /* 老版本 SHOW VECTOR INDEXES 不接受这些列 → 跳过 */ }
        // 内置探测候选：**只是探测值，不是断言** —— 引擎接受即用，拒绝时其错误信息会
        // 列出真正可用的 Provider 名（上面的自证路径随即采用），因此写错也不致命。
        // 语义名见于 5.18+ 线；版本化命名见于更晚的发行版；两者都留，避免任一侧失效时无候选。
        addProviderCandidate('vector-2.0');
        addProviderCandidate('vector-2026.07');

        const vectorAttempts: Array<{ label: string; cypher: string; provider?: string }> = [
          ...providerCandidates.map((p) => ({ label: `vectorConfig + provider '${p}'`, cypher: vectorConfigCypher(p), provider: p })),
          {
            label: 'indexConfig + HNSW/SCALAR (5.x Enterprise)',
            cypher: `
              CREATE VECTOR INDEX ${VECTOR_INDEX_NAME} IF NOT EXISTS
              FOR (n:Task|Skill|Event) ON n.embedding
              OPTIONS {
                indexConfig: {
                  \`vector.dimensions\`: ${dim},
                  \`vector.similarity_function\`: 'cosine',
                  \`vector.quantization.type\`: '${VECTOR_QUANTIZATION_TYPE.toLowerCase()}',
                  \`vector.default_search_expansion_factor\`: ${VECTOR_SEARCH_EXPANSION_FACTOR},
                  \`vector.hnsw.m\`: ${VECTOR_HNSW_M},
                  \`vector.hnsw.ef_construction\`: ${VECTOR_HNSW_EF_CONSTRUCTION}
                }
              }
            `,
          },
          {
            label: 'indexConfig basic (5.x Community)',
            cypher: `
              CREATE VECTOR INDEX ${VECTOR_INDEX_NAME} IF NOT EXISTS
              FOR (n:Task|Skill|Event) ON n.embedding
              OPTIONS {
                indexConfig: {
                  \`vector.dimensions\`: ${dim},
                  \`vector.similarity_function\`: 'cosine'
                }
              }
            `,
          },
          {
            label: 'procedural createNodeIndex (<5.11)',
            cypher: `CALL db.index.vector.createNodeIndex('${VECTOR_INDEX_NAME}', ['Task', 'Skill', 'Event'], 'embedding', ${dim}, 'cosine')`,
          },
        ];
        let vectorVariant: string | null = null;
        let resolvedProvider: string | null = null;
        const vectorErrors: string[] = [];
        // 引擎自证：从 "Unknown index provider 'x'. Available providers are: [a, b]" 里取向量类 Provider
        const parseAvailableProviders = (msg: string): string[] => {
          const m = /available providers[^[]*\[([^\]]*)\]/i.exec(msg);
          if (!m) return [];
          return m[1]
            .split(',')
            .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
            .filter((p) => /vector/i.test(p));
        };
        let extraAttempts = 0;
        const MAX_EXTRA_ATTEMPTS = 3;
        for (let i = 0; i < vectorAttempts.length && !vectorVariant; i++) {
          const attempt = vectorAttempts[i];
          try {
            await session.run(attempt.cypher);
            vectorVariant = attempt.label;
            resolvedProvider = attempt.provider ?? resolvedProvider;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vectorErrors.push(`${attempt.label}: ${msg}`);
            if (extraAttempts < MAX_EXTRA_ATTEMPTS) {
              for (const p of parseAvailableProviders(msg)) {
                if (seenProviders.has(p) || !isSafeProviderName(p)) continue;
                seenProviders.add(p);
                extraAttempts += 1;
                getGlobalLogger()?.info?.(`[lcm-graph-extra] 引擎报告可用向量 Provider：${p} → 追加尝试`);
                vectorAttempts.push({
                  label: `vectorConfig + engine-reported provider '${p}'`,
                  cypher: vectorConfigCypher(p),
                  provider: p,
                });
              }
            }
          }
        }
        if (vectorVariant) {
          if (resolvedProvider) _resolvedVectorProvider = resolvedProvider;
          getGlobalLogger()?.info?.(
            `[lcm-graph-extra] vector index ${VECTOR_INDEX_NAME} ensured via ${vectorVariant} (dim=${dim}`
            + `${resolvedProvider ? `, provider=${resolvedProvider}` : ''})`,
          );
        } else {
          // 全部变体失败必须告警（而不是静默吞掉）：向量索引缺失会让检索侧
          // "查不到向量索引" 且无人察觉。这里把每个变体的错误都带出来。
          getGlobalLogger()?.warn?.(
            '[lcm-graph-extra] CREATE VECTOR INDEX failed for ALL syntax variants',
            { name: VECTOR_INDEX_NAME, dim, triedProviders: providerCandidates, errors: vectorErrors },
          );
        }

        // 建后校验：读回真实 provider / vectorConfig / state。
        // 必要性：CREATE ... IF NOT EXISTS 对**已存在**的索引不会更新参数 —— 若线上还是
        // 旧参数（例如 5.x 建的 efConstruction=128、或旧 Provider）索引，新参数永远不会生效。
        // 这里只如实告警并给出确切的重建 DDL，不擅自 DROP（重建大向量库耗时长且期间不可用）。
        try {
          // driver 返回的 map 可能是 Map / 原生对象，统一转成普通对象后再比对
          const toPlain = (v: any): any => {
            if (v == null || typeof v !== 'object') return v;
            if (Array.isArray(v)) return v.map(toPlain);
            if (typeof v.toObject === 'function') return toPlain(v.toObject());
            if (typeof v.get === 'function' && typeof v.keys === 'function') {
              const o: Record<string, any> = {};
              for (const k of v.keys()) o[String(k)] = toPlain(v.get(k));
              return o;
            }
            const o: Record<string, any> = {};
            for (const k of Object.keys(v)) o[k] = toPlain(v[k]);
            return o;
          };
          const shown = await session.run(
            'SHOW VECTOR INDEXES YIELD name, indexProvider, vectorConfig, state',
          );
          for (const rec of shown.records) {
            if (String(rec.get('name')) !== VECTOR_INDEX_NAME) continue;
            const provider = rec.get('indexProvider');
            const state = rec.get('state');
            const liveProvider = provider != null ? String(provider) : '';
            const cfg = toPlain(rec.get('vectorConfig')) ?? {};
            const hnsw = cfg.hnsw ?? {};
            const liveEf = Number(hnsw.efConstruction ?? cfg['hnsw.ef_construction']);
            const liveDim = Number(cfg.dimensions ?? cfg['vector.dimensions']);
            const liveQuant = String(cfg.quantizationType ?? cfg['quantization.type'] ?? '');
            getGlobalLogger()?.info?.(
              `[lcm-graph-extra] vector index live config: provider=${provider} state=${state} `
              + `dimensions=${cfg.dimensions ?? cfg['vector.dimensions'] ?? 'n/a'} `
              + `efConstruction=${hnsw.efConstruction ?? cfg['hnsw.ef_construction'] ?? 'n/a'} `
              + `quantizationType=${liveQuant || 'n/a'} `
              + `searchExpansionFactor=${cfg.searchExpansionFactor ?? cfg['default_search_expansion_factor'] ?? 'n/a'}`,
            );
            // 只比对"确实读出来的"值：形状不可识别时保持沉默，避免误报
            const mismatch: string[] = [];
            if (Number.isFinite(liveEf) && liveEf !== VECTOR_HNSW_EF_CONSTRUCTION) {
              mismatch.push(`efConstruction=${liveEf}（目标 ${VECTOR_HNSW_EF_CONSTRUCTION}）`);
            }
            if (Number.isFinite(liveDim) && liveDim !== dim) {
              mismatch.push(`dimensions=${liveDim}（目标 ${dim}）`);
            }
            if (liveQuant && liveQuant.toLowerCase() !== 'scalar') {
              mismatch.push(`quantizationType=${liveQuant}（目标 SCALAR）`);
            }
            // Provider 不同同样需要重建：索引参数是绑定 Provider 的，换 Provider 只能重建
            if (resolvedProvider && liveProvider && liveProvider !== resolvedProvider) {
              mismatch.push(`indexProvider=${liveProvider}（期望 ${resolvedProvider}）`);
            }
            if (mismatch.length > 0) {
              getGlobalLogger()?.warn?.(
                `[lcm-graph-extra] vector index ${VECTOR_INDEX_NAME} 参数与目标不一致：${mismatch.join('; ')}`
                + ` —— CREATE INDEX IF NOT EXISTS 不会更新既有索引的参数。`
                + ` 如需按 m=${VECTOR_HNSW_M} / efConstruction=${VECTOR_HNSW_EF_CONSTRUCTION} / SCALAR /`
                + ` searchExpansionFactor=2.0 重建，请手动执行：DROP VECTOR INDEX \`${VECTOR_INDEX_NAME}\` IF EXISTS;`
                + ` 然后重跑 schema 初始化。重建为后台异步（state=POPULATING），ONLINE 后检索才可用。`,
              );
            }
            if (state && String(state) !== 'ONLINE') {
              getGlobalLogger()?.info?.(
                `[lcm-graph-extra] vector index ${VECTOR_INDEX_NAME} state=${state}（构建为后台异步，ONLINE 前检索不可用）`,
              );
            }
          }
        } catch { /* SHOW VECTOR INDEXES 的列/语法在老版本不可用 → 跳过校验 */ }
      } finally { await session.close(); }
    } catch (e) {
      // schema 初始化失败不阻塞工具主体（仅降低后续查询性能），
      // 但必须清除 _schemaReady 缓存 —— 否则失败被永久吞掉，
      // 即使后续 Neo4j 恢复也不会再重试建索引/约束（能力丢失且不自愈）。
      // 清除后下次调用（工具写入前 / 心跳周期）会重新尝试。
      _schemaReady = null;
      getGlobalLogger()?.warn?.("[lcm-graph-extra] ensureNeo4jSchema failed", { err: e instanceof Error ? e.message : String(e) });
    }
  })();
  return _schemaReady;
}

// ── Tool handler registry ──

/** 已注册 handler + 其声明的 TypeBox 参数 schema（用于 dashboard 调用边界的参数校验） */
interface RegisteredTool {
  handler: (toolCallId: string, params: any, signal?: AbortSignal) => Promise<any>;
  /** TypeBox schema（toolDef.parameters）；未提供则为 undefined，边界处跳过校验 */
  schema?: unknown;
}

const _registeredToolHandlers = new Map<string, RegisteredTool>();

export function getRegisteredToolHandler(name: string): ((toolCallId: string, params: any, signal?: AbortSignal) => Promise<any>) | undefined {
  return _registeredToolHandlers.get(name)?.handler;
}

/** 取工具声明的参数 schema（供 dashboard 调用边界做类型/范围校验） */
export function getRegisteredToolSchema(name: string): unknown | undefined {
  return _registeredToolHandlers.get(name)?.schema;
}

export function _resetRegisteredToolHandlers(): void {
  _registeredToolHandlers.clear();
}

export function registerToolHandler(
  name: string,
  handler: (toolCallId: string, params: any, signal?: AbortSignal) => Promise<any>,
  schema?: unknown,
): void {
  _registeredToolHandlers.set(name, { handler, schema });
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
    toolDef.execute = async function (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) {
      const startTs = Date.now();
      let result: any;
      let error: string | undefined;
      let status: 'success' | 'failure' = 'success';
      try {
        // 透传 SDK 全量实参（含 onUpdate 进度回调与 ExtensionContext），
        // 保持 execute(toolCallId, params, signal, onUpdate, ctx) 契约完整。
        result = await originalExecute.call(this, toolCallId, params, signal, onUpdate, ctx);
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
    registerToolHandler(toolName, toolDef.execute, toolDef.parameters);
    return originalRegisterTool(toolDef, opts);
  };
}