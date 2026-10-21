/**
 * Harnessing P5: 探测预算与开关门控。
 *
 * 成本纪律（对齐本仓 P0–P4 风格）：
 *   - harnessing 步骤只被显式调用（工具/cron），绝不进入 turn 热路径；
 *   - 无探针集 = 无行为证据 → 直接跳过（证据纪律，而非降级为"凭感觉采纳"）；
 *   - fixture 数与候选修改数有硬上限（probe 成本 = fixture 数 × 候选数）；
 *   - 开关 opt-out：LCMG_HARNESSING=off 关闭（默认启用，但仅显式调用时运行）。
 */

import type { ProbeFixture, HarnessEdit } from './types.js';

export interface ProbeBudget {
  enabled: boolean;
  /** 单步最大候选修改数 */
  maxEdits: number;
  /** 单步最大探针 fixture 数 */
  maxProbeFixtures: number;
}

export const DEFAULT_PROBE_BUDGET: ProbeBudget = {
  enabled: true,
  maxEdits: 4,
  maxProbeFixtures: 20,
};

/** 开关：默认启用，仅显式 LCMG_HARNESSING=off 关闭（大小写/空白容忍） */
export function isHarnessingEnabled(): boolean {
  return (process.env.LCMG_HARNESSING ?? '').trim().toLowerCase() !== 'off';
}

/** 合并预算配置并夹紧到安全范围 */
export function resolveProbeBudget(opts?: Partial<ProbeBudget>): ProbeBudget {
  const enabled = opts?.enabled ?? DEFAULT_PROBE_BUDGET.enabled;
  const maxEdits = clampInt(opts?.maxEdits ?? DEFAULT_PROBE_BUDGET.maxEdits, 1, 8);
  const maxProbeFixtures = clampInt(opts?.maxProbeFixtures ?? DEFAULT_PROBE_BUDGET.maxProbeFixtures, 1, 100);
  return { enabled, maxEdits, maxProbeFixtures };
}

export interface BudgetCheck {
  ok: boolean;
  /** 不放行的原因：'disabled' | 'no-fixtures' */
  reason?: 'disabled' | 'no-fixtures';
}

/** 门控检查：disabled 或 fixture 为空时不运行 probe */
export function checkProbeBudget(
  budget: ProbeBudget,
  input: { fixtures: readonly ProbeFixture[] },
): BudgetCheck {
  if (!budget.enabled || !isHarnessingEnabled()) return { ok: false, reason: 'disabled' };
  if (!input.fixtures || input.fixtures.length === 0) return { ok: false, reason: 'no-fixtures' };
  return { ok: true };
}

/** 按 maxEdits 截断候选修改（截断如实反映在返回值长度上，调用方无需再查） */
export function applyEditBudget(edits: readonly HarnessEdit[], budget: ProbeBudget): HarnessEdit[] {
  return edits.slice(0, budget.maxEdits);
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
