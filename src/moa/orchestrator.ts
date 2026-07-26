/**
 * MoA (Mixture of Agents) 编排器
 *
 * 核心管道：
 * 1. 参考模型层：并行/串行调用多个 LLM，从不同视角分析
 * 2. 聚合模型层：接收所有参考输出，批判性评估、去重、综合
 *
 * 支持两种部署模式：
 * - parallel: 云端部署，不同模型并行调用
 * - serial: 本地部署（Ollama），同模型串行多轮（不同 temperature/prompt）
 *
 * 结果缓存：聚合模型输出存入模块级缓存，供 lcmg_moa_reply 工具读取。
 */

import { randomUUID } from 'node:crypto';
import { ensureOllamaV1Path } from '../utils/url.js';
import { callLlm as universalCallLlm } from '../utils/llm-call.js';
import { llmTimeout } from '../config/defaults.js';
import { backgroundTasks } from '../async/task-registry.js';
import {
  type MoaConfig,
  type MoaPipelineResult,
  type MoaPipelineContext,
  type ReferenceModelConfig,
  type AggregatorModelConfig,
  type LlmCallResult,
  type MoaPreset,
} from './types.js';
import { recordMoaRun } from './perf-tracker.js';

// ============================================================================
// 预设管理
// ============================================================================

/**
 * 默认预设列表。
 * 不同场景使用不同的模型组合与视角配置。
 */
const DEFAULT_PRESETS: MoaPreset[] = [
  {
    name: 'code-review',
    description: '代码审查：多角度审查代码质量、安全与性能',
    mode: 'parallel',
    referenceModels: [
      {
        provider: 'openai', model: 'gpt-4o', temperature: 0.7, timeoutMs: 60_000,
        systemPrompt: '你是一位代码架构专家。从代码架构、模块划分、设计模式的角度分析问题，关注可维护性、扩展性和模块间耦合。',
      },
      {
        provider: 'openai', model: 'gpt-4o', temperature: 0.6, timeoutMs: 60_000,
        systemPrompt: '你是一位资深安全审查专家。从潜在风险、边界条件、异常处理、安全漏洞的角度分析问题，关注健壮性和防御性。',
      },
      {
        provider: 'openai', model: 'gpt-4o', temperature: 0.5, timeoutMs: 60_000,
        systemPrompt: '你是一位性能优化专家。从性能、效率、资源消耗的角度分析问题，关注算法复杂度、内存使用和响应时间。',
      },
    ],
    aggregatorModel: {
      provider: 'openai', model: 'gpt-4o', temperature: 0.3, timeoutMs: 120_000,
    },
  },
  {
    name: 'architecture',
    description: '架构设计：专注系统架构与设计模式',
    mode: 'parallel',
    referenceModels: [
      {
        provider: 'openai', model: 'gpt-4o', temperature: 0.7, timeoutMs: 60_000,
        systemPrompt: '你是一位系统架构师。从系统架构、模块划分、接口设计角度分析，关注可扩展性和高可用性。',
      },
      {
        provider: 'openai', model: 'gpt-4o', temperature: 0.6, timeoutMs: 60_000,
        systemPrompt: '你是一位技术选型专家。从技术栈适配性、生态成熟度、团队能力匹配角度分析，关注可行性和长期维护。',
      },
    ],
    aggregatorModel: {
      provider: 'openai', model: 'gpt-4o', temperature: 0.3, timeoutMs: 120_000,
    },
  },
  {
    name: 'security',
    description: '安全审计：专项安全漏洞分析',
    mode: 'parallel',
    referenceModels: [
      {
        provider: 'openai', model: 'gpt-4o', temperature: 0.7, timeoutMs: 60_000,
        systemPrompt: '你是一位安全漏洞分析师。从 OWASP Top 10、CWE 等角度分析，关注注入攻击、认证绕过、数据泄露。',
      },
      {
        provider: 'openai', model: 'gpt-4o', temperature: 0.6, timeoutMs: 60_000,
        systemPrompt: '你是一位合规审计专家。从 GDPR、SOC2、数据隐私角度分析，关注合规风险和数据处理规范。',
      },
    ],
    aggregatorModel: {
      provider: 'openai', model: 'gpt-4o', temperature: 0.3, timeoutMs: 120_000,
    },
  },
];

/**
 * 解析激活预设，返回有效配置。
 * 如果 activePreset 匹配到预设，使用预设的 referenceModels + aggregatorModel + mode；
 * 否则回退到 config 根级别的配置。
 */
export function resolveActivePreset(config: MoaConfig): {
  referenceModels: ReferenceModelConfig[];
  aggregatorModel: AggregatorModelConfig;
  mode: 'parallel' | 'serial';
} {
  const presets = getAvailablePresets(config);
  const activeName = config.activePreset;
  if (activeName) {
    const preset = presets.find((p) => p.name === activeName);
    if (preset) {
      return {
        referenceModels: preset.referenceModels,
        aggregatorModel: preset.aggregatorModel,
        mode: preset.mode ?? config.mode,
      };
    }
  }
  return {
    referenceModels: config.referenceModels,
    aggregatorModel: config.aggregatorModel,
    mode: config.mode,
  };
}

/**
 * 获取所有可用预设（包含默认预设 + 用户自定义预设）。
 */
export function getAvailablePresets(config: MoaConfig): MoaPreset[] {
  const customPresets = config.presets ?? [];
  const customNames = new Set(customPresets.map((p) => p.name));
  // 合并内置预设 + 自定义预设，同名时自定义覆盖内置
  const merged = [
    ...DEFAULT_PRESETS.filter((p) => !customNames.has(p.name)),
    ...customPresets,
  ];
  return merged;
}

// ============================================================================
// 模块级缓存：MoA 聚合结果，供 lcmg_moa_reply 工具跨轮次读取
// ============================================================================

let moaResultCache: string | null = null;

/** 聚合模型是否正在后台执行 */
let moaAggregatorPending = false;

/** 存入 MoA 结果缓存（一次性写入） */
export function setMoaResultCache(result: string): void {
  moaResultCache = result;
  moaAggregatorPending = false;
}

/** 读取并清空 MoA 结果缓存（一次性消费） */
export function getMoaResultCache(): string | null {
  const result = moaResultCache;
  moaResultCache = null;
  return result;
}

/** 查看 MoA 结果缓存（不消费） */
export function peekMoaResultCache(): string | null {
  return moaResultCache;
}

/** 查询聚合模型是否正在后台执行 */
export function isMoaAggregatorPending(): boolean {
  return moaAggregatorPending;
}

// ============================================================================
// 会话级参考模型输出缓存（MoA 异步聚合用）
// ============================================================================

/** 参考模型输出缓存条目 */
interface MoaRefCacheEntry {
  /** 参考模型各输出 */
  referenceOutputs: string[];
  /** 各参考模型 token 消耗 */
  refTokens: number[];
  /** 各参考模型耗时 */
  refTimings: number[];
  /** 各参考模型名称 */
  refModels: string[];
  /** 查询文本 */
  query: string;
  /** 检索上下文 */
  retrievalContext: string;
  /** 对话上下文 */
  conversationContext: string;
  /** 聚合模型配置 */
  aggregatorModel: AggregatorModelConfig;
  /** 执行模式 */
  mode: 'parallel' | 'serial';
  /** 复杂度评分 */
  complexityScore?: number;
  /** 创建时间 */
  createdAt: number;
}

const moaRefCache = new Map<string, MoaRefCacheEntry>();
const MOA_REF_CACHE_MAX = 100;
const MOA_REF_CACHE_TTL_MS = 10 * 60 * 1000; // 10min

// ============================================================================
// LLM 调用基础设施
// ============================================================================

/**
 * 调用单个 LLM，返回文本结果。
 * 复用 distillation.ts 中的 fetch 模式，支持 Ollama keepAlive。
 */
async function callLlm(
  systemPrompt: string,
  userMessage: string,
  modelConfig: { model: string; temperature: number; apiKey?: string; baseURL?: string; keepAlive?: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  const baseURL = ensureOllamaV1Path(modelConfig.baseURL || 'http://127.0.0.1:18789/v1');
  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const result = await universalCallLlm({
      baseURL,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      system: systemPrompt || undefined,
      prompt: userMessage,
      temperature: modelConfig.temperature,
      maxTokens: 4096,
      keepAlive: modelConfig.keepAlive || '1h',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - startTime;
    const tokensUsed = result.raw?.usage?.total_tokens ?? 0;
    return { text: result.text, tokensUsed, ms, model: modelConfig.model };
  } catch (err) {
    clearTimeout(timer);
    const errName = err instanceof Error ? err.name : '';
    if (errName === 'AbortError') {
      throw new Error(`MoA LLM call timeout after ${timeoutMs}ms (model: ${modelConfig.model})`);
    }
    throw err;
  }
}

// ============================================================================
// 参考模型层
// ============================================================================

/**
 * 调用单个参考模型。
 * 参考模型不调用工具、不执行命令，仅输出纯文本分析。
 *
 * 成本优化：参考模型输入剥离系统提示词（Hermes 对齐）。
 * 将角色描述压缩为 1 行前缀拼入用户消息，system prompt 留空，节省 15-20% token。
 */
async function callReferenceModel(
  query: string,
  refConfig: ReferenceModelConfig,
  classificationContext?: string,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  // 从 systemPrompt 提取角色描述（第一句）作为 1 行前缀
  const rolePrefix = refConfig.systemPrompt?.split('。')[0]?.trim() || refConfig.systemPrompt?.trim() || '';
  const userMessage = rolePrefix
    ? `【${rolePrefix}】\n\n${query}`
    : query;
  // 自动分类器补充的领域上下文，拼入 user message 头部，帮助参考模型聚焦分析方向
  const finalUserMessage = classificationContext
    ? `${classificationContext}\n\n---\n\n${userMessage}`
    : userMessage;
  return callLlm(
    '',  // 不传 system prompt，节省 token
    finalUserMessage,
    {
      model: refConfig.model,
      temperature: refConfig.temperature,
      apiKey: refConfig.apiKey,
      baseURL: refConfig.baseURL,
      keepAlive: refConfig.keepAlive,
    },
    refConfig.timeoutMs,
    signal,
  );
}

/**
 * 运行所有参考模型。
 *
 * @param query 用户查询
 * @param refConfigs 参考模型配置列表
 * @param mode 执行模式（parallel/serial）
 * @param signal AbortSignal
 * @returns 各参考模型的结果
 */
async function runReferenceModels(
  query: string,
  refConfigs: ReferenceModelConfig[],
  mode: 'parallel' | 'serial',
  classificationContext?: string,
  signal?: AbortSignal,
): Promise<LlmCallResult[]> {
  if (mode === 'parallel') {
    // 云端部署：不同模型并行调用
    return Promise.all(
      refConfigs.map((cfg) => callReferenceModel(query, cfg, classificationContext, signal))
    );
  }

  // 本地部署：同模型串行多轮（共享 keepAlive 会话，避免模型反复加载卸载）
  const results: LlmCallResult[] = [];
  for (const cfg of refConfigs) {
    if (signal?.aborted) break;
    try {
      const result = await callReferenceModel(query, cfg, classificationContext, signal);
      results.push(result);
    } catch (err) {
      // 单个参考模型失败不影响其他模型
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        text: `[Reference model error: ${errMsg}]`,
        tokensUsed: 0,
        ms: 0,
        model: cfg.model,
      });
    }
  }
  return results;
}

// ============================================================================
// 聚合模型层
// ============================================================================

/**
 * 构建聚合模型提示词。
 *
 * 聚合模型接收：
 * 1. 对话上下文（最近几轮讨论，帮助理解背景）
 * 2. 原始用户查询
 * 3. 知识库检索结果（L2/L3/L4）
 * 4. 所有参考模型输出
 *
 * 聚合模型可调用工具、执行命令，承接 Hermes 完整 Agent 能力。
 */
function buildAggregatorPrompt(
  query: string,
  retrievalContext: string,
  referenceOutputs: string[],
  conversationContext: string,
): string {
  const refSections = referenceOutputs
    .map((output, i) => `### 参考模型 ${i + 1} 分析\n${output}`)
    .join('\n\n');

  const convSection = conversationContext
    ? `## 对话上下文（帮助理解用户意图）\n${conversationContext}\n\n`
    : '';

  return `${convSection}## 原始用户问题
${query}

## 知识库检索结果（参考）
${retrievalContext || '(无相关知识库结果)'}

## 参考模型分析（来自 ${referenceOutputs.length} 个独立模型）
${refSections}

## 聚合要求
你是一个聚合模型，负责综合以上参考意见，生成最终回复。

**重要：必须严格针对用户问题回答，不要引入与问题无关的话题。**

1. **锚定用户问题**：始终以用户问题为核心，不要偏离到其他话题
2. **批判性评估**：审视以上参考意见，识别矛盾、遗漏和潜在错误
3. **去重合并**：合并相似观点，避免重复
4. **综合优化**：综合形成结构化、准确、完整的最终回复
5. **避免幻觉**：不确定的内容需明确标注，优先使用知识库检索结果中的事实
6. **工具调用**：如有需要，可直接调用工具获取额外信息
7. **输出格式**：直接输出最终答案，不需要标注"综合意见"或"聚合结果"等前缀

请现在生成最终回复：`;
}

/**
 * 运行聚合模型。
 *
 * @param query 原始查询
 * @param retrievalContext 检索上下文
 * @param referenceResults 参考模型结果
 * @param aggConfig 聚合模型配置
 * @param signal AbortSignal
 * @returns 聚合结果
 */
async function runAggregatorModel(
  query: string,
  retrievalContext: string,
  referenceResults: LlmCallResult[],
  aggConfig: AggregatorModelConfig,
  conversationContext: string,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  const referenceTexts = referenceResults.map((r) => r.text);
  const aggregatorPrompt = buildAggregatorPrompt(query, retrievalContext, referenceTexts, conversationContext);

  return callLlm(
    '', // 聚合模型不使用 system prompt（所有指令在 user message 中）
    aggregatorPrompt,
    {
      model: aggConfig.model,
      temperature: aggConfig.temperature,
      apiKey: aggConfig.apiKey,
      baseURL: aggConfig.baseURL,
      keepAlive: aggConfig.keepAlive,
    },
    aggConfig.timeoutMs,
    signal,
  );
}

// ============================================================================
// MoA 完整管道
// ============================================================================

/**
 * 执行完整 MoA 管道。
 *
 * 1. 参考模型层：并行/串行调用
 * 2. 聚合模型层：综合输出
 * 3. 结果存入缓存
 *
 * @param ctx 管道上下文
 * @returns 管道结果
 */
export async function runMoaPipeline(ctx: MoaPipelineContext): Promise<MoaPipelineResult | null> {
  const { query, retrievalContext, conversationContext, config, api, logger, signal, complexityScore } = ctx;
  const pipelineStart = Date.now();

  if (signal?.aborted) {
    logger?.debug?.('[moa] Pipeline aborted before start');
    return null;
  }

  // 解析预设：如果设置了 activePreset，使用预设的模型和模式
  const effective = resolveActivePreset(config);
  const effectiveRefModels = effective.referenceModels;
  const effectiveAggModel = effective.aggregatorModel;
  const effectiveMode = effective.mode;

  logger?.info?.('[moa] Starting MoA pipeline', {
    mode: effectiveMode,
    refCount: effectiveRefModels.length,
    aggModel: effectiveAggModel.model,
    queryLen: query.length,
    activePreset: config.activePreset ?? 'default',
  });

  // =========================================================================
  // Phase 1: 参考模型层
  // =========================================================================
  const refStart = Date.now();
  let referenceResults: LlmCallResult[];

  try {
    referenceResults = await runReferenceModels(
      query,
      effectiveRefModels,
      effectiveMode,
      ctx.classificationContext,
      signal,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.warn?.('[moa] Reference models phase failed', { err: errMsg });
    recordMoaRun(query, null, errMsg, {
      mode: effectiveMode,
      referenceModels: effectiveRefModels,
      aggregatorModel: effectiveAggModel,
    }, complexityScore);
    return null;
  }

  const refMs = Date.now() - refStart;
  logger?.debug?.('[moa] Reference models completed', {
    count: referenceResults.length,
    ms: refMs,
    models: referenceResults.map((r) => r.model),
    tokens: referenceResults.reduce((sum, r) => sum + r.tokensUsed, 0),
  });

  // 如果所有参考模型都失败，跳过聚合
  const validRefs = referenceResults.filter((r) => !r.text.startsWith('[Reference model error:'));
  if (validRefs.length === 0) {
    logger?.warn?.('[moa] All reference models failed, skipping aggregation');
    recordMoaRun(query, null, 'All reference models failed', {
      mode: effectiveMode,
      referenceModels: effectiveRefModels,
      aggregatorModel: effectiveAggModel,
    }, complexityScore);
    return null;
  }

  // =========================================================================
  // Phase 2: 聚合模型层
  // =========================================================================
  const aggStart = Date.now();
  let aggregatorResult: LlmCallResult;

  try {
    aggregatorResult = await runAggregatorModel(
      query,
      retrievalContext,
      validRefs,
      effectiveAggModel,
      conversationContext,
      signal,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.warn?.('[moa] Aggregator model failed', { err: errMsg });
    recordMoaRun(query, null, errMsg, {
      mode: effectiveMode,
      referenceModels: effectiveRefModels,
      aggregatorModel: effectiveAggModel,
    }, complexityScore);
    return null;
  }

  const aggMs = Date.now() - aggStart;
  const totalMs = Date.now() - pipelineStart;

  // =========================================================================
  // Phase 3: 结果整理
  // =========================================================================
  const referenceOutputs = validRefs.map((r) => r.text);
  const totalTokens = referenceResults.reduce((sum, r) => sum + r.tokensUsed, 0)
    + aggregatorResult.tokensUsed;

  const result: MoaPipelineResult = {
    referenceOutputs,
    finalResponse: aggregatorResult.text,
    estimatedTokens: totalTokens,
    totalMs,
    referenceTimings: referenceResults.map((r) => r.ms),
    aggregatorTiming: aggMs,
  };

  // 存入缓存（供 lcmg_moa_reply 工具读取）
  setMoaResultCache(result.finalResponse);

  // 记录性能数据（供 Dashboard 查询）
  recordMoaRun(query, result, null, {
    mode: effectiveMode,
    referenceModels: effectiveRefModels,
    aggregatorModel: effectiveAggModel,
  }, complexityScore);

  logger?.info?.('[moa] Pipeline completed', {
    totalMs,
    refMs,
    aggMs,
    totalTokens,
    refCount: validRefs.length,
    responseLen: result.finalResponse.length,
  });

  return result;
}

// ============================================================================
// 工具指令构建
// ============================================================================

/**
 * 构建 MoA 工具调用指令（注入 systemPromptAddition）。
 *
 * 指令主模型调用 lcmg_moa_reply 工具获取预计算的 MoA 回复。
 * 主模型应将 MoA 结果作为主要参考，但有责任验证其与用户问题的相关性。
 * 如果 MoA 结果明显偏离用户问题，主模型应忽略并自行回答。
 */
export function buildMoaToolInstruction(): string {
  return `## MoA (Mixture of Agents) Reference Response
The MoA system has pre-computed a response using multiple reference models and an aggregator model.

**Instructions:**
1. Call the \`lcmg_moa_reply\` tool to retrieve the pre-computed response.
2. If the tool returns a "pending" status (aggregation still in progress), inform the user: "MoA aggregation is still in progress. Please continue the conversation in a moment to receive the complete multi-model analysis." Do NOT fabricate or guess the MoA result.
3. **Verify relevance**: If the MoA response is available, check that it actually addresses the user's question.
4. If the MoA response is relevant and on-topic, use it as your primary answer (you may lightly polish formatting).
5. If the MoA response is clearly about the wrong topic or doesn't address the user's question, **ignore it** and answer the user's question yourself based on the conversation context.
6. Do NOT mention "MoA" or "aggregator" in your response to the user.`;
}

// ============================================================================
// MoA 异步管道（v2.3.0: 拆分同步参考层 + 异步聚合层，避免对话超时）
// ============================================================================

/** 同步参考模型阶段结果 */
export interface MoaRefsSyncResult {
  /** 参考模型是否全部完成 */
  completed: boolean;
  /** 会话 key（用于后续异步聚合关联） */
  sessionKey: string;
  /** 错误信息（completed=false 时） */
  error?: string;
}

/**
 * 同步执行参考模型层（带时间预算）。
 *
 * Phase 1/2: 参考模型发散分析。
 * 在 syncBudgetMs 预算内同步执行，超时则降级。
 * 完成后将参考输出存入会话级缓存，供异步聚合阶段使用。
 *
 * @param ctx 管道上下文
 * @param sessionKey 会话标识（用于关联异步聚合结果）
 * @param syncBudgetMs 同步预算（ms），默认 240,000（4分钟）
 */
export async function runMoaRefsSync(
  ctx: MoaPipelineContext,
  sessionKey: string,
  syncBudgetMs: number = 240_000,
): Promise<MoaRefsSyncResult> {
  const { query, config, logger, signal } = ctx;

  if (signal?.aborted) {
    return { completed: false, sessionKey, error: 'aborted before start' };
  }

  const effective = resolveActivePreset(config);
  const effectiveRefModels = effective.referenceModels;
  const effectiveAggModel = effective.aggregatorModel;
  const effectiveMode = effective.mode;

  logger?.info?.('[moa] Phase 1: Reference models (sync)', {
    mode: effectiveMode,
    refCount: effectiveRefModels.length,
    budgetMs: syncBudgetMs,
  });

  // 用 Promise.race 实现时间预算
  const refStart = Date.now();
  let referenceResults: LlmCallResult[];

  try {
    const budgetPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('MoA sync budget exceeded')), syncBudgetMs);
    });
    // 预吞 reject 避免 unhandledRejection
    budgetPromise.catch(() => {});

    referenceResults = await Promise.race([
      runReferenceModels(query, effectiveRefModels, effectiveMode, ctx.classificationContext, signal),
      budgetPromise,
    ]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.warn?.('[moa] Reference models sync phase failed', { err: errMsg });
    recordMoaRun(query, null, errMsg, {
      mode: effectiveMode,
      referenceModels: effectiveRefModels,
      aggregatorModel: effectiveAggModel,
    }, ctx.complexityScore);
    return { completed: false, sessionKey, error: errMsg };
  }

  const refMs = Date.now() - refStart;

  // 过滤失败的参考模型
  const validRefs = referenceResults.filter((r) => !r.text.startsWith('[Reference model error:'));
  if (validRefs.length === 0) {
    logger?.warn?.('[moa] All reference models failed');
    recordMoaRun(query, null, 'All reference models failed', {
      mode: effectiveMode,
      referenceModels: effectiveRefModels,
      aggregatorModel: effectiveAggModel,
    }, ctx.complexityScore);
    return { completed: false, sessionKey, error: 'All reference models failed' };
  }

  logger?.debug?.('[moa] Reference models sync completed', {
    count: referenceResults.length,
    validCount: validRefs.length,
    ms: refMs,
  });

  // 存入会话级缓存
  if (moaRefCache.size >= MOA_REF_CACHE_MAX) {
    const oldest = moaRefCache.keys().next().value;
    if (oldest !== undefined) moaRefCache.delete(oldest);
  }
  // TTL 清理
  const now = Date.now();
  for (const [key, entry] of moaRefCache) {
    if (now - entry.createdAt > MOA_REF_CACHE_TTL_MS) {
      moaRefCache.delete(key);
    }
  }

  moaRefCache.set(sessionKey, {
    referenceOutputs: validRefs.map((r) => r.text),
    refTokens: referenceResults.map((r) => r.tokensUsed),
    refTimings: referenceResults.map((r) => r.ms),
    refModels: referenceResults.map((r) => r.model),
    query,
    retrievalContext: ctx.retrievalContext,
    conversationContext: ctx.conversationContext,
    aggregatorModel: effectiveAggModel,
    mode: effectiveMode,
    complexityScore: ctx.complexityScore,
    createdAt: now,
  });

  return { completed: true, sessionKey };
}

/**
 * 异步调度聚合模型层。
 *
 * Phase 2/2: 聚合模型收敛裁决。
 * 从会话级缓存读取参考模型输出，在后台执行聚合模型调用。
 * 完成后将结果存入 moaResultCache，供下一轮 lcmg_moa_reply 消费。
 *
 * @param sessionKey 会话标识（与 runMoaRefsSync 中的 sessionKey 一致）
 * @param logger 日志器
 * @param signal AbortSignal（可选）
 */
export function dispatchMoaAggregator(
  sessionKey: string,
  logger: any,
  signal?: AbortSignal,
): void {
  const entry = moaRefCache.get(sessionKey);
  if (!entry) {
    logger?.warn?.('[moa] No ref cache entry for session, skipping aggregator', { sessionKey });
    return;
  }

  moaAggregatorPending = true;

  logger?.info?.('[moa] Phase 2: Aggregator (async dispatch)', {
    sessionKey,
    refCount: entry.referenceOutputs.length,
    aggModel: entry.aggregatorModel.model,
  });

  backgroundTasks.register('moa:aggregator', (async () => {
    if (signal?.aborted) {
      logger?.debug?.('[moa] Aggregator aborted before start');
      moaAggregatorPending = false;
      return;
    }

    const aggStart = Date.now();
    let aggregatorResult: LlmCallResult;

    try {
      // 构建聚合提示词
      const refSections = entry.referenceOutputs
        .map((output, i) => `### 参考模型 ${i + 1} 分析\n${output}`)
        .join('\n\n');

      const convSection = entry.conversationContext
        ? `## 对话上下文（帮助理解用户意图）\n${entry.conversationContext}\n\n`
        : '';

      const aggregatorPrompt = `${convSection}## 原始用户问题
${entry.query}

## 知识库检索结果（参考）
${entry.retrievalContext || '(无相关知识库结果)'}

## 参考模型分析（来自 ${entry.referenceOutputs.length} 个独立模型）
${refSections}

## 聚合要求
你是一个聚合模型，负责综合以上参考意见，生成最终回复。

**重要：必须严格针对用户问题回答，不要引入与问题无关的话题。**

1. **锚定用户问题**：始终以用户问题为核心，不要偏离到其他话题
2. **批判性评估**：审视以上参考意见，识别矛盾、遗漏和潜在错误
3. **去重合并**：合并相似观点，避免重复
4. **综合优化**：综合形成结构化、准确、完整的最终回复
5. **避免幻觉**：不确定的内容需明确标注，优先使用知识库检索结果中的事实
6. **工具调用**：如有需要，可直接调用工具获取额外信息
7. **输出格式**：直接输出最终答案，不需要标注"综合意见"或"聚合结果"等前缀

请现在生成最终回复：`;

      aggregatorResult = await callLlm(
        '',
        aggregatorPrompt,
        {
          model: entry.aggregatorModel.model,
          temperature: entry.aggregatorModel.temperature,
          apiKey: entry.aggregatorModel.apiKey,
          baseURL: entry.aggregatorModel.baseURL,
          keepAlive: entry.aggregatorModel.keepAlive,
        },
        entry.aggregatorModel.timeoutMs,
        signal,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger?.warn?.('[moa] Aggregator async failed', { err: errMsg, sessionKey });
      moaAggregatorPending = false;
      recordMoaRun(entry.query, null, errMsg, {
        mode: entry.mode,
        referenceModels: [], // 参考模型详情在 ref cache 中
        aggregatorModel: entry.aggregatorModel,
      }, entry.complexityScore);
      moaRefCache.delete(sessionKey);
      return;
    }

    const aggMs = Date.now() - aggStart;

    // 存入缓存（供 lcmg_moa_reply 工具读取）
    setMoaResultCache(aggregatorResult.text);

    // 记录性能数据
    const totalTokens = entry.refTokens.reduce((sum, t) => sum + t, 0) + aggregatorResult.tokensUsed;
    const totalMs = entry.refTimings.reduce((sum, t) => sum + t, 0) + aggMs;

    const result: MoaPipelineResult = {
      referenceOutputs: entry.referenceOutputs,
      finalResponse: aggregatorResult.text,
      estimatedTokens: totalTokens,
      totalMs,
      referenceTimings: entry.refTimings,
      aggregatorTiming: aggMs,
    };

    recordMoaRun(entry.query, result, null, {
      mode: entry.mode,
      referenceModels: [], // 参考模型详情在 ref cache 中
      aggregatorModel: entry.aggregatorModel,
    }, entry.complexityScore);

    logger?.info?.('[moa] Aggregator async completed', {
      sessionKey,
      aggMs,
      totalTokens,
      responseLen: aggregatorResult.text.length,
    });

    // 清理 ref cache
    moaRefCache.delete(sessionKey);
  })());
}

// ============================================================================
// 默认配置生成
// ============================================================================

/**
 * 生成默认 MoA 配置（本地 Ollama 部署）。
 *
 * 参考模型：同一 qwen3.6:27b，3 个不同视角 + temperature
 * 聚合模型：同一 qwen3.6:27b，低温收敛
 */
export function defaultMoaConfig(): MoaConfig {
  return {
    enabled: false,
    complexityThreshold: 0.6,
    mode: 'serial',
    referenceModels: [
      {
        provider: 'ollama',
        model: 'qwen3.6:27b',
        temperature: 0.7,
        systemPrompt: '你是一位代码架构专家。从代码架构、模块划分、设计模式的角度分析问题，关注可维护性、扩展性和模块间耦合。',
        timeoutMs: 900_000,
        keepAlive: '1h',
      },
      {
        provider: 'ollama',
        model: 'qwen3.6:27b',
        temperature: 0.6,
        systemPrompt: '你是一位资深安全审查专家。从潜在风险、边界条件、异常处理、安全漏洞的角度分析问题，关注健壮性和防御性。',
        timeoutMs: 900_000,
        keepAlive: '1h',
      },
      {
        provider: 'ollama',
        model: 'qwen3.6:27b',
        temperature: 0.5,
        systemPrompt: '你是一位性能优化专家。从性能、效率、资源消耗的角度分析问题，关注算法复杂度、内存使用和响应时间。',
        timeoutMs: 900_000,
        keepAlive: '1h',
      },
    ],
    aggregatorModel: {
      provider: 'ollama',
      model: 'qwen3.6:27b',
      temperature: 0.3,
      timeoutMs: 1_200_000,
      keepAlive: '1h',
    },
    enabledTiers: ['low', 'medium'],
  };
}