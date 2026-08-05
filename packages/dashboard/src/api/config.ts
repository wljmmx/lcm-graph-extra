/**
 * 配置管理 API 封装（v1.1.0-5 + v1.2.0 P1-1 全字段表单）。
 *
 * - GET  /api/config                —— 运行时配置查看（脱敏后）
 * - GET  /api/config/schema         —— 配置字段 schema 文档
 * - PATCH /api/config               —— 白名单字段热更新
 * - GET  /api/capability-profile    —— 能力档次查看
 * - POST /api/capability-profile    —— 能力档次切换
 */
import { apiGet, apiPatch, apiPost, apiPut } from './client';

// ─── 能力档次 ─────────────────────────────────────────────────────────────

export interface CapabilityProfile {
  id: string;
  label: string;
  description: string;
  estimatedOverhead: number;
  apiCount?: number;
}

export interface CapabilityProfileResponse {
  ok: boolean;
  current?: CapabilityProfile;
  profiles?: CapabilityProfile[];
  error?: string;
}

export function fetchCapabilityProfile(): Promise<CapabilityProfileResponse> {
  return apiGet<CapabilityProfileResponse>('/api/capability-profile');
}

export function switchCapabilityProfile(id: string): Promise<CapabilityProfileResponse> {
  return apiPost<CapabilityProfileResponse>('/api/capability-profile', { id });
}

// ─── 运行时配置 + Schema ─────────────────────────────────────────────────

export interface SchemaFieldDoc {
  path: string;
  type: string;
  description: string;
  updatable: boolean;
  defaultValue?: unknown;
}

export interface ConfigSchemaResponse {
  ok: boolean;
  fields?: SchemaFieldDoc[];
  error?: string;
}

export interface ConfigResponse {
  ok: boolean;
  config?: Record<string, unknown>;
  error?: string;
}

export interface ConfigUpdateResponse {
  ok: boolean;
  applied?: string[];
  rejected?: Array<{ path: string; reason: string }>;
  error?: string;
}

/** 获取配置 schema 文档 */
export function fetchConfigSchema(): Promise<ConfigSchemaResponse> {
  return apiGet<ConfigSchemaResponse>('/api/config/schema');
}

/** 获取运行时配置（脱敏后） */
export function fetchConfig(): Promise<ConfigResponse> {
  return apiGet<ConfigResponse>('/api/config');
}

/** 热更新配置（白名单字段） */
export function updateConfig(updates: Record<string, unknown>): Promise<ConfigUpdateResponse> {
  return apiPatch<ConfigUpdateResponse>('/api/config', { updates });
}

// P3-3: Raw 配置编辑器 API
export interface RawConfigResponse {
  ok: boolean;
  config?: Record<string, unknown>;
  error?: string;
}

export interface ValidateConfigResponse {
  ok: boolean;
  message?: string;
  error?: string;
  errors?: string[];
}

export function fetchRawConfig(): Promise<RawConfigResponse> {
  return apiGet<RawConfigResponse>('/api/config/raw');
}

export function validateConfig(json: string): Promise<ValidateConfigResponse> {
  return apiPost<ValidateConfigResponse>('/api/config/validate', { config: JSON.parse(json) });
}

export function saveRawConfig(json: string): Promise<RawConfigResponse> {
  return apiPut<RawConfigResponse>('/api/config/raw', { config: JSON.parse(json) });
}

// =========================================================================
// v2.1.13: graph-memory-pro 插件配置管理
// =========================================================================

/** 获取 graph-memory-pro 配置 schema 文档 */
export function fetchGmProConfigSchema(): Promise<ConfigSchemaResponse> {
  return apiGet<ConfigSchemaResponse>('/api/gm-pro/config/schema');
}

/** 获取 graph-memory-pro 运行时配置（脱敏后） */
export function fetchGmProConfig(): Promise<ConfigResponse> {
  return apiGet<ConfigResponse>('/api/gm-pro/config');
}

/** 热更新 graph-memory-pro 配置（白名单字段） */
export function updateGmProConfig(updates: Record<string, unknown>): Promise<ConfigUpdateResponse> {
  return apiPatch<ConfigUpdateResponse>('/api/gm-pro/config', { updates });
}

// GM Pro raw config 编辑器 API
export function fetchGmProRawConfig(): Promise<RawConfigResponse> {
  return apiGet<RawConfigResponse>('/api/gm-pro/config/raw');
}

export function validateGmProConfig(json: string): Promise<ValidateConfigResponse> {
  return apiPost<ValidateConfigResponse>('/api/gm-pro/config/validate', { config: JSON.parse(json) });
}

export function saveGmProRawConfig(json: string): Promise<RawConfigResponse> {
  return apiPut<RawConfigResponse>('/api/gm-pro/config/raw', { config: JSON.parse(json) });
}
