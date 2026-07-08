/**
 * QMD MCP 测试路由（v1.2.0 性能诊断）。
 *
 * - GET  /api/qmd-test/default-url —— 返回系统配置中的 QMD MCP 地址（供前端默认填充）
 * - POST /api/qmd-test            —— 执行 N 次查询，统计平均/最小/最大延迟
 *
 * 两种测试模式：
 * - mode='rest'（默认）：直接 POST /query，不经 MCP transport 层，更稳定快速
 *   QMD server.ts 提供 REST 端点 POST /query（或 /search），直接调用 store.search()
 * - mode='mcp'：完整 MCP initialize + tools/call "query"，用于测试 MCP 协议本身
 *   注意：MCP WebStandardStreamableHTTPServerTransport 的 enableJsonResponse 模式
 *   在长时间运行的 tools/call（含 LLM rerank）时可能挂起超时
 *
 * 设计：
 * - 默认 baseUrl 优先级：用户入参 > 系统配置 (openclaw.json: retrieval.qmd.mcpEndpoint) > env.QMD_URL > 127.0.0.1:8081
 * - 单次超时可配置（timeoutMs，默认 10s），范围 1s-60s
 * - 10x/20x 串行执行（并行会让 QMD 内部排队，无法反映真实单次延迟）
 * - 完整日志输出 + 查询结果输出
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
// 类型定义
// ---------------------------------------------------------------------------

type TestMode = 'rest' | 'mcp';

interface McpQueryResult {
  success: boolean;
  latencyMs: number;
  resultCount: number;
  error?: string;
  initMs?: number;
  queryMs?: number;
}

interface QmdTestLogEntry {
  timestamp: number;
  iteration: number;
  phase: 'initialize' | 'query' | 'error' | 'info';
  message: string;
  durationMs?: number;
}

interface QmdTestQueryItem {
  docid?: string;
  file?: string;
  title?: string;
  score?: number;
  snippet?: string;
  line?: number;
}

interface QmdTestQueryResult {
  iteration: number;
  success: boolean;
  count: number;
  items: QmdTestQueryItem[];
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
// QMD MCP 测试使用的 protocolVersion（与 qmd test/mcp.test.ts 一致）
const MCP_PROTOCOL_VERSION = '2025-03-26';

// ---------------------------------------------------------------------------
// REST 模式：直接 POST /query（不经 MCP transport 层）
// ---------------------------------------------------------------------------

/** REST /query 请求 —— 直接调用 QMD store.search()，无需 initialize 握手 */
async function restQuery(
  baseUrl: string,
  query: string,
  limit: number,
  timeoutMs: number,
  log: (phase: QmdTestLogEntry['phase'], message: string, durationMs?: number) => void,
): Promise<{ count: number; items: QmdTestQueryItem[] }> {
  const start = Date.now();
  const body = {
    searches: [
      { type: 'lex', query },
      { type: 'vec', query },
    ],
    limit,
    minScore: 0,
    rerank: true,
  };
  log('query', `POST ${baseUrl}/query (REST, q="${query.slice(0, 60)}")`);
  const resp = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`REST /query HTTP ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { results?: any[] };
  let items: QmdTestQueryItem[] = [];
  if (data?.results && Array.isArray(data.results)) {
    items = data.results.map((r: any) => ({
      docid: r?.docid ?? r?.id ?? '',
      file: r?.file ?? r?.path ?? '',
      title: r?.title ?? '',
      score: typeof r?.score === 'number' ? r.score : undefined,
      snippet: typeof r?.snippet === 'string' ? r.snippet.slice(0, 500) : (typeof r?.content === 'string' ? r.content.slice(0, 500) : ''),
      line: typeof r?.line === 'number' ? r.line : undefined,
    }));
  }

  const elapsed = Date.now() - start;
  log('query', `REST /query 成功，返回 ${items.length} 条结果`, elapsed);
  return { count: items.length, items };
}

// ---------------------------------------------------------------------------
// MCP 模式：完整 initialize + tools/call "query"
// ---------------------------------------------------------------------------

/** MCP initialize 握手 —— 每次测试都新建 session（模拟冷启动） */
async function mcpInitialize(
  baseUrl: string,
  timeoutMs: number,
  log: (phase: QmdTestLogEntry['phase'], message: string, durationMs?: number) => void,
): Promise<string> {
  const start = Date.now();
  const body = {
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'lcm-dashboard-qmd-test', version: '1.0' },
    },
  };
  log('initialize', `POST ${baseUrl}/mcp (initialize)`);
  const resp = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`initialize HTTP ${resp.status} ${resp.statusText}`);
  }
  const sid = resp.headers.get('mcp-session-id');
  if (!sid) {
    throw new Error('initialize: 缺少 mcp-session-id 响应头');
  }
  const elapsed = Date.now() - start;
  log('initialize', `initialize 成功，sessionId=${sid.slice(0, 12)}...`, elapsed);
  return sid;
}

/** MCP tools/call "query" —— 模拟 assemble L2_qmd 调用，返回结果数 + 原始结果 */
async function mcpQuery(
  baseUrl: string,
  sid: string,
  query: string,
  limit: number,
  timeoutMs: number,
  log: (phase: QmdTestLogEntry['phase'], message: string, durationMs?: number) => void,
): Promise<{ count: number; items: QmdTestQueryItem[] }> {
  const start = Date.now();
  const body = {
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
  };
  log('query', `POST ${baseUrl}/mcp (tools/call: query, q="${query.slice(0, 60)}")`);
  const resp = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sid,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`query HTTP ${resp.status} ${resp.statusText}`);
  }

  // 处理 SSE / JSON 两种响应格式
  const contentType = resp.headers.get('content-type') ?? '';
  let parsed: any;
  if (contentType.includes('text/event-stream')) {
    const text = await resp.text();
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

  if (parsed?.error) {
    throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);
  }
  if (parsed?.result?.isError) {
    const errText = parsed?.result?.content?.[0]?.text ?? 'unknown MCP error';
    throw new Error(`MCP isError=true: ${errText}`);
  }

  // 解析查询结果
  // MCP query 工具返回 content[0].text 为格式化文本摘要，structuredContent.results 为结构化数据
  let items: QmdTestQueryItem[] = [];
  const structured = parsed?.result?.structuredContent?.results;
  if (Array.isArray(structured)) {
    items = structured.map((r: any) => ({
      docid: r?.docid ?? r?.id ?? '',
      file: r?.file ?? r?.path ?? '',
      title: r?.title ?? '',
      score: typeof r?.score === 'number' ? r.score : undefined,
      snippet: typeof r?.snippet === 'string' ? r.snippet.slice(0, 500) : (typeof r?.content === 'string' ? r.content.slice(0, 500) : ''),
      line: typeof r?.line === 'number' ? r.line : undefined,
    }));
  } else {
    // fallback: 尝试从 content[0].text 解析
    const contentText = parsed?.result?.content?.[0]?.text;
    if (contentText) {
      try {
        const arr = JSON.parse(contentText);
        if (Array.isArray(arr)) {
          items = arr.map((r: any) => ({
            docid: r?.docid ?? r?.id ?? '',
            file: r?.file ?? r?.path ?? '',
            title: r?.title ?? '',
            score: typeof r?.score === 'number' ? r.score : undefined,
            snippet: typeof r?.snippet === 'string' ? r.snippet.slice(0, 500) : (typeof r?.content === 'string' ? r.content.slice(0, 500) : ''),
            line: typeof r?.line === 'number' ? r.line : undefined,
          }));
        }
      } catch {
        // 非 JSON 格式，items 保持空
      }
    }
  }

  const elapsed = Date.now() - start;
  log('query', `MCP query 成功，返回 ${items.length} 条结果`, elapsed);
  return { count: items.length, items };
}

// ---------------------------------------------------------------------------
// 单次测试执行
// ---------------------------------------------------------------------------

/** 执行单次完整测试 */
async function runSingleTest(
  baseUrl: string,
  query: string,
  limit: number,
  timeoutMs: number,
  mode: TestMode,
  iteration: number,
  logs: QmdTestLogEntry[],
): Promise<{ result: McpQueryResult; queryResult: QmdTestQueryResult }> {
  const totalStart = Date.now();
  const logFn = (phase: QmdTestLogEntry['phase'], message: string, durationMs?: number) => {
    logs.push({ timestamp: Date.now(), iteration, phase, message, durationMs });
  };

  logFn('info', `===== 迭代 #${iteration} 开始 (mode=${mode}) =====`);

  // REST 模式：直接 POST /query，不需要 initialize
  if (mode === 'rest') {
    let queryData: { count: number; items: QmdTestQueryItem[] };
    try {
      queryData = await restQuery(baseUrl, query, limit, timeoutMs, logFn);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logFn('error', `REST /query 失败: ${errMsg}`);
      return {
        result: {
          success: false,
          latencyMs: Date.now() - totalStart,
          resultCount: 0,
          error: `REST /query 失败: ${errMsg}`,
        },
        queryResult: { iteration, success: false, count: 0, items: [] },
      };
    }

    const totalMs = Date.now() - totalStart;
    logFn('info', `迭代 #${iteration} 完成，总耗时 ${totalMs}ms`);
    return {
      result: {
        success: true,
        latencyMs: totalMs,
        resultCount: queryData.count,
        queryMs: totalMs,
      },
      queryResult: {
        iteration,
        success: true,
        count: queryData.count,
        items: queryData.items,
      },
    };
  }

  // MCP 模式：initialize + tools/call
  let sid: string;
  let initMs: number;
  try {
    const initStart = Date.now();
    sid = await mcpInitialize(baseUrl, timeoutMs, logFn);
    initMs = Date.now() - initStart;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logFn('error', `initialize 失败: ${errMsg}`);
    return {
      result: {
        success: false,
        latencyMs: Date.now() - totalStart,
        resultCount: 0,
        error: `initialize 失败: ${errMsg}`,
      },
      queryResult: { iteration, success: false, count: 0, items: [] },
    };
  }

  let queryMs: number;
  let queryData: { count: number; items: QmdTestQueryItem[] };
  try {
    const queryStart = Date.now();
    queryData = await mcpQuery(baseUrl, sid, query, limit, timeoutMs, logFn);
    queryMs = Date.now() - queryStart;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logFn('error', `query 失败: ${errMsg}`);
    return {
      result: {
        success: false,
        latencyMs: Date.now() - totalStart,
        resultCount: 0,
        initMs,
        error: `query 失败: ${errMsg}`,
      },
      queryResult: { iteration, success: false, count: 0, items: [] },
    };
  }

  const totalMs = Date.now() - totalStart;
  logFn('info', `迭代 #${iteration} 完成，总耗时 ${totalMs}ms (init=${initMs}ms, query=${queryMs}ms)`);

  return {
    result: {
      success: true,
      latencyMs: totalMs,
      resultCount: queryData.count,
      initMs,
      queryMs,
    },
    queryResult: {
      iteration,
      success: true,
      count: queryData.count,
      items: queryData.items,
    },
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
  timeoutMs?: number;
  mode?: TestMode;
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
    const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const mode: TestMode = body.mode === 'mcp' ? 'mcp' : 'rest';

    // 参数校验
    if (!query) {
      reply.code(400);
      return { ok: false, error: 'query 不能为空' };
    }
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 50) {
      reply.code(400);
      return { ok: false, error: 'iterations 必须为 1-50 之间的整数' };
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
      reply.code(400);
      return { ok: false, error: 'timeoutMs 必须在 1000-60000 之间' };
    }

    // baseUrl：用户输入 > 系统配置 > 兜底
    const finalBaseUrl = baseUrl || resolveDefaultQmdUrl();
    if (!/^https?:\/\/.+/.test(finalBaseUrl)) {
      reply.code(400);
      return { ok: false, error: `baseUrl 格式无效: ${finalBaseUrl}` };
    }

    req.log.info(
      { baseUrl: finalBaseUrl, query, iterations, limit, timeoutMs, mode },
      'QMD MCP 测试开始',
    );

    const results: McpQueryResult[] = [];
    const queryResults: QmdTestQueryResult[] = [];
    const logs: QmdTestLogEntry[] = [];
    const testStart = Date.now();

    logs.push({ timestamp: testStart, iteration: 0, phase: 'info', message: `测试启动: baseUrl=${finalBaseUrl}, query="${query}", iterations=${iterations}, limit=${limit}, timeout=${timeoutMs}ms, mode=${mode}` });

    for (let i = 0; i < iterations; i++) {
      const { result, queryResult } = await runSingleTest(
        finalBaseUrl,
        query,
        limit,
        timeoutMs,
        mode,
        i + 1,
        logs,
      );
      results.push(result);
      queryResults.push(queryResult);
      req.log.info(
        { iteration: i + 1, success: result.success, latencyMs: result.latencyMs, error: result.error },
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

    // 拆分阶段统计（仅成功的样本，MCP 模式才有 initMs）
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

    logs.push({ timestamp: Date.now(), iteration: 0, phase: 'info', message: `测试完成: 成功 ${successCount}/${iterations}, 平均 ${avgLatencyMs}ms, 总耗时 ${totalMs}ms` });

    return {
      ok: true,
      baseUrl: finalBaseUrl,
      query,
      iterations,
      limit,
      timeoutMs,
      mode,
      totalMs,
      successCount,
      successRate,
      avgLatencyMs,
      minLatencyMs,
      maxLatencyMs,
      avgInitMs,
      avgQueryMs,
      results,
      logs,
      queryResults,
    };
  });
}
