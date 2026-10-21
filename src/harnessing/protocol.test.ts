/**
 * Harnessing P2c + P5: Compose / Budget / Roles 单测。
 */
import { describe, it, expect } from 'vitest';
import { composeProbes, lessonsFromAdopted } from './compose.js';
import {
  DEFAULT_PROBE_BUDGET,
  isHarnessingEnabled,
  resolveProbeBudget,
  checkProbeBudget,
  applyEditBudget,
} from './budget.js';
import { EDITOR_ROLE_PROMPT, COMPOSER_ROLE_PROMPT, buildEditorPrompt, buildComposerPrompt } from './roles.js';
import type { HarnessEdit, ProbeOutcome } from './types.js';

const ORIG = process.env.LCMG_HARNESSING;

function edit(id: string): HarnessEdit {
  return { id, component: 'tool-guidance', scope: 'invariant', title: id, detail: 'd', rationale: 'r', basis: [{ kind: 'action-realization', text: 'x', source: 'sad-feedback' }] };
}

function outcome(editId: string, verdict: ProbeOutcome['verdict'], contrast = 0.2): ProbeOutcome {
  return { editId, baseline: { score: 0.5, fixtures: 4, hits: 2 }, candidate: { score: 0.5 + contrast, fixtures: 4, hits: 2 + contrast * 4 }, contrast, verdict };
}

describe('composeProbes（P2c：证据裁决分拣）', () => {
  it('按 verdict 分拣三组', () => {
    const edits = [edit('a'), edit('b'), edit('c')];
    const outcomes = [outcome('a', 'adopt'), outcome('b', 'reject', -0.2), outcome('c', 'inconclusive', 0.01)];
    const r = composeProbes(edits, outcomes);
    expect(r.adopted.map((e) => e.id)).toEqual(['a']);
    expect(r.rejected.map((e) => e.id)).toEqual(['b']);
    expect(r.inconclusive.map((e) => e.id)).toEqual(['c']);
  });

  it('未知 editId 的 outcome 被忽略（不崩）', () => {
    const r = composeProbes([edit('a')], [outcome('ghost', 'adopt')]);
    expect(r.adopted).toHaveLength(0);
  });
});

describe('lessonsFromAdopted（驾驭级递归：带证据链的经验草稿）', () => {
  it('草稿含 scope + evidence（probeId/对比分/轨迹引用）', () => {
    const edits = [edit('a')];
    const outcomes = [outcome('a', 'adopt', 0.25)];
    const [draft] = lessonsFromAdopted(edits, outcomes, { stepId: 'hstep_t1' });
    expect(draft.type).toBe('lesson');
    expect(draft.scope).toBe('invariant');
    expect(draft.evidence.probeId).toBe('hstep_t1');
    expect(draft.evidence.baseline).toBe(0.5);
    expect(draft.evidence.contrast).toBe(0.25);
    expect(draft.evidence.trajectoryRef).toBe('sad-feedback');
    expect(draft.evidence.adoptedAt).toBeTruthy();
    expect(draft.tags?.freeTags).toContain('harnessing');
  });
});

describe('budget（P5：预算与开关）', () => {
  it('LCMG_HARNESSING=off 关闭（opt-out，默认启用）', () => {
    delete process.env.LCMG_HARNESSING;
    expect(isHarnessingEnabled()).toBe(true);
    process.env.LCMG_HARNESSING = 'off';
    expect(isHarnessingEnabled()).toBe(false);
    process.env.LCMG_HARNESSING = '  OFF ';
    expect(isHarnessingEnabled()).toBe(false);
    process.env.LCMG_HARNESSING = 'on';
    expect(isHarnessingEnabled()).toBe(true);
    process.env.LCMG_HARNESSING = ORIG;
  });

  it('resolveProbeBudget 夹紧范围', () => {
    expect(resolveProbeBudget({ maxEdits: 99 }).maxEdits).toBe(8);
    expect(resolveProbeBudget({ maxProbeFixtures: 0 }).maxProbeFixtures).toBe(1);
    expect(resolveProbeBudget()).toEqual(DEFAULT_PROBE_BUDGET);
  });

  it('checkProbeBudget：disabled / no-fixtures 拦截', () => {
    const fixtures = [{ query: 'q', expectedTools: ['t'] }];
    expect(checkProbeBudget({ ...DEFAULT_PROBE_BUDGET, enabled: false }, { fixtures })).toEqual({ ok: false, reason: 'disabled' });
    expect(checkProbeBudget(DEFAULT_PROBE_BUDGET, { fixtures: [] })).toEqual({ ok: false, reason: 'no-fixtures' });
    process.env.LCMG_HARNESSING = 'off';
    expect(checkProbeBudget(DEFAULT_PROBE_BUDGET, { fixtures })).toEqual({ ok: false, reason: 'disabled' });
    delete process.env.LCMG_HARNESSING;
    expect(checkProbeBudget(DEFAULT_PROBE_BUDGET, { fixtures })).toEqual({ ok: true });
  });

  it('applyEditBudget 截断候选', () => {
    const edits = [edit('1'), edit('2'), edit('3')];
    expect(applyEditBudget(edits, { ...DEFAULT_PROBE_BUDGET, maxEdits: 2 })).toHaveLength(2);
  });
});

describe('roles（P5：Editor/Composer prompt 构建器）', () => {
  it('Editor prompt 含组件清单与失败信号', () => {
    const p = buildEditorPrompt({ signals: [{ kind: 'action-realization', text: '工具失败', source: 's1' }] });
    expect(p).toContain('Harness Editor');
    expect(p).toContain('tool-guidance');
    expect(p).toContain('[action-realization] 工具失败');
  });

  it('Composer prompt 含候选与探针证据 + 证据纪律', () => {
    const p = buildComposerPrompt({
      edits: [edit('e1')],
      outcomes: [outcome('e1', 'adopt', 0.25)],
    });
    expect(p).toContain('Harness Composer');
    expect(p).toContain('e1');
    expect(p).toContain('基线 50% → 候选 75%');
  });
});
