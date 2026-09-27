/**
 * 本地 Embedding 函数工厂 —— 确保 keep_alive 参数被正确传递，并支持批量嵌入。
 *
 * 问题背景：graph-memory-pro 的 createEmbedFn 是外部模块，无法保证它读取
 * EmbeddingConfig.keepAlive 并写入 HTTP 请求 body 的 keep_alive 字段。
 * Ollama 默认 keep_alive=5m，模型在 5 分钟无请求后自动卸载，下次请求需重新加载，
 * 导致首次召回延迟显著（GGUF 模型加载可能数秒到数十秒）。
 *
 * 本模块实现自带的 embed 函数，明确在请求 body 中包含 keep_alive 字段，
 * 绕过 graph-memory-pro 的不确定性。支持三种端点格式：
 *
 *   - OpenAI 兼容 (/v1、OVMS /v3): POST {base}/embeddings
 *       body { model, input, ...options }（OpenAI 标准，字段始终用 input；
 *       扩展 options 平铺到顶层。keep_alive 为 Ollama 专有字段，此路径不发送，
 *       避免 OVMS 等严格校验服务端拒绝未知字段）
 *   - Ollama 新版原生: POST /api/embed       → body { model, input, keep_alive, options: {...} }
 *       （Ollama 0.3+，字段为 input；运行时参数 num_ctx/seed 等嵌套在 options 内）
 *   - Ollama 旧版原生: POST /api/embeddings   → body { model, prompt, keep_alive, options: {...} }
 *       （Ollama 0.1.x，字段为 prompt，端点带 s；options 同样嵌套）
 *
 * 非新版端点首次 404 时自动回退到旧版并缓存，避免每次探测。
 * Ollama 原生端点的 options 嵌套：Ollama 会忽略顶层不认识的字段，运行时参数
 * （num_ctx、seed、temperature、top_k 等）必须放在 options 子对象内才会生效。
 *
 * OVMS（OpenVINO Model Server）内网服务说明：
 *   OVMS 的 OpenAI 兼容接口在 /v3 前缀下（/v3/embeddings、/v3/chat/completions），
 *   必须以版本段结尾的 baseURL（如 http://192.168.1.10:8000/v3）配置。
 *   本模块通过 isOpenAiCompatibleEndpoint 识别版本段，走 OpenAI 兼容路径，
 *   不会把 /v3 改写成 Ollama 原生 /v3/api/embed。
 *
 * 批量嵌入（BatchEmbedFn）：
 *   一次 HTTP 请求携带多个文本（OpenAI 兼容端点与 Ollama /api/embed 均支持
 *   input 数组），显著减少请求数，缓解本地 Ollama 队列压力与 OVMS 单请求开销。
 *   语义对齐上游 graph-memory-pro createBatchEmbedFn：先查缓存，未命中的按
 *   batchSize 切分子批发送；子批失败降级为逐条请求，单条失败返回 null（不阻塞整批）。
 */

import type { EmbeddingConfig } from '../types.js';
import { cleanBaseURL, isOllamaEndpoint, isOpenAiCompatibleEndpoint } from '../utils/url.js';
import { withOllamaSlot } from '../async/ollama-slot.js';
// P2-9: 接入集中化 LLM 超时常量
import { llmTimeout } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// LRU 缓存：相同 query 文本的 embedding 结果缓存，避免重复请求 Ollama
// （assemble 中相似/重复 query 可命中缓存，vec_embed 2.5s → ~0ms）
// ---------------------------------------------------------------------------
const EMBED_CACHE_CAPACITY = 64;
const EMBED_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟

class EmbedLRUCache {
  private map = new Map<string, { value: number[]; expiresAt: number }>();
  get(key: string): number[] | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) { this.map.delete(key); return undefined; }
    // move-to-end（Map 迭代顺序 = 插入顺序 = LRU 顺序）
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, value: number[]): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= EMBED_CACHE_CAPACITY) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { value, expiresAt: Date.now() + EMBED_CACHE_TTL_MS });
  }
}

/** 缓存键：长文本截断，避免超长 key 额外占用内存（确定性映射） */
function embedCacheKey(text: string): string {
  return text.length > 500 ? text.slice(0, 500) + ':' + text.length : text;
}

// ---------------------------------------------------------------------------
// 端点解析：单文本与批量共用，保证两条链路判定一致
// ---------------------------------------------------------------------------

interface ResolvedEmbedTarget {
  /** 原始 baseURL（用于 withOllamaSlot 判定） */
  baseURL: string;
  /** 清洗后的 baseURL（拼接 OpenAI 兼容路径） */
  baseClean: string;
  /** Ollama 原生端点基址（剥离 /vN 后缀，避免 /v1/api/embed 非法路径） */
  baseForOllama: string;
  model: string;
  isOllama: boolean;
  isOpenAiCompatible: boolean;
  headers: Record<string, string>;
  keepAliveNorm: string | number;
  options?: Record<string, number | boolean | string>;
}

/** 端点判定闭包状态：Ollama 旧版回退标记（闭包持久化，避免每次探测） */
interface EmbedRuntimeState {
  /** false = 新版 /api/embed + input；true = 旧版 /api/embeddings + prompt */
  useLegacyOllama: boolean;
}

/** 解析端点形态：OpenAI 兼容 / Ollama 原生（新版 or 旧版回退） */
function resolveEmbedTarget(ecfg: EmbeddingConfig): ResolvedEmbedTarget {
  const {
    model = 'Qwen3.5-Embedding-0.6B-GGUF',
    // P2-B2: 默认改为 Ollama 原生端点（不带 /v1），走 /api/embed 而非 /v1/embeddings。
    // 原因：Ollama 的 OpenAI 兼容层 (/v1/*) 是实验性支持，keep_alive 参数可能被忽略，
    // 导致模型反复卸载加载（5m 默认 keep_alive）。原生 /api/embed 端点完整支持 keep_alive。
    baseURL = 'http://127.0.0.1:11434',
    apiKey,
    keepAlive = '-1',
    options,
  } = ecfg;

  const baseClean = cleanBaseURL(baseURL);
  const isOllama = isOllamaEndpoint(baseClean);
  // OpenAI 兼容端点：/v1（OpenAI/vLLM/LM Studio）与 /v3（OVMS 内网服务）。
  // 注意：Ollama 端点即使带 /v1 也优先走原生 /api/embed（keep_alive 生效）。
  const isOpenAiCompatible = isOpenAiCompatibleEndpoint(baseClean);
  // Ollama 端点剥离版本段后缀（避免 /v1/api/embed 非法路径）
  const baseForOllama = isOllama ? baseClean.replace(/\/v\d+\/?$/, '') : baseClean;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  // Ollama 的 keep_alive 字段：数字 -1 表示永不过期，duration 字符串如 "1h" 也可接受。
  // 但字符串 "-1" 会被 Ollama 解析为 duration 失败 → 回退到默认 5m。
  // 因此需要将 "-1" 字符串转换为数字 -1。
  const keepAliveNorm: string | number = keepAlive === '-1' ? -1 : keepAlive;

  return { baseURL, baseClean, baseForOllama, model, isOllama, isOpenAiCompatible, headers, keepAliveNorm, options };
}

/**
 * 解析 embedding 响应为与输入等长的 (number[] | null)[]。
 * - OpenAI 兼容：{ data: [{ embedding, index }] }，按 index 对齐（OVMS 明确返回 index）
 * - Ollama 新版：{ embeddings: number[][] }，按位置对齐
 * 缺失的位置保持 null（批量路径不阻塞整批）。
 */
function parseEmbedResponse(data: any, count: number, isOpenAiCompatible: boolean): (number[] | null)[] {
  const out: (number[] | null)[] = new Array(count).fill(null);
  if (isOpenAiCompatible) {
    const arr = Array.isArray(data?.data) ? data.data : null;
    if (arr) {
      for (const item of arr) {
        const emb = item?.embedding;
        if (!Array.isArray(emb)) continue;
        const rawIdx = item?.index;
        const idx = typeof rawIdx === 'number' && rawIdx >= 0 && rawIdx < count ? rawIdx : out.indexOf(null);
        if (idx >= 0) out[idx] = emb;
      }
      return out;
    }
    // 兼容部分 OpenAI 兼容端点返回的扁平格式: { embedding: number[] }
    if (Array.isArray(data?.embedding) && count >= 1) out[0] = data.embedding;
    return out;
  }
  // Ollama 原生
  if (Array.isArray(data?.embeddings)) {
    for (let i = 0; i < Math.min(count, data.embeddings.length); i++) {
      if (Array.isArray(data.embeddings[i])) out[i] = data.embeddings[i];
    }
    return out;
  }
  // 兼容旧版/部分版本: { embedding: number[] }
  if (Array.isArray(data?.embedding) && count >= 1) out[0] = data.embedding;
  // 兼容部分 Ollama 版本返回嵌套格式: { data: [{ embedding: number[] }] }
  if (Array.isArray(data?.data?.[0]?.embedding) && count >= 1) out[0] = data.data[0].embedding;
  return out;
}

/**
 * 发送一次 embedding 请求（支持单文本与多文本数组）。
 *
 * - OpenAI 兼容（/v1、OVMS /v3）：{base}/embeddings + input 数组，不发送 keep_alive
 * - Ollama 新版：/api/embed + input 数组 + keep_alive
 * - Ollama 旧版回退：/api/embeddings + prompt（仅单文本）
 *
 * 404 回退：新版端点不存在（旧版 Ollama）且为单文本时，切旧版重试一次；
 * 多文本数组遇到 404 直接抛出，由批量调用方降级为逐条请求处理。
 */
async function requestEmbed(
  target: ResolvedEmbedTarget,
  inputs: string[],
  state: EmbedRuntimeState,
): Promise<{ vecs: (number[] | null)[]; raw: any }> {
  // 最多重试一次：新版端点 404 时回退到旧版
  for (let attempt = 0; attempt < 2; attempt++) {
    let ep: string;
    let body: Record<string, unknown>;
    if (target.isOpenAiCompatible) {
      ep = target.baseClean + '/embeddings';
      body = { model: target.model, input: inputs };
    } else if (state.useLegacyOllama) {
      // 旧版 Ollama: /api/embeddings + prompt
      ep = target.baseForOllama + '/api/embeddings';
      body = { model: target.model, prompt: inputs[0], keep_alive: target.keepAliveNorm };
    } else {
      // 新版 Ollama: /api/embed + input (数组格式)
      ep = target.baseForOllama + '/api/embed';
      body = { model: target.model, input: inputs, keep_alive: target.keepAliveNorm };
    }
    // 透传额外 options：
    // - OpenAI 兼容端点：平铺到 body 顶层（dimensions/encoding_format 等标准字段本就在顶层）
    // - Ollama 原生端点：嵌套为 body.options（num_ctx/seed/temperature 等运行时参数必须嵌套）
    if (target.options) {
      if (target.isOpenAiCompatible) {
        for (const [k, v] of Object.entries(target.options)) {
          if (!(k in body)) body[k] = v;
        }
      } else {
        body.options = { ...(body.options as Record<string, unknown> | undefined), ...target.options };
      }
    }

    // 本地 Ollama 全局并发闸门（与 LLM 请求共用，OLLAMA_MAX_CONCURRENCY 默认 2）：
    // embedding 与 LLM 摘要/主生成共用同一 Ollama 队列，不加闸会叠加打爆服务端。
    const resp = await withOllamaSlot(target.baseURL, target.model, () => fetch(ep, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(llmTimeout('embedTimeoutMs')),
    }));

    // 新版端点不存在（旧版 Ollama）→ 切换旧版并重试（仅单文本可回退）
    if (resp.status === 404 && !target.isOpenAiCompatible && !state.useLegacyOllama) {
      if (inputs.length === 1) {
        state.useLegacyOllama = true;
        continue;
      }
      throw new Error(`Embedding API 404: ${ep}`);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let hint = '';
      if (resp.status === 400 && errText.includes('invalid input type')) {
        hint = '. 提示：请检查 embedding.model 配置是否为支持 embedding 的模型（如 nomic-embed-text、bge-large-zh），聊天模型（如 qwen3.6）不支持 embedding';
      }
      throw new Error(`Embedding API ${resp.status}: ${errText.slice(0, 200)}${hint}`);
    }

    const data: any = await resp.json();
    return { vecs: parseEmbedResponse(data, inputs.length, target.isOpenAiCompatible), raw: data };
  }
  // 理论上不会到达
  throw new Error('Embedding API: exhausted retries');
}

// ---------------------------------------------------------------------------
// 工厂：单文本 + 批量（共享端点解析、缓存与旧版回退状态）
// ---------------------------------------------------------------------------

/** 批量嵌入函数签名（与上游 graph-memory-pro BatchEmbedFn 对齐） */
export type BatchEmbedFn = (texts: string[]) => Promise<(number[] | null)[]>;

/** v2.8.x 对齐上游：单请求最大文本数默认 32，可经 embedding.batchSize 调整 */
const DEFAULT_BATCH_SIZE = 32;

/** 归一化批次大小：非法/非正值回退默认，避免 0 导致切分死循环 */
function resolveBatchSize(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_BATCH_SIZE;
}

export interface LocalEmbedFns {
  embed: (text: string) => Promise<number[]>;
  embedBatch: BatchEmbedFn;
}

/**
 * 创建单文本 + 批量 embedding 函数（共享端点解析 / LRU 缓存 / 旧版回退状态）。
 *
 * 每次调用都会向 embedding 端点发送 HTTP 请求，body 中包含 keep_alive（仅 Ollama），
 * 确保 Ollama 保持模型驻留内存。
 */
export function createLocalEmbedFns(ecfg: EmbeddingConfig): LocalEmbedFns {
  const target = resolveEmbedTarget(ecfg);
  const cache = new EmbedLRUCache();
  const state: EmbedRuntimeState = { useLegacyOllama: false };
  const batchSize = resolveBatchSize(ecfg.batchSize);

  async function embed(text: string): Promise<number[]> {
    if (text == null || text === '') {
      throw new Error('Embedding API: input text cannot be null, undefined, or empty');
    }
    // 缓存命中：相同 query 文本的 embedding 是确定性的
    const cacheKey = embedCacheKey(text);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { vecs, raw } = await requestEmbed(target, [text], state);
    const result = vecs[0];
    if (result) {
      cache.set(cacheKey, result);
      return result;
    }
    throw new Error(`Embedding API: missing embedding in response (keys: ${Object.keys(raw || {}).join(',')})`);
  }

  async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    if (!texts.length) return out;

    // 先查缓存，剩下未命中的才发请求（与单文本共享同一缓存）
    const pending: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (t == null || t === '') continue;
      const cached = cache.get(embedCacheKey(t));
      if (cached) { out[i] = cached; continue; }
      pending.push(i);
    }
    if (!pending.length) return out;

    // 按 batchSize 切分子批，串行发送（保持对本地 Ollama 队列的友好度）
    for (let start = 0; start < pending.length; start += batchSize) {
      const idxs = pending.slice(start, start + batchSize);
      const inputs = idxs.map((i) => texts[i]);
      try {
        const { vecs } = await requestEmbed(target, inputs, state);
        for (let k = 0; k < idxs.length; k++) {
          const v = vecs[k];
          if (v) {
            out[idxs[k]] = v;
            cache.set(embedCacheKey(inputs[k]), v);
          }
        }
      } catch (err) {
        // 子批整体失败 → 逐条降级，保留单条隔离（避免一条坏输入/超长文本拖垮整批）
        const msg = err instanceof Error ? err.message : String(err);
        for (const i of idxs) {
          try {
            const { vecs } = await requestEmbed(target, [texts[i]], state);
            const v = vecs[0];
            if (v) {
              out[i] = v;
              cache.set(embedCacheKey(texts[i]), v);
            }
          } catch { /* 单条失败 → 保持 null，由调用方降级 */ }
        }
        // 仅在子批失败时输出（逐条降级已记录各自结果）
        void msg;
      }
    }
    return out;
  }

  return { embed, embedBatch };
}

/**
 * 创建一个 embed 函数：(text: string) => Promise<number[]>
 *
 * 每次调用都会向 embedding 端点发送 HTTP 请求，body 中包含 keep_alive 字段（仅 Ollama），
 * 确保 Ollama 保持模型驻留内存。
 */
export function createLocalEmbedFn(ecfg: EmbeddingConfig): (text: string) => Promise<number[]> {
  return createLocalEmbedFns(ecfg).embed;
}

/**
 * 创建一个批量 embed 函数：(texts: string[]) => Promise<(number[] | null)[]>
 *
 * 一次 HTTP 请求携带多个文本（OpenAI 兼容 /v1、OVMS /v3 与 Ollama /api/embed 均支持
 * input 数组），显著减少请求数。返回与输入等长的数组，单条失败为 null（不阻塞整批）。
 */
export function createLocalBatchEmbedFn(ecfg: EmbeddingConfig): BatchEmbedFn {
  return createLocalEmbedFns(ecfg).embedBatch;
}

/**
 * 轻量级 Embedding API 健康探测（heartbeat 中调用）。
 * 不消耗 token，仅验证服务可达且端点正常响应。
 * - OpenAI 兼容 (baseURL 以 /v1 或 OVMS /v3 结尾): 探测 {base}/models
 * - Ollama 原生: 探测 /api/tags
 *
 * 返回 { ok: true } 或 { ok: false, detail: "具体错误信息" }。
 */
export interface EmbeddingProbeResult {
  ok: boolean;
  detail?: string;
}

export async function probeEmbeddingHealth(cfg: EmbeddingConfig): Promise<boolean> {
  return (await probeEmbeddingHealthDetailed(cfg)).ok;
}

export async function probeEmbeddingHealthDetailed(cfg: EmbeddingConfig): Promise<EmbeddingProbeResult> {
  if (!cfg?.baseURL) return { ok: false, detail: 'embedding.baseURL not configured' };
  const baseClean = cleanBaseURL(cfg.baseURL);
  // BUGFIX(P0-5): 使用 isOllamaEndpoint 判断，与 createLocalEmbedFn 保持一致
  // OVMS /v3 属于 OpenAI 兼容端点（探测 /v3/models），不得回退到 Ollama /api/tags
  const isOpenAiCompatible = isOpenAiCompatibleEndpoint(baseClean);
  const timeoutMs = 5000;

  const probePaths: string[] = isOpenAiCompatible
    ? ['/models', '/health']
    : ['/api/tags', '/health'];

  const errors: string[] = [];
  for (const path of probePaths) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`${baseClean}${path}`, {
          method: 'GET',
          signal: controller.signal,
          headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined,
        });
        if (resp.ok) return { ok: true };
        if (resp.status === 401 || resp.status === 403) return { ok: true };
        errors.push(`${path} → HTTP ${resp.status}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${path} → ${msg}`);
    }
  }
  return { ok: false, detail: errors.join('; ') };
}