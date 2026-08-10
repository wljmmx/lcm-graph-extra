/**
 * Phase 3: 查询重构 — 当实体提取质量差时，用 LLM 将模糊查询改写为更精确的查询
 * 
 * 触发条件：
 * - 实体提取结果为空（无有效 terms/properNouns/tokens）
 * - 查询长度 < 5 字符
 * - 查询全是停用词/无意义词
 * 
 * 改写策略：
 * - 补全技术术语（"怎么配" → "如何配置项目"）
 * - 补充上下文（"报错了" → "代码执行报错，请分析错误原因"）
 * - 添加搜索关键词（"帮我" → "帮我完成编程任务"）
 */

import { callLlm } from '../utils/llm-call.js';


export interface QueryRewriteResult {
  /** 改写后的查询 */
  rewrittenQuery: string;
  /** 原始查询 */
  originalQuery: string;
  /** 是否触发了改写 */
  wasRewritten: boolean;
  /** 改写原因 */
  reason: string;
}

/**
 * 判断是否需要触发查询重构
 */
export function needsQueryRewrite(entities: { terms: string[]; properNouns: string[]; techTerms: string[]; tokens: string[] }, query: string): boolean {
  if (!query || query.trim().length < 3) return true;
  const totalTokens = entities.terms.length + entities.properNouns.length + entities.techTerms.length + entities.tokens.length;
  return totalTokens === 0;
}

/**
 * LLM 查询重构
 */
export async function rewriteQuery(
  originalQuery: string,
  ctx?: { logger?: { debug?: (...args: any[]) => void } }
): Promise<QueryRewriteResult> {
  // Use the same LLM config mechanism as distillation — resolveDistillationLlm from AssembleContext
  let llmConfig: { baseURL: string; apiKey: string; model: string } | null = null;
  if (ctx && typeof (ctx as any).resolveDistillationLlm === 'function') {
    try {
      const distillLlm = (ctx as any).resolveDistillationLlm((ctx as any).api);
      if (distillLlm?.model) {
        llmConfig = {
          baseURL: distillLlm.baseURL || '',
          apiKey: distillLlm.apiKey || '',
          model: distillLlm.model,
        };
      }
    } catch (e) {
      ctx.logger?.debug?.('[query-rewrite] resolveDistillationLlm failed (non-fatal)', { err: String(e) });
    }
  }
  
  if (!llmConfig) {
    ctx?.logger?.debug?.('[query-rewrite] No LLM config, skipping rewrite');
    return { rewrittenQuery: originalQuery, originalQuery, wasRewritten: false, reason: 'no_llm_config' };
  }

  const systemPrompt = `你是一个查询优化助手。用户会给你一个模糊或不完整的查询，你需要将其改写为更精确、更适合搜索引擎检索的查询。

要求：
1. 保持用户的原始意图
2. 补充技术术语和关键词
3. 添加相关搜索词（如"配置"、"实现"、"代码"、"教程"等）
4. 输出格式：只输出改写后的查询，不要解释
5. 如果原始查询已经足够清晰，原样返回

示例：
- "怎么配" → "如何配置项目设置"
- "报错了" → "代码执行报错，分析错误原因和解决方案"
- "帮我" → "帮我完成编程任务，提供代码示例"
- "这个怎么用" → "如何使用这个工具或库，提供使用说明和示例"
- "优化" → "代码性能优化，提升运行效率的方法"
- "xxl" → "xxl 工具使用方法和技术文档"`;

  const userPrompt = `请改写以下查询，使其更适合作为知识检索的搜索词：

原始查询：${originalQuery}

改写后的查询：`;

  try {
    const result = await callLlm({
      baseURL: llmConfig.baseURL,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.3,
      maxTokens: 200,
    });

    const rewritten = result.text.trim().replace(/^["'"'"']|["'"'"']$/g, '').trim();
    
    if (rewritten && rewritten !== originalQuery) {
      ctx?.logger?.debug?.('[query-rewrite] rewritten query', { original: originalQuery, rewritten });
      return {
        rewrittenQuery: rewritten,
        originalQuery,
        wasRewritten: true,
        reason: 'llm_rewrite',
      };
    }
    
    return {
      rewrittenQuery: originalQuery,
      originalQuery,
      wasRewritten: false,
      reason: 'no_improvement',
    };
  } catch (e) {
    ctx?.logger?.debug?.('[query-rewrite] rewrite failed (non-fatal)', { err: String(e) });
    return {
      rewrittenQuery: originalQuery,
      originalQuery,
      wasRewritten: false,
      reason: 'rewrite_failed',
    };
  }
}

