/**
 * graph-memory-pro HTTP API 代理 —— 前端 API 封装与类型定义。
 *
 * 所有调用通过 dashboard 后端的 /api/gm-pro/proxy/* 代理到 graph-memory-pro 的 HTTP 服务器。
 * 后端代理负责鉴权（x-auth-token + Basic Auth）、路径白名单、超时控制，前端仅需调用此模块的薄封装函数。
 *
 * v2.9.0: graph-memory-pro 所有路由已升级为 auth: "plugin"（SDK 必填），
 * 后端代理对所有路径统一携带 x-auth-token 头。
 *
 * 代理路径映射：
 *   前端调用           → 后端代理                      → graph-memory-pro
 *   fetchGmProStatus() → GET /api/gm-pro/proxy/status  → GET {GM_PRO_HTTP_URL}/api/status
 *   fetchGmProStats()  → GET /api/gm-pro/proxy/stats   → GET {GM_PRO_HTTP_URL}/api/stats
 */
import { apiGet } from './client';

// ─── 通用代理响应 ──────────────────────────────────────────────────────────

export interface GmProProxyResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  detail?: unknown;
}

// ─── 状态 ──────────────────────────────────────────────────────────────────

/**
 * graph-memory-pro /api/status 响应体。
 *
 * 实际返回格式（来自 graph-memory-pro src/routes/crud.ts handleStatus）：
 *   { status: "connected" | "disconnected", version: "2.3.2" }
 */
export interface GmProStatus {
  status?: 'connected' | 'disconnected';
  version?: string;
  error?: string;
  [key: string]: unknown;
}

export function fetchGmProStatus(): Promise<GmProProxyResponse<GmProStatus>> {
  return apiGet<GmProProxyResponse<GmProStatus>>('/api/gm-pro/proxy/status');
}

// ─── 统计 ──────────────────────────────────────────────────────────────────

/**
 * graph-memory-pro /api/stats 响应体。
 *
 * 实际返回格式（来自 graph-memory-pro src/routes/crud.ts handleStats）：
 *   { nodeCount: number, edgeCount: number }
 */
export interface GmProStats {
  nodeCount?: number;
  edgeCount?: number;
  [key: string]: unknown;
}

export function fetchGmProStats(): Promise<GmProProxyResponse<GmProStats>> {
  return apiGet<GmProProxyResponse<GmProStats>>('/api/gm-pro/proxy/stats');
}

// ─── 健康 ──────────────────────────────────────────────────────────────────

/**
 * graph-memory-pro /api/health 响应体（GraphHealthReport）。
 *
 * 来自 graph-memory-pro src/graph/maintenance/health.ts healthCheck()。
 * 路由层额外追加 connectionPool 和 circuitBreakers 字段。
 */
export interface GmProHealth {
  timestamp?: number;
  nodes?: { total: number; active: number; superseded: number; transitional: number };
  edges?: { total: number; byType: Record<string, number> };
  isolatedNodes?: number;
  highStaleNodes?: number;
  communities?: number;
  avgPageRank?: number;
  topNodes?: Array<{ id: string; name: string; pagerank: number }>;
  anomalies?: string[];
  connectionPool?: unknown;
  circuitBreakers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function fetchGmProHealth(): Promise<GmProProxyResponse<GmProHealth>> {
  return apiGet<GmProProxyResponse<GmProHealth>>('/api/gm-pro/proxy/health');
}

// ─── 图谱搜索 ──────────────────────────────────────────────────────────────

export interface GmProSearchParams {
  /** 搜索关键词（对应 graph-memory-pro 的 query 参数） */
  query?: string;
  /** 返回条数上限（默认 10，最大 50） */
  limit?: number;
}

export interface GmProSearchResult {
  nodes?: Array<{
    id: string;
    type?: string;
    name?: string;
    description?: string;
    [key: string]: unknown;
  }>;
  edges?: Array<{
    source: string;
    target: string;
    type?: string;
    [key: string]: unknown;
  }>;
  total?: number;
}

export function fetchGmProSearch(params: GmProSearchParams = {}): Promise<GmProProxyResponse<GmProSearchResult>> {
  const qs = new URLSearchParams();
  if (params.query) qs.set('query', params.query);
  if (params.limit != null) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return apiGet<GmProProxyResponse<GmProSearchResult>>(`/api/gm-pro/proxy/search${query ? `?${query}` : ''}`);
}

// ─── 节点详情 ──────────────────────────────────────────────────────────────

export interface GmProNode {
  id: string;
  type?: string;
  name?: string;
  description?: string;
  content?: string;
  pagerank?: number;
  communityId?: string;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export function fetchGmProNode(id: string): Promise<GmProProxyResponse<GmProNode>> {
  return apiGet<GmProProxyResponse<GmProNode>>(`/api/gm-pro/proxy/nodes/${encodeURIComponent(id)}`);
}

// ─── Top 节点 ──────────────────────────────────────────────────────────────

export interface GmProTopResult {
  nodes?: Array<{
    id: string;
    type?: string;
    name?: string;
    pagerank?: number;
    [key: string]: unknown;
  }>;
}

export function fetchGmProTop(limit?: number): Promise<GmProProxyResponse<GmProTopResult>> {
  const qs = limit != null ? `?limit=${limit}` : '';
  return apiGet<GmProProxyResponse<GmProTopResult>>(`/api/gm-pro/proxy/top${qs}`);
}

// ─── 按类型查节点 ──────────────────────────────────────────────────────────

/** graph-memory-pro 支持的节点类型（仅 TASK / SKILL / EVENT） */
export type GmProNodeType = 'TASK' | 'SKILL' | 'EVENT';

/** graph-memory-pro /api/nodes-by-type/:type 响应体 */
export interface GmProNodesByTypeResult {
  type?: string;
  nodes?: Array<{
    id: string;
    type?: string;
    name?: string;
    description?: string;
    [key: string]: unknown;
  }>;
}

export function fetchGmProNodesByType(
  type: GmProNodeType,
  limit?: number,
): Promise<GmProProxyResponse<GmProNodesByTypeResult>> {
  const qs = limit != null ? `?limit=${limit}` : '';
  return apiGet<GmProProxyResponse<GmProNodesByTypeResult>>(
    `/api/gm-pro/proxy/nodes-by-type/${encodeURIComponent(type)}${qs}`,
  );
}

// ─── 指标 ──────────────────────────────────────────────────────────────────

export interface GmProMetrics {
  [key: string]: unknown;
}

export function fetchGmProMetrics(): Promise<GmProProxyResponse<GmProMetrics>> {
  return apiGet<GmProProxyResponse<GmProMetrics>>('/api/gm-pro/proxy/metrics');
}

// ─── Dirty Nodes ───────────────────────────────────────────────────────────

/** graph-memory-pro /api/maintain/dirty-nodes 响应体 */
export interface GmProDirtyNodesResult {
  count?: number;
  nodeIds?: string[];
}

export function fetchGmProDirtyNodes(): Promise<GmProProxyResponse<GmProDirtyNodesResult>> {
  return apiGet<GmProProxyResponse<GmProDirtyNodesResult>>('/api/gm-pro/proxy/maintain/dirty-nodes');
}

// ─── Auto Tuner 状态 ───────────────────────────────────────────────────────

export interface GmProAutoTunerState {
  [key: string]: unknown;
}

export function fetchGmProAutoTunerState(): Promise<GmProProxyResponse<GmProAutoTunerState>> {
  return apiGet<GmProProxyResponse<GmProAutoTunerState>>('/api/gm-pro/proxy/auto-tuner/state');
}

// ─── Association Matrix 状态 ───────────────────────────────────────────────

export interface GmProAssociationMatrixState {
  [key: string]: unknown;
}

export function fetchGmProAssociationMatrixState(): Promise<GmProProxyResponse<GmProAssociationMatrixState>> {
  return apiGet<GmProProxyResponse<GmProAssociationMatrixState>>('/api/gm-pro/proxy/association-matrix/state');
}

// ─── Doctor 诊断 ───────────────────────────────────────────────────────────

export interface GmProDoctorResult {
  [key: string]: unknown;
}

export function fetchGmProDoctor(): Promise<GmProProxyResponse<GmProDoctorResult>> {
  return apiGet<GmProProxyResponse<GmProDoctorResult>>('/api/gm-pro/proxy/doctor');
}

// ─── Usage 统计 ────────────────────────────────────────────────────────────

export interface GmProUsage {
  [key: string]: unknown;
}

export function fetchGmProUsage(): Promise<GmProProxyResponse<GmProUsage>> {
  return apiGet<GmProProxyResponse<GmProUsage>>('/api/gm-pro/proxy/usage');
}