/**
 * Benchmark API 封装 + 类型定义（v2.3.0）。
 *
 * 与后端 server/routes/benchmark.ts 的响应契约对齐。
 *
 * v2.3.0 新增：
 * - 多测试集选择（fixtureSetId: project-scenarios / ce-multi-turn / beir-nfcorpus / beir-scifact）
 * - CE 引擎查询（engine: 'qmd' 直查 QMD /query，'ce' 走 dashboard /api/memory/search 多引擎并行）
 * - BEIR 在线下载 + 缓存状态查询
 * - 多轮会话分析（MultiTurnSessionStats: coherenceScore / recallByTurn / latencyByTurn）
 */
import { apiGet, apiPost } from './client';

// ---------------------------------------------------------------------------
// 类型定义（与 server/lib/benchmark.ts 对齐）
// ---------------------------------------------------------------------------

export type BenchmarkMode = 'rest' | 'mcp';

/** 查询引擎：'qmd' 直查 QMD /query，'ce' 走 dashboard /api/memory/search 多引擎并行 */
export type BenchmarkEngine = 'qmd' | 'ce';

export type FixtureCategory = 'knowledge' | 'experience' | 'error' | 'config' | 'multilingual' | 'mixed';

/** 测试集来源标识 */
export type FixtureSetId = 'project-scenarios' | 'ce-multi-turn' | 'beir-nfcorpus' | 'beir-scifact';

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
  /** 来源引擎（ce 模式下：lcm / qmd / neo4j） */
  source?: string;
}

/** CE 引擎诊断信息（区分"服务不可达"vs"无数据"） */
export interface CeEngineDiagnostics {
  lcmCount: number;
  qmdCount: number;
  neo4jCount: number;
  lcmError?: string;
  qmdError?: string;
  neo4jError?: string;
  conclusion: 'ok' | 'all-empty' | 'all-failed' | 'partial-failure';
  hint?: string;
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
  /** 多轮会话：轮次索引（0-based，非多轮会话为 undefined） */
  turnIndex?: number;
  /** 多轮会话：总轮次数 */
  turnTotal?: number;
  /** 多轮会话：轮次角色（opening/followup/clarify/recall/compress） */
  turnRole?: string;
  /** 多轮会话：会话 ID */
  sessionId?: string;
  /** CE 引擎诊断（engine='ce' 时）：各引擎结果数 + 错误信息 */
  ceDiagnostics?: CeEngineDiagnostics;
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

/** 多轮会话统计（CE 能力维度） */
export interface MultiTurnSessionStats {
  sessionId: string;
  category: string;
  turnCount: number;
  successCount: number;
  avgLatencyMs: number;
  recallByTurn: Array<number | null>;
  resultCountByTurn: number[];
  latencyByTurn: number[];
  /** 上下文连贯性评分（followup 轮召回 opening 轮文档的比例，0-1，无评估时为 null） */
  coherenceScore: number | null;
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
  /** 多轮会话统计（CE 能力维度，仅 ce-multi-turn 或含 sessionId 的用例有值） */
  multiTurnSessions?: MultiTurnSessionStats[];
}

export interface BenchmarkResult {
  runId: string;
  startedAt: string;
  endedAt: string;
  options: {
    qmdBaseUrl: string;
    mode: string;
    engine: string;
    limit: number;
    timeoutMs: number;
    rerank: boolean;
    concurrency: number;
    fixtureSetId: string;
    fixturesSource: string;
    fixturesCount: number;
  };
  summary: BenchmarkSummary;
  items: BenchmarkItemResult[];
}

export interface BenchmarkRunRequest {
  baseUrl?: string;
  fixtures?: BenchmarkFixture[];
  fixtureSetId?: FixtureSetId;
  beirSubsetSize?: number;
  limit?: number;
  timeoutMs?: number;
  rerank?: boolean;
  mode?: BenchmarkMode;
  engine?: BenchmarkEngine;
  dashboardBaseUrl?: string;
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// 测试集元数据类型
// ---------------------------------------------------------------------------

export interface FixtureSetMeta {
  id: FixtureSetId;
  name: string;
  description: string;
  type: 'single-turn' | 'multi-turn' | 'beir';
  requiresDownload?: boolean;
  count?: number;
  /** BEIR 是否已缓存 */
  cached?: boolean;
  /** BEIR 缓存信息 */
  cacheInfo?: { cached: boolean; path: string; sizeBytes: number; fileCount: number } | null;
  defaultSubsetSize?: number;
}

// ---------------------------------------------------------------------------
// API 响应类型
// ---------------------------------------------------------------------------

/** GET /api/benchmark/fixture-sets 响应 */
export interface BenchmarkFixtureSetsResponse {
  ok: boolean;
  fixtureSets: FixtureSetMeta[];
}

/** GET /api/benchmark/fixtures 响应（内置测试集） */
export interface BenchmarkFixturesResponse {
  ok: boolean;
  fixtureSetId: FixtureSetId;
  fixtures: BenchmarkFixture[];
  categoryStats: Record<string, number>;
  totalCount: number;
}

/** GET /api/benchmark/fixtures 响应（BEIR 测试集，未实际加载 fixtures） */
export interface BenchmarkBeirFixturesResponse {
  ok: boolean;
  fixtureSetId: FixtureSetId;
  type: 'beir';
  cached: boolean;
  cacheInfo: { cached: boolean; path: string; sizeBytes: number; fileCount: number } | null;
  message: string;
}

/** GET /api/benchmark/default-url 响应 */
export interface BenchmarkDefaultUrlResponse {
  ok: boolean;
  defaultQmdUrl: string;
  defaultDashboardUrl: string;
}

/** BEIR 数据集状态 */
export interface BeirDatasetInfo {
  name: string;
  description: string;
  defaultSubsetSize: number;
  cached: boolean;
  cacheInfo: { cached: boolean; path: string; sizeBytes: number; fileCount: number } | null;
}

/** GET /api/benchmark/beir/status 响应 */
export interface BenchmarkBeirStatusResponse {
  ok: boolean;
  datasets: BeirDatasetInfo[];
}

/** POST /api/benchmark/beir/download 响应（失败时包含 manualInstructions） */
export interface BenchmarkBeirDownloadResponse {
  ok: boolean;
  dataset: string;
  cached: boolean;
  cacheInfo?: { cached: boolean; path: string; sizeBytes: number; fileCount: number };
  error?: string;
  message?: string;
  /** 手工下载指引（下载失败时返回，供前端展示） */
  manualInstructions?: string;
}

/** GET /api/benchmark/beir/manual 响应 */
export interface BenchmarkBeirManualResponse {
  ok: boolean;
  dataset: string;
  instructions: string;
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

// ---------------------------------------------------------------------------
// API 调用
// ---------------------------------------------------------------------------

/** 获取所有测试集元数据 */
export function fetchBenchmarkFixtureSets(): Promise<BenchmarkFixtureSetsResponse> {
  return apiGet<BenchmarkFixtureSetsResponse>('/api/benchmark/fixture-sets');
}

/** 获取内置测试集 fixtures（project-scenarios / ce-multi-turn） */
export function fetchBenchmarkFixtures(set: FixtureSetId): Promise<BenchmarkFixturesResponse | BenchmarkBeirFixturesResponse> {
  return apiGet<BenchmarkFixturesResponse | BenchmarkBeirFixturesResponse>(
    `/api/benchmark/fixtures?set=${encodeURIComponent(set)}`,
  );
}

/** 获取系统配置中的 QMD + dashboard 地址 */
export function fetchBenchmarkDefaultUrl(): Promise<BenchmarkDefaultUrlResponse> {
  return apiGet<BenchmarkDefaultUrlResponse>('/api/benchmark/default-url');
}

/** 获取 BEIR 数据集缓存状态 */
export function fetchBeirStatus(): Promise<BenchmarkBeirStatusResponse> {
  return apiGet<BenchmarkBeirStatusResponse>('/api/benchmark/beir/status');
}

/** 触发 BEIR 数据集下载（失败时返回 manualInstructions 字段） */
export function downloadBeirDatasetApi(dataset: 'nfcorpus' | 'scifact'): Promise<BenchmarkBeirDownloadResponse> {
  return apiPost<BenchmarkBeirDownloadResponse>('/api/benchmark/beir/download', { dataset });
}

/** 获取 BEIR 手工下载指引 */
export function fetchBeirManualInstructions(dataset: 'nfcorpus' | 'scifact'): Promise<BenchmarkBeirManualResponse> {
  return apiGet<BenchmarkBeirManualResponse>(`/api/benchmark/beir/manual?dataset=${encodeURIComponent(dataset)}`);
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
