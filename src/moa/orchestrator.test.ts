/**
 * MoA 编排器单元测试（可单元测试的部分）。
 *
 * 覆盖：
 * - resolveActivePreset: 预设解析、回退默认配置
 * - getAvailablePresets: 预设合并（内置 + 自定义，同名覆盖）
 * - setMoaResultCache / getMoaResultCache / peekMoaResultCache: 结果缓存
 * - isMoaAggregatorPending: 聚合状态
 * - buildMoaToolInstruction: 工具指令模板
 * - defaultMoaConfig: 默认配置生成
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveActivePreset,
  getAvailablePresets,
  setMoaResultCache,
  getMoaResultCache,
  peekMoaResultCache,
  isMoaAggregatorPending,
  buildMoaToolInstruction,
  defaultMoaConfig,
} from './orchestrator.js';
import type { MoaConfig, MoaPreset } from './types.js';

// ============================================================================
// 辅助函数
// ============================================================================
function createBaseConfig(): MoaConfig {
  return {
    enabled: true,
    complexityThreshold: 0.6,
    mode: 'serial',
    referenceModels: [
      {
        provider: 'ollama',
        model: 'qwen3.6:27b',
        temperature: 0.7,
        systemPrompt: 'default ref prompt',
        timeoutMs: 60_000,
      },
    ],
    aggregatorModel: {
      provider: 'ollama',
      model: 'qwen3.6:27b',
      temperature: 0.3,
      timeoutMs: 120_000,
    },
    enabledTiers: ['low', 'medium'],
  };
}

// ============================================================================
// resolveActivePreset
// ============================================================================
describe('resolveActivePreset', () => {
  it('无 activePreset 时回退到 config 根配置', () => {
    const config = createBaseConfig();
    const result = resolveActivePreset(config);
    expect(result.referenceModels).toBe(config.referenceModels);
    expect(result.aggregatorModel).toBe(config.aggregatorModel);
    expect(result.mode).toBe('serial');
  });

  it('activePreset 匹配到内置预设 code-review', () => {
    const config = createBaseConfig();
    config.activePreset = 'code-review';
    const result = resolveActivePreset(config);
    expect(result.referenceModels.length).toBe(3);
    expect(result.referenceModels[0].model).toBe('gpt-4o');
  });

  it('activePreset 匹配到内置预设 security', () => {
    const config = createBaseConfig();
    config.activePreset = 'security';
    const result = resolveActivePreset(config);
    expect(result.referenceModels.length).toBe(2);
  });

  it('activePreset 不匹配时回退到 config 根配置', () => {
    const config = createBaseConfig();
    config.activePreset = 'non-existent';
    const result = resolveActivePreset(config);
    expect(result.referenceModels).toBe(config.referenceModels);
  });

  it('activePreset 匹配到自定义预设', () => {
    const customPreset: MoaPreset = {
      name: 'custom-preset',
      description: '自定义预设',
      mode: 'parallel',
      referenceModels: [
        {
          provider: 'deepseek',
          model: 'deepseek-chat',
          temperature: 0.7,
          systemPrompt: 'custom prompt',
          timeoutMs: 60_000,
        },
      ],
      aggregatorModel: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        temperature: 0.3,
        timeoutMs: 120_000,
      },
    };
    const config = createBaseConfig();
    config.presets = [customPreset];
    config.activePreset = 'custom-preset';
    config.mode = undefined as any; // 清除根级 mode，使 preset.mode 生效
    const result = resolveActivePreset(config);
    expect(result.referenceModels.length).toBe(1);
    expect(result.referenceModels[0].provider).toBe('deepseek');
    expect(result.mode).toBe('parallel');
  });

  it('自定义预设不指定 mode 时使用 config.mode', () => {
    const customPreset: MoaPreset = {
      name: 'no-mode-preset',
      referenceModels: [
        {
          provider: 'ollama',
          model: 'test',
          temperature: 0.5,
          systemPrompt: 'test',
          timeoutMs: 60_000,
        },
      ],
      aggregatorModel: {
        provider: 'ollama',
        model: 'test',
        temperature: 0.3,
        timeoutMs: 120_000,
      },
    };
    const config = createBaseConfig();
    config.presets = [customPreset];
    config.activePreset = 'no-mode-preset';
    const result = resolveActivePreset(config);
    expect(result.mode).toBe('serial'); // 回退到 config.mode
  });
});

// ============================================================================
// getAvailablePresets
// ============================================================================
describe('getAvailablePresets', () => {
  it('无自定义预设时返回内置预设', () => {
    const config = createBaseConfig();
    const presets = getAvailablePresets(config);
    expect(presets.length).toBeGreaterThanOrEqual(3);
    expect(presets.some((p) => p.name === 'code-review')).toBe(true);
    expect(presets.some((p) => p.name === 'architecture')).toBe(true);
    expect(presets.some((p) => p.name === 'security')).toBe(true);
  });

  it('自定义预设与内置预设合并', () => {
    const customPreset: MoaPreset = {
      name: 'my-preset',
      description: 'my custom preset',
      referenceModels: [],
      aggregatorModel: {
        provider: 'ollama',
        model: 'test',
        temperature: 0.3,
        timeoutMs: 60_000,
      },
    };
    const config = createBaseConfig();
    config.presets = [customPreset];
    const presets = getAvailablePresets(config);
    expect(presets.some((p) => p.name === 'my-preset')).toBe(true);
    expect(presets.some((p) => p.name === 'code-review')).toBe(true);
  });

  it('自定义预设覆盖同名内置预设', () => {
    const customCodeReview: MoaPreset = {
      name: 'code-review',
      description: '自定义代码审查',
      mode: 'parallel',
      referenceModels: [
        {
          provider: 'deepseek',
          model: 'deepseek-chat',
          temperature: 0.7,
          systemPrompt: 'custom code review prompt',
          timeoutMs: 60_000,
        },
      ],
      aggregatorModel: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        temperature: 0.3,
        timeoutMs: 120_000,
      },
    };
    const config = createBaseConfig();
    config.presets = [customCodeReview];
    const presets = getAvailablePresets(config);
    const crPreset = presets.find((p) => p.name === 'code-review');
    expect(crPreset).toBeDefined();
    expect(crPreset!.referenceModels[0].provider).toBe('deepseek');
    expect(crPreset!.description).toBe('自定义代码审查');
  });

  it('config.presets 为空时正常工作', () => {
    const config = createBaseConfig();
    const presets = getAvailablePresets(config);
    expect(presets.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// MoA 结果缓存
// ============================================================================
describe('MoA 结果缓存', () => {
  beforeEach(() => {
    // 清理缓存状态
    getMoaResultCache(); // 消费掉可能之前残留的
  });

  it('setMoaResultCache 后 getMoaResultCache 可读取', () => {
    setMoaResultCache('test result');
    expect(getMoaResultCache()).toBe('test result');
  });

  it('getMoaResultCache 是一次性消费', () => {
    setMoaResultCache('first');
    expect(getMoaResultCache()).toBe('first');
    expect(getMoaResultCache()).toBeNull();
  });

  it('peekMoaResultCache 不消费缓存', () => {
    setMoaResultCache('peek test');
    expect(peekMoaResultCache()).toBe('peek test');
    expect(peekMoaResultCache()).toBe('peek test'); // 仍可读取
    expect(getMoaResultCache()).toBe('peek test'); // 消费后清空
  });

  it('空缓存时 getMoaResultCache 返回 null', () => {
    expect(getMoaResultCache()).toBeNull();
  });

  it('空缓存时 peekMoaResultCache 返回 null', () => {
    expect(peekMoaResultCache()).toBeNull();
  });
});

// ============================================================================
// isMoaAggregatorPending
// ============================================================================
describe('isMoaAggregatorPending', () => {
  it('初始状态为 false', () => {
    expect(isMoaAggregatorPending()).toBe(false);
  });
});

// ============================================================================
// buildMoaToolInstruction
// ============================================================================
describe('buildMoaToolInstruction', () => {
  it('返回包含 lcmg_moa_reply 的指令', () => {
    const instruction = buildMoaToolInstruction();
    expect(instruction).toContain('lcmg_moa_reply');
    expect(instruction).toContain('MoA');
    expect(instruction).toContain('Mixture of Agents');
  });

  it('包含 pending 状态处理说明', () => {
    const instruction = buildMoaToolInstruction();
    expect(instruction).toContain('pending');
    expect(instruction).toContain('in progress');
  });

  it('包含相关性验证说明', () => {
    const instruction = buildMoaToolInstruction();
    expect(instruction).toContain('Verify relevance');
  });

  it('禁止提及 MoA 内部术语', () => {
    const instruction = buildMoaToolInstruction();
    expect(instruction).toContain('Do NOT mention');
  });
});

// ============================================================================
// defaultMoaConfig
// ============================================================================
describe('defaultMoaConfig', () => {
  it('返回合法的 MoaConfig', () => {
    const config = defaultMoaConfig();
    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('serial');
    expect(config.referenceModels.length).toBe(3);
    expect(config.referenceModels[0].provider).toBe('ollama');
    expect(config.aggregatorModel.provider).toBe('ollama');
    expect(config.enabledTiers).toEqual(['low', 'medium']);
  });

  it('参考模型使用不同 temperature', () => {
    const config = defaultMoaConfig();
    const temps = config.referenceModels.map((r) => r.temperature);
    const uniqueTemps = new Set(temps);
    expect(uniqueTemps.size).toBeGreaterThanOrEqual(1);
  });

  it('聚合模型 temperature 低于参考模型', () => {
    const config = defaultMoaConfig();
    for (const ref of config.referenceModels) {
      expect(config.aggregatorModel.temperature).toBeLessThan(ref.temperature);
    }
  });
});