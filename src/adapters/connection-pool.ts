/**
 * lcm-graph-extra — Neo4j 连接池
 *
 * 全局单例连接池，按 (uri + user) 维度复用 driver 实例。
 * 引用计数管理生命周期：acquire() 加引用，release() 减引用。
 * 引用归零时自动关闭 driver。
 *
 * 彻底消除每创建一次 GraphAdapter 就要新建 driver 的连接泄漏风险。
 *
 * v2.3.1 稳定性加固：
 * - 主动连接刷新：在 Neo4j driver 内置 maxConnectionLifetime（30min）到期前
 *   5 分钟主动关闭并重建连接，避免"session closed"断联错误。
 * - 将 driver 的 maxConnectionLifetime 提升至 35min，确保主动刷新在 driver
 *   内部关闭连接之前完成。
 */

import type { Neo4jConfig } from '../types';
import { DEFAULTS } from '../config/defaults.js';

/** 主动刷新阈值：在 Neo4j driver 内置超时前 5 分钟触发重建 */
const PROACTIVE_REFRESH_BEFORE_MS = 5 * 60 * 1000;
/** Neo4j driver 内置 maxConnectionLifetime（略高于主动刷新窗口，确保 driver 不会在我们之前关闭连接） */
const DRIVER_MAX_CONNECTION_LIFETIME_MS = 35 * 60 * 1000;
/** 主动刷新阈值：连接存活超过此时间则重建 */
const PROACTIVE_REFRESH_AGE_MS = DRIVER_MAX_CONNECTION_LIFETIME_MS - PROACTIVE_REFRESH_BEFORE_MS;

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
    // v2.3.1: 主动连接刷新 —— 在 Neo4j driver 内置 maxConnectionLifetime 到期前
    // 5 分钟主动关闭旧连接并重建，避免"session closed"断联错误。
    // 修复前：连接池复用不检查连接年龄，driver 在 30min 后内部关闭连接，
    // 导致 `this.driver.session()` 返回已关闭的 session，触发"session closed"错误。
    const ageMs = Date.now() - existing.createdAt;
    if (ageMs >= PROACTIVE_REFRESH_AGE_MS) {
      try {
        await existing.driver.close();
      } catch { /* ignore close errors */ }
      pool.delete(key);
      // 回退到新建连接
      return await acquireDriver(config);
    }

    // 复用连接：先验证连通性，再引用 +1。
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
      maxConnectionLifetime: DRIVER_MAX_CONNECTION_LIFETIME_MS,
      connectionLivenessCheckTimeout: 30 * 1000,
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
