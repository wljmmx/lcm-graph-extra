/**
 * Harnessing P1: 经验作用域分层单测。
 * 核心兼容性契约：存量数据（无 scope）→ invariant → 行为完全不变。
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveScope,
  scopeMatchesContext,
  applyScopeLayering,
  DEFAULT_EXPERIENCE_SCOPE,
} from './scope.js';
import type { DistilledExperience } from './types.js';

function exp(partial: Partial<DistilledExperience>): DistilledExperience {
  return {
    id: 'exp-1',
    rawIds: [],
    type: 'lesson',
    title: 't',
    summary: 's',
    detail: 'd',
    context: 'c',
    relevanceScore: 0.7,
    createdAt: new Date(),
    matchCount: 0,
    ...partial,
  };
}

describe('effectiveScope（缺省 invariant，向后兼容）', () => {
  it('undefined / 其他值 → invariant', () => {
    expect(effectiveScope(undefined)).toBe('invariant');
    expect(effectiveScope(exp({}))).toBe('invariant');
    expect(effectiveScope(exp({ scope: undefined }))).toBe('invariant');
    expect(DEFAULT_EXPERIENCE_SCOPE).toBe('invariant');
  });

  it('显式 domain → domain', () => {
    expect(effectiveScope(exp({ scope: 'domain' }))).toBe('domain');
  });
});

describe('scopeMatchesContext（domain 需场景标签命中）', () => {
  const domainExp = exp({
    scope: 'domain',
    tags: { scenario: ['bug-fix'], freeTags: ['react'] },
  });

  it('invariant 恒注入', () => {
    expect(scopeMatchesContext(exp({}))).toBe(true);
    expect(scopeMatchesContext(exp({}), { scenarioTags: [] })).toBe(true);
  });

  it('domain + 场景命中（scenario/freeTags 均可，大小写不敏感）', () => {
    expect(scopeMatchesContext(domainExp, { scenarioTags: ['Bug-Fix'] })).toBe(true);
    expect(scopeMatchesContext(domainExp, { scenarioTags: ['react'] })).toBe(true);
  });

  it('domain + 场景不命中 → 不注入（防跨域泄漏）', () => {
    expect(scopeMatchesContext(domainExp, { scenarioTags: ['deployment'] })).toBe(false);
  });

  it('domain + 无场景信号 → 不注入（保守）', () => {
    expect(scopeMatchesContext(domainExp, { scenarioTags: [] })).toBe(false);
    expect(scopeMatchesContext(domainExp, {})).toBe(false);
  });
});

describe('applyScopeLayering（批量分层 + 计数）', () => {
  it('混合结果：invariant 全保留，domain 未命中被剔除并计数', () => {
    const results = [
      { experience: exp({ id: 'a' }) },                                        // invariant（缺省）
      { experience: exp({ id: 'b', scope: 'domain', tags: { scenario: ['bug-fix'] } }) },
      { experience: exp({ id: 'c', scope: 'domain', tags: { scenario: ['deployment'] } }) },
      { experience: undefined as any },                                        // 空经验原样保留
    ];
    const { kept, droppedDomain } = applyScopeLayering(results, { scenarioTags: ['bug-fix'] });
    expect(kept.map((r) => r.experience?.id ?? undefined)).toEqual(['a', 'b', undefined]);
    expect(droppedDomain).toBe(1);
  });

  it('null/undefined 输入安全', () => {
    expect(applyScopeLayering(null as any, {}).kept).toEqual([]);
    expect(applyScopeLayering(undefined as any, {}).droppedDomain).toBe(0);
  });
});
