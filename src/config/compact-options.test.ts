/**
 * resolveCompactOptions 单测。
 *
 * 验证目标（对应"不硬编码"）：
 *  1. 显式配置优先（lcmMonitor.compactTimeout / inputOverflowThreshold）；
 *  2. 缺失 / 非法值回退 DEFAULTS.compact（默认值与 schema 单一来源）；
 *  3. 边界：0、负数、NaN、>1 的占比、字符串数字，均不得产出会让调用方行为异常的值
 *     （尤其是阈值 0 —— 会让"输入超限"对任何 token 数恒为 true）。
 */
import { describe, it, expect } from 'vitest';
import { DEFAULTS, resolveCompactOptions } from './defaults.js';

describe('DEFAULTS.compact', () => {
  it('默认值存在且合法（阈值在 (0,1]，超时为正）', () => {
    expect(DEFAULTS.compact.attemptTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULTS.compact.inputOverflowRatio).toBeGreaterThan(0);
    expect(DEFAULTS.compact.inputOverflowRatio).toBeLessThanOrEqual(1);
  });
});

describe('resolveCompactOptions', () => {
  it('无配置 / null / undefined 时回退默认', () => {
    const base = {
      attemptTimeoutMs: DEFAULTS.compact.attemptTimeoutMs,
      inputOverflowRatio: DEFAULTS.compact.inputOverflowRatio,
    };
    expect(resolveCompactOptions(undefined)).toEqual(base);
    expect(resolveCompactOptions(null)).toEqual(base);
    expect(resolveCompactOptions({})).toEqual(base);
  });

  it('显式配置优先', () => {
    const r = resolveCompactOptions({ compactTimeout: 45_000, inputOverflowThreshold: 0.9 });
    expect(r.attemptTimeoutMs).toBe(45_000);
    expect(r.inputOverflowRatio).toBe(0.9);
  });

  it('字符串数字可被接受（配置经 JSON 传递时的常见形态）', () => {
    const r = resolveCompactOptions({ compactTimeout: '120000' as unknown as number, inputOverflowThreshold: '0.7' as unknown as number });
    expect(r.attemptTimeoutMs).toBe(120_000);
    expect(r.inputOverflowRatio).toBe(0.7);
  });

  it('超时非法（0 / 负数 / NaN / 非数字）回退默认', () => {
    for (const bad of [0, -1, NaN, Infinity, 'abc' as unknown as number]) {
      expect(resolveCompactOptions({ compactTimeout: bad }).attemptTimeoutMs)
        .toBe(DEFAULTS.compact.attemptTimeoutMs);
    }
  });

  it('占比非法（0 / 负数 / NaN / >1）回退默认 —— 0 会让超限判定恒真', () => {
    for (const bad of [0, -0.2, NaN, 1.5, Infinity, 'abc' as unknown as number]) {
      expect(resolveCompactOptions({ inputOverflowThreshold: bad }).inputOverflowRatio)
        .toBe(DEFAULTS.compact.inputOverflowRatio);
    }
  });

  it('阈值 = 1 视为合法（仅满窗才算超限）', () => {
    expect(resolveCompactOptions({ inputOverflowThreshold: 1 }).inputOverflowRatio).toBe(1);
  });

  it('超时向下取整为整数毫秒', () => {
    expect(resolveCompactOptions({ compactTimeout: 1500.9 }).attemptTimeoutMs).toBe(1500);
  });
});