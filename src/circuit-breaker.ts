/**
 * Circuit breaker — 生产加固: 熔断、重试、健康探测
 *
 * 用于包装对 lossless-claw / qmd / Neo4j 的调用。
 * 在连续失败 N 次后自动降级，一段时间后尝试恢复。
 */

import { DEFAULTS } from './config/defaults.js';

type Subsystem = "lcm" | "qmd" | "neo4j";

interface CircuitState {
  failures: number;
  lastFailureAt: number | null;
  halfOpenAt: number | null;
  open: boolean;
}

const state = new Map<Subsystem, CircuitState>();

// P2-3 H-16: 阈值/冷却期集中到 DEFAULTS.circuitBreaker
const CONFIG = {
  threshold: DEFAULTS.circuitBreaker.threshold,
  cooldownMs: DEFAULTS.circuitBreaker.cooldownMs,
  halfOpenTimeoutMs: DEFAULTS.circuitBreaker.halfOpenTimeoutMs,
};

function getState(name: Subsystem): CircuitState {
  if (!state.has(name)) {
    state.set(name, { failures: 0, lastFailureAt: null, halfOpenAt: null, open: false });
  }
  return state.get(name)!;
}

/**
 * 检查子系统是否可用。
 */
export function isAvailable(name: Subsystem): boolean {
  const s = getState(name);
  if (!s.open) return true;

  // 检查 cooldown 是否已过 → 转为半开
  if (s.halfOpenAt && Date.now() >= s.halfOpenAt) {
    s.open = false;
    s.halfOpenAt = null;
    return true;
  }

  // 如果 cooldown 已到但没有 halfOpenAt，设置 halfOpen 窗口
  if (s.lastFailureAt && Date.now() - s.lastFailureAt >= CONFIG.cooldownMs && !s.halfOpenAt) {
    s.halfOpenAt = Date.now() + CONFIG.halfOpenTimeoutMs;
    s.open = false;
    return true;
  }

  return false;
}

/**
 * 记录调用成功（重置失败计数）。
 */
export function recordSuccess(name: Subsystem): void {
  const s = getState(name);
  s.failures = 0;
  s.open = false;
  s.halfOpenAt = null;
  s.lastFailureAt = null;
}

/**
 * 记录调用失败（如果达到阈值则熔断）。
 */
export function recordFailure(name: Subsystem): void {
  const s = getState(name);
  s.failures++;
  s.lastFailureAt = Date.now();

  if (s.failures >= CONFIG.threshold) {
    s.open = true;
    s.halfOpenAt = Date.now() + CONFIG.cooldownMs;
  }
}

/**
 * 熔断包装: 自动重试 + 熔断保护。
 * 如果子系统已熔断，直接抛出（不浪费调用）。
 */
export async function withCircuitBreaker<T>(
  name: Subsystem,
  label: string,
  fn: () => Promise<T>,
  retries: number = 1,
): Promise<T> {
  if (!isAvailable(name)) {
    const s = getState(name);
    const retryAfter = s.halfOpenAt ? Math.max(0, s.halfOpenAt - Date.now()) : CONFIG.cooldownMs;
    throw new Error(`${label}: circuit breaker OPEN (retry in ${Math.ceil(retryAfter / 1000)}s)`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Backoff: 1s, 2s, 4s...
      const delay = 1000 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const result = await fn();
      recordSuccess(name);
      return result;
    } catch (err) {
      lastError = err;
      recordFailure(name);
    }
  }
  throw lastError;
}

/**
 * 获取所有子系统健康状态快照。
 */
export function getHealthSnapshot(): Record<string, { available: boolean; failures: number }> {
  const snap: Record<string, { available: boolean; failures: number }> = {};
  for (const [name, s] of state) {
    snap[name] = { available: isAvailable(name), failures: s.failures };
  }
  return snap;
}

/**
 * 重置指定子系统的熔断器状态：清零 failures、关闭 open、清除冷却窗口。
 * 供 dashboard lcmg_reset_breaker 工具手动恢复使用。
 *
 * @param name 子系统名（lcm | qmd | neo4j）
 * @returns 合法子系统返回 true，非法名返回 false
 */
export function resetCircuitBreaker(name: string): boolean {
  // 合法性校验：只允许已定义的子系统
  if (name !== 'lcm' && name !== 'qmd' && name !== 'neo4j') {
    return false;
  }
  const s = getState(name as Subsystem);
  s.failures = 0;
  s.open = false;
  s.halfOpenAt = null;
  s.lastFailureAt = null;
  return true;
}
