/**
 * graph-memory-pro API 调用统一入口（graceful degradation wrapper）。
 *
 * 设计：
 * - graph-memory-pro 作为 OpenClaw extension 通过 extensions 目录安装管理
 * - 支持的扩展 API：judgeRecall / upsertFeedback / getNodesByTimeRange /
 *   evolveNode / getGraphHealth / consolidateBuffer / linkNodes / markDirty / incrementalMaintain
 * - 所有调用采用 "优先 gm-pro → 失败/不可用降级到现有 Cypher/本地实现" 模式
 * - 单一来源避免散落 try-catch，提供统一日志与遥测
 *
 * 架构说明：
 * - graph-memory（SQLite 版，npm: graph-memory）：基础图谱记忆，自带 Recaller/维护
 * - graph-memory-pro（Neo4j 版，OpenClaw extension）：高级能力（judgeRecall/evolveNode 等）
 * - 路径解析优先从 extensions 目录查找（global/workspace/stock），兼容 require.resolve 降级
 * - 本 wrapper 兼容两种形态：探测到任一形态均标记为可用，但扩展 API 按需检测
 *
 * @module adapters/gm-pro-fallback
 */

import { resolveGmProPath } from './graph-adapter.js';
import { resolveLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

/** gm-pro 路径解析来源类型 */
type GmProSource = 'env' | 'extensions-global' | 'extensions-workspace' | 'extensions-stock' | 'require';

/** 缓存的 gm-pro 模块（成功 import 后缓存） */
let _gmProMod: any = null;
let _gmProProbed = false;
let _gmProAvailable = false;
let _gmProSource: GmProSource = 'extensions-global';

/**
 * 探测 graph-memory-pro 是否可用，成功后缓存模块实例。
 *
 * 探测结果：
 * - true：模块已加载，可尝试调用其 API
 * - false：模块未安装或 import 失败，所有调用走 fallback
 *
 * 行为幂等：首次调用后缓存，后续无 IO。
 */
export async function probeGmPro(): Promise<boolean> {
  if (_gmProProbed) return _gmProAvailable;
  _gmProProbed = true;
  try {
    const resolved = resolveGmProPath();
    _gmProSource = resolved.source;
    const mod = await import(`${resolved.path}/dist/index.js`);
    if (mod && (
      typeof mod.runMaintenance === 'function' ||
      typeof mod.Recaller === 'function' ||
      typeof mod.searchNodes === 'function'
    )) {
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

/** 获取 gm-pro 解析来源（用于诊断） */
export function getGmProSource(): string {
  return _gmProSource;
}

/** 重置探测状态（仅供测试使用） */
export function _resetGmProProbe(): void {
  _gmProMod = null;
  _gmProProbed = false;
  _gmProAvailable = false;
  _gmProSource = 'extensions-global';
}

/**
 * 检查 gm-pro 模块上是否存在指定 API 函数。
 * 支持 dot 路径（如 'Recaller.prototype.recall'），但默认直接查顶层函数。
 */
function _hasApi(mod: any, apiName: string): boolean {
  if (!mod) return false;
  if (typeof mod[apiName] === 'function') return true;
  if (apiName.includes('.')) {
    const parts = apiName.split('.');
    let cur: any = mod;
    for (const p of parts) {
      if (cur == null) return false;
      cur = cur[p];
    }
    return typeof cur === 'function';
  }
  return false;
}

/**
 * 统一调用 gm-pro API，失败时降级到 fallback。
 *
 * 行为：
 * 1. 首次调用前自动 probe gm-pro
 * 2. gm-pro 不可用 → 直接 fallback
 * 3. gm-pro 可用但 API 缺失 → fallback
 * 4. gm-pro 可用且 API 存在 → 调用，异常时 fallback
 *
 * @param apiName 调用的 gm-pro 函数名（用于日志/遥测）
 * @param gmProFn 调用 gm-pro API 的闭包，参数为已加载的 mod
 * @param fallbackFn 降级实现的闭包
 * @param opts.logger 可选日志器
 * @param opts.label 调用标签（出现在 debug 日志中）
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
    // 能力档次检查：如果当前档次未启用该 API，直接走 fallback
    try {
      const { isApiEnabled } = await import('../capability-profiles.js');
      if (!isApiEnabled(apiName as any)) {
        return await fallbackFn();
      }
    } catch {
      // capability-profiles 模块不可用时，不阻止调用（向后兼容）
    }

    const available = await probeGmPro();
    if (!available || !_gmProMod) {
      return await fallbackFn();
    }

    if (!_hasApi(_gmProMod, apiName)) {
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
// 类型定义：扩展 API 的入参/出参契约（lcm-graph-extra 期望形态）
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

/** consolidateBuffer 入参：将情节缓冲中的节点整合到全局图谱（S-9） */
export interface ConsolidateBufferParams {
  nodes: GmNode[];
  sessionId?: string;
}

/** consolidateBuffer 出参：成功整合的节点 ID 列表 */
export interface ConsolidateBufferResult {
  consolidatedIds: string[];
  skippedIds?: string[];
  reason?: string;
}

/** linkNodes 入参：创建语义链接（S-11 Zettelkasten） */
export interface LinkNodesParams {
  fromId: string;
  toId: string;
  type: string; // e.g. 'RELATED_TO' | 'DERIVED_FROM' | 'EVOLVED_FROM'
  instruction?: string;
}

/** linkNodes 出参 */
export interface LinkNodesResult {
  created: boolean;
  edgeId?: string;
  reason?: string;
}

/** markDirty 入参：标记节点脏数据，触发增量维护（gm-pro v2.2.1） */
export interface MarkDirtyParams {
  nodeIds: string[];
  reason?: string;
}

/** incrementalMaintain 入参：增量维护（gm-pro v2.2.1） */
export interface IncrementalMaintainParams {
  nodeIds?: string[]; // 为空则处理所有 dirty 节点
  maxBatchSize?: number;
}

/** incrementalMaintain 出参 */
export interface IncrementalMaintainResult {
  processedCount: number;
  remainingCount: number;
  durationMs?: number;
}

// ──────────────────────────────────────────────────────────────────
// 基础 API 类型契约（graph-memory / graph-memory-pro 通用核心能力）
// ──────────────────────────────────────────────────────────────────

/** 图谱节点基础类型 */
export interface GmNode {
  id: string;
  type: string;
  name: string;
  description: string;
  content: string;
  status?: string;
  validatedCount?: number;
  communityId?: string | null;
  pagerank?: number;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: any;
}

/** 图谱边基础类型 */
export interface GmEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  instruction: string;
  condition?: string;
  sessionId?: string;
  createdAt?: number;
  [key: string]: any;
}

/** 召回结果 */
export interface RecallResult {
  nodes: GmNode[];
  edges: GmEdge[];
  tokenEstimate?: number;
}

/** PPR 结果 */
export interface PPRResult {
  scores: Map<string, number>;
}

/** 社区检测结果 */
export interface CommunityResult {
  labels: Map<string, string>;
  communities: Map<string, string[]>;
  count: number;
}
