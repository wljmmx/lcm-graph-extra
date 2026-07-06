/**
 * 配置管理 API 封装（v1.1.0-1/2/3/5）。
 *
 * - GET  /api/config              —— 运行时配置查看（脱敏）
 * - GET  /api/config/schema       —— 配置字段 schema 文档
 * - PATCH /api/config             —— 白名单字段热更新
 * - GET  /api/capability-profile  —— 能力档次查看
 * - POST /api/capability-profile  —— 能力档次切换
 */
import { apiGet, apiPost, apiPatch } from './client';

// ─── 运行时配置 ─────────────────────────────────────────────────────────

export interface RuntimeConfigResponse {
  ok: boolean;
  configPath?: string;
  configExists?: boolean;
  config: Record<string, unknown>;
  error?: string;
}

export function fetchRuntimeConfig(): Promise<RuntimeConfigResponse> {
  return apiGet<RuntimeConfigResponse>('/api/config');
}

// ─── 配置 schema 文档 ────────────────────────────────────────────────────

export interface ConfigSchemaField {
  path: string;
  type: string;
  description: string;
  updatable: boolean;
  defaultValue?: unknown;
}

export interface ConfigSchemaResponse {
  ok: boolean;
  fields: ConfigSchemaField[];
  updatablePaths: string[];
}

export function fetchConfigSchema(): Promise<ConfigSchemaResponse> {
  return apiGet<ConfigSchemaResponse>('/api/config/schema');
}

// ─── 配置热更新 ───────────────────────────────────────────────────────────

export interface ConfigPatchResponse {
  ok: boolean;
  applied: string[];
  rejected: Array<{ path: string; reason: string }>;
  config: Record<string, unknown>;
  note?: string;
  error?: string;
}

export function patchConfig(updates: Record<string, unknown>): Promise<ConfigPatchResponse> {
  return apiPatch<ConfigPatchResponse>('/api/config', { updates });
}

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
