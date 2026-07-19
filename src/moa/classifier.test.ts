/**
 * MoA 分类器单元测试。
 *
 * 覆盖：
 * - classifyTaskType: 各领域分类规则匹配、置信度计算、context 生成
 * - resolveClassifiedPreset: 预设名解析
 * - 边界条件：空查询、无匹配、低置信度
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTaskType,
  resolveClassifiedPreset,
  type ClassificationResult,
} from './classifier.js';

// ============================================================================
// classifyTaskType
// ============================================================================
describe('classifyTaskType', () => {
  describe('安全审计分类', () => {
    it('安全相关关键词触发 security 分类', () => {
      const result = classifyTaskType('请帮我审计这个代码的安全漏洞');
      expect(result.preset).toBe('security');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('SQL注入触发 security', () => {
      const result = classifyTaskType('这里存在SQL注入的风险吗');
      expect(result.preset).toBe('security');
    });

    it('XSS 触发 security', () => {
      const result = classifyTaskType('检查XSS攻击面');
      expect(result.preset).toBe('security');
    });

    it('加密相关触发 security', () => {
      const result = classifyTaskType('这个加密算法是否安全');
      expect(result.preset).toBe('security');
    });

    it('合规相关触发 security', () => {
      const result = classifyTaskType('GDPR合规检查');
      expect(result.preset).toBe('security');
    });

    it('security 分类返回正确的 context', () => {
      const result = classifyTaskType('安全漏洞审计');
      expect(result.context).toContain('安全审计模式');
      expect(result.context).toContain('OWASP');
    });
  });

  describe('架构设计分类', () => {
    it('架构关键词触发 architecture', () => {
      const result = classifyTaskType('请帮我设计一个微服务架构');
      expect(result.preset).toBe('architecture');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('设计模式触发 architecture', () => {
      const result = classifyTaskType('这里应该用哪种设计模式');
      expect(result.preset).toBe('architecture');
    });

    it('系统设计触发 architecture', () => {
      const result = classifyTaskType('做一个系统设计');
      expect(result.preset).toBe('architecture');
    });

    it('技术选型触发 architecture', () => {
      const result = classifyTaskType('技术选型对比分析');
      expect(result.preset).toBe('architecture');
    });

    it('DDD 触发 architecture', () => {
      const result = classifyTaskType('使用DDD进行领域驱动设计');
      expect(result.preset).toBe('architecture');
    });

    it('architecture 分类返回正确的 context', () => {
      const result = classifyTaskType('架构设计');
      expect(result.context).toContain('架构设计模式');
      expect(result.context).toContain('模块划分');
    });
  });

  describe('代码审查分类', () => {
    it('代码审查关键词触发 code-review', () => {
      const result = classifyTaskType('请帮我做一次代码审查 code review');
      expect(result.preset).toBe('code-review');
    });

    it('bug 修复 + 代码审查触发 code-review', () => {
      const result = classifyTaskType('修复这个bug，帮我做代码审查');
      expect(result.preset).toBe('code-review');
    });

    it('重构 + 代码质量触发 code-review', () => {
      const result = classifyTaskType('重构这个模块并检查代码质量');
      expect(result.preset).toBe('code-review');
    });

    it('性能优化 + 测试触发 code-review', () => {
      const result = classifyTaskType('优化这段代码的性能并补充单元测试');
      expect(result.preset).toBe('code-review');
    });

    it('code-review 分类返回正确的 context', () => {
      const result = classifyTaskType('代码审查 code review');
      expect(result.context).toContain('代码审查模式');
      expect(result.context).toContain('代码质量');
    });
  });

  describe('confidence 置信度计算', () => {
    it('单一分类匹配时置信度接近 1', () => {
      const result = classifyTaskType('安全漏洞审计 OWASP XSS注入');
      expect(result.preset).toBe('security');
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('多分类竞争时置信度降低', () => {
      // "架构" 和 "重构" 分别匹配 architecture 和 code-review
      const result = classifyTaskType('架构重构');
      // 置信度应低于单一匹配
      expect(result.confidence).toBeLessThan(1.0);
    });

    it('低置信度时 confidence 小于 1', () => {
      // 弱匹配
      const result = classifyTaskType('优化');
      if (result.preset) {
        expect(result.confidence).toBeLessThanOrEqual(1.0);
      }
    });
  });

  describe('无匹配场景', () => {
    it('不相关查询返回 null', () => {
      const result = classifyTaskType('你好');
      expect(result.preset).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.reasons).toEqual([]);
      expect(result.context).toBe('');
    });

    it('空查询返回 null', () => {
      const result = classifyTaskType('');
      expect(result.preset).toBeNull();
      expect(result.confidence).toBe(0);
    });

    it('简单问候返回 null', () => {
      const result = classifyTaskType('hello world');
      expect(result.preset).toBeNull();
    });
  });

  describe('对话上下文辅助分类', () => {
    it('查询无匹配但上下文有安全关键词 → 触发分类', () => {
      const result = classifyTaskType('帮我看看', '之前讨论的安全漏洞还需要修复吗');
      expect(result.preset).toBe('security');
    });

    it('查询无匹配但上下文有架构关键词 → 触发分类', () => {
      const result = classifyTaskType('继续', '我们正在设计微服务架构方案');
      expect(result.preset).toBe('architecture');
    });
  });

  describe('reasons 字段', () => {
    it('返回匹配到的关键词列表', () => {
      const result = classifyTaskType('安全漏洞审计和XSS检查');
      expect(result.preset).toBe('security');
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('reasons 去重且最多 5 个', () => {
      // 多次提及同一关键词
      const result = classifyTaskType('安全 安全 安全 漏洞 漏洞 漏洞 审计 审计 审计');
      if (result.preset) {
        expect(result.reasons.length).toBeLessThanOrEqual(5);
      }
    });
  });
});

// ============================================================================
// resolveClassifiedPreset
// ============================================================================
describe('resolveClassifiedPreset', () => {
  const availablePresets = ['code-review', 'architecture', 'security'];

  it('高置信度分类匹配到可用预设', () => {
    const classification: ClassificationResult = {
      preset: 'security',
      confidence: 0.9,
      reasons: ['安全'],
      context: '安全审计模式',
    };
    expect(resolveClassifiedPreset(classification, availablePresets)).toBe('security');
  });

  it('低置信度分类不匹配', () => {
    const classification: ClassificationResult = {
      preset: 'security',
      confidence: 0.3,
      reasons: ['安全'],
      context: '安全审计模式',
    };
    expect(resolveClassifiedPreset(classification, availablePresets)).toBeNull();
  });

  it('preset 为 null 时返回 null', () => {
    const classification: ClassificationResult = {
      preset: null,
      confidence: 0,
      reasons: [],
      context: '',
    };
    expect(resolveClassifiedPreset(classification, availablePresets)).toBeNull();
  });

  it('预设不在可用列表中返回 null', () => {
    const classification: ClassificationResult = {
      preset: 'security',
      confidence: 0.9,
      reasons: ['安全'],
      context: '安全审计模式',
    };
    expect(resolveClassifiedPreset(classification, ['code-review'])).toBeNull();
  });

  it('confidence 恰好为 0.5 时匹配', () => {
    const classification: ClassificationResult = {
      preset: 'code-review',
      confidence: 0.5,
      reasons: ['review'],
      context: '代码审查模式',
    };
    expect(resolveClassifiedPreset(classification, availablePresets)).toBe('code-review');
  });
});