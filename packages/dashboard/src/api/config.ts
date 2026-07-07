/**
 * 配置管理 API 封装（v1.1.0-5）。
 *
 * - GET  /api/capability-profile  —— 能力档次查看
 * - POST /api/capability-profile  —— 能力档次切换
 *
 * 注：运行时配置 / schema / 热更新相关封装因暂无 UI 消费，已移除，
 * 后端端点（GET /api/config 等）仍保留，需要时再补回 client 封装。
 */
import { apiGet, apiPost } from './client';

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
