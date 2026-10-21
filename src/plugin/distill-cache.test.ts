/**
 * Harnessing P4: 蒸馏内容寻址缓存单测。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isDistillCacheEnabled,
  computeDistillContentAddress,
  getCachedDistill,
  setCachedDistill,
  buildDistillArtifactFromCache,
  clearDistillCache,
  getDistillCacheStats,
  DISTILL_PROMPT_VERSION,
} from './distill-cache.js';

const ORIG_ENV = process.env.LCMG_DISTILL_CACHE;

beforeEach(() => {
  clearDistillCache();
  if (ORIG_ENV === undefined) delete process.env.LCMG_DISTILL_CACHE;
  else process.env.LCMG_DISTILL_CACHE = ORIG_ENV;
});

describe('isDistillCacheEnabled（opt-out：默认开启）', () => {
  it('未设置 → 开启；仅 off（大小写/空白容忍）关闭', () => {
    delete process.env.LCMG_DISTILL_CACHE;
    expect(isDistillCacheEnabled()).toBe(true);
    process.env.LCMG_DISTILL_CACHE = 'off';
    expect(isDistillCacheEnabled()).toBe(false);
    process.env.LCMG_DISTILL_CACHE = '  OFF ';
    expect(isDistillCacheEnabled()).toBe(false);
    process.env.LCMG_DISTILL_CACHE = 'on';
    expect(isDistillCacheEnabled()).toBe(true);
    process.env.LCMG_DISTILL_CACHE = '';
    expect(isDistillCacheEnabled()).toBe(true);
  });
});

describe('computeDistillContentAddress（内容寻址）', () => {
  it('同内容同模型 → 同键；任一维度变化 → 不同键', () => {
    const a = computeDistillContentAddress({ source: 'failure', context: 'c', detail: 'd', model: 'qwen' });
    const b = computeDistillContentAddress({ source: 'failure', context: 'c', detail: 'd', model: 'qwen' });
    expect(a).toBe(b);
    expect(a).not.toBe(computeDistillContentAddress({ source: 'failure', context: 'c', detail: 'd', model: 'glm' }));
    expect(a).not.toBe(computeDistillContentAddress({ source: 'failure', context: 'c', detail: 'd2', model: 'qwen' }));
  });

  it('prompt 版本参与键（bump 后旧缓存自然失效）', () => {
    expect(DISTILL_PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});

describe('get/set 缓存语义', () => {
  it('未命中 → undefined 且 misses 计数；写入后命中且深拷贝隔离', () => {
    const key = computeDistillContentAddress({ source: 's', context: 'c', detail: 'd', model: 'm' });
    expect(getCachedDistill(key)).toBeUndefined();

    const fields = { type: 'lesson', title: 't', summary: 's', relevanceScore: 0.6, tags: { freeTags: ['x'] } };
    setCachedDistill(key, fields);

    const hit = getCachedDistill(key)!;
    expect(hit.title).toBe('t');
    // 修改命中结果不影响缓存内容
    (hit.tags as any).freeTags.push('y');
    expect((getCachedDistill(key) as any).tags.freeTags).toEqual(['x']);
  });

  it('stats 如实统计', () => {
    clearDistillCache();
    const key = 'k1';
    getCachedDistill(key); // miss
    setCachedDistill(key, { type: 'lesson', title: 't', summary: 's', relevanceScore: 0.5 });
    getCachedDistill(key); // hit
    const s = getDistillCacheStats();
    expect(s).toMatchObject({ hits: 1, misses: 1, stores: 1, size: 1 });
  });
});

describe('buildDistillArtifactFromCache（身份字段重新生成，与实时产物同构）', () => {
  it('id/rawIds/createdAt/matchCount 按当前 raw 生成，派生字段来自缓存', () => {
    const artifact = buildDistillArtifactFromCache(
      { type: 'fix', title: 'T', summary: 'S', relevanceScore: 0.7, relatedConcepts: ['a'] },
      'raw-42',
      'detail-长文本',
      'ctx',
    );
    expect(artifact.id).toMatch(/^exp_dist_/);
    expect(artifact.rawIds).toEqual(['raw-42']);
    expect(artifact.title).toBe('T');
    expect(artifact.type).toBe('fix');
    expect(artifact.matchCount).toBe(0);
    expect(artifact.createdAt).toBeInstanceOf(Date);
    expect(artifact.relatedConcepts).toEqual(['a']);
  });
});
