/**
 * lcmg_harness_step 工具级测试。
 * 覆盖：注册契约 / observe 默认不落盘 / apply 写入经验库 / 空参安全跳过 / abort 快速返回。
 * 采纳路径通过 SAD 反馈构造低基线权重（< 0.2 命中线）真实触发。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerOperationalToolsWithDashboard, getRegisteredToolHandler, _resetRegisteredToolHandlers } from '../tools.js';
import { recordSadFeedback, clearSadWeights } from '../plugin/sad-feedback.js';
import '../plugin/tool-guidance.js'; // 触发 setCategorizer 注册

const ORIG = process.env.LCMG_HARNESSING;

function setup(dashboardContext?: any) {
  _resetRegisteredToolHandlers();
  const registered: any[] = [];
  const mockApi = { registerTool: vi.fn((t: any) => { registered.push(t); }) };
  registerOperationalToolsWithDashboard(mockApi, dashboardContext);
  const tool = registered.find((t: any) => t.name === 'lcmg_harness_step');
  return { tool, registered };
}

/** 把 lcmg_search 的 SAD 有效权重压到命中线以下（连续 4 轮注入未使用） */
function decaySearchBelowThreshold(sessionKey: string) {
  for (let round = 1; round <= 4; round++) {
    recordSadFeedback(
      sessionKey,
      [{ tool: 'lcmg_search', used: false, round }],
      ['lcmg_search'],
    );
  }
}

const FIXTURES = [
  { query: '搜索记忆', expectedTools: ['lcmg_search'] },
  { query: '蒸馏', expectedTools: ['lcmg_distill'] },
  { query: '诊断', expectedTools: ['lcmg_diagnose'] },
  { query: '备份', expectedTools: ['lcmg_backup'] },
];
const SIGNALS = ['lcmg_search 调用失败：参数错误'];

beforeEach(() => {
  if (ORIG === undefined) delete process.env.LCMG_HARNESSING;
  else process.env.LCMG_HARNESSING = ORIG;
  clearSadWeights('sess-harness-test');
});

describe('lcmg_harness_step（工具）', () => {
  it('注册契约：name/label/execute 齐备且进入 handler 注册表', () => {
    const { tool } = setup();
    expect(tool).toBeDefined();
    expect(tool.label).toBe('Harness 演进步骤');
    expect(typeof tool.execute).toBe('function');
    expect(getRegisteredToolHandler('lcmg_harness_step')).toBeDefined();
  });

  it('observe（默认）：真实采纳路径演算成功但不落盘', async () => {
    const { tool } = setup(undefined);
    decaySearchBelowThreshold('sess-harness-test');
    const res = await tool.execute('call-1', {
      signals: SIGNALS,
      fixtures: FIXTURES,
      sessionKey: 'sess-harness-test',
    }, { aborted: false } as AbortSignal);

    expect(res.isError).toBeUndefined();
    expect(res.details.ok).toBe(true);
    expect(res.details.mode).toBe('observe');
    expect(res.details.result.ran).toBe(true);
    expect(res.details.result.adopted).toHaveLength(1);   // SAD 低基线 → 候选过命中线
    expect(res.details.result.lessonsWritten).toBe(0);    // observe 不落盘
    expect(res.content[0].text).toContain('observe 模式不落盘');
  });

  it('apply + expStore：采纳项写入经验库（含 evidence + scope）', async () => {
    const saveDistilled = vi.fn().mockResolvedValue(undefined);
    const { tool } = setup({ expStore: { saveDistilled } });
    decaySearchBelowThreshold('sess-harness-test');
    const res = await tool.execute('call-2', {
      signals: SIGNALS,
      fixtures: FIXTURES,
      mode: 'apply',
      sessionKey: 'sess-harness-test',
      stepId: 'hstep_tool_test',
    }, { aborted: false } as AbortSignal);

    expect(res.details.ok).toBe(true);
    expect(res.details.result.lessonsWritten).toBe(1);
    expect(saveDistilled).toHaveBeenCalledTimes(1);
    const saved = saveDistilled.mock.calls[0][0];
    expect(saved.scope).toBe('domain');
    expect(saved.evidence.probeId).toBe('hstep_tool_test');
    expect(saved.evidence.contrast).toBeGreaterThan(0);
    expect(res.content[0].text).not.toContain('observe 模式不落盘');
  });

  it('空参数 → 安全跳过（no-signals），不抛错、ok:true', async () => {
    const { tool } = setup();
    const res = await tool.execute('call-3', {}, { aborted: false } as AbortSignal);
    expect(res.details.ok).toBe(true);
    expect(res.details.result.skipped).toBe('no-signals');
  });

  it('无探针集 → 跳过（no-fixtures，证据纪律）', async () => {
    const { tool } = setup();
    const res = await tool.execute('call-4', { signals: SIGNALS, fixtures: [] }, { aborted: false } as AbortSignal);
    expect(res.details.result.skipped).toBe('no-fixtures');
  });

  it('signal.aborted → 快速返回 abort 错误', async () => {
    const { tool } = setup();
    const res = await tool.execute('call-5', { signals: SIGNALS, fixtures: FIXTURES }, { aborted: true } as AbortSignal);
    expect(res.isError).toBe(true);
    expect(res.details.aborted).toBe(true);
  });

  it('LCMG_HARNESSING=off → skipped（harnessing-disabled）', async () => {
    process.env.LCMG_HARNESSING = 'off';
    const { tool } = setup();
    const res = await tool.execute('call-6', { signals: SIGNALS, fixtures: FIXTURES }, { aborted: false } as AbortSignal);
    expect(res.details.result.skipped).toBe('harnessing-disabled');
  });
});
