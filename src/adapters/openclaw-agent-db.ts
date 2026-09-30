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
 *   - embedding 为 TEXT（模型相关编码，query 侧无同模型编码器），本模块不做向量余弦，
 *     检索改为多词 OR 召回（拉丁词 + CJK bigram + 整句），提升中文/同义召回率；
 *   - agent 库发现结果带 TTL 缓存（默认 30s），避免每次检索全盘扫描目录；
 *   - 迁移布局（目录/表名）以官方 database-schemas 文档为准。
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import * as zlib from 'node:zlib';

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
  /** 库发现结果缓存 TTL（ms）；0 表示禁用缓存（每次全盘扫描）。默认 30s */
  discoveryTtlMs?: number;
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
 * agent 库发现缓存：按 agentsDir 缓存扫描结果，避免每次检索 readdirSync 全盘扫。
 * 缓存数量上限 100（超出时清空重建，防止异常增长）。
 */
const DISCOVERY_TTL_DEFAULT_MS = 30_000;
const DISCOVERY_CACHE_MAX = 100;
const discoveryCache = new Map<string, { ts: number; dbs: AgentDbPath[] }>();

/** 清空库发现缓存（agent 目录发生变化 / 测试隔离时调用） */
export function clearAgentDbDiscoveryCache(): void {
  discoveryCache.clear();
}

/** 无缓存的实际扫描实现 */
function scanAgentDbs(agentsDir: string): AgentDbPath[] {
  if (!existsSync(agentsDir)) return [];
  const out: AgentDbPath[] = [];
  for (const agentId of readdirSync(agentsDir)) {
    const dbPath = join(agentsDir, agentId, 'agent', 'openclaw-agent.sqlite');
    if (existsSync(dbPath)) out.push({ agentId, dbPath });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * 扫描 ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite，返回全部 agent 库。
 * 目录缺失或库文件不存在时返回空数组（不抛错）。
 * 带 TTL 缓存（默认 30s）；传 options.discoveryTtlMs=0 强制每次扫描。
 */
export function discoverAgentDbs(
  agentsDirOrOptions?: string | OpenClawAgentDbOptions,
): AgentDbPath[] {
  const opts: OpenClawAgentDbOptions =
    agentsDirOrOptions != null && typeof agentsDirOrOptions === 'object'
      ? agentsDirOrOptions
      : { agentsDir: agentsDirOrOptions as string | undefined };
  const agentsDir = opts.agentsDir ?? resolveAgentsDir();
  const ttlMs = opts.discoveryTtlMs ?? DISCOVERY_TTL_DEFAULT_MS;

  if (ttlMs > 0) {
    const cached = discoveryCache.get(agentsDir);
    if (cached && Date.now() - cached.ts < ttlMs) return cached.dbs;
  }

  const dbs = scanAgentDbs(agentsDir);
  if (ttlMs > 0) {
    if (discoveryCache.size >= DISCOVERY_CACHE_MAX) discoveryCache.clear();
    discoveryCache.set(agentsDir, { ts: Date.now(), dbs });
  }
  return dbs;
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

/**
 * 官方 embedding 为模型相关 TEXT 编码、query 侧无同模型编码器，无法直接做向量余弦。
 * 务实替代：把 query 拆成多命中词（整句 + 拉丁/数字词 + 连续 CJK 相邻 bigram），
 * OR 召回后合并排序——中文"进度"命中"项目进度"、缩写/大小写变体等场景召回率更高。
 */
export function tokenizeMemoryQuery(q: string): string[] {
  const out = new Set<string>();
  for (const m of q.match(/[a-z0-9][a-z0-9._:/+#-]{1,}/gi) ?? []) out.add(m.toLowerCase());
  for (const run of q.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/** chunk 基础列（memory_index_chunks）；列缺失时降级 [] */
const CHUNK_BASE_COLS = 'id, path, source, start_line, end_line, model, text, updated_at';

// ---------------------------------------------------------------------------
// 官方转录（transcript_events）—— 会话消息的权威来源
// ---------------------------------------------------------------------------
//
// 官方存储教义（openclaw/openclaw `src/state/openclaw-agent-schema.sql` 顶部注释）：
//   "session_windows and their children own transcript generations"
//   —— 会话消息的权威存储是 per-agent SQLite 的 transcript_events，不是 JSONL。
//   JSONL / sessionFile 已被标记为 legacy（仅归档、迁移、plugin SDK 兼容用途，
//   `sessionFile` 现在是"进程内路由 token"而非文件路径）。
//
// 表结构（逐字来自官方 DDL，仅取本读取器需要的列）：
//   transcript_events(session_id, seq, event_json|event_zstd+event_utf8_bytes, created_at,
//                     PRIMARY KEY(session_id, seq))
//   session_windows(session_id PK, session_key, ...)
//   transcript_event_identities(session_id, event_id, seq, ...)
// event_json 内容 = 一条 canonical transcript entry，消息条为
//   { id, parentId?, timestamp?, type: "message", message: { role, content } }
// （与 JSONL 行同形；角色取值 user|assistant|toolResult|custom|bashExecution）。

/** 一条官方转录消息（已解析 event_json，content 保持原始形态：字符串或块数组） */
export interface AgentTranscriptMessage {
  agentId: string;
  /** 稳定会话键（session_windows.session_key），跨 /new 轮换不变 */
  sessionKey: string;
  sessionId: string;
  /** 会话内单调序号（transcript_events 主键之一） */
  seq: number;
  /** entry id（transcript_event_identities.event_id），缺失为 null */
  eventId: string | null;
  role: string;
  /** 原始 content（字符串或块数组）；扁平化由调用方按上游规则处理 */
  content: unknown;
  /** ms 时间戳 */
  createdAt: number;
}

export interface AgentTranscriptReadResult {
  messages: AgentTranscriptMessage[];
  /** 成功解压 zstd 载荷的行数（官方新版会把冷 transcript 压成 zstd） */
  decodedCompressed: number;
  /** 解压/解码失败而跳过的行数（载荷损坏、长度不符、运行时无 zstd 等） */
  skippedCompressed: number;
  /** 非 message 类型 entry 数（session 头 / compaction / label / model_change 等） */
  skippedNonMessage: number;
  /** 解析失败的行数 */
  parseErrors: number;
  agentsScanned: number;
}

/** 官方上限：单条压缩载荷最大 4MB（openclaw transcript-payload.ts MAX_COMPRESSED_EVENT_BYTES） */
const MAX_COMPRESSED_EVENT_BYTES = 4 * 1024 * 1024;
/** 官方解码函数名：镜像它可让 SQL 表达式与官方逐字一致 */
const TRANSCRIPT_DECODE_FUNCTION = 'openclaw_transcript_payload_decode';

/** 运行时能否解压 zstd（Node 22.15+/23.8+ 内置 zlib.zstdDecompressSync） */
function resolveZstdDecompress(): ((bytes: Uint8Array) => Uint8Array) | undefined {
  const fn = (zlib as unknown as { zstdDecompressSync?: (b: Uint8Array) => Uint8Array }).zstdDecompressSync;
  return typeof fn === 'function' ? fn : undefined;
}

/**
 * 注册官方同名的 zstd 解码 SQL 函数（`openclaw_transcript_payload_decode`）。
 *
 * 官方实现（openclaw `src/config/sessions/transcript-payload.ts` `registerDecoder`）：
 *   database.function(DECODE_FUNCTION, { deterministic: true, directOnly: true }, (bytes, rawBytes) => {
 *     // 校验：Uint8Array、1..4MB、rawBytes 为安全整数且 1..4MB
 *     const decoded = codec.decompress(bytes, rawBytes);
 *     if (decoded.byteLength !== rawBytes) throw ...;
 *     return utf8Decoder.decode(decoded);   // TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
 *   });
 *   SQL:  coalesce(event_json, openclaw_transcript_payload_decode(event_zstd, event_utf8_bytes))
 *
 * 与官方的**唯一差异**（有意的）：单行解码失败返回 NULL 而不 throw。
 * 官方 throw 会让整条 SELECT 失败；本读取器是旁路消费者，不能让一行损坏载荷
 * 导致整次导入读不到任何消息，故降级为跳过该行并计数（调用方可见）。
 */
function registerTranscriptPayloadDecoder(
  db: { function?: (name: string, options: Record<string, unknown>, fn: (...args: unknown[]) => unknown) => void },
  stats: { decoded: number; failed: number },
): boolean {
  if (typeof db.function !== 'function') return false;
  const decompress = resolveZstdDecompress();
  if (!decompress) return false;
  try {
    db.function(
      TRANSCRIPT_DECODE_FUNCTION,
      { deterministic: true, directOnly: true },
      (bytes, rawBytes) => {
        try {
          if (
            !(bytes instanceof Uint8Array) ||
            bytes.byteLength === 0 ||
            bytes.byteLength > MAX_COMPRESSED_EVENT_BYTES ||
            typeof rawBytes !== 'number' ||
            !Number.isSafeInteger(rawBytes) ||
            rawBytes < 1 ||
            rawBytes > MAX_COMPRESSED_EVENT_BYTES
          ) {
            throw new Error('Invalid compressed transcript payload bounds');
          }
          const decoded = decompress(bytes);
          if (decoded.byteLength !== rawBytes) {
            throw new Error('Compressed transcript payload length does not match its recorded UTF-8 size');
          }
          // 与官方一致：fatal UTF-8 解码，遇非法字节即失败（不静默替换字符）
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded);
          stats.decoded += 1;
          return text;
        } catch {
          stats.failed += 1;
          return null;
        }
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** 时间戳归一为 ms：官方 INTEGER 约定为 ms；若明显是秒则换算（防御性，不改动已合法值） */
function normalizeEpochMs(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

/**
 * 读取官方 per-agent SQLite 的会话转录消息（权威来源）。
 *
 * 设计约束（沿用本模块既有约定）：
 *   - 只读打开，不写任何文件；
 *   - 表/列缺失即降级为空结果，不抛错（官方 schema 演进时不炸）；
 *   - **无法解压 zstd 行**：官方用注册函数 `openclaw_transcript_payload_decode(event_zstd, ...)`
 *     读取压缩行，本模块用 node:sqlite 只读打开、无法注册该函数，故只读 `event_json IS NOT NULL`
 *     的行，压缩行计入 skippedCompressed 由调用方如实上报。
 *
 * @param options.agentsDir 覆盖 agents 目录（测试用）
 * @param options.agentId   只读指定 agent
 */
export function readAgentTranscriptMessages(
  options: OpenClawAgentDbOptions & { agentId?: string } = {},
): AgentTranscriptReadResult {
  const result: AgentTranscriptReadResult = {
    messages: [], decodedCompressed: 0, skippedCompressed: 0, skippedNonMessage: 0, parseErrors: 0, agentsScanned: 0,
  };
  const agents = discoverAgentDbs(options).filter((a) => !options.agentId || a.agentId === options.agentId);
  for (const agent of agents) {
    const db = openReadOnly(agent.dbPath);
    if (!db) continue;
    result.agentsScanned += 1;
    try {
      // 官方 schema 演进防御：核心两表缺失即跳过该库
      if (!tableExists(db, 'transcript_events') || !tableExists(db, 'session_windows')) continue;

      // event_id 映射（可选表）
      const eventIds = new Map<string, string>();
      if (tableExists(db, 'transcript_event_identities')) {
        try {
          for (const r of db.prepare('SELECT session_id, seq, event_id FROM transcript_event_identities').all() as any[]) {
            if (r?.event_id) eventIds.set(`${r.session_id}:${r.seq}`, String(r.event_id));
          }
        } catch { /* 忽略 */ }
      }

      // 注册官方同名 zstd 解码函数；成功则用**官方同款 SQL 表达式**读取，
      // 连压缩行一起读（否则只读 event_json 非空的行，压缩历史会缺失）。
      const decodeStats = { decoded: 0, failed: 0 };
      const canDecode = registerTranscriptPayloadDecoder(db as any, decodeStats);
      const jsonExpr = canDecode
        ? `COALESCE(e.event_json, ${TRANSCRIPT_DECODE_FUNCTION}(e.event_zstd, e.event_utf8_bytes))`
        : 'e.event_json';
      const whereClause = canDecode ? '' : 'WHERE e.event_json IS NOT NULL';

      // 主查询：消息行 JOIN 会话窗口取稳定 sessionKey（列名不符即降级跳过该库）。
      // 排序 = 会话键 → 窗口创建时间 → 窗口内序号：同一 session_key 在 /new 后会开新
      // session_window（各自 seq 从 1 起），只按 seq 排会把不同窗口交错，必须带上窗口时间。
      const rows = db.prepare(
        `SELECT e.session_id AS session_id, e.seq AS seq, ${jsonExpr} AS event_json,
                e.created_at AS created_at, w.session_key AS session_key
         FROM transcript_events e
         JOIN session_windows w ON w.session_id = e.session_id
         ${whereClause}
         ORDER BY w.session_key ASC, w.created_at ASC, e.seq ASC`,
      ).all() as any[];
      result.decodedCompressed += decodeStats.decoded;

      for (const row of rows) {
        // 压缩行解码失败（返回 NULL）→ 如实计入跳过数，不中断整次读取
        if (row.event_json == null) {
          result.skippedCompressed += 1;
          continue;
        }
        let entry: any;
        try {
          entry = JSON.parse(String(row.event_json));
        } catch {
          result.parseErrors += 1;
          continue;
        }
        if (!entry || entry.type !== 'message' || !entry.message) {
          result.skippedNonMessage += 1;
          continue;
        }
        const sessionId = String(row.session_id ?? '');
        const seq = Number(row.seq ?? 0);
        result.messages.push({
          agentId: agent.agentId,
          sessionKey: String(row.session_key ?? ''),
          sessionId,
          seq,
          eventId: eventIds.get(`${sessionId}:${seq}`) ?? (entry.id != null ? String(entry.id) : null),
          role: String(entry.message.role ?? ''),
          content: entry.message.content,
          createdAt: normalizeEpochMs(row.created_at),
        });
      }
    } catch {
      // 单库失败不影响其余库
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
  return result;
}

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
  patterns: string[],
  limit: number,
  maxTextLen: number,
): AgentMemoryChunk[] {
  const db = openReadOnly(agent.dbPath);
  if (!db) return [];
  try {
    // 1) 基础检索：多词 OR 命中官方 memory_index_chunks.text（提升中文/同义召回率）
    if (!tableExists(db, 'memory_index_chunks')) return [];
    if (patterns.length === 0) return [];
    const orSql = patterns.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ');
    // LIMIT 放大 2 倍再内存排序，避免"最新优先截断"丢 importance 高但较旧的行
    const baseRows = db
      .prepare(`SELECT ${CHUNK_BASE_COLS} FROM memory_index_chunks WHERE ${orSql} ORDER BY updated_at DESC LIMIT ?`)
      .all(...patterns, limit * 2) as BaseChunkRow[];

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
    return chunks.slice(0, limit);
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
 * 命中策略：整句 LIKE + 拉丁词 + CJK bigram OR 召回（详见 tokenizeMemoryQuery），
 * 排序优先级：importance → 更新时间；每 agent 截断 maxChunksPerAgent。
 */
export function searchAgentMemory(q: string, options: OpenClawAgentDbOptions = {}): AgentMemoryChunk[] {
  const query = String(q ?? '').trim();
  if (!query) return [];
  const agents = discoverAgentDbs(options.agentsDir ? { agentsDir: options.agentsDir, discoveryTtlMs: options.discoveryTtlMs } : { discoveryTtlMs: options.discoveryTtlMs });
  // 空目录（未安装 openclaw 2.0 布局）→ 空结果
  if (agents.length === 0) return [];
  const perAgent = Math.max(1, options.maxChunksPerAgent ?? 10);
  // 用户显式使用 %/_（通配符意图）时仅整句字面 LIKE，保持原语义；
  // 否则做多词 OR 召回（整句优先 + 拉丁词 + CJK bigram 兜底）
  const hasExplicitWildcard = query.includes('%') || query.includes('_');
  const patterns = hasExplicitWildcard
    ? [`%${escapeLikePattern(query)}%`]
    : [query, ...tokenizeMemoryQuery(query)]
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .map((t) => `%${escapeLikePattern(t)}%`);
  const out: AgentMemoryChunk[] = [];
  for (const agent of agents) {
    out.push(...searchAgentDb(agent, patterns, perAgent, 4000));
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