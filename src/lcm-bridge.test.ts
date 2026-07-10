/**
 * C-3: detectScenarioAndAdjustLimits 单元测试（v2.2.0 加权关键词 + 置信度门控）。
 *
 * 覆盖：
 * - 8 个场景关键词匹配（bug-fix/config-debug/performance-opt/security-audit/code-review/deployment/feature-dev/refactor）
 * - 加权评分 + 置信度门控（threshold=0.5）
 * - 平局打破（score 相同时按 priority 排序）
 * - 4 类权重调整策略验证（比例正确、总量守恒）
 * - 高压力模式跳过调整（baseLimits.qmd<=1 && graph<=1）
 * - 默认场景（无关键词命中 / 低置信度）
 * - 边界条件：空查询
 */
import { describe, it, expect } from 'vitest';
import { detectScenarioAndAdjustLimits } from './lcm-bridge.js';
import type { RetrievalLimits } from './lcm-bridge.js';

describe('detectScenarioAndAdjustLimits', () => {
  // 总量为 20 的基础限制，确保各比例调整后总量守恒
  const baseLimits: RetrievalLimits = { qmd: 10, graph: 6, exp: 4 };
  const totalBase = baseLimits.qmd + baseLimits.graph + baseLimits.exp; // 20

  describe('8 个场景关键词匹配', () => {
    it('bug-fix 场景 (crash 强信号)', () => {
      const r = detectScenarioAndAdjustLimits('there is a bug and error and crash in code', baseLimits);
      expect(r.scenario).toBe('bug-fix');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('config-debug 场景', () => {
      const r = detectScenarioAndAdjustLimits('I need to check the config setting', baseLimits);
      expect(r.scenario).toBe('config-debug');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('performance-opt 场景', () => {
      const r = detectScenarioAndAdjustLimits('the performance is slow need optimization', baseLimits);
      expect(r.scenario).toBe('performance-opt');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('feature-dev 场景', () => {
      const r = detectScenarioAndAdjustLimits('implement a new feature for the app', baseLimits);
      expect(r.scenario).toBe('feature-dev');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('refactor 场景', () => {
      const r = detectScenarioAndAdjustLimits('lets refactor this module', baseLimits);
      expect(r.scenario).toBe('refactor');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('code-review 场景', () => {
      const r = detectScenarioAndAdjustLimits('please review and audit this code', baseLimits);
      expect(r.scenario).toBe('code-review');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('deployment 场景', () => {
      const r = detectScenarioAndAdjustLimits('release via CI CD pipeline to production', baseLimits);
      expect(r.scenario).toBe('deployment');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('security-audit 独立分类 (C-3 新增)', () => {
      const r = detectScenarioAndAdjustLimits('check SQL injection vulnerability and security', baseLimits);
      expect(r.scenario).toBe('security-audit');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      // C-3: 安全审计 QMD 权重应高于 code-review
      expect(r.limits.qmd).toBeGreaterThanOrEqual(r.limits.exp);
    });
  });

  describe('4 类权重调整策略', () => {
    it('bug-fix: QMD↑ Graph→ Exp↓ (0.55/0.30/0.15)', () => {
      const r = detectScenarioAndAdjustLimits('bug error crash', baseLimits);
      expect(r.scenario).toBe('bug-fix');
      expect(r.limits.qmd).toBe(Math.round(totalBase * 0.55)); // 11
      expect(r.limits.graph).toBe(Math.round(totalBase * 0.30)); // 6
      expect(r.limits.exp).toBe(Math.round(totalBase * 0.15)); // 3
      // 总量守恒
      const total = r.limits.qmd + r.limits.graph + r.limits.exp;
      expect(total).toBe(totalBase);
    });

    it('feature-dev: QMD→ Graph↑ Exp→ (0.40/0.45/0.15)', () => {
      const r = detectScenarioAndAdjustLimits('implement new feature', baseLimits);
      expect(r.scenario).toBe('feature-dev');
      expect(r.limits.qmd).toBe(Math.round(totalBase * 0.40)); // 8
      expect(r.limits.graph).toBe(Math.round(totalBase * 0.45)); // 9
      expect(r.limits.exp).toBe(Math.round(totalBase * 0.15)); // 3
      const total = r.limits.qmd + r.limits.graph + r.limits.exp;
      expect(total).toBe(totalBase);
    });

    it('code-review: QMD↓ Graph↓ Exp↑ (0.30/0.30/0.40)', () => {
      const r = detectScenarioAndAdjustLimits('review audit check', baseLimits);
      expect(r.scenario).toBe('code-review');
      expect(r.limits.qmd).toBe(Math.round(totalBase * 0.30)); // 6
      expect(r.limits.graph).toBe(Math.round(totalBase * 0.30)); // 6
      expect(r.limits.exp).toBe(Math.round(totalBase * 0.40)); // 8
      const total = r.limits.qmd + r.limits.graph + r.limits.exp;
      expect(total).toBe(totalBase);
    });

    it('deployment: QMD↑ Graph↓ Exp→ (0.55/0.20/0.25)', () => {
      const r = detectScenarioAndAdjustLimits('release via CI CD pipeline', baseLimits);
      expect(r.scenario).toBe('deployment');
      expect(r.limits.qmd).toBe(Math.round(totalBase * 0.55)); // 11
      expect(r.limits.graph).toBe(Math.round(totalBase * 0.20)); // 4
      expect(r.limits.exp).toBe(Math.round(totalBase * 0.25)); // 5
      const total = r.limits.qmd + r.limits.graph + r.limits.exp;
      expect(total).toBe(totalBase);
    });

    it('security-audit: QMD↑ Graph↓ Exp→ (0.50/0.20/0.30)', () => {
      const r = detectScenarioAndAdjustLimits('security vulnerability injection', baseLimits);
      expect(r.scenario).toBe('security-audit');
      expect(r.limits.qmd).toBe(Math.round(totalBase * 0.50)); // 10
      expect(r.limits.graph).toBe(Math.round(totalBase * 0.20)); // 4
      expect(r.limits.exp).toBe(Math.round(totalBase * 0.30)); // 6
      const total = r.limits.qmd + r.limits.graph + r.limits.exp;
      expect(total).toBe(totalBase);
    });
  });

  describe('高压力模式跳过调整', () => {
    it('baseLimits.qmd<=1 && graph<=1 时不调整限制', () => {
      const highPressureLimits: RetrievalLimits = { qmd: 1, graph: 1, exp: 1 };
      const r = detectScenarioAndAdjustLimits('bug error crash', highPressureLimits);
      expect(r.scenario).toBe('bug-fix');
      // 限制保持不变
      expect(r.limits).toEqual(highPressureLimits);
    });

    it('qmd>1 时仍会调整（不满足高压力条件）', () => {
      const limits: RetrievalLimits = { qmd: 3, graph: 1, exp: 1 };
      const r = detectScenarioAndAdjustLimits('bug error crash', limits);
      expect(r.scenario).toBe('bug-fix');
      // qmd=3 > 1，应调整，limits 与 base 不同
      expect(r.limits).not.toEqual(limits);
    });
  });

  describe('默认场景（无关键词命中 / 低置信度）', () => {
    it('无关键词命中返回 null 场景', () => {
      const r = detectScenarioAndAdjustLimits('hello world nothing matches here', baseLimits);
      expect(r.scenario).toBeNull();
      expect(r.limits).toEqual(baseLimits);
      expect(r.confidence).toBeLessThan(0.5);
    });

    it('C-3: 弱信号词单独命中不触发分类（低于置信度阈值）', () => {
      // "error" 权重仅 0.3，低于 0.5 阈值
      const r = detectScenarioAndAdjustLimits('just a minor error message', baseLimits);
      expect(r.scenario).toBeNull();
      expect(r.confidence).toBeLessThan(0.5);
    });
  });

  describe('边界条件', () => {
    it('空查询返回 null 场景', () => {
      const r = detectScenarioAndAdjustLimits('', baseLimits);
      expect(r.scenario).toBeNull();
      expect(r.limits).toEqual(baseLimits);
      expect(r.confidence).toBe(0);
    });

    it('仅空白字符查询返回 null 场景', () => {
      const r = detectScenarioAndAdjustLimits('   \n\t  ', baseLimits);
      expect(r.scenario).toBeNull();
      expect(r.limits).toEqual(baseLimits);
      expect(r.confidence).toBe(0);
    });

    it('多场景同时命中选最高 score', () => {
      // bug-fix: bug(0.6) + error(0.3) + crash(1.0) = 1.9
      // config-debug: config(0.6) + setting(0.6) = 1.2
      // performance-opt: perf(0.6) + slow(0.6) = 1.2
      // → 选 bug-fix (1.9)
      const r = detectScenarioAndAdjustLimits('bug error crash config setting perf slow', baseLimits);
      expect(r.scenario).toBe('bug-fix');
      // 验证使用了 bug-fix 的调整策略 (0.55/0.30/0.15)
      expect(r.limits.qmd).toBe(11);
      expect(r.limits.graph).toBe(6);
      expect(r.limits.exp).toBe(3);
    });

    it('C-3: 同分时按 priority 排序（config-debug 先于 deployment）', () => {
      // 'deploy' 同时匹配 config-debug(0.6) 和 deployment(0.6)，同分
      // config-debug priority=2 < deployment priority=6 → config-debug 胜出
      const r = detectScenarioAndAdjustLimits('deploy the service', baseLimits);
      expect(r.scenario).toBe('config-debug');
    });
  });

  describe('C-3: confidence 字段验证', () => {
    it('返回对象包含 confidence 字段', () => {
      const r = detectScenarioAndAdjustLimits('crash bug error', baseLimits);
      expect(r).toHaveProperty('confidence');
      expect(typeof r.confidence).toBe('number');
    });

    it('强信号词产生高置信度', () => {
      const r = detectScenarioAndAdjustLimits('crash segfault panic fatal', baseLimits);
      expect(r.scenario).toBe('bug-fix');
      expect(r.confidence).toBeGreaterThanOrEqual(1.0);
    });

    it('无匹配时 confidence 为 0', () => {
      const r = detectScenarioAndAdjustLimits('hello world', baseLimits);
      expect(r.confidence).toBe(0);
    });
  });
});
