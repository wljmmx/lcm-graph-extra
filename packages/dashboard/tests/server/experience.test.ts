/**
 * 后端路由测试：experience 路由（模块 2）。
 *
 * - mock neo4j lib 的 runReadQuery（返回构造 records）
 * - mock mcp lib 的 invokeMcpTool（验证写操作转发）
 * - 使用 fastify inject，避免真实 Neo4j / OpenClaw host
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// mock neo4j lib（避免真实 driver）
vi.mock('../../server/lib/neo4j', () => ({
  runReadQuery: vi.fn(),
  toNumber: (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    const i = v as { toNumber?: () => number; low?: number };
    if (typeof i.toNumber === 'function') return i.toNumber();
    if (typeof i.low === 'number') return i.low;
    return null;
  },
  splitTag: (v: unknown): string[] => {
    if (v === null || v === undefined) return [];
    if (Array.isArray(v)) return v as string[];
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
  },
  getNeo4jSession: vi.fn(),
  getNeo4jDriver: vi.fn(),
  closeNeo4jDriver: vi.fn(),
  closeNeo4j: vi.fn(),
}));

// mock mcp lib
vi.mock('../../server/lib/mcp', () => ({
  invokeMcpTool: vi.fn(),
}));

import { runReadQuery } from '../../server/lib/neo4j';
import { invokeMcpTool } from '../../server/lib/mcp';
import { registerExperienceRoutes } from '../../server/routes/experience';

const mockRunReadQuery = vi.mocked(runReadQuery);
const mockInvokeMcpTool = vi.mocked(invokeMcpTool);

/** 模拟 neo4j-driver record：toObject 返回传入行 */
function makeRecord(row: Record<string, unknown>) {
  return { toObject: () => row };
}

/** 模拟 QueryResult */
function makeResult(records: Array<Record<string, unknown>>) {
  return { records: records.map(makeRecord) };
}

/** 构造一个完整的列表行（含 tags 逗号分隔字符串） */
function makeListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    title: '测试经验',
    summary: '这是一条测试经验',
    type: 'lesson',
    status: 'DISTILLED',
    state: null,
    relevanceScore: 0.8,
    qualityScore: 0.7,
    matchCount: 3,
    createdAt: 1700000000000,
    lastValidatedAt: 1700000001000,
    tags_scenario: 'bug-fix,refactor',
    tags_techStack: 'frontend,vue',
    tags_severity: 'major',
    tags_free: 'tag1,tag2',
    projectName: 'demo',
    ...overrides,
  };
}

/** 构造详情行 */
function makeDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    ...makeListRow(),
    detail: '完整描述',
    context: '上下文内容',
    source: 'correction',
    sessionId: 'sess-1',
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerExperienceRoutes(app);
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockRunReadQuery.mockResolvedValue(makeResult([]));
  mockInvokeMcpTool.mockResolvedValue({ ok: true, result: { success: true } });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/experience/list', () => {
  it('返回 { total, items }，items 字段映射到 API 契约（tags 拆分为数组）', async () => {
    // 第一次调用：list 查询；第二次调用：count 查询
    mockRunReadQuery
      .mockResolvedValueOnce(makeResult([makeListRow()]))
      .mockResolvedValueOnce(makeResult([{ total: 1 }]));

    const res = await app.inject({ method: 'GET', url: '/api/experience/list' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.id).toBe('exp-1');
    expect(item.title).toBe('测试经验');
    expect(item.tags.scenario).toEqual(['bug-fix', 'refactor']);
    expect(item.tags.techStack).toEqual(['frontend', 'vue']);
    expect(item.tags.severity).toBe('major');
    expect(item.tags.free).toEqual(['tag1', 'tag2']);
    expect(item.projectName).toBe('demo');
    expect(item.relevanceScore).toBe(0.8);
    expect(item.qualityScore).toBe(0.7);
  });

  it('空结果 → total=0, items=[]', async () => {
    mockRunReadQuery
      .mockResolvedValueOnce(makeResult([]))
      .mockResolvedValueOnce(makeResult([{ total: 0 }]));

    const res = await app.inject({ method: 'GET', url: '/api/experience/list' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 0, items: [] });
  });

  it('limit 上限 100（超限截断）', async () => {
    mockRunReadQuery
      .mockResolvedValueOnce(makeResult([]))
      .mockResolvedValueOnce(makeResult([{ total: 0 }]));

    await app.inject({ method: 'GET', url: '/api/experience/list?limit=9999' });
    // 第一次调用是 list 查询，检查 limit 参数
    const listCall = mockRunReadQuery.mock.calls[0];
    expect(listCall?.[1]).toMatchObject({ limit: 100 });
  });

  it('query 异常 → 降级返回空结果', async () => {
    mockRunReadQuery.mockRejectedValue(new Error('Neo4j 不可达'));

    const res = await app.inject({ method: 'GET', url: '/api/experience/list' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 0, items: [] });
  });
});

describe('GET /api/experience/:id', () => {
  it('返回详情（含 detail/context/source/sessionId）', async () => {
    mockRunReadQuery.mockResolvedValueOnce(makeResult([makeDetailRow()]));

    const res = await app.inject({ method: 'GET', url: '/api/experience/exp-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('exp-1');
    expect(body.detail).toBe('完整描述');
    expect(body.context).toBe('上下文内容');
    expect(body.source).toBe('correction');
    expect(body.sessionId).toBe('sess-1');
    expect(body.tags.scenario).toEqual(['bug-fix', 'refactor']);
  });

  it('不存在 → 404', async () => {
    mockRunReadQuery.mockResolvedValueOnce(makeResult([]));

    const res = await app.inject({ method: 'GET', url: '/api/experience/no-such-id' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/experience/relations/:id', () => {
  it('返回 nodes + edges（去重）', async () => {
    mockRunReadQuery.mockResolvedValueOnce(
      makeResult([
        {
          id: 'other-1',
          name: '关联经验 1',
          type: 'EXPERIENCE',
          pagerank: 1.5,
          relType: 'RELATED_TO',
          source: 'exp-1',
          target: 'other-1',
        },
        {
          id: 'other-2',
          name: '关联经验 2',
          type: 'EXPERIENCE',
          pagerank: 0,
          relType: 'RELATED_TO',
          source: 'exp-1',
          target: 'other-2',
        },
        // 重复边（应去重）
        {
          id: 'other-1',
          name: '关联经验 1',
          type: 'EXPERIENCE',
          pagerank: 1.5,
          relType: 'RELATED_TO',
          source: 'exp-1',
          target: 'other-1',
        },
      ]),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/experience/relations/exp-1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 去重后 nodes：other-1, other-2, exp-1（自身）
    const nodeIds = body.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain('other-1');
    expect(nodeIds).toContain('other-2');
    expect(nodeIds).toContain('exp-1');
    // 重复边已去重
    expect(body.edges).toHaveLength(2);
  });

  it('relations 路径返回孤立节点（自身）', async () => {
    mockRunReadQuery.mockResolvedValueOnce(makeResult([]));

    const res = await app.inject({
      method: 'GET',
      url: '/api/experience/relations/iso-1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].id).toBe('iso-1');
    expect(body.edges).toEqual([]);
  });
});

describe('GET /api/experience/:id/quality-history', () => {
  it('返回单点（qualityScore + lastValidatedAt）', async () => {
    mockRunReadQuery.mockResolvedValueOnce(
      makeResult([
        { qualityScore: 0.85, lastValidatedAt: 1700000001000 },
      ]),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/experience/exp-1/quality-history',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.points).toHaveLength(1);
    expect(body.points[0].qualityScore).toBe(0.85);
    expect(body.points[0].timestamp).toBe(1700000001000);
  });

  it('不存在 → points 为空数组', async () => {
    mockRunReadQuery.mockResolvedValueOnce(makeResult([]));

    const res = await app.inject({
      method: 'GET',
      url: '/api/experience/no-such-id/quality-history',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toEqual([]);
  });
});

describe('POST /api/mcp/invoke', () => {
  it('缺失 tool → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/invoke',
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('转发 tool + params 到 invokeMcpTool', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/invoke',
      payload: { tool: 'lcmg_forget', params: { id: 'exp-1', mode: 'soft' } },
    });
    expect(res.statusCode).toBe(200);
    expect(mockInvokeMcpTool).toHaveBeenCalledWith('lcmg_forget', {
      id: 'exp-1',
      mode: 'soft',
    });
    expect(res.json().ok).toBe(true);
  });

  it('lcmg_pin unpin 参数透传', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/mcp/invoke',
      payload: { tool: 'lcmg_pin', params: { id: 'exp-1', unpin: true } },
    });
    expect(mockInvokeMcpTool).toHaveBeenCalledWith('lcmg_pin', {
      id: 'exp-1',
      unpin: true,
    });
  });

  it('invokeMcpTool 失败 → 透传 ok:false + error', async () => {
    mockInvokeMcpTool.mockResolvedValueOnce({
      ok: false,
      error: 'host 不可达',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/invoke',
      payload: { tool: 'lcmg_forget', params: { id: 'exp-1', mode: 'hard', confirm: true } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('host 不可达');
  });
});
