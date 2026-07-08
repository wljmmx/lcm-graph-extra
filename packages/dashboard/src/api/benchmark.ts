/**
 * Benchmark API 封装 + 类型定义。
 *
 * 与后端 server/routes/benchmark.ts 的响应契约对齐。
 */
import { apiGet, apiPost } from './client';

// ---------------------------------------------------------------------------
// 类型定义（与 server/lib/benchmark.ts 对齐）
// ---------------------------------------------------------------------------

export type BenchmarkMode = 'rest' | 'mcp';

export type FixtureCategory = 'knowledge' | 'experience' | 'error' | 'config' | 'multilingual' | 'mixed';

export interface BenchmarkFixture {
  id: string;
  query: string;
  category: FixtureCategory;
  searches?: Array<{ type: 'lex' | 'vec' | 'hyde'; query?: string }>;
  expectedDocIds?: string[];
  minExpectedResults?: number;
  description?: string;
}

export interface BenchmarkTopResult {
  docid?: string;
  file?: string;
  title?: string;
  score?: number;
  snippet?: string;
}

export interface BenchmarkItemResult {
  fixtureId: string;
  query: string;
  category: string;
  success: boolean;
  latencyMs: number;
  resultCount: number;
  returnedDocIds: string[];
  expectedDocIds: string[];
  recall: number | null;
  precision: number | null;
  f1: number | null;
  error?: string;
  topResults?: BenchmarkTopResult[];
}

export interface BenchmarkLatencyStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  std: number;
}

export interface BenchmarkCategoryStats {
  category: string;
  total: number;
  success: number;
  successRate: number;
  avgLatencyMs: number;
  avgResultCount: number;
  avgRecall: number | null;
  recallEvaluated: number;
}

export interface BenchmarkSummary {
  totalFixtures: number;
  successCount: number;
  successRate: number;
  totalDurationMs: number;
  latency: BenchmarkLatencyStats;
  avgResultCount: number;
  estimatedTokens: {
    input: number;
    output: number;
    total: number;
  };
  compressionRatio: number;
  recall: {
    evaluated: number;
    avgRecall: number;
    avgPrecision: number;
    avgF1: number;
  } | null;
  byCategory: BenchmarkCategoryStats[];
}

export interface BenchmarkResult {
  runId: string;
  startedAt: string;
  endedAt: string;
  options: {
    qmdBaseUrl: string;
    mode: string;
    limit: number;
    timeoutMs: number;
    rerank: boolean;
    concurrency: number;
    fixturesSource: 'builtin' | 'custom' | 'mixed';
    fixturesCount: number;
  };
  summary: BenchmarkSummary;
  items: BenchmarkItemResult[];
}

export interface BenchmarkRunRequest {
  baseUrl?: string;
  fixtures?: BenchmarkFixture[];
  limit?: number;
  timeoutMs?: number;
  rerank?: boolean;
  mode?: BenchmarkMode;
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// API 调用
// ---------------------------------------------------------------------------

/** GET /api/benchmark/fixtures 响应 */
export interface BenchmarkFixturesResponse {
  ok: boolean;
  fixtures: BenchmarkFixture[];
  categoryStats: Record<string, number>;
  totalCount: number;
}

/** GET /api/benchmark/default-url 响应 */
export interface BenchmarkDefaultUrlResponse {
  ok: boolean;
  defaultUrl: string;
}

/** GET /api/benchmark/history 响应（不含 items） */
export interface BenchmarkHistoryItem {
  runId: string;
  startedAt: string;
  endedAt: string;
  summary: BenchmarkSummary;
  options: BenchmarkResult['options'];
}

export interface BenchmarkHistoryResponse {
  ok: boolean;
  history: BenchmarkHistoryItem[];
}

/** GET /api/benchmark/report/:id 响应 */
export interface BenchmarkReportResponse {
  ok: boolean;
  result?: BenchmarkResult;
  error?: string;
}

/** POST /api/benchmark/run 响应 */
export interface BenchmarkRunResponse {
  ok: boolean;
  result?: BenchmarkResult;
  error?: string;
}

/** 获取内置测试集 */
export function fetchBenchmarkFixtures(): Promise<BenchmarkFixturesResponse> {
  return apiGet<BenchmarkFixturesResponse>('/api/benchmark/fixtures');
}

/** 获取系统配置中的 QMD 地址 */
export function fetchBenchmarkDefaultUrl(): Promise<BenchmarkDefaultUrlResponse> {
  return apiGet<BenchmarkDefaultUrlResponse>('/api/benchmark/default-url');
}

/** 获取历史列表 */
export function fetchBenchmarkHistory(): Promise<BenchmarkHistoryResponse> {
  return apiGet<BenchmarkHistoryResponse>('/api/benchmark/history');
}

/** 获取完整结果 */
export function fetchBenchmarkReport(runId: string): Promise<BenchmarkReportResponse> {
  return apiGet<BenchmarkReportResponse>(`/api/benchmark/report/${encodeURIComponent(runId)}`);
}

/** 执行压测 */
export function runBenchmark(req: BenchmarkRunRequest): Promise<BenchmarkRunResponse> {
  return apiPost<BenchmarkRunResponse>('/api/benchmark/run', req);
}

/** 下载 Markdown 报告（直接触发浏览器下载） */
export function downloadBenchmarkMarkdown(runId: string): void {
  window.open(`/api/benchmark/report/${encodeURIComponent(runId)}/markdown`, '_blank');
}
