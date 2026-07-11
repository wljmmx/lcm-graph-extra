/**
 * afterTurn 经验提取模块。
 *
 * 包含：
 *   1. 三元组提取（队列写入 + fire-and-forget Neo4j upsert）
 *   2. P0-1 经验触发检测 + 三元组提取 + 写入 PENDING 队列
 */

import { readFileSync, existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectExperienceTrigger, extractRawExperience } from '../experience/index.js';
import { backgroundTasks } from '../async/task-registry.js';
import { cleanBaseURL } from '../utils/url.js';
import type { AfterTurnContext } from './types.js';

/**
 * 三元组提取：写入 extract-queue.jsonl 并 fire-and-forget 调用 graphAdapter.extractAndUpsertFromTurn。
 */
export async function extractTriplets(
  ctx: AfterTurnContext,
  userContent: string,
  assistantContent: string,
  autoSummary: string | undefined,
  params: any,
): Promise<void> {
  if (!ctx.graphAdapter) return;

  const llmConfig = resolveLlmConfig(ctx, params);

  // A方案：写入提取队列供 graph-memory-pro 后台服务消费（推荐路径）
  try {
    // P1-6: 已改为静态导入，避免每次 afterTurn 的 await import 开销
    const queueDir = join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.openclaw', 'graph-memory-pro'
    );
    const queuePath = join(queueDir, 'extract-queue.jsonl');
    await mkdir(queueDir, { recursive: true }).catch(() => {});
    const queueItem = JSON.stringify({
      user: autoSummary ? `${userContent}\n\n[Compaction Context]\n${autoSummary}` : userContent,
      assistant: assistantContent,
      sessionId: params.sessionId ?? params.session_id,
      ts: Date.now(),
    }) + '\n';
    await appendFile(queuePath, queueItem).catch(() => {});
  } catch (e) { /* 队列写入失败不影响 afterTurn */
    ctx.logger?.debug?.("experience extract queue write failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
  }

  // Fire-and-forget with latency tracking
  const tripletStart = Date.now();
  backgroundTasks.register('afterturn:triplet-extract', Promise.race([
    ctx.graphAdapter.extractAndUpsertFromTurn(
      llmConfig,
      autoSummary ? `${userContent}\n\n[Compaction Context]\n${autoSummary}` : userContent,
      assistantContent,
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Triplet extraction timeout')), (ctx.api.pluginConfig?.tripletTimeoutMs ?? 8000)))
  ]).then(result => {
    const tripletMs = Date.now() - tripletStart;
    if (result && (result.nodes > 0 || result.edges > 0)) {
      ctx.logger?.debug?.(`[afterTurn] triplets: +${result.nodes} nodes, +${result.edges} edges (${tripletMs}ms)`);
    } else {
      ctx.logger?.debug?.(`[afterTurn] triplets: no extraction needed (${tripletMs}ms)`);
    }
  }).catch((err: Error) => {
    ctx.logger?.warn?.('afterTurn: triplet extraction skipped (async)', { err: err.message });
  }));
}

/**
 * P0-1: 经验提取管道 — 检测触发条件，提取原始经验，写入 PENDING 队列。
 */
export function extractExperiences(
  ctx: AfterTurnContext,
  recentMessages: any[],
  priorMessages: any[],
  msgs: any[],
  params: any,
): void {
  if (!ctx.expStore || typeof detectExperienceTrigger !== 'function') return;

  try {
    const sessionId = String(params.sessionId ?? params.session_id ?? 'unknown');
    const recent = recentMessages.length > 0 ? recentMessages : msgs.slice(-2);
    for (const msg of recent) {
      try {
        const trigger = detectExperienceTrigger(msg, priorMessages);
        if (!trigger) continue;
        const raw = extractRawExperience(trigger, msg, sessionId);
        backgroundTasks.register('exp:save-raw', ctx.expStore.saveRaw(raw).then(() => {
          // P2-1: 经验写入后失效 L4 检索缓存（新经验可能改变检索结果）
          ctx.l4QueryCache?.clear();
        }, (saveErr: any) => {
          ctx.logger?.warn?.('[afterTurn] experience saveRaw failed', { err: String(saveErr) });
        }));
        ctx.logger?.debug?.(`[afterTurn] experience extracted: source=${trigger}, id=${raw.id}`);
      } catch (e) { /* single message extraction failure, non-fatal */
        ctx.logger?.debug?.("single message experience extraction failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (expErr) {
    ctx.logger?.warn?.('[afterTurn] experience extraction pipeline failed (non-fatal)', { err: String(expErr) });
  }
}

/**
 * 解析 LLM 配置，优先级：
 *   1. SDK runtimeContext.llm.complete
 *   2. resolveDistillationLlm(api)
 *   3. api.pluginConfig.llm / ~/.openclaw/openclaw.json graph-memory-pro 配置
 *   4. 环境变量 OPENAI_API_KEY 等兜底
 */
function resolveLlmConfig(ctx: AfterTurnContext, params: any): any {
  const sdkLlmComplete = (params as any)?.runtimeContext?.llm?.complete;
  const distillLlm = ctx.resolveDistillationLlm(ctx.api);

  if (sdkLlmComplete) {
    return {
      complete: sdkLlmComplete,
      model: distillLlm?.model,
      apiKey: distillLlm?.apiKey,
      baseURL: distillLlm?.baseURL,
      keepAlive: distillLlm?.keepAlive,
    };
  }

  if (distillLlm?.model || distillLlm?.apiKey) {
    return {
      model: distillLlm.model,
      apiKey: distillLlm.apiKey,
      baseURL: distillLlm.baseURL,
      keepAlive: distillLlm.keepAlive,
    };
  }

  // 读取缓存的 graph-memory-pro LLM 配置
  let cachedGmpLlmConfig: any;
  try {
    const p = homedir() + '/.openclaw/openclaw.json';
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      cachedGmpLlmConfig = d?.plugins?.entries?.['graph-memory-pro']?.config?.llm;
    }
  } catch { /* ignore */ }

  return ctx.api.pluginConfig?.llm || cachedGmpLlmConfig || {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: cleanBaseURL(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}