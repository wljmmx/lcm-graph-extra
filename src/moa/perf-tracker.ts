/**
 * MoA 性能追踪器
 *
 * 环形缓冲区存储最近 N 次 MoA 管道执行记录，供 Dashboard 查询。
 * 线程安全：所有操作在单线程 event loop 中执行，无需加锁。
 * 持久化：每次记录后写入 ~/.openclaw/moa-perf.json，Dashboard 服务读取。
 */

import type { MoaPipelineResult, LlmCallResult } from './types.js';
import { mkdirSync, existsSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { recordModelOutcome, recordTokenUsage } from './learning-model.js';

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
  /** 角色：ref=参考模型 / agg=聚合模型 */
  role: 'ref' | 'agg';
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
  task?: string,
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
    // v2.5.2: 使用 result 中的实际模型名和 token 数据，而非 config 中的配置名
    // （异步路径 config.referenceModels 可能为空，但 result.referenceModels 有值）
    refModels: result?.referenceModels ?? config.referenceModels.map((r) => r.model),
    refTokens: result?.referenceTokens ?? [],
    aggModel: config.aggregatorModel.model,
    aggTokens: result?.aggregatorTokens ?? 0,
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

  // 自适应学习：记录实际 token 消耗（优化点 3）与模型成败（优化点 1）
  // - token 学习：让成本预估随真实 token 量收敛，替代"相对单价"粗估
  // - 能力学习：让能力分档随实测可靠性校准，替代纯启发式
  if (result) {
    const refModels = result.referenceModels ?? [];
    const refTokens = result.referenceTokens ?? [];
    for (let i = 0; i < refModels.length; i++) {
      recordTokenUsage(refModels[i], 0, refTokens[i] ?? 0);
      recordModelOutcome(refModels[i], i < result.referenceOutputs.length, task);
    }
    if (config.aggregatorModel?.model) {
      recordTokenUsage(config.aggregatorModel.model, 0, result.aggregatorTokens ?? 0);
      recordModelOutcome(config.aggregatorModel.model, true, task);
    }
  } else {
    for (const r of config.referenceModels) {
      recordModelOutcome(r.model, false, task);
    }
    if (config.aggregatorModel?.model) {
      recordModelOutcome(config.aggregatorModel.model, false, task);
    }
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
  const modelMap = new Map<string, { role: 'ref' | 'agg'; provider: string; timings: number[]; tokens: number[]; success: boolean[] }>();

  for (const r of runRecords) {
    // 参考模型
    for (let i = 0; i < r.refModels.length; i++) {
      const key = `ref:${r.refModels[i]}`;
      if (!modelMap.has(key)) {
        modelMap.set(key, { role: 'ref', provider: 'unknown', timings: [], tokens: [], success: [] });
      }
      const entry = modelMap.get(key)!;
      if (r.refTimings[i] !== undefined) entry.timings.push(r.refTimings[i]);
      // v2.5.2: refTokens 现在有实际数据（从 result.referenceTokens 填充）
      if (r.refTokens[i] !== undefined) entry.tokens.push(r.refTokens[i]);
      entry.success.push(i < r.validRefCount);
    }
    // 聚合模型
    const aggKey = `agg:${r.aggModel}`;
    if (!modelMap.has(aggKey)) {
      modelMap.set(aggKey, { role: 'agg', provider: 'unknown', timings: [], tokens: [], success: [] });
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
      role,
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
 *
 * v2.5.2 增强：覆盖 MoA 管道常见的失败场景，最大限度减少 "other" 占比。
 * 注意：当所有参考模型失败时，错误信息为
 *   "All reference models failed (modelA: <err1>; modelB: <err2>)"
 * 这里会先提取具体错误正文再分类，从而把 timeout / auth / rate_limit 等正确归类。
 *
 * 分类优先级（从高到低）：
 *   1. 超时/截止时间（最常见的本地模型问题）
 *   2. 中止/取消（用户取消或信号中断）
 *   3. 同步预算超限（MoA 特有）
 *   4. 连接/网络（DNS、SSL、TCP 层）
 *   5. 限流/配额（API 调用频率）
 *   6. 认证/授权（API Key 问题）
 *   7. 模型不存在（404/unknown model）
 *   8. 上下文长度超限
 *   9. 服务端错误（500/502/504）
 *   10. 过载/不可用（503/overloaded）
 *   11. 内容过滤/安全拦截
 *   12. 解析错误（JSON/格式）
 *   13. 空响应
 *   14. 其他（兜底）
 */
function classifyError(error?: string): string {
  if (!error) return 'unknown';
  const lower = error.toLowerCase();
  // 提取 "All reference models failed (...)" 括号内的具体错误正文，优先按真实错误分类
  const refBody = (lower.match(/all reference models failed \(([\s\S]*)\)/) ?? [])[1] ?? lower;
  const haystack = refBody || lower;

  // 超时（含 "MoA LLM call timeout after XXXms"）
  if (haystack.includes('timeout') || haystack.includes('timed out') || haystack.includes('deadline') || haystack.includes('call timeout')) return 'timeout';
  // 中止/取消
  if (haystack.includes('abort') || haystack.includes('cancel') || haystack.includes('aborted or missing')) return 'aborted';
  // 同步预算超限（MoA 特有）
  if (haystack.includes('budget') || haystack.includes('sync budget')) return 'sync_budget_exceeded';
  // DNS 解析失败
  if (haystack.includes('enotfound') || haystack.includes('getaddrinfo') || haystack.includes('dns') || haystack.includes('name not resolved')) return 'dns_error';
  // SSL/TLS 证书错误
  if (haystack.includes('certificate') || haystack.includes('ssl') || haystack.includes('tls') || haystack.includes('self-signed') || haystack.includes('cert')) return 'ssl_error';
  // 连接/网络层错误
  if (haystack.includes('connect') || haystack.includes('network') || haystack.includes('econnrefused') || haystack.includes('socket') || haystack.includes('fetch failed') || haystack.includes('unreachable') || haystack.includes('ehostunreach') || haystack.includes('enetunreach')) return 'connection';
  // 限流/配额
  if (haystack.includes('rate') || haystack.includes('429') || haystack.includes('quota') || haystack.includes('too many request')) return 'rate_limit';
  // "limit" 单独出现可能是 context_length，放后面
  if (haystack.includes('limit') && !haystack.includes('context')) return 'rate_limit';
  // 认证/授权
  if (haystack.includes('auth') || haystack.includes('401') || haystack.includes('403') || haystack.includes('unauthorized') || haystack.includes('forbidden') || haystack.includes('api key') || haystack.includes('invalid key') || haystack.includes('permission')) return 'auth_error';
  // 模型不存在
  if (haystack.includes('model') && (haystack.includes('not found') || haystack.includes('404') || haystack.includes('does not exist') || haystack.includes('unknown model') || haystack.includes('no such model'))) return 'model_not_found';
  // 404 单独出现
  if (haystack.includes('404') || haystack.includes('not found')) return 'model_not_found';
  // 上下文长度超限
  if (haystack.includes('context') && (haystack.includes('length') || haystack.includes('exceed') || haystack.includes('too long') || haystack.includes('max token') || haystack.includes('limit'))) return 'context_length';
  // 服务端错误（500/502/504）
  if (haystack.includes('500') || haystack.includes('502') || haystack.includes('504') || haystack.includes('internal server error') || haystack.includes('bad gateway') || haystack.includes('gateway timeout')) return 'server_error';
  // 过载/不可用（503）
  if (haystack.includes('overloaded') || haystack.includes('unavailable') || haystack.includes('service unavailable') || haystack.includes('503')) return 'overloaded';
  // 内容过滤/安全拦截
  if (haystack.includes('content filter') || haystack.includes('safety') || haystack.includes('blocked') || haystack.includes('moderation') || haystack.includes('policy') || haystack.includes('inappropriate')) return 'content_filter';
  // 解析错误
  if (haystack.includes('parse') || haystack.includes('json') || haystack.includes('syntax') || haystack.includes('unexpected token') || haystack.includes('invalid response body')) return 'parse_error';
  // 空响应
  if (haystack.includes('empty') || haystack.includes('no result') || haystack.includes('no content') || haystack.includes('empty response') || haystack.includes('no data')) return 'empty_response';
  // 流式传输错误
  if (haystack.includes('stream') || haystack.includes('sse') || haystack.includes('chunk') || haystack.includes('partial')) return 'stream_error';
  // 内存不足
  if (haystack.includes('out of memory') || haystack.includes('oom') || haystack.includes('memory allocation')) return 'memory_error';
  // 配置错误
  if (haystack.includes('config') || haystack.includes('not configured') || haystack.includes('missing') || haystack.includes('undefined')) return 'config_error';
  return 'other';
}

// ============================================================================
// 持久化
// ============================================================================

const PERF_FILE = join(homedir(), '.openclaw', 'moa-perf.json');
const PERF_FILE_VERSION = 1;

let lastPersistTime = 0;
const PERSIST_THROTTLE_MS = 5_000;

/**
 * 持久化文件结构。
 *
 * v1（当前）：单独保存原始 runRecords / allComplexityRecords，
 * 启动时直接还原内存环形缓冲区，确保进程重启后历史数据完整可见。
 *
 * 兼容性：若文件存在但缺少 version 字段（旧格式仅写入 summary），
 * loadFromDisk 会跳过还原，仍可正常写入新格式覆盖。
 */
interface PersistedPerfFile {
  version: number;
  savedAt: number;
  runRecords: MoaRunRecord[];
  allComplexityRecords: Array<{ timestamp: number; score: number }>;
  summary: MoaPerformanceSummary;
}

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
      // 写入原始缓冲区 + 聚合 summary，启动时可直接还原内存
      const payload: PersistedPerfFile = {
        version: PERF_FILE_VERSION,
        savedAt: Date.now(),
        runRecords: [...runRecords],
        allComplexityRecords: [...allComplexityRecords],
        summary: getMoaPerformance(),
      };
      await writeFile(PERF_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      // 静默失败，不影响主流程
    }
  });
}

/**
 * 启动时从磁盘恢复历史数据。
 *
 * 修复前：persistAsync 已写入 ~/.openclaw/moa-perf.json，但模块加载时
 * 从未读取该文件，导致 snapshot 服务（端口 7423）重启后 runRecords /
 * allComplexityRecords 全部丢失，Dashboard MoA 监控页显示空数据。
 *
 * 行为：
 * - 文件不存在 / 解析失败 / 旧格式（无 version 字段）→ 静默跳过
 * - v1 格式 → 还原 runRecords（截断到 MAX_RECORDS）和 allComplexityRecords（截断到 MAX_ALL_COMPLEXITY）
 * - 异步执行，不阻塞模块导出；加载期间 getMoaPerformance 仍可正常返回（基于当前空缓冲区）
 * - 加载完成后清除 performanceCache，确保下次查询返回还原后的数据
 */
async function loadFromDisk(): Promise<void> {
  try {
    if (!existsSync(PERF_FILE)) return;
    const raw = await readFile(PERF_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedPerfFile>;

    // 兼容性：旧格式仅写入 MoaPerformanceSummary（无 version / runRecords 字段）
    if (typeof parsed.version !== 'number' || parsed.version !== PERF_FILE_VERSION) {
      return;
    }

    if (Array.isArray(parsed.runRecords) && parsed.runRecords.length > 0) {
      // 截断到 MAX_RECORDS 防止意外的大文件撑爆缓冲区
      const restored = parsed.runRecords.slice(-MAX_RECORDS);
      runRecords.length = 0;
      runRecords.push(...restored);
    }

    if (Array.isArray(parsed.allComplexityRecords) && parsed.allComplexityRecords.length > 0) {
      const restored = parsed.allComplexityRecords.slice(-MAX_ALL_COMPLEXITY);
      allComplexityRecords.length = 0;
      allComplexityRecords.push(...restored);
    }

    // 还原后清除性能缓存，确保下次 getMoaPerformance() 基于还原后的数据计算
    clearPerformanceCache();
  } catch {
    // 静默失败，不影响主流程
  }
}

// 模块加载时异步触发还原（不阻塞导入，不阻塞事件循环）
void loadFromDisk();

export { PERF_FILE, loadFromDisk };

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