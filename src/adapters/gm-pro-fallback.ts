/**
 * graph-memory-pro v2.1.10 新 API 调用统一入口（graceful degradation wrapper）。
 *
 * 设计：
 * - graph-memory-pro 在运行时可能未安装（optional peerDep），需优雅降级
 * - v2.1.10 新增 5 个 API：judgeRecall / upsertFeedback / getNodesByTimeRange /
 *   evolveNode / G-5 图谱健康（getGraphHealth）
 * - 所有调用采用 "优先 gm-pro → 失败/不可用降级到现有 Cypher/本地实现" 模式
 * - 单一来源避免散落 try-catch，提供统一日志与遥测
 *
 * @module adapters/gm-pro-fallback
 */

import { resolveGmProPath } from './graph-adapter.js';
import { resolveLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

/** 缓存的 gm-pro 模块（成功 import 后缓存） */
let _gmProMod: any = null;
let _gmProProbed = false;
let _gmProAvailable = false;

/**
 * 探测 graph-memory-pro 是否可用，成功后缓存模块实例。
 *
 * 探测结果：
 * - true：模块已加载，后续调用 v2.1.10 新 API 可走 gm-pro 路径
 * - false：模块未安装或 import 失败，所有调用走 fallback
 *
 * 行为幂等：首次调用后缓存，后续无 IO。
 */
export async function probeGmPro(): Promise<boolean> {
  if (_gmProProbed) return _gmProAvailable;
  _gmProProbed = true;
  try {
    const { path } = resolveGmProPath();
    const mod = await import(`${path}/dist/index.js`);
    if (mod && (typeof mod.runMaintenance === 'function' || typeof mod.Recaller === 'function')) {
      _gmProMod = mod;
      _gmProAvailable = true;
    }
  } catch {
    _gmProAvailable = false;
  }
  return _gmProAvailable;
}

/** 获取已加载的 gm-pro 模块（probe 成功后可用，否则 null） */
export function getGmProMod(): any {
  return _gmProMod;
}

/** 重置探测状态（仅供测试使用） */
export function _resetGmProProbe(): void {
  _gmProMod = null;
  _gmProProbed = false;
  _gmProAvailable = false;
}

/**
 * 统一调用 gm-pro 新 API，失败时降级到 fallback。
 *
 * 行为：
 * 1. 首次调用前自动 probe gm-pro
 * 2. gm-pro 不可用 → 直接 fallback
 * 3. gm-pro 可用但 API 缺失（mod 上无对应函数） → fallback
 * 4. gm-pro 可用且 API 存在 → 调用，异常时 fallback
 *
 * @param apiName 调用的 gm-pro 函数名（用于日志/遥测）
 * @param gmProFn 调用 gm-pro API 的闭包，参数为已加载的 mod
 * @param fallbackFn 降级实现的闭包
 * @param logger 可选日志器
 * @param label 调用标签（出现在 debug 日志中）
 */
export async function withGmProFallback<T>(
  apiName: string,
  gmProFn: (mod: any) => Promise<T>,
  fallbackFn: () => Promise<T> | T,
  opts: { logger?: Logger; label?: string } = {},
): Promise<T> {
  const logger = opts.logger ?? resolveLogger(undefined);
  const label = opts.label ?? apiName;

  try {
    const available = await probeGmPro();
    if (!available || !_gmProMod) {
      return await fallbackFn();
    }

    const fn = _gmProMod[apiName];
    if (typeof fn !== 'function') {
      // gm-pro 不存在该 API（旧版本或未升级到 v2.1.10）
      return await fallbackFn();
    }

    const result = await gmProFn(_gmProMod);
    return result;
  } catch (err) {
    logger?.debug?.(`[gm-pro-fallback] ${label} failed, falling back`, { err: String(err) });
    return await fallbackFn();
  }
}

// ──────────────────────────────────────────────────────────────────
// 类型定义：v2.1.10 新 API 的入参/出参契约（lcm-graph-extra 期望形态）
// ──────────────────────────────────────────────────────────────────

/** judgeRecall 入参：评估召回结果是否有效 */
export interface JudgeRecallParams {
  query: string;
  recalledNodeIds: string[];
  scenario?: string;
}

/** judgeRecall 出参：每个节点的相关性判断 */
export interface JudgeRecallResult {
  judgments: Array<{
    id: string;
    relevant: boolean;
    confidence: number;
    reason?: string;
  }>;
  tier1Confidence: number; // 0-1
}

/** upsertFeedback 入参：写入 LLM 验证回路反馈 */
export interface UpsertFeedbackParams {
  nodeId: string;
  query: string;
  relevant: boolean;
  score: number; // 0-1
  delta?: number; // relevanceScore 调整量
}

/** getNodesByTimeRange 入参 */
export interface GetNodesByTimeRangeParams {
  from: number; // 毫秒时间戳
  to: number; // 毫秒时间戳
  limit?: number;
  label?: string; // 'EXPERIENCE' | 'EVENT' | undefined
}

/** getNodesByTimeRange 出参 */
export interface TimeRangeNode {
  id: string;
  type?: string;
  title?: string;
  summary?: string;
  createdAt?: number;
  updatedAt?: number;
  pagerank?: number;
  state?: string;
}

/** evolveNode 入参：更新节点状态 */
export interface EvolveNodeParams {
  nodeId: string;
  updates: Record<string, unknown>;
}

/** evolveNode 出参 */
export interface EvolveNodeResult {
  evolved: boolean;
  previousState?: string;
  newState?: string;
  reason?: string;
}

/** getGraphHealth 出参（G-5 图谱健康） */
export interface GraphHealthSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  nodeCount?: number;
  relationshipCount?: number;
  staleNodeCount?: number;
  lastMaintenanceAt?: number;
  avgQueryLatencyMs?: number;
  errorRate?: number;
  details?: Record<string, unknown>;
}
