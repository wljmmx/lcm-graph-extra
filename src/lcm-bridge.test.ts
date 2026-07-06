/**
 * R-5': detectScenarioAndAdjustLimits 单元测试。
 *
 * 覆盖：
 * - 7 个场景关键词匹配（bug-fix/config-debug/performance-opt/feature-dev/refactor/code-review/deployment）
 * - 4 类权重调整策略验证（比例正确、总量守恒）
 * - 高压力模式跳过调整（baseLimits.qmd<=1 && graph<=1）
 * - 默认场景（无关键词命中）
 * - 边界条件：空查询、多场景同时命中（选 maxScore）
 */
import { describe, it, expect } from 'vitest';
import { detectScenarioAndAdjustLimits } from './lcm-bridge.js';
import type { RetrievalLimits } from './lcm-bridge.js';

describe('detectScenarioAndAdjustLimits', () => {
  // 总量为 20 的基础限制，确保各比例调整后总量守恒
  const baseLimits: RetrievalLimits = { qmd: 10, graph: 6, exp: 4 };
  const totalBase = baseLimits.qmd + baseLimits.graph + baseLimits.exp; // 20

  describe('7 个场景关键词匹配', () => {
    it('bug-fix 场景', () => {
      const r = detectScenarioAndAdjustLimits('there is a bug and error in code', baseLimits);
      expect(r.scenario).toBe('bug-fix');
    });

    it('config-debug 场景', () => {
      const r = detectScenarioAndAdjustLimits('I need to check the config setting', baseLimits);
      expect(r.scenario).toBe('config-debug');
    });

    it('performance-opt 场景', () => {
      const r = detectScenarioAndAdjustLimits('the performance is slow need optimization', baseLimits);
      expect(r.scenario).toBe('performance-opt');
    });

    it('feature-dev 场景', () => {
      const r = detectScenarioAndAdjustLimits('implement a new feature for the app', baseLimits);
      expect(r.scenario).toBe('feature-dev');
    });

    it('refactor 场景', () => {
      const r = detectScenarioAndAdjustLimits('lets refactor this module', baseLimits);
      expect(r.scenario).toBe('refactor');
    });

    it('code-review 场景', () => {
      const r = detectScenarioAndAdjustLimits('please review and audit this code', baseLimits);
      expect(r.scenario).toBe('code-review');
    });

    it('deployment 场景', () => {
      const r = detectScenarioAndAdjustLimits('release via CI CD pipeline to production', baseLimits);
      expect(r.scenario).toBe('deployment');
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

  describe('默认场景（无关键词命中）', () => {
    it('无关键词命中返回 null 场景', () => {
      const r = detectScenarioAndAdjustLimits('hello world nothing matches here', baseLimits);
      expect(r.scenario).toBeNull();
      expect(r.limits).toEqual(baseLimits);
    });
  });

  describe('边界条件', () => {
    it('空查询返回 null 场景', () => {
      const r = detectScenarioAndAdjustLimits('', baseLimits);
      expect(r.scenario).toBeNull();
      expect(r.limits).toEqual(baseLimits);
    });

    it('仅空白字符查询返回 null 场景', () => {
      const r = detectScenarioAndAdjustLimits('   \n\t  ', baseLimits);
      expect(r.scenario).toBeNull();
      expect(r.limits).toEqual(baseLimits);
    });

    it('多场景同时命中选 maxScore', () => {
      // bug-fix=3, config-debug=2, performance-opt=2 → 选 bug-fix
      const r = detectScenarioAndAdjustLimits('bug error crash config setting perf slow', baseLimits);
      expect(r.scenario).toBe('bug-fix');
      // 验证使用了 bug-fix 的调整策略 (0.55/0.30/0.15)
      expect(r.limits.qmd).toBe(11);
      expect(r.limits.graph).toBe(6);
      expect(r.limits.exp).toBe(3);
    });

    it('多场景同分时选迭代顺序首个（config-debug 先于 deployment）', () => {
      // 'deploy' 同时匹配 config-debug(1) 和 deployment(1)，选 config-debug
      const r = detectScenarioAndAdjustLimits('deploy the service', baseLimits);
      expect(r.scenario).toBe('config-debug');
    });
  });
});
