import type { PressureTier } from '../lcm-bridge.js';

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
  losslessClawAdapter: any;
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
}