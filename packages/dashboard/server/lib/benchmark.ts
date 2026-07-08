/**
 * Benchmark Runner —— 压测执行引擎。
 *
 * 职责：
 * - 加载测试集（内置或用户自定义）
 * - 逐条执行查询（串行，避免并发干扰延迟测量）
 * - 采集每条查询的延迟、结果数、返回的 docids
 * - 计算召回率（若 fixture 提供 expectedDocIds）
 * - 聚合统计：P50/P90/P95/P99 延迟、avg/min/max、成功率、召回率分布
 * - 输出 BenchmarkResult 供报告生成器使用
 *
 * 设计：
 * - runner 本身不持久化，持久化由路由层负责（写入 benchmark_results.db）
 * - runner 不依赖 fastify，可独立测试
 * - 支持 onProgress 回调，用于实时推送执行进度
 */
import type { BenchmarkFixture } from './benchmark-fixtures.js';
import { BUILTIN_FIXTURES } from './benchmark-fixtures.js';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface BenchmarkRunnerOptions {
  /** QMD 服务 base URL（如 http://127.0.0.1:8081） */
  qmdBaseUrl: string;
  /** 自定义测试集（不传则用内置 BUILTIN_FIXTURES） */
  fixtures?: BenchmarkFixture[];
  /** 每条查询的 limit（默认 5） */
  limit?: number;
  /** 单次查询超时（默认 10s） */
  timeoutMs?: number;
  /** 是否启用 rerank（默认 true） */
  rerank?: boolean;
  /** 查询模式：'rest' 直接 REST /query，'mcp' 走 MCP /mcp */
  mode?: 'rest' | 'mcp';
  /** 并发数（默认 1，串行）。>1 时并发执行但延迟测量仍按单条计算 */
  concurrency?: number;
  /** 进度回调 */
  onProgress?: (completed: number, total: number, current: BenchmarkFixture) => void;
}

export interface BenchmarkItemResult {
  /** 对应的 fixture ID */
  fixtureId: string;
  /** 查询文本 */
  query: string;
  /** 分类 */
  category: string;
  /** 是否成功 */
  success: boolean;
  /** 延迟（ms） */
  latencyMs: number;
  /** 返回结果数 */
  resultCount: number;
  /** 返回的 docid 列表 */
  returnedDocIds: string[];
  /** 期望的 docid 列表（若 fixture 提供） */
  expectedDocIds: string[];
  /** 召回率（expectedDocIds 中被命中的比例，0-1）。无 expectedDocIds 时为 null */
  recall: number | null;
  /** 精确率（returnedDocIds 中命中 expectedDocIds 的比例，0-1）。无 expectedDocIds 时为 null */
  precision: number | null;
  /** F1 分数。无 expectedDocIds 时为 null */
  f1: number | null;
  /** 错误信息（失败时） */
  error?: string;
  /** 返回的结果项（前 limit 个，用于报告展示） */
  topResults?: Array<{
    docid?: string;
    file?: string;
    title?: string;
    score?: number;
    snippet?: string;
  }>;
}

export interface BenchmarkLatencyStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  /** 标准差 */
  std: number;
}

export interface BenchmarkCategoryStats {
  category: string;
  total: number;
  success: number;
  successRate: number;
  avgLatencyMs: number;
  avgResultCount: number;
  /** 平均召回率（仅统计有 expectedDocIds 的用例） */
  avgRecall: number | null;
  /** 有 expectedDocIds 的用例数 */
  recallEvaluated: number;
}

export interface BenchmarkSummary {
  /** 总用例数 */
  totalFixtures: number;
  /** 成功数 */
  successCount: number;
  /** 成功率（0-1） */
  successRate: number;
  /** 总耗时（ms） */
  totalDurationMs: number;
  /** 延迟统计（仅成功用例） */
  latency: BenchmarkLatencyStats;
  /** 平均结果数 */
  avgResultCount: number;
  /** 总 tokens 估算（输入+输出，基于结果数和 snippet 长度粗估） */
  estimatedTokens: {
    /** 输入 tokens（query 文本估算） */
    input: number;
    /** 输出 tokens（返回的 snippets 估算） */
    output: number;
    /** 总 tokens */
    total: number;
  };
  /** 压缩率：返回 snippets 总字符数 / 假设全文档总字符数（用 snippet 长度作为压缩后，limit*avgSnippetLen 作为基准） */
  compressionRatio: number;
  /** 召回率统计（仅有 expectedDocIds 的用例） */
  recall: {
    evaluated: number;
    avgRecall: number;
    avgPrecision: number;
    avgF1: number;
  } | null;
  /** 按分类统计 */
  byCategory: BenchmarkCategoryStats[];
}

export interface BenchmarkResult {
  /** 运行 ID（时间戳 + 随机后缀） */
  runId: string;
  /** 开始时间 ISO */
  startedAt: string;
  /** 结束时间 ISO */
  endedAt: string;
  /** 使用的配置 */
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
  /** 汇总统计 */
  summary: BenchmarkSummary;
  /** 每条用例的详细结果 */
  items: BenchmarkItemResult[];
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 计算 P50/P90/P95/P99 百分位 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

/** 计算标准差 */
function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** 粗略估算 tokens：中英文混合，约 1 token / 2 字符（中文）/ 1 token / 4 字符（英文） */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 127) cjk++;
    else ascii++;
  }
  return Math.ceil(cjk / 2 + ascii / 4);
}

/** 计算召回率和精确率 */
function calcRecallPrecision(
  returnedDocIds: string[],
  expectedDocIds: string[],
): { recall: number; precision: number; f1: number } {
  if (expectedDocIds.length === 0) {
    return { recall: 0, precision: 0, f1: 0 };
  }
  const returnedSet = new Set(returnedDocIds);
  const expectedSet = new Set(expectedDocIds);
  let hits = 0;
  for (const id of expectedDocIds) {
    if (returnedSet.has(id)) hits++;
  }
  const recall = hits / expectedDocIds.length;
  const precision = returnedDocIds.length > 0 ? hits / returnedDocIds.length : 0;
  const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  return { recall, precision, f1 };
}

// ---------------------------------------------------------------------------
// REST 查询
// ---------------------------------------------------------------------------

interface QmdQueryItem {
  docid?: string;
  file?: string;
  title?: string;
  score?: number;
  snippet?: string;
  line?: number;
}

async function restQuery(
  baseUrl: string,
  fixture: BenchmarkFixture,
  limit: number,
  timeoutMs: number,
  rerank: boolean,
): Promise<{ items: QmdQueryItem[]; latencyMs: number }> {
  const start = Date.now();
  const searches = fixture.searches && fixture.searches.length > 0
    ? fixture.searches.map((s) => ({ type: s.type, query: s.query ?? fixture.query }))
    : [{ type: 'lex' as const, query: fixture.query }, { type: 'vec' as const, query: fixture.query }];

  const body = {
    searches,
    limit,
    minScore: 0,
    rerank,
  };
  const resp = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`REST /query HTTP ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as { results?: QmdQueryItem[] };
  const items = Array.isArray(data?.results) ? data.results : [];
  return { items, latencyMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * 执行 benchmark 压测。
 * 串行执行每条 fixture，采集延迟/结果数/docids/召回率。
 */
export async function runBenchmark(opts: BenchmarkRunnerOptions): Promise<BenchmarkResult> {
  const fixtures = opts.fixtures ?? BUILTIN_FIXTURES;
  const limit = opts.limit ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const rerank = opts.rerank ?? true;
  const mode = opts.mode ?? 'rest';
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const startedAt = new Date();
  const startMs = Date.now();

  const items: BenchmarkItemResult[] = [];
  let completed = 0;

  // 串行执行（concurrency > 1 时分批并发，但保持延迟测量准确性）
  const batches: BenchmarkFixture[][] = [];
  for (let i = 0; i < fixtures.length; i += concurrency) {
    batches.push(fixtures.slice(i, i + concurrency));
  }

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async (fixture) => {
        try {
          const { items: rawItems, latencyMs } = await restQuery(
            opts.qmdBaseUrl, fixture, limit, timeoutMs, rerank,
          );
          const returnedDocIds = rawItems
            .map((r) => r.docid)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          const expectedDocIds = fixture.expectedDocIds ?? [];
          const hasExpected = expectedDocIds.length > 0;
          const { recall, precision, f1 } = hasExpected
            ? calcRecallPrecision(returnedDocIds, expectedDocIds)
            : { recall: 0, precision: 0, f1: 0 };

          const result: BenchmarkItemResult = {
            fixtureId: fixture.id,
            query: fixture.query,
            category: fixture.category,
            success: true,
            latencyMs,
            resultCount: rawItems.length,
            returnedDocIds,
            expectedDocIds,
            recall: hasExpected ? recall : null,
            precision: hasExpected ? precision : null,
            f1: hasExpected ? f1 : null,
            topResults: rawItems.slice(0, limit).map((r) => ({
              docid: r.docid,
              file: r.file,
              title: r.title,
              score: r.score,
              snippet: r.snippet,
            })),
          };
          return result;
        } catch (err) {
          const result: BenchmarkItemResult = {
            fixtureId: fixture.id,
            query: fixture.query,
            category: fixture.category,
            success: false,
            latencyMs: timeoutMs,
            resultCount: 0,
            returnedDocIds: [],
            expectedDocIds: fixture.expectedDocIds ?? [],
            recall: null,
            precision: null,
            f1: null,
            error: err instanceof Error ? err.message : String(err),
          };
          return result;
        }
      }),
    );
    items.push(...batchResults);
    completed += batch.length;
    if (opts.onProgress) {
      for (const f of batch) {
        opts.onProgress(completed, fixtures.length, f);
      }
    }
  }

  const endedAt = new Date();
  const totalDurationMs = Date.now() - startMs;

  // 聚合统计
  const successItems = items.filter((i) => i.success);
  const latencies = successItems.map((i) => i.latencyMs).sort((a, b) => a - b);
  const resultCounts = successItems.map((i) => i.resultCount);

  // tokens 估算
  const inputTokens = fixtures.reduce((sum, f) => sum + estimateTokens(f.query), 0);
  const outputTokens = successItems.reduce(
    (sum, i) => sum + (i.topResults ?? []).reduce(
      (s, r) => s + estimateTokens(r.snippet ?? '') + estimateTokens(r.title ?? ''),
      0,
    ),
    0,
  );

  // 压缩率：返回的 snippet 总长度 / 假设全文档总长度（用 4000 字符/文档作为基准估算）
  const returnedSnippetLen = successItems.reduce(
    (sum, i) => sum + (i.topResults ?? []).reduce((s, r) => s + (r.snippet ?? '').length, 0),
    0,
  );
  const assumedFullDocLen = successItems.length * limit * 4000;
  const compressionRatio = assumedFullDocLen > 0
    ? returnedSnippetLen / assumedFullDocLen
    : 0;

  // 召回率统计（仅有 expectedDocIds 的用例）
  const recallEvaluated = successItems.filter((i) => i.recall !== null);
  const recallStats = recallEvaluated.length > 0
    ? {
        evaluated: recallEvaluated.length,
        avgRecall: recallEvaluated.reduce((s, i) => s + (i.recall ?? 0), 0) / recallEvaluated.length,
        avgPrecision: recallEvaluated.reduce((s, i) => s + (i.precision ?? 0), 0) / recallEvaluated.length,
        avgF1: recallEvaluated.reduce((s, i) => s + (i.f1 ?? 0), 0) / recallEvaluated.length,
      }
    : null;

  // 按分类统计
  const categories = [...new Set(items.map((i) => i.category))];
  const byCategory: BenchmarkCategoryStats[] = categories.map((cat) => {
    const catItems = items.filter((i) => i.category === cat);
    const catSuccess = catItems.filter((i) => i.success);
    const catLatencies = catSuccess.map((i) => i.latencyMs);
    const catRecallEval = catSuccess.filter((i) => i.recall !== null);
    return {
      category: cat,
      total: catItems.length,
      success: catSuccess.length,
      successRate: catItems.length > 0 ? catSuccess.length / catItems.length : 0,
      avgLatencyMs: catLatencies.length > 0
        ? catLatencies.reduce((a, b) => a + b, 0) / catLatencies.length
        : 0,
      avgResultCount: catSuccess.length > 0
        ? catSuccess.reduce((s, i) => s + i.resultCount, 0) / catSuccess.length
        : 0,
      avgRecall: catRecallEval.length > 0
        ? catRecallEval.reduce((s, i) => s + (i.recall ?? 0), 0) / catRecallEval.length
        : null,
      recallEvaluated: catRecallEval.length,
    };
  }).sort((a, b) => b.total - a.total);

  const summary: BenchmarkSummary = {
    totalFixtures: fixtures.length,
    successCount: successItems.length,
    successRate: fixtures.length > 0 ? successItems.length / fixtures.length : 0,
    totalDurationMs,
    latency: {
      min: latencies.length > 0 ? latencies[0] : 0,
      max: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
      avg: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      std: stdDev(latencies),
    },
    avgResultCount: resultCounts.length > 0
      ? resultCounts.reduce((a, b) => a + b, 0) / resultCounts.length
      : 0,
    estimatedTokens: {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
    },
    compressionRatio,
    recall: recallStats,
    byCategory,
  };

  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    runId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    options: {
      qmdBaseUrl: opts.qmdBaseUrl,
      mode,
      limit,
      timeoutMs,
      rerank,
      concurrency,
      fixturesSource: opts.fixtures ? 'custom' : 'builtin',
      fixturesCount: fixtures.length,
    },
    summary,
    items,
  };
}
