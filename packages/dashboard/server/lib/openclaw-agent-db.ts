/**
 * OpenClaw Agent SQLite —— 官方记忆只读读取器（dashboard 侧独立实现）。
 *
 * openclaw 2.0（2026.8.1）起，memory indexes 迁入 per-agent SQLite：
 *   ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite
 * （主包另有 src/adapters/openclaw-agent-db.ts；dashboard 不依赖主包，
 *   这里按同一官方 schema 独立实现精简版，仅用于记忆搜索。）
 *
 * 设计：
 *   - 只读打开 node:sqlite（readOnly），不写任何文件；
 *   - 防御性 schema：表缺失/列改名时降级空结果，不抛错；
 *   - 检索走 memory_index_chunks.text 多词 OR（整句 + 拉丁词 + CJK bigram，提升中文召回率）；
 *   - agent 库发现结果带 TTL 缓存（默认 30s），避免每次检索全盘扫描目录；
 *   - env OPENCLAW_AGENTS_DIR 可覆盖 agents 根目录（测试注入）。
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const req = createRequire(import.meta.url);
// node:sqlite 是 Node 内置模块；与 server/lib/db.ts 一致用 createRequire 动态加载
const { DatabaseSync } = req('node:sqlite') as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseSyncLike;
};

/** DatabaseSync 最小可用类型（仅用到的部分） */
interface DatabaseSyncLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

/** 官方记忆 chunk 行（memory_index_chunks）+ 元数据 */
export interface OpenClawMemoryRow {
  chunkId: string;
  agentId: string;
  path: string;
  source: string;
  text: string;
  importance: number | null;
  triggers: string | null;
  originClass: string | null;
  sessionKind: string | null;
  updatedAt: number | null;
}

/** agents 根目录：env OPENCLAW_AGENTS_DIR > ~/.openclaw/agents */
function resolveAgentsDir(): string {
  const fromEnv = process.env.OPENCLAW_AGENTS_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return resolve(homedir(), '.openclaw', 'agents');
}

/** 扫描全部 agent 库：~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite */
function scanAgentDbs(agentsDir: string): Array<{ agentId: string; dbPath: string }> {
  if (!existsSync(agentsDir)) return [];
  const out: Array<{ agentId: string; dbPath: string }> = [];
  for (const agentId of readdirSync(agentsDir)) {
    const dbPath = join(agentsDir, agentId, 'agent', 'openclaw-agent.sqlite');
    if (existsSync(dbPath)) out.push({ agentId, dbPath });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * agent 库发现缓存：按 agentsDir 缓存扫描结果，避免每次检索 readdirSync 全盘扫。
 */
const DISCOVERY_TTL_DEFAULT_MS = 30_000;
const DISCOVERY_CACHE_MAX = 100;
const discoveryCache = new Map<string, { ts: number; dbs: Array<{ agentId: string; dbPath: string }> }>();

/** 清空库发现缓存（agent 目录变化 / 测试隔离时调用） */
export function clearAgentDbDiscoveryCache(dirs?: string): void {
  if (dirs) discoveryCache.delete(dirs);
  else discoveryCache.clear();
}

function discoverAgentDbs(agentsDir: string): Array<{ agentId: string; dbPath: string }> {
  const cached = discoveryCache.get(agentsDir);
  if (cached && Date.now() - cached.ts < DISCOVERY_TTL_DEFAULT_MS) return cached.dbs;
  const dbs = scanAgentDbs(agentsDir);
  if (discoveryCache.size >= DISCOVERY_CACHE_MAX) discoveryCache.clear();
  discoveryCache.set(agentsDir, { ts: Date.now(), dbs });
  return dbs;
}

/** 只读打开；失败返回 null */
function openReadOnly(dbPath: string): DatabaseSyncLike | null {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/** 表是否存在 */
function tableExists(db: DatabaseSyncLike, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name) as unknown;
    return !!row;
  } catch {
    return false;
  }
}

/** LIKE 转义（\ % _） */
function escapeLikePattern(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 拆 query 为命中词：拉丁/数字词（小写） + 连续 CJK 相邻 bigram */
function tokenizeQuery(q: string): string[] {
  const out = new Set<string>();
  for (const m of q.match(/[a-z0-9][a-z0-9._:/+#-]{1,}/gi) ?? []) out.add(m.toLowerCase());
  for (const run of q.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

const CHUNK_BASE_COLS = 'id, path, source, model, text, updated_at';

interface BaseChunkRow {
  id?: unknown;
  path?: unknown;
  source?: unknown;
  model?: unknown;
  text?: unknown;
  updated_at?: unknown;
}

/** recall 元数据（表缺失返回空 Map） */
function loadRecallMeta(db: DatabaseSyncLike, ids: string[]): Map<string, { importance: number | null; triggers: string | null }> {
  const meta = new Map<string, { importance: number | null; triggers: string | null }>();
  if (ids.length === 0 || !tableExists(db, 'memory_index_chunk_recall_metadata')) return meta;
  const placeholders = ids.map(() => '?').join(',');
  try {
    const rows = db
      .prepare(`SELECT chunk_id, importance, triggers FROM memory_index_chunk_recall_metadata WHERE chunk_id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.chunk_id ?? '');
      if (!id) continue;
      meta.set(id, {
        importance: typeof r.importance === 'number' ? r.importance : null,
        triggers: typeof r.triggers === 'string' ? r.triggers : null,
      });
    }
  } catch {
    // 忽略
  }
  return meta;
}

/** provenance 元数据（表缺失返回空 Map） */
function loadProvenance(db: DatabaseSyncLike, ids: string[]): Map<string, { originClass: string | null; sessionKind: string | null }> {
  const prov = new Map<string, { originClass: string | null; sessionKind: string | null }>();
  if (ids.length === 0 || !tableExists(db, 'memory_index_chunk_provenance')) return prov;
  const placeholders = ids.map(() => '?').join(',');
  try {
    const rows = db
      .prepare(`SELECT chunk_id, origin_class, session_kind FROM memory_index_chunk_provenance WHERE chunk_id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.chunk_id ?? '');
      if (!id) continue;
      prov.set(id, {
        originClass: typeof r.origin_class === 'string' ? r.origin_class : null,
        sessionKind: typeof r.session_kind === 'string' ? r.session_kind : null,
      });
    }
  } catch {
    // 忽略
  }
  return prov;
}

function toRow(agentId: string, r: BaseChunkRow, meta?: { importance: number | null; triggers: string | null }, prov?: { originClass: string | null; sessionKind: string | null }): OpenClawMemoryRow {
  return {
    chunkId: String(r.id ?? ''),
    agentId,
    path: String(r.path ?? ''),
    source: String(r.source ?? 'memory'),
    text: String(r.text ?? ''),
    importance: meta?.importance ?? null,
    triggers: meta?.triggers ?? null,
    originClass: prov?.originClass ?? null,
    sessionKind: prov?.sessionKind ?? null,
    updatedAt: typeof r.updated_at === 'number' ? r.updated_at : null,
  };
}

/**
 * 跨 agent 检索官方记忆（多词 OR 命中 text + 元数据），按 importance → 更新时间排序。
 * 返回 0 条表示无匹配或 openclaw 2.0 布局不存在（均不抛错）。
 * 用户显式输入 %/_（通配符意图）时仅整句字面 LIKE，保持原语义。
 */
export function searchOpenClawMemory(q: string, limit: number = 10): OpenClawMemoryRow[] {
  const query = String(q ?? '').trim();
  if (!query) return [];
  const agentsDir = resolveAgentsDir();
  const agents = discoverAgentDbs(agentsDir);
  if (agents.length === 0) return [];
  const perAgent = Math.max(1, limit);
  const hasExplicitWildcard = query.includes('%') || query.includes('_');
  const patterns = hasExplicitWildcard
    ? [`%${escapeLikePattern(query)}%`]
    : [query, ...tokenizeQuery(query)]
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .map((t) => `%${escapeLikePattern(t)}%`);
  const orSql = patterns.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ');
  const out: OpenClawMemoryRow[] = [];

  for (const agent of agents) {
    const db = openReadOnly(agent.dbPath);
    if (!db) continue;
    try {
      if (!tableExists(db, 'memory_index_chunks')) continue;
      const rows = db
        .prepare(`SELECT ${CHUNK_BASE_COLS} FROM memory_index_chunks WHERE ${orSql} ORDER BY updated_at DESC LIMIT ?`)
        .all(...patterns, perAgent * 2) as BaseChunkRow[];
      const ids = rows.map((r) => String(r.id ?? '')).filter(Boolean);
      const metaMap = loadRecallMeta(db, ids);
      const provMap = loadProvenance(db, ids);
      for (const r of rows) {
        const id = String(r.id ?? '');
        out.push(toRow(agent.agentId, r, metaMap.get(id), provMap.get(id)));
      }
    } catch {
      // 单 agent 失败不影响其他
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }

  out.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out.slice(0, limit);
}

/** 官方记忆索引概要（空目录返回空数组） */
export function openClawMemoryHealth(): Array<{ agentId: string; chunkCount: number; sourceCount: number; error?: string }> {
  const agents = discoverAgentDbs(resolveAgentsDir());
  return agents.map((agent) => {
    const h: { agentId: string; chunkCount: number; sourceCount: number; error?: string } = {
      agentId: agent.agentId,
      chunkCount: 0,
      sourceCount: 0,
    };
    const db = openReadOnly(agent.dbPath);
    if (!db) {
      h.error = '无法只读打开 openclaw-agent.sqlite';
      return h;
    }
    try {
      if (tableExists(db, 'memory_index_chunks')) {
        const row = db.prepare('SELECT COUNT(*) AS c FROM memory_index_chunks').get() as { c?: unknown } | undefined;
        h.chunkCount = Number(row?.c ?? 0);
      }
      if (tableExists(db, 'memory_index_sources')) {
        const row = db.prepare('SELECT COUNT(*) AS c FROM memory_index_sources').get() as { c?: unknown } | undefined;
        h.sourceCount = Number(row?.c ?? 0);
      }
    } catch (e) {
      h.error = e instanceof Error ? e.message : String(e);
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    return h;
  });
}