/**
 * 经验管理路由（模块 2）。
 *
 * - GET /api/experience/list                —— 列表查询（直读 Neo4j，分页 + 过滤）
 * - GET /api/experience/:id                 —— 单条详情
 * - GET /api/experience/relations/:id       —— RELATED_TO 邻接子图（供 ECharts Graph）
 * - GET /api/experience/:id/quality-history —— qualityScore 历史（MVP 单点）
 * - POST /api/mcp/invoke                    —— 写操作统一走 MCP（lcmg_forget / lcmg_pin）
 *
 * 设计原则：只读 Neo4j，写操作走 MCP。前端通过 POST /api/mcp/invoke 触发遗忘/固定。
 */
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import { runReadQuery, runWriteQuery, toNumber, splitTag } from '../lib/neo4j';
import { invokeMcpTool } from '../lib/mcp';

// ---------------------------------------------------------------------------
// 路径安全：backup/restore 工具的路径参数必须位于 ~/.openclaw 之下
// ---------------------------------------------------------------------------

const OPENCLAW_ROOT = path.join(os.homedir(), '.openclaw');

/**
 * 校验路径解析后位于 ~/.openclaw 之下（服务端硬墙，前端校验可被绕过）。
 * @returns null 通过，否则为错误文案
 */
function validatePathUnderOpenclaw(p: unknown, field: string): string | null {
  if (typeof p !== 'string' || !p.trim()) return `${field}不能为空`;
  const home = os.homedir();
  const root = path.join(home, '.openclaw');
  // 展开 ~ 为 home 后 resolve
  const expanded = p.replace(/^~(?=$|[/\\])/, home);
  const resolved = path.resolve(expanded);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return `${field}必须位于 ~/.openclaw 之下`;
  }
  return null;
}

/** MCP 工具名白名单：dashboard 仅允许转发以下工具（纵深防御） */
const ALLOWED_MCP_TOOLS = new Set<string>([
  'lcmg_maintain',
  'lcmg_diagnose',
  'lcmg_distill',
  'lcmg_backfill',
  'lcmg_compact',
  'lcmg_reset_breaker',
  'lcmg_backup',
  'lcmg_restore',
  'lcmg_sync',
  'lcmg_import',
  'lcmg_forget',
  'lcmg_pin',
]);

// ---------------------------------------------------------------------------
// 类型定义（与 src/api/experience.ts 对齐）
// ---------------------------------------------------------------------------

export interface ExperienceItem {
  id: string;
  title: string;
  summary: string;
  type: string;
  status: string;
  state: string | null;
  relevanceScore: number;
  qualityScore: number | null;
  matchCount: number;
  createdAt: number;
  lastValidatedAt: number | null;
  tags: { scenario: string[]; techStack: string[]; severity: string; free: string[] };
  projectName: string;
}

export interface ExperienceListResponse {
  total: number;
  items: ExperienceItem[];
}

export interface ExperienceDetail extends ExperienceItem {
  context: string;
  detail: string;
  source: string;
  sessionId: string;
}

export interface ExperienceGraph {
  nodes: Array<{ id: string; name: string; type: string; pagerank: number }>;
  edges: Array<{ source: string; target: string; type: string }>;
}

export interface QualityHistoryPoint {
  qualityScore: number | null;
  timestamp: number | null;
  delta?: number | null;
  source?: 'gm-pro' | 'local' | null;
}

// ---------------------------------------------------------------------------
// Cypher 查询
// ---------------------------------------------------------------------------

const LIST_CYPHER = `
MATCH (e:EXPERIENCE)
WHERE ($status = 'all' OR e.status = $status)
  AND (e.state IS NULL OR e.state <> 'superseded')
  AND ($type IS NULL OR e.type = $type)
  AND ($from IS NULL OR coalesce(e.createdAt, 0) >= $from)
  AND ($to IS NULL OR coalesce(e.createdAt, 0) <= $to)
  AND ($tag IS NULL OR e.communityId = $tag)
  AND ($freeTag IS NULL OR toLower(e.tags_free) CONTAINS toLower($freeTag))
  AND ($projectName IS NULL OR toLower(e.projectName) = toLower($projectName))
RETURN e.id AS id, e.title AS title, e.summary AS summary, e.type AS type,
       e.status AS status, e.state AS state, e.relevanceScore AS relevanceScore,
       e.qualityScore AS qualityScore, e.matchCount AS matchCount,
       e.createdAt AS createdAt, e.lastValidatedAt AS lastValidatedAt,
       e.tags_scenario AS tags_scenario, e.tags_techStack AS tags_techStack,
       e.tags_severity AS tags_severity, e.tags_free AS tags_free,
       e.projectName AS projectName
ORDER BY e.createdAt DESC
SKIP toInteger($offset) LIMIT toInteger($limit)
`;

const COUNT_CYPHER = `
MATCH (e:EXPERIENCE)
WHERE ($status = 'all' OR e.status = $status)
  AND (e.state IS NULL OR e.state <> 'superseded')
  AND ($type IS NULL OR e.type = $type)
  AND ($from IS NULL OR coalesce(e.createdAt, 0) >= $from)
  AND ($to IS NULL OR coalesce(e.createdAt, 0) <= $to)
  AND ($tag IS NULL OR e.communityId = $tag)
  AND ($freeTag IS NULL OR toLower(e.tags_free) CONTAINS toLower($freeTag))
  AND ($projectName IS NULL OR toLower(e.projectName) = toLower($projectName))
RETURN count(e) AS total
`;

const DETAIL_CYPHER = `
MATCH (e:EXPERIENCE {id: $id})
RETURN e.id AS id, e.title AS title, e.summary AS summary, e.detail AS detail,
       e.context AS context, e.source AS source, e.sessionId AS sessionId,
       e.type AS type, e.status AS status, e.state AS state,
       e.relevanceScore AS relevanceScore, e.qualityScore AS qualityScore,
       e.matchCount AS matchCount, e.createdAt AS createdAt,
       e.lastValidatedAt AS lastValidatedAt,
       e.tags_scenario AS tags_scenario, e.tags_techStack AS tags_techStack,
       e.tags_severity AS tags_severity, e.tags_free AS tags_free,
       e.projectName AS projectName
`;

const RELATIONS_CYPHER = `
MATCH (e:EXPERIENCE {id: $id})-[r:RELATED_TO]-(n)
RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
       coalesce(n.pagerank, 0) AS pagerank,
       type(r) AS relType, startNode(r).id AS source, endNode(r).id AS target
`;

const QUALITY_HISTORY_CYPHER = `
MATCH (e:EXPERIENCE {id: $id})
RETURN e.qualityScore AS qualityScore,
       e.lastValidatedAt AS lastValidatedAt,
       e.qualityScoreHistory AS qualityScoreHistory
`;

// ---------------------------------------------------------------------------
// 行 → API 响应映射
// ---------------------------------------------------------------------------

interface RawListRow {
  id: string;
  title: string;
  summary: string;
  type: string;
  status: string;
  state: string | null;
  relevanceScore: number;
  qualityScore: number | null;
  matchCount: number;
  createdAt: number;
  lastValidatedAt: number | null;
  tags_scenario: string;
  tags_techStack: string;
  tags_severity: string;
  tags_free: string;
  projectName: string;
}

interface RawDetailRow extends RawListRow {
  detail: string;
  context: string;
  source: string;
  sessionId: string;
}

/** 把 Neo4j record 转成 list item（处理 Integer / tags 拆分） */
function rowToItem(r: RawListRow): ExperienceItem {
  return {
    id: r.id,
    title: r.title ?? '',
    summary: r.summary ?? '',
    type: r.type ?? 'lesson',
    status: r.status ?? 'PENDING',
    state: r.state ?? null,
    relevanceScore: toNumber(r.relevanceScore) ?? 0,
    qualityScore: toNumber(r.qualityScore),
    matchCount: toNumber(r.matchCount) ?? 0,
    createdAt: toNumber(r.createdAt) ?? 0,
    lastValidatedAt: toNumber(r.lastValidatedAt),
    tags: {
      scenario: splitTag(r.tags_scenario),
      techStack: splitTag(r.tags_techStack),
      severity: typeof r.tags_severity === 'string' ? r.tags_severity : '',
      free: splitTag(r.tags_free),
    },
    projectName: r.projectName ?? '',
  };
}

function rowToDetail(r: RawDetailRow): ExperienceDetail {
  return {
    ...rowToItem(r),
    detail: r.detail ?? '',
    context: r.context ?? '',
    source: r.source ?? '',
    sessionId: r.sessionId ?? '',
  };
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** 解析可选数字参数（无效/缺省返回 null） */
function parseOptionalNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 解析可选字符串参数（空串视为 null） */
function parseOptionalString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export async function registerExperienceRoutes(app: FastifyInstance): Promise<void> {
  // ===== 列表查询 =====
  app.get('/api/experience/list', async (req, _reply) => {
    const q = (req.query as Record<string, unknown>) ?? {};
    const status = parseOptionalString(q.status) ?? 'all';
    const type = parseOptionalString(q.type);
    const from = parseOptionalNumber(q.from);
    const to = parseOptionalNumber(q.to);
    const tag = parseOptionalString(q.tag);
    const projectName = parseOptionalString(q.projectName);
    const limitRaw = parseOptionalNumber(q.limit);
    const limit = Math.min(Math.max(limitRaw ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(parseOptionalNumber(q.offset) ?? 0, 0);

    const params = {
      status,
      type: type ?? null,
      from: from ?? null,
      to: to ?? null,
      tag: tag ?? null,
      projectName: projectName ?? null,
      limit,
      offset,
    };

    try {
      const [listRes, countRes] = await Promise.all([
        runReadQuery(LIST_CYPHER, params),
        runReadQuery(COUNT_CYPHER, params),
      ]);

      const items = listRes.records.map((rec) => rowToItem(rec.toObject() as RawListRow));
      const totalRow = countRes.records[0]?.toObject() as { total?: unknown } | undefined;
      const total = toNumber(totalRow?.total) ?? 0;

      return { total, items } satisfies ExperienceListResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, 'experience/list 查询失败');
      return { total: 0, items: [] } satisfies ExperienceListResponse;
    }
  });

  // ===== 关联子图（注意：放在 :id 之前，避免被 :id 路由吞掉） =====
  app.get('/api/experience/relations/:id', async (req, reply) => {
    const { id } = (req.params as { id: string }) ?? {};
    if (!id) {
      reply.code(400);
      return { error: 'missing id' };
    }
    try {
      const res = await runReadQuery(RELATIONS_CYPHER, { id });
      const nodeMap = new Map<string, { id: string; name: string; type: string; pagerank: number }>();
      const edgeSet = new Set<string>();
      const edges: ExperienceGraph['edges'] = [];

      for (const rec of res.records) {
        const row = rec.toObject() as {
          id: string;
          name: string;
          type: string;
          pagerank: unknown;
          relType: string;
          source: string;
          target: string;
        };
        // 节点去重
        if (row.id && !nodeMap.has(row.id)) {
          nodeMap.set(row.id, {
            id: row.id,
            name: row.name ?? row.id,
            type: row.type ?? 'UNKNOWN',
            pagerank: toNumber(row.pagerank) ?? 0,
          });
        }
        // 边去重（用 source|target|type 作为 key）
        const edgeKey = `${row.source}|${row.target}|${row.relType}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({ source: row.source, target: row.target, type: row.relType });
        }
      }

      // 当前经验节点本身也加入 nodes（避免孤立点无节点）
      if (!nodeMap.has(id)) {
        nodeMap.set(id, { id, name: id, type: 'EXPERIENCE', pagerank: 0 });
      }

      return { nodes: Array.from(nodeMap.values()), edges } satisfies ExperienceGraph;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, 'experience/relations 查询失败');
      return { nodes: [], edges: [] } satisfies ExperienceGraph;
    }
  });

  // ===== 质量分历史（含完整时序） =====
  // 注意：此路由路径含 quality-history 后缀，须放在 :id 之前注册以匹配优先级
  app.get('/api/experience/:id/quality-history', async (req, reply) => {
    const { id } = (req.params as { id: string }) ?? {};
    if (!id) {
      reply.code(400);
      return { error: 'missing id' };
    }
    try {
      const res = await runReadQuery(QUALITY_HISTORY_CYPHER, { id });
      const row = res.records[0]?.toObject() as
        | { qualityScore?: unknown; lastValidatedAt?: unknown; qualityScoreHistory?: unknown }
        | undefined;
      const points: QualityHistoryPoint[] = [];
      if (row) {
        // 优先使用完整时序（qualityScoreHistory 数组）
        const historyArr = Array.isArray(row.qualityScoreHistory) ? row.qualityScoreHistory : [];
        if (historyArr.length > 0) {
          for (const item of historyArr) {
            const it = item as { ts?: unknown; score?: unknown; delta?: unknown; source?: unknown };
            points.push({
              qualityScore: toNumber(it.score),
              timestamp: toNumber(it.ts),
              delta: it.delta == null ? null : toNumber(it.delta),
              source: it.source === 'gm-pro' || it.source === 'local' ? it.source : null,
            });
          }
        }
        // 兜底：若没有历史数组，至少返回当前 qualityScore 单点
        if (points.length === 0 && row.qualityScore != null) {
          points.push({
            qualityScore: toNumber(row.qualityScore),
            timestamp: toNumber(row.lastValidatedAt),
          });
        }
      }
      return { points };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, 'experience/quality-history 查询失败');
      return { points: [] };
    }
  });

  // ===== 单条详情 =====
  app.get('/api/experience/:id', async (req, reply) => {
    const { id } = (req.params as { id: string }) ?? {};
    if (!id) {
      reply.code(400);
      return { error: 'missing id' };
    }
    try {
      const res = await runReadQuery(DETAIL_CYPHER, { id });
      const row = res.records[0]?.toObject() as RawDetailRow | undefined;
      if (!row) {
        reply.code(404);
        return { error: 'not found' };
      }
      return rowToDetail(row) satisfies ExperienceDetail;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, 'experience/:id 查询失败');
      // C1 修复: 与同模块 list/relations/quality-history 一致，Neo4j 故障时降级
      // 返回 200 + error 字段，而非 500 —— 避免 ExperienceView 抛 ApiError 导致详情抽屉
      // 显示"加载中"或空白。前端 fetchExperienceDetail 会拿到 error 字段并展示。
      return {
        error: '详情查询失败，请查看服务端日志（Neo4j 不可达？）',
      } as unknown as ExperienceDetail;
    }
  });

  // ===== P3-4: 标签管理 —— 统计所有 freeTags 及其出现次数 =====
  app.get('/api/experience/tags', async (_req, _reply) => {
    try {
      const res = await runReadQuery(`
        MATCH (e:EXPERIENCE)
        WHERE e.status = 'DISTILLED'
          AND e.tags_free IS NOT NULL
          AND e.tags_free <> ''
        RETURN e.tags_free AS tags_free
      `);

      const countMap = new Map<string, number>();
      for (const rec of res.records) {
        const row = rec.toObject() as { tags_free: string };
        const tags = (row.tags_free || '').split(',').filter(Boolean);
        for (const t of tags) {
          const normalized = t.trim().toLowerCase();
          if (normalized) {
            countMap.set(normalized, (countMap.get(normalized) ?? 0) + 1);
          }
        }
      }

      const items = Array.from(countMap.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);

      return { ok: true, items, total: items.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg, items: [], total: 0 };
    }
  });

  // ===== P3-4: 标签合并 —— 将 fromTag 合并到 toTag =====
  app.post('/api/experience/tags/merge', async (req, reply) => {
    const body = (req.body as { from?: string; to?: string }) ?? {};
    const fromTag = body.from?.trim().toLowerCase();
    const toTag = body.to?.trim().toLowerCase();

    if (!fromTag || !toTag) {
      reply.code(400);
      return { ok: false, error: 'from 和 to 参数不能为空' };
    }
    if (fromTag === toTag) {
      reply.code(400);
      return { ok: false, error: 'from 和 to 不能相同' };
    }

    try {
      const res = await runWriteQuery(`
        MATCH (e:EXPERIENCE)
        WHERE e.status = 'DISTILLED'
          AND e.tags_free IS NOT NULL
          AND e.tags_free <> ''
        WITH e,
             [t IN split(e.tags_free, ',') WHERE trim(toLower(t)) = $from] AS matched,
             [t IN split(e.tags_free, ',') WHERE trim(toLower(t)) <> $from] AS others
        WHERE size(matched) > 0
        SET e.tags_free = reduce(
          s = '', t IN (others + [$to]) | CASE WHEN s = '' THEN t ELSE s + ',' + t END
        )
        RETURN count(e) AS affected
      `, { from: fromTag, to: toTag });

      const row = res.records[0]?.toObject() as { affected?: unknown } | undefined;
      const affected = toNumber(row?.affected) ?? 0;

      return { ok: true, affected, message: `已将 ${affected} 个节点中的 "${fromTag}" 合并为 "${toTag}"` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { ok: false, error: msg, affected: 0 };
    }
  });

  // ===== MCP 写操作转发：lcmg_forget / lcmg_pin 等 =====
  app.post('/api/mcp/invoke', async (req, reply) => {
    const body = (req.body as { tool?: string; params?: Record<string, unknown>; user?: string; sessionId?: string }) ?? {};
    const tool = body.tool;
    const params = body.params ?? {};
    if (!tool || typeof tool !== 'string') {
      reply.code(400);
      return { ok: false, error: 'missing tool' };
    }
    // P1 安全：MCP 工具名白名单（纵深防御，阻止调用未在 UI 暴露的危险工具）
    if (!ALLOWED_MCP_TOOLS.has(tool)) {
      reply.code(400);
      return { ok: false, error: `tool "${tool}" not allowed` };
    }
    // P0 安全：backup/restore 路径参数必须在 ~/.openclaw 之下（服务端硬墙）
    if (tool === 'lcmg_backup') {
      const err = validatePathUnderOpenclaw(params.outputPath, 'outputPath');
      if (err) {
        reply.code(400);
        return { ok: false, error: err };
      }
    }
    if (tool === 'lcmg_restore') {
      const err = validatePathUnderOpenclaw(params.backupPath, 'backupPath');
      if (err) {
        reply.code(400);
        return { ok: false, error: err };
      }
    }
    const startTs = Date.now();
    let result: any;
    let error: string | undefined;
    try {
      result = await invokeMcpTool(tool, params);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      result = { ok: false, error };
    }
    // 持久化操作日志
    try {
      const { appendOperationLog } = await import('../lib/operation-logs');
      // v1.0.1-6: 提取 user / session_id（从请求头或 body 透传）
      const user = (req.headers['x-user'] as string) || (body.user as string) || undefined;
      const sessionId = (req.headers['x-session-id'] as string) || (body.sessionId as string) || undefined;
      appendOperationLog({
        ts: startTs,
        tool,
        params,
        result: result ?? null,
        status: error ? 'failure' : 'success',
        durationMs: Date.now() - startTs,
        error,
        user,
        sessionId,
      });
    } catch {
      /* 日志写入失败不阻塞响应 */
    }
    return result;
  });

  // ===== 操作日志查询（v1.0.1-6 增强：支持 user / from / to 过滤） =====
  app.get('/api/operation-logs', async (req, reply) => {
    const query = req.query as { n?: string; tool?: string; user?: string; from?: string; to?: string };
    try {
      const { queryOperationLogs } = await import('../lib/operation-logs');
      const rows = queryOperationLogs({
        n: query.n ? parseInt(query.n, 10) : 50,
        tool: query.tool || undefined,
        user: query.user || undefined,
        fromTs: query.from ? parseInt(query.from, 10) : undefined,
        toTs: query.to ? parseInt(query.to, 10) : undefined,
      });
      // 反序列化 JSON 字段
      const logs = rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        tool: r.tool,
        params: safeJsonParse(r.params_json, {}),
        result: safeJsonParse(r.result_json, null),
        status: r.status,
        durationMs: r.duration_ms,
        error: r.error,
        // v1.0.1-6: 返回合规审计字段
        user: r.user ?? null,
        sessionId: r.session_id ?? null,
      }));
      return { logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, 'operation-logs 查询失败');
      return { logs: [] };
    }
  });
}

function safeJsonParse(s: string | null | undefined, fallback: unknown): unknown {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
