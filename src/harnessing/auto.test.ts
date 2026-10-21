/**
 * Harnessing 自动介入单测：signal-collector + auto 观察步 + sad-feedback 最差权重基线。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordHarnessSignal,
  drainHarnessSignals,
  peekHarnessSignals,
  buildAutoFixtures,
  setLastAutoStep,
  getLastAutoStep,
  resetHarnessingDiagnostics,
} from './signal-collector.js';
import { runAutoHarnessingStep, isHarnessingAutoEnabled } from './auto.js';
import { recordSadFeedback, clearSadWeights, getWorstEffectiveWeight } from '../plugin/sad-feedback.js';
import '../plugin/tool-guidance.js'; // 触发 setCategorizer

const ORIG = {
  LCMG_HARNESSING: process.env.LCMG_HARNESSING,
  LCMG_HARNESSING_AUTO: process.env.LCMG_HARNESSING_AUTO,
};

beforeEach(() => {
  resetHarnessingDiagnostics();
  clearSadWeights('sess-auto-1');
  clearSadWeights('sess-auto-2');
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
});

describe('signal-collector（自动信号池）', () => {
  it('记录 + 自动分类 + 同源同文聚合计数', () => {
    expect(recordHarnessSignal('工具 lcmg_search 调用失败：超时', 'lcmg_search')).toBe(true);
    recordHarnessSignal('工具 lcmg_search 调用失败：超时', 'lcmg_search'); // 同 key → count++
    recordHarnessSignal('Cannot find module "x"', 'other');
    expect(recordHarnessSignal('   ')).toBe(false);

    const peek = peekHarnessSignals();
    expect(peek.count).toBe(2);
    expect(peek.totalOccurrences).toBe(3);
    expect(peek.bySource['lcmg_search']).toBe(1);
    expect(peek.byKind['action-realization']).toBe(1);   // 超时 → 动作实现失败
    expect(peek.byKind['environment-contract']).toBe(1); // 找不到模块 → 环境契约
  });

  it('drain 清空语义：取走即空，二次 drain 为空', () => {
    recordHarnessSignal('配置缺失', 'cfg');
    const first = drainHarnessSignals();
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe('environment-contract');
    expect(first[0].source).toBe('cfg');
    expect(drainHarnessSignals()).toEqual([]);
  });

  it('TTL 过期信号被清理（fake timers）', () => {
    vi.useFakeTimers();
    try {
      recordHarnessSignal('旧信号', 'old');
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); // 25h 后
      recordHarnessSignal('新信号', 'new');
      const drained = drainHarnessSignals();
      expect(drained.map((s) => s.source)).toEqual(['new']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('buildAutoFixtures：信号提到的已知工具 → 探针对（按工具去重，cap 20）', () => {
    recordHarnessSignal('lcmg_search 调用失败', 'lcmg_search');
    recordHarnessSignal('lcmg_diagnose 报错', 'lcmg_diagnose');
    recordHarnessSignal('完全无关的失败文本', 'unknown-src');
    const sigs = drainHarnessSignals();
    const fixtures = buildAutoFixtures(sigs, ['lcmg_search', 'lcmg_diagnose']);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]).toEqual({ query: 'lcmg_search 调用失败', expectedTools: ['lcmg_search'] });
    // 同一工具被多个信号提及 → 只产一个探针对（按工具去重）
    const repeated = Array.from({ length: 30 }, (_, i) => ({ kind: 'action-realization' as const, text: `lcmg_search 失败 ${i}` }));
    expect(buildAutoFixtures(repeated, ['lcmg_search'])).toHaveLength(1);
    // 未知工具不产探针对
    expect(buildAutoFixtures([{ kind: 'action-realization', text: 'mystery_tool 挂了' }], ['lcmg_search'])).toHaveLength(0);
  });
});

describe('getWorstEffectiveWeight（跨会话最差 SAD 基线）', () => {
  it('无观测 → DEFAULT 0.5；有衰减会话 → 取最差', () => {
    expect(getWorstEffectiveWeight('lcmg_search')).toBe(0.5);
    // sess-auto-1 连续 4 轮注入未使用 → 权重被压低
    for (let r = 1; r <= 4; r++) {
      recordSadFeedback('sess-auto-1', [{ tool: 'lcmg_search', used: false, round: r }], ['lcmg_search']);
    }
    // sess-auto-2 正向使用 → 权重升高
    recordSadFeedback('sess-auto-2', [{ tool: 'lcmg_search', used: true, round: 1 }], ['lcmg_search']);
    const worst = getWorstEffectiveWeight('lcmg_search');
    expect(worst).toBeLessThan(0.2);   // 最差会话已低于命中线
    expect(worst).toBeGreaterThanOrEqual(0);
  });
});

describe('runAutoHarnessingStep（自动观察步）', () => {
  it('LCMG_HARNESSING_AUTO=off → skipped（auto-disabled），信号不被消费', async () => {
    process.env.LCMG_HARNESSING_AUTO = 'off';
    recordHarnessSignal('lcmg_search 调用失败', 'lcmg_search');
    const s = await runAutoHarnessingStep();
    expect(s.skipped).toBe('auto-disabled');
    expect(peekHarnessSignals().count).toBe(1); // 信号保留
  });

  it('无信号 → skipped（no-signals）并写入快照', async () => {
    const s = await runAutoHarnessingStep();
    expect(s.skipped).toBe('no-signals');
    expect(getLastAutoStep()?.skipped).toBe('no-signals');
  });

  it('信号指向已知工具 + SAD 低基线 → 完整观察步（adopt 但零写盘）', async () => {
    // 构造最差基线：sess-auto-1 中 lcmg_search 被压到命中线以下
    for (let r = 1; r <= 4; r++) {
      recordSadFeedback('sess-auto-1', [{ tool: 'lcmg_search', used: false, round: r }], ['lcmg_search']);
    }
    recordHarnessSignal('lcmg_search 调用失败：参数错误', 'lcmg_search');

    const s = await runAutoHarnessingStep();
    expect(s.ran).toBe(true);
    expect(s.signals).toBe(1);
    expect(s.adopted).toBeGreaterThanOrEqual(1);       // 候选把最差会话拉回命中线
    expect(s.lessonsWritten).toBe(0);                  // v1 硬约束：自动路径零写盘

    const snap = getLastAutoStep()!;
    expect(snap.ran).toBe(true);
    expect(snap.lessonsWritten).toBe(0);
    expect(snap.stepId).toMatch(/^auto_/);
  });

  it('信号未指向已知工具 → skipped（no-fixtures）', async () => {
    recordHarnessSignal('完全无关的失败描述文本');
    const s = await runAutoHarnessingStep();
    expect(s.skipped).toBe('no-fixtures');
  });

  it('isHarnessingAutoEnabled：默认开启，仅 off 关闭', () => {
    delete process.env.LCMG_HARNESSING_AUTO;
    expect(isHarnessingAutoEnabled()).toBe(true);
    process.env.LCMG_HARNESSING_AUTO = '  OFF ';
    expect(isHarnessingAutoEnabled()).toBe(false);
    process.env.LCMG_HARNESSING_AUTO = 'on';
    expect(isHarnessingAutoEnabled()).toBe(true);
  });
});
