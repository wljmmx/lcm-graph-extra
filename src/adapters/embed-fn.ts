/**
 * 本地 Embedding 函数工厂 —— 确保.keep_alive 参数被正确传递给 Ollama API。
 *
 * 问题背景：graph-memory-pro 的 createEmbedFn 是外部模块，无法保证它读取
 * EmbeddingConfig.keepAlive 并写入 HTTP 请求 body 的 keep_alive 字段。
 * Ollama 默认 keep_alive=5m，模型在 5 分钟无请求后自动卸载，下次请求需重新加载，
 * 导致首次召回延迟显著（GGUF 模型加载可能数秒到数十秒）。
 *
 * 本模块实现自带的 embed 函数，明确在请求 body 中包含 keep_alive 字段，
 * 绕过 graph-memory-pro 的不确定性。支持两种 API 格式：
 *   - Ollama 原生: POST /api/embed   → body 含 { model, input, keep_alive }
 *   - OpenAI 兼容: POST /v1/embeddings → body 含 { model, input, keep_alive }
 *
 * Ollama 的 OpenAI 兼容端点也支持 keep_alive 字段（非标准但有效）。
 */

import type { EmbeddingConfig } from '../types.js';

/**
 * 创建一个 embed 函数：(text: string) => Promise<number[]>
 *
 * 每次调用都会向 embedding 端点发送 HTTP 请求，body 中包含 keep_alive 字段，
 * 确保 Ollama 保持模型驻留内存。
 */
export function createLocalEmbedFn(ecfg: EmbeddingConfig): (text: string) => Promise<number[]> {
  const {
    model = 'Qwen3.5-Embedding-0.6B-GGUF',
    baseURL = 'http://127.0.0.1:11434/v1',
    apiKey,
    keepAlive = '1h',
    options,
  } = ecfg;

  // 判断 API 格式：baseURL 以 /v1 结尾走 OpenAI 兼容，否则走 Ollama 原生
  const isOpenAiCompatible = /\/v1\/?$/.test(baseURL);
  const endpoint = isOpenAiCompatible
    ? baseURL.replace(/\/+$/, '') + '/embeddings'
    : baseURL.replace(/\/+$/, '') + '/api/embed';

  // 预构建请求头
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  return async function embed(text: string): Promise<number[]> {
    // 构建 body，始终包含 keep_alive 字段（Ollama 原生和 OpenAI 兼容端点均支持）
    const body: Record<string, unknown> = {
      model,
      input: text,
      keep_alive: keepAlive,
    };
    // 透传额外 options（如 temperature、seed 等，Ollama 会忽略不认识的字段）
    if (options) {
      for (const [k, v] of Object.entries(options)) {
        if (!(k in body)) body[k] = v;
      }
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Embedding API ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data: any = await resp.json();

    // OpenAI 兼容格式: { data: [{ embedding: number[] }] }
    if (isOpenAiCompatible) {
      const embedding = data?.data?.[0]?.embedding;
      if (Array.isArray(embedding)) return embedding;
      throw new Error('Embedding API: missing data[0].embedding in response');
    }

    // Ollama 原生格式: { embedding: number[] }
    const embedding = data?.embedding;
    if (Array.isArray(embedding)) return embedding;
    throw new Error('Embedding API: missing embedding in response');
  };
}
