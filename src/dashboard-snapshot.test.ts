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
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { startDashboardSnapshotServer, type SnapshotProviders, type SnapshotServerHandle } from './dashboard-snapshot.js';

// mock tools.js 的 getRegisteredToolHandler，避免引入完整插件依赖
vi.mock('./tools.js', () => ({
  getRegisteredToolHandler: vi.fn(),
  closeSharedDb: vi.fn(),
}));
import { getRegisteredToolHandler } from './tools.js';
const mockGetHandler = vi.mocked(getRegisteredToolHandler);

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

    it('未启动（端口被 foreign 进程占用）时 stop 仍安全', async () => {
      const port = getRandomPort();
      // 用 foreign http server 占住端口（非自身实例，不响应 /internal/health）
      const { createServer } = await import('node:http');
      const occupier = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('foreign occupier');
      });
      await new Promise<void>((resolve) => occupier.listen(port, '127.0.0.1', resolve));
      stoppers.push(async () => { await new Promise<void>((r) => occupier.close(() => r())); });

      // 再启动一个相同端口的实例 → 应启动失败（foreign 占用）
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
    it('provider 抛错时 snapshot 返回 200 + fallback 值（不因单个 provider 异常导致整体 500）', async () => {
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
      // 修复后：单个 provider 抛错不导致整体 500，而是返回 200 + fallback
      expect(resp.status).toBe(200);
      const body = await resp.json();
      // cascade 应返回 fallback 值
      expect(body.cascade.armsCount).toBe(0);
      expect(body.cascade.topArms).toEqual([]);
      expect(body.cascade.confidenceThreshold).toBe(0.7);
      // 其他字段应正常返回
      expect(body.userProfile).toBeDefined();
      expect(body.timestamp).toBeGreaterThan(0);
    });
  });

  describe('端口冲突处理', () => {
    it('端口被自身残留实例占用 → 识别为 self-stale 并通过 shutdown 恢复启动', async () => {
      const port = getRandomPort();
      // 起一个"残留实例"占住端口
      const stale = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      // 注意：不把 stale.stop 加入 stoppers —— 它会被新实例的 shutdownStaleInstance 关闭
      expect(await waitForStartup(stale)).toBe(true);

      // 再启动一个，应识别为 self-stale 并通过 POST /internal/shutdown 恢复
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);

      const started = await waitForStartup(handle);
      // v1.0.1-3: 恢复流程现在工作（shutdown 端点已移到方法守卫之前）
      expect(started).toBe(true);
      expect(handle.failureReason).toBeUndefined();
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

  // N-4: Prometheus /metrics + G-5 /internal/graph-health 端点覆盖
  describe('GET /metrics (Prometheus)', () => {
    it('返回 200 + text/plain + 包含 R-2 cascade_tier1_confidence 指标', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders({
          getHealthLatest: () => ({
            pendingMessages: 5,
            summaryFragments: 2,
            maxTokenRatio: 0.3,
            cbLcmAvailable: true,
            cbQmdAvailable: false,
            cbNeo4jAvailable: true,
            cbLcmFailures: 0,
            cbQmdFailures: 3,
            cbNeo4jFailures: 0,
            lastAssembleMs: 100,
            lastL2Ms: 50,
            lastL3Ms: 30,
            lastL4Ms: 20,
            pendingExperienceCount: 4,
            distilledExperienceCount: 10,
            tierLow: 8,
            tierMedium: 2,
            tierHigh: 0,
            // R-2 字段
            cascadeTier1Confidence: 0.85,
            cascadeJudgeSource: 'gm-pro',
          }),
        }),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(resp.status).toBe(200);
      const ct = resp.headers.get('content-type') ?? '';
      expect(ct).toContain('text/plain');
      const body = await resp.text();
      // 压力信号
      expect(body).toContain('lcm_pressure_pending_messages 5');
      expect(body).toContain('lcm_pressure_summary_fragments 2');
      expect(body).toContain('lcm_pressure_max_token_ratio 0.3');
      // 熔断器
      expect(body).toContain('lcm_circuit_breaker_available{engine="qmd"} 0');
      expect(body).toContain('lcm_circuit_breaker_failures{engine="qmd"} 3');
      // R-2: cascade Tier 1 置信度（含 source label）
      expect(body).toContain('lcm_cascade_tier1_confidence{source="gm-pro"} 0.85');
      // Graph adapter
      expect(body).toContain('lcm_graph_adapter_connected 1');
    });

    it('health 为 null 时不抛错，输出零值指标', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders({
          getHealthLatest: () => null,
        }),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(resp.status).toBe(200);
      const body = await resp.text();
      // 零值兜底
      expect(body).toContain('lcm_pressure_pending_messages 0');
      expect(body).toContain('lcm_cascade_tier1_confidence{source="local"} 0');
    });
  });

  describe('GET /internal/graph-health (G-5)', () => {
    it('返回 200 + application/json + 含 status/source 字段（降级到 local）', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders({
          getGraphAdapterState: () => ({ connected: true, connectFailed: false }),
        }),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/graph-health`);
      expect(resp.status).toBe(200);
      const ct = resp.headers.get('content-type') ?? '';
      expect(ct).toContain('application/json');
      const body = await resp.json();
      // gm-pro 不可用时降级到 local 推断
      expect(body.source).toBe('local');
      expect(body.status).toBe('healthy');
      expect(body.graphAdapterConnected).toBe(true);
    });

    it('graphAdapter 未连接时 status=unhealthy', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders({
          getGraphAdapterState: () => ({ connected: false, connectFailed: true }),
        }),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/graph-health`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.status).toBe('unhealthy');
      expect(body.source).toBe('local');
    });
  });

  describe('POST /internal/mcp-invoke', () => {
    beforeEach(() => {
      mockGetHandler.mockReset();
    });

    it('缺失 tool → 200 + ok:false + missing tool', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/mcp-invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('missing tool');
    });

    it('非白名单工具 → ok:false + not allowed', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/mcp-invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'dangerous_tool', params: {} }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('not allowed');
    });

    it('工具未注册 → ok:false + not registered', async () => {
      mockGetHandler.mockReturnValue(undefined);
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/mcp-invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'lcmg_distill', params: { limit: 50 } }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('not registered');
    });

    it('成功调用工具 handler → ok:true + result', async () => {
      const fakeResult = {
        content: [{ type: 'text', text: 'distilled 5 experiences' }],
        details: { ok: true, metrics: { limit: 50, triggered: 5 } },
      };
      mockGetHandler.mockReturnValue(async () => fakeResult);
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/mcp-invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'lcmg_distill', params: { limit: 50 } }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(true);
      expect(body.result).toEqual(fakeResult);
      // handler 应被调用，参数含 toolCallId + params
      expect(mockGetHandler).toHaveBeenCalledWith('lcmg_distill');
    });

    it('handler 抛异常 → ok:false + error message', async () => {
      mockGetHandler.mockReturnValue(async () => {
        throw new Error('distillation failed: LLM unavailable');
      });
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/mcp-invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'lcmg_distill', params: {} }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('distillation failed');
    });

    it('非法 JSON body → ok:false + invalid JSON', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/mcp-invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json{',
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('invalid JSON');
    });

    it('GET 方法 → 405', async () => {
      const port = getRandomPort();
      const handle = startDashboardSnapshotServer({
        port,
        host: '127.0.0.1',
        providers: makeProviders(),
      });
      stoppers.push(handle.stop);
      expect(await waitForStartup(handle)).toBe(true);

      const resp = await fetch(`http://127.0.0.1:${port}/internal/mcp-invoke`);
      expect(resp.status).toBe(405);
    });
  });
});
