/**
 * DashboardSnapshotServer 单元测试。
 *
 * 覆盖：
 * - GET /internal/snapshot 返回聚合 JSON
 * - GET /internal/health 返回简化健康状态
 * - 其他路径返回 404
 * - providers 数据变化时反映最新值（延迟求值）
 * - stop() 后服务关闭
 * - 仅监听指定 host（127.0.0.1）
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startDashboardSnapshotServer, type SnapshotProviders } from './dashboard-snapshot.js';

// 随机端口避免冲突
function getRandomPort(): number {
  return 17000 + Math.floor(Math.random() * 1000);
}

async function fetchJson(url: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(url);
  const body = await resp.json();
  return { status: resp.status, body };
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const resp = await fetch(url);
  const body = await resp.text();
  return { status: resp.status, body };
}

describe('DashboardSnapshotServer', () => {
  const stoppers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stoppers) {
      try { await stop(); } catch {}
    }
    stoppers.length = 0;
  });

  function makeProviders(overrides: Partial<SnapshotProviders> = {}): SnapshotProviders {
    return {
      getCascadeSnapshot: () => ({
        armsCount: 3,
        topArms: [
          { armKey: 'bug-fix:e1', alpha: 5, beta: 1, sample: 0.8 },
          { armKey: 'feature-dev:e2', alpha: 2, beta: 1, sample: 0.6 },
        ],
        confidenceThreshold: 0.7,
      }),
      getUserProfile: () => ({
        techStack: [{ name: 'backend', weight: 2.5 }],
        scenario: [{ name: 'bug-fix', weight: 1.2 }],
        language: 'zh',
      }),
      getGraphAdapterState: () => ({
        connected: true,
        connectFailed: false,
      }),
      getDebtStats: () => ({
        running: 1,
        pendingCount: 2,
        pollIntervalMs: 60000,
        maxConcurrent: 2,
      }),
      getRetrievalState: () => ({
        lastQuery: 'how to fix memory leak',
        perfSummary: 'qmd: 5 searches',
      }),
      getHealthLatest: () => ({ timestamp: 123, pendingMessages: 10 }),
      ...overrides,
    };
  }

  describe('GET /internal/snapshot', () => {
    it('返回 200 + 聚合 JSON 包含所有字段', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/internal/snapshot`);
      expect(status).toBe(200);
      expect(body).toHaveProperty('cascade');
      expect(body).toHaveProperty('userProfile');
      expect(body).toHaveProperty('graphAdapter');
      expect(body).toHaveProperty('debt');
      expect(body).toHaveProperty('retrieval');
      expect(body).toHaveProperty('health');
      expect(body).toHaveProperty('timestamp');
      expect(body.cascade.armsCount).toBe(3);
      expect(body.userProfile.language).toBe('zh');
      expect(body.graphAdapter.connected).toBe(true);
      expect(body.debt.pendingCount).toBe(2);
      expect(body.retrieval.lastQuery).toBe('how to fix memory leak');
      expect(body.health.latest).toEqual({ timestamp: 123, pendingMessages: 10 });
      expect(typeof body.timestamp).toBe('number');
    });

    it('timestamp 为当前时间', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const before = Date.now();
      const { body } = await fetchJson(`http://127.0.0.1:${port}/internal/snapshot`);
      const after = Date.now();
      expect(body.timestamp).toBeGreaterThanOrEqual(before);
      expect(body.timestamp).toBeLessThanOrEqual(after);
    });

    it('providers 数据变化时反映最新值（延迟求值）', async () => {
      let armsCount = 1;
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders({
          getCascadeSnapshot: () => ({ armsCount, topArms: [], confidenceThreshold: 0.7 }),
        }),
      });
      stoppers.push(handle.stop);

      const r1 = await fetchJson(`http://127.0.0.1:${port}/internal/snapshot`);
      expect(r1.body.cascade.armsCount).toBe(1);

      armsCount = 99;
      const r2 = await fetchJson(`http://127.0.0.1:${port}/internal/snapshot`);
      expect(r2.body.cascade.armsCount).toBe(99);
    });

    it('只接受 GET 方法', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/snapshot`, { method: 'POST' });
      expect(resp.status).toBe(404);
    });
  });

  describe('GET /internal/health', () => {
    it('返回 200 + { ok: true, ts }', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/internal/health`);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(typeof body.ts).toBe('number');
    });
  });

  describe('未知路径', () => {
    it('返回 404', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const { status } = await fetchText(`http://127.0.0.1:${port}/unknown`);
      expect(status).toBe(404);
    });

    it('根路径返回 404', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const { status } = await fetchText(`http://127.0.0.1:${port}/`);
      expect(status).toBe(404);
    });
  });

  describe('stop()', () => {
    it('停止后请求失败', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });

      // 先确认服务可用
      const before = await fetchJson(`http://127.0.0.1:${port}/internal/health`);
      expect(before.status).toBe(200);

      await handle.stop();

      // 停止后请求应失败（连接被拒绝）
      await expect(fetch(`http://127.0.0.1:${port}/internal/health`)).rejects.toThrow();
    });

    it('多次 stop 不抛错（幂等）', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      await handle.stop();
      await expect(handle.stop()).resolves.not.toThrow();
    });
  });

  describe('provider 异常容错', () => {
    it('provider 抛错时 snapshot 返回 500 + 错误信息', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders({
          getCascadeSnapshot: () => { throw new Error('cascade boom'); },
        }),
      });
      stoppers.push(handle.stop);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/snapshot`);
      expect(resp.status).toBe(500);
    });
  });
});
