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
import { apiGet, apiPost, apiDelete } from './client';

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

/**
 * graph-memory-pro /api/association-matrix/state 响应体。
 *
 * 实际返回格式（graph-memory-pro src/routes/crud.ts handleAssociationMatrixState）：
 *   { enabled, available, config,
 *     stats: { enabled, dim, t, updatesApplied, updatesRejected, historySize },
 *     coldStart, feedbackCount, warmupFeedbacks,
 *     persist: { path, persisted: {exists, bytes, modifiedAt} }, hint }
 */
export interface GmProAssociationMatrixStats {
  enabled?: boolean;
  dim?: number;              // 矩阵维度 N
  t?: number;                // Adam 时间步
  updatesApplied?: number;   // 已应用的更新次数
  updatesRejected?: number;  // 被 R-3 拒绝的更新次数
  historySize?: number;      // R-3 历史样本池大小
}

export interface GmProAssociationMatrixPersistInfo {
  path?: string;
  persisted?: { exists?: boolean; bytes?: number; modifiedAt?: string } | null;
}

export interface GmProAssociationMatrixState {
  enabled?: boolean;
  available?: boolean;
  reason?: string;
  config?: Record<string, unknown> | null;
  stats?: GmProAssociationMatrixStats | null;
  coldStart?: boolean;
  feedbackCount?: number;
  warmupFeedbacks?: number;
  persist?: GmProAssociationMatrixPersistInfo | null;
  hint?: string;
  [key: string]: unknown;
}

export function fetchGmProAssociationMatrixState(): Promise<GmProProxyResponse<GmProAssociationMatrixState>> {
  return apiGet<GmProProxyResponse<GmProAssociationMatrixState>>('/api/gm-pro/proxy/association-matrix/state');
}

// ─── Association Matrix 持久化（save / load）───────────────────────────────

export interface GmProAssociationMatrixSaveResult {
  ok?: boolean;
  path?: string;
  bytes?: number;
  dim?: number;
  updateCount?: number;
  rejectedCount?: number;
  reason?: string;
}

export function postGmProAssociationMatrixSave(): Promise<GmProProxyResponse<GmProAssociationMatrixSaveResult>> {
  return apiPost<GmProProxyResponse<GmProAssociationMatrixSaveResult>>('/api/gm-pro/proxy/association-matrix/save', {});
}

export function postGmProAssociationMatrixLoad(): Promise<GmProProxyResponse<GmProAssociationMatrixSaveResult>> {
  return apiPost<GmProProxyResponse<GmProAssociationMatrixSaveResult>>('/api/gm-pro/proxy/association-matrix/load', {});
}

// ─── Association Matrix 学习曲线（AM-5，跨重启持久化）──────────────────────

export interface GmProLearningSample {
  timestamp: number;
  t: number;
  updatesApplied: number;
  updatesRejected: number;
  feedbackCount: number;
}

export interface GmProAssociationMatrixHistory {
  available?: boolean;
  count?: number;
  samples?: GmProLearningSample[];
}

export function fetchGmProAssociationMatrixHistory(n?: number): Promise<GmProProxyResponse<GmProAssociationMatrixHistory>> {
  const qs = n != null ? `?n=${n}` : '';
  return apiGet<GmProProxyResponse<GmProAssociationMatrixHistory>>(`/api/gm-pro/proxy/association-matrix/history${qs}`);
}

// ─── Association Matrix 可视化热力网格（AM-6）───────────────────────────────

export interface GmProAssociationMatrixVisual {
  available?: boolean;
  dim?: number;
  grid?: number;
  values?: number[];
  diagDeviation?: number;
  rowEnergy?: number[];
  frobenius?: number;
  identityRatio?: number;
}

export function fetchGmProAssociationMatrixVisual(max?: number): Promise<GmProProxyResponse<GmProAssociationMatrixVisual>> {
  const qs = max != null ? `?max=${max}` : '';
  return apiGet<GmProProxyResponse<GmProAssociationMatrixVisual>>(`/api/gm-pro/proxy/association-matrix/visual${qs}`);
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

/**
 * v2.4.0 检索质量与输出增强配置（recall 段）。
 * 来自 graph-memory-pro src/types.ts GmConfig.recall。
 */
export interface GmProRecallConfig {
  /** 点2：嵌入文本记忆切片长度（默认 800） */
  memorySliceChars?: number;
  /** 点6：长文本分段嵌入 */
  chunking?: {
    enabled?: boolean;
    /** 单段字符数（默认 400） */
    chunkSize?: number;
    /** 段间重叠字符数（默认 40） */
    chunkOverlap?: number;
  };
  /** 点5：多阶段检索（FTS 种子 → graphWalk 邻域筛选 → 候选内向量排序） */
  multiStage?: boolean;
  /** 点4：时序权重（0~1，默认 0.3），与关联矩阵 M 共同加权 */
  temporalWeight?: number;
  /** 点3：标准格式化输出（注入简洁/贴近原文/减少篡改 policy） */
  outputFormat?: {
    enabled?: boolean;
    /** 是否要求简洁（默认 true） */
    concise?: boolean;
    /** 是否要求贴近原文表述（默认 true） */
    faithful?: boolean;
  };
}

export interface GmProRuntimeConfigResult {
  version?: string;
  config?: Record<string, unknown> & { recall?: GmProRecallConfig };
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

// ─── 运维操作（v2.4.0：熔断器重置 / 缓存清空 / Neo4j 重连）──────────────────

/** POST /api/ops/circuit-breakers/reset 响应：重置全部熔断器 */
export interface GmProOpsResetBreakersResult {
  message?: string;
  resetCount?: number;
  previousStates?: Array<{ name: string; state: string; failureCount?: number }>;
}

/** 重置 graph-memory-pro 全部熔断器（CLOSED + 清零失败计数） */
export function postGmProOpsResetBreakers(): Promise<GmProProxyResponse<GmProOpsResetBreakersResult>> {
  return apiPost<GmProProxyResponse<GmProOpsResetBreakersResult>>('/api/gm-pro/proxy/ops/circuit-breakers/reset', {});
}

/** DELETE /api/ops/cache 响应：清空查询缓存 + 重置召回计时 */
export interface GmProOpsClearCacheResult {
  message?: string;
  entriesRemoved?: number;
  recallTimingReset?: boolean;
}

/** 清空 graph-memory-pro 查询缓存（QueryCache LRU + 召回计时统计） */
export function deleteGmProOpsCache(): Promise<GmProProxyResponse<GmProOpsClearCacheResult>> {
  return apiDelete<GmProProxyResponse<GmProOpsClearCacheResult>>('/api/gm-pro/proxy/ops/cache');
}

/** POST /api/ops/reconnect 响应：手动触发 Neo4j 重连 */
export interface GmProOpsReconnectResult {
  connected?: boolean;
  pool?: { activeSessions?: number; totalCreated?: number; driverActive?: number };
}

/** 手动触发 graph-memory-pro 的 Neo4j 连接重连与连通性校验 */
export function postGmProOpsReconnect(): Promise<GmProProxyResponse<GmProOpsReconnectResult>> {
  return apiPost<GmProProxyResponse<GmProOpsReconnectResult>>('/api/gm-pro/proxy/ops/reconnect', {});
}

// ─── 维护触发（v2.4.0：全量 / 增量 / 标脏 / 清脏）──────────────────────────

/** 触发全量维护（POST /api/maintain） */
export function postGmProMaintain(): Promise<GmProProxyResponse<Record<string, unknown>>> {
  return apiPost<GmProProxyResponse<Record<string, unknown>>>('/api/gm-pro/proxy/maintain', {});
}

/** 触发增量维护，仅处理 markDirty 标记的脏节点（POST /api/maintain/incremental） */
export function postGmProMaintainIncremental(): Promise<GmProProxyResponse<Record<string, unknown>>> {
  return apiPost<GmProProxyResponse<Record<string, unknown>>>('/api/gm-pro/proxy/maintain/incremental', {});
}

/** 标记节点为脏（POST /api/maintain/mark-dirty，body: { nodeIds: string[] }） */
export function postGmProMarkDirty(nodeIds: string[]): Promise<GmProProxyResponse<{ marked?: number }>> {
  return apiPost<GmProProxyResponse<{ marked?: number }>>('/api/gm-pro/proxy/maintain/mark-dirty', { nodeIds });
}

/** DELETE /api/maintain/dirty-nodes 响应：清空脏节点标记 */
export interface GmProClearDirtyResult {
  cleared?: number | 'all';
}

/** 清空全部脏节点标记（DELETE /api/maintain/dirty-nodes，不传 nodeIds 即清全部） */
export function deleteGmProDirtyNodes(): Promise<GmProProxyResponse<GmProClearDirtyResult>> {
  return apiDelete<GmProProxyResponse<GmProClearDirtyResult>>('/api/gm-pro/proxy/maintain/dirty-nodes');
}

// ─── 自动调优触发（v2.4.0：POST /api/auto-tuner/tune）──────────────────────

export interface GmProAutoTunerTuneResult {
  rounds?: unknown[];
  finalAction?: unknown;
  totalRounds?: number;
  snapshots?: number;
}

/** 触发 AutoTuner 调优轮次（rounds 默认 1，上限 autoTuner.maxRounds） */
export function postGmProAutoTunerTune(rounds?: number): Promise<GmProProxyResponse<GmProAutoTunerTuneResult>> {
  return apiPost<GmProProxyResponse<GmProAutoTunerTuneResult>>(
    '/api/gm-pro/proxy/auto-tuner/tune',
    rounds != null ? { rounds } : {},
  );
}

// ─── Recall 触发（v2.4.0：POST /api/recall）─────────────────────────────────

/** POST /api/recall 请求体 */
export interface GmProRecallParams {
  /** 检索 query（必填） */
  query: string;
}

/** 触发一次 recall（用于检索质量回归测试 / 人工验证） */
export function postGmProRecall(params: GmProRecallParams): Promise<GmProProxyResponse<unknown>> {
  return apiPost<GmProProxyResponse<unknown>>('/api/gm-pro/proxy/recall', params);
}