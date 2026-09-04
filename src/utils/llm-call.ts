import { cleanBaseURL, detectApiFormat, isOllamaEndpoint } from './url.js';

export interface LlmCallParams {
  baseURL: string;
  apiKey?: string;
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  keepAlive?: string;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  /**
   * LLM 思考模式开关：
   *  - Ollama 原生/OpenAI 兼容端点透传 think 字段（不识别该字段的服务会自动忽略）
   *  - true  开启 reasoning（深度思考）
   *  - false 关闭思考（快速输出）
   *  - 缺省不传，保持服务端默认
   */
  think?: boolean;
}

export interface LlmCallResult {
  text: string;
  reasoning?: string;
  raw: any;
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function buildOpenAiBody(params: LlmCallParams): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [];
  if (params.system) {
    messages.push({ role: 'system', content: params.system });
  }
  messages.push({ role: 'user', content: params.prompt });
  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    temperature: params.temperature ?? 0.3,
    max_tokens: params.maxTokens ?? 2048,
  };
  if (params.keepAlive && isOllamaEndpoint(params.baseURL)) {
    body.keep_alive = params.keepAlive;
  }
  // 思考模式开关：透传 think 字段（不识别该字段的服务自动忽略）
  if (params.think !== undefined) {
    body.think = params.think;
  }
  return body;
}

function buildAnthropicBody(params: LlmCallParams): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [
    { role: 'user', content: params.prompt },
  ];
  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    temperature: params.temperature ?? 0.3,
    max_tokens: params.maxTokens ?? 2048,
  };
  if (params.system) {
    body.system = params.system;
  }
  return body;
}

function getEndpoint(baseURL: string, format: 'openai' | 'anthropic'): string {
  const clean = cleanBaseURL(baseURL);
  if (format === 'anthropic') {
    if (clean.endsWith('/v1/messages') || clean.endsWith('/messages')) return clean;
    if (clean.endsWith('/v1')) return clean + '/messages';
    return clean + '/v1/messages';
  }
  if (clean.endsWith('/v1/chat/completions')) return clean;
  if (clean.endsWith('/v1')) return clean + '/chat/completions';
  return clean + '/v1/chat/completions';
}

function parseOpenAiResponse(data: any): LlmCallResult {
  const msg = data?.choices?.[0]?.message;
  let text = msg?.content ?? '';
  let reasoning = msg?.reasoning_content;
  if (!text && reasoning) {
    text = reasoning;
  }
  if (text) {
    text = stripThinkTags(text);
  }
  return { text, reasoning, raw: data };
}

function parseAnthropicResponse(data: any): LlmCallResult {
  const contents: any[] = data?.content ?? [];
  let text = '';
  let reasoning = '';
  for (const block of contents) {
    if (block?.type === 'text') {
      text += block.text ?? '';
    } else if (block?.type === 'thinking') {
      reasoning += block.thinking ?? '';
    }
  }
  if (text) {
    text = stripThinkTags(text);
  }
  return { text, reasoning, raw: data };
}

/**
 * 默认调用超时：调用方未传 signal 时的兜底期限。
 *
 * 背景：callLlm 原先完全依赖调用方传 signal，而注入给 lossless-claw 的
 * llm.complete（buildLocalLlmComplete / buildConfiguredLlmComplete）只透传
 * p?.signal —— lossless-claw 不传 signal → 压缩/轮后维护的 LLM 调用无界。
 * Ollama 串行排队或网络半开时请求永久挂起，fire-and-forget 后台任务
 * 逐渐堆积成僵尸，最终拖垮会话（host "stopped making progress"/timeout）。
 *
 * 180s 取值依据：本地 27B 模型长输入摘要最坏 ~2min（distillMs 默认 120s
 * 同类场景），留 50% 余量；短调用（rerank 等）均自带更短 signal，不受影响。
 */
const DEFAULT_CALL_TIMEOUT_MS = Math.max(
  5_000,
  parseInt(process.env.LCM_GRAPH_EXTRA_LLM_CALL_TIMEOUT_MS || '0', 10) || 180_000,
);

export async function callLlm(params: LlmCallParams): Promise<LlmCallResult> {
  const format = detectApiFormat(params.baseURL, params.model);
  const endpoint = getEndpoint(params.baseURL, format);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.apiKey) {
    if (format === 'anthropic') {
      headers['x-api-key'] = params.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = 'Bearer ' + params.apiKey;
    }
  }
  if (params.extraHeaders) {
    Object.assign(headers, params.extraHeaders);
  }
  const body = format === 'anthropic'
    ? buildAnthropicBody(params)
    : buildOpenAiBody(params);

  // 超时兜底：无 signal 时挂全局默认期限；调用方自带 signal（含 AbortSignal.timeout）
  // 时完全尊重调用方，行为不变。
  const signal = params.signal ?? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '<unreadable>');
    const err = new Error(`LLM HTTP ${resp.status}: ${errBody.slice(0, 300)}`);
    (err as any).status = resp.status;
    (err as any).endpoint = endpoint;
    throw err;
  }

  const data = await resp.json();
  return format === 'anthropic'
    ? parseAnthropicResponse(data)
    : parseOpenAiResponse(data);
}

export function isLocalLlm(baseURL: string | undefined | null, model?: string): boolean {
  const cleaned = cleanBaseURL(baseURL);
  if (!cleaned) return false;
  try {
    const u = new URL(cleaned);
    const host = u.hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0') return true;
    if (host.endsWith('.local')) return true;
    const ipMatch = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const na = Number(ipMatch[1]);
      const nb = Number(ipMatch[2]);
      if (na === 10) return true;
      if (na === 172 && nb >= 16 && nb <= 31) return true;
      if (na === 192 && nb === 168) return true;
    }
    return false;
  } catch {
    const lower = cleaned.toLowerCase();
    return (
      lower.includes('127.0.0.1') ||
      lower.includes('localhost') ||
      lower.includes('0.0.0.0') ||
      lower.includes('.local') ||
      /\b10\.\d+\.\d+\.\d+\b/.test(lower) ||
      /\b192\.168\.\d+\.\d+\b/.test(lower) ||
      /\b172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+\b/.test(lower)
    );
  }
}
