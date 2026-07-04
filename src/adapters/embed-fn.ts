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
 *   - OpenAI 兼容 (/v1): POST /v1/embeddings → body { model, input, keep_alive }
 *       （OpenAI 标准，字段始终用 input，保持 OpenAI 旧格式不变）
 *   - Ollama 新版原生: POST /api/embed       → body { model, input, keep_alive }
 *       （Ollama 0.3+，字段为 input）
 *   - Ollama 旧版原生: POST /api/embeddings   → body { model, prompt, keep_alive }
 *       （Ollama 0.1.x，字段为 prompt，端点带 s）
 *
 * 非新版端点首次 404 时自动回退到旧版并缓存，避免每次探测。
 */

import type { EmbeddingConfig } from '../types.js';
import { cleanBaseURL } from '../utils/url.js';

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
  // 使用 cleanBaseURL 清洗可能的反引号/引号/首尾空格污染（用户从 markdown 复制时常见）
  const baseClean = cleanBaseURL(baseURL);
  const isOpenAiCompatible = /\/v1\/?$/.test(baseClean);

  // 预构建请求头
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  // Ollama 原生端点版本探测状态（闭包持久化，避免每次都探测）
  // false = 新版 /api/embed + input；true = 旧版 /api/embeddings + prompt
  let useLegacyOllama = false;

  return async function embed(text: string): Promise<number[]> {
    // 最多重试一次：新版端点 404 时回退到旧版
    for (let attempt = 0; attempt < 2; attempt++) {
      // v1 始终用 OpenAI 标准格式（input）；非 v1 根据 useLegacyOllama 选择端点和字段
      let ep: string;
      let body: Record<string, unknown>;
      if (isOpenAiCompatible) {
        ep = baseClean + '/embeddings';
        body = { model, input: text, keep_alive: keepAlive };
      } else if (useLegacyOllama) {
        // 旧版 Ollama: /api/embeddings + prompt
        ep = baseClean + '/api/embeddings';
        body = { model, prompt: text, keep_alive: keepAlive };
      } else {
        // 新版 Ollama: /api/embed + input
        ep = baseClean + '/api/embed';
        body = { model, input: text, keep_alive: keepAlive };
      }
      // 透传额外 options（Ollama 会忽略不认识的字段）
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          if (!(k in body)) body[k] = v;
        }
      }

      const resp = await fetch(ep, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      // 新版端点不存在（旧版 Ollama）→ 切换旧版并重试
      if (resp.status === 404 && !isOpenAiCompatible && !useLegacyOllama) {
        useLegacyOllama = true;
        continue;
      }

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

      // Ollama 原生格式（新旧版响应相同）: { embedding: number[] }
      const embedding = data?.embedding;
      if (Array.isArray(embedding)) return embedding;
      throw new Error('Embedding API: missing embedding in response');
    }
    // 理论上不会到达
    throw new Error('Embedding API: exhausted retries');
  };
}
