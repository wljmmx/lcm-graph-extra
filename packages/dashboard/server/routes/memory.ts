/**
 * 记忆查询路由（模块 3）。
 *
 * - GET /api/memory/search?q=&engines=all&limit=10 —— 跨引擎联合搜索（lcm + qmd + neo4j）
 * - GET /api/memory/graph?q=&limit=20              —— 图谱节点子集（供 ECharts Graph 浏览）
 *
 * 设计原则：三引擎并行 + 独立降级（单引擎失败不阻塞其他）。
 * - lcm 引擎：直读 lcm.db（messages/conversations/summaries 表 LIKE 搜索）
 * - qmd 引擎：直读 QMD MCP REST（env QMD_URL，默认 http://127.0.0.1:8081）
 * - neo4j 引擎：直读 Neo4j（过滤 state='superseded' 的 EXPERIENCE 节点）
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../lib/db';
import { runReadQuery, toNumber } from '../lib/neo4j';

// ---------------------------------------------------------------------------
// 类型定义（与 src/api/memory.ts 对齐）
// ---------------------------------------------------------------------------

export interface MemorySearchResult {
  source: 'lcm' | 'qmd' | 'neo4j';
  content: string;
  file?: string;
  sessionId?: string;
  type?: string;
  score?: number;
  pagerank?: number;
  timestamp?: number | string;
}

export interface MemorySearchResponse {
  results: {
    lcm: MemorySearchResult[];
    qmd: MemorySearchResult[];
    neo4j: MemorySearchResult[];
  };
  total: number;
  errors?: { lcm?: string; qmd?: string; neo4j?: string };
}

export interface MemoryGraphNode {
  id: string;
  name: string;
  type: string;
  pagerank: number;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface MemoryGraphResponse {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

// ---------------------------------------------------------------------------
// Cypher 查询
// ---------------------------------------------------------------------------

/** neo4j 搜索：按 name/title CONTAINS，过滤 superseded EXPERIENCE */
const NEO4J_SEARCH_CYPHER = `
MATCH (n)
WHERE (n.name CONTAINS $q OR n.title CONTAINS $q)
  AND NOT (n:EXPERIENCE AND n.state = 'superseded')
RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
       coalesce(n.pagerank, 0) AS pagerank
LIMIT toInteger($limit)
`;

/** 图谱浏览（q 非空）：含关系的子图，过滤 superseded */
const GRAPH_WITH_EDGES_CYPHER = `
MATCH (n)
WHERE ($q IS NULL OR $q = '' OR n.name CONTAINS $q OR n.title CONTAINS $q)
  AND NOT (n:EXPERIENCE AND n.state = 'superseded')
OPTIONAL MATCH (n)-[r]-(m)
WHERE NOT (m:EXPERIENCE AND m.state = 'superseded')
WITH n, r, m
LIMIT toInteger($limit)
RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
       coalesce(n.pagerank, 0) AS pagerank,
       type(r) AS relType, m.id AS targetId, m.name AS targetName,
       labels(m)[0] AS targetType
`;

/** 图谱浏览（q 为空）：仅 top pagerank 节点，不查边（避免全图扫描） */
const GRAPH_TOP_CYPHER = `
MATCH (n)
WHERE NOT (n:EXPERIENCE AND n.state = 'superseded')
RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
       coalesce(n.pagerank, 0) AS pagerank
ORDER BY pagerank DESC
LIMIT toInteger($limit)
`;

// ---------------------------------------------------------------------------
// LCM 引擎：直读 lcm.db
// ---------------------------------------------------------------------------

/** 转义 SQLite LIKE 特殊字符（\ % _），配合 ESCAPE '\\' 使用 */
function escapeLikePattern(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 单表 LIKE 搜索（失败返回空数组，不抛错） */
function searchLcmTable(
  db: NonNullable<ReturnType<typeof getDb>>,
  sql: string,
  params: unknown[],
  mapRow: (row: Record<string, unknown>) => MemorySearchResult,
): MemorySearchResult[] {
  try {
    const stmt = db.prepare(sql);
    const rows = (stmt.all(...params) ?? []) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  } catch {
    // 表不存在或查询失败 → 降级空数组
    return [];
  }
}

/** LCM 三表并行 LIKE 搜索 */
function searchLcm(q: string, limit: number): MemorySearchResult[] {
  const db = getDb();
  if (!db) return []; // lcm.db 不可用 → 降级
  const pattern = `%${escapeLikePattern(q)}%`;
  const results: MemorySearchResult[] = [];

  // messages 表：搜索 content
  results.push(
    ...searchLcmTable(
      db,
      "SELECT content, conversation_id, created_at FROM messages WHERE content LIKE ? ESCAPE '\\' LIMIT ?",
      [pattern, limit],
      (r) => ({
        source: 'lcm' as const,
        content: String(r.content ?? ''),
        sessionId: r.conversation_id != null ? String(r.conversation_id) : undefined,
        score: 1.0,
        timestamp: r.created_at != null ? String(r.created_at) : undefined,
      }),
    ),
  );

  // conversations 表：搜索 session_id / session_key
  results.push(
    ...searchLcmTable(
      db,
      "SELECT session_id, session_key, conversation_id FROM conversations WHERE session_id LIKE ? ESCAPE '\\' OR session_key LIKE ? ESCAPE '\\' LIMIT ?",
      [pattern, pattern, limit],
      (r) => ({
        source: 'lcm' as const,
        content: String(r.session_id ?? r.session_key ?? ''),
        sessionId: r.session_id != null ? String(r.session_id) : undefined,
        score: 1.0,
      }),
    ),
  );

  // summaries 表：搜索 content
  results.push(
    ...searchLcmTable(
      db,
      "SELECT content, conversation_id, earliest_at FROM summaries WHERE content LIKE ? ESCAPE '\\' LIMIT ?",
      [pattern, limit],
      (r) => ({
        source: 'lcm' as const,
        content: String(r.content ?? ''),
        sessionId: r.conversation_id != null ? String(r.conversation_id) : undefined,
        score: 1.0,
        timestamp: r.earliest_at != null ? String(r.earliest_at) : undefined,
      }),
    ),
  );

  return results;
}

// ---------------------------------------------------------------------------
// QMD 引擎：直读 QMD MCP REST
// ---------------------------------------------------------------------------

const QMD_BASE_URL = process.env.QMD_URL ?? 'http://127.0.0.1:8081';
// 优化: 8000ms → 5000ms。assemble 主路径 L2 已降至 3000ms，
// dashboard memory 搜索是用户主动查询，可稍宽松但仍需避免长时间阻塞
const QMD_TIMEOUT_MS = 5_000;

/** 缓存 MCP session id（与 qmd-client.ts 一致，避免重复 initialize） */
let qmdSessionId: string | null = null;

/** QMD MCP initialize 握手（获取 mcp-session-id） */
async function qmdInitialize(): Promise<string> {
  if (qmdSessionId) return qmdSessionId;
  const resp = await fetch(`${QMD_BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {} },
        clientInfo: { name: 'lcm-dashboard', version: '1.0' },
      },
    }),
    signal: AbortSignal.timeout(QMD_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`QMD initialize HTTP ${resp.status}`);
  const sid = resp.headers.get('mcp-session-id');
  if (!sid) throw new Error('QMD initialize: 缺少 mcp-session-id 响应头');
  qmdSessionId = sid;
  return sid;
}

/** QMD 搜索：MCP tools/call "query"，返回 lex+vec 混合结果 */
async function searchQmd(q: string, limit: number): Promise<MemorySearchResult[]> {
  const sid = await qmdInitialize();
  let resp: Response;
  try {
    resp = await fetch(`${QMD_BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sid,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query',
          arguments: {
            searches: [
              { type: 'lex', query: q },
              { type: 'vec', query: q },
            ],
            limit,
            minScore: 0,
            rerank: true,
          },
        },
      }),
      signal: AbortSignal.timeout(QMD_TIMEOUT_MS),
    });
  } catch (e) {
    // D1 修复: 网络错误也可能意味着 session 失效，重置以便下次重新握手
    qmdSessionId = null;
    throw e;
  }
  if (!resp.ok) {
    // D1 修复: 401/403 表示 session 已失效，重置 qmdSessionId 以便下次重新 initialize
    // 原代码仅 throw，session 永不复位 → QMD 引擎永久降级为空直到进程重启
    if (resp.status === 401 || resp.status === 403) {
      qmdSessionId = null;
    }
    throw new Error(`QMD query HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  };
  const text = data?.result?.content?.[0]?.text;
  if (!text) return [];

  let parsed: Array<{
    docid?: string; file?: string; title?: string;
    score?: number; snippet?: string; line?: number;
  }> = [];
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) parsed = v;
  } catch {
    // 非 JSON 文本（如 "No results found"），视为空
  }

  return parsed.map((r) => ({
    source: 'qmd' as const,
    content: r.title || r.snippet || r.file || r.docid || '',
    file: r.file ?? '',
    score: typeof r.score === 'number' ? r.score : 0,
  }));
}

// ---------------------------------------------------------------------------
// Neo4j 引擎：直读图谱节点
// ---------------------------------------------------------------------------

async function searchNeo4j(q: string, limit: number): Promise<MemorySearchResult[]> {
  const res = await runReadQuery(NEO4J_SEARCH_CYPHER, { q, limit });
  return res.records.map((rec) => {
    const row = rec.toObject() as {
      id: string; name: string; type: string; pagerank: unknown;
    };
    const pagerank = toNumber(row.pagerank) ?? 0;
    return {
      source: 'neo4j' as const,
      content: row.name ?? row.id ?? '',
      type: row.type ?? 'UNKNOWN',
      pagerank,
      score: pagerank,
    } satisfies MemorySearchResult;
  });
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_GRAPH_LIMIT = 20;
const MAX_GRAPH_LIMIT = 200;

function parseLimit(v: unknown, def: number, max: number): number {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.trunc(n), max);
}

function parseString(v: unknown, def: string = ''): string {
  if (v === undefined || v === null) return def;
  return String(v);
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  // ===== 跨引擎联合搜索 =====
  app.get('/api/memory/search', async (req, _reply) => {
    const q = parseString((req.query as Record<string, unknown>)?.q).trim();
    const engines = parseString((req.query as Record<string, unknown>)?.engines, 'all').trim() || 'all';
    const limit = parseLimit((req.query as Record<string, unknown>)?.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

    const response: MemorySearchResponse = {
      results: { lcm: [], qmd: [], neo4j: [] },
      total: 0,
    };

    // 空 q：直接返回空结果，不触发任何引擎
    if (!q) {
      return response;
    }

    const errors: NonNullable<MemorySearchResponse['errors']> = {};
    const wantLcm = engines === 'all' || engines === 'lcm_only';
    const wantQmd = engines === 'all' || engines === 'qmd_only';
    const wantNeo4j = engines === 'all' || engines === 'neo4j_only';

    // 三引擎独立 try-catch，并行执行
    const tasks: Promise<void>[] = [];

    if (wantLcm) {
      tasks.push(
        Promise.resolve()
          .then(() => {
            response.results.lcm = searchLcm(q, limit);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            errors.lcm = msg;
            response.results.lcm = [];
          }),
      );
    }

    if (wantQmd) {
      tasks.push(
        searchQmd(q, limit)
          .then((r) => {
            response.results.qmd = r;
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            errors.qmd = msg;
            response.results.qmd = [];
          }),
      );
    }

    if (wantNeo4j) {
      tasks.push(
        searchNeo4j(q, limit)
          .then((r) => {
            response.results.neo4j = r;
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            errors.neo4j = msg;
            response.results.neo4j = [];
          }),
      );
    }

    await Promise.all(tasks);

    response.total =
      response.results.lcm.length +
      response.results.qmd.length +
      response.results.neo4j.length;
    if (Object.keys(errors).length > 0) {
      response.errors = errors;
    }
    return response;
  });

  // ===== 图谱节点子集（供 ECharts Graph 浏览） =====
  app.get('/api/memory/graph', async (req, _reply) => {
    const q = parseString((req.query as Record<string, unknown>)?.q).trim();
    const limit = parseLimit((req.query as Record<string, unknown>)?.limit, DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT);

    try {
      // q 为空：仅返回 top pagerank 节点（不查边，避免全图扫描）
      if (!q) {
        const res = await runReadQuery(GRAPH_TOP_CYPHER, { limit });
        const nodes: MemoryGraphNode[] = res.records.map((rec) => {
          const row = rec.toObject() as {
            id: string; name: string; type: string; pagerank: unknown;
          };
          return {
            id: row.id ?? '',
            name: row.name ?? row.id ?? '',
            type: row.type ?? 'UNKNOWN',
            pagerank: toNumber(row.pagerank) ?? 0,
          };
        });
        return { nodes, edges: [] } satisfies MemoryGraphResponse;
      }

      // q 非空：含关系的子图
      const res = await runReadQuery(GRAPH_WITH_EDGES_CYPHER, { q, limit });
      const nodeMap = new Map<string, MemoryGraphNode>();
      const edgeSet = new Set<string>();
      const edges: MemoryGraphEdge[] = [];

      for (const rec of res.records) {
        const row = rec.toObject() as {
          id: string; name: string; type: string; pagerank: unknown;
          relType: string | null; targetId: string | null;
          targetName: string | null; targetType: string | null;
        };
        // 当前节点 n（去重）
        if (row.id && !nodeMap.has(row.id)) {
          nodeMap.set(row.id, {
            id: row.id,
            name: row.name ?? row.id,
            type: row.type ?? 'UNKNOWN',
            pagerank: toNumber(row.pagerank) ?? 0,
          });
        }
        // 关联节点 m + 边（去重）
        if (row.relType && row.targetId) {
          if (!nodeMap.has(row.targetId)) {
            nodeMap.set(row.targetId, {
              id: row.targetId,
              name: row.targetName ?? row.targetId,
              type: row.targetType ?? 'UNKNOWN',
              pagerank: 0,
            });
          }
          const edgeKey = `${row.id}|${row.targetId}|${row.relType}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({ source: row.id, target: row.targetId, type: row.relType });
          }
        }
      }

      return { nodes: Array.from(nodeMap.values()), edges } satisfies MemoryGraphResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, 'memory/graph 查询失败');
      return { nodes: [], edges: [] } satisfies MemoryGraphResponse;
    }
  });
}
