/**
 * lcm-graph-extra — Neo4j 连接池
 *
 * 全局单例连接池，按 (uri + user) 维度复用 driver 实例。
 * 引用计数管理生命周期：acquire() 加引用，release() 减引用。
 * 引用归零时自动关闭 driver。
 *
 * 彻底消除每创建一次 GraphAdapter 就要新建 driver 的连接泄漏风险。
 */

import type { Neo4jConfig } from '../types';
import { DEFAULTS } from '../config/defaults.js';

/** Driver 引用包 */
interface PoolEntry {
  driver: any;               // neo4j-driver Driver 实例
  refCount: number;
  lastUsed: number;          // 毫秒时间戳
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 全局连接池（单例）
// ---------------------------------------------------------------------------

const pool = new Map<string, PoolEntry>();

/** 生成连接池键值：uri + user */
function poolKey(uri: string, user: string): string {
  return `${uri}|${user}`;
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 获取 Neo4j driver 连接。
 * 如果已有复用连接则引用计数 +1，否则新建。
 *
 * @param config Neo4j 连接配置
 * @returns driver 实例
 */
export async function acquireDriver(config: Neo4jConfig): Promise<any> {
  const key = poolKey(config.uri, config.user || 'neo4j');
  const existing = pool.get(key);

  if (existing && existing.driver) {
    // 复用连接：先验证连通性，再引用 +1。
    // 修复前：直接返回 driver，不验证。若 driver 因 maxConnectionLifetime（30min）
    // 或 Neo4j 服务重启而失效，后续所有查询都会失败，且 health() 的
    // verifyConnectivity() 反复对同一过期 driver 调用，永远无法自动恢复。
    // 修复后：先 verifyConnectivity()，失败则关闭旧 driver、从池中移除、新建替换。
    try {
      await existing.driver.verifyConnectivity();
    } catch {
      // 旧 driver 已失效 → 关闭并从池中移除
      try {
        await existing.driver.close();
      } catch { /* ignore close errors */ }
      pool.delete(key);
      // 回退到新建连接逻辑
      return await acquireDriver(config);
    }
    existing.refCount++;
    existing.lastUsed = Date.now();
    return existing.driver;
  }

  // 新建连接
  const neo4j = await import('neo4j-driver');
  const driver = neo4j.default.driver(
    config.uri,
    neo4j.default.auth.basic(config.user || 'neo4j', config.password || ''),
    {
      maxConnectionLifetime: 30 * 60 * 1000,
      idleTimeBeforeConnectionTest: 30 * 1000,
      connectionAcquisitionTimeout: DEFAULTS.connectionPool.acquireTimeoutMs,
    },
  );

  // 验证连接
  try {
    await driver.verifyConnectivity();
  } catch (err) {
    await driver.close().catch(() => {});
    throw err;
  }

  const entry: PoolEntry = {
    driver,
    refCount: 1,
    lastUsed: Date.now(),
    createdAt: Date.now(),
  };
  pool.set(key, entry);

  return driver;
}

/**
 * 释放 driver 引用。引用计数归零时自动关闭底层连接。
 *
 * @param config 连接配置（用于查找池条目）
 */
export async function releaseDriver(config: Neo4jConfig): Promise<void> {
  const key = poolKey(config.uri, config.user || 'neo4j');
  const entry = pool.get(key);

  if (!entry) return;

  entry.refCount--;

  if (entry.refCount <= 0) {
    pool.delete(key);
    try {
      await entry.driver.close();
    } catch {
      // 关闭失败忽略
    }
  }
}

/**
 * 强制关闭所有连接池条目。
 * 仅在插件关闭/卸载时调用。
 */
export async function drainPool(): Promise<void> {
  for (const [key, entry] of pool.entries()) {
    pool.delete(key);
    try {
      await entry.driver.close();
    } catch {
      // 忽略
    }
  }
}

/**
 * 返回当前连接池统计信息（用于健康检查/调试）。
 */
export function getPoolStats(): Array<{
  uri: string;
  refCount: number;
  ageMs: number;
  idleMs: number;
}> {
  const now = Date.now();
  return Array.from(pool.entries()).map(([key, entry]) => {
    const [uri] = key.split('|');
    return {
      uri,
      refCount: entry.refCount,
      ageMs: now - entry.createdAt,
      idleMs: now - entry.lastUsed,
    };
  });
}
