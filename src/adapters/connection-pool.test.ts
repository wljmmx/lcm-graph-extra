/**
 * Neo4jConnectionPool 单元测试
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getPoolStats, drainPool } from './connection-pool';

describe('Neo4jConnectionPool', () => {
  // 清理连接池状态
  afterEach(async () => {
    await drainPool();
  });

  it('should have empty pool after drain', () => {
    const stats = getPoolStats();
    expect(stats).toEqual([]);
  });

  it('should report pool stats with zero entries initially', () => {
    const stats = getPoolStats();
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBe(0);
  });

  it('should handle drain on empty pool gracefully', async () => {
    await expect(drainPool()).resolves.toBeUndefined();
    const stats = getPoolStats();
    expect(stats.length).toBe(0);
  });
});
