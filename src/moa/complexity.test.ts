/**
 * MoA 复杂度评估单元测试。
 *
 * 覆盖：
 * - computeTaskComplexity: 各维度打分、简单场景排除、压力层级控制
 * - 边界条件：空查询、不同长度、各种场景标签
 */
import { describe, it, expect } from 'vitest';
import {
  computeTaskComplexity,
  decideMoa,
  estimateAggregateStrength,
  estimateMainModelStrength,
  modelDomainFit,
  isLocalModel,
  getModelCostUnit,
  computeCostPenalty,
  DEFAULT_BENEFIT_THRESHOLD,
} from './complexity.js';

// ============================================================================
// computeTaskComplexity
// ============================================================================
describe('computeTaskComplexity', () => {
  describe('简单场景快速排除', () => {
    it('greeting 场景返回 score 0', () => {
      const result = computeTaskComplexity('hello', [], 'greeting', 'low');
      expect(result.score).toBe(0);
      expect(result.reasons).toContain('简单场景: greeting');
    });

    it('simple-query 场景返回 score 0', () => {
      const result = computeTaskComplexity('what is this', [], 'simple-query', 'low');
      expect(result.score).toBe(0);
    });

    it('translation 场景返回 score 0', () => {
      const result = computeTaskComplexity('translate this', [], 'translation', 'low');
      expect(result.score).toBe(0);
    });
  });

  describe('压力层级控制', () => {
    it('high 压力时跳过 MoA', () => {
      const result = computeTaskComplexity(
        '请帮我设计一个完整的微服务架构方案，包括数据库设计、API设计、部署方案',
        [],
        'architecture',
        'high',
      );
      expect(result.score).toBe(0);
      expect(result.reasons).toContain('高压模式跳过 MoA');
    });
  });

  describe('查询长度分析', () => {
    it('超长查询 (>500 字符) 加分', () => {
      const longQuery = '请帮我设计一个系统 '.repeat(40); // ~560 字符
      const result = computeTaskComplexity(longQuery, [], null, 'low');
      expect(result.score).toBeGreaterThan(0);
      expect(result.reasons.some((r) => r.includes('长查询'))).toBe(true);
    });

    it('中长查询 (200-500 字符) 加分', () => {
      const mediumQuery = '请帮我设计一个完整的用户认证系统 '.repeat(20); // ~300 字符
      const result = computeTaskComplexity(mediumQuery, [], null, 'low');
      expect(result.reasons.some((r) => r.includes('中长查询'))).toBe(true);
    });

    it('短查询不加长度分', () => {
      const result = computeTaskComplexity('hello', [], null, 'low');
      const hasLengthReason = result.reasons.some((r) => r.includes('查询') || r.includes('字符'));
      expect(hasLengthReason).toBe(false);
    });
  });

  describe('多步骤指令检测', () => {
    it('中文多步骤指令', () => {
      const result = computeTaskComplexity('首先分析需求，然后设计方案，最后实现代码', [], null, 'low');
      expect(result.reasons).toContain('多步骤指令');
    });

    it('英文多步骤指令', () => {
      const result = computeTaskComplexity('first analyze, then design, finally implement', [], null, 'low');
      expect(result.reasons).toContain('多步骤指令');
    });
  });

  describe('代码生成动词检测', () => {
    it('写代码触发代码生成', () => {
      const result = computeTaskComplexity('写一个排序函数', [], null, 'low');
      expect(result.reasons).toContain('代码生成任务');
    });

    it('实现功能触发代码生成', () => {
      const result = computeTaskComplexity('实现一个LRU缓存', [], null, 'low');
      expect(result.reasons).toContain('代码生成任务');
    });

    it('build 触发代码生成', () => {
      const result = computeTaskComplexity('build a REST API', [], null, 'low');
      expect(result.reasons).toContain('代码生成任务');
    });
  });

  describe('架构设计关键词', () => {
    it('架构设计触发', () => {
      const result = computeTaskComplexity('设计一个微服务架构方案', [], null, 'low');
      expect(result.reasons).toContain('架构设计/技术选型');
    });

    it('技术选型触发', () => {
      const result = computeTaskComplexity('技术选型：React vs Vue', [], null, 'low');
      expect(result.reasons).toContain('架构设计/技术选型');
    });
  });

  describe('跨模块/多文件操作', () => {
    it('多文件操作触发', () => {
      const result = computeTaskComplexity('需要修改多个文件', [], null, 'low');
      expect(result.reasons).toContain('跨模块/多文件操作');
    });

    it('跨模块操作触发', () => {
      const result = computeTaskComplexity('跨模块重构', [], null, 'low');
      expect(result.reasons).toContain('跨模块/多文件操作');
    });
  });

  describe('场景标签加权', () => {
    it('bug-fix 场景加分', () => {
      const result = computeTaskComplexity('修复崩溃问题', [], 'bug-fix', 'low');
      expect(result.reasons).toContain('复杂场景: bug-fix');
    });

    it('refactor 场景加分', () => {
      const result = computeTaskComplexity('重构代码', [], 'refactor', 'low');
      expect(result.reasons).toContain('复杂场景: refactor');
    });

    it('performance-opt 场景加分', () => {
      const result = computeTaskComplexity('性能优化', [], 'performance-opt', 'low');
      expect(result.reasons).toContain('复杂场景: performance-opt');
    });
  });

  describe('多轮对话深度', () => {
    it('>20 条消息加分', () => {
      const messages = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'msg' }));
      const result = computeTaskComplexity('继续', messages, null, 'low');
      expect(result.reasons).toContain('深度多轮对话(>20条)');
    });

    it('10-20 条消息加分', () => {
      const messages = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'msg' }));
      const result = computeTaskComplexity('继续', messages, null, 'low');
      expect(result.reasons).toContain('多轮对话(10-20条)');
    });

    it('<10 条消息不加分', () => {
      const messages = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: 'msg' }));
      const result = computeTaskComplexity('hello', messages, null, 'low');
      const hasDepthReason = result.reasons.some((r) => r.includes('多轮') || r.includes('对话'));
      expect(hasDepthReason).toBe(false);
    });
  });

  describe('综合场景', () => {
    it('高复杂度任务 score 较高', () => {
      const longQuery = '请帮我设计一个完整的微服务架构，首先分析需求，然后设计方案，最后实现代码。需要修改多个文件，涉及跨模块重构。'.repeat(3);
      const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'msg' }));
      const result = computeTaskComplexity(longQuery, messages, 'architecture', 'low');
      // 应触发多个维度
      expect(result.score).toBeGreaterThan(0.5);
      expect(result.reasons.length).toBeGreaterThan(2);
    });

    it('简单任务 score 较低', () => {
      const result = computeTaskComplexity('hello world', [], null, 'low');
      expect(result.score).toBe(0);
    });
  });

  describe('上限约束', () => {
    it('score 不超过 1.0', () => {
      const result = computeTaskComplexity(
        '首先分析需求，然后设计方案，最后实现代码。'.repeat(20),
        Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: 'msg' })),
        'bug-fix',
        'low',
      );
      expect(result.score).toBeLessThanOrEqual(1.0);
    });
  });

  describe('边界条件', () => {
    it('空查询正常返回', () => {
      const result = computeTaskComplexity('', [], null, 'low');
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual([]);
    });

    it('null scenario 正常处理', () => {
      const result = computeTaskComplexity('写代码', [], null, 'low');
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });
});

// ============================================================================
// decideMoa —— 收益基准 + 主模型/聚合后能力感知决策
// ============================================================================
describe('decideMoa', () => {
  const baseComplexity = { score: 0.7, reasons: ['复杂场景'] };

  it('复杂度低于基准门槛 (0.3) 时必定不触发', () => {
    const d = decideMoa({
      complexity: { score: 0.2, reasons: [] },
      mainModel: 'gpt-4o',
      configThreshold: 0.6,
      referenceModels: [{ model: 'qwen3.6:27b' }],
    });
    expect(d.trigger).toBe(false);
    expect(d.expectedUplift).toBe(0);
  });

  it('强主模型 + 弱参考模型时，即使复杂度偏高也不触发（能力差距≈0）', () => {
    // 主模型 gpt-4o(0.85)，参考模型为本地小参数(0.35)，聚合后能力难以超过主模型
    const d = decideMoa({
      complexity: { score: 0.7, reasons: ['复杂场景'] },
      mainModel: 'gpt-4o',
      configThreshold: 0.6,
      referenceModels: [
        { model: 'llama3.2:1b' },
        { model: 'qwen2.5:1.5b' },
      ],
      aggregatorModel: { model: 'qwen2.5:1.5b' },
    });
    // 强主模型有效阈值更高（0.85 → 阈值 0.72），0.7 不够
    expect(d.effectiveThreshold).toBeGreaterThan(0.6);
    expect(d.capabilityGap).toBeLessThan(0.1);
    expect(d.trigger).toBe(false);
  });

  it('弱主模型 + 强参考模型时触发，且净收益 ≥ 默认门槛(10%)', () => {
    const d = decideMoa({
      complexity: { score: 0.7, reasons: ['复杂场景'] },
      mainModel: 'qwen2.5:7b',
      configThreshold: 0.6,
      referenceModels: [
        { model: 'gpt-4o' },
        { model: 'claude-sonnet-4' },
      ],
      aggregatorModel: { model: 'gpt-4o' },
    });
    expect(d.capabilityGap).toBeGreaterThan(0.1);
    expect(d.netValue).toBeGreaterThanOrEqual(DEFAULT_BENEFIT_THRESHOLD);
    expect(d.trigger).toBe(true);
  });

  it('本地参考模型 (provider=ollama) 成本几乎不计，微弱提升即可触发', () => {
    // 主模型本地弱(qwen2.5:7b=0.35)，参考模型同为本地小模型，能力差距小
    const d = decideMoa({
      complexity: { score: 0.6, reasons: ['复杂场景'] },
      mainModel: 'qwen2.5:7b',
      mainModelProvider: 'ollama',
      configThreshold: 0.6,
      referenceModels: [
        { model: 'qwen2.5:14b', provider: 'ollama' },
        { model: 'qwen2.5:32b', provider: 'ollama' },
      ],
      aggregatorModel: { model: 'qwen2.5:32b', provider: 'ollama' },
    });
    // 全本地 → 成本摊薄系数接近 1
    expect(d.costPenalty).toBeGreaterThan(0.8);
    expect(d.trigger).toBe(true);
  });

  it('相同模型组合下游本地 vs 远程：远程成本摊薄重，需更高提升才触发', () => {
    const local = decideMoa({
      complexity: { score: 0.5, reasons: ['复杂场景'] },
      mainModel: 'qwen2.5:7b', mainModelProvider: 'ollama',
      configThreshold: 0.6,
      referenceModels: [{ model: 'gpt-4o', provider: 'ollama' }, { model: 'claude-sonnet-4', provider: 'ollama' }],
      aggregatorModel: { model: 'gpt-4o', provider: 'ollama' },
    });
    const remote = decideMoa({
      complexity: { score: 0.5, reasons: ['复杂场景'] },
      mainModel: 'qwen2.5:7b',
      configThreshold: 0.6,
      referenceModels: [{ model: 'gpt-4o' }, { model: 'claude-sonnet-4' }],
      aggregatorModel: { model: 'gpt-4o' },
    });
    expect(local.costPenalty).toBeGreaterThan(remote.costPenalty);
    expect(local.netValue).toBeGreaterThan(remote.netValue);
  });

  it('远程单价配置 (tokenCosts) 可覆盖内置默认表', () => {
    const defaultCost = getModelCostUnit('my-gpt-4o-proxy');
    const configuredCost = getModelCostUnit('my-gpt-4o-proxy', { 'gpt-4o': 0.9 });
    expect(configuredCost).toBe(0.9);
    expect(defaultCost).toBe(0.6);
  });

  it('domainFit：擅长当前任务的模型适配度更高', () => {
    expect(modelDomainFit('qwen-coder', 'code-review')).toBe(1.0);
    expect(modelDomainFit('llama3.2:1b', 'code-review')).toBe(0.7);
    expect(modelDomainFit('deepseek-r1', 'architecture')).toBe(1.0);
    expect(modelDomainFit('gpt-4o', undefined)).toBe(0.85);
  });

  it('isLocalModel：ollama provider 与本地 baseURL 判定为本地', () => {
    expect(isLocalModel('ollama')).toBe(true);
    expect(isLocalModel('openai', 'http://localhost:11434')).toBe(true);
    expect(isLocalModel('openai', 'http://192.168.1.10:8080')).toBe(true);
    expect(isLocalModel('openai', 'https://api.openai.com')).toBe(false);
  });

  it('computeCostPenalty：本地模型成本远低于远程', () => {
    const local = computeCostPenalty([{ model: 'a', provider: 'ollama' }, { model: 'b', provider: 'ollama' }]);
    const remote = computeCostPenalty([{ model: 'gpt-4o' }, { model: 'gpt-4o' }]);
    expect(local).toBeGreaterThan(remote);
  });

  it('参考模型越多，成本摊薄越大，净收益越低', () => {
    const mk = (refCount: number) => decideMoa({
      complexity: baseComplexity,
      mainModel: 'qwen2.5:7b',
      configThreshold: 0.6,
      referenceModels: Array.from({ length: refCount }, () => ({ model: 'gpt-4o' })),
      aggregatorModel: { model: 'gpt-4o' },
    });
    const two = mk(2);
    const four = mk(4);
    expect(four.costPenalty).toBeLessThan(two.costPenalty);
    expect(four.netValue).toBeLessThan(two.netValue);
  });

  it('净收益不足 15% 时即使复杂度达标也不触发', () => {
    // 主模型中性(0.5)，参考模型也是中性(0.5)，能力差距小；复杂度 0.35 仅略高于基准门槛
    const d = decideMoa({
      complexity: { score: 0.35, reasons: ['复杂场景'] },
      mainModel: 'unknown-model',
      configThreshold: 0.6,
      referenceModels: [{ model: 'another-unknown' }, { model: 'yet-another' }],
      aggregatorModel: { model: 'agg-unknown' },
      baseBenefitThreshold: 0.15,
    });
    // 期望提升 = 0.35*0.4 + 差距(≈0) = 0.14，再摊薄后 < 0.15
    expect(d.netValue).toBeLessThan(0.15);
    expect(d.trigger).toBe(false);
  });

  it('/moa 强制场景由调用方绕过 decideMoa，不受收益门槛限制', () => {
    // decideMoa 本身返回 false，但调用方可结合 forceMoa 强制触发
    const d = decideMoa({
      complexity: { score: 0.2, reasons: [] },
      mainModel: 'gpt-4o',
      configThreshold: 0.6,
      referenceModels: [{ model: 'qwen3.6:27b' }, { model: 'qwen3.6:32b' }],
    });
    expect(d.trigger).toBe(false);
  });
});

// ============================================================================
// estimateMainModelStrength / estimateAggregateStrength
// ============================================================================
describe('estimateMainModelStrength', () => {
  it('远程旗舰模型为强', () => {
    expect(estimateMainModelStrength('gpt-4o')).toBeGreaterThan(0.8);
    expect(estimateMainModelStrength('claude-sonnet-4')).toBeGreaterThan(0.8);
  });
  it('远程中端模型中等偏强', () => {
    expect(estimateMainModelStrength('gpt-4o-mini')).toBe(0.7);
  });
  it('本地大参数模型中等', () => {
    expect(estimateMainModelStrength('qwen3.6:32b')).toBe(0.5);
  });
  it('本地小参数模型偏弱', () => {
    expect(estimateMainModelStrength('llama3.2:1b')).toBe(0.35);
  });
  it('未知模型中性', () => {
    expect(estimateMainModelStrength('unknown-model')).toBe(0.5);
  });
});

describe('estimateAggregateStrength', () => {
  it('强主模型 + 弱参与模型时聚合后能力受参与模型上限约束', () => {
    const agg = estimateAggregateStrength(0.85, [{ model: 'llama3.2:1b' }, { model: 'qwen2.5:1.5b' }]);
    expect(agg).toBeLessThan(0.85);
  });
  it('弱主模型 + 强参与模型时聚合后能力显著提升', () => {
    const agg = estimateAggregateStrength(0.35, [{ model: 'gpt-4o' }, { model: 'claude-sonnet-4' }]);
    expect(agg).toBeGreaterThan(0.5);
  });
});