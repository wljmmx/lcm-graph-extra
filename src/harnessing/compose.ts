/**
 * Harnessing P2c: Compose —— 汇总探针证据，裁决候选修改。
 *
 * 裁决纪律（对齐 Harness²）：
 *   - adopt        有正向行为对比证据 → 采纳，并沉淀为带证据链的经验（驾驭级递归）
 *   - reject       有负向行为证据 → 拒绝
 *   - inconclusive 无行为证据/差异不显著 → 不采纳（默认保守）
 */

import type { ComposeResult, HarnessEdit, HarnessingLessonDraft, ProbeOutcome } from './types.js';
import { getHarnessComponent } from './components.js';

/** 按探针结论把候选修改分拣为 采纳/拒绝/存疑 三组 */
export function composeProbes(edits: readonly HarnessEdit[], outcomes: readonly ProbeOutcome[]): ComposeResult {
  const byEdit = new Map(edits.map((e) => [e.id, e]));
  const adopted: HarnessEdit[] = [];
  const rejected: HarnessEdit[] = [];
  const inconclusive: HarnessEdit[] = [];
  for (const o of outcomes) {
    const edit = byEdit.get(o.editId);
    if (!edit) continue;
    if (o.verdict === 'adopt') adopted.push(edit);
    else if (o.verdict === 'reject') rejected.push(edit);
    else inconclusive.push(edit);
  }
  return { adopted, rejected, inconclusive, outcomes: [...outcomes] };
}

/**
 * 把采纳的修改转为经验草稿（含 Harness² 式证据链 + 作用域）。
 * 身份字段（id/rawIds/createdAt/matchCount）由调用方（总线）补齐后写入经验库。
 */
export function lessonsFromAdopted(
  adopted: readonly HarnessEdit[],
  outcomes: readonly ProbeOutcome[],
  meta: { stepId: string; now?: Date },
): HarnessingLessonDraft[] {
  const outcomeByEdit = new Map(outcomes.map((o) => [o.editId, o]));
  const adoptedAt = (meta.now ?? new Date()).toISOString();
  const drafts: HarnessingLessonDraft[] = [];

  for (const edit of adopted) {
    const o = outcomeByEdit.get(edit.id);
    if (!o) continue;
    const compMeta = getHarnessComponent(edit.component);
    const basisSources = [...new Set(edit.basis.map((s) => s.source).filter(Boolean))] as string[];

    drafts.push({
      type: 'lesson',
      title: edit.title,
      summary: `${edit.detail}（探针证据：命中率 ${(o.baseline.score * 100).toFixed(0)}% → ${(o.candidate.score * 100).toFixed(0)}%，对比 ${(o.contrast * 100).toFixed(0)}%）`,
      detail: [
        `修改动机：${edit.rationale}`,
        `支撑失败信号：${edit.basis.map((s) => `[${s.kind}] ${s.text}`).join('；')}`,
        `探针对比：基线 ${o.baseline.hits}/${o.baseline.fixtures} → 候选 ${o.candidate.hits}/${o.candidate.fixtures}`,
        compMeta ? `组件：${compMeta.label}（${compMeta.engineSurface}）` : `组件：${edit.component}`,
      ].join('\n'),
      context: compMeta ? `harnessing/${edit.component}` : `harnessing/${edit.component}`,
      relevanceScore: 0.65,
      tags: {
        freeTags: ['harnessing', edit.component, edit.scope],
      },
      relatedConcepts: ['harnessing', edit.component],
      scope: edit.scope,
      evidence: {
        probeId: meta.stepId,
        baseline: o.baseline.score,
        candidate: o.candidate.score,
        contrast: o.contrast,
        trajectoryRef: basisSources[0],
        adoptedAt,
      },
    });
  }
  return drafts;
}
