/**
 * 经验管理 API 封装 + 类型定义。
 *
 * 与后端 server/routes/experience.ts 的响应契约对齐。
 * 写操作（forget / pin）通过 POST /api/mcp/invoke 走 MCP。
 */
import { apiGet, apiPost } from './client';

export interface ExperienceItem {
  id: string;
  title: string;
  summary: string;
  type: string;
  status: string;
  state: string | null;
  relevanceScore: number;
  qualityScore: number | null;
  matchCount: number;
  createdAt: number;
  lastValidatedAt: number | null;
  tags: { scenario: string[]; techStack: string[]; severity: string; free: string[] };
  projectName: string;
}

export interface ExperienceListResponse {
  total: number;
  items: ExperienceItem[];
}

export interface ExperienceDetail extends ExperienceItem {
  context: string;
  detail: string;
  source: string;
  sessionId: string;
}

export interface ExperienceGraph {
  nodes: Array<{ id: string; name: string; type: string; pagerank: number }>;
  edges: Array<{ source: string; target: string; type: string }>;
}

export interface QualityHistoryPoint {
  qualityScore: number | null;
  timestamp: number | null;
  delta?: number | null;
  source?: 'gm-pro' | 'local' | null;
}

export interface QualityHistoryResponse {
  points: QualityHistoryPoint[];
}

export interface ExperienceListParams {
  status?: string;
  type?: string;
  from?: number;
  to?: number;
  tag?: string;
  projectName?: string;
  limit?: number;
  offset?: number;
}

/** MCP 工具返回的结构化指标 */
export interface McpToolDetails {
  ok: boolean;
  error?: string;
  aborted?: boolean;
  metrics?: Record<string, unknown>;
}

export interface McpInvokeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * 从 MCP invoke 响应中提取 details 结构化指标。
 *
 * result 可能的形态：
 *   - { content: [...], details: { ok, metrics } }  — OpenClaw MCP host 直接透传
 *   - { ok, metrics }  — 已解包
 *   - undefined / null  — 无结构化数据
 */
export function extractDetails(result: unknown): McpToolDetails | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  // 形态 1：MCP 标准返回 { content, details }
  if (r.details && typeof r.details === 'object') {
    return r.details as McpToolDetails;
  }
  // 形态 2：直接包含 ok + metrics
  if (typeof r.ok === 'boolean' && r.metrics) {
    return r as unknown as McpToolDetails;
  }
  return null;
}

/** 从 MCP invoke 响应中提取 text 内容（用于 fallback 展示） */
export function extractText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    const textPart = (r.content as unknown[]).find(
      (c) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text',
    );
    if (textPart) return String((textPart as Record<string, unknown>).text ?? '');
  }
  if (typeof r.text === 'string') return r.text;
  return null;
}

/** 把列表参数编码为 query string */
function buildListQs(params: ExperienceListParams): string {
  const sp = new URLSearchParams();
  if (params.status) sp.set('status', params.status);
  if (params.type) sp.set('type', params.type);
  if (params.from !== undefined) sp.set('from', String(params.from));
  if (params.to !== undefined) sp.set('to', String(params.to));
  if (params.tag) sp.set('tag', params.tag);
  if (params.projectName) sp.set('projectName', params.projectName);
  if (params.limit !== undefined) sp.set('limit', String(params.limit));
  if (params.offset !== undefined) sp.set('offset', String(params.offset));
  return sp.toString();
}

export function fetchExperienceList(
  params: ExperienceListParams,
): Promise<ExperienceListResponse> {
  const qs = buildListQs(params);
  return apiGet<ExperienceListResponse>(`/api/experience/list?${qs}`);
}

export function fetchExperienceDetail(id: string): Promise<ExperienceDetail> {
  return apiGet<ExperienceDetail>(`/api/experience/${encodeURIComponent(id)}`);
}

export function fetchExperienceRelations(id: string): Promise<ExperienceGraph> {
  return apiGet<ExperienceGraph>(`/api/experience/relations/${encodeURIComponent(id)}`);
}

export function fetchQualityHistory(
  id: string,
): Promise<QualityHistoryResponse> {
  return apiGet<QualityHistoryResponse>(
    `/api/experience/${encodeURIComponent(id)}/quality-history`,
  );
}

/**
 * 调用 MCP 工具（写操作统一入口）。
 *
 * @param tool 工具名，如 'lcmg_forget' / 'lcmg_pin'
 * @param params 工具参数
 */
export function invokeMcpTool(
  tool: string,
  params: Record<string, unknown>,
): Promise<McpInvokeResponse> {
  return apiPost<McpInvokeResponse>('/api/mcp/invoke', { tool, params });
}
