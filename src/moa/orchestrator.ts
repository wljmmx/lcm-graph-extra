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
import { withKeepAliveIfOllama, ensureOllamaV1Path } from '../utils/url.js';
import { llmTimeout } from '../config/defaults.js';
import {
  type MoaConfig,
  type MoaPipelineResult,
  type MoaPipelineContext,
  type ReferenceModelConfig,
  type AggregatorModelConfig,
  type LlmCallResult,
} from './types.js';
import { recordMoaRun } from './perf-tracker.js';

// ============================================================================
// 模块级缓存：MoA 聚合结果，供 lcmg_moa_reply 工具跨轮次读取
// ============================================================================

let moaResultCache: string | null = null;

/** 存入 MoA 结果缓存（一次性写入） */
export function setMoaResultCache(result: string): void {
  moaResultCache = result;
}

/** 读取并清空 MoA 结果缓存（一次性消费） */
export function getMoaResultCache(): string | null {
  const result = moaResultCache;
  moaResultCache = null;
  return result;
}

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

  // 如果外部 signal 先触发，也取消
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (modelConfig.apiKey) headers['Authorization'] = 'Bearer ' + modelConfig.apiKey;

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userMessage });

    const body = withKeepAliveIfOllama(
      baseURL,
      {
        model: modelConfig.model,
        messages,
        temperature: modelConfig.temperature,
        max_tokens: 4096,
      },
      modelConfig.keepAlive || '1h',
    );

    const resp = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '<unreadable>');
      throw new Error(`MoA LLM HTTP ${resp.status} from ${baseURL} (model: ${modelConfig.model}): ${errBody.slice(0, 200)}`);
    }

    const data: any = await resp.json();
    const msg = data?.choices?.[0]?.message;
    let text = msg?.content;

    // qwen3 思考模式兜底
    if (!text && msg?.reasoning_content) {
      text = msg.reasoning_content;
    }

    if (text) {
      // 剥离  think... 标签
      text = text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
    }

    if (!text) {
      const finishReason = data?.choices?.[0]?.finish_reason;
      throw new Error(`MoA LLM returned empty content (model: ${modelConfig.model}, finish_reason: ${finishReason})`);
    }

    const tokensUsed = data?.usage?.total_tokens ?? 0;
    const ms = Date.now() - startTime;

    return { text, tokensUsed, ms, model: modelConfig.model };
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
 */
async function callReferenceModel(
  query: string,
  refConfig: ReferenceModelConfig,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  return callLlm(
    refConfig.systemPrompt,
    query,
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
  signal?: AbortSignal,
): Promise<LlmCallResult[]> {
  if (mode === 'parallel') {
    // 云端部署：不同模型并行调用
    return Promise.all(
      refConfigs.map((cfg) => callReferenceModel(query, cfg, signal))
    );
  }

  // 本地部署：同模型串行多轮（共享 keepAlive 会话，避免模型反复加载卸载）
  const results: LlmCallResult[] = [];
  for (const cfg of refConfigs) {
    if (signal?.aborted) break;
    try {
      const result = await callReferenceModel(query, cfg, signal);
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

  logger?.info?.('[moa] Starting MoA pipeline', {
    mode: config.mode,
    refCount: config.referenceModels.length,
    aggModel: config.aggregatorModel.model,
    queryLen: query.length,
  });

  // =========================================================================
  // Phase 1: 参考模型层
  // =========================================================================
  const refStart = Date.now();
  let referenceResults: LlmCallResult[];

  try {
    referenceResults = await runReferenceModels(
      query,
      config.referenceModels,
      config.mode,
      signal,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.warn?.('[moa] Reference models phase failed', { err: errMsg });
    recordMoaRun(query, null, errMsg, {
      mode: config.mode,
      referenceModels: config.referenceModels,
      aggregatorModel: config.aggregatorModel,
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
      mode: config.mode,
      referenceModels: config.referenceModels,
      aggregatorModel: config.aggregatorModel,
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
      config.aggregatorModel,
      conversationContext,
      signal,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.warn?.('[moa] Aggregator model failed', { err: errMsg });
    recordMoaRun(query, null, errMsg, {
      mode: config.mode,
      referenceModels: config.referenceModels,
      aggregatorModel: config.aggregatorModel,
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
    mode: config.mode,
    referenceModels: config.referenceModels,
    aggregatorModel: config.aggregatorModel,
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
2. **Verify relevance**: Check that the MoA response actually addresses the user's question.
3. If the MoA response is relevant and on-topic, use it as your primary answer (you may lightly polish formatting).
4. If the MoA response is clearly about the wrong topic or doesn't address the user's question, **ignore it** and answer the user's question yourself based on the conversation context.
5. Do NOT mention "MoA" or "aggregator" in your response to the user.`;
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
    enabledTiers: ['low'],
  };
}