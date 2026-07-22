import type { PressureTier } from '../lcm-bridge.js';
import type { LosslessClawAdapter } from '../middleware/lossless-claw-adapter.js';

/**
 * AssembleContext — 依赖注入接口，传递 assemble 需要的所有闭包单例。
 */
export interface AssembleContext {
  api: any;
  logger: any;
  qmdClient: any;
  graphAdapter: any;
  expStore: any;
  merger: any;
  losslessClawAdapter: LosslessClawAdapter;
  retrievalGateway: any;
  cascadeManager: any;
  modelRegistry: Record<string, number> | undefined;
  lastEmbedHealth: boolean;
  tracker: any;
  ensureInitialized: () => Promise<void>;
  resolveDistillationLlm: (api: any) => any;
  sessionWarmupCache: Map<string, any[]>;
  lastAssembleExpIdsBySession: Map<string, { ids: Array<{ id: string; summary: string; query: string }>; ts: number }>;
  userProfile: any;
  setLastRetrievalQuery: (q: string) => void;
  /** R-5: 会话级输出质量评分，afterTurn 评估后写入，assemble 中读取调整检索门槛 */
  sessionQualityScores: Map<string, number>;
  /** P0-1: 会话级 LLM Rerank 异步缓存，fire-and-forget 结果供下一轮使用 */
  llmRerankCache: Map<string, { query: string; results: any[]; ts: number }>;
  /** P2-1: L2 qmd 检索结果 LRU 缓存（同 query 短期复用，TTL 由 heartbeat 清理） */
  l2QueryCache: Map<string, { results: any[]; ts: number }>;
  /** P2-1: L4 experience 检索结果 LRU 缓存（经验写入时整体失效） */
  l4QueryCache: Map<string, { results: any[]; ts: number }>;
}

/**
 * assemble 函数返回结果。
 */
export interface AssembleResult {
  messages: any[];
  estimatedTokens: number;
  systemPromptAddition: string | undefined;
  promptAuthority: string;
  degraded: boolean;
  degradedReasons: string[] | undefined;
}

/**
 * 检索结果汇总。
 */
export interface RetrievalOutput {
  qmdResults: any[];
  graphResults: any[];
  expResults: any[];
  fullDocs: string[];
  l2_ms: number;
  l3_ms: number;
  l4_ms: number;
  mgMs: number;
  scenario: string | null;
  confidence: { tier1Score: number; needsTier2: boolean; needsTier3: boolean; hasFactualClaim: boolean };
  tier: PressureTier;
  retrievalLimits: { qmd: number; graph: number; exp: number };
  tokenRatio: number;
  degradedReasons: string[];
  estimatedTokens: number;
  contextWindow: number;
  effectiveTokenCount: number;
  overheadTokens: number;
  msgCount: number;
  uncompressedMsgs: number;
  initMs: number;
  parallelMs: number;
  hasGraphTool: boolean;
  hasExperienceTool: boolean;
  availableTools: string[];
  qmdQuery: string;
}

/**
 * 注入结果。
 */
export interface InjectionOutput {
  systemPromptAddition: string;
  currentRoundHashes: string[];
  removedSections: { label: string; chars: number }[];
  expResults: any[];
  /** 当前场景标识（来自 detectScenarioAndAdjustLimits），供智能工具引导使用 */
  scenario: string | null;
}