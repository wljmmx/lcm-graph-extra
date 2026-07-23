/**
 * 本地 Embedding 函数工厂 —— 确保.keep_alive 参数被正确传递给 Ollama API。
 *
 * 问题背景：graph-memory-pro 的 createEmbedFn 是外部模块，无法保证它读取
 * EmbeddingConfig.keepAlive 并写入 HTTP 请求 body 的 keep_alive 字段。
 * Ollama 默认 keep_alive=5m，模型在 5 分钟无请求后自动卸载，下次请求需重新加载，
 * 导致首次召回延迟显著（GGUF 模型加载可能数秒到数十秒）。
 *
 * 本模块实现自带的 embed 函数，明确在请求 body 中包含 keep_alive 字段，
 * 绕过 graph-memory-pro 的不确定性。支持三种端点格式：
 *
 *   - OpenAI 兼容 (/v1): POST /v1/embeddings → body { model, input, keep_alive, ...options }
 *       （OpenAI 标准，字段始终用 input；扩展 options 平铺到顶层）
 *   - Ollama 新版原生: POST /api/embed       → body { model, input, keep_alive, options: {...} }
 *       （Ollama 0.3+，字段为 input；运行时参数 num_ctx/seed 等嵌套在 options 内）
 *   - Ollama 旧版原生: POST /api/embeddings   → body { model, prompt, keep_alive, options: {...} }
 *       （Ollama 0.1.x，字段为 prompt，端点带 s；options 同样嵌套）
 *
 * 非新版端点首次 404 时自动回退到旧版并缓存，避免每次探测。
 * Ollama 原生端点的 options 嵌套：Ollama 会忽略顶层不认识的字段，运行时参数
 * （num_ctx、seed、temperature、top_k 等）必须放在 options 子对象内才会生效。
 */

import type { EmbeddingConfig } from '../types.js';
import { cleanBaseURL, isOllamaEndpoint } from '../utils/url.js';
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

/**
 * 创建一个 embed 函数：(text: string) => Promise<number[]>
 *
 * 每次调用都会向 embedding 端点发送 HTTP 请求，body 中包含 keep_alive 字段，
 * 确保 Ollama 保持模型驻留内存。
 */
export function createLocalEmbedFn(ecfg: EmbeddingConfig): (text: string) => Promise<number[]> {
  const {
    model = 'Qwen3.5-Embedding-0.6B-GGUF',
    // P2-B2: 默认改为 Ollama 原生端点（不带 /v1），走 /api/embed 而非 /v1/embeddings。
    // 原因：Ollama 的 OpenAI 兼容层 (/v1/*) 是实验性支持，keep_alive 参数可能被忽略，
    // 导致模型反复卸载加载（5m 默认 keep_alive）。原生 /api/embed 端点完整支持 keep_alive。
    // 如果用户配置了云端 OpenAI 兼容 API（baseURL 含 /v1），仍走 /v1/embeddings。
    baseURL = 'http://127.0.0.1:11434',
    apiKey,
    keepAlive = '-1',
    options,
  } = ecfg;

  // 判断 API 格式：
  //   - Ollama 端点（127.0.0.1:11434 / localhost:11434 等）→ 优先原生 /api/embed（支持 keep_alive）
  //   - 非 Ollama 且 baseURL 以 /v1 结尾 → OpenAI 兼容 /v1/embeddings
  //   - 其他 → 默认按原生 Ollama 处理（/api/embed）
  // BUGFIX(P0-5): 对于 Ollama 端点，即使 baseURL 以 /v1 结尾，也优先使用原生 /api/embed。
  // 因为 Ollama 的 OpenAI 兼容 /v1/embeddings 端点不识别 keep_alive 参数，
  // 会导致模型 5 分钟后自动卸载，keep_alive=1h 完全失效。
  // 同时剥离 /v1 后缀，避免拼接出 /v1/api/embed 这样的非法路径。
  const baseClean = cleanBaseURL(baseURL);
  const isOllama = isOllamaEndpoint(baseClean);
  const isOpenAiCompatible = !isOllama && /\/v1\/?$/.test(baseClean);
  // Ollama 原生端点（/api/embed 和 /api/embeddings）要求运行时参数嵌套在 options 子对象内，
  // 不能平铺到 body 顶层（顶层会被 Ollama 静默忽略，导致 num_ctx/seed/temperature 等失效）。
  // OpenAI 兼容端点的扩展字段（dimensions/encoding_format）本就在顶层，保持平铺。
  const isOllamaNative = !isOpenAiCompatible;
  // Ollama 端点剥离 /v1 后缀（避免 /v1/api/embed 非法路径）
  const baseForOllama = isOllama ? baseClean.replace(/\/v1\/?$/, '') : baseClean;

  // 预构建请求头
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  // Ollama 的 keep_alive 字段：数字 -1 表示永不过期，duration 字符串如 "1h" 也可接受。
  // 但字符串 "-1" 会被 Ollama 解析为 duration 失败 → 回退到默认 5m。
  // 因此需要将 "-1" 字符串转换为数字 -1。
  const keepAliveNorm: string | number = keepAlive === '-1' ? -1 : keepAlive;
  // Ollama 原生端点版本探测状态（闭包持久化，避免每次都探测）
  // false = 新版 /api/embed + input；true = 旧版 /api/embeddings + prompt
  let useLegacyOllama = false;

  // LRU 缓存：相同 text 的 embedding 结果缓存（assemble 中相似 query 可命中）
  const cache = new EmbedLRUCache();

  return async function embed(text: string): Promise<number[]> {
    if (text == null || text === '') {
      throw new Error('Embedding API: input text cannot be null, undefined, or empty');
    }
    // 缓存命中：相同 query 文本的 embedding 是确定性的
    const cacheKey = text.length > 500 ? text.slice(0, 500) + ':' + text.length : text;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    // 最多重试一次：新版端点 404 时回退到旧版
    for (let attempt = 0; attempt < 2; attempt++) {
      // v1 始终用 OpenAI 标准格式（input）；非 v1 根据 useLegacyOllama 选择端点和字段
      let ep: string;
      let body: Record<string, unknown>;
      if (isOpenAiCompatible) {
        ep = baseClean + '/embeddings';
        body = { model, input: [text], keep_alive: keepAliveNorm };
      } else if (useLegacyOllama) {
        // 旧版 Ollama: /api/embeddings + prompt
        ep = baseForOllama + '/api/embeddings';
        body = { model, prompt: text, keep_alive: keepAliveNorm };
      } else {
        // 新版 Ollama: /api/embed + input (数组格式)
        ep = baseForOllama + '/api/embed';
        body = { model, input: [text], keep_alive: keepAliveNorm };
      }
      // 透传额外 options：
      // - OpenAI 兼容端点：平铺到 body 顶层（dimensions/encoding_format 等标准字段本就在顶层）
      // - Ollama 原生端点：嵌套为 body.options（num_ctx/seed/temperature 等运行时参数必须嵌套）
      if (options) {
        if (isOllamaNative) {
          // 保留已有 options 字段（理论上不应有），合并用户 options
          body.options = { ...(body.options as Record<string, unknown> | undefined), ...options };
        } else {
          for (const [k, v] of Object.entries(options)) {
            if (!(k in body)) body[k] = v;
          }
        }
      }

      const resp = await fetch(ep, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(llmTimeout('embedTimeoutMs')),
      });

      // 新版端点不存在（旧版 Ollama）→ 切换旧版并重试
      if (resp.status === 404 && !isOpenAiCompatible && !useLegacyOllama) {
        useLegacyOllama = true;
        continue;
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

      // 统一提取 embedding 向量（支持多种响应格式），命中后写入缓存并返回
      let result: number[] | null = null;
      if (isOpenAiCompatible) {
        // OpenAI 兼容格式: { data: [{ embedding: number[] }] }
        const embedding = data?.data?.[0]?.embedding;
        if (Array.isArray(embedding)) result = embedding;
        // 兼容部分 OpenAI 兼容端点返回的扁平格式: { embedding: number[] }
        if (!result) {
          const flatEmbedding = data?.embedding;
          if (Array.isArray(flatEmbedding)) result = flatEmbedding;
        }
      } else {
        // Ollama 原生格式（新版）: { embedding: number[] }
        const embedding = data?.embedding;
        if (Array.isArray(embedding)) result = embedding;
        // Ollama 新版 /api/embed 响应: { embeddings: number[][] }
        if (!result) {
          const embeddings = data?.embeddings;
          if (Array.isArray(embeddings) && embeddings.length > 0 && Array.isArray(embeddings[0])) result = embeddings[0];
        }
        // 兼容部分 Ollama 版本返回嵌套格式: { data: [{ embedding: number[] }] }
        if (!result) {
          const nestedEmbedding = data?.data?.[0]?.embedding;
          if (Array.isArray(nestedEmbedding)) result = nestedEmbedding;
        }
      }
      if (result) {
        cache.set(cacheKey, result);
        return result;
      }
      throw new Error(`Embedding API: missing embedding in response (keys: ${Object.keys(data || {}).join(',')})`);
    }
    // 理论上不会到达
    throw new Error('Embedding API: exhausted retries');
  };
}

/**
 * 轻量级 Embedding API 健康探测（heartbeat 中调用）。
 * 不消耗 token，仅验证服务可达且端点正常响应。
 * - OpenAI 兼容 (baseURL 以 /v1 结尾): 探测 /v1/models
 * - Ollama 原生: 探测 /api/tags
 *
 * 返回 true 表示服务可用，false 表示不可用。
 */
export async function probeEmbeddingHealth(cfg: EmbeddingConfig): Promise<boolean> {
  if (!cfg?.baseURL) return false;
  const baseClean = cleanBaseURL(cfg.baseURL);
  // BUGFIX(P0-5): 使用 isOllamaEndpoint 判断，与 createLocalEmbedFn 保持一致
  const isOllama = isOllamaEndpoint(baseClean);
  const isOpenAiCompatible = !isOllama && /\/v1\/?$/.test(baseClean);
  const timeoutMs = 5000;

  const probePaths: string[] = isOpenAiCompatible
    ? ['/models', '/health']
    : ['/api/tags', '/health'];

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
        if (resp.ok) return true;
        if (resp.status === 401 || resp.status === 403) return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      continue;
    }
  }
  return false;
}
