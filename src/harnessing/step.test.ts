/**
 * Harnessing 总线集成测试：runHarnessingStep（Propose → Probe → Compose → 经验沉淀）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHarnessingStep } from './index.js';
import type { ProbeFixture } from './probe.js';

const ORIG = process.env.LCMG_HARNESSING;

beforeEach(() => {
  if (ORIG === undefined) delete process.env.LCMG_HARNESSING;
  else process.env.LCMG_HARNESSING = ORIG;
});

const FIXTURES: ProbeFixture[] = [
  { query: '搜索', expectedTools: ['lcmg_search'] },
  { query: '蒸馏', expectedTools: ['lcmg_distill'] },
  { query: '诊断', expectedTools: ['lcmg_diagnose'] },
  { query: '备份', expectedTools: ['lcmg_backup'] },
];

/** 基线：lcmg_search 低于命中线（模拟"工具引导存在改进空间"） */
const baseLookup = (t: string) => (t === 'lcmg_search' ? 0.15 : 0.5);

function fakeExpStore() {
  return { saveDistilled: vi.fn().mockResolvedValue(undefined) };
}

describe('runHarnessingStep（总线）', () => {
  it('完整闭环：采纳 → 经验写入（含 evidence + scope），命中工具从信号文本提取', async () => {
    const expStore = fakeExpStore();
    const r = await runHarnessingStep({
      signals: ['lcmg_search 调用失败：参数错误（反复重试）'],
      fixtures: FIXTURES,
      baseLookup,
      knownTools: ['lcmg_search', 'lcmg_distill', 'lcmg_diagnose', 'lcmg_backup'],
      expStore,
      stepId: 'hstep_test',
    });

    expect(r.ran).toBe(true);
    expect(r.skipped).toBeUndefined();
    // action-realization → tool-guidance 候选（domain，指名工具）
    expect(r.proposals[0].component).toBe('tool-guidance');
    expect(r.proposals[0].scope).toBe('domain');
    // 探针：基线 3/4 → 候选 4/4 → adopt
    expect(r.outcomes[0].verdict).toBe('adopt');
    expect(r.adopted).toHaveLength(1);
    // 经验写入：证据链 + 作用域齐备
    expect(expStore.saveDistilled).toHaveBeenCalledTimes(1);
    const saved = expStore.saveDistilled.mock.calls[0][0];
    expect(saved.id).toContain('hstep_test');
    expect(saved.scope).toBe('domain');
    expect(saved.evidence.probeId).toBe('hstep_test');
    expect(saved.evidence.contrast).toBeGreaterThan(0);
    expect(saved.evidence.trajectoryRef).toBeUndefined(); // 信号无 source → 无轨迹引用
    expect(r.lessonsWritten).toBe(1);
  });

  it('LCMG_HARNESSING=off → 跳过且零写入', async () => {
    process.env.LCMG_HARNESSING = 'off';
    const expStore = fakeExpStore();
    const r = await runHarnessingStep({
      signals: ['配置缺失'],
      fixtures: FIXTURES,
      expStore,
    });
    expect(r.ran).toBe(false);
    expect(r.skipped).toBe('harnessing-disabled');
    expect(expStore.saveDistilled).not.toHaveBeenCalled();
  });

  it('无探针集 → 跳过（no-fixtures，证据纪律）', async () => {
    const r = await runHarnessingStep({ signals: ['配置缺失'], fixtures: [] });
    expect(r.skipped).toBe('no-fixtures');
  });

  it('无信号 → 跳过（no-signals）', async () => {
    const r = await runHarnessingStep({ signals: [], fixtures: FIXTURES });
    expect(r.skipped).toBe('no-signals');
  });

  it('全部 inconclusive → 零写入（默认保守）', async () => {
    const expStore = fakeExpStore();
    const r = await runHarnessingStep({
      signals: ['环境契约失配：配置缺失'], // → guardrails 候选，无 probe 负载 → inconclusive
      fixtures: FIXTURES,
      expStore,
    });
    expect(r.ran).toBe(true);
    expect(r.inconclusive).toHaveLength(1);
    expect(r.adopted).toHaveLength(0);
    expect(expStore.saveDistilled).not.toHaveBeenCalled();
    expect(r.lessonsWritten).toBe(0);
  });

  it('expStore 缺省 = 观察模式（演算不落盘）', async () => {
    const r = await runHarnessingStep({
      signals: ['lcmg_search 调用失败：参数错误'],
      fixtures: FIXTURES,
      baseLookup,
      knownTools: ['lcmg_search'],
    });
    expect(r.ran).toBe(true);
    expect(r.adopted).toHaveLength(1);
    expect(r.lessonsWritten).toBe(0);
  });

  it('经验写入失败 → 软失败不抛错，lessonsWritten 如实为 0', async () => {
    const expStore = { saveDistilled: vi.fn().mockRejectedValue(new Error('neo4j down')) };
    const r = await runHarnessingStep({
      signals: ['lcmg_search 调用失败：参数错误'],
      fixtures: FIXTURES,
      baseLookup,
      knownTools: ['lcmg_search'],
      expStore,
      log: { warn: vi.fn() },
    });
    expect(r.ran).toBe(true);
    expect(r.lessonsWritten).toBe(0);
  });

  it('探针集超过预算上限 → 截断后执行', async () => {
    const many: ProbeFixture[] = Array.from({ length: 50 }, (_, i) => ({ query: `q${i}`, expectedTools: ['lcmg_search'] }));
    const r = await runHarnessingStep({
      signals: ['lcmg_search 调用失败：参数错误'],
      fixtures: many,
      baseLookup,
      knownTools: ['lcmg_search'],
    });
    expect(r.ran).toBe(true);
    expect(r.outcomes[0].baseline.fixtures).toBeLessThanOrEqual(20); // maxProbeFixtures 默认 20
  });
});
