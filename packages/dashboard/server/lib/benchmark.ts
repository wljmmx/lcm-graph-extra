/**
 * Benchmark Runner —— 压测执行引擎（v2.3.0 扩展）。
 *
 * v2.3.0 新增：
 * - 多测试集选择：project-scenarios / ce-multi-turn / beir-nfcorpus / beir-scifact
 * - 多轮会话测试：ce-multi-turn 展开为按轮次执行，分析上下文累积召回变化
 * - CE 能力维度指标：多轮连贯性（recall trend）、压力分级、压缩触发检测
 * - 查询引擎扩展：支持通过 dashboard /api/memory/search 测试 CE 多引擎并行检索（L1+L2+L3）
 *
 * 职责：
 * - 加载测试集（内置 project-scenarios / ce-multi-turn / BEIR 在线下载）
 * - 逐条执行查询（串行，避免并发干扰延迟测量）
 * - 采集每条查询的延迟、结果数、返回的 docids
 * - 计算召回率（若 fixture 提供 expectedDocIds）
 * - 聚合统计：P50/P90/P95/P99 延迟、avg/min/max、成功率、召回率分布
 * - 多轮会话分析：按 sessionId 分组，计算 recall 随轮次的变化趋势
 * - 输出 BenchmarkResult 供报告生成器使用
 */
import type { BenchmarkFixture } from './benchmark-fixtures.js';
import {
  PROJECT_SCENARIO_FIXTURES,
  CE_MULTI_TURN_FIXTURES,
  flattenMultiTurnFixtures,
  type FixtureSetId,
} from './benchmark-fixtures.js';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface BenchmarkRunnerOptions {
  /** QMD 服务 base URL（如 http://127.0.0.1:8081） */
  qmdBaseUrl: string;
  /** 自定义测试集（不传则按 fixtureSetId 加载内置） */
  fixtures?: BenchmarkFixture[];
  /** 测试集 ID（决定加载哪个内置集，默认 project-scenarios） */
  fixtureSetId?: FixtureSetId;
  /** BEIR 子集大小（仅 beir-* 有效，默认 200） */
  beirSubsetSize?: number;
  /** 每条查询的 limit（默认 5） */
  limit?: number;
  /** 单次查询超时（默认 10s） */
  timeoutMs?: number;
  /** 是否启用 rerank（默认 true） */
  rerank?: boolean;
  /** 查询模式：'rest' 直接 REST /query，'mcp' 走 MCP /mcp */
  mode?: 'rest' | 'mcp';
  /** 查询引擎：'qmd' 直接调 QMD /query，'ce' 调 dashboard /api/memory/search 多引擎并行 */
  engine?: 'qmd' | 'ce';
  /** dashboard base URL（engine='ce' 时使用，默认 http://127.0.0.1:7421） */
  dashboardBaseUrl?: string;
  /** 并发数（默认 1，串行）。>1 时并发执行但延迟测量仍按单条计算 */
  concurrency?: number;
  /** 进度回调（每完成一条 fixture 触发，携带该条结果） */
  onProgress?: (completed: number, total: number, current: BenchmarkFixture, item: BenchmarkItemResult) => void;
  /** BEIR 数据集下载/解压进度回调（仅 beir-* 测试集触发，与 onProgress 分离避免类型错位） */
  onDownloadProgress?: (phase: string, progress?: number) => void;
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
    source?: string;
  }>;
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

/** CE 引擎诊断信息（区分"服务不可达"vs"无数据"） */
export interface CeEngineDiagnostics {
  /** lcm 引擎返回结果数 */
  lcmCount: number;
  /** qmd 引擎返回结果数 */
  qmdCount: number;
  /** neo4j 引擎返回结果数 */
  neo4jCount: number;
  /** 各引擎错误信息（仅失败时有值） */
  lcmError?: string;
  qmdError?: string;
  neo4jError?: string;
  /** 诊断结论 */
  conclusion: 'ok' | 'all-empty' | 'all-failed' | 'partial-failure';
  /** 诊断建议 */
  hint?: string;
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

/** 多轮会话统计（CE 能力维度） */
export interface MultiTurnSessionStats {
  /** 会话 ID */
  sessionId: string;
  /** 会话分类 */
  category: string;
  /** 总轮次数 */
  turnCount: number;
  /** 成功轮次数 */
  successCount: number;
  /** 平均延迟 */
  avgLatencyMs: number;
  /** 召回率随轮次变化（按 turnIndex 排序，null 表示该轮无 expectedDocIds） */
  recallByTurn: Array<number | null>;
  /** 结果数随轮次变化 */
  resultCountByTurn: number[];
  /** 延迟随轮次变化 */
  latencyByTurn: number[];
  /** 上下文连贯性评分（followup 轮召回 opening 轮文档的比例，0-1，无评估时为 null） */
  coherenceScore: number | null;
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
  /** 多轮会话统计（CE 能力维度，仅 ce-multi-turn 或含 sessionId 的用例有值） */
  multiTurnSessions?: MultiTurnSessionStats[];
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
    engine: string;
    limit: number;
    timeoutMs: number;
    rerank: boolean;
    concurrency: number;
    fixtureSetId: string;
    fixturesSource: string;
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
// 测试集加载
// ---------------------------------------------------------------------------

/** 按 fixtureSetId 加载内置测试集 */
export async function loadFixtures(
  fixtureSetId: FixtureSetId,
  beirSubsetSize?: number,
  onBeirProgress?: (phase: string, progress?: number) => void,
): Promise<BenchmarkFixture[]> {
  switch (fixtureSetId) {
    case 'project-scenarios':
      return PROJECT_SCENARIO_FIXTURES;
    case 'ce-multi-turn':
      // 展开多轮会话为单轮 fixture 列表
      return flattenMultiTurnFixtures(CE_MULTI_TURN_FIXTURES);
    case 'beir-nfcorpus':
    case 'beir-scifact': {
      const datasetName = fixtureSetId.replace('beir-', '');
      const { getBeirFixtures } = await import('./benchmark-beir.js');
      return getBeirFixtures(datasetName, beirSubsetSize, onBeirProgress);
    }
    default:
      return PROJECT_SCENARIO_FIXTURES;
  }
}

// ---------------------------------------------------------------------------
// 查询执行
// ---------------------------------------------------------------------------

interface QmdQueryItem {
  docid?: string;
  file?: string;
  title?: string;
  score?: number;
  snippet?: string;
  line?: number;
  source?: string;
}

/** QMD REST /query 查询 */
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

/** CE 多引擎并行查询（通过 dashboard /api/memory/search）
 *
 * v2.3.1 改进：
 * - 捕获 /api/memory/search 响应中的 errors 字段（各引擎独立降级时的错误信息）
 * - 当三引擎全空时生成诊断信息（区分"服务不可达"vs"无数据"）
 * - 诊断信息附加到 BenchmarkItemResult.ceDiagnostics
 */
async function ceSearch(
  dashboardBaseUrl: string,
  fixture: BenchmarkFixture,
  limit: number,
  timeoutMs: number,
): Promise<{ items: QmdQueryItem[]; latencyMs: number; diagnostics?: CeEngineDiagnostics }> {
  const start = Date.now();
  const url = `${dashboardBaseUrl}/api/memory/search?q=${encodeURIComponent(fixture.query)}&engines=all&limit=${limit}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`CE /api/memory/search HTTP ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as {
    results?: {
      lcm?: QmdQueryItem[];
      qmd?: QmdQueryItem[];
      neo4j?: QmdQueryItem[];
    };
    total?: number;
    errors?: { lcm?: string; qmd?: string; neo4j?: string };
  };

  // 合并三引擎结果
  const items: QmdQueryItem[] = [];
  const lcmResults = data?.results?.lcm ?? [];
  const qmdResults = data?.results?.qmd ?? [];
  const neo4jResults = data?.results?.neo4j ?? [];
  for (const r of lcmResults) {
    items.push({ ...r, source: 'lcm' });
  }
  for (const r of qmdResults) {
    items.push({ ...r, source: 'qmd' });
  }
  for (const r of neo4jResults) {
    items.push({ ...r, source: 'neo4j' });
  }

  // 生成诊断信息
  const diagnostics = buildCeDiagnostics(
    lcmResults.length,
    qmdResults.length,
    neo4jResults.length,
    data?.errors,
  );

  return { items, latencyMs: Date.now() - start, diagnostics };
}

/** 构建 CE 引擎诊断信息 */
function buildCeDiagnostics(
  lcmCount: number,
  qmdCount: number,
  neo4jCount: number,
  errors?: { lcm?: string; qmd?: string; neo4j?: string },
): CeEngineDiagnostics {
  const lcmError = errors?.lcm;
  const qmdError = errors?.qmd;
  const neo4jError = errors?.neo4j;

  const hasError = !!(lcmError || qmdError || neo4jError);
  const allEmpty = lcmCount === 0 && qmdCount === 0 && neo4jCount === 0;
  const allFailed = !!(lcmError && qmdError && neo4jError);

  let conclusion: CeEngineDiagnostics['conclusion'];
  let hint: string | undefined;

  if (allFailed) {
    conclusion = 'all-failed';
    hint = '三引擎全部失败。请确认 dashboard 服务已启动（默认 http://127.0.0.1:7421），且 OpenClaw 宿主 / QMD / Neo4j 依赖可用。';
  } else if (allEmpty) {
    conclusion = 'all-empty';
    hint = '三引擎均返回空结果。可能原因：1) lossless-claw 未摄入过相关会话数据（lcm.db 为空或无匹配）；2) QMD 未索引项目代码（运行 qmd index）；3) Neo4j 无图节点数据。';
  } else if (hasError) {
    conclusion = 'partial-failure';
    hint = '部分引擎失败。查看各引擎 error 字段定位问题。';
  } else {
    conclusion = 'ok';
  }

  return {
    lcmCount,
    qmdCount,
    neo4jCount,
    lcmError,
    qmdError,
    neo4jError,
    conclusion,
    hint,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * 执行 benchmark 压测。
 * 串行执行每条 fixture，采集延迟/结果数/docids/召回率。
 */
export async function runBenchmark(opts: BenchmarkRunnerOptions): Promise<BenchmarkResult> {
  // 加载测试集
  let fixtures: BenchmarkFixture[];
  let fixtureSetId: string;
  if (opts.fixtures) {
    fixtures = opts.fixtures;
    fixtureSetId = 'custom';
  } else if (opts.fixtureSetId) {
    fixtureSetId = opts.fixtureSetId;
    fixtures = await loadFixtures(opts.fixtureSetId, opts.beirSubsetSize, opts.onDownloadProgress);
  } else {
    fixtureSetId = 'project-scenarios';
    fixtures = PROJECT_SCENARIO_FIXTURES;
  }

  const limit = opts.limit ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const rerank = opts.rerank ?? true;
  const mode = opts.mode ?? 'rest';
  const engine = opts.engine ?? 'qmd';
  const dashboardBaseUrl = opts.dashboardBaseUrl ?? 'http://127.0.0.1:7421';
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
          const ceOrQmd = engine === 'ce'
            ? await ceSearch(dashboardBaseUrl, fixture, limit, timeoutMs)
            : await restQuery(opts.qmdBaseUrl, fixture, limit, timeoutMs, rerank);
          const { items: rawItems, latencyMs, diagnostics: ceDiagnostics } = ceOrQmd as
            { items: QmdQueryItem[]; latencyMs: number; diagnostics?: CeEngineDiagnostics };

          const returnedDocIds = rawItems
            .map((r) => r.docid)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          const expectedDocIds = fixture.expectedDocIds ?? [];
          const hasExpected = expectedDocIds.length > 0;
          const { recall, precision, f1 } = hasExpected
            ? calcRecallPrecision(returnedDocIds, expectedDocIds)
            : { recall: 0, precision: 0, f1: 0 };

          // 提取多轮会话元数据（若 fixture 来自 ce-multi-turn 展开）
          const multiTurnMeta = fixture as BenchmarkFixture & {
            turnIndex?: number;
            turnTotal?: number;
            role?: string;
            sessionId?: string;
          };

          // CE 引擎三引擎全空时标记失败 + 附带诊断
          const ceAllEmpty = ceDiagnostics?.conclusion === 'all-empty' || ceDiagnostics?.conclusion === 'all-failed';
          const success = !ceAllEmpty;

          const result: BenchmarkItemResult = {
            fixtureId: fixture.id,
            query: fixture.query,
            category: fixture.category,
            success,
            latencyMs,
            resultCount: rawItems.length,
            returnedDocIds,
            expectedDocIds,
            recall: hasExpected ? recall : null,
            precision: hasExpected ? precision : null,
            f1: hasExpected ? f1 : null,
            error: ceAllEmpty
              ? `CE 三引擎${ceDiagnostics?.conclusion === 'all-failed' ? '全部失败' : '均返回空结果'}: ${ceDiagnostics?.hint ?? ''}`
              : undefined,
            topResults: rawItems.slice(0, limit).map((r) => ({
              docid: r.docid,
              file: r.file,
              title: r.title,
              score: r.score,
              snippet: r.snippet,
              source: r.source,
            })),
            turnIndex: multiTurnMeta.turnIndex,
            turnTotal: multiTurnMeta.turnTotal,
            turnRole: multiTurnMeta.role,
            sessionId: multiTurnMeta.sessionId,
            ceDiagnostics,
          };
          return result;
        } catch (err) {
          const multiTurnMeta = fixture as BenchmarkFixture & {
            turnIndex?: number;
            turnTotal?: number;
            role?: string;
            sessionId?: string;
          };
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
            turnIndex: multiTurnMeta.turnIndex,
            turnTotal: multiTurnMeta.turnTotal,
            turnRole: multiTurnMeta.role,
            sessionId: multiTurnMeta.sessionId,
          };
          return result;
        }
      }).map(async (resultPromise, i) => {
        // 保持批内并发，但每条 resolve 后立即触发 onProgress（JS 单线程，++ 原子安全）
        const result = await resultPromise;
        completed++;
        opts.onProgress?.(completed, fixtures.length, batch[i], result);
        return result;
      }),
    );
    items.push(...batchResults);
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

  // 多轮会话统计（CE 能力维度）
  const sessionItems = items.filter((i) => i.sessionId);
  const sessionIds = [...new Set(sessionItems.map((i) => i.sessionId!))];
  const multiTurnSessions: MultiTurnSessionStats[] = sessionIds.map((sid) => {
    const sessionItemsSorted = sessionItems
      .filter((i) => i.sessionId === sid)
      .sort((a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0));
    const turnCount = sessionItemsSorted.length;
    const successCount = sessionItemsSorted.filter((i) => i.success).length;
    const latencies = sessionItemsSorted.map((i) => i.latencyMs);
    const recallByTurn = sessionItemsSorted.map((i) => i.recall);
    const resultCountByTurn = sessionItemsSorted.map((i) => i.resultCount);
    const latencyByTurn = latencies;
    const avgLatencyMs = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

    // 上下文连贯性：followup 轮召回 opening 轮文档的比例
    let coherenceScore: number | null = null;
    const openingTurn = sessionItemsSorted.find((i) => i.turnRole === 'opening');
    const followupTurns = sessionItemsSorted.filter((i) => i.turnRole === 'followup' || i.turnRole === 'recall');
    if (openingTurn && openingTurn.returnedDocIds.length > 0 && followupTurns.length > 0) {
      const openingDocs = new Set(openingTurn.returnedDocIds);
      const coherenceScores = followupTurns
        .filter((t) => t.returnedDocIds.length > 0)
        .map((t) => {
          const overlap = t.returnedDocIds.filter((d) => openingDocs.has(d)).length;
          return overlap / openingTurn.returnedDocIds.length;
        });
      if (coherenceScores.length > 0) {
        coherenceScore = coherenceScores.reduce((a, b) => a + b, 0) / coherenceScores.length;
      }
    }

    return {
      sessionId: sid,
      category: sessionItemsSorted[0]?.category ?? '',
      turnCount,
      successCount,
      avgLatencyMs,
      recallByTurn,
      resultCountByTurn,
      latencyByTurn,
      coherenceScore,
    };
  });

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
    multiTurnSessions: multiTurnSessions.length > 0 ? multiTurnSessions : undefined,
  };

  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    runId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    options: {
      qmdBaseUrl: opts.qmdBaseUrl,
      mode,
      engine,
      limit,
      timeoutMs,
      rerank,
      concurrency,
      fixtureSetId,
      fixturesSource: opts.fixtures ? 'custom' : fixtureSetId,
      fixturesCount: fixtures.length,
    },
    summary,
    items,
  };
}
