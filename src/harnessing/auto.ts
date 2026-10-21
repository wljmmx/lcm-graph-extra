/**
 * Harnessing 自动观察步 —— 默认开启的低频介入回路（observe-only）。
 *
 * 回答"工具要 LLM 主动用，有没有默认介入"的问题：
 *   - 信号侧默认介入：audit wrapper 把每次工具失败自动记入 signal-collector（零配置）；
 *   - 演算侧默认介入：heartbeat 每 ~6h drain 信号，跑一次 Propose–Probe–Compose 观察步；
 *   - 写盘侧**不**默认介入：v1 硬约束 expStore 恒 null，自动路径零写盘，
 *     产出仅日志 + 诊断快照；写入必须显式走 lcmg_harness_step mode=apply
 *     （与 P4 转录改写"先观察后强执"同一纪律）。
 *
 * 开关：
 *   LCMG_HARNESSING=off        总开关（连 observe 也停）
 *   LCMG_HARNESSING_AUTO=off   仅关自动观察步（手动工具不受影响）
 *
 * 基线：getWorstEffectiveWeight（跨会话最差 SAD 权重）——
 * 反复失败的工具在部分会话已被压到命中线以下，这是有观测依据的基线，
 * 而非中性假设；"候选能否把最差会话拉回可推荐线"即行为对比判据。
 */

import { drainHarnessSignals, buildAutoFixtures, setLastAutoStep } from './signal-collector.js';
import { isHarnessingEnabled } from './budget.js';
import { runHarnessingStep } from './index.js';
import { SELF_REGISTERED_TOOLS } from '../plugin/tool-guidance.js';
import { getWorstEffectiveWeight } from '../plugin/sad-feedback.js';
import type { AutoStepSnapshot } from './signal-collector.js';

/** 自动观察步开关：默认开启，仅显式 LCMG_HARNESSING_AUTO=off 关闭 */
export function isHarnessingAutoEnabled(): boolean {
  return (process.env.LCMG_HARNESSING_AUTO ?? '').trim().toLowerCase() !== 'off';
}

export interface AutoHarnessingSummary {
  ran: boolean;
  skipped?: 'auto-disabled' | 'no-signals' | 'no-fixtures';
  signals: number;
  stepId?: string;
  proposals?: number;
  adopted?: number;
  rejected?: number;
  inconclusive?: number;
  lessonsWritten?: number;
}

/**
 * 运行一次自动观察步（由 heartbeat 低频调用；永不抛错）。
 * @param opts.minSignals 触发演算的最少信号数（默认 1）
 */
export async function runAutoHarnessingStep(opts?: {
  minSignals?: number;
  log?: { debug?: (msg: string, meta?: any) => void; warn?: (msg: string, meta?: any) => void };
}): Promise<AutoHarnessingSummary> {
  try {
    // 顺序重要：先查开关再 drain，关着的时候不能把信号丢掉
    if (!isHarnessingEnabled()) {
      return { ran: false, skipped: 'auto-disabled', signals: 0 };
    }
    if (!isHarnessingAutoEnabled()) {
      return { ran: false, skipped: 'auto-disabled', signals: 0 };
    }

    const signals = drainHarnessSignals();
    const min = Math.max(1, Math.trunc(opts?.minSignals ?? 1));
    if (signals.length < min) {
      setLastAutoStep({ ts: Date.now(), ran: false, skipped: 'no-signals', signalCount: signals.length });
      return { ran: false, skipped: 'no-signals', signals: signals.length };
    }

    const knownTools = [...SELF_REGISTERED_TOOLS];
    const fixtures = buildAutoFixtures(signals, knownTools);

    // 无探针集 = 信号未指向任何已知工具 → 无行为证据可对比，如实跳过（信号已消费，
    // 但计数留在快照里供诊断；探测预算上限 20 由 buildAutoFixtures cap 保证）
    if (fixtures.length === 0) {
      setLastAutoStep({ ts: Date.now(), ran: false, skipped: 'no-fixtures', signalCount: signals.length });
      return { ran: false, skipped: 'no-fixtures', signals: signals.length };
    }

    // v1 硬约束：expStore 恒 null —— 自动路径绝不写盘
    const step = await runHarnessingStep({
      signals,
      fixtures,
      knownTools,
      baseLookup: (t: string) => getWorstEffectiveWeight(t),
      expStore: null,
      stepId: 'auto_' + Date.now().toString(36),
      log: opts?.log,
    });

    const snapshot: AutoStepSnapshot = {
      ts: Date.now(),
      ran: step.ran,
      skipped: step.skipped,
      signalCount: signals.length,
      stepId: step.stepId,
      proposals: step.proposals.length,
      adopted: step.adopted.length,
      rejected: step.rejected.length,
      inconclusive: step.inconclusive.length,
      lessonsWritten: step.lessonsWritten,
    };
    setLastAutoStep(snapshot);

    return {
      ran: step.ran,
      skipped: step.skipped as AutoHarnessingSummary['skipped'],
      signals: signals.length,
      stepId: step.stepId,
      proposals: step.proposals.length,
      adopted: step.adopted.length,
      rejected: step.rejected.length,
      inconclusive: step.inconclusive.length,
      lessonsWritten: step.lessonsWritten,
    };
  } catch (err) {
    opts?.log?.warn?.('auto harnessing step failed (soft-fail)', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { ran: false, skipped: 'no-signals', signals: 0 };
  }
}
