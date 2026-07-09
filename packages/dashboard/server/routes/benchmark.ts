/**
 * Benchmark 路由 —— CE 引擎能力压测（v2.3.0）。
 *
 * 端点：
 * - GET  /api/benchmark/fixture-sets      —— 列出所有测试集（project-scenarios / ce-multi-turn / beir-*）
 * - GET  /api/benchmark/fixtures          —— 获取指定测试集的 fixtures（?set=<id>）
 * - GET  /api/benchmark/beir/status       —— BEIR 数据集缓存状态
 * - POST /api/benchmark/beir/download     —— 触发 BEIR 数据集下载
 * - GET  /api/benchmark/default-url       —— 系统配置中的 QMD 地址
 * - POST /api/benchmark/run               —— 执行压测，返回完整 BenchmarkResult
 * - GET  /api/benchmark/history           —— 获取历史运行列表（不含 items 详情）
 * - GET  /api/benchmark/report/:id        —— 获取完整结果（含 items）
 * - GET  /api/benchmark/report/:id/markdown —— 下载 Markdown 报告
 *
 * v2.3.0 新增：
 * - 多测试集选择（fixtureSetId: project-scenarios / ce-multi-turn / beir-nfcorpus / beir-scifact）
 * - CE 引擎查询（engine: 'qmd' 直查 QMD /query，'ce' 走 dashboard /api/memory/search 多引擎并行）
 * - BEIR 在线下载 + 缓存状态查询
 *
 * 设计：
 * - runner 本身不依赖 fastify，路由层只做参数校验和持久化
 * - 内存存储（MAX_HISTORY=20），进程重启后清空；后续可扩展 SQLite
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  FIXTURE_SETS,
  PROJECT_SCENARIO_FIXTURES,
  CE_MULTI_TURN_FIXTURES,
  flattenMultiTurnFixtures,
  fixtureCategoryStats,
  type BenchmarkFixture,
  type FixtureSetId,
} from '../lib/benchmark-fixtures.js';
import { listBeirDatasets, isBeirCached, getBeirCacheInfo, downloadBeirDataset } from '../lib/benchmark-beir.js';
import { runBenchmark, type BenchmarkResult } from '../lib/benchmark.js';
import {
  exportMarkdownReport,
  saveBenchmarkResult,
  getBenchmarkHistory,
  getBenchmarkResult,
} from '../lib/benchmark-report.js';

// ---------------------------------------------------------------------------
// 配置读取（与 qmd-test.ts 一致，提取 QMD MCP 地址作为默认 base URL）
// ---------------------------------------------------------------------------

function getConfigPath(): string {
  return resolve(homedir(), '.openclaw', 'openclaw.json');
}

function readPluginConfigs(): Record<string, unknown> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const entriesConfig = parsed?.plugins?.entries?.['lcm-graph-extra']?.config;
    if (entriesConfig && typeof entriesConfig === 'object') {
      return entriesConfig as Record<string, unknown>;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveDefaultQmdUrl(): string {
  const cfg = readPluginConfigs();
  const retrieval = (cfg.retrieval ?? {}) as Record<string, unknown>;
  const qmd = (retrieval.qmd ?? {}) as Record<string, unknown>;
  const mcpEndpoint = typeof qmd.mcpEndpoint === 'string' ? qmd.mcpEndpoint : '';
  if (mcpEndpoint) {
    return mcpEndpoint.replace(/\/mcp$/, '');
  }
  if (process.env.QMD_URL) return process.env.QMD_URL;
  return 'http://127.0.0.1:8081';
}

function resolveDefaultDashboardUrl(): string {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL;
  return 'http://127.0.0.1:7421';
}

// ---------------------------------------------------------------------------
// 测试集元数据辅助
// ---------------------------------------------------------------------------

/** 校验 fixtureSetId 合法性 */
function isValidFixtureSetId(id: unknown): id is FixtureSetId {
  return typeof id === 'string'
    && (id === 'project-scenarios' || id === 'ce-multi-turn' || id === 'beir-nfcorpus' || id === 'beir-scifact');
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

interface BenchmarkRunRequest {
  baseUrl?: string;
  fixtures?: BenchmarkFixture[];
  fixtureSetId?: string;
  beirSubsetSize?: number;
  limit?: number;
  timeoutMs?: number;
  rerank?: boolean;
  mode?: 'rest' | 'mcp';
  engine?: 'qmd' | 'ce';
  dashboardBaseUrl?: string;
  concurrency?: number;
}

export async function registerBenchmarkRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/benchmark/fixture-sets —— 所有测试集元数据
  app.get('/api/benchmark/fixture-sets', async (_req, _reply) => {
    // 合并 BEIR 缓存状态
    const beirStatus = listBeirDatasets();
    const sets = FIXTURE_SETS.map((s) => {
      if (s.type === 'beir') {
        const status = beirStatus.find((b) => b.name === s.id.replace('beir-', ''));
        return {
          ...s,
          cached: status?.cached ?? false,
          cacheInfo: status?.cacheInfo ?? null,
          defaultSubsetSize: status?.defaultSubsetSize,
        };
      }
      return { ...s, cached: true };
    });
    return { ok: true, fixtureSets: sets };
  });

  // GET /api/benchmark/fixtures —— 指定测试集的 fixtures（?set=<id>，默认 project-scenarios）
  app.get('/api/benchmark/fixtures', async (req, reply) => {
    const setParam = (req.query as Record<string, unknown>)?.set;
    const fixtureSetId: FixtureSetId = isValidFixtureSetId(setParam)
      ? setParam
      : 'project-scenarios';

    // BEIR 测试集需要下载，这里只返回元数据，实际 fixtures 由 /run 时加载
    if (fixtureSetId === 'beir-nfcorpus' || fixtureSetId === 'beir-scifact') {
      const datasetName = fixtureSetId.replace('beir-', '');
      const cached = isBeirCached(datasetName);
      const cacheInfo = getBeirCacheInfo(datasetName);
      return {
        ok: true,
        fixtureSetId,
        type: 'beir',
        cached,
        cacheInfo,
        message: cached
          ? `BEIR ${datasetName} 已缓存，运行压测时自动加载`
          : `BEIR ${datasetName} 未缓存，运行压测时将自动下载（首次约 30s）`,
      };
    }

    // 内置测试集直接返回 fixtures
    let fixtures: BenchmarkFixture[];
    if (fixtureSetId === 'ce-multi-turn') {
      fixtures = flattenMultiTurnFixtures(CE_MULTI_TURN_FIXTURES);
    } else {
      fixtures = PROJECT_SCENARIO_FIXTURES;
    }

    return {
      ok: true,
      fixtureSetId,
      fixtures,
      categoryStats: fixtureCategoryStats(fixtures),
      totalCount: fixtures.length,
    };
  });

  // GET /api/benchmark/beir/status —— BEIR 数据集缓存状态
  app.get('/api/benchmark/beir/status', async (_req, _reply) => {
    return { ok: true, datasets: listBeirDatasets() };
  });

  // POST /api/benchmark/beir/download —— 触发 BEIR 下载（预下载，避免压测时阻塞）
  app.post('/api/benchmark/beir/download', async (req, reply) => {
    const body = (req.body as { dataset?: string } | undefined) ?? {};
    const dataset = (body.dataset ?? '').trim();
    if (dataset !== 'nfcorpus' && dataset !== 'scifact') {
      reply.code(400);
      return { ok: false, error: 'dataset 必须为 nfcorpus 或 scifact' };
    }
    if (isBeirCached(dataset)) {
      return { ok: true, dataset, cached: true, message: `${dataset} 已缓存，跳过下载` };
    }
    try {
      await downloadBeirDataset(dataset);
      return { ok: true, dataset, cached: true, cacheInfo: getBeirCacheInfo(dataset) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ dataset, err: msg }, 'BEIR 下载失败');
      reply.code(500);
      return { ok: false, dataset, error: msg };
    }
  });

  // GET /api/benchmark/default-url —— 系统配置中的 QMD 地址 + dashboard 地址
  app.get('/api/benchmark/default-url', async (_req, _reply) => {
    return {
      ok: true,
      defaultQmdUrl: resolveDefaultQmdUrl(),
      defaultDashboardUrl: resolveDefaultDashboardUrl(),
    };
  });

  // GET /api/benchmark/history —— 历史列表
  app.get('/api/benchmark/history', async (_req, _reply) => {
    return { ok: true, history: getBenchmarkHistory() };
  });

  // GET /api/benchmark/report/:id —— 完整结果
  app.get('/api/benchmark/report/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getBenchmarkResult(id);
    if (!result) {
      reply.code(404);
      return { ok: false, error: `未找到运行 ID: ${id}` };
    }
    return { ok: true, result };
  });

  // GET /api/benchmark/report/:id/markdown —— 下载 Markdown 报告
  app.get('/api/benchmark/report/:id/markdown', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getBenchmarkResult(id);
    if (!result) {
      reply.code(404);
      return { ok: false, error: `未找到运行 ID: ${id}` };
    }
    const md = exportMarkdownReport(result);
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="benchmark-${id}.md"`);
    return md;
  });

  // POST /api/benchmark/run —— 执行压测
  app.post('/api/benchmark/run', async (req, reply) => {
    const body = (req.body as BenchmarkRunRequest) ?? {};
    const baseUrlInput = (body.baseUrl ?? '').trim();
    const limitRaw = body.limit;
    const limit = (limitRaw !== undefined && limitRaw !== null && !Number.isNaN(Number(limitRaw)))
      ? Number(limitRaw)
      : 5;
    const timeoutMs = Number(body.timeoutMs) || 10_000;
    const rerank = body.rerank !== false; // 默认 true
    const mode: 'rest' | 'mcp' = body.mode === 'mcp' ? 'mcp' : 'rest';
    const engine: 'qmd' | 'ce' = body.engine === 'ce' ? 'ce' : 'qmd';
    const concurrency = Math.max(1, Math.min(10, Number(body.concurrency) || 1));
    const customFixtures = Array.isArray(body.fixtures) ? body.fixtures : undefined;
    const fixtureSetIdRaw = body.fixtureSetId;
    const beirSubsetSizeRaw = body.beirSubsetSize;
    const beirSubsetSize = (beirSubsetSizeRaw !== undefined && beirSubsetSizeRaw !== null && !Number.isNaN(Number(beirSubsetSizeRaw)))
      ? Math.max(10, Math.min(1000, Number(beirSubsetSizeRaw)))
      : undefined;
    const dashboardBaseUrlInput = (body.dashboardBaseUrl ?? '').trim();

    // 参数校验
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
      reply.code(400);
      return { ok: false, error: 'timeoutMs 必须在 1000-60000 之间' };
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      reply.code(400);
      return { ok: false, error: 'limit 必须为 1-50 之间的整数' };
    }
    if (customFixtures && customFixtures.length === 0) {
      reply.code(400);
      return { ok: false, error: '自定义 fixtures 不能为空数组' };
    }
    if (customFixtures && customFixtures.length > 200) {
      reply.code(400);
      return { ok: false, error: '自定义 fixtures 数量不能超过 200' };
    }
    // fixtureSetId 校验（仅当未传 customFixtures 时校验）
    let fixtureSetId: FixtureSetId | undefined;
    if (!customFixtures) {
      if (fixtureSetIdRaw !== undefined && !isValidFixtureSetId(fixtureSetIdRaw)) {
        reply.code(400);
        return { ok: false, error: `fixtureSetId 无效: ${String(fixtureSetIdRaw)}（合法值: project-scenarios / ce-multi-turn / beir-nfcorpus / beir-scifact）` };
      }
      fixtureSetId = isValidFixtureSetId(fixtureSetIdRaw) ? fixtureSetIdRaw : 'project-scenarios';
    }

    // baseUrl 默认值：用户输入 > 系统配置 > 兜底
    const finalBaseUrl = baseUrlInput || resolveDefaultQmdUrl();
    if (!/^https?:\/\/.+/.test(finalBaseUrl)) {
      reply.code(400);
      return { ok: false, error: `baseUrl 格式无效: ${finalBaseUrl}` };
    }
    // dashboardBaseUrl（engine='ce' 时使用）
    const finalDashboardUrl = dashboardBaseUrlInput || resolveDefaultDashboardUrl();
    if (engine === 'ce' && !/^https?:\/\/.+/.test(finalDashboardUrl)) {
      reply.code(400);
      return { ok: false, error: `dashboardBaseUrl 格式无效: ${finalDashboardUrl}` };
    }

    // 校验自定义 fixtures 基本结构
    if (customFixtures) {
      for (const f of customFixtures) {
        if (!f.id || typeof f.id !== 'string') {
          reply.code(400);
          return { ok: false, error: 'fixture.id 必须为非空字符串' };
        }
        if (!f.query || typeof f.query !== 'string') {
          reply.code(400);
          return { ok: false, error: `fixture ${f.id} 的 query 必须为非空字符串` };
        }
      }
    }

    req.log.info(
      {
        baseUrl: finalBaseUrl,
        engine,
        fixtureSetId: fixtureSetId ?? 'custom',
        limit,
        timeoutMs,
        rerank,
        mode,
        concurrency,
        beirSubsetSize,
        fixturesSource: customFixtures ? 'custom' : (fixtureSetId ?? 'project-scenarios'),
      },
      'Benchmark 开始执行',
    );

    try {
      const result: BenchmarkResult = await runBenchmark({
        qmdBaseUrl: finalBaseUrl,
        fixtures: customFixtures,
        fixtureSetId,
        beirSubsetSize,
        limit,
        timeoutMs,
        rerank,
        mode,
        engine,
        dashboardBaseUrl: finalDashboardUrl,
        concurrency,
      });

      // 持久化到内存历史
      saveBenchmarkResult(result);

      req.log.info(
        {
          runId: result.runId,
          fixtureSetId: result.options.fixtureSetId,
          engine: result.options.engine,
          totalFixtures: result.summary.totalFixtures,
          successCount: result.summary.successCount,
          successRate: result.summary.successRate,
          totalDurationMs: result.summary.totalDurationMs,
          avgLatency: result.summary.latency.avg,
          p95Latency: result.summary.latency.p95,
          multiTurnSessions: result.summary.multiTurnSessions?.length ?? 0,
        },
        'Benchmark 完成',
      );

      return { ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, 'Benchmark 执行失败');
      reply.code(500);
      return { ok: false, error: msg };
    }
  });
}
