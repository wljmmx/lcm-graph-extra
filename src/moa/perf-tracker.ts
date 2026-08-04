/**
 * MoA 性能追踪器
 *
 * 环形缓冲区存储最近 N 次 MoA 管道执行记录，供 Dashboard 查询。
 * 线程安全：所有操作在单线程 event loop 中执行，无需加锁。
 * 持久化：每次记录后写入 ~/.openclaw/moa-perf.json，Dashboard 服务读取。
 */

import type { MoaPipelineResult, LlmCallResult } from './types.js';
import { mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ============================================================================
// 类型定义
// ============================================================================

export interface MoaRunRecord {
  /** 运行 ID */
  id: string;
  /** 运行时间戳 */
  timestamp: number;
  /** 查询文本（截断至 200 字符） */
  queryPreview: string;
  /** 总耗时（ms） */
  totalMs: number;
  /** 参考模型阶段耗时（ms） */
  refMs: number;
  /** 聚合模型阶段耗时（ms） */
  aggMs: number;
  /** 总 Token 消耗 */
  totalTokens: number;
  /** 参考模型数 */
  refCount: number;
  /** 有效参考模型数（排除失败） */
  validRefCount: number;
  /** 各参考模型耗时（ms） */
  refTimings: number[];
  /** 各参考模型名称 */
  refModels: string[];
  /** 各参考模型 Token 消耗 */
  refTokens: number[];
  /** 聚合模型名称 */
  aggModel: string;
  /** 聚合模型 Token 消耗 */
  aggTokens: number;
  /** 响应长度 */
  responseLen: number;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
  /** 执行模式 */
  mode: string;
  /** 复杂度评分 */
  complexityScore?: number;
}

export interface MoaModelBreakdown {
  model: string;
  provider: string;
  runCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgTokens: number;
  totalTokens: number;
}

export interface MoaPerformanceSummary {
  /** 总运行次数 */
  totalRuns: number;
  /** 成功次数 */
  successRuns: number;
  /** 失败次数 */
  failedRuns: number;
  /** 平均总耗时（ms） */
  avgTotalMs: number;
  /** 平均参考阶段耗时（ms） */
  avgRefMs: number;
  /** 平均聚合阶段耗时（ms） */
  avgAggMs: number;
  /** 总 Token 消耗 */
  totalTokens: number;
  /** 平均 Token 消耗 */
  avgTokens: number;
  /** 最近运行记录 */
  recentRuns: MoaRunRecord[];
  // ===== v2.3.0: 增强指标 =====
  /** 延迟百分位 */
  latencyPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** 参考模型阶段延迟百分位 */
  refLatencyPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** 聚合模型阶段延迟百分位 */
  aggLatencyPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** Token 效率比（字符/Token，越高越高效） */
  tokenEfficiency: number;
  /** 平均响应长度 */
  avgResponseLen: number;
  /** 参考模型细粒度指标 */
  modelBreakdown: MoaModelBreakdown[];
  /** 错误类型分布 */
  errorBreakdown: Record<string, number>;
  /** 复杂度触发分布（分数区间统计） */
  complexityDistribution: {
    low: number;    // 0.0-0.4
    medium: number; // 0.4-0.7
    high: number;   // 0.7-1.0
  };
  /** 降级回退次数（MoA 触发但失败回退到普通流程） */
  fallbackCount: number;
  /** 平均复杂度评分 */
  avgComplexityScore: number;
  /** 复杂度评分百分位 */
  complexityPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** 最近 N 次复杂度评分历史（MoA 触发，用于趋势图） */
  complexityHistory: Array<{ timestamp: number; score: number }>;
  // ===== v2.4.0: 全量复杂度（所有 assemble 调用，含未触发 MoA 的） =====
  /** 全量复杂度分布（所有 assemble） */
  allComplexityDistribution: {
    low: number;
    medium: number;
    high: number;
  };
  /** 全量复杂度百分位 */
  allComplexityPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** 全量复杂度历史（最近 50 条，含时间戳） */
  allComplexityHistory: Array<{ timestamp: number; score: number }>;
  /** 按小时聚合的复杂度（最近 24 小时） */
  complexityHourlyBuckets: Array<{ hour: string; avg: number; count: number; min: number; max: number }>;
  /** 按天聚合的复杂度（最近 7 天） */
  complexityDailyBuckets: Array<{ date: string; avg: number; count: number; min: number; max: number }>;
}

// ============================================================================
// 环形缓冲区
// ============================================================================

const MAX_RECORDS = 50;
const runRecords: MoaRunRecord[] = [];

// ============================================================================
// 全量复杂度记录器（所有 assemble 调用，含未触发 MoA 的）
// ============================================================================

const MAX_ALL_COMPLEXITY = 50;
const allComplexityRecords: Array<{ timestamp: number; score: number }> = [];

/** 记录每次 assemble 的复杂度评分（无论是否触发 MoA） */
export function recordAllComplexity(score: number): void {
  allComplexityRecords.push({ timestamp: Date.now(), score });
  if (allComplexityRecords.length > MAX_ALL_COMPLEXITY) {
    allComplexityRecords.shift();
  }
  // H4: 新数据写入时清除缓存
  clearPerformanceCache();
  // 持久化全量复杂度数据，确保进程重启后不丢失
  // 使用节流避免高频写入：每 5 秒最多写一次
  persistThrottled();
}

/**
 * 记录一次 MoA 管道执行。
 */
export function recordMoaRun(
  query: string,
  result: MoaPipelineResult | null,
  error: string | null,
  config: { mode: string; referenceModels: Array<{ model: string; provider?: string }>; aggregatorModel: { model: string; provider?: string } },
  complexityScore?: number,
): void {
  const record: MoaRunRecord = {
    id: generateId(),
    timestamp: Date.now(),
    queryPreview: query.slice(0, 200),
    totalMs: result?.totalMs ?? 0,
    refMs: result ? result.referenceTimings.reduce((sum, t) => sum + t, 0) : 0,
    aggMs: result?.aggregatorTiming ?? 0,
    totalTokens: result?.estimatedTokens ?? 0,
    refCount: config.referenceModels.length,
    validRefCount: result?.referenceOutputs.length ?? 0,
    refTimings: result?.referenceTimings ?? [],
    refModels: config.referenceModels.map((r) => r.model),
    refTokens: [],
    aggModel: config.aggregatorModel.model,
    aggTokens: 0,
    responseLen: result?.finalResponse.length ?? 0,
    success: !!result && !error,
    error: error ?? undefined,
    mode: config.mode,
    complexityScore,
  };

  // 环形缓冲区
  runRecords.push(record);
  if (runRecords.length > MAX_RECORDS) {
    runRecords.shift();
  }

  // H4: 新数据写入时清除缓存，确保下次 getMoaPerformance() 返回最新结果
  clearPerformanceCache();

  // 异步持久化到文件（不阻塞管道）
  persistAsync();
}

// ============================================================================
// 时间分桶工具
// ============================================================================

function buildHourlyBuckets(
  records: Array<{ timestamp: number; score: number }>,
  hours: number,
): Array<{ hour: string; avg: number; count: number; min: number; max: number }> {
  const now = Date.now();
  const cutoff = now - hours * 3600_000;
  const buckets = new Map<string, number[]>();

  for (const r of records) {
    if (r.timestamp < cutoff) continue;
    const d = new Date(r.timestamp);
    const key = `${String(d.getHours()).padStart(2, '0')}:00`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r.score);
  }

  const result: Array<{ hour: string; avg: number; count: number; min: number; max: number }> = [];
  const currentHour = new Date().getHours();
  for (let i = hours - 1; i >= 0; i--) {
    const h = (currentHour - i + 24) % 24;
    const key = `${String(h).padStart(2, '0')}:00`;
    const scores = buckets.get(key) ?? [];
    result.push({
      hour: key,
      avg: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 1000) / 1000 : 0,
      count: scores.length,
      min: scores.length > 0 ? Math.round(Math.min(...scores) * 1000) / 1000 : 0,
      max: scores.length > 0 ? Math.round(Math.max(...scores) * 1000) / 1000 : 0,
    });
  }
  return result;
}

function buildDailyBuckets(
  records: Array<{ timestamp: number; score: number }>,
  days: number,
): Array<{ date: string; avg: number; count: number; min: number; max: number }> {
  const now = Date.now();
  const cutoff = now - days * 86_400_000;
  const buckets = new Map<string, number[]>();

  for (const r of records) {
    if (r.timestamp < cutoff) continue;
    const d = new Date(r.timestamp);
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r.score);
  }

  const result: Array<{ date: string; avg: number; count: number; min: number; max: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const scores = buckets.get(key) ?? [];
    result.push({
      date: key,
      avg: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 1000) / 1000 : 0,
      count: scores.length,
      min: scores.length > 0 ? Math.round(Math.min(...scores) * 1000) / 1000 : 0,
      max: scores.length > 0 ? Math.round(Math.max(...scores) * 1000) / 1000 : 0,
    });
  }
  return result;
}

/**
 * 获取 MoA 性能摘要（含增强指标）。
 *
 * H4: 添加 5 秒结果缓存，避免 persistAsync 和 API 端点高频调用时重复全量排序计算。
 * 清除缓存的条件：recordMoaRun / recordAllComplexity 写入新数据时。
 */
let performanceCache: { timestamp: number; data: MoaPerformanceSummary } | null = null;

function clearPerformanceCache(): void {
  performanceCache = null;
}

export function getMoaPerformance(): MoaPerformanceSummary {
  const now = Date.now();
  if (performanceCache && now - performanceCache.timestamp < 5000) {
    return performanceCache.data;
  }
  const successRecords = runRecords.filter((r) => r.success);
  const failedRecords = runRecords.filter((r) => !r.success);

  const allTimings = successRecords.map((r) => r.totalMs);
  const allRefTimings = successRecords.map((r) => r.refMs);
  const allAggTimings = successRecords.map((r) => r.aggMs);

  // 延迟百分位
  const latencyP = percentiles(allTimings);
  const refLatencyP = percentiles(allRefTimings);
  const aggLatencyP = percentiles(allAggTimings);

  // Token 效率比：总响应字符数 / 总 Token 数
  const totalResponseLen = successRecords.reduce((sum, r) => sum + r.responseLen, 0);
  const totalSuccessTokens = successRecords.reduce((sum, r) => sum + r.totalTokens, 0);
  const tokenEfficiency = totalSuccessTokens > 0
    ? Math.round((totalResponseLen / totalSuccessTokens) * 100) / 100
    : 0;

  // 平均响应长度
  const avgResponseLen = successRecords.length > 0
    ? Math.round(totalResponseLen / successRecords.length)
    : 0;

  // 模型细粒度指标
  const modelBreakdown = buildModelBreakdown();

  // 错误类型分布
  const errorBreakdown: Record<string, number> = {};
  for (const r of failedRecords) {
    const errType = classifyError(r.error);
    errorBreakdown[errType] = (errorBreakdown[errType] ?? 0) + 1;
  }

  // 复杂度触发分布
  const complexityDistribution = {
    low: 0,
    medium: 0,
    high: 0,
  };
  const complexityScores: number[] = [];
  for (const r of runRecords) {
    const score = r.complexityScore;
    if (score === undefined) continue;
    complexityScores.push(score);
    if (score < 0.4) complexityDistribution.low++;
    else if (score < 0.7) complexityDistribution.medium++;
    else complexityDistribution.high++;
  }

  // 复杂度评分统计
  const complexityP = percentiles(complexityScores);
  const avgComplexityScore = complexityScores.length > 0
    ? Math.round((complexityScores.reduce((a, b) => a + b, 0) / complexityScores.length) * 1000) / 1000
    : 0;

  // 复杂度历史（最近 20 条带评分的记录，按时间正序）
  const complexityHistory = runRecords
    .filter((r) => r.complexityScore !== undefined)
    .slice(-20)
    .map((r) => ({ timestamp: r.timestamp, score: r.complexityScore! }));

  // 全量复杂度统计（所有 assemble 调用，含未触发 MoA 的）
  const allScores = allComplexityRecords.map((r) => r.score);
  const allComplexityP = percentiles(allScores);
  const allComplexityDistribution = {
    low: 0,
    medium: 0,
    high: 0,
  };
  for (const s of allScores) {
    if (s < 0.4) allComplexityDistribution.low++;
    else if (s < 0.7) allComplexityDistribution.medium++;
    else allComplexityDistribution.high++;
  }
  const allComplexityHistory = [...allComplexityRecords].slice(-30);

  // 按小时聚合（最近 24 小时）
  const complexityHourlyBuckets = buildHourlyBuckets(allComplexityRecords, 24);

  // 按天聚合（最近 7 天）
  const complexityDailyBuckets = buildDailyBuckets(allComplexityRecords, 7);

  // 降级回退次数：MoA 触发但最终没有结果（失败）
  const fallbackCount = failedRecords.length;

  const result = {
    totalRuns: runRecords.length,
    successRuns: successRecords.length,
    failedRuns: failedRecords.length,
    avgTotalMs: avg(allTimings),
    avgRefMs: avg(allRefTimings),
    avgAggMs: avg(allAggTimings),
    totalTokens: successRecords.reduce((sum, r) => sum + r.totalTokens, 0),
    avgTokens: successRecords.length > 0
      ? Math.round(successRecords.reduce((sum, r) => sum + r.totalTokens, 0) / successRecords.length)
      : 0,
    recentRuns: [...runRecords].reverse().slice(0, 10),
    latencyPercentiles: { p50: latencyP.p50, p90: latencyP.p90, p95: latencyP.p95, p99: latencyP.p99 },
    refLatencyPercentiles: { p50: refLatencyP.p50, p90: refLatencyP.p90, p95: refLatencyP.p95, p99: refLatencyP.p99 },
    aggLatencyPercentiles: { p50: aggLatencyP.p50, p90: aggLatencyP.p90, p95: aggLatencyP.p95, p99: aggLatencyP.p99 },
    tokenEfficiency,
    avgResponseLen,
    modelBreakdown,
    errorBreakdown,
    complexityDistribution,
    fallbackCount,
    avgComplexityScore,
    complexityPercentiles: { p50: complexityP.p50, p90: complexityP.p90, p95: complexityP.p95, p99: complexityP.p99 },
    complexityHistory,
    allComplexityDistribution,
    allComplexityPercentiles: { p50: allComplexityP.p50, p90: allComplexityP.p90, p95: allComplexityP.p95, p99: allComplexityP.p99 },
    allComplexityHistory,
    complexityHourlyBuckets,
    complexityDailyBuckets,
  };

  performanceCache = { timestamp: Date.now(), data: result };
  return result;
}

/**
 * 构建模型级细粒度指标。
 */
function buildModelBreakdown(): MoaModelBreakdown[] {
  const modelMap = new Map<string, { provider: string; timings: number[]; tokens: number[]; success: boolean[] }>();

  for (const r of runRecords) {
    // 参考模型
    for (let i = 0; i < r.refModels.length; i++) {
      const key = `ref:${r.refModels[i]}`;
      if (!modelMap.has(key)) {
        modelMap.set(key, { provider: 'unknown', timings: [], tokens: [], success: [] });
      }
      const entry = modelMap.get(key)!;
      if (r.refTimings[i] !== undefined) entry.timings.push(r.refTimings[i]);
      if (r.refTokens[i] !== undefined) entry.tokens.push(r.refTokens[i]);
      entry.success.push(i < r.validRefCount);
    }
    // 聚合模型
    const aggKey = `agg:${r.aggModel}`;
    if (!modelMap.has(aggKey)) {
      modelMap.set(aggKey, { provider: 'unknown', timings: [], tokens: [], success: [] });
    }
    const aggEntry = modelMap.get(aggKey)!;
    aggEntry.timings.push(r.aggMs);
    aggEntry.tokens.push(r.aggTokens);
    aggEntry.success.push(r.success);
  }

  const breakdown: MoaModelBreakdown[] = [];
  for (const [key, data] of modelMap) {
    const role = key.startsWith('ref:') ? 'ref' : 'agg';
    const modelName = key.slice(4); // strip "ref:" or "agg:"
    const p = percentiles(data.timings);
    const totalToks = data.tokens.reduce((a, b) => a + b, 0);
    breakdown.push({
      model: modelName,
      provider: data.provider,
      runCount: data.timings.length,
      successCount: data.success.filter(Boolean).length,
      failureCount: data.success.filter((s) => !s).length,
      avgLatencyMs: avg(data.timings),
      p50LatencyMs: p.p50,
      p95LatencyMs: p.p95,
      avgTokens: data.tokens.length > 0 ? Math.round(totalToks / data.tokens.length) : 0,
      totalTokens: totalToks,
    });
  }

  return breakdown.sort((a, b) => b.runCount - a.runCount);
}

/**
 * 错误分类：将错误信息归类为简短类型标签。
 */
function classifyError(error?: string): string {
  if (!error) return 'unknown';
  const lower = error.toLowerCase();
  if (lower.includes('timeout')) return 'timeout';
  if (lower.includes('abort') || lower.includes('cancel')) return 'aborted';
  if (lower.includes('connect') || lower.includes('network') || lower.includes('econnrefused')) return 'connection';
  if (lower.includes('rate') || lower.includes('limit') || lower.includes('429')) return 'rate_limit';
  if (lower.includes('auth') || lower.includes('401') || lower.includes('403')) return 'auth_error';
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('404'))) return 'model_not_found';
  if (lower.includes('parse') || lower.includes('json') || lower.includes('syntax')) return 'parse_error';
  if (lower.includes('empty') || lower.includes('no result')) return 'empty_response';
  return 'other';
}

// ============================================================================
// 持久化
// ============================================================================

const PERF_FILE = join(homedir(), '.openclaw', 'moa-perf.json');

let lastPersistTime = 0;
const PERSIST_THROTTLE_MS = 5_000;

function persistThrottled(): void {
  const now = Date.now();
  if (now - lastPersistTime < PERSIST_THROTTLE_MS) return;
  lastPersistTime = now;
  persistAsync();
}

function persistAsync(): void {
  // H2: 使用 setImmediate + fs.promises.writeFile 异步写入，避免阻塞事件循环。
  // 修复前：writeFileSync 同步写入 + getMoaPerformance() 全量排序，高并发下阻塞管道。
  setImmediate(async () => {
    try {
      const dir = join(homedir(), '.openclaw');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await writeFile(PERF_FILE, JSON.stringify(getMoaPerformance(), null, 2), 'utf-8');
    } catch {
      // 静默失败，不影响主流程
    }
  });
}

export { PERF_FILE };

// ============================================================================
// 工具函数
// ============================================================================

function generateId(): string {
  // BUG-8: 使用 crypto.randomUUID() 替代 Math.random()，避免非加密安全随机数碰撞风险。
  return `moa-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function percentiles(arr: number[]): { p50: number; p90: number; p95: number; p99: number } {
  if (arr.length === 0) return { p50: 0, p90: 0, p95: 0, p99: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const getP = (p: number) => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  };
  return {
    p50: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99),
  };
}