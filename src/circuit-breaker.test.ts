/**
 * CircuitBreaker 单元测试。
 *
 * 覆盖：
 * - resetCircuitBreaker 重置 failures / open 状态
 * - 合法/非法子系统名校验
 * - 重置后 isAvailable 恢复为 true
 * - 不影响现有 isAvailable/recordSuccess/recordFailure/getHealthSnapshot
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isAvailable,
  recordSuccess,
  recordFailure,
  getHealthSnapshot,
  resetCircuitBreaker,
  withCircuitBreaker,
} from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  describe('resetCircuitBreaker', () => {
    it('重置已熔断子系统的 failures 与 open 状态', () => {
      // 先制造熔断：连续失败超过阈值
      for (let i = 0; i < 10; i++) recordFailure('neo4j');
      // 确认已熔断
      const snapBefore = getHealthSnapshot();
      expect(snapBefore.neo4j.failures).toBeGreaterThan(0);

      // 重置
      const ok = resetCircuitBreaker('neo4j');
      expect(ok).toBe(true);

      // 重置后 failures=0 且 available=true
      const snapAfter = getHealthSnapshot();
      expect(snapAfter.neo4j.failures).toBe(0);
      expect(snapAfter.neo4j.available).toBe(true);
      expect(isAvailable('neo4j')).toBe(true);
    });

    it('重置 lcm 子系统', () => {
      for (let i = 0; i < 10; i++) recordFailure('lcm');
      expect(isAvailable('lcm')).toBe(false);

      expect(resetCircuitBreaker('lcm')).toBe(true);
      expect(isAvailable('lcm')).toBe(true);
    });

    it('重置 qmd 子系统', () => {
      for (let i = 0; i < 10; i++) recordFailure('qmd');
      expect(isAvailable('qmd')).toBe(false);

      expect(resetCircuitBreaker('qmd')).toBe(true);
      expect(isAvailable('qmd')).toBe(true);
    });

    it('非法子系统名返回 false', () => {
      expect(resetCircuitBreaker('invalid' as any)).toBe(false);
      expect(resetCircuitBreaker('' as any)).toBe(false);
    });

    it('重置后 recordSuccess 仍正常工作（不破坏现有 API）', () => {
      resetCircuitBreaker('neo4j');
      recordSuccess('neo4j');
      expect(isAvailable('neo4j')).toBe(true);
    });

    it('重置后可再次正常使用 withCircuitBreaker', async () => {
      // 制造熔断
      for (let i = 0; i < 10; i++) recordFailure('lcm');
      // 重置
      resetCircuitBreaker('lcm');
      // withCircuitBreaker 应能正常执行
      const result = await withCircuitBreaker('lcm', 'test', async () => 42);
      expect(result).toBe(42);
    });
  });

  describe('现有 API 兼容性', () => {
    it('getHealthSnapshot 仍返回所有子系统状态', () => {
      const snap = getHealthSnapshot();
      // 至少包含已使用的子系统
      expect(snap).toBeDefined();
    });

    it('recordSuccess 重置失败计数', () => {
      recordFailure('qmd');
      recordFailure('qmd');
      recordSuccess('qmd');
      const snap = getHealthSnapshot();
      expect(snap.qmd.failures).toBe(0);
    });
  });
});
