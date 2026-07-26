/**
 * URL 清洗与端点判断工具。
 *
 * 解决两类常见配置污染：
 *  1. 用户从 Markdown / 文档中复制 baseURL 时混入反引号、引号、首尾空格，
 *     导致 fetch URL 非法（如 "`http://192.168.50.5:11434`"）。
 *  2. 不同来源 baseURL 末尾斜杠数量不一致（/v1, /v1/, /v1//），影响拼接。
 *
 * 同时提供 Ollama 端点判断，用于决定是否在请求 body 注入 keep_alive
 * （OpenAI 官方 API 不识别该字段，会被忽略；只有 Ollama 系列端点才生效）。
 */

/**
 * 清洗 baseURL：
 *  - trim 首尾空格 / 换行
 *  - 去掉包裹的反引号、单引号、双引号（含两侧不配对的情况）
 *  - 去掉尾部多余斜杠
 *  - 多次循环以应对 "`xxx`" 这类多层包裹
 *
 * @example
 *   cleanBaseURL('`http://192.168.50.5:11434`')  → 'http://192.168.50.5:11434'
 *   cleanBaseURL(' "http://x/v1/" ')              → 'http://x/v1'
 *   cleanBaseURL('http://x/v1//')                 → 'http://x/v1'
 */
export function cleanBaseURL(url: string | undefined | null): string {
  if (!url) return '';
  let s = String(url).trim();
  for (let i = 0; i < 5; i++) {
    const len = s.length;
    const first = s[0];
    const last = s[len - 1];
    const isWrapped =
      (first === '`' || first === '"' || first === "'") &&
      (last === '`' || last === '"' || last === "'");
    if (!isWrapped) break;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\/+$/, '');
  return s;
}

/**
 * 判断 baseURL 是否指向 Ollama 端点。
 *
 * 判断依据（任一命中即视为 Ollama）：
 *  - hostname 是 127.0.0.1 / localhost / 0.0.0.0 且端口是 11434/18789
 *  - 端口是 11434（Ollama 默认）或 18789（OpenClaw 桥接 Ollama 默认）
 *  - URL 路径是 Ollama 原生端点（/api/generate, /api/chat 等）
 *
 * 用于决定是否在 LLM/embedding 请求 body 注入 keep_alive。
 */
export function isOllamaEndpoint(baseURL: string | undefined | null): boolean {
  const cleaned = cleanBaseURL(baseURL);
  if (!cleaned) return false;
  try {
    const u = new URL(cleaned);
    const host = u.hostname;
    const port = u.port;
    if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0') {
      if (port === '11434' || port === '18789') return true;
    }
    if (port === '11434' || port === '18789') return true;
    const OLLAMA_API_PREFIXES = ['/api/generate', '/api/chat', '/api/embed',
      '/api/tags', '/api/show', '/api/pull', '/api/push', '/api/version'];
    if (OLLAMA_API_PREFIXES.some((p) => u.pathname === p || u.pathname.startsWith(p + '/') || u.pathname.startsWith(p + '?'))) {
      return true;
    }
    return false;
  } catch {
    const lower = cleaned.toLowerCase();
    return (
      lower.includes(':11434') ||
      lower.includes(':18789') ||
      lower.includes('/api/embed') ||
      lower.includes('/api/generate') ||
      lower.includes('/api/chat')
    );
  }
}

/**
 * 构造 LLM 请求 body 的辅助函数：
 *  - 自动注入 keep_alive（仅 Ollama 端点）
 *  - 保证不污染 OpenAI 等官方端点
 */
export function withKeepAliveIfOllama(
  baseURL: string,
  baseBody: Record<string, unknown>,
  keepAlive?: string,
): Record<string, unknown> {
  if (keepAlive && isOllamaEndpoint(baseURL)) {
    return { ...baseBody, keep_alive: keepAlive };
  }
  return baseBody;
}

/**
 * 判断 baseURL 是否指向本地/私有部署端点。
 *
 * 判断依据（任一命中即视为本地）：
 *  - hostname 是 127.0.0.1 / localhost / 0.0.0.0
 *  - hostname 是私有网段 IP：10.x.x.x / 172.(16-31).x.x / 192.168.x.x
 *  - hostname 以 .local 结尾（mDNS 本地域名）
 *
 * 与 isOllamaEndpoint 的区别：
 *  - isOllamaEndpoint 判断具体产品（Ollama），用于 keep_alive 等 Ollama 特有功能
 *  - isLocalEndpoint 判断部署位置，用于模型复用、超时策略等通用本地模型优化
 */
export function isLocalEndpoint(baseURL: string | undefined | null): boolean {
  const cleaned = cleanBaseURL(baseURL);
  if (!cleaned) return false;
  try {
    const u = new URL(cleaned);
    const host = u.hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0') return true;
    if (host.endsWith('.local')) return true;
    const ipMatch = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch;
      const na = Number(a);
      const nb = Number(b);
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

/**
 * 判断 LLM API 格式：OpenAI 兼容 或 Anthropic Messages 格式。
 *
 * 判断依据：
 *  - baseURL 路径包含 /v1/messages 或 /messages → Anthropic 格式
 *  - 模型名以 claude- 开头 → Anthropic 格式
 *  - 其他 → 默认 OpenAI 兼容格式
 *
 * 用途：决定请求 body 格式和端点路径。
 */
export function detectApiFormat(baseURL: string | undefined | null, model?: string): 'openai' | 'anthropic' {
  const cleaned = cleanBaseURL(baseURL);
  if (cleaned) {
    try {
      const u = new URL(cleaned);
      const path = u.pathname.toLowerCase();
      if (path.includes('/v1/messages') || path.includes('/messages')) return 'anthropic';
    } catch {
      const lower = cleaned.toLowerCase();
      if (lower.includes('/v1/messages') || lower.includes('/messages')) return 'anthropic';
    }
  }
  if (model?.startsWith('claude-')) return 'anthropic';
  return 'openai';
}

/**
 * 确保 Ollama 端点的 baseURL 包含 /v1 路径。
 *
 * Ollama 的 OpenAI 兼容端点是 http://host:11434/v1/chat/completions，
 * 但用户配置中常写 http://host:11434（不带 /v1），导致 fetch 拼出
 * http://host:11434/chat/completions → 404。
 *
 * 仅对 Ollama 端点（isOllamaEndpoint 判定）补全 /v1，
 * 其他端点（OpenAI / vLLM / LM Studio 等）原样返回。
 *
 * @example
 *   ensureOllamaV1Path('http://192.168.50.5:11434')    → 'http://192.168.50.5:11434/v1'
 *   ensureOllamaV1Path('http://127.0.0.1:11434/v1')    → 'http://127.0.0.1:11434/v1'  (已有 /v1，不变)
 *   ensureOllamaV1Path('https://api.openai.com/v1')    → 'https://api.openai.com/v1'  (非 Ollama，不变)
 */
export function ensureOllamaV1Path(baseURL: string | undefined | null): string {
  const cleaned = cleanBaseURL(baseURL);
  if (!cleaned) return '';
  if (!isOllamaEndpoint(cleaned)) return cleaned;
  if (/\/v\d+$/.test(cleaned)) return cleaned;
  return cleaned + '/v1';
}

/**
 * 确保 Anthropic Messages 端点的 baseURL 包含 /v1/messages 路径。
 *
 * unsloth 等本地部署的 Anthropic 格式端点，用户配置中常写
 * http://192.168.50.5:8888（不带 /v1/messages），导致请求路径错误。
 * 此函数自动补全：
 *  - http://host:port               → http://host:port/v1/messages
 *  - http://host:port/v1            → http://host:port/v1/messages
 *  - http://host:port/v1/messages   → 不变
 *  - http://host:port/messages      → 不变
 *
 * @example
 *   ensureAnthropicMessagesPath('http://192.168.50.5:8888')        → 'http://192.168.50.5:8888/v1/messages'
 *   ensureAnthropicMessagesPath('http://127.0.0.1:8000/v1')        → 'http://127.0.0.1:8000/v1/messages'
 *   ensureAnthropicMessagesPath('http://host:8000/v1/messages')    → 'http://host:8000/v1/messages'  (已有，不变)
 */
export function ensureAnthropicMessagesPath(baseURL: string | undefined | null): string {
  const cleaned = cleanBaseURL(baseURL);
  if (!cleaned) return '';
  // 已有 /messages 后缀则不重复添加
  if (/\/messages$/.test(cleaned)) return cleaned;
  // 已有 /v1 后缀则补全 /messages
  if (/\/v\d+$/.test(cleaned)) return cleaned + '/messages';
  // 裸 baseURL 补全 /v1/messages
  return cleaned + '/v1/messages';
}
