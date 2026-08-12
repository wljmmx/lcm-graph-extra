/**
 * MOA (Mixture of Agents) 配置 API 封装。
 *
 * - GET  /api/moa/config     —— 读取 MOA 配置
 * - PATCH /api/moa/config     —— 热更新 MOA 配置
 * - GET  /api/moa/status      —— 查看 MOA 运行时状态
 */
import { apiGet, apiPatch } from './client';

// ─── 类型 ──────────────────────────────────────────────────────────────────

export interface MoaModelConfig {
  provider: string;
  model: string;
  temperature: number;
  systemPrompt?: string;
  timeoutMs: number;
  apiKey?: string;
  baseURL?: string;
  keepAlive?: string;
}

export interface MoaConfig {
  enabled: boolean;
  complexityThreshold: number;
  benefitThreshold?: number;
  tokenCosts?: Record<string, number>;
  mode: string;
  enabledTiers: string[];
  referenceModels: MoaModelConfig[];
  aggregatorModel: MoaModelConfig | null;
  syncBudgetMs?: number;
}

export interface MoaConfigResponse {
  ok: boolean;
  config?: MoaConfig;
  error?: string;
}

export interface MoaConfigUpdateResponse {
  ok: boolean;
  applied?: string[];
  rejected?: Array<{ path: string; reason: string }>;
  config?: MoaConfig;
  note?: string;
  error?: string;
}

export interface MoaStatus {
  enabled: boolean;
  mode: string;
  /** 最近一次实际调度策略（运行时 effective mode），可能不同于配置的 mode */
  lastEffectiveMode: string;
  complexityThreshold: number;
  enabledTiers: string[];
  referenceModelCount: number;
  hasAggregator: boolean;
  referenceModels: Array<{ provider: string; model: string }>;
  aggregatorModel: { provider: string; model: string } | null;
}

export interface MoaStatusResponse {
  ok: boolean;
  status?: MoaStatus;
  error?: string;
}

// ─── API 函数 ──────────────────────────────────────────────────────────────

/** 获取 MOA 配置 */
export function fetchMoaConfig(): Promise<MoaConfigResponse> {
  return apiGet<MoaConfigResponse>('/api/moa/config');
}

/** 热更新 MOA 配置 */
export function updateMoaConfig(updates: Record<string, unknown>): Promise<MoaConfigUpdateResponse> {
  return apiPatch<MoaConfigUpdateResponse>('/api/moa/config', { updates });
}

/** 获取 MOA 运行时状态 */
export function fetchMoaStatus(): Promise<MoaStatusResponse> {
  return apiGet<MoaStatusResponse>('/api/moa/status');
}

// ─── 性能追踪 ──────────────────────────────────────────────────────────────

export interface MoaRunRecord {
  id: string;
  timestamp: number;
  queryPreview: string;
  totalMs: number;
  refMs: number;
  aggMs: number;
  totalTokens: number;
  refCount: number;
  validRefCount: number;
  refTimings: number[];
  refModels: string[];
  refTokens: number[];
  aggModel: string;
  aggTokens: number;
  responseLen: number;
  success: boolean;
  error?: string;
  mode: string;
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

export interface MoaPerformanceData {
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
  avgTotalMs: number;
  avgRefMs: number;
  avgAggMs: number;
  totalTokens: number;
  avgTokens: number;
  recentRuns: MoaRunRecord[];
  latencyPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  refLatencyPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  aggLatencyPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  tokenEfficiency: number;
  avgResponseLen: number;
  modelBreakdown: MoaModelBreakdown[];
  errorBreakdown: Record<string, number>;
  complexityDistribution: {
    low: number;
    medium: number;
    high: number;
  };
  fallbackCount: number;
  avgComplexityScore: number;
  complexityPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  complexityHistory: Array<{ timestamp: number; score: number }>;
  allComplexityDistribution: { low: number; medium: number; high: number };
  allComplexityPercentiles: { p50: number; p90: number; p95: number; p99: number };
  allComplexityHistory: Array<{ timestamp: number; score: number }>;
  complexityHourlyBuckets: Array<{ hour: string; avg: number; count: number; min: number; max: number }>;
  complexityDailyBuckets: Array<{ date: string; avg: number; count: number; min: number; max: number }>;
}

export interface MoaPerformanceResponse {
  ok: boolean;
  data?: MoaPerformanceData;
  error?: string;
}

/** 获取 MoA 性能追踪数据 */
export function fetchMoaPerformance(): Promise<MoaPerformanceResponse> {
  return apiGet<MoaPerformanceResponse>('/api/moa/performance');
}