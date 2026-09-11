/**
 * learning-model 自适应学习测试
 *
 * 验证：
 * - 能力校准（优化点 1）：持续成功 → 能力上调；常失败 → 能力下调；样本少时 ≈ 启发式
 * - Token 成本学习（优化点 3）：实测均值随记录收敛
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 隔离：把学习状态文件指向临时路径，避免读写用户真实状态、也避免跨文件/跨运行污染
vi.hoisted(() => {
  process.env.LCM_MOA_LEARNING_FILE = `/tmp/lcm-moa-learning-test-${process.pid}.json`;
});

import {
  recordModelOutcome,
  recordTokenUsage,
  getCalibratedStrength,
  getExpectedTokens,
  resetLearningModel,
} from './learning-model.js';

describe('learning-model: 能力校准', () => {
  beforeEach(() => {
    // 重置内存统计；状态文件已由 vi.hoisted 指向临时路径，不触碰用户真实数据
    resetLearningModel({ deleteFile: true });
  });

  it('无样本时返回启发式基线', () => {
    expect(getCalibratedStrength('gpt-4o', undefined, 'code-review', 0.85)).toBeCloseTo(0.85, 5);
  });

  it('持续成功 → 能力上调（高于启发式）', () => {
    for (let i = 0; i < 20; i++) recordModelOutcome('gpt-4o', true, 'code-review');
    const calibrated = getCalibratedStrength('gpt-4o', undefined, 'code-review', 0.85);
    expect(calibrated).toBeGreaterThan(0.85);
  });

  it('持续失败 → 能力下调（低于启发式）', () => {
    for (let i = 0; i < 20; i++) recordModelOutcome('llama3.2:1b', false, 'code-review');
    const calibrated = getCalibratedStrength('llama3.2:1b', undefined, 'code-review', 0.35);
    expect(calibrated).toBeLessThan(0.35);
  });

  it('样本量少时校准偏移被抑制（接近启发式）', () => {
    recordModelOutcome('qwen2.5:7b', true, 'architecture');
    recordModelOutcome('qwen2.5:7b', true, 'architecture');
    recordModelOutcome('qwen2.5:7b', false, 'architecture');
    const calibrated = getCalibratedStrength('qwen2.5:7b', undefined, 'architecture', 0.35);
    // 2/3 成功，但受先验(PRIOR_N=5)压制：偏移(0.07)明显小于无先验时的 0.15
    expect(Math.abs(calibrated - 0.35)).toBeLessThan(0.1);
    expect(calibrated).toBeLessThan(0.35);
  });

  it('无任务时退化为模型全局统计', () => {
    for (let i = 0; i < 10; i++) recordModelOutcome('deepseek-r1', true, 'security');
    const calibrated = getCalibratedStrength('deepseek-r1', undefined, undefined, 0.85);
    expect(calibrated).toBeGreaterThan(0.85);
  });
});

describe('learning-model: token 成本学习', () => {
  beforeEach(() => {
    resetLearningModel({ deleteFile: true });
  });

  it('实测均值随记录收敛', () => {
    recordTokenUsage('gpt-4o', 1000, 500);
    recordTokenUsage('gpt-4o', 2000, 1500);
    const exp = getExpectedTokens('gpt-4o');
    expect(exp).toBeDefined();
    expect(exp!.input).toBeCloseTo(1500, 5);
    expect(exp!.output).toBeCloseTo(1000, 5);
  });

  it('无记录时返回 undefined', () => {
    expect(getExpectedTokens('never-seen')).toBeUndefined();
  });
});