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
 * - 端口被占时启动失败 + started=false（不抛错）
 * - 端口被自身残留实例占用时识别为 self-stale
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startDashboardSnapshotServer, type SnapshotProviders, type SnapshotServerHandle } from './dashboard-snapshot.js';

// 随机端口避免冲突
function getRandomPort(): number {
  return 17000 + Math.floor(Math.random() * 1000);
}

/**
 * 等待 handle.started 变为 true 或 false（启动完成）。
 * 由于 startDashboardSnapshotServer 内部异步执行探测+listen，
 * 调用方需要 await 这个状态才能保证后续 fetch 命中。
 */
async function waitForStartup(handle: SnapshotServerHandle, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (handle.started === true) return true;
    if (handle.failureReason) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return handle.started;
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
      expect(await waitForStartup(handle)).toBe(true);

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
      expect(await waitForStartup(handle)).toBe(true);

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
      expect(await waitForStartup(handle)).toBe(true);

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
      expect(await waitForStartup(handle)).toBe(true);

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
      expect(await waitForStartup(handle)).toBe(true);

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
      expect(await waitForStartup(handle)).toBe(true);

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
      expect(await waitForStartup(handle)).toBe(true);

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
      expect(await waitForStartup(handle)).toBe(true);
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
      expect(await waitForStartup(handle)).toBe(true);
      await handle.stop();
      await expect(handle.stop()).resolves.not.toThrow();
    });

    it('未启动（端口被占）时 stop 仍安全', async () => {
      const port = getRandomPort();
      // 先占住端口
      const occupier = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(occupier.stop);
      expect(await waitForStartup(occupier)).toBe(true);

      // 再启动一个相同端口的实例 → 应启动失败
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      const started = await waitForStartup(handle);
      expect(started).toBe(false);
      expect(handle.failureReason).toBeTruthy();

      // 即使未启动，stop 也应安全无错
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
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/snapshot`);
      expect(resp.status).toBe(500);
    });
  });

  describe('端口冲突处理', () => {
    it('端口被自身残留实例占用 → 识别为 self-stale 并放弃启动', async () => {
      const port = getRandomPort();
      // 起一个"残留实例"占住端口
      const stale = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(stale.stop);
      expect(await waitForStartup(stale)).toBe(true);

      // 再启动一个，应识别为 self-stale
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const started = await waitForStartup(handle);
      expect(started).toBe(false);
      // failureReason 应包含 self-stale 提示
      expect(handle.failureReason).toMatch(/stale previous instance/);
    });

    it('端口被非自身进程占用（响应非 health）→ 识别为 foreign 并放弃启动', async () => {
      const port = getRandomPort();
      // 用 node:http 起一个"外来"服务器，响应非 health 内容
      const { createServer } = await import('node:http');
      const foreignServer = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('I am not openclaw');
      });
      await new Promise<void>((resolve) => foreignServer.listen(port, '127.0.0.1', resolve));
      // 测试结束关闭 foreignServer
      stoppers.push(async () => { await new Promise<void>((r) => foreignServer.close(() => r())); });

      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const started = await waitForStartup(handle);
      expect(started).toBe(false);
      expect(handle.failureReason).toMatch(/occupied by unknown process/);
    });

    it('端口空闲时正常启动', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);
      expect(handle.failureReason).toBeUndefined();
    });
  });
});
