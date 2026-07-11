/**
 * 后端路由测试：health + agent。
 *
 * 用 vitest + fastify inject 测试，mock db.ts 与 snapshot.ts 模块，
 * 避免依赖真实 lcm.db / 插件 / OpenClaw host。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from '../../server/routes/health';
import { registerAgentRoutes } from '../../server/routes/agent';

// mock db 模块（避免加载 node:sqlite）
vi.mock('../../server/lib/db', () => ({
  queryHealthHistory: vi.fn(),
  queryHealthLatest: vi.fn(),
}));

// mock snapshot 模块（避免真实 HTTP 调用插件）
vi.mock('../../server/lib/snapshot', () => ({
  fetchPluginSnapshot: vi.fn(),
}));

import {
  queryHealthHistory,
  queryHealthLatest,
  type HealthMetricRow,
} from '../../server/lib/db';
import { fetchPluginSnapshot } from '../../server/lib/snapshot';

const mockQueryHealthHistory = vi.mocked(queryHealthHistory);
const mockQueryHealthLatest = vi.mocked(queryHealthLatest);
const mockFetchPluginSnapshot = vi.mocked(fetchPluginSnapshot);

/** 构造一条完整的 DB 行（覆盖所有字段，便于复用） */
function makeRow(overrides: Partial<HealthMetricRow> = {}): HealthMetricRow {
  return {
    ts: 2000,
    pending_msgs: 5,
    summary_frags: 2,
    token_ratio: 0.3,
    cb_lcm_ok: 1,
    cb_qmd_ok: 1,
    cb_neo4j_ok: 0,
    cb_lcm_fails: 0,
    cb_qmd_fails: 0,
    cb_neo4j_fails: 3,
    assemble_ms: 100,
    l2_ms: 10,
    l3_ms: 20,
    l4_ms: 30,
    pending_exp: 1,
    distilled_exp: 2,
    tier_low: 5,
    tier_med: 3,
    tier_high: 1,
    ...overrides,
  };
}

/** 构造一个挂载了 health + agent 路由的 Fastify 实例 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerHealthRoutes(app);
  await registerAgentRoutes(app);
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockQueryHealthHistory.mockReturnValue([]);
  mockQueryHealthLatest.mockReturnValue(null);
  mockFetchPluginSnapshot.mockResolvedValue(null);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

describe('GET /api/health/history', () => {
  it('返回 snapshots 数组（snake_case → camelCase + boolean 转换）', async () => {
    mockQueryHealthHistory.mockReturnValue([makeRow({ ts: 1000, pending_msgs: 5, cb_neo4j_ok: 0 })]);

    const res = await app.inject({ method: 'GET', url: '/api/health/history?n=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].timestamp).toBe(1000);
    expect(body.snapshots[0].pendingMessages).toBe(5);
    expect(body.snapshots[0].cbNeo4jAvailable).toBe(false);
    expect(body.snapshots[0].cbLcmAvailable).toBe(true);
    // n 透传给 db 查询
    expect(mockQueryHealthHistory).toHaveBeenCalledWith(10);
  });

  it('默认 n=144', async () => {
    await app.inject({ method: 'GET', url: '/api/health/history' });
    expect(mockQueryHealthHistory).toHaveBeenCalledWith(144);
  });

  it('n 超过上限 8640 时截断', async () => {
    await app.inject({ method: 'GET', url: '/api/health/history?n=99999' });
    expect(mockQueryHealthHistory).toHaveBeenCalledWith(8640);
  });

  it('db 无数据时返回空数组', async () => {
    mockQueryHealthHistory.mockReturnValue([]);
    const res = await app.inject({ method: 'GET', url: '/api/health/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshots).toEqual([]);
  });
});

describe('GET /api/health/latest', () => {
  it('db 有数据 + snapshot 成功 → 同时返回 db 与 memory', async () => {
    mockQueryHealthLatest.mockReturnValue(makeRow({ ts: 2000 }));
    mockFetchPluginSnapshot.mockResolvedValue({
      cascade: { armsCount: 3, topArms: [], confidenceThreshold: 0.5 },
      userProfile: {
        techStack: [],
        scenario: [],
        language: 'zh',
      },
      graphAdapter: { connected: true, connectFailed: false },
      debt: { running: 1, pendingCount: 2, pollIntervalMs: 1000, maxConcurrent: 4 },
      retrieval: { lastQuery: 'q', perfSummary: 'fast' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/health/latest' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.db).not.toBeNull();
    expect(body.db.timestamp).toBe(2000);
    expect(body.db.cbNeo4jFailures).toBe(3);
    expect(body.memory).not.toBeNull();
    expect(body.memory.cascade.armsCount).toBe(3);
  });

  it('db 有数据 + snapshot 失败 → memory 为 null（不阻塞 db）', async () => {
    mockQueryHealthLatest.mockReturnValue(makeRow({ ts: 2000 }));
    mockFetchPluginSnapshot.mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/api/health/latest' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.db).not.toBeNull();
    expect(body.db.timestamp).toBe(2000);
    expect(body.memory).toBeNull();
  });

  it('db 无数据 + snapshot 无数据 → db 与 memory 均为 null', async () => {
    mockQueryHealthLatest.mockReturnValue(null);
    mockFetchPluginSnapshot.mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/api/health/latest' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.db).toBeNull();
    expect(body.memory).toBeNull();
  });
});

describe('GET /api/agent/status', () => {
  it('host 不可达 → 返回 online: false + error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const res = await app.inject({ method: 'GET', url: '/api/agent/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(false);
    expect(body.error).toContain('不可达');
  });

  it('host 成功 → 透传响应 + online: true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: 2, uptime: 123 }),
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/agent/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(true);
    expect(body.sessions).toBe(2);
    expect(body.uptime).toBe(123);
  });

  it('host 返回非 2xx → online: false + error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/agent/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.online).toBe(false);
    expect(body.error).toContain('503');
  });
});
