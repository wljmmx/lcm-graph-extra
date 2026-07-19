/**
 * MoA 复杂度评估单元测试。
 *
 * 覆盖：
 * - computeTaskComplexity: 各维度打分、简单场景排除、压力层级控制
 * - 边界条件：空查询、不同长度、各种场景标签
 */
import { describe, it, expect } from 'vitest';
import { computeTaskComplexity } from './complexity.js';

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