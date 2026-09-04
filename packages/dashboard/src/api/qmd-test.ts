/**
 * QMD MCP 测试 API 封装 + 类型定义。
 *
 * 与后端 server/routes/qmd-test.ts 的响应契约对齐。
 */
import { apiGet, apiPost } from './client';

/** 测试模式：'rest' 直连 POST /query（默认，稳定快速），'mcp' stateless 直接 tools/call "query"（无 initialize / 无会话） */
export type TestMode = 'rest' | 'mcp';

/** 单次测试结果摘要 */
export interface QmdTestIterationResult {
  success: boolean;
  latencyMs: number;
  resultCount: number;
  error?: string;
  initMs?: number;
  queryMs?: number;
}

/** 日志条目 */
export interface QmdTestLogEntry {
  timestamp: number;
  iteration: number;
  phase: 'initialize' | 'query' | 'error' | 'info';
  message: string;
  durationMs?: number;
}

/** 查询结果项 */
export interface QmdTestQueryItem {
  docid?: string;
  file?: string;
  title?: string;
  score?: number;
  snippet?: string;
  line?: number;
}

/** 单次迭代的查询结果 */
export interface QmdTestQueryResult {
  iteration: number;
  success: boolean;
  count: number;
  items: QmdTestQueryItem[];
}

/** POST /api/qmd-test 响应 */
export interface QmdTestResponse {
  ok: boolean;
  baseUrl: string;
  query: string;
  iterations: number;
  limit: number;
  timeoutMs: number;
  mode: TestMode;
  totalMs: number;
  successCount: number;
  successRate: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  avgInitMs: number;
  avgQueryMs: number;
  results: QmdTestIterationResult[];
  logs: QmdTestLogEntry[];
  queryResults: QmdTestQueryResult[];
  error?: string;
}

/** GET /api/qmd-test/default-url 响应 */
export interface QmdTestDefaultUrlResponse {
  ok: boolean;
  defaultUrl: string;
  error?: string;
}

/** 获取系统配置中的 QMD MCP 地址 */
export function fetchQmdTestDefaultUrl(): Promise<QmdTestDefaultUrlResponse> {
  return apiGet<QmdTestDefaultUrlResponse>('/api/qmd-test/default-url');
}

/** 执行 N 次反复测试 */
export function runQmdTest(
  baseUrl: string,
  query: string,
  iterations: number,
  limit: number = 5,
  timeoutMs: number = 10000,
  mode: TestMode = 'rest',
): Promise<QmdTestResponse> {
  return apiPost<QmdTestResponse>('/api/qmd-test', {
    baseUrl,
    query,
    iterations,
    limit,
    timeoutMs,
    mode,
  });
}
