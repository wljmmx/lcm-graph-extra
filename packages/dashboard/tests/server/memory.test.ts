/**
 * 后端路由测试：memory 路由（模块 3）。
 *
 * - mock db lib 的 getDb（lcm.db 只读连接）
 * - mock neo4j lib 的 runReadQuery（返回构造 records）
 * - mock global fetch（QMD MCP REST 调用）
 * - 使用 fastify inject，避免真实 lcm.db / Neo4j / QMD
 *
 * 三引擎并行 + 独立降级是核心契约，重点覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// mock db lib（避免真实 lcm.db）
vi.mock('../../server/lib/db', () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
}));

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

import { getDb } from '../../server/lib/db';
import { runReadQuery } from '../../server/lib/neo4j';
import { registerMemoryRoutes } from '../../server/routes/memory';

const mockGetDb = vi.mocked(getDb);
const mockRunReadQuery = vi.mocked(runReadQuery);

/** 模拟 neo4j-driver record：toObject 返回传入行 */
function makeRecord(row: Record<string, unknown>) {
  return { toObject: () => row };
}

/** 模拟 QueryResult */
function makeResult(records: Array<Record<string, unknown>>) {
  return { records: records.map(makeRecord) };
}

/** 构造 lcm.db mock：按 SQL 中的表名返回不同行 */
function makeMockDb(tableRows: Record<string, unknown[]>) {
  return {
    prepare: vi.fn((sql: string) => {
      let rows: unknown[] = [];
      const lower = sql.toLowerCase();
      if (lower.includes('from messages')) rows = tableRows.messages ?? [];
      else if (lower.includes('from conversations')) rows = tableRows.conversations ?? [];
      else if (lower.includes('from summaries')) rows = tableRows.summaries ?? [];
      return { all: vi.fn(() => rows), get: vi.fn(() => undefined) };
    }),
    close: vi.fn(),
  };
}

/** 原始 global.fetch 引用（测试后恢复） */
const originalFetch = global.fetch;

/** mock global fetch 以模拟 QMD（REST /query 优先 + MCP 降级） */
function mockQmdFetch(results: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn().mockImplementation((url: string, opts: { body?: string } | undefined) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    // REST /query 优先路径：URL 以 /query 结尾，body 无 method 字段
    if (typeof url === 'string' && url.includes('/query') && !body.method) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ results }),
      });
    }
    // MCP 降级路径
    if (body.method === 'initialize') {
      // initialize 返回 mcp-session-id header
      const headers = new Map<string, string>();
      headers.set('mcp-session-id', 'test-session-id');
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (k: string) => headers.get(k.toLowerCase()) },
        json: () => Promise.resolve({ result: {} }),
      });
    }
    // tools/call query 返回 text 内容（JSON 字符串）
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          result: { content: [{ type: 'text', text: JSON.stringify(results) }] },
        }),
    });
  });
  global.fetch = fetchMock as unknown as typeof global.fetch;
  return fetchMock;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerMemoryRoutes(app);
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  // 默认：db 不可用 → lcm 引擎降级空数组
  mockGetDb.mockReturnValue(null);
  // 默认：neo4j 返回空
  mockRunReadQuery.mockResolvedValue(makeResult([]));
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  // 恢复 global.fetch
  global.fetch = originalFetch;
});

describe('GET /api/memory/search', () => {
  it('engines=all 返回三引擎结果（lcm + qmd + neo4j）', async () => {
    // lcm 引擎：db 返回 messages + conversations + summaries 行
    mockGetDb.mockReturnValue(
      makeMockDb({
        messages: [
          { content: 'hello test world', conversation_id: 1, created_at: '2024-01-01 10:00' },
        ],
        conversations: [
          { session_id: 'sess-test', session_key: 'key-test', conversation_id: 1 },
        ],
        summaries: [
          { content: 'summary test', conversation_id: 1, earliest_at: '2024-01-01' },
        ],
      }),
    );
    // neo4j 引擎：返回图谱节点
    mockRunReadQuery.mockResolvedValueOnce(
      makeResult([
        { id: 'node-1', name: '测试节点', type: 'TASK', pagerank: 1.5 },
      ]),
    );
    // qmd 引擎：mock fetch
    const fetchMock = mockQmdFetch([
      { docid: 'd1', file: 'src/a.ts', title: 'A 文档', score: 0.9, snippet: 'test snippet', line: 10 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/search?q=test&engines=all&limit=10',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 三引擎都有结果
    expect(body.results.lcm).toHaveLength(3); // messages + conversations + summaries
    expect(body.results.qmd).toHaveLength(1);
    expect(body.results.neo4j).toHaveLength(1);
    // total = 三引擎之和
    expect(body.total).toBe(5);
    // lcm 结果字段
    const lcmMsg = body.results.lcm.find((r: { content: string }) => r.content.includes('hello test world'));
    expect(lcmMsg).toBeDefined();
    expect(lcmMsg.source).toBe('lcm');
    expect(String(lcmMsg.sessionId)).toBe('1');
    // qmd 结果字段
    expect(body.results.qmd[0].source).toBe('qmd');
    expect(body.results.qmd[0].file).toBe('src/a.ts');
    expect(body.results.qmd[0].score).toBe(0.9);
    // neo4j 结果字段
    expect(body.results.neo4j[0].source).toBe('neo4j');
    expect(body.results.neo4j[0].type).toBe('TASK');
    expect(body.results.neo4j[0].pagerank).toBe(1.5);
    // fetch 被调用（QMD initialize + query）
    expect(fetchMock).toHaveBeenCalled();
  });

  it('engines=lcm_only 只返回 lcm（不调 qmd / neo4j）', async () => {
    mockGetDb.mockReturnValue(
      makeMockDb({
        messages: [{ content: 'test msg', conversation_id: 2, created_at: '2024-02-01' }],
        conversations: [],
        summaries: [],
      }),
    );
    const fetchMock = mockQmdFetch([]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/search?q=test&engines=lcm_only',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.lcm).toHaveLength(1);
    expect(body.results.qmd).toEqual([]);
    expect(body.results.neo4j).toEqual([]);
    // qmd fetch 不应被调用
    expect(fetchMock).not.toHaveBeenCalled();
    // neo4j 不应被调用
    expect(mockRunReadQuery).not.toHaveBeenCalled();
  });

  it('engines=qmd_only 只返回 qmd', async () => {
    mockQmdFetch([
      { docid: 'd2', file: 'b.md', title: 'B', score: 0.5, snippet: 'snip', line: 1 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/search?q=test&engines=qmd_only',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.qmd).toHaveLength(1);
    expect(body.results.lcm).toEqual([]);
    expect(body.results.neo4j).toEqual([]);
  });

  it('engines=neo4j_only 只返回 neo4j', async () => {
    mockRunReadQuery.mockResolvedValueOnce(
      makeResult([
        { id: 'n2', name: '节点2', type: 'ENTITY', pagerank: 0.8 },
      ]),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/search?q=test&engines=neo4j_only',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.neo4j).toHaveLength(1);
    expect(body.results.lcm).toEqual([]);
    expect(body.results.qmd).toEqual([]);
  });

  it('某引擎失败时返回空数组 + error 字段（不阻塞其他引擎）', async () => {
    // lcm: db 不可用（返回 null）→ 降级空数组
    mockGetDb.mockReturnValue(null);
    // neo4j: 抛错
    mockRunReadQuery.mockRejectedValueOnce(new Error('Neo4j 不可达'));
    // qmd: 正常
    mockQmdFetch([
      { docid: 'd3', file: 'c.ts', title: 'C', score: 0.7, snippet: 's', line: 5 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/search?q=test&engines=all',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // lcm 降级空数组（db 不可用，无 error 或有 error）
    expect(body.results.lcm).toEqual([]);
    // qmd 正常
    expect(body.results.qmd).toHaveLength(1);
    // neo4j 失败 → 空数组 + error
    expect(body.results.neo4j).toEqual([]);
    expect(body.errors).toBeDefined();
    expect(body.errors.neo4j).toContain('Neo4j 不可达');
  });

  it('qmd 引擎失败（fetch 抛错）→ 空数组 + error', async () => {
    // fetch 抛错
    global.fetch = vi.fn().mockRejectedValue(new Error('QMD 连接失败')) as unknown as typeof global.fetch;

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/search?q=test&engines=qmd_only',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.qmd).toEqual([]);
    expect(body.errors?.qmd).toContain('QMD 连接失败');
  });

  it('空 q → 返回空结果（不触发查询）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/search?q=&engines=all',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.results.lcm).toEqual([]);
    expect(body.results.qmd).toEqual([]);
    expect(body.results.neo4j).toEqual([]);
    // 空查询不应触发任何引擎
    expect(mockRunReadQuery).not.toHaveBeenCalled();
  });
});

describe('GET /api/memory/graph', () => {
  it('q=test 返回 nodes + edges（去重）', async () => {
    mockRunReadQuery.mockResolvedValueOnce(
      makeResult([
        {
          id: 'n1', name: '节点1', type: 'TASK', pagerank: 1.2,
          relType: 'RELATED_TO', targetId: 'n2', targetName: '节点2', targetType: 'ENTITY',
        },
        {
          id: 'n2', name: '节点2', type: 'ENTITY', pagerank: 0.5,
          relType: 'RELATED_TO', targetId: 'n1', targetName: '节点1', targetType: 'TASK',
        },
        // 重复边（应去重）
        {
          id: 'n1', name: '节点1', type: 'TASK', pagerank: 1.2,
          relType: 'RELATED_TO', targetId: 'n2', targetName: '节点2', targetType: 'ENTITY',
        },
      ]),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/graph?q=test&limit=20',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 去重后节点：n1, n2
    const nodeIds = body.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain('n1');
    expect(nodeIds).toContain('n2');
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    // 重复边已去重（n1->n2 与 n2->n1 视为不同方向，但同向重复去掉）
    expect(body.edges.length).toBeGreaterThan(0);
  });

  it('空 q 返回 top 节点（无 edges）', async () => {
    mockRunReadQuery.mockResolvedValueOnce(
      makeResult([
        { id: 'top1', name: '热门1', type: 'TASK', pagerank: 3.0 },
        { id: 'top2', name: '热门2', type: 'ENTITY', pagerank: 2.0 },
      ]),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/graph?limit=10',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes[0].id).toBe('top1');
    expect(body.edges).toEqual([]);
  });

  it('graph 查询失败 → 降级返回空', async () => {
    mockRunReadQuery.mockRejectedValue(new Error('Neo4j 不可达'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/graph?q=test',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });
});
