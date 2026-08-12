/**
 * MoA (Mixture of Agents) 类型定义
 *
 * 多模型分层协作架构：
 * 参考模型层（并行发散）+ 聚合模型层（收敛裁决）
 * 将多个 LLM 整合为虚拟超级模型，在复杂推理场景超越单模型上限。
 */

import type { LlmProvider } from '../config.js';

/** 单个参考模型配置 */
export interface ReferenceModelConfig {
  /** LLM provider，可选值见 config.ts 中的 LLM_PROVIDERS 常量 */
  provider: LlmProvider;
  /** 模型名称 */
  model: string;
  /** 参考模型温度（0.5-0.7，鼓励多样性） */
  temperature: number;
  /** 参考视角的 system prompt（不同参考模型从不同角度分析） */
  systemPrompt: string;
  /** 超时时间（ms） */
  timeoutMs: number;
  /** API Key（可选） */
  apiKey?: string;
  /** Base URL（可选） */
  baseURL?: string;
  /** Ollama keepAlive（可选） */
  keepAlive?: string;
}

/** 聚合模型配置 */
export interface AggregatorModelConfig {
  /** LLM provider，可选值见 config.ts 中的 LLM_PROVIDERS 常量 */
  provider: LlmProvider;
  /** 模型名称 */
  model: string;
  /** 聚合模型温度（0.3-0.5，偏收敛） */
  temperature: number;
  /** 超时时间（ms） */
  timeoutMs: number;
  /** API Key（可选） */
  apiKey?: string;
  /** Base URL（可选） */
  baseURL?: string;
  /** Ollama keepAlive（可选） */
  keepAlive?: string;
}

/** MoA 预设 */
export interface MoaPreset {
  /** 预设名称 */
  name: string;
  /** 预设描述 */
  description?: string;
  /**
   * 执行模式（可选，缺省时由根级 config.mode 或 'auto' 兜底）
   * - 'auto': 自动判断——本地模型串行（防 GPU 争抢），远程模型并行，混合时分组并发（推荐）
   * - 'parallel': 强制全部并行（需要用户明确知道有多张 GPU 或纯远程 API）
   * - 'serial': 强制全链路串行，最保守
   */
  mode?: 'auto' | 'parallel' | 'serial';
  /** 参考模型列表（2-4 个） */
  referenceModels: ReferenceModelConfig[];
  /** 聚合模型配置 */
  aggregatorModel: AggregatorModelConfig;
}

/** MoA 完整配置 */
export interface MoaConfig {
  /** 是否启用 MoA */
  enabled: boolean;
  /** 任务复杂度阈值（0-1，默认 0.6） */
  complexityThreshold: number;
  /**
   * 执行模式（可选）。
   * - 'auto': 自动判断——本地模型串行（防 GPU 争抢），远程模型并行，混合时分组并发（推荐，默认）
   * - 'parallel': 强制全部并行（需要用户明确知道有多张 GPU 或纯远程 API）
   * - 'serial': 强制全链路串行，最保守
   *
   * 优先级规则（见 resolveActivePreset）：
   *   根级 config.mode > preset.mode > 'auto'
   * 即用户在根级显式设置的 mode 始终覆盖预设，便于本地/混合场景手动切换。
   * 配置加载层（config.ts）会填充默认 'auto'，因此生产运行时始终有值。
   */
  mode?: 'auto' | 'parallel' | 'serial';
  /** 参考模型列表（2-4 个） */
  referenceModels: ReferenceModelConfig[];
  /** 聚合模型配置 */
  aggregatorModel: AggregatorModelConfig;
  /**
   * 压力层级控制
   * - 仅在指定 tier 启用 MoA
   * - high 压力时自动跳过（节省成本）
   */
  enabledTiers: Array<'low' | 'medium' | 'high'>;
  /**
   * 同步阶段时间预算（ms）。
   * 参考模型层在此预算内同步执行，超过预算则降级到正常流程。
   * 聚合模型层始终异步执行，不受此预算限制。
   * 默认 240,000ms（4 分钟），为对话 5 分钟超时留 1 分钟缓冲。
   */
  syncBudgetMs?: number;
  /**
   * 预设列表（可选）。
   * 支持多套预设，不同场景切换不同模型组合。
   * 如不配置则使用 referenceModels + aggregatorModel 作为默认。
   */
  presets?: MoaPreset[];
  /**
   * 当前激活的预设名称（可选）。
   * 为空时使用 referenceModels + aggregatorModel。
   */
  activePreset?: string;
}

/** 任务复杂度评估结果 */
export interface ComplexityScore {
  /** 复杂度分数（0-1） */
  score: number;
  /** 触发原因列表 */
  reasons: string[];
}

/** MoA 管道执行结果 */
export interface MoaPipelineResult {
  /** 参考模型各输出 */
  referenceOutputs: string[];
  /** 聚合模型最终回复 */
  finalResponse: string;
  /** 总 token 消耗估算 */
  estimatedTokens: number;
  /** 总耗时（ms） */
  totalMs: number;
  /** 各参考模型耗时（ms） */
  referenceTimings: number[];
  /** 聚合模型耗时（ms） */
  aggregatorTiming: number;
  /** 各参考模型 token 消耗（与 referenceTimings 一一对应） */
  referenceTokens?: number[];
  /** 聚合模型 token 消耗 */
  aggregatorTokens?: number;
  /** 各参考模型名称（与 referenceTimings 一一对应，用于模型级指标） */
  referenceModels?: string[];
}

/** MoA 管道执行上下文 */
export interface MoaPipelineContext {
  /** 用户查询 */
  query: string;
  /** 检索上下文（来自 L2/L3/L4） */
  retrievalContext: string;
  /** 对话上下文（最近几轮对话摘要，帮助聚合模型理解讨论背景） */
  conversationContext: string;
  /** MoA 配置 */
  config: MoaConfig;
  /** API 引用（用于 resolveDistillationLlm） */
  api: any;
  /** 日志器 */
  logger: any;
  /** AbortSignal */
  signal?: AbortSignal;
  /** 任务复杂度评分（供性能追踪器记录） */
  complexityScore?: number;
  /** v2: MoA 触发决策快照（供性能追踪器记录能力提升与净收益） */
  decision?: MoaDecisionSnapshot;
  /** v2: 任务类型（code-review/architecture/security 等），供按任务维度分析 */
  task?: string;
  /** 自动分类后的领域上下文补充说明（注入各参考模型 system prompt，不覆盖模型选择） */
  classificationContext?: string;
}

/**
 * v2: MoA 决策快照 —— 记录 decideMoa 的"能力提升/净收益"价值指标，
 * 从决策层透传到性能追踪器，供 dashboard 展示 MoA 是否物有所值。
 */
export interface MoaDecisionSnapshot {
  /** 是否触发 MoA */
  trigger: boolean;
  /** 主模型能力基线（0-1） */
  mainModelStrength: number;
  /** 聚合后能力（0-1） */
  aggregateStrength: number;
  /** 能力差距（聚合能力 - 主模型能力） */
  capabilityGap: number;
  /** 期望提升（原始增值） */
  expectedUplift: number;
  /** 成本摊薄系数（0-1，越大成本越低） */
  costPenalty: number;
  /** 净收益 = 期望提升 × 成本摊薄 */
  netValue: number;
  /** 动态生效门槛 */
  effectiveThreshold: number;
  /** 配置的基础净收益门槛 */
  benefitThreshold: number;
  /** 决策原因 */
  reasons?: string[];
}

/** LLM 调用结果 */
export interface LlmCallResult {
  text: string;
  tokensUsed: number;
  ms: number;
  model: string;
}