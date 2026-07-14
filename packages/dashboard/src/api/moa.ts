/**
 * MOA (Mixture of Agents) 配置 API 封装。
 *
 * - GET  /api/moa/config     —— 读取 MOA 配置
 * - PATCH /api/moa/config     —— 热更新 MOA 配置
 * - GET  /api/moa/status      —— 查看 MOA 运行时状态
 */
import { apiGet, apiPatch } from './client';

// ─── 类型 ──────────────────────────────────────────────────────────────────

export interface MoaModelConfig {
  provider: string;
  model: string;
  temperature: number;
  systemPrompt?: string;
  timeoutMs: number;
  apiKey?: string;
  baseURL?: string;
  keepAlive?: string;
}

export interface MoaConfig {
  enabled: boolean;
  complexityThreshold: number;
  mode: string;
  enabledTiers: string[];
  referenceModels: MoaModelConfig[];
  aggregatorModel: MoaModelConfig | null;
}

export interface MoaConfigResponse {
  ok: boolean;
  config?: MoaConfig;
  error?: string;
}

export interface MoaConfigUpdateResponse {
  ok: boolean;
  applied?: string[];
  rejected?: Array<{ path: string; reason: string }>;
  config?: MoaConfig;
  note?: string;
  error?: string;
}

export interface MoaStatus {
  enabled: boolean;
  mode: string;
  complexityThreshold: number;
  enabledTiers: string[];
  referenceModelCount: number;
  hasAggregator: boolean;
  referenceModels: Array<{ provider: string; model: string }>;
  aggregatorModel: { provider: string; model: string } | null;
}

export interface MoaStatusResponse {
  ok: boolean;
  status?: MoaStatus;
  error?: string;
}

// ─── API 函数 ──────────────────────────────────────────────────────────────

/** 获取 MOA 配置 */
export function fetchMoaConfig(): Promise<MoaConfigResponse> {
  return apiGet<MoaConfigResponse>('/api/moa/config');
}

/** 热更新 MOA 配置 */
export function updateMoaConfig(updates: Record<string, unknown>): Promise<MoaConfigUpdateResponse> {
  return apiPatch<MoaConfigUpdateResponse>('/api/moa/config', { updates });
}

/** 获取 MOA 运行时状态 */
export function fetchMoaStatus(): Promise<MoaStatusResponse> {
  return apiGet<MoaStatusResponse>('/api/moa/status');
}