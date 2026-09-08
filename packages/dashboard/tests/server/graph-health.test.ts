/**
 * graph-health 路由专测
 *
 * E3 修复: 原 mock 路径错误（../../src/lib/snapshot 应为 ../../server/lib/snapshot），
 * 且未用 app.inject 真正测试路由，整文件空跑。重写为使用 fastify inject + mock auth。
 *
 * 验证 /api/graph/health 端点的转发与降级行为
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// mock auth（graph-health 现在通过 getOutboundAuthHeader 注入出站 auth 头）
vi.mock('../../server/lib/auth', () => ({
  getOutboundAuthHeader: vi.fn(() => ({})),
  isAuthEnabled: vi.fn(() => false),
  requireAuth: vi.fn((_req, _reply, done) => done()),
  requireAuthForPath: vi.fn(() => false),
}));

import { registerGraphHealthRoutes } from '../../server/routes/graph-health';
import { getOutboundAuthHeader } from '../../server/lib/auth';
import { runReadQuery } from '../../server/lib/neo4j';

// mock neo4j lib（health-score 路由直读 Neo4j GraphHealthMetric 快照）
vi.mock('../../server/lib/neo4j', () => ({
  runReadQuery: vi.fn(),
  toNumber: (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    const i = v as { toNumber?: () => number; low?: number; high?: number };
    if (typeof i.toNumber === 'function') return i.toNumber();
    if (typeof i.low === 'number') return i.low;
    return null;
  },
  runWriteQuery: vi.fn(),
  getNeo4jSession: vi.fn(),
  getNeo4jDriver: vi.fn(),
  closeNeo4jDriver: vi.fn(),
  closeNeo4j: vi.fn(),
}));

const mockRunReadQuery = vi.mocked(runReadQuery);

/** 模拟 neo4j-driver 的 Node 对象：属性在 .properties 下（直接 .score 为 undefined） */
function makeNode(properties: Record<string, unknown>) {
  return { properties, identity: { toString: () => '0' }, labels: ['GraphHealthMetric'] };
}

/** 模拟 QueryResult：record.get('m') 返回 Node */
function makeNodeResult(records: Array<{ get: (k: string) => unknown }>) {
  return { records };
}

// stub fetch（graph-health 路由内部调用 fetch 转发到 :7423）
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockGetOutboundAuthHeader = vi.mocked(getOutboundAuthHeader);

let app: FastifyInstance;

function makeResp(opts: {
  ok: boolean;
  status: number;
  body?: unknown;
  contentType?: string;
  textBody?: string;
}) {
  const contentType = opts.contentType ?? 'application/json';
  return {
    ok: opts.ok,
    status: opts.status,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-type') return contentType;
        return null;
      },
    },
    json: async () => opts.body ?? {},
    text: async () => opts.textBody ?? JSON.stringify(opts.body ?? {}),
  };
}

describe('graph-health 路由', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetOutboundAuthHeader.mockReturnValue({});
    app = Fastify({ logger: false });
    await app.register(registerGraphHealthRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/graph/health', () => {
    it('应转发到插件 :7423/internal/graph-health 并附加 fetchedAt', async () => {
      mockFetch.mockResolvedValueOnce(makeResp({
        ok: true,
        status: 200,
        body: {
          status: 'healthy',
          source: 'gm-pro',
          nodeCount: 100,
          relationshipCount: 500,
          graphAdapterConnected: true,
          details: {},
        },
      }));

      const resp = await app.inject({ method: 'GET', url: '/api/graph/health' });
      expect(resp.statusCode).toBe(200);
      const body = resp.json();
      expect(body.status).toBe('healthy');
      expect(body.source).toBe('gm-pro');
      expect(body.nodeCount).toBe(100);
      expect(body.relationshipCount).toBe(500);
      expect(body.graphAdapterConnected).toBe(true);
      expect(body.fetchedAt).toBeGreaterThan(0);

      // 验证 fetch 转发到了正确端点
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:7423/internal/graph-health');
      expect(opts.method).toBeUndefined(); // GET 不需要 method
      expect(opts.headers).toEqual({}); // getOutboundAuthHeader 默认返回 {}
    });

    it('插件不可达时应降级返回 status=unknown', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const resp = await app.inject({ method: 'GET', url: '/api/graph/health' });
      const body = resp.json();
      expect(body.status).toBe('unknown');
      expect(body.source).toBe('none');
      expect(body.error).toBeTruthy();
      expect(body.fetchedAt).toBeGreaterThan(0);
    });

    it('插件返回非 200 时应降级返回 status=unknown', async () => {
      mockFetch.mockResolvedValueOnce(makeResp({
        ok: false,
        status: 404,
        body: {},
      }));

      const resp = await app.inject({ method: 'GET', url: '/api/graph/health' });
      const body = resp.json();
      expect(body.status).toBe('unknown');
      expect(body.source).toBe('none');
      expect(body.error).toContain('404');
    });

    it('插件返回 HTML（如 SPA 兜底/端口被占）时应降级返回 status=unknown', async () => {
      // 真实场景：PLUGIN_SNAPSHOT_URL 指错指向了 dev server，或 :7423 被别的 web 服务占用
      mockFetch.mockResolvedValueOnce(makeResp({
        ok: true,
        status: 200,
        contentType: 'text/html; charset=utf-8',
        textBody: '<!DOCTYPE html><html><head><title>App</title></head><body>...</body></html>',
      }));

      const resp = await app.inject({ method: 'GET', url: '/api/graph/health' });
      const body = resp.json();
      expect(body.status).toBe('unknown');
      expect(body.source).toBe('none');
      // 错误信息应暴露 Content-Type 和 PLUGIN_SNAPSHOT_URL 提示
      expect(body.error).toContain('text/html');
      expect(body.error).toContain('PLUGIN_SNAPSHOT_URL');
      expect(body.fetchedAt).toBeGreaterThan(0);
    });

    it('启用 auth 时出站 fetch 应携带 Authorization 头', async () => {
      mockGetOutboundAuthHeader.mockReturnValue({ Authorization: 'Basic dXNlcjpwYXNz' });
      mockFetch.mockResolvedValueOnce(makeResp({
        ok: true,
        status: 200,
        body: { status: 'healthy', source: 'gm-pro' },
      }));

      await app.inject({ method: 'GET', url: '/api/graph/health' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers).toEqual({ Authorization: 'Basic dXNlcjpwYXNz' });
    });
  });

  describe('GET /api/graph/health-score', () => {
    it('应从 GraphHealthMetric Node 的 .properties 读取评分（修复全 0 问题）', async () => {
      mockRunReadQuery.mockResolvedValueOnce(makeNodeResult([
        {
          get: (k: string) => (k === 'm' ? makeNode({
            timestamp: 1720000000000,
            score: 87,
            connectivity: 0.9,
            density: 0.6,
            influence: 0.8,
            freshness: 0.5,
            conflictFree: 1,
            activeNodes: 120,
            totalEdges: 300,
            isolatedNodes: 5,
            isolatedRatio: 0.04,
            avgDegree: 2.5,
            avgPageRank: 0.012,
            highStaleRatio: 0.1,
            transitionalRatio: 0,
            sparse: false,
          }) : undefined),
        },
      ]));

      const resp = await app.inject({ method: 'GET', url: '/api/graph/health-score' });
      expect(resp.statusCode).toBe(200);
      const body = resp.json();
      expect(body.available).toBe(true);
      expect(body.score).toBe(87);
      expect(body.dims?.connectivity).toBe(0.9);
      expect(body.metrics?.activeNodes).toBe(120);
      expect(body.metrics?.isolatedRatio).toBe(0.04);
      expect(body.sparse).toBe(false);
      expect(body.timestamp).toBe(1720000000000);
    });

    it('无 GraphHealthMetric 快照时返回 available=false', async () => {
      mockRunReadQuery.mockResolvedValueOnce({ records: [] });
      const resp = await app.inject({ method: 'GET', url: '/api/graph/health-score' });
      const body = resp.json();
      expect(body.available).toBe(false);
      expect(body.error).toContain('尚无 GraphHealthMetric');
    });

    it('Neo4j 查询失败时降级返回 available=false 与错误信息', async () => {
      mockRunReadQuery.mockRejectedValueOnce(new Error('connection refused'));
      const resp = await app.inject({ method: 'GET', url: '/api/graph/health-score' });
      const body = resp.json();
      expect(body.available).toBe(false);
      expect(body.error).toContain('Neo4j 查询失败');
    });
  });
});
