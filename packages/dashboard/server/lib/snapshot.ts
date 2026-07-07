/**
 * 插件 /internal/snapshot 客户端。
 *
 * 调用 lcm-graph-extra 插件的 /internal/snapshot 端点，聚合返回 cascadeManager /
 * userProfile / graphAdapter / debt / retrieval 内存态。
 *
 * 端口规划：插件 snapshot 默认 :7423（仅本机）。
 * 5s 超时，失败返回 null（降级：监控页 memory 面板显示"插件未响应"）。
 */

import { getOutboundAuthHeader } from './auth';

const SNAPSHOT_URL = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';

// 5s 超时
const SNAPSHOT_TIMEOUT_MS = 5_000;

/** 插件内存态快照（与设计文档 3.1 节 memory 字段对齐） */
export interface PluginSnapshot {
  // E4: 补齐插件实际返回的字段（src/dashboard-snapshot.ts DashboardSnapshot）
  // 之前缺少 health / capabilityProfile / timestamp，运行时透传但 TS 类型不安全
  health?: {
    latest?: {
      timestamp?: number;
      tier?: string;
      degraded?: string[];
      lastAssembleMs?: number;
      l2Ms?: number;
      l3Ms?: number;
      l4Ms?: number;
      [key: string]: unknown;
    };
    history?: Array<{
      timestamp?: number;
      tier?: string;
      assembleMs?: number;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  capabilityProfile?: {
    current?: { id?: string; label?: string; description?: string; estimatedOverhead?: number };
    profiles?: Array<{ id: string; label: string; description: string; estimatedOverhead: number }>;
    [key: string]: unknown;
  };
  timestamp?: number;
  cascade?: {
    armsCount: number;
    topArms: Array<{ armKey: string; alpha: number; beta: number; sample: number }>;
    confidenceThreshold: number;
  };
  userProfile?: {
    techStack: Array<{ name: string; weight: number }>;
    scenario: Array<{ name: string; weight: number }>;
    language: 'zh' | 'en' | 'mixed';
  };
  graphAdapter?: {
    connected: boolean;
    connectFailed: boolean;
    lastError?: string;
  };
  debt?: {
    running: number;
    pendingCount: number;
    pollIntervalMs: number;
    maxConcurrent: number;
  };
  retrieval?: {
    lastQuery: string;
    perfSummary: string;
  };
}

/**
 * 拉取插件 /internal/snapshot。
 * 失败/超时返回 null（调用方降级处理）。
 */
export async function fetchPluginSnapshot(): Promise<PluginSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  try {
    const resp = await fetch(`${SNAPSHOT_URL}/internal/snapshot`, {
      method: 'GET',
      headers: getOutboundAuthHeader(),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return null;
    }
    return (await resp.json()) as PluginSnapshot;
  } catch {
    // 任何错误（超时/连接失败/JSON 解析失败）都降级为 null
    return null;
  } finally {
    clearTimeout(timer);
  }
}
