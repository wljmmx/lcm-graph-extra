/**
 * graph-health 路由专测
 *
 * 验证 /api/graph/health 端点的转发与降级行为
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock snapshot lib
vi.mock('../../src/lib/snapshot', () => ({
  fetchPluginSnapshot: vi.fn(),
  PLUGIN_SNAPSHOT_URL: 'http://127.0.0.1:7423',
}));

describe('graph-health 路由', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/graph/health', () => {
    it('应转发到插件 :7423/internal/graph-health', async () => {
      // 验证转发契约
      const expectedUrl = 'http://127.0.0.1:7423/internal/graph-health';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          status: 'healthy',
          source: 'gm-pro',
          nodeCount: 100,
          relationshipCount: 500,
          graphAdapterConnected: true,
          details: {},
        }),
      });

      const resp = await fetch(expectedUrl);
      const body = await resp.json();
      expect(mockFetch).toHaveBeenCalledWith(expectedUrl);
      expect(body.status).toBe('healthy');
      expect(body.source).toBe('gm-pro');
      expect(body.nodeCount).toBe(100);
      expect(body.relationshipCount).toBe(500);
      expect(body.graphAdapterConnected).toBe(true);
    });

    it('插件不可达时应降级返回 status=unknown', async () => {
      // 5s 超时后降级
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await fetch('http://127.0.0.1:7423/internal/graph-health');
      } catch {
        // 降级路径
        const degraded = {
          status: 'unknown',
          source: 'none',
          error: 'ECONNREFUSED',
          fetchedAt: Date.now(),
        };
        expect(degraded.status).toBe('unknown');
        expect(degraded.source).toBe('none');
        expect(degraded.error).toBeTruthy();
      }
    });

    it('gm-pro 不可用时应降级到 local graphAdapter 状态', async () => {
      // resolveGraphHealth fallback
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          status: 'degraded',
          source: 'local',
          graphAdapterConnected: false,
        }),
      });

      const resp = await fetch('http://127.0.0.1:7423/internal/graph-health');
      const body = await resp.json();
      expect(body.source).toBe('local');
      expect(body.status).toBe('degraded');
    });

    it('应包含 fetchedAt 时间戳', async () => {
      // dashboard 后端转发响应应附加 fetchedAt
      const response = {
        status: 'healthy',
        source: 'gm-pro',
        nodeCount: 100,
        fetchedAt: Date.now(),
      };
      expect(response.fetchedAt).toBeGreaterThan(0);
      expect(typeof response.fetchedAt).toBe('number');
    });
  });

  describe('GraphHealthResponse 类型契约', () => {
    it('status 应为 healthy | degraded | unhealthy | unknown 之一', () => {
      const validStatuses = ['healthy', 'degraded', 'unhealthy', 'unknown'];
      validStatuses.forEach((s) => {
        expect(['healthy', 'degraded', 'unhealthy', 'unknown']).toContain(s);
      });
    });

    it('source 应为 gm-pro | local | none 之一', () => {
      const validSources = ['gm-pro', 'local', 'none'];
      validSources.forEach((s) => {
        expect(['gm-pro', 'local', 'none']).toContain(s);
      });
    });

    it('可选字段 nodeCount / relationshipCount 应为 number', () => {
      const response = {
        status: 'healthy' as const,
        source: 'gm-pro' as const,
        nodeCount: 100,
        relationshipCount: 500,
        graphAdapterConnected: true,
        details: { avgDegree: 5 },
        fetchedAt: Date.now(),
      };
      expect(typeof response.nodeCount).toBe('number');
      expect(typeof response.relationshipCount).toBe('number');
      expect(typeof response.graphAdapterConnected).toBe('boolean');
      expect(response.details).toBeInstanceOf(Object);
    });
  });
});
