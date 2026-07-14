/**
 * MoA 性能追踪器
 *
 * 环形缓冲区存储最近 N 次 MoA 管道执行记录，供 Dashboard 查询。
 * 线程安全：所有操作在单线程 event loop 中执行，无需加锁。
 * 持久化：每次记录后写入 ~/.openclaw/moa-perf.json，Dashboard 服务读取。
 */

import type { MoaPipelineResult, LlmCallResult } from './types.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
}

// ============================================================================
// 环形缓冲区
// ============================================================================

const MAX_RECORDS = 50;
const runRecords: MoaRunRecord[] = [];

/**
 * 记录一次 MoA 管道执行。
 */
export function recordMoaRun(
  query: string,
  result: MoaPipelineResult | null,
  error: string | null,
  config: { mode: string; referenceModels: Array<{ model: string }>; aggregatorModel: { model: string } },
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
  };

  // 环形缓冲区
  runRecords.push(record);
  if (runRecords.length > MAX_RECORDS) {
    runRecords.shift();
  }

  // 异步持久化到文件（不阻塞管道）
  persistAsync();
}

/**
 * 获取 MoA 性能摘要。
 */
export function getMoaPerformance(): MoaPerformanceSummary {
  const successRecords = runRecords.filter((r) => r.success);
  const failedRecords = runRecords.filter((r) => !r.success);

  const allTimings = successRecords.map((r) => r.totalMs);
  const allRefTimings = successRecords.map((r) => r.refMs);
  const allAggTimings = successRecords.map((r) => r.aggMs);

  return {
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
  };
}

// ============================================================================
// 持久化
// ============================================================================

const PERF_FILE = join(homedir(), '.openclaw', 'moa-perf.json');

function persistAsync(): void {
  // 使用 setImmediate 确保不阻塞当前管道
  setImmediate(() => {
    try {
      const dir = join(homedir(), '.openclaw');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(PERF_FILE, JSON.stringify(getMoaPerformance(), null, 2), 'utf-8');
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
  return `moa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}