/**
 * Harnessing P2b: Probe —— 同一探针集上对比基线与候选的行为差异。
 *
 * 无标准答案（verifier-free，Answer Freedom）：不判"对错"，只对比
 * "基线权重表 vs 候选权重表"在同一组 fixture 上的命中行为差异。
 *
 * 当前支持组件：tool-guidance（权重负载可直接仿真）。
 * 其他组件的候选修改无行为负载 → 标记 inconclusive（无行为证据不采纳，
 * 与 Harness² 的证据纪律一致）。
 *
 * 纯函数：权重查找表通过 WeightLookup 注入，生产环境接
 * sad-feedback.getEffectiveWeight(tool, sessionKey)，测试可注入任意表。
 */

import { categorizeTool } from '../plugin/tool-guidance.js';
import { DEFAULT_WEIGHT, MIN_WEIGHT } from '../plugin/sad-feedback.js';
import type { HarnessEdit, ProbeFixture, ProbeOutcome, ProbeRun, ToolGuidanceWeightHint } from './types.js';

/** 工具权重查找表（0..1） */
export type WeightLookup = (tool: string) => number;

export type { ProbeFixture };

/** 命中阈值：期望工具的有效权重 ≥ MIN_WEIGHT（对齐 sad-feedback 的可推荐线） */
export { MIN_WEIGHT as PROBE_HIT_THRESHOLD };

/** 采纳阈值：归一化命中率提升 ≥ 0.1（至少 1/10 fixture 的行为改善） */
export const ADOPT_CONTRAST = 0.1;
/** 拒绝阈值：归一化命中率下降 ≤ 0.1 */
export const REJECT_CONTRAST = -0.1;

const clamp01 = (w: number): number => Math.max(0, Math.min(1, w));

/** 在探针集上评估权重表：每 fixture 的期望工具平均权重 ≥ 阈值即命中 */
export function evaluateFixtures(fixtures: readonly ProbeFixture[], lookup: WeightLookup): ProbeRun {
  if (!fixtures || fixtures.length === 0) {
    return { score: 0, fixtures: 0, hits: 0 };
  }
  let hits = 0;
  for (const f of fixtures) {
    if (!f.expectedTools?.length) continue;
    const avg = f.expectedTools.reduce((s, t) => s + lookup(t), 0) / f.expectedTools.length;
    if (avg >= MIN_WEIGHT) hits++;
  }
  return { score: hits / fixtures.length, fixtures: fixtures.length, hits };
}

/** 在基线权重表上叠加候选权重建议，构造候选权重表 */
export function applyWeightHints(
  base: WeightLookup,
  hints: readonly ToolGuidanceWeightHint[] | undefined,
): WeightLookup {
  if (!hints || hints.length === 0) return base;
  return (tool: string): number => {
    let w = base(tool);
    for (const h of hints) {
      if (h.tool && h.tool === tool) w += h.delta;
      else if (h.category && categorizeTool(tool).includes(h.category)) w += h.delta;
    }
    return clamp01(w);
  };
}

/**
 * 对候选修改逐一探针（基线只算一次，复用）。
 * 无 payload 的修改 → 直接 inconclusive（contrast=0，基线=候选）。
 */
export function probeEdits(
  edits: readonly HarnessEdit[],
  fixtures: readonly ProbeFixture[],
  opts: { baseLookup: WeightLookup },
): ProbeOutcome[] {
  const baseline = evaluateFixtures(fixtures, opts.baseLookup);
  const outcomes: ProbeOutcome[] = [];
  for (const edit of edits) {
    if (!edit.payload?.weightHints?.length) {
      outcomes.push({
        editId: edit.id,
        baseline,
        candidate: baseline,
        contrast: 0,
        verdict: 'inconclusive',
      });
      continue;
    }
    const candidate = evaluateFixtures(fixtures, applyWeightHints(opts.baseLookup, edit.payload.weightHints));
    const contrast = candidate.score - baseline.score;
    const verdict: ProbeOutcome['verdict'] =
      contrast >= ADOPT_CONTRAST ? 'adopt'
      : contrast <= REJECT_CONTRAST ? 'reject'
      : 'inconclusive';
    outcomes.push({ editId: edit.id, baseline, candidate, contrast, verdict });
  }
  return outcomes;
}

/** 中性基线（所有工具 0.5）：无真实会话权重数据时的缺省查找表 */
export function neutralWeightLookup(): WeightLookup {
  return () => DEFAULT_WEIGHT;
}
