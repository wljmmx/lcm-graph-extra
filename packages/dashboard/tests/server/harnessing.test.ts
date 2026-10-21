/**
 * Harnessing 路由测试：/api/harnessing/summary。
 *
 * - mock snapshot lib（插件实时态）
 * - mock neo4j lib（runReadQuery 返回构造 records）
 * - fastify inject，不触真实插件 / Neo4j
 *
 * 核心契约：live 与 history 任一失败互不影响（独立降级）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../server/lib/snapshot', () => ({
  fetchPluginSnapshot: vi.fn(),
}));

vi.mock('../../server/lib/neo4j', () => ({
  runReadQuery: vi.fn(),
  toNumber: (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    const i = v as { toNumber?: () => number };
    if (typeof i.toNumber === 'function') return i.toNumber();
    return null;
  },
}));

import { fetchPluginSnapshot } from '../../server/lib/snapshot';
import { runReadQuery } from '../../server/lib/neo4j';
import { registerHarnessingRoutes } from '../../server/routes/harnessing';

const mockFetch = vi.mocked(fetchPluginSnapshot);
const mockRunReadQuery = vi.mocked(runReadQuery);

function makeRecord(row: Record<string, unknown>) {
  return { toObject: () => row };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify({ logger: false });
  await registerHarnessingRoutes(app);
});

describe('GET /api/harnessing/summary', () => {
  it('live + history 双路正常：evidence 解析、组件提取、统计聚合', async () => {
    mockFetch.mockResolvedValueOnce({
      harnessing: {
        enabled: true,
        autoEnabled: true,
        signals: { count: 2, totalOccurrences: 5, byKind: { 'action-realization': 2 }, bySource: { lcmg_search: 2 } },
        lastAutoStep: { ts: Date.now(), ran: true, signalCount: 2, adopted: 1, lessonsWritten: 0 },
      },
    } as any);
    mockRunReadQuery.mockResolvedValueOnce({
      records: [
        makeRecord({
          id: 'exp-1', title: '提升 lcmg_search 权重', summary: 's1',
          scope: 'domain', tagsFree: 'harnessing,tool-guidance,domain',
          evidence: JSON.stringify({ probeId: 'auto_x', baseline: 0.5, candidate: 0.75, contrast: 0.25 }),
          createdAt: 1700000000000,
        }),
        makeRecord({
          id: 'exp-2', title: '补充契约护栏', summary: 's2',
          scope: 'invariant', tagsFree: 'harnessing,guardrails,invariant',
          evidence: JSON.stringify({ probeId: 'auto_y', contrast: 0.15 }),
          createdAt: { toNumber: () => 1700000100000 },
        }),
      ],
    } as any);

    const res = await app.inject({ method: 'GET', url: '/api/harnessing/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live.enabled).toBe(true);
    expect(body.live.signals.count).toBe(2);
    expect(body.stats.total).toBe(2);
    expect(body.stats.byScope).toEqual({ domain: 1, invariant: 1 });
    expect(body.stats.byComponent).toEqual({ 'tool-guidance': 1, guardrails: 1 });
    expect(body.history[0].component).toBe('tool-guidance');
    expect(body.history[0].evidence.contrast).toBe(0.25);
    expect(body.history[1].createdAt).toBe(1700000100000); // neo4j Integer 走 toNumber
    expect(body.historyError).toBeUndefined();
    expect(body.liveError).toBeUndefined();
  });

  it('live 失败 → liveError 标注，history 不受影响', async () => {
    mockFetch.mockRejectedValueOnce(new Error('plugin snapshot unreachable'));
    mockRunReadQuery.mockResolvedValueOnce({
      records: [makeRecord({
        id: 'exp-1', title: 't', summary: 's', scope: 'invariant',
        tagsFree: 'harnessing,memory,invariant',
        evidence: JSON.stringify({ probeId: 'p' }), createdAt: 1700000000000,
      })],
    } as any);

    const res = await app.inject({ method: 'GET', url: '/api/harnessing/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live).toBeNull();
    expect(body.liveError).toContain('unreachable');
    expect(body.stats.total).toBe(1);
  });

  it('history 失败 → historyError 标注，live 正常透传', async () => {
    mockFetch.mockResolvedValueOnce({ harnessing: { enabled: true, autoEnabled: false, signals: { count: 0, totalOccurrences: 0, byKind: {}, bySource: {} }, lastAutoStep: null } } as any);
    mockRunReadQuery.mockRejectedValueOnce(new Error('Neo4j down'));

    const res = await app.inject({ method: 'GET', url: '/api/harnessing/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live.enabled).toBe(true);
    expect(body.history).toEqual([]);
    expect(body.historyError).toContain('Neo4j down');
  });

  it('evidence 损坏 JSON → 安全降级为空对象，不抛错', async () => {
    mockFetch.mockResolvedValueOnce(null as any);
    mockRunReadQuery.mockResolvedValueOnce({
      records: [makeRecord({
        id: 'exp-bad', title: 't', summary: 's', scope: 'domain',
        tagsFree: 'harnessing,skills,domain',
        evidence: '{broken', createdAt: 1700000000000,
      })],
    } as any);

    const res = await app.inject({ method: 'GET', url: '/api/harnessing/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.history[0].evidence).toEqual({});
    expect(body.history[0].component).toBe('skills');
  });
});
