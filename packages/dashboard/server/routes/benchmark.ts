/**
 * Benchmark 路由 —— 性能压测能力（v2.2.0）。
 *
 * 端点：
 * - GET  /api/benchmark/fixtures         —— 获取内置测试集列表 + 分类统计
 * - POST /api/benchmark/run              —— 执行压测，返回完整 BenchmarkResult
 * - GET  /api/benchmark/history          —— 获取历史运行列表（不含 items 详情）
 * - GET  /api/benchmark/report/:id      —— 获取完整结果（含 items）
 * - GET  /api/benchmark/report/:id/markdown —— 下载 Markdown 报告
 *
 * 设计：
 * - runner 本身不依赖 fastify，路由层只做参数校验和持久化
 * - 内存存储（MAX_HISTORY=20），进程重启后清空；后续可扩展 SQLite
 * - 支持自定义 fixtures（POST body 中传入），未传则用内置 BUILTIN_FIXTURES
 * - baseUrl 默认值优先级：用户入参 > 系统配置 > env.QMD_URL > 127.0.0.1:8081
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { BUILTIN_FIXTURES, fixtureCategoryStats, type BenchmarkFixture } from '../lib/benchmark-fixtures.js';
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

function readPluginConfig(): Record<string, unknown> {
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
  const cfg = readPluginConfig();
  const retrieval = (cfg.retrieval ?? {}) as Record<string, unknown>;
  const qmd = (retrieval.qmd ?? {}) as Record<string, unknown>;
  const mcpEndpoint = typeof qmd.mcpEndpoint === 'string' ? qmd.mcpEndpoint : '';
  if (mcpEndpoint) {
    return mcpEndpoint.replace(/\/mcp$/, '');
  }
  if (process.env.QMD_URL) return process.env.QMD_URL;
  return 'http://127.0.0.1:8081';
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

interface BenchmarkRunRequest {
  baseUrl?: string;
  fixtures?: BenchmarkFixture[];
  limit?: number;
  timeoutMs?: number;
  rerank?: boolean;
  mode?: 'rest' | 'mcp';
  concurrency?: number;
}

export async function registerBenchmarkRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/benchmark/fixtures —— 内置测试集
  app.get('/api/benchmark/fixtures', async (_req, _reply) => {
    return {
      ok: true,
      fixtures: BUILTIN_FIXTURES,
      categoryStats: fixtureCategoryStats(BUILTIN_FIXTURES),
      totalCount: BUILTIN_FIXTURES.length,
    };
  });

  // GET /api/benchmark/default-url —— 系统配置中的 QMD 地址
  app.get('/api/benchmark/default-url', async (_req, _reply) => {
    return { ok: true, defaultUrl: resolveDefaultQmdUrl() };
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
    const concurrency = Math.max(1, Math.min(10, Number(body.concurrency) || 1));
    const customFixtures = Array.isArray(body.fixtures) ? body.fixtures : undefined;

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

    // baseUrl 默认值：用户输入 > 系统配置 > 兜底
    const finalBaseUrl = baseUrlInput || resolveDefaultQmdUrl();
    if (!/^https?:\/\/.+/.test(finalBaseUrl)) {
      reply.code(400);
      return { ok: false, error: `baseUrl 格式无效: ${finalBaseUrl}` };
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
        limit,
        timeoutMs,
        rerank,
        mode,
        concurrency,
        fixturesSource: customFixtures ? 'custom' : 'builtin',
        fixturesCount: customFixtures?.length ?? BUILTIN_FIXTURES.length,
      },
      'Benchmark 开始执行',
    );

    try {
      const result: BenchmarkResult = await runBenchmark({
        qmdBaseUrl: finalBaseUrl,
        fixtures: customFixtures,
        limit,
        timeoutMs,
        rerank,
        mode,
        concurrency,
      });

      // 持久化到内存历史
      saveBenchmarkResult(result);

      req.log.info(
        {
          runId: result.runId,
          totalFixtures: result.summary.totalFixtures,
          successCount: result.summary.successCount,
          successRate: result.summary.successRate,
          totalDurationMs: result.summary.totalDurationMs,
          avgLatency: result.summary.latency.avg,
          p95Latency: result.summary.latency.p95,
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
