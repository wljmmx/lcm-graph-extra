/**
 * Harnessing P2b: Probe 单测（verifier-free 行为对比）。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateFixtures,
  applyWeightHints,
  probeEdits,
  neutralWeightLookup,
  ADOPT_CONTRAST,
  REJECT_CONTRAST,
} from './probe.js';
import type { HarnessEdit, ToolGuidanceWeightHint } from './types.js';

const FIXTURES = [
  { query: '搜索记忆', expectedTools: ['lcmg_search'] },
  { query: '蒸馏经验', expectedTools: ['lcmg_distill'] },
  { query: '诊断状态', expectedTools: ['lcmg_diagnose'] },
  { query: '备份恢复', expectedTools: ['lcmg_backup'] },
];

describe('evaluateFixtures（命中率 = 命中 fixture / 总数）', () => {
  it('空探针集 → score 0', () => {
    expect(evaluateFixtures([], () => 1)).toEqual({ score: 0, fixtures: 0, hits: 0 });
  });

  it('权重 ≥ MIN_WEIGHT(0.2) 记为命中', () => {
    // 全部 0.5 → 全命中
    expect(evaluateFixtures(FIXTURES, () => 0.5)).toEqual({ score: 1, fixtures: 4, hits: 4 });
    // 全部 0.1 → 全不命中
    expect(evaluateFixtures(FIXTURES, () => 0.1).hits).toBe(0);
    // 一半命中
    const lookup = (t: string) => (['lcmg_search', 'lcmg_distill'].includes(t) ? 0.5 : 0.1);
    expect(evaluateFixtures(FIXTURES, lookup)).toEqual({ score: 0.5, fixtures: 4, hits: 2 });
  });
});

describe('applyWeightHints（候选权重表构造）', () => {
  it('按工具名叠加 delta 并 clamp 到 [0,1]', () => {
    const base = () => 0.5;
    const hints: ToolGuidanceWeightHint[] = [{ tool: 'lcmg_search', delta: 0.15 }, { tool: 'lcmg_backup', delta: -0.6 }];
    const lookup = applyWeightHints(base, hints);
    expect(lookup('lcmg_search')).toBeCloseTo(0.65);
    expect(lookup('lcmg_backup')).toBeCloseTo(0); // clamp 下限
    expect(lookup('lcmg_distill')).toBeCloseTo(0.5); // 未提及不受影响
  });

  it('空 hints 返回原查找表（引用相等）', () => {
    const base = () => 0.5;
    expect(applyWeightHints(base, [])).toBe(base);
    expect(applyWeightHints(base, undefined)).toBe(base);
  });
});

describe('probeEdits（对比裁决）', () => {
  const baseLookup = (t: string) => (t === 'lcmg_search' ? 0.15 : 0.5); // search 低于命中线

  function editWith(hints?: ToolGuidanceWeightHint[]): HarnessEdit {
    return {
      id: 'e1',
      component: 'tool-guidance',
      scope: 'domain',
      title: 't',
      detail: 'd',
      rationale: 'r',
      basis: [],
      payload: hints ? { weightHints: hints } : undefined,
    };
  }

  it('候选把低权重工具拉过命中线 → contrast=+0.25 → adopt', () => {
    // 基线：search 0.15 不命中 → 3/4；候选：search 0.30 命中 → 4/4
    const outcomes = probeEdits([editWith([{ tool: 'lcmg_search', delta: 0.15 }])], FIXTURES, { baseLookup });
    expect(outcomes[0].baseline.hits).toBe(3);
    expect(outcomes[0].candidate.hits).toBe(4);
    expect(outcomes[0].contrast).toBeCloseTo(0.25);
    expect(outcomes[0].verdict).toBe('adopt');
  });

  it('候选把命中工具拉下线 → 负向对比 → reject', () => {
    const outcomes = probeEdits([editWith([{ tool: 'lcmg_distill', delta: -0.5 }])], FIXTURES, { baseLookup });
    // 基线 3/4 → 候选 2/4（distill 0.0 不命中）
    expect(outcomes[0].baseline.hits).toBe(3);
    expect(outcomes[0].candidate.hits).toBe(2);
    expect(outcomes[0].verdict).toBe('reject');
    expect(outcomes[0].contrast).toBeLessThanOrEqual(REJECT_CONTRAST);
  });

  it('无行为负载的修改 → inconclusive（无证据不采纳）', () => {
    const outcomes = probeEdits([editWith()], FIXTURES, { baseLookup });
    expect(outcomes[0].verdict).toBe('inconclusive');
    expect(outcomes[0].contrast).toBe(0);
    expect(outcomes[0].baseline).toEqual(outcomes[0].candidate);
  });

  it('差异低于采纳阈值 → inconclusive', () => {
    // 单 fixture 提升不足 0.1
    const small = [FIXTURES[0], { query: 'x', expectedTools: ['lcmg_distill'] }];
    const outcomes = probeEdits(
      [editWith([{ tool: 'lcmg_distill', delta: 0.0 }])], // delta 0 → 无变化
      small,
      { baseLookup: () => 0.5 },
    );
    expect(outcomes[0].contrast).toBe(0);
    expect(outcomes[0].verdict).toBe('inconclusive');
  });

  it('阈值常量符合 Harness² 证据纪律', () => {
    expect(ADOPT_CONTRAST).toBe(0.1);
    expect(REJECT_CONTRAST).toBe(-0.1);
  });

  it('neutralWeightLookup：全 0.5', () => {
    expect(neutralWeightLookup()('anything')).toBe(0.5);
  });
});
