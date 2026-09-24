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
// 仅类型引用：markDirty/getDirtyNodeIds/clearDirty/upsertFeedback 采用上游原始导出
// markDirty(driver, nodeIds) 形态，driver 与 gm-pro 同为 neo4j-driver 的 Driver。
import type { Driver } from 'neo4j-driver';

/** gm-pro 路径解析来源类型 */
type GmProSource = 'env' | 'extensions-global' | 'extensions-workspace' | 'extensions-stock' | 'require';

/** 缓存的 gm-pro 模块（成功 import 后缓存） */
let _gmProMod: any = null;
let _gmProProbed = false;
let _gmProAvailable = false;
let _gmProSource: GmProSource = 'extensions-global';

// perf: 缓存 capability-profiles 的 isApiEnabled 引用，避免每次
// withGmProFallback 都 await import('../capability-profiles.js')
// （assemble 主路径每次调用 judgeRecall 都会触发）
// 注：isApiEnabled 实际签名为 (api: GmProApiName) => boolean，这里放宽为
// (api: string) => boolean 以避免把 GmProApiName 类型耦合到本模块
let _isApiEnabledFn: ((api: string) => boolean) | null = null;
let _isApiEnabledProbed = false;

async function getIsApiEnabled(): Promise<((api: string) => boolean) | null> {
  if (_isApiEnabledProbed) return _isApiEnabledFn;
  _isApiEnabledProbed = true;
  try {
    const mod = await import('../capability-profiles.js');
    if (typeof mod.isApiEnabled === 'function') {
      // 类型擦除：GmProApiName 是 string 字面量联合，运行时与 string 等价
      _isApiEnabledFn = mod.isApiEnabled as (api: string) => boolean;
    }
  } catch {
    /* capability-profiles 模块不可用时，保持 null（不阻止调用） */
  }
  return _isApiEnabledFn;
}

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
  _isApiEnabledFn = null;
  _isApiEnabledProbed = false;
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
    // perf: 使用缓存的 isApiEnabled 引用，避免每次动态 import
    const isApiEnabled = await getIsApiEnabled();
    if (isApiEnabled && !isApiEnabled(apiName as any)) {
      return await fallbackFn();
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
// 上游类型契约（graph-memory-pro v2.4.x，与 src/types.ts 同源）
//
// 对齐目标：wljmmx/graph-memory-pro 顶层导出的真实接口形态。
// lcm-graph-extra 作为调用方，按此契约构造入参 / 解读返回值。
// 上游索引（index.ts）顶层导出有：
//   getNodesByTimeRange(params) / evolveNode(id, updates) / linkNodes(fromId, toId, type)
//   consolidateBuffer(nodes) / incrementalMaintain() / judgeRecall(query, recalledNodes, assistantReply)
//   markDirty(driver, nodeIds) / getDirtyNodeIds(driver) / clearDirty(driver, nodeIds?)
//   upsertFeedback(driver, feedback) / getGraphHealth()
// ──────────────────────────────────────────────────────────────────

/** 上游节点类型枚举（getNodesByTimeRange.type / GmNode.type） */
export type NodeType = "TASK" | "SKILL" | "EVENT";

/** 上游边类型枚举。注意：语义关联边是 RELATES_TO（无 D），与经验层自有边型 RELATED_TO 不同 */
export type EdgeType =
  | "USED_SKILL"
  | "SOLVED_BY"
  | "REQUIRES"
  | "PATCHES"
  | "CONFLICTS_WITH"
  | "RELATES_TO"
  | "CAUSED_BY"
  | "LEADS_TO"
  | "MENTIONS"
  | "NEXT_SESSION"
  | "CONTAINS";

/** 上游节点生命周期状态（S-13） */
export type NodeState = "current" | "superseded" | "transitional";

/** 上游节点可用性状态 */
export type NodeStatus = "active" | "deprecated" | "merged";

/** 上游知识来源（S-3） */
export type NodeSource = "experience" | "knowledge" | "imported";

/** 上游 GmNode（含 2026.9 前 S-1/S-3/S-13/S-14/G-3/G-4/R-4/S-4 扩展字段） */
export interface GmNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  status: NodeStatus;
  communityId?: string | null;
  pagerank: number;
  validatedCount: number;
  createdAt: number;
  updatedAt: number;
  embedding?: number[];
  // S-1 Bi-Temporal
  validFrom?: number;
  validTo?: number;
  recordedAt?: number;
  // S-3 来源标记
  source?: NodeSource;
  supersededBy?: string;
  // S-13 状态追踪
  state?: NodeState;
  // S-14 过时检测
  stalenessScore?: number;
  // G-3 重要性评分
  importanceScore?: number;
  // G-4 / R-4 嵌入模型与可进化嵌入
  embeddingModel?: string;
  embeddingHash?: string;
  embeddingHistory?: Array<{
    embedding: number[];
    embeddingModel?: string;
    embeddingHash?: string;
    archivedAt: number;
  }>;
  // v2.4.0 长文本分段
  chunkTexts?: string[];
  chunkEmbeddings?: number[][];
  // S-4 层次化社区
  topicId?: string;
  domainId?: string;
  [key: string]: any;
}

/** 上游 GmEdge */
export interface GmEdge {
  id: string;
  type: EdgeType;
  fromId: string;
  toId: string;
  instruction: string;
  condition?: string;
  weight: number;
  createdAt: number;
  updatedAt: number;
  [key: string]: any;
}

// ──────────────────────────────────────────────────────────────────
// 上游 API 调用契约（顶层导出形态）
// ──────────────────────────────────────────────────────────────────

/** getNodesByTimeRange：上游签名 getNodesByTimeRange(params) => Promise<GmNode[]> */
export interface GetNodesByTimeRangeParams {
  start: number; // 毫秒时间戳（含）
  end: number; // 毫秒时间戳（含）
  timeField: "createdAt" | "updatedAt";
  type?: NodeType; // 缺省查 Task|Skill|Event 全量
  limit?: number;
}
export type GetNodesByTimeRangeResult = GmNode[];

/** evolveNode：上游签名 evolveNode(id, updates: Partial<GmNode>) => Promise<void> */
export interface EvolveNodeParams {
  id: string;
  /** 仅上游 upsertNode 白名单字段生效（超集字段会被静默丢弃） */
  updates: Partial<GmNode>;
}
export type EvolveNodeResult = void;

/** linkNodes：上游签名 linkNodes(fromId, toId, type: EdgeType) => Promise<void> */
export interface LinkNodesParams {
  fromId: string;
  toId: string;
  type: EdgeType;
}
export type LinkNodesResult = void;

/** markDirty：上游签名 markDirty(driver, nodeIds) => Promise<void>（原始导出，无 reason 参数） */
export interface MarkDirtyParams {
  driver: Driver; // 项目侧 Neo4j Driver（与 gm-pro 同驱动库）
  nodeIds: string[];
}
export type MarkDirtyResult = void;

/** getDirtyNodeIds：上游签名 getDirtyNodeIds(driver) => Promise<string[]> */
export interface GetDirtyNodeIdsParams {
  driver: Driver;
}
export type GetDirtyNodeIdsResult = string[];

/** clearDirty：上游签名 clearDirty(driver, nodeIds?) => Promise<void>（缺省清全部） */
export interface ClearDirtyParams {
  driver: Driver;
  nodeIds?: string[];
}
export type ClearDirtyResult = void;

/** incrementalMaintain：上游签名 incrementalMaintain() => Promise<IncrementalMaintenanceResult>（无入参） */
export interface IncrementalMaintainResult {
  processedNodes: number;
  dedup: {
    pairs: Array<{ idA: string; idB: string; nameA: string; nameB: string; similarity: number }>;
    merged: number;
  };
  staleness: { scanned: number; updated: number; highStaleCount: number };
  importance?: { scanned: number; updated: number; avgScore: number };
  conflictResolution?: { scanned: number; resolved: number; superseded: number; merged: number };
  edgeWeights?: { scanned: number; strengthened: number; decayed: number };
  phasesRun: string[];
  durationMs: number;
}

/** consolidateBuffer：上游签名 consolidateBuffer(nodes: GmNode[]) => Promise<string[]>（返回节点名列表） */
export interface ConsolidateBufferParams {
  /** 仅取各节点 content 拼接后交给 Extractor 做三元组提取 */
  nodes: GmNode[];
}
export type ConsolidateBufferResult = string[];

/** judgeRecall：上游签名 judgeRecall(query, recalledNodes, assistantReply) => Promise<JudgeResult>。
 *  上游 JudgeResult 定义于 judge.ts（本次资料未含），项目本地不消费该返回值（G-8 用本地
 *  evaluateTier1 + fire-and-forget），此处仅标注调用形态，返回值保持宽容。 */
export interface JudgeRecallParams {
  query: string;
  recalledNodes: GmNode[];
  assistantReply: string;
}
export type JudgeRecallResult = unknown;

/** GmFeedback：上游 store.ts 的 GmFeedback（v2.3.2 起 upsertFeedback(driver, GmFeedback)）。
 *  部分字段未在本次资料中全量核实，保持宽容；matchedBy 联合类型确认含 "custom"。 */
export interface GmFeedback {
  nodeId: string;
  query: string;
  relevant: boolean;
  matchedBy?: string; // 上游联合类型含 "custom"（Tier 3 匹配）
  score?: number;
  delta?: number;
  [key: string]: unknown;
}

/** upsertFeedback：上游签名 upsertFeedback(driver, feedback)（store.ts 导出）。
 *  项目 G-8 已改用本地 store.updateQualityScore（v2.3.2 契约变更后弃用上游 API），类型仅作注解。 */
export interface UpsertFeedbackParams {
  driver: Driver;
  feedback: GmFeedback;
}
export type UpsertFeedbackResult = void;

/** getGraphHealth：上游返回形态（status 必填，计数类字段上游恒返回，此处可选仅便于本地构造降级快照） */
export interface GraphHealthSnapshot {
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  nodeCount?: number;
  relationshipCount?: number;
  staleNodeCount?: number;
  lastMaintenanceAt?: number;
  avgQueryLatencyMs?: number;
  errorRate?: number;
  details?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────
// 基础返回类型（上游 recall/store 通用）
// ──────────────────────────────────────────────────────────────────

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
