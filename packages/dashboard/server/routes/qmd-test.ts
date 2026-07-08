/**
 * QMD MCP 测试路由（v1.2.0 性能诊断）。
 *
 * - GET  /api/qmd-test/default-url —— 返回系统配置中的 QMD MCP 地址（供前端默认填充）
 * - POST /api/qmd-test            —— 执行 N 次完整 initialize + query，统计平均/最小/最大延迟
 *
 * 设计：
 * - 默认 baseUrl 优先级：用户入参 > 系统配置 (openclaw.json: retrieval.qmd.mcpEndpoint) > env.QMD_URL > 127.0.0.1:8081
 * - 每次测试均执行完整 MCP initialize 握手 + tools/call "query"，模拟冷启动场景
 * - 单次超时 = 10s（远大于 assemble 路径的 3s，避免误判慢但可用的 MCP）
 * - 10x/20x 串行执行（并行会让 QMD 内部排队，无法反映真实单次延迟）
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

function getConfigPath(): string {
  return resolve(homedir(), '.openclaw', 'openclaw.json');
}

/** 读取 openclaw.json 中的 lcm-graph-extra 插件配置 */
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

/** 从插件配置中提取 QMD MCP base URL（去掉 /mcp 后缀，与 src/index.ts 一致） */
function resolveDefaultQmdUrl(): string {
  // 1. 系统配置：retrieval.qmd.mcpEndpoint
  const cfg = readPluginConfig();
  const retrieval = (cfg.retrieval ?? {}) as Record<string, unknown>;
  const qmd = (retrieval.qmd ?? {}) as Record<string, unknown>;
  const mcpEndpoint = typeof qmd.mcpEndpoint === 'string' ? qmd.mcpEndpoint : '';
  if (mcpEndpoint) {
    return mcpEndpoint.replace(/\/mcp$/, '');
  }
  // 2. 环境变量 QMD_URL
  if (process.env.QMD_URL) return process.env.QMD_URL;
  // 3. 兜底
  return 'http://127.0.0.1:8081';
}

// ---------------------------------------------------------------------------
// QMD MCP 客户端（独立实现，不复用 qmd-client.ts，避免缓存影响测试结果）
// ---------------------------------------------------------------------------

const TEST_TIMEOUT_MS = 10_000;

interface McpQueryResult {
  success: boolean;
  latencyMs: number;
  resultCount: number;
  error?: string;
  /** initialize 耗时（ms），便于拆分握手 vs 查询 */
  initMs?: number;
  /** tools/call 耗时（ms） */
  queryMs?: number;
}

/** MCP initialize 握手 —— 每次测试都新建 session（模拟冷启动） */
async function mcpInitialize(baseUrl: string): Promise<string> {
  const start = Date.now();
  const resp = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {} },
        clientInfo: { name: 'lcm-dashboard-qmd-test', version: '1.0' },
      },
    }),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`initialize HTTP ${resp.status} ${resp.statusText}`);
  }
  const sid = resp.headers.get('mcp-session-id');
  if (!sid) {
    throw new Error('initialize: 缺少 mcp-session-id 响应头');
  }
  // 记录握手耗时（不返回，由调用方拿 start 计算）
  void start;
  return sid;
}

/** MCP tools/call "query" —— 模拟 assemble L2_qmd 调用 */
async function mcpQuery(baseUrl: string, sid: string, query: string, limit: number): Promise<number> {
  const resp = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sid,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          searches: [
            { type: 'lex', query },
            { type: 'vec', query },
          ],
          limit,
          minScore: 0,
          rerank: true,
        },
      },
    }),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`query HTTP ${resp.status} ${resp.statusText}`);
  }

  // 处理 SSE / JSON 两种响应格式
  const contentType = resp.headers.get('content-type') ?? '';
  let text: string;
  let parsed: any;
  if (contentType.includes('text/event-stream')) {
    text = await resp.text();
    const dataLines = text
      .split('\n')
      .filter((l: string) => l.startsWith('data: '))
      .map((l: string) => l.slice(6));
    if (dataLines.length === 0) {
      throw new Error('SSE 响应无 data 行');
    }
    parsed = JSON.parse(dataLines[dataLines.length - 1]);
  } else {
    parsed = await resp.json();
  }

  // 检查 MCP 错误
  if (parsed?.error) {
    throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);
  }
  if (parsed?.result?.isError) {
    const errText = parsed?.result?.content?.[0]?.text ?? 'unknown MCP error';
    throw new Error(`MCP isError=true: ${errText}`);
  }

  // 解析结果数量
  const contentText = parsed?.result?.content?.[0]?.text;
  if (!contentText) return 0;
  try {
    const arr = JSON.parse(contentText);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/** 执行单次完整测试（initialize + query） */
async function runSingleTest(baseUrl: string, query: string, limit: number): Promise<McpQueryResult> {
  const totalStart = Date.now();
  let sid: string;
  let initMs: number;
  try {
    const initStart = Date.now();
    sid = await mcpInitialize(baseUrl);
    initMs = Date.now() - initStart;
  } catch (e) {
    return {
      success: false,
      latencyMs: Date.now() - totalStart,
      resultCount: 0,
      error: `initialize 失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let queryMs: number;
  let resultCount: number;
  try {
    const queryStart = Date.now();
    resultCount = await mcpQuery(baseUrl, sid, query, limit);
    queryMs = Date.now() - queryStart;
  } catch (e) {
    return {
      success: false,
      latencyMs: Date.now() - totalStart,
      resultCount: 0,
      initMs,
      error: `query 失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    success: true,
    latencyMs: Date.now() - totalStart,
    resultCount,
    initMs,
    queryMs,
  };
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

interface QmdTestRequest {
  baseUrl?: string;
  query?: string;
  iterations?: number;
  limit?: number;
}

export async function registerQmdTestRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/qmd-test/default-url —— 返回系统配置中的 QMD MCP 地址
  app.get('/api/qmd-test/default-url', async (req, _reply) => {
    try {
      const defaultUrl = resolveDefaultQmdUrl();
      return { ok: true, defaultUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, '/api/qmd-test/default-url 读取失败');
      return { ok: false, defaultUrl: 'http://127.0.0.1:8081', error: msg };
    }
  });

  // POST /api/qmd-test —— 执行 N 次反复测试
  app.post('/api/qmd-test', async (req, reply) => {
    const body = (req.body as QmdTestRequest) ?? {};
    const baseUrl = (body.baseUrl ?? '').trim();
    const query = (body.query ?? '').trim();
    const iterations = Number(body.iterations);
    const limit = Number(body.limit) || 5;

    // 参数校验
    if (!query) {
      reply.code(400);
      return { ok: false, error: 'query 不能为空' };
    }
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 50) {
      reply.code(400);
      return { ok: false, error: 'iterations 必须为 1-50 之间的整数' };
    }

    // baseUrl：用户输入 > 系统配置 > 兜底
    const finalBaseUrl = baseUrl || resolveDefaultQmdUrl();
    if (!/^https?:\/\/.+/.test(finalBaseUrl)) {
      reply.code(400);
      return { ok: false, error: `baseUrl 格式无效: ${finalBaseUrl}` };
    }

    req.log.info(
      { baseUrl: finalBaseUrl, query, iterations, limit },
      'QMD MCP 测试开始',
    );

    const results: McpQueryResult[] = [];
    const testStart = Date.now();

    for (let i = 0; i < iterations; i++) {
      const r = await runSingleTest(finalBaseUrl, query, limit);
      results.push(r);
      req.log.info(
        { iteration: i + 1, success: r.success, latencyMs: r.latencyMs, error: r.error },
        'QMD MCP 测试迭代完成',
      );
    }

    const totalMs = Date.now() - testStart;
    const successResults = results.filter((r) => r.success);
    const successCount = successResults.length;
    const latencies = successResults.map((r) => r.latencyMs);

    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    const minLatencyMs = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLatencyMs = latencies.length > 0 ? Math.max(...latencies) : 0;
    const successRate = iterations > 0 ? Math.round((successCount / iterations) * 100) : 0;

    // 拆分阶段统计（仅成功的样本）
    const initMsList = successResults
      .map((r) => r.initMs)
      .filter((v): v is number => typeof v === 'number');
    const queryMsList = successResults
      .map((r) => r.queryMs)
      .filter((v): v is number => typeof v === 'number');

    const avgInitMs = initMsList.length > 0
      ? Math.round(initMsList.reduce((a, b) => a + b, 0) / initMsList.length)
      : 0;
    const avgQueryMs = queryMsList.length > 0
      ? Math.round(queryMsList.reduce((a, b) => a + b, 0) / queryMsList.length)
      : 0;

    return {
      ok: true,
      baseUrl: finalBaseUrl,
      query,
      iterations,
      limit,
      totalMs,
      successCount,
      successRate,
      avgLatencyMs,
      minLatencyMs,
      maxLatencyMs,
      avgInitMs,
      avgQueryMs,
      results,
    };
  });
}
