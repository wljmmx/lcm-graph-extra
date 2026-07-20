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
import { resolveNeo4jConfig } from '../config/neo4j-helper';
import { getGlobalLogger } from '../utils/logger.js';
import { cleanBaseURL, withKeepAliveIfOllama } from '../utils/url.js';
import { llmTimeout } from '../config/defaults.js';

const _lcmRequire = createRequire(import.meta.url);

// ── Module-level state ──

let _pluginNeo4jConfig: Record<string, unknown> | undefined;
let _pluginQmdUrl = "http://127.0.0.1:8081";
let _sharedQmdClient: any = null;

export function setPluginNeo4jConfig(cfg: Record<string, unknown> | undefined): void {
  _pluginNeo4jConfig = cfg;
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
    const llmCfg = _pluginNeo4jConfig?.distillationLlm || _pluginNeo4jConfig?.llm;
    const model = (llmCfg as any)?.model;
    const apiKey = (llmCfg as any)?.apiKey || '';
    const baseURL = cleanBaseURL((llmCfg as any)?.baseURL || 'http://127.0.0.1:18789/v1');
    const keepAlive = (llmCfg as any)?.keepAlive || '1h';
    if (model) {
      const expList = experiences.map((e, i) => `${i + 1}. [${e.type}] ${e.name} (${e.confidence}, seen ${e.seen}) - ${e.desc}`).join('\n');
      const prompt = `Based on the following ${total} experiences (time range: ${fromStr} to ${toStr}), write a concise natural language summary in the user's language. Group by theme, highlight key lessons learned, and note patterns. Keep it under 500 words.\n\nExperiences:\n${expList}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
      const body = withKeepAliveIfOllama(baseURL, { model, messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 800 }, keepAlive);
      const resp = await fetch(baseURL + '/chat/completions', {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(llmTimeout('summarizeTimeoutMs')),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text?.trim()) return `## 经验回顾摘要\n\n**时间范围**: ${fromStr} → ${toStr}\n**总数**: ${total} 条经验\n\n${text.trim()}`;
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