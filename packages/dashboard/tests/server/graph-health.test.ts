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

// stub fetch（graph-health 路由内部调用 fetch 转发到 :7423）
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockGetOutboundAuthHeader = vi.mocked(getOutboundAuthHeader);

let app: FastifyInstance;

function makeResp(opts: { ok: boolean; status: number; body?: unknown }) {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => opts.body ?? {},
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
});
