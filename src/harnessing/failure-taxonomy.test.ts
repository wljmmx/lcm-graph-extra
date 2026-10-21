/**
 * Harnessing P6: 失败四分类法单测。
 */
import { describe, it, expect } from 'vitest';
import { classifyFailure, normalizeSignals, FAILURE_KIND_LABELS } from './failure-taxonomy.js';

describe('classifyFailure（四分类，中英双语，顺序=优先级）', () => {
  it('environment-contract（最先匹配，即使文本含"失败"）', () => {
    expect(classifyFailure('Cannot find module "neo4j-driver"')).toBe('environment-contract');
    expect(classifyFailure('npm EBADENGINE: 版本不满足要求')).toBe('environment-contract');
    expect(classifyFailure('配置缺失：未设置 apiKey')).toBe('environment-contract');
  });

  it('action-realization', () => {
    expect(classifyFailure('工具调用失败：lcmg_search 参数错误')).toBe('action-realization');
    expect(classifyFailure('command failed with exit code 1')).toBe('action-realization');
    expect(classifyFailure('LLM call timeout after 30000ms')).toBe('action-realization');
  });

  it('trajectory-degeneration', () => {
    expect(classifyFailure('模型反复尝试同一命令，原地打转')).toBe('trajectory-degeneration');
    expect(classifyFailure('context overflow, 上下文丢失了前文结论')).toBe('trajectory-degeneration');
  });

  it('residual-reasoning', () => {
    expect(classifyFailure('模型误解了需求，产出错误结论')).toBe('residual-reasoning');
    expect(classifyFailure('hallucinated a non-existent API')).toBe('residual-reasoning');
  });

  it('无命中 → null；空输入 → null', () => {
    expect(classifyFailure('今天天气不错')).toBeNull();
    expect(classifyFailure('')).toBeNull();
  });
});

describe('normalizeSignals（归一化 + 兜底）', () => {
  it('字符串输入自动分类', () => {
    const out = normalizeSignals(['Cannot find module "x"', '工具调用失败：参数错误']);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe('environment-contract');
    expect(out[1].kind).toBe('action-realization');
    expect(out[0].count).toBe(1);
  });

  it('对象输入：缺 kind 补分类，count 保留合法值', () => {
    const out = normalizeSignals([{ text: '死循环了', source: 'diagnose', count: 3 }, { kind: 'residual-reasoning', text: '推理错了' }]);
    expect(out[0].kind).toBe('trajectory-degeneration');
    expect(out[0].source).toBe('diagnose');
    expect(out[0].count).toBe(3);
    expect(out[1].kind).toBe('residual-reasoning');
  });

  it('无法分类的文本兜底为 residual-reasoning（记录而不丢弃）', () => {
    expect(normalizeSignals(['莫名其妙的问题'])[0].kind).toBe('residual-reasoning');
  });

  it('空白/非法输入被过滤', () => {
    expect(normalizeSignals(['', '   ', null as any])).toEqual([]);
  });

  it('四类标签齐备', () => {
    expect(Object.keys(FAILURE_KIND_LABELS)).toHaveLength(4);
  });
});
