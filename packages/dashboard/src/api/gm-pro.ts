/**
 * graph-memory-pro HTTP API 代理 —— 前端 API 封装与类型定义。
 *
 * 所有调用通过 dashboard 后端的 /api/gm-pro/proxy/* 代理到 graph-memory-pro 的独立 HTTP API 服务器。
 * 后端代理负责鉴权（X-Auth-Token）、路径白名单、超时控制，前端仅需调用此模块的薄封装函数。
 *
 * v2.10.0: graph-memory-pro 升级为独立 HTTP 服务器（node:http，默认端口 7850），
 * 不再通过 OpenClaw Gateway 的 registerHttpRoute 注册路由。
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

// ─── 社区 ──────────────────────────────────────────────────────────────────

export interface GmProCommunitySummary {
  communityId: string;
  summary: string;
  memberCount: number;
  embedding?: number[];
}

export interface GmProCommunitiesResult {
  count?: number;
  summaries?: GmProCommunitySummary[];
}

export function fetchGmProCommunities(): Promise<GmProProxyResponse<GmProCommunitiesResult>> {
  return apiGet<GmProProxyResponse<GmProCommunitiesResult>>('/api/gm-pro/proxy/communities');
}

export function fetchGmProCommunitySummary(id: string): Promise<GmProProxyResponse<GmProCommunitySummary>> {
  return apiGet<GmProProxyResponse<GmProCommunitySummary>>(`/api/gm-pro/proxy/communities/${encodeURIComponent(id)}/summary`);
}

export interface GmProCommunityNodesResult {
  communityId?: string;
  count?: number;
  nodes?: GmProNode[];
}

export function fetchGmProCommunityNodes(id: string, limit?: number): Promise<GmProProxyResponse<GmProCommunityNodesResult>> {
  const qs = limit != null ? `?limit=${limit}` : '';
  return apiGet<GmProProxyResponse<GmProCommunityNodesResult>>(`/api/gm-pro/proxy/communities/${encodeURIComponent(id)}/nodes${qs}`);
}

export interface GmProCommunityRepresentativesResult {
  communityId?: string;
  representatives?: GmProNode[];
}

export function fetchGmProCommunityRepresentatives(id: string): Promise<GmProProxyResponse<GmProCommunityRepresentativesResult>> {
  return apiGet<GmProProxyResponse<GmProCommunityRepresentativesResult>>(`/api/gm-pro/proxy/communities/${encodeURIComponent(id)}/representatives`);
}

// ─── 图谱可视化 ────────────────────────────────────────────────────────────

export interface GmProGraphWalkParams {
  seedIds: string[];
  depth?: number;
  maxNodes?: number;
}

export interface GmProGraphWalkResult {
  nodes?: GmProNode[];
  edges?: Array<{
    source: string;
    target: string;
    type?: string;
    [key: string]: unknown;
  }>;
}

export function fetchGmProGraphWalk(params: GmProGraphWalkParams): Promise<GmProProxyResponse<GmProGraphWalkResult>> {
  const qs = new URLSearchParams();
  qs.set('seedIds', params.seedIds.join(','));
  if (params.depth != null) qs.set('depth', String(params.depth));
  if (params.maxNodes != null) qs.set('maxNodes', String(params.maxNodes));
  return apiGet<GmProProxyResponse<GmProGraphWalkResult>>(`/api/gm-pro/proxy/graph/walk?${qs.toString()}`);
}

// ─── 节点边 ────────────────────────────────────────────────────────────────

export interface GmProNodeEdgesResult {
  nodeId?: string;
  edges?: Array<{
    source: string;
    target: string;
    type?: string;
    [key: string]: unknown;
  }>;
}

export function fetchGmProNodeEdges(id: string): Promise<GmProProxyResponse<GmProNodeEdgesResult>> {
  return apiGet<GmProProxyResponse<GmProNodeEdgesResult>>(`/api/gm-pro/proxy/nodes/${encodeURIComponent(id)}/edges`);
}

// ─── 节点反馈统计 ──────────────────────────────────────────────────────────

export interface GmProNodeFeedbackStats {
  nodeId?: string;
  feedbackCount?: number;
  avgScore?: number;
  [key: string]: unknown;
}

export function fetchGmProNodeFeedbackStats(id: string): Promise<GmProProxyResponse<GmProNodeFeedbackStats>> {
  return apiGet<GmProProxyResponse<GmProNodeFeedbackStats>>(`/api/gm-pro/proxy/nodes/${encodeURIComponent(id)}/feedback-stats`);
}

// ─── Schema 自省 ───────────────────────────────────────────────────────────

export interface GmProSchemaResult {
  nodeTypes?: Array<{ label: string; count: number }>;
  edgeTypes?: Array<{ type: string; count: number }>;
  indexingModels?: string | null;
  vectorDimension?: number | null;
}

export function fetchGmProSchema(): Promise<GmProProxyResponse<GmProSchemaResult>> {
  return apiGet<GmProProxyResponse<GmProSchemaResult>>('/api/gm-pro/proxy/schema');
}

// ─── 运行时配置（graph-memory-pro 直接查询，区别于 config.ts 的配置管理 API） ──

export interface GmProRuntimeConfigResult {
  version?: string;
  config?: Record<string, unknown>;
}

/** 获取 graph-memory-pro 运行时配置（脱敏后），通过代理直连 gm-pro HTTP API */
export function fetchGmProRuntimeConfig(): Promise<GmProProxyResponse<GmProRuntimeConfigResult>> {
  return apiGet<GmProProxyResponse<GmProRuntimeConfigResult>>('/api/gm-pro/proxy/config');
}

// ─── 服务状态 ──────────────────────────────────────────────────────────────

export interface GmProServiceStatus {
  version?: string;
  timestamp?: string;
  services?: Array<{ name: string; status: string; detail?: unknown }>;
}

export function fetchGmProServices(): Promise<GmProProxyResponse<GmProServiceStatus>> {
  return apiGet<GmProProxyResponse<GmProServiceStatus>>('/api/gm-pro/proxy/ops/services');
}