/**
 * Harnessing P1: 存储层 scope/evidence 持久化单测。
 * 覆盖：saveDistilled 写入 scope/evidence 属性；读回路径（rowToDistilled）解析与安全降级。
 */
import { describe, it, expect, vi } from 'vitest';
import { ExperienceStorage } from './storage.js';
import type { DistilledExperience } from './types.js';

function mockAdapter() {
  return { query: vi.fn() };
}

const baseExp: DistilledExperience = {
  id: 'exp-h-1',
  rawIds: ['raw-1'],
  type: 'lesson',
  title: '工具引导教训',
  summary: '提升 lcmg_search 推荐权重',
  detail: 'd',
  context: 'c',
  relevanceScore: 0.65,
  createdAt: new Date(),
  matchCount: 0,
};

describe('ExperienceStorage scope/evidence（Harnessing P1）', () => {
  it('saveDistilled 写入 scope 与 evidence（JSON 序列化）', async () => {
    const adapter = mockAdapter();
    adapter.query.mockResolvedValueOnce([]);
    const store = new ExperienceStorage(adapter as any);

    await store.saveDistilled({
      ...baseExp,
      scope: 'domain',
      evidence: { probeId: 'hstep_x', baseline: 0.5, candidate: 0.8, contrast: 0.3, trajectoryRef: 'lcmg_search', adoptedAt: '2026-10-21T00:00:00.000Z' },
    });

    const [cypher, params] = adapter.query.mock.calls[0];
    expect(String(cypher)).toContain('MERGE');
    expect(params.props.scope).toBe('domain');
    const evidence = JSON.parse(params.props.evidence);
    expect(evidence.probeId).toBe('hstep_x');
    expect(evidence.contrast).toBe(0.3);
  });

  it('不设 scope/evidence 时 props 不含这两个键（存量路径零变化）', async () => {
    const adapter = mockAdapter();
    adapter.query.mockResolvedValueOnce([]);
    const store = new ExperienceStorage(adapter as any);
    await store.saveDistilled({ ...baseExp });
    const params = adapter.query.mock.calls[0][1];
    expect('scope' in params.props).toBe(false);
    expect('evidence' in params.props).toBe(false);
  });

  it("读回：scope='domain' 还原，evidence JSON 解析", async () => {
    const adapter = mockAdapter();
    adapter.query.mockResolvedValueOnce([{
      id: 'exp-h-1',
      title: 't', summary: 's', detail: 'd', context: 'c',
      relevanceScore: 0.7, createdAt: 1700000000000, matchCount: 1,
      rawIds: 'raw-1', type: 'lesson',
      scope: 'domain',
      evidence: JSON.stringify({ probeId: 'p1', contrast: 0.2 }),
    }]);
    const store = new ExperienceStorage(adapter as any);
    const res = await store.searchRelevant(0.5, 5);
    expect(res[0].experience.scope).toBe('domain');
    expect(res[0].experience.evidence?.probeId).toBe('p1');
    expect(res[0].experience.evidence?.contrast).toBe(0.2);
  });

  it('读回：无 scope 的存量行 → invariant；evidence 损坏 JSON → 安全降级 undefined', async () => {
    const adapter = mockAdapter();
    adapter.query.mockResolvedValueOnce([{
      id: 'legacy', title: 't', summary: 's', detail: 'd', context: 'c',
      relevanceScore: 0.8, createdAt: 1700000000000, matchCount: 0,
      evidence: '{broken json',
    }]);
    const store = new ExperienceStorage(adapter as any);
    const res = await store.searchRelevant(0.5, 5);
    expect(res[0].experience.scope).toBe('invariant');
    expect(res[0].experience.evidence).toBeUndefined();
  });

  it('RETURN 子句包含 scope/evidence 列（全文索引路径）', async () => {
    const adapter = mockAdapter();
    adapter.query.mockResolvedValueOnce([]);
    const store = new ExperienceStorage(adapter as any);
    await store.searchByQuery({ query: '测试', limit: 3 }).catch(() => []);
    const cypher = String(adapter.query.mock.calls[0]?.[0] ?? '');
    expect(cypher).toContain('e.scope AS scope');
    expect(cypher).toContain('e.evidence AS evidence');
  });
});
