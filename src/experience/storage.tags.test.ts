/**
 * Phase 1（T-Mem 借鉴）: searchByTags 关联通道单测。
 *
 * 覆盖：
 *   - 查询词查 experience_tags_search 索引，返回与 searchByQuery 同构的结果
 *   - 空查询 / 空结果 / 失败（索引缺失）均安全降级为 []
 *   - 传入参数正确（queryKeyword / minScore / limit / halfLifeDays）
 */
import { describe, it, expect, vi } from 'vitest';
import { ExperienceStorage } from './storage.js';

function mockAdapter() {
  const query = vi.fn();
  return { query };
}

describe('ExperienceStorage.searchByTags（Phase 1 tag 关联通道）', () => {
  it('调用 experience_tags_search 并返回同构结果', async () => {
    const adapter = mockAdapter();
    adapter.query.mockResolvedValueOnce([
      {
        id: 'exp-1',
        title: '压缩冷却',
        summary: '非紧急压缩需纳入冷却',
        detail: 'detail',
        context: 'ctx',
        relevanceScore: 0.8,
        createdAt: 1700000000000,
        matchCount: 2,
        rawIds: 'raw-1',
        type: 'lesson',
        tags_scenario: 'performance',
        tags_techStack: 'cooldown',
        tags_severity: 'minor',
        tags_free: 'forced-compaction',
        queryMatch: 1.2, // ftScore * 0.6
      },
    ]);

    const store = new ExperienceStorage(adapter as any);
    const res = await store.searchByTags('cooldown', { limit: 3, minScore: 0.3 });

    // 必须命中独立 tag 索引（隔离，I2）
    expect(adapter.query.mock.calls[0][0]).toContain("'experience_tags_search'");
    // 参数正确
    const params = adapter.query.mock.calls[0][1];
    expect(params.queryKeyword).toBe('cooldown');
    expect(params.minScore).toBe(0.3);
    expect(params.limit).toBe(3);
    // 返回同构（experience + score）
    expect(res).toHaveLength(1);
    expect(res[0].experience.id).toBe('exp-1');
    expect(typeof res[0].score).toBe('number');
  });

  it('空查询直接返回 []，不发请求', async () => {
    const adapter = mockAdapter();
    const store = new ExperienceStorage(adapter as any);
    expect(await store.searchByTags('   ')).toEqual([]);
    expect(adapter.query).not.toHaveBeenCalled();
  });

  it('索引缺失/查询失败 → 返回 [] 而非抛错（不干扰主路径）', async () => {
    const adapter = mockAdapter();
    adapter.query.mockRejectedValueOnce(new Error('no such fulltext schema index: experience_tags_search'));
    const store = new ExperienceStorage(adapter as any);
    expect(await store.searchByTags('deployment')).toEqual([]);
  });

  it('空结果 → []', async () => {
    const adapter = mockAdapter();
    adapter.query.mockResolvedValueOnce([]);
    const store = new ExperienceStorage(adapter as any);
    expect(await store.searchByTags('nonsense-tag-xyz')).toEqual([]);
  });
});
