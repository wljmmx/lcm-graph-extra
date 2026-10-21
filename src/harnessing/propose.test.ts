/**
 * Harnessing P2a/P3: Propose + 组件分类法单测。
 */
import { describe, it, expect } from 'vitest';
import { proposeEdits, KIND_TO_COMPONENT, MAX_EDITS_PER_STEP } from './propose.js';
import { HARNESS_COMPONENTS, getHarnessComponent, isHarnessComponentId } from './components.js';
import type { FailureSignal } from './types.js';

describe('HARNESS_COMPONENTS（P3：8 组件分类法）', () => {
  it('恰好 8 个组件、4 个分组，id 唯一', () => {
    expect(HARNESS_COMPONENTS).toHaveLength(8);
    const ids = HARNESS_COMPONENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(8);
    expect(new Set(HARNESS_COMPONENTS.map((c) => c.group)).size).toBe(4);
  });

  it('每个组件都映射到本引擎模块（engineSurface 非空）', () => {
    for (const c of HARNESS_COMPONENTS) {
      expect(c.engineSurface.length).toBeGreaterThan(0);
      expect(getHarnessComponent(c.id)).toBe(c);
    }
  });

  it('isHarnessComponentId 守卫', () => {
    expect(isHarnessComponentId('tool-guidance')).toBe(true);
    expect(isHarnessComponentId('nope')).toBe(false);
  });
});

describe('proposeEdits（P2a：规则版 Editor）', () => {
  it('四类失败 → 四个组件各一个候选，映射关系正确', () => {
    const signals: FailureSignal[] = [
      { kind: 'action-realization', text: '工具调用失败：参数错误' },
      { kind: 'environment-contract', text: '配置缺失' },
      { kind: 'trajectory-degeneration', text: '原地打转' },
      { kind: 'residual-reasoning', text: '推理错误' },
    ];
    const edits = proposeEdits(signals);
    expect(edits).toHaveLength(4);
    expect(edits.map((e) => e.component)).toEqual([
      KIND_TO_COMPONENT['action-realization'],
      KIND_TO_COMPONENT['environment-contract'],
      KIND_TO_COMPONENT['trajectory-degeneration'],
      KIND_TO_COMPONENT['residual-reasoning'],
    ]);
    expect(edits.map((e) => e.scope)).toEqual(['invariant', 'invariant', 'invariant', 'invariant']);
  });

  it('同类失败信号聚合到一个候选的 basis（证据完整）', () => {
    const edits = proposeEdits([
      { kind: 'environment-contract', text: '找不到模块 a' },
      { kind: 'environment-contract', text: '配置缺失 b', source: 'diagnose' },
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0].basis).toHaveLength(2);
    expect(edits[0].basis[1].source).toBe('diagnose');
  });

  it('tool-guidance：文本提到已知工具 → domain 作用域 + 可 probe 权重负载', () => {
    const edits = proposeEdits(
      [{ kind: 'action-realization', text: 'lcmg_search 调用失败，参数错误', source: 'sad-feedback' }],
      { knownTools: ['lcmg_search', 'lcmg_diagnose', 'lcmg_distill'] },
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].scope).toBe('domain');
    expect(edits[0].payload?.weightHints).toEqual([{ tool: 'lcmg_search', delta: 0.15 }]);
  });

  it('tool-guidance：未指名具体工具 → invariant、无负载（不可 probe）', () => {
    const edits = proposeEdits(
      [{ kind: 'action-realization', text: '某工具调用失败' }],
      { knownTools: ['lcmg_search'] },
    );
    expect(edits[0].scope).toBe('invariant');
    expect(edits[0].payload).toBeUndefined();
  });

  it('id 内容寻址：同输入同 id，天然幂等', () => {
    const input = [{ kind: 'environment-contract' as const, text: '配置缺失' }];
    const [a] = proposeEdits(input);
    const [b] = proposeEdits(input);
    expect(a.id).toBe(b.id);
  });

  it('候选数不超过 MAX_EDITS_PER_STEP', () => {
    const many: FailureSignal[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'environment-contract' as const,
      text: `失败 ${i}`,
    }));
    expect(proposeEdits(many).length).toBeLessThanOrEqual(MAX_EDITS_PER_STEP);
  });
});
