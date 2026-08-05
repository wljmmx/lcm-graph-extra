/**
 * graph-memory-pro HTTP API 代理 —— 前端 API 封装与类型定义。
 *
 * 所有调用通过 dashboard 后端的 /api/gm-pro/proxy/* 代理到 graph-memory-pro 的 HTTP 服务器。
 * 后端代理负责鉴权、路径白名单、超时控制，前端仅需调用此模块的薄封装函数。
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

export interface GmProStatus {
  ok?: boolean;
  version?: string;
  uptime?: number;
  neo4j?: { connected: boolean; uri?: string };
  [key: string]: unknown;
}

export function fetchGmProStatus(): Promise<GmProProxyResponse<GmProStatus>> {
  return apiGet<GmProProxyResponse<GmProStatus>>('/api/gm-pro/proxy/status');
}

// ─── 统计 ──────────────────────────────────────────────────────────────────

export interface GmProStats {
  nodeCount?: number;
  edgeCount?: number;
  pendingExperienceCount?: number;
  distilledExperienceCount?: number;
  [key: string]: unknown;
}

export function fetchGmProStats(): Promise<GmProProxyResponse<GmProStats>> {
  return apiGet<GmProProxyResponse<GmProStats>>('/api/gm-pro/proxy/stats');
}

// ─── 健康 ──────────────────────────────────────────────────────────────────

export interface GmProHealth {
  status?: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  checks?: Record<string, { ok: boolean; message?: string }>;
  [key: string]: unknown;
}

export function fetchGmProHealth(): Promise<GmProProxyResponse<GmProHealth>> {
  return apiGet<GmProProxyResponse<GmProHealth>>('/api/gm-pro/proxy/health');
}

// ─── 图谱搜索 ──────────────────────────────────────────────────────────────

export interface GmProSearchParams {
  q?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

export interface GmProSearchResult {
  nodes?: Array<{
    id: string;
    type?: string;
    name?: string;
    description?: string;
    [key: string]: unknown;
  }>;
  total?: number;
}

export function fetchGmProSearch(params: GmProSearchParams = {}): Promise<GmProProxyResponse<GmProSearchResult>> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.type) qs.set('type', params.type);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
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

export function fetchGmProNodesByType(
  type: string,
  limit?: number,
): Promise<GmProProxyResponse<GmProSearchResult>> {
  const qs = limit != null ? `?limit=${limit}` : '';
  return apiGet<GmProProxyResponse<GmProSearchResult>>(
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

export function fetchGmProDirtyNodes(): Promise<GmProProxyResponse<GmProSearchResult>> {
  return apiGet<GmProProxyResponse<GmProSearchResult>>('/api/gm-pro/proxy/maintain/dirty-nodes');
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