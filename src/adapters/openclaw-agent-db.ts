/**
 * OpenClaw Agent SQLite —— 官方记忆读取器（openclaw >= 2026.8（2.0）schema）。
 *
 * openclaw 2.0（2026.8.1）起，sessions/transcripts/memory indexes 迁入 per-agent SQLite：
 *   ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite
 * （全局控制面另有 ~/.openclaw/state/openclaw.sqlite，本模块只读数据面。）
 *
 * 本模块只读对接官方 memory_index_* 表（memory_index_chunks 等），提供：
 *   - discoverAgentDbs()   扫描全部 agent 库
 *   - searchAgentMemory()  跨库关键词检索记忆（含 recall/provenance 元数据）
 *   - recentAgentMemory()  最近写入的官方记忆（无关键词浏览 / 备份用）
 *   - agentMemoryHealth()  各 agent 记忆索引健康概要
 *
 * 设计约束：
 *   - 一律只读打开（node:sqlite readOnly），不写任何文件；
 *   - 对官方 schema 采用防御性读取：表/列缺失或改名时降级为空结果，不抛错；
 *   - embedding 为 TEXT（模型相关编码），本模块不解析向量，检索走文本 LIKE；
 *   - 迁移布局（目录/表名）以官方 database-schemas 文档为准。
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const req = createRequire(import.meta.url);
// node:sqlite 是 Node 内置模块；与 src/health-metrics.ts 一致用 createRequire 动态加载，
// 避免直接 import 引发 TS 类型缺失问题。
const { DatabaseSync } = req('node:sqlite') as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseSyncLike;
};

/** DatabaseSync 的最小可用类型描述（仅用到的部分） */
interface DatabaseSyncLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 一条官方记忆 chunk（对应 memory_index_chunks 行 + 关联元数据） */
export interface AgentMemoryChunk {
  /** chunk 主键（全局唯一，跨 agent 稳定） */
  chunkId: string;
  /** 所属 agent id（来自目录名） */
  agentId: string;
  /** 原始记忆文件路径（如 memory/xxx.md；也可能是 memory 专属 key） */
  path: string;
  /** 来源（默认 'memory'） */
  source: string;
  startLine: number | null;
  endLine: number | null;
  /** 生成/嵌入使用的模型 */
  model: string;
  /** chunk 正文 */
  text: string;
  /** 重要度（1-10，来自 recall_metadata，可能缺失） */
  importance: number | null;
  /** 触发词（JSON 字符串，来自 recall_metadata） */
  triggers: string | null;
  /** 项目 key（来自 recall_metadata） */
  projectKey: string | null;
  /** 来源身份：owner/agent/untrusted/system（来自 provenance） */
  originClass: string | null;
  /** 会话类型：interactive/cron/heartbeat/subagent/unknown（来自 provenance） */
  sessionKind: string | null;
  /** 观察时间（ms epoch，来自 provenance） */
  observedAt: number | null;
  /** chunk 更新时间（ms epoch） */
  updatedAt: number | null;
}

/** 单个 agent 库的定位信息 */
export interface AgentDbPath {
  agentId: string;
  dbPath: string;
}

/** agent 记忆索引健康概要 */
export interface AgentMemoryHealth {
  agentId: string;
  dbPath: string;
  /** memory_index_meta 中的 schema 版本（key: 'version'） */
  schemaVersion: string | null;
  /** memory_index_chunks 行数 */
  chunkCount: number;
  /** memory_index_sources 行数 */
  sourceCount: number;
  /** 打开/查询失败原因（存在则该 agent 视为不可用） */
  error?: string;
}

export interface OpenClawAgentDbOptions {
  /** agents 根目录；默认 ~/.openclaw/agents，可用 env OPENCLAW_AGENTS_DIR 覆盖（测试注入用） */
  agentsDir?: string;
  /** 每个 agent 最多返回的 chunk 数 */
  maxChunksPerAgent?: number;
}

// ---------------------------------------------------------------------------
// 路径与发现
// ---------------------------------------------------------------------------

/** agents 根目录：env OPENCLAW_AGENTS_DIR > ~/.openclaw/agents */
function resolveAgentsDir(): string {
  const fromEnv = process.env.OPENCLAW_AGENTS_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return resolve(homedir(), '.openclaw', 'agents');
}

/**
 * 扫描 ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite，返回全部 agent 库。
 * 目录缺失或库文件不存在时返回空数组（不抛错）。
 */
export function discoverAgentDbs(agentsDir: string = resolveAgentsDir()): AgentDbPath[] {
  if (!existsSync(agentsDir)) return [];
  const out: AgentDbPath[] = [];
  for (const agentId of readdirSync(agentsDir)) {
    const dbPath = join(agentsDir, agentId, 'agent', 'openclaw-agent.sqlite');
    if (existsSync(dbPath)) out.push({ agentId, dbPath });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

// ---------------------------------------------------------------------------
// 只读连接与防御性查询
// ---------------------------------------------------------------------------

/** 只读打开库；失败返回 null（库损坏/版本过新等情况不抛错） */
function openReadOnly(dbPath: string): DatabaseSyncLike | null {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/** 表是否存在于当前库 */
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

/** LIKE 转义（\ % _），配合 ESCAPE '\' 使用 */
export function escapeLikePattern(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** chunk 基础列（memory_index_chunks）；列缺失时降级 [] */
const CHUNK_BASE_COLS = 'id, path, source, start_line, end_line, model, text, updated_at';

interface BaseChunkRow {
  id?: unknown;
  path?: unknown;
  source?: unknown;
  start_line?: unknown;
  end_line?: unknown;
  model?: unknown;
  text?: unknown;
  updated_at?: unknown;
}

/** 附加 recall 元数据（表缺失时返回空 Map） */
function loadRecallMeta(db: DatabaseSyncLike, chunkIds: string[]): Map<string, { importance: number | null; triggers: string | null; projectKey: string | null }> {
  const meta = new Map<string, { importance: number | null; triggers: string | null; projectKey: string | null }>();
  if (chunkIds.length === 0 || !tableExists(db, 'memory_index_chunk_recall_metadata')) return meta;
  const placeholders = chunkIds.map(() => '?').join(',');
  try {
    const rows = db
      .prepare(`SELECT chunk_id, importance, triggers, project_key FROM memory_index_chunk_recall_metadata WHERE chunk_id IN (${placeholders})`)
      .all(...chunkIds) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.chunk_id ?? '');
      if (!id) continue;
      const importance = typeof r.importance === 'number' ? r.importance : null;
      meta.set(id, {
        importance,
        triggers: typeof r.triggers === 'string' ? r.triggers : null,
        projectKey: typeof r.project_key === 'string' ? r.project_key : null,
      });
    }
  } catch {
    // 表损坏等 → 忽略元数据
  }
  return meta;
}

/** 附加 provenance 元数据（表缺失时返回空 Map） */
function loadProvenance(db: DatabaseSyncLike, chunkIds: string[]): Map<string, { originClass: string | null; sessionKind: string | null; observedAt: number | null }> {
  const prov = new Map<string, { originClass: string | null; sessionKind: string | null; observedAt: number | null }>();
  if (chunkIds.length === 0 || !tableExists(db, 'memory_index_chunk_provenance')) return prov;
  const placeholders = chunkIds.map(() => '?').join(',');
  try {
    const rows = db
      .prepare(`SELECT chunk_id, origin_class, session_kind, observed_at FROM memory_index_chunk_provenance WHERE chunk_id IN (${placeholders})`)
      .all(...chunkIds) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.chunk_id ?? '');
      if (!id) continue;
      prov.set(id, {
        originClass: typeof r.origin_class === 'string' ? r.origin_class : null,
        sessionKind: typeof r.session_kind === 'string' ? r.session_kind : null,
        observedAt: typeof r.observed_at === 'number' ? r.observed_at : null,
      });
    }
  } catch {
    // 忽略
  }
  return prov;
}

/** 把基础行 + 元数据组装成 AgentMemoryChunk */
function toChunk(agentId: string, row: BaseChunkRow, meta?: { importance: number | null; triggers: string | null; projectKey: string | null }, prov?: { originClass: string | null; sessionKind: string | null; observedAt: number | null }): AgentMemoryChunk {
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    chunkId: String(row.id ?? ''),
    agentId,
    path: String(row.path ?? ''),
    source: String(row.source ?? 'memory'),
    startLine: numOrNull(row.start_line),
    endLine: numOrNull(row.end_line),
    model: String(row.model ?? ''),
    text: String(row.text ?? ''),
    importance: meta?.importance ?? null,
    triggers: meta?.triggers ?? null,
    projectKey: meta?.projectKey ?? null,
    originClass: prov?.originClass ?? null,
    sessionKind: prov?.sessionKind ?? null,
    observedAt: prov?.observedAt ?? null,
    updatedAt: numOrNull(row.updated_at),
  };
}

/** chunk 排序：importance 高者优先，其次按更新时间新者优先 */
function sortChunks(a: AgentMemoryChunk, b: AgentMemoryChunk): number {
  const impA = a.importance ?? 0;
  const impB = b.importance ?? 0;
  if (impA !== impB) return impB - impA;
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

function searchAgentDb(
  agent: AgentDbPath,
  pattern: string,
  limit: number,
  maxTextLen: number,
): AgentMemoryChunk[] {
  const db = openReadOnly(agent.dbPath);
  if (!db) return [];
  try {
    // 1) 基础检索：按正文 LIKE（官方 memory_index_chunks.text）
    if (!tableExists(db, 'memory_index_chunks')) return [];
    const baseRows = db
      .prepare(`SELECT ${CHUNK_BASE_COLS} FROM memory_index_chunks WHERE text LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`)
      .all(pattern, limit) as BaseChunkRow[];

    const chunkIds = baseRows.map((r) => String(r.id ?? '')).filter(Boolean);
    const metaMap = loadRecallMeta(db, chunkIds);
    const provMap = loadProvenance(db, chunkIds);

    const chunks = baseRows.map((r) => {
      const id = String(r.id ?? '');
      const c = toChunk(agent.agentId, r, metaMap.get(id), provMap.get(id));
      if (maxTextLen > 0 && c.text.length > maxTextLen) c.text = c.text.slice(0, maxTextLen);
      return c;
    });
    chunks.sort(sortChunks);
    return chunks;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * 跨 agent 库关键词检索官方记忆。
 * 命中优先级：importance → 更新时间；每 agent 截断 maxChunksPerAgent。
 */
export function searchAgentMemory(q: string, options: OpenClawAgentDbOptions = {}): AgentMemoryChunk[] {
  const query = String(q ?? '').trim();
  if (!query) return [];
  const agents = discoverAgentDbs(options.agentsDir);
  // 空目录（未安装 openclaw 2.0 布局）→ 空结果
  if (agents.length === 0) return [];
  const perAgent = Math.max(1, options.maxChunksPerAgent ?? 10);
  const pattern = `%${escapeLikePattern(query)}%`;
  const out: AgentMemoryChunk[] = [];
  for (const agent of agents) {
    out.push(...searchAgentDb(agent, pattern, perAgent, 4000));
  }
  out.sort(sortChunks);
  return out;
}

/** 最近写入的官方记忆（无关键词浏览/快速抽样；按更新时间倒序） */
export function recentAgentMemory(limit: number = 10, options: OpenClawAgentDbOptions = {}): AgentMemoryChunk[] {
  const n = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 10;
  const agents = discoverAgentDbs(options.agentsDir);
  const out: AgentMemoryChunk[] = [];
  for (const agent of agents) {
    const db = openReadOnly(agent.dbPath);
    if (!db) continue;
    try {
      if (!tableExists(db, 'memory_index_chunks')) continue;
      const rows = db
        .prepare(`SELECT ${CHUNK_BASE_COLS} FROM memory_index_chunks ORDER BY updated_at DESC LIMIT ?`)
        .all(n) as BaseChunkRow[];
      const chunkIds = rows.map((r) => String(r.id ?? '')).filter(Boolean);
      const metaMap = loadRecallMeta(db, chunkIds);
      const provMap = loadProvenance(db, chunkIds);
      for (const r of rows) {
        const id = String(r.id ?? '');
        out.push(toChunk(agent.agentId, r, metaMap.get(id), provMap.get(id)));
      }
    } catch {
      // 单 agent 失败不阻塞其他
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out.slice(0, n * Math.max(1, discoverAgentDbs(options.agentsDir).length));
}

/** 各 agent 官方记忆索引健康概要（用于状态展示/备份清单） */
export function agentMemoryHealth(options: OpenClawAgentDbOptions = {}): AgentMemoryHealth[] {
  const agents = discoverAgentDbs(options.agentsDir);
  return agents.map((agent) => {
    const health: AgentMemoryHealth = {
      agentId: agent.agentId,
      dbPath: agent.dbPath,
      schemaVersion: null,
      chunkCount: 0,
      sourceCount: 0,
    };
    const db = openReadOnly(agent.dbPath);
    if (!db) {
      health.error = '无法只读打开 openclaw-agent.sqlite';
      return health;
    }
    try {
      // memory_index_meta 为 key-value 表，读取 'version' 键
      if (tableExists(db, 'memory_index_meta')) {
        const row = db.prepare("SELECT value FROM memory_index_meta WHERE key = 'version'").get() as { value?: unknown } | undefined;
        if (row && typeof row.value === 'string') health.schemaVersion = row.value;
      }
      if (tableExists(db, 'memory_index_chunks')) {
        const row = db.prepare('SELECT COUNT(*) AS c FROM memory_index_chunks').get() as { c?: unknown } | undefined;
        health.chunkCount = Number(row?.c ?? 0);
      }
      if (tableExists(db, 'memory_index_sources')) {
        const row = db.prepare('SELECT COUNT(*) AS c FROM memory_index_sources').get() as { c?: unknown } | undefined;
        health.sourceCount = Number(row?.c ?? 0);
      }
    } catch (e) {
      health.error = e instanceof Error ? e.message : String(e);
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    return health;
  });
}