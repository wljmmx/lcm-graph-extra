/**
 * 后端测试：benchmark 路由 + lib（runner + report）。
 *
 * 覆盖：
 * - lib/benchmark.ts: runBenchmark 执行逻辑、召回率计算、tokens 估算、按分类统计
 * - lib/benchmark-report.ts: JSON/Markdown 导出、内存历史存储
 * - routes/benchmark.ts: 5 个端点的参数校验、执行、查询、下载
 *
 * mock global.fetch 以模拟 QMD /query 响应（避免真实 QMD 依赖）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { runBenchmark, type BenchmarkResult } from '../../server/lib/benchmark.js';
import {
  exportJsonReport,
  exportMarkdownReport,
  saveBenchmarkResult,
  getBenchmarkHistory,
  getBenchmarkResult,
} from '../../server/lib/benchmark-report.js';
import {
  BUILTIN_FIXTURES,
  CE_MULTI_TURN_FIXTURES,
  flattenMultiTurnFixtures,
  FIXTURE_SETS,
  type BenchmarkFixture,
} from '../../server/lib/benchmark-fixtures.js';
import { registerBenchmarkRoutes } from '../../server/routes/benchmark.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

interface MockFetchOpts {
  /** 每次查询返回的固定结果集 */
  results?: Array<Record<string, unknown>>;
  /** 延迟 ms（fetch 前等待） */
  delayMs?: number;
  /** 是否返回非 ok 响应（HTTP 错误） */
  httpStatus?: number;
  /** 抛出错误而非返回响应 */
  throwError?: string;
}

function mockQmdFetch(opts: MockFetchOpts = {}): void {
  const results = opts.results ?? [
    { docid: 'doc-1', file: 'src/a.ts', title: 'A 文档', score: 0.9, snippet: 'test snippet content' },
    { docid: 'doc-2', file: 'src/b.md', title: 'B 文档', score: 0.7, snippet: 'another snippet' },
  ];
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit & { signal?: AbortSignal }) => {
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    if (opts.throwError) {
      throw new Error(opts.throwError);
    }
    if (opts.httpStatus && opts.httpStatus !== 200) {
      return {
        ok: false,
        status: opts.httpStatus,
        statusText: 'Mock Error',
        headers: { get: () => null },
        json: async () => ({ error: 'mock error' }),
      } as unknown as Response;
    }
    // 忽略 url，统一返回 results（benchmark runner 只调 /query）
    void url;
    void init;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({ results }),
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof global.fetch;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerBenchmarkRoutes(app);
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockQmdFetch(); // 默认成功 mock
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// 测试 fixtures
// ---------------------------------------------------------------------------

const customFixtures: BenchmarkFixture[] = [
  {
    id: 't-001',
    query: '知识图谱',
    category: 'knowledge',
    expectedDocIds: ['doc-1', 'doc-2'],
    description: '召回率测试 - 全部命中',
  },
  {
    id: 't-002',
    query: '配置项',
    category: 'config',
    expectedDocIds: ['doc-missing'], // 未命中
    description: '召回率测试 - 部分命中',
  },
  {
    id: 't-003',
    query: '无期望结果',
    category: 'knowledge',
    description: '无 expectedDocIds - 跳过召回率评估',
  },
];

// ---------------------------------------------------------------------------
// lib/benchmark.ts 测试
// ---------------------------------------------------------------------------

describe('lib/benchmark.ts - runBenchmark', () => {
  it('使用内置 fixtures 时返回 builtin 来源标记', async () => {
    // 只用前 2 条内置 fixtures 加速测试（通过 fixtures 参数覆盖）
    const fixtures = BUILTIN_FIXTURES.slice(0, 2);
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.options.fixturesSource).toBe('custom');
    expect(result.options.fixturesCount).toBe(2);
    expect(result.summary.totalFixtures).toBe(2);
    expect(result.summary.successCount).toBe(2);
    expect(result.summary.successRate).toBe(1);
    expect(result.items).toHaveLength(2);
  });

  it('每条用例返回正确的结果数和 docids', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.summary.totalFixtures).toBe(3);
    // 每条返回 2 个结果
    for (const item of result.items) {
      expect(item.success).toBe(true);
      expect(item.resultCount).toBe(2);
      expect(item.returnedDocIds).toEqual(expect.arrayContaining(['doc-1', 'doc-2']));
    }
  });

  it('计算召回率/精确率/F1（有 expectedDocIds 的用例）', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    // t-001: expected=[doc-1, doc-2], returned=[doc-1, doc-2] → recall=1, precision=1, f1=1
    const t1 = result.items.find((i) => i.fixtureId === 't-001')!;
    expect(t1.recall).toBe(1);
    expect(t1.precision).toBe(1);
    expect(t1.f1).toBe(1);

    // t-002: expected=[doc-missing], returned=[doc-1, doc-2] → recall=0, precision=0, f1=0
    const t2 = result.items.find((i) => i.fixtureId === 't-002')!;
    expect(t2.recall).toBe(0);
    expect(t2.precision).toBe(0);
    expect(t2.f1).toBe(0);

    // t-003: 无 expectedDocIds → recall=null
    const t3 = result.items.find((i) => i.fixtureId === 't-003')!;
    expect(t3.recall).toBeNull();
    expect(t3.precision).toBeNull();
    expect(t3.f1).toBeNull();

    // summary.recall 应该只统计 t-001 和 t-002
    expect(result.summary.recall).not.toBeNull();
    expect(result.summary.recall!.evaluated).toBe(2);
    // avg recall = (1 + 0) / 2 = 0.5
    expect(result.summary.recall!.avgRecall).toBeCloseTo(0.5, 2);
  });

  it('延迟统计包含 P50/P90/P95/P99 和标准差', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    const lat = result.summary.latency;
    expect(lat.min).toBeGreaterThanOrEqual(0);
    expect(lat.max).toBeGreaterThanOrEqual(lat.min);
    expect(lat.avg).toBeGreaterThanOrEqual(lat.min);
    expect(lat.avg).toBeLessThanOrEqual(lat.max);
    expect(lat.p50).toBeGreaterThanOrEqual(lat.min);
    expect(lat.p99).toBeGreaterThanOrEqual(lat.p50);
    expect(lat.std).toBeGreaterThanOrEqual(0);
  });

  it('tokens 估算：输入非 0，输出非 0（有 snippet 时）', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.summary.estimatedTokens.input).toBeGreaterThan(0);
    expect(result.summary.estimatedTokens.output).toBeGreaterThan(0);
    expect(result.summary.estimatedTokens.total).toBe(
      result.summary.estimatedTokens.input + result.summary.estimatedTokens.output,
    );
  });

  it('压缩率在 0-1 之间', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.summary.compressionRatio).toBeGreaterThan(0);
    expect(result.summary.compressionRatio).toBeLessThan(1);
  });

  it('按分类统计：每个分类有 total/success/avgLatencyMs', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    // customFixtures 有 2 个 knowledge + 1 个 config
    const cats = result.summary.byCategory;
    expect(cats).toHaveLength(2);
    const knowledgeCat = cats.find((c) => c.category === 'knowledge')!;
    expect(knowledgeCat.total).toBe(2);
    expect(knowledgeCat.success).toBe(2);
    expect(knowledgeCat.successRate).toBe(1);
    expect(knowledgeCat.avgLatencyMs).toBeGreaterThanOrEqual(0);
    const configCat = cats.find((c) => c.category === 'config')!;
    expect(configCat.total).toBe(1);
  });

  it('fetch 失败时该用例标记为失败，其他用例继续', async () => {
    // 让 fetch 永远抛错
    global.fetch = vi.fn().mockRejectedValue(new Error('QMD 连接失败')) as unknown as typeof global.fetch;
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.summary.successCount).toBe(0);
    expect(result.summary.successRate).toBe(0);
    for (const item of result.items) {
      expect(item.success).toBe(false);
      expect(item.error).toContain('QMD 连接失败');
      expect(item.recall).toBeNull();
    }
    // 失败时 latencyMs = timeoutMs
    for (const item of result.items) {
      expect(item.latencyMs).toBe(5000);
    }
  });

  it('HTTP 非 200 时用例失败', async () => {
    mockQmdFetch({ httpStatus: 500 });
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: [customFixtures[0]],
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.summary.successCount).toBe(0);
    expect(result.items[0].error).toContain('500');
  });

  it('onProgress 回调被调用', async () => {
    const progressCalls: Array<{ completed: number; total: number }> = [];
    await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
      concurrency: 1,
      onProgress: (completed, total) => {
        progressCalls.push({ completed, total });
      },
    });
    // 3 条用例，串行 → 3 次回调
    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[0].completed).toBe(1);
    expect(progressCalls[0].total).toBe(3);
    expect(progressCalls[2].completed).toBe(3);
  });

  it('runId 包含时间戳和随机后缀', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: [customFixtures[0]],
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]+$/);
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// lib/benchmark-report.ts 测试
// ---------------------------------------------------------------------------

describe('lib/benchmark-report.ts', () => {
  let sampleResult: BenchmarkResult;

  beforeEach(async () => {
    // 生成一个样本结果供报告测试使用
    sampleResult = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: customFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
  });

  it('exportJsonReport 返回合法 JSON 字符串', () => {
    const json = exportJsonReport(sampleResult);
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.runId).toBe(sampleResult.runId);
    expect(parsed.summary.totalFixtures).toBe(3);
    expect(parsed.items).toHaveLength(3);
  });

  it('exportMarkdownReport 包含核心章节', () => {
    const md = exportMarkdownReport(sampleResult);
    expect(md).toContain('# Benchmark 报告');
    expect(md).toContain('## 配置');
    expect(md).toContain('## 概览');
    expect(md).toContain('## 延迟分布');
    expect(md).toContain('## Tokens 消耗');
    expect(md).toContain('## 压缩率');
    expect(md).toContain('## 召回率评估');
    expect(md).toContain('## 按分类统计');
    expect(md).toContain('## 逐条详情');
    // 配置表
    expect(md).toContain('QMD Base URL');
    expect(md).toContain('查询模式');
    // 延迟分布表
    expect(md).toContain('P50');
    expect(md).toContain('P99');
    // 召回率
    expect(md).toContain('平均召回率');
  });

  it('exportMarkdownReport 在无召回率数据时显示提示', async () => {
    const noRecallFixtures: BenchmarkFixture[] = [
      { id: 'nr-1', query: 'test', category: 'knowledge' },
    ];
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: noRecallFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    const md = exportMarkdownReport(result);
    expect(md).toContain('无 `expectedDocIds` 标注的用例');
  });

  it('exportMarkdownReport 包含失败用例章节（当有失败时）', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('QMD 不可达')) as unknown as typeof global.fetch;
    const failedResult = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: [customFixtures[0]],
      limit: 5,
      timeoutMs: 5000,
    });
    const md = exportMarkdownReport(failedResult);
    expect(md).toContain('## 失败用例');
    expect(md).toContain('QMD 不可达');
  });

  it('saveBenchmarkResult + getBenchmarkHistory + getBenchmarkResult 内存存储', () => {
    saveBenchmarkResult(sampleResult);
    const history = getBenchmarkHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
    const latest = history[0];
    expect(latest.runId).toBe(sampleResult.runId);
    expect(latest.summary.totalFixtures).toBe(3);
    expect(latest.options.qmdBaseUrl).toBe('http://127.0.0.1:8081');

    // getBenchmarkResult 返回完整结果
    const full = getBenchmarkResult(sampleResult.runId);
    expect(full).not.toBeNull();
    expect(full!.items).toHaveLength(3);
  });

  it('getBenchmarkResult 不存在的 runId 返回 null', () => {
    const result = getBenchmarkResult('non-existent-id');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// routes/benchmark.ts 测试
// ---------------------------------------------------------------------------

describe('routes/benchmark.ts', () => {
  it('GET /api/benchmark/fixtures 返回内置测试集', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/fixtures',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.fixtures)).toBe(true);
    expect(body.fixtures.length).toBeGreaterThanOrEqual(15); // 内置至少 15 条
    expect(body.totalCount).toBe(body.fixtures.length);
    expect(body.categoryStats).toBeDefined();
    // 至少包含 knowledge 和 mixed
    expect(body.categoryStats.knowledge).toBeGreaterThan(0);
    expect(body.categoryStats.mixed).toBeGreaterThan(0);
    // fixture 结构校验
    const f = body.fixtures[0];
    expect(f.id).toBeDefined();
    expect(f.query).toBeDefined();
    expect(f.category).toBeDefined();
  });

  it('GET /api/benchmark/default-url 返回默认地址', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/default-url',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.defaultQmdUrl).toBe('string');
    expect(body.defaultQmdUrl).toMatch(/^https?:\/\//);
    expect(typeof body.defaultDashboardUrl).toBe('string');
    expect(body.defaultDashboardUrl).toMatch(/^https?:\/\//);
  });

  it('GET /api/benchmark/history 初始为空或包含已保存项', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/history',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.history)).toBe(true);
  });

  it('POST /api/benchmark/run 执行压测并返回完整结果', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: customFixtures,
        limit: 5,
        timeoutMs: 5000,
        rerank: true,
        mode: 'rest',
        concurrency: 1,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toBeDefined();
    expect(body.result.summary.totalFixtures).toBe(3);
    expect(body.result.summary.successCount).toBe(3);
    expect(body.result.items).toHaveLength(3);
    // runId 应该可用来查报告
    expect(body.result.runId).toBeDefined();
  });

  it('POST /api/benchmark/run 未传 baseUrl 时使用系统默认值', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        fixtures: [customFixtures[0]],
        limit: 5,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result.options.qmdBaseUrl).toMatch(/^https?:\/\//);
  });

  it('POST /api/benchmark/run 未传 fixtures 时使用内置测试集', async () => {
    // 为加速，仅校验来源标记为 project-scenarios + 数量正确
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        limit: 3,
        timeoutMs: 5000,
        concurrency: 4, // 并发加速
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result.options.fixturesSource).toBe('project-scenarios');
    expect(body.result.options.fixtureSetId).toBe('project-scenarios');
    expect(body.result.options.fixturesCount).toBe(BUILTIN_FIXTURES.length);
    expect(body.result.summary.totalFixtures).toBe(BUILTIN_FIXTURES.length);
  });

  it('POST /api/benchmark/run 参数校验：limit 超出范围返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: [customFixtures[0]],
        limit: 0, // 非法
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('limit');
  });

  it('POST /api/benchmark/run 参数校验：timeoutMs 超出范围返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: [customFixtures[0]],
        limit: 5,
        timeoutMs: 100, // 非法（< 1000）
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('timeoutMs');
  });

  it('POST /api/benchmark/run 参数校验：空自定义 fixtures 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: [],
        limit: 5,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('不能为空');
  });

  it('POST /api/benchmark/run 参数校验：fixture 缺 id 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: [{ query: 'test', category: 'knowledge' }], // 缺 id
        limit: 5,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('id');
  });

  it('POST /api/benchmark/run 参数校验：非法 baseUrl 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'not-a-url',
        fixtures: [customFixtures[0]],
        limit: 5,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('baseUrl');
  });

  it('GET /api/benchmark/report/:id 返回完整结果', async () => {
    // 先执行一次压测以保存到历史
    const runRes = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: [customFixtures[0]],
        limit: 5,
        timeoutMs: 5000,
      },
    });
    const runBody = runRes.json();
    const runId = runBody.result.runId;

    // 查询报告
    const res = await app.inject({
      method: 'GET',
      url: `/api/benchmark/report/${encodeURIComponent(runId)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toBeDefined();
    expect(body.result.runId).toBe(runId);
    expect(body.result.items).toHaveLength(1);
  });

  it('GET /api/benchmark/report/:id 不存在的 runId 返回 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/report/non-existent',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('未找到');
  });

  it('GET /api/benchmark/report/:id/markdown 下载 Markdown 报告', async () => {
    // 先执行压测
    const runRes = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: [customFixtures[0]],
        limit: 5,
        timeoutMs: 5000,
      },
    });
    const runId = runRes.json().result.runId;

    const res = await app.inject({
      method: 'GET',
      url: `/api/benchmark/report/${encodeURIComponent(runId)}/markdown`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(`benchmark-${runId}.md`);
    const body = res.body;
    expect(body).toContain('# Benchmark 报告');
    expect(body).toContain('## 延迟分布');
  });

  it('GET /api/benchmark/report/:id/markdown 不存在的 runId 返回 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/report/non-existent/markdown',
    });
    expect(res.statusCode).toBe(404);
  });

  it('压测完成后历史列表包含该次运行', async () => {
    const runRes = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: [customFixtures[0]],
        limit: 5,
        timeoutMs: 5000,
      },
    });
    const runId = runRes.json().result.runId;

    const histRes = await app.inject({
      method: 'GET',
      url: '/api/benchmark/history',
    });
    const histBody = histRes.json();
    const found = histBody.history.find((h: { runId: string }) => h.runId === runId);
    expect(found).toBeDefined();
    expect(found.summary.totalFixtures).toBe(1);
  });

  it('fetch 全部失败时仍返回 200 + successRate=0 的结果', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('网络不可达')) as unknown as typeof global.fetch;
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtures: [customFixtures[0], customFixtures[1]],
        limit: 5,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result.summary.successRate).toBe(0);
    expect(body.result.summary.successCount).toBe(0);
    for (const item of body.result.items) {
      expect(item.success).toBe(false);
      expect(item.error).toContain('网络不可达');
    }
  });
});

// ---------------------------------------------------------------------------
// v2.3.0 新增：测试集元数据 + BEIR 状态 + 多轮会话 + CE 引擎
// ---------------------------------------------------------------------------

/** mock dashboard /api/memory/search（CE 三引擎并行） */
function mockCeFetch(opts: {
  lcm?: Array<Record<string, unknown>>;
  qmd?: Array<Record<string, unknown>>;
  neo4j?: Array<Record<string, unknown>>;
  throwError?: string;
} = {}): void {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (opts.throwError) throw new Error(opts.throwError);
    // CE 引擎调用 /api/memory/search?q=...&engines=all&limit=...
    if (typeof url === 'string' && url.includes('/api/memory/search')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        json: async () => ({
          results: {
            lcm: opts.lcm ?? [],
            qmd: opts.qmd ?? [
              { docid: 'doc-qmd-1', file: 'src/a.ts', title: 'QMD 文档', score: 0.9, snippet: 'qmd snippet' },
            ],
            neo4j: opts.neo4j ?? [],
          },
          total: (opts.lcm?.length ?? 0) + (opts.qmd?.length ?? 0) + (opts.neo4j?.length ?? 0),
        }),
      } as unknown as Response;
    }
    // 兜底：QMD /query
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({ results: opts.qmd ?? [] }),
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof global.fetch;
}

describe('v2.3.0 测试集元数据端点', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQmdFetch();
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    global.fetch = originalFetch;
  });

  it('GET /api/benchmark/fixture-sets 返回 4 个测试集', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/fixture-sets',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.fixtureSets).toHaveLength(4);
    const ids = body.fixtureSets.map((s: { id: string }) => s.id);
    expect(ids).toContain('project-scenarios');
    expect(ids).toContain('ce-multi-turn');
    expect(ids).toContain('beir-nfcorpus');
    expect(ids).toContain('beir-scifact');
    // project-scenarios 应有 count
    const ps = body.fixtureSets.find((s: { id: string }) => s.id === 'project-scenarios');
    expect(ps.count).toBeGreaterThan(0);
    expect(ps.cached).toBe(true);
    // beir 应有 requiresDownload
    const nf = body.fixtureSets.find((s: { id: string }) => s.id === 'beir-nfcorpus');
    expect(nf.requiresDownload).toBe(true);
  });

  it('GET /api/benchmark/fixtures?set=project-scenarios 返回 fixtures 列表', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/fixtures?set=project-scenarios',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.fixtureSetId).toBe('project-scenarios');
    expect(Array.isArray(body.fixtures)).toBe(true);
    expect(body.fixtures.length).toBe(BUILTIN_FIXTURES.length);
    expect(body.categoryStats).toBeDefined();
  });

  it('GET /api/benchmark/fixtures?set=ce-multi-turn 返回展开后的多轮 fixtures', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/fixtures?set=ce-multi-turn',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.fixtureSetId).toBe('ce-multi-turn');
    // 展开后的 fixtures 数量应大于会话数（每会话多轮）
    const expectedCount = flattenMultiTurnFixtures(CE_MULTI_TURN_FIXTURES).length;
    expect(body.fixtures).toHaveLength(expectedCount);
    // 应含 sessionId 和 turnIndex
    const withSession = body.fixtures.filter((f: { sessionId?: string }) => f.sessionId);
    expect(withSession.length).toBeGreaterThan(0);
  });

  it('GET /api/benchmark/fixtures?set=beir-nfcorpus 返回 BEIR 元数据（不预加载 fixtures）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/fixtures?set=beir-nfcorpus',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.fixtureSetId).toBe('beir-nfcorpus');
    expect(body.type).toBe('beir');
    // 应有 cached 字段和 message
    expect(typeof body.cached).toBe('boolean');
    expect(body.message).toBeDefined();
    // 不应返回 fixtures 数组（BEIR 不预加载）
    expect(body.fixtures).toBeUndefined();
  });

  it('GET /api/benchmark/fixtures 无 set 参数默认返回 project-scenarios', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/fixtures',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fixtureSetId).toBe('project-scenarios');
  });

  it('GET /api/benchmark/beir/status 返回 BEIR 数据集状态', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/benchmark/beir/status',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.datasets)).toBe(true);
    expect(body.datasets.length).toBe(2);
    const names = body.datasets.map((d: { name: string }) => d.name);
    expect(names).toContain('nfcorpus');
    expect(names).toContain('scifact');
  });

  it('POST /api/benchmark/beir/download 非法 dataset 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/beir/download',
      payload: { dataset: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('nfcorpus');
  });

  it('POST /api/benchmark/run 非法 fixtureSetId 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtureSetId: 'invalid-set',
        limit: 5,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('fixtureSetId');
  });

  it('POST /api/benchmark/run 指定 fixtureSetId=project-scenarios 执行压测', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        baseUrl: 'http://127.0.0.1:8081',
        fixtureSetId: 'project-scenarios',
        limit: 3,
        timeoutMs: 5000,
        concurrency: 4,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result.options.fixtureSetId).toBe('project-scenarios');
    expect(body.result.options.engine).toBe('qmd');
  });
});

describe('v2.3.0 lib/benchmark.ts 多轮会话分析', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQmdFetch();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('多轮会话 fixtures 展开后包含 sessionId/turnIndex/turnRole', async () => {
    const flattened = flattenMultiTurnFixtures(CE_MULTI_TURN_FIXTURES);
    expect(flattened.length).toBeGreaterThan(CE_MULTI_TURN_FIXTURES.length);
    // 第一条应有 sessionId
    const first = flattened[0];
    expect(first.sessionId).toBeDefined();
    expect(first.turnIndex).toBe(0);
    expect(first.turnTotal).toBeGreaterThan(0);
  });

  it('使用 ce-multi-turn 测试集时 summary.multiTurnSessions 有值', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtureSetId: 'ce-multi-turn',
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.options.fixtureSetId).toBe('ce-multi-turn');
    expect(result.summary.multiTurnSessions).toBeDefined();
    expect(result.summary.multiTurnSessions!.length).toBeGreaterThan(0);
    // 每条 item 应有 sessionId
    const withSession = result.items.filter((i) => i.sessionId);
    expect(withSession.length).toBe(result.items.length);
  });

  it('多轮会话统计包含 turnCount/recallByTurn/coherenceScore', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtureSetId: 'ce-multi-turn',
      limit: 5,
      timeoutMs: 5000,
    });
    const session = result.summary.multiTurnSessions![0];
    expect(session.sessionId).toBeDefined();
    expect(session.turnCount).toBeGreaterThan(0);
    expect(session.successCount).toBeGreaterThan(0);
    expect(Array.isArray(session.recallByTurn)).toBe(true);
    expect(session.recallByTurn.length).toBe(session.turnCount);
    expect(Array.isArray(session.latencyByTurn)).toBe(true);
    expect(Array.isArray(session.resultCountByTurn)).toBe(true);
    // coherenceScore 可为 null（无 expectedDocIds 时）或 number
    expect(session.coherenceScore === null || typeof session.coherenceScore === 'number').toBe(true);
  });

  it('非多轮会话测试集时 multiTurnSessions 为 undefined', async () => {
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtureSetId: 'project-scenarios',
      limit: 3,
      timeoutMs: 5000,
      concurrency: 4,
    });
    expect(result.summary.multiTurnSessions).toBeUndefined();
  });

  it('coherenceScore 计算：followup 轮召回 opening 轮文档', async () => {
    // 构造多轮会话 fixtures：opening 返回 doc-a，followup 也返回 doc-a
    const multiTurnFixtures: BenchmarkFixture[] = [
      {
        id: 'mt-test-t1',
        query: 'opening query',
        category: 'knowledge',
        expectedDocIds: ['doc-1'],
        // 模拟展开后的多轮元数据
        ...({ turnIndex: 0, turnTotal: 2, role: 'opening', sessionId: 'mt-test' } as Record<string, unknown>),
      } as BenchmarkFixture,
      {
        id: 'mt-test-t2',
        query: 'followup query',
        category: 'knowledge',
        expectedDocIds: ['doc-1'],
        ...({ turnIndex: 1, turnTotal: 2, role: 'followup', sessionId: 'mt-test' } as Record<string, unknown>),
      } as BenchmarkFixture,
    ];
    // mock fetch 返回 doc-1（与 opening 召回的文档相同）
    mockQmdFetch({
      results: [{ docid: 'doc-1', file: 'src/a.ts', title: 'A', score: 0.9, snippet: 'content' }],
    });
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: multiTurnFixtures,
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.summary.multiTurnSessions).toBeDefined();
    expect(result.summary.multiTurnSessions).toHaveLength(1);
    const session = result.summary.multiTurnSessions![0];
    // coherenceScore 应为 1（followup 召回了 opening 的所有文档）
    expect(session.coherenceScore).toBe(1);
  });
});

describe('v2.3.0 lib/benchmark.ts CE 引擎查询', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('engine=ce 时通过 dashboard /api/memory/search 查询三引擎并行', async () => {
    mockCeFetch({
      lcm: [{ content: 'lcm content', sessionId: 's1' }],
      qmd: [{ docid: 'doc-qmd-1', file: 'a.ts', title: 'QMD', score: 0.9, snippet: 'qmd' }],
      neo4j: [{ content: 'neo4j node', type: 'TASK', pagerank: 1.5 }],
    });
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      dashboardBaseUrl: 'http://127.0.0.1:7421',
      engine: 'ce',
      fixtures: [customFixtures[0]],
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.options.engine).toBe('ce');
    expect(result.summary.successCount).toBe(1);
    // 结果应合并三引擎
    const item = result.items[0];
    expect(item.resultCount).toBe(3); // lcm + qmd + neo4j
    // topResults 应有 source 标记
    const sources = (item.topResults ?? []).map((r) => r.source).filter(Boolean);
    expect(sources).toContain('lcm');
    expect(sources).toContain('qmd');
    expect(sources).toContain('neo4j');
  });

  it('engine=ce 时 CE 查询失败标记为失败', async () => {
    mockCeFetch({ throwError: 'dashboard 不可达' });
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      dashboardBaseUrl: 'http://127.0.0.1:7421',
      engine: 'ce',
      fixtures: [customFixtures[0]],
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.summary.successCount).toBe(0);
    expect(result.items[0].error).toContain('dashboard 不可达');
  });

  it('engine=ce 空结果时仍标记成功', async () => {
    mockCeFetch({ lcm: [], qmd: [], neo4j: [] });
    const result = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      dashboardBaseUrl: 'http://127.0.0.1:7421',
      engine: 'ce',
      fixtures: [customFixtures[0]],
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.summary.successCount).toBe(1);
    expect(result.items[0].resultCount).toBe(0);
  });

  it('POST /api/benchmark/run engine=ce 时传递 dashboardBaseUrl', async () => {
    mockCeFetch({
      qmd: [{ docid: 'doc-1', file: 'a.ts', title: 'A', score: 0.9, snippet: 's' }],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmark/run',
      payload: {
        engine: 'ce',
        dashboardBaseUrl: 'http://127.0.0.1:7421',
        fixtures: [customFixtures[0]],
        limit: 5,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result.options.engine).toBe('ce');
    expect(body.result.summary.successCount).toBe(1);
  });
});

describe('v2.3.0 lib/benchmark-report.ts CE 能力维度报告', () => {
  let multiTurnResult: BenchmarkResult;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQmdFetch({
      results: [{ docid: 'doc-1', file: 'src/a.ts', title: 'A', score: 0.9, snippet: 'content' }],
    });
    multiTurnResult = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtureSetId: 'ce-multi-turn',
      limit: 5,
      timeoutMs: 5000,
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('多轮会话报告包含 CE 能力维度章节', () => {
    const md = exportMarkdownReport(multiTurnResult);
    expect(md).toContain('## CE 能力维度');
    expect(md).toContain('## CE 多轮会话分析');
    expect(md).toContain('lossless-claw');
  });

  it('多轮会话报告包含会话汇总表', () => {
    const md = exportMarkdownReport(multiTurnResult);
    expect(md).toContain('### 会话汇总');
    expect(md).toContain('连贯性评分');
    expect(md).toContain('Recall 随轮次变化趋势');
  });

  it('多轮会话报告逐条详情包含会话/轮次列', () => {
    const md = exportMarkdownReport(multiTurnResult);
    expect(md).toContain('会话');
    expect(md).toContain('轮次');
    expect(md).toContain('角色');
  });

  it('BEIR 测试集报告包含 BEIR 说明', async () => {
    // 用 project-scenarios 模拟，但手动设置 fixtureSetId
    const beirResult = await runBenchmark({
      qmdBaseUrl: 'http://127.0.0.1:8081',
      fixtures: [customFixtures[0]],
      limit: 5,
      timeoutMs: 5000,
    });
    // 手动覆盖 options.fixtureSetId 模拟 BEIR 报告
    (beirResult.options as { fixtureSetId: string }).fixtureSetId = 'beir-nfcorpus';
    const md = exportMarkdownReport(beirResult);
    expect(md).toContain('BEIR nfcorpus');
    expect(md).toContain('NeurIPS 2021');
  });
});
