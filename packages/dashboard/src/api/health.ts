/**
 * 健康监控相关 API 封装 + 类型定义。
 *
 * 与后端 server/routes/health.ts + server/routes/agent.ts 的响应契约对齐，
 * 类型与主包 src/health-metrics.ts / src/dashboard-snapshot.ts 保持一致。
 */
import { apiGet } from './client';

export interface HealthSnapshot {
  timestamp: number;
  pendingMessages: number;
  summaryFragments: number;
  maxTokenRatio: number;
  cbLcmAvailable: boolean;
  cbQmdAvailable: boolean;
  cbNeo4jAvailable: boolean;
  cbLcmFailures: number;
  cbQmdFailures: number;
  cbNeo4jFailures: number;
  lastAssembleMs: number;
  lastL2Ms: number;
  lastL3Ms: number;
  lastL4Ms: number;
  pendingExperienceCount: number;
  distilledExperienceCount: number;
  tierLow: number;
  tierMedium: number;
  tierHigh: number;
  // R-2: cascade Tier 1 置信度（仅内存态，来自 :7423 snapshot）
  cascadeTier1Confidence?: number;
  cascadeJudgeSource?: 'gm-pro' | 'local';
  // v1.1-6: UX 指标 —— 降级频率 / Token 节省率 / 经验命中率（来自内存快照）
  degradedCount?: number;
  totalAssembleCount?: number;
  tokenSavedRatio?: number;
  experienceHitCount?: number;
  experienceQueryCount?: number;
  // v1.1-7: 最近一次 assemble 的降级原因（用于链路状态可视化）
  lastDegradedReasons?: string[];
}

export interface CascadeSnapshot {
  armsCount: number;
  topArms: Array<{ armKey: string; alpha: number; beta: number; sample: number }>;
  confidenceThreshold: number;
}

export interface UserProfileSnapshot {
  techStack: Array<{ name: string; weight: number }>;
  scenario: Array<{ name: string; weight: number }>;
  language: 'zh' | 'en' | 'mixed';
}

export interface GraphAdapterState {
  connected: boolean;
  connectFailed: boolean;
  lastError?: string;
  circuitBreaker?: { available: boolean; failures: number; open: boolean };
  healthCheckCount?: number;
  gmProHasModule?: boolean;
  gmProGetDriverType?: string;
  gmProDriverAvailable?: boolean;
  hasOwnDriver?: boolean;
  connectRetryCount?: number;
  gmProPath?: string;
  gmProSource?: string;
}

export interface DebtStats {
  running: number;
  pendingCount: number;
  pollIntervalMs: number;
  maxConcurrent: number;
}

export interface RetrievalState {
  lastQuery: string;
  perfSummary: string;
  qmdCircuitBreaker?: { available: boolean; failures: number; open: boolean };
}

export interface DashboardSnapshot {
  cascade: CascadeSnapshot;
  userProfile: UserProfileSnapshot;
  graphAdapter: GraphAdapterState;
  debt: DebtStats;
  retrieval: RetrievalState;
  health: { latest: HealthSnapshot | null };
  timestamp: number;
}

export interface HealthLatestResponse {
  db: HealthSnapshot | null;
  memory: DashboardSnapshot | null;
}

export interface HealthHistoryResponse {
  snapshots: HealthSnapshot[];
}

export interface AgentStatus {
  online: boolean;
  error?: string;
  [key: string]: unknown;
}

export function fetchHealthLatest(): Promise<HealthLatestResponse> {
  return apiGet<HealthLatestResponse>('/api/health/latest');
}

export function fetchHealthHistory(n: number = 144): Promise<HealthHistoryResponse> {
  return apiGet<HealthHistoryResponse>(`/api/health/history?n=${n}`);
}

export function fetchAgentStatus(): Promise<AgentStatus> {
  return apiGet<AgentStatus>('/api/agent/status');
}

// ─── N-4: G-5 图谱健康 ────────────────────────────────────────────────────

export interface GraphHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  source: 'gm-pro' | 'local' | 'none';
  nodeCount?: number;
  relationshipCount?: number;
  graphAdapterConnected?: boolean;
  circuitBreakerOpen?: boolean;
  circuitBreakerFailures?: number;
  details?: Record<string, unknown>;
  fetchedAt: number;
  error?: string;
}

export function fetchGraphHealth(): Promise<GraphHealthResponse> {
  return apiGet<GraphHealthResponse>('/api/graph/health');
}
