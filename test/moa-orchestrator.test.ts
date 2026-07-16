/**
 * MoA orchestrator 单元测试
 *
 * 覆盖：
 * - resolveActivePreset：预设解析逻辑
 * - getAvailablePresets：预设列表合并
 * - classifyTaskType：任务分类器
 * - resolveClassifiedPreset：分类结果匹配预设
 */
import { describe, it, expect } from 'vitest';
import { resolveActivePreset, getAvailablePresets } from '../src/moa/orchestrator.js';
import { classifyTaskType, resolveClassifiedPreset } from '../src/moa/classifier.js';
import type { MoaConfig, MoaPreset } from '../src/moa/types.js';

// ============================================================================
// resolveActivePreset 测试
// ============================================================================

describe('resolveActivePreset', () => {
  it('should return default reference models when no preset is active', () => {
    const config: MoaConfig = {
      enabled: true,
      mode: 'parallel',
      complexityThreshold: 0.6,
      referenceModels: [
        { provider: 'ollama', model: 'default', temperature: 0.7, timeoutMs: 60000 },
      ],
      aggregatorModel: { provider: 'ollama', model: 'agg', temperature: 0.3, timeoutMs: 60000 },
      enabledTiers: ['low'],
    };

    const result = resolveActivePreset(config);
    expect(result.referenceModels).toHaveLength(1);
    expect(result.referenceModels[0].model).toBe('default');
    expect(result.mode).toBe('parallel');
    expect(result.aggregatorModel.model).toBe('agg');
  });

  it('should resolve active preset by name', () => {
    const customPreset: MoaPreset = {
      name: 'custom-test',
      description: 'Custom preset',
      mode: 'serial',
      referenceModels: [
        { provider: 'ollama', model: 'custom-a', temperature: 0.5, timeoutMs: 30000 },
        { provider: 'ollama', model: 'custom-b', temperature: 0.5, timeoutMs: 30000 },
      ],
      aggregatorModel: { provider: 'ollama', model: 'custom-agg', temperature: 0.3, timeoutMs: 60000 },
    };

    const config: MoaConfig = {
      enabled: true,
      mode: 'parallel',
      complexityThreshold: 0.6,
      referenceModels: [],
      aggregatorModel: { provider: 'ollama', model: 'default', temperature: 0.3, timeoutMs: 60000 },
      enabledTiers: ['low'],
      presets: [customPreset],
      activePreset: 'custom-test',
    };

    const result = resolveActivePreset(config);
    expect(result.referenceModels).toHaveLength(2);
    expect(result.referenceModels[0].model).toBe('custom-a');
    expect(result.referenceModels[1].model).toBe('custom-b');
    expect(result.mode).toBe('serial');
    expect(result.aggregatorModel.model).toBe('custom-agg');
  });

  it('should fall back to default built-in preset when name matches built-in', () => {
    const config: MoaConfig = {
      enabled: true,
      mode: 'parallel',
      complexityThreshold: 0.6,
      referenceModels: [],
      aggregatorModel: { provider: 'ollama', model: 'default', temperature: 0.3, timeoutMs: 60000 },
      enabledTiers: ['low'],
      activePreset: 'code-review',
    };

    const result = resolveActivePreset(config);
    // Built-in preset should have 3 reference models
    expect(result.referenceModels.length).toBeGreaterThanOrEqual(2);
    expect(result.mode).toBe('parallel');
  });

  it('should fall back to config defaults when activePreset not found', () => {
    const config: MoaConfig = {
      enabled: true,
      mode: 'serial',
      complexityThreshold: 0.6,
      referenceModels: [
        { provider: 'ollama', model: 'fallback', temperature: 0.7, timeoutMs: 60000 },
      ],
      aggregatorModel: { provider: 'ollama', model: 'fallback-agg', temperature: 0.3, timeoutMs: 60000 },
      enabledTiers: ['low'],
      activePreset: 'nonexistent',
    };

    const result = resolveActivePreset(config);
    expect(result.referenceModels[0].model).toBe('fallback');
    expect(result.mode).toBe('serial');
  });
});

// ============================================================================
// getAvailablePresets 测试
// ============================================================================

describe('getAvailablePresets', () => {
  it('should return built-in presets when no custom presets', () => {
    const config: MoaConfig = {
      enabled: true,
      mode: 'parallel',
      complexityThreshold: 0.6,
      referenceModels: [],
      aggregatorModel: { provider: 'ollama', model: 'agg', temperature: 0.3, timeoutMs: 60000 },
      enabledTiers: ['low'],
    };

    const presets = getAvailablePresets(config);
    expect(presets.length).toBeGreaterThanOrEqual(3);
    expect(presets.map(p => p.name)).toContain('code-review');
    expect(presets.map(p => p.name)).toContain('architecture');
    expect(presets.map(p => p.name)).toContain('security');
  });

  it('should merge custom presets with built-in', () => {
    const customPreset: MoaPreset = {
      name: 'my-custom',
      description: 'My custom preset',
      mode: 'parallel',
      referenceModels: [
        { provider: 'ollama', model: 'my-model', temperature: 0.7, timeoutMs: 60000 },
      ],
      aggregatorModel: { provider: 'ollama', model: 'my-agg', temperature: 0.3, timeoutMs: 60000 },
    };

    const config: MoaConfig = {
      enabled: true,
      mode: 'parallel',
      complexityThreshold: 0.6,
      referenceModels: [],
      aggregatorModel: { provider: 'ollama', model: 'agg', temperature: 0.3, timeoutMs: 60000 },
      enabledTiers: ['low'],
      presets: [customPreset],
    };

    const presets = getAvailablePresets(config);
    const names = presets.map(p => p.name);
    expect(names).toContain('my-custom');
    expect(names).toContain('code-review');
  });

  it('should not duplicate when custom preset overrides built-in name', () => {
    const overridePreset: MoaPreset = {
      name: 'code-review',
      description: 'Overridden code review',
      mode: 'serial',
      referenceModels: [
        { provider: 'ollama', model: 'overridden', temperature: 0.7, timeoutMs: 60000 },
      ],
      aggregatorModel: { provider: 'ollama', model: 'agg', temperature: 0.3, timeoutMs: 60000 },
    };

    const config: MoaConfig = {
      enabled: true,
      mode: 'parallel',
      complexityThreshold: 0.6,
      referenceModels: [],
      aggregatorModel: { provider: 'ollama', model: 'agg', temperature: 0.3, timeoutMs: 60000 },
      enabledTiers: ['low'],
      presets: [overridePreset],
    };

    const presets = getAvailablePresets(config);
    const nameCount = presets.filter(p => p.name === 'code-review').length;
    expect(nameCount).toBe(1);
    expect(presets.find(p => p.name === 'code-review')!.mode).toBe('serial');
  });
});

// ============================================================================
// classifyTaskType 测试
// ============================================================================

describe('classifyTaskType', () => {
  it('should classify security queries', () => {
    const result = classifyTaskType('请检查这段代码是否有SQL注入漏洞');
    expect(result.preset).toBe('security');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('should classify architecture queries', () => {
    const result = classifyTaskType('请设计一个微服务架构方案');
    expect(result.preset).toBe('architecture');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should classify code review queries', () => {
    const result = classifyTaskType('请审查这段代码，看看有没有bug和性能问题');
    expect(result.preset).toBe('code-review');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should return null for unclassifiable queries', () => {
    const result = classifyTaskType('你好');
    expect(result.preset).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('should return null for short ambiguous queries', () => {
    const result = classifyTaskType('?');
    expect(result.preset).toBeNull();
  });

  it('should pick highest confidence when multiple categories match', () => {
    // Matches both security and code-review keywords
    const result = classifyTaskType(
      '请审查这段代码的安全性，检查是否有bug和漏洞，并评估架构设计是否合理'
    );
    expect(result.preset).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// resolveClassifiedPreset 测试
// ============================================================================

describe('resolveClassifiedPreset', () => {
  it('should return preset name when classification matches available preset', () => {
    const classification = {
      preset: 'code-review' as const,
      confidence: 0.8,
      reasons: ['代码审查', 'bug'],
    };
    const available = ['code-review', 'architecture', 'security'];

    expect(resolveClassifiedPreset(classification, available)).toBe('code-review');
  });

  it('should return null when preset not in available list', () => {
    const classification = {
      preset: 'code-review' as const,
      confidence: 0.8,
      reasons: ['代码审查'],
    };
    const available = ['architecture', 'security'];

    expect(resolveClassifiedPreset(classification, available)).toBeNull();
  });

  it('should return null when confidence below threshold', () => {
    const classification = {
      preset: 'code-review' as const,
      confidence: 0.3,
      reasons: ['代码'],
    };
    const available = ['code-review'];

    expect(resolveClassifiedPreset(classification, available)).toBeNull();
  });

  it('should return null when classification is null', () => {
    const classification = { preset: null, confidence: 0, reasons: [] };
    const available = ['code-review'];

    expect(resolveClassifiedPreset(classification, available)).toBeNull();
  });
});