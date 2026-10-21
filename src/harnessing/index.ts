/**
 * Harnessing 总线：runHarnessingStep —— 串联 Propose → Probe → Compose → 经验沉淀。
 *
 * 这是"第一个落地闭环"的公共入口（库形态）：
 *   失败信号（diagnose/SAD/人工）
 *     → normalizeSignals（P6 四分类）
 *     → 预算门控（P5）
 *     → proposeEdits（P2a，规则版 Editor）
 *     → probeEdits（P2b，探针对比，基线权重表可接 sad-feedback）
 *     → composeProbes（P2c，证据裁决）
 *     → 采纳项写入经验库（P1 evidence + scope，防过拟合分层）
 *
 * 运行时约束：
 *   - 只被显式调用（后续可挂 lcmg 工具 / cron），绝不进 turn 热路径；
 *   - LCMG_HARNESSING=off 或无探针集 → 如实返回 skipped，不做任何写入；
 *   - 经验写入失败不抛错（软失败，结果中如实报告 lessonsWritten）。
 *
 * @module harnessing
 */

import type {
  ComposeResult,
  FailureSignal,
  HarnessEdit,
  HarnessingLessonDraft,
  ProbeOutcome,
} from './types.js';
import { normalizeSignals } from './failure-taxonomy.js';
import { proposeEdits } from './propose.js';
import { probeEdits, neutralWeightLookup, type ProbeFixture, type WeightLookup } from './probe.js';
import { composeProbes, lessonsFromAdopted } from './compose.js';
import {
  checkProbeBudget,
  resolveProbeBudget,
  isHarnessingEnabled,
  applyEditBudget,
  type ProbeBudget,
} from './budget.js';

/** 经验库最小接口（ExperienceStorage.saveDistilled 满足） */
export interface LessonSink {
  saveDistilled(d: HarnessingLessonDraft & {
    id: string;
    rawIds: string[];
    createdAt: Date;
    matchCount: number;
  }): Promise<void>;
}

export interface HarnessingStepInput {
  /** 失败信号（对象形式，可带 kind/source）或纯文本（自动分类） */
  signals?: ReadonlyArray<string | FailureSignal>;
  /** 探针集：查询 + 期望命中工具（无行为证据则整步跳过） */
  fixtures?: readonly ProbeFixture[];
  /** 基线权重查找表（生产接 getEffectiveWeight(tool, sessionKey)；缺省中性 0.5） */
  baseLookup?: WeightLookup;
  /** 已知工具名（用于把 tool-guidance 修改具体化为可 probe 的权重负载） */
  knownTools?: readonly string[];
  /** 经验库写入目标（缺省只演算不落盘 —— 观察模式） */
  expStore?: LessonSink | null;
  /** 步骤 ID（写入经验证据链 probeId；缺省按时间生成） */
  stepId?: string;
  /** 预算覆盖 */
  budget?: Partial<ProbeBudget>;
  log?: {
    debug?: (msg: string, meta?: any) => void;
    warn?: (msg: string, meta?: any) => void;
    info?: (msg: string, meta?: any) => void;
  };
}

export interface HarnessingStepResult {
  stepId: string;
  /** false = 被开关/预算门控跳过（见 skipped） */
  ran: boolean;
  /** 跳过原因：'harnessing-disabled' | 'no-fixtures' | 'no-signals' | 'no-proposals' */
  skipped?: string;
  signals: FailureSignal[];
  proposals: HarnessEdit[];
  outcomes: ProbeOutcome[];
  adopted: HarnessEdit[];
  rejected: HarnessEdit[];
  inconclusive: HarnessEdit[];
  /** 实际写入经验库的教训数 */
  lessonsWritten: number;
  compose?: ComposeResult;
}

/** 生成步骤 ID */
function defaultStepId(): string {
  return 'hstep_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

/**
 * 运行一个完整的 harnessing 步骤。
 * 永不抛错：所有异常降级为 ran=false / lessonsWritten=0 并记录 warn。
 */
export async function runHarnessingStep(input: HarnessingStepInput): Promise<HarnessingStepResult> {
  const stepId = input.stepId?.trim() || defaultStepId();
  const base: HarnessingStepResult = {
    stepId,
    ran: false,
    signals: [],
    proposals: [],
    outcomes: [],
    adopted: [],
    rejected: [],
    inconclusive: [],
    lessonsWritten: 0,
  };

  try {
    // 1. 开关门控（opt-out：LCMG_HARNESSING=off）
    if (!isHarnessingEnabled()) {
      return { ...base, skipped: 'harnessing-disabled' };
    }

    // 2. 信号归一化（P6 四分类）
    const signals = normalizeSignals(input.signals ?? []);
    base.signals = signals;
    if (signals.length === 0) {
      return { ...base, skipped: 'no-signals' };
    }

    // 3. 预算门控（P5）：无探针集 = 无行为证据 → 跳过
    const budget = resolveProbeBudget(input.budget);
    const check = checkProbeBudget(budget, { fixtures: input.fixtures ?? [] });
    if (!check.ok) {
      return { ...base, skipped: check.reason };
    }

    // 4. Propose（P2a，规则版 Editor）+ 预算截断
    const proposals = applyEditBudget(proposeEdits(signals, { knownTools: input.knownTools }), budget);
    base.proposals = proposals;
    if (proposals.length === 0) {
      return { ...base, skipped: 'no-proposals' };
    }

    // 5. Probe（P2b）：同一探针集对比基线/候选行为
    const fixtures = (input.fixtures ?? []).slice(0, budget.maxProbeFixtures);
    const outcomes = probeEdits(proposals, fixtures, {
      baseLookup: input.baseLookup ?? neutralWeightLookup(),
    });

    // 6. Compose（P2c）：证据裁决
    const composed = composeProbes(proposals, outcomes);

    // 7. 驾驭级递归：采纳项沉淀为带证据链的经验（P1 evidence + scope）
    let lessonsWritten = 0;
    if (input.expStore && composed.adopted.length > 0) {
      const drafts = lessonsFromAdopted(composed.adopted, outcomes, { stepId });
      for (const d of drafts) {
        try {
          await input.expStore.saveDistilled({
            ...d,
            id: `exp_hstep_${stepId}_${lessonsWritten + 1}`,
            rawIds: [],
            createdAt: new Date(),
            matchCount: 0,
          });
          lessonsWritten++;
        } catch (err) {
          input.log?.warn?.('harnessing: lesson write failed (soft-fail)', {
            stepId, title: d.title, err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      ...base,
      ran: true,
      outcomes,
      adopted: composed.adopted,
      rejected: composed.rejected,
      inconclusive: composed.inconclusive,
      lessonsWritten,
      compose: composed,
    };
  } catch (err) {
    input.log?.warn?.('harnessing: step failed (soft-fail)', {
      stepId, err: err instanceof Error ? err.message : String(err),
    });
    return base;
  }
}

// ---------------------------------------------------------------------------
// 子模块统一导出（库形态公共 API）
// ---------------------------------------------------------------------------
export {
  // 类型（P2）
  type HarnessComponentId,
  type HarnessScope,
  type FailureKind,
  type FailureSignal,
  type HarnessEdit,
  type ProbeOutcome,
  type ProbeRun,
  type ComposeResult,
  type HarnessingLessonDraft,
  type ToolGuidancePayload,
  type ToolGuidanceWeightHint,
} from './types.js';

// P3 组件分类法
export {
  HARNESS_COMPONENTS,
  getHarnessComponent,
  isHarnessComponentId,
  type HarnessComponentMeta,
} from './components.js';

// P6 失败分类法
export {
  classifyFailure,
  normalizeSignals,
  FAILURE_KIND_LABELS,
} from './failure-taxonomy.js';

// P2a/b/c 协议
export { proposeEdits, MAX_EDITS_PER_STEP, KIND_TO_COMPONENT } from './propose.js';
export {
  probeEdits,
  evaluateFixtures,
  applyWeightHints,
  neutralWeightLookup,
  ADOPT_CONTRAST,
  REJECT_CONTRAST,
  PROBE_HIT_THRESHOLD,
  type ProbeFixture,
  type WeightLookup,
} from './probe.js';
export { composeProbes, lessonsFromAdopted } from './compose.js';

// P5 预算与角色
export {
  DEFAULT_PROBE_BUDGET,
  isHarnessingEnabled,
  resolveProbeBudget,
  checkProbeBudget,
  applyEditBudget,
  type ProbeBudget,
  type BudgetCheck,
} from './budget.js';
export {
  EDITOR_ROLE_PROMPT,
  COMPOSER_ROLE_PROMPT,
  buildEditorPrompt,
  buildComposerPrompt,
} from './roles.js';
