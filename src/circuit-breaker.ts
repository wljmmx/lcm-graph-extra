/**
 * Circuit breaker — 生产加固: 熔断、重试、健康探测
 *
 * 用于包装对 lossless-claw / qmd / Neo4j 的调用。
 * 在连续失败 N 次后自动降级，一段时间后尝试恢复。
 */

import { DEFAULTS } from './config/defaults.js';

// P1-8: "lcm" 子系统为死注册 —— 生产代码无 withCircuitBreaker("lcm", ...) 调用点，
// 仅 circuit-breaker.test.ts 和 health_metrics 表 schema（cb_lcm_ok/cb_lcm_fails）引用。
// 保留类型定义以兼容 DB schema 与 dashboard reset_breaker 工具，实际熔断保护未生效。
type Subsystem = "lcm" | "qmd" | "neo4j";

interface CircuitState {
  failures: number;
  lastFailureAt: number | null;
  halfOpenAt: number | null;
  open: boolean;
  /** P-CB-1: 半开窗口内已有探测请求在途，其余请求继续熔断防雪崩 */
  halfOpenProbeInFlight: boolean;
  /** P-CB-1: 探测请求开始时间，超时后自动释放（防探测 hang 导致永久阻塞） */
  halfOpenProbeStartedAt: number | null;
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
    state.set(name, {
      failures: 0,
      lastFailureAt: null,
      halfOpenAt: null,
      open: false,
      halfOpenProbeInFlight: false,
      halfOpenProbeStartedAt: null,
    });
  }
  return state.get(name)!;
}

/**
 * P-CB-1: 释放半开探测锁。
 * 探测超时（halfOpenTimeoutMs）后自动释放，防止单个探测 hang 导致永久阻塞。
 */
function releaseStaleProbe(s: CircuitState): void {
  if (s.halfOpenProbeInFlight && s.halfOpenProbeStartedAt) {
    if (Date.now() - s.halfOpenProbeStartedAt >= CONFIG.halfOpenTimeoutMs) {
      s.halfOpenProbeInFlight = false;
      s.halfOpenProbeStartedAt = null;
    }
  }
}

/**
 * 检查子系统是否可用。
 *
 * P-CB-1: 半开窗口内仅放行一个探测请求，其余请求继续返回熔断。
 * 标准熔断器模式：HALF_OPEN 状态下只允许 1 个请求探测服务是否恢复，
 * 避免高并发场景下大量请求涌入全部失败导致故障雪崩。
 *
 * P-CB-2: 统一冷却逻辑为单一时间源。
 * halfOpenAt 在 recordFailure 中设置为 Date.now() + cooldownMs，
 * 语义为"cooldown 到期时间"。fallback 到 lastFailureAt + cooldownMs
 * 仅为防御异常状态（open=true 但 halfOpenAt=null）。
 */
export function isAvailable(name: Subsystem): boolean {
  const s = getState(name);
  if (!s.open) return true;

  releaseStaleProbe(s);

  // P-CB-2: 统一冷却检查，单一时间源 halfOpenAt（fallback 到 lastFailureAt）
  const cooldownDeadline = s.halfOpenAt
    ?? (s.lastFailureAt ? s.lastFailureAt + CONFIG.cooldownMs : null);

  if (cooldownDeadline !== null && Date.now() >= cooldownDeadline) {
    // P-CB-1: 半开窗口内仅放行一个探测请求
    if (s.halfOpenProbeInFlight) {
      return false;
    }
    s.open = false;
    s.halfOpenAt = null;
    s.halfOpenProbeInFlight = true;
    s.halfOpenProbeStartedAt = Date.now();
    return true;
  }

  return false;
}

/**
 * 记录调用成功（重置失败计数）。
 *
 * P-CB-1: 探测成功 → 清除半开探测锁，完全恢复到 CLOSED。
 */
export function recordSuccess(name: Subsystem): void {
  const s = getState(name);
  s.failures = 0;
  s.open = false;
  s.halfOpenAt = null;
  s.lastFailureAt = null;
  s.halfOpenProbeInFlight = false;
  s.halfOpenProbeStartedAt = null;
}

/**
 * 记录调用失败（如果达到阈值则熔断）。
 *
 * P-CB-1: 探测失败 → 清除半开探测锁，允许下次 cooldown 后重新探测。
 * P-CB-3: failures 计数上限为 threshold*2，防止半开窗口内大量请求
 * 全部失败导致计数无界增长（诊断失真 + reset 后可能立即再次熔断）。
 */
export function recordFailure(name: Subsystem): void {
  const s = getState(name);
  // P-CB-3: 限制 failures 上限为 threshold*2，防止无界增长
  s.failures = Math.min(s.failures + 1, CONFIG.threshold * 2);
  s.lastFailureAt = Date.now();
  s.halfOpenProbeInFlight = false;
  s.halfOpenProbeStartedAt = null;

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
    // P-CB-2: 统一 retryAfter 计算，与 isAvailable 使用相同的 cooldownDeadline 逻辑
    const cooldownDeadline = s.halfOpenAt
      ?? (s.lastFailureAt ? s.lastFailureAt + CONFIG.cooldownMs : Date.now() + CONFIG.cooldownMs);
    const retryAfter = Math.max(0, cooldownDeadline - Date.now());
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
      // R-7: 仅对最终失败计数，避免单次网络抖动触发误熔断
      if (attempt < retries) {
        // 中间失败：仅记录日志，不增加 failure 计数
        // logger.debug?.(`[CB] ${label}: retry ${attempt + 1}/${retries + 1} failed, will retry`);
      }
    }
  }
  // R-7: 所有重试耗尽，计数最终失败
  recordFailure(name);
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
  s.halfOpenProbeInFlight = false;
  s.halfOpenProbeStartedAt = null;
  return true;
}

/**
 * M-2: 重置所有子系统的熔断器状态（供插件 dispose / 测试隔离使用）。
 * 模块级 state Map 在插件 dispose 后不会自动清空，
 * 热重载或测试复用进程时会残留旧的熔断状态（如测试中人为触发的 failure）。
 */
export function resetAllCircuitBreakers(): void {
  for (const [, s] of state) {
    s.failures = 0;
    s.open = false;
    s.halfOpenAt = null;
    s.lastFailureAt = null;
    s.halfOpenProbeInFlight = false;
    s.halfOpenProbeStartedAt = null;
  }
}
