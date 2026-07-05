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
  // 循环剥离包裹引号（最多 5 层，足够覆盖任何合理场景，避免无限循环）
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
  // 去掉尾部斜杠（保留协议头的双斜杠）
  s = s.replace(/\/+$/, '');
  return s;
}

/**
 * 判断 baseURL 是否指向 Ollama 端点。
 *
 * 判断依据（任一命中即视为 Ollama）：
 *  - hostname 是 127.0.0.1 / localhost / 0.0.0.0
 *  - 端口是 11434（Ollama 默认）或 18789（OpenClaw 桥接 Ollama 默认）
 *  - URL 路径包含 /api/ （Ollama 原生端点特征）
 *
 * 用于决定是否在 LLM/embedding 请求 body 注入 keep_alive。
 * OpenAI / Anthropic 等官方 API 不识别 keep_alive，传了也会被忽略，
 * 但为了减少不必要的字段，仅在 Ollama 端点时注入。
 */
export function isOllamaEndpoint(baseURL: string | undefined | null): boolean {
  const cleaned = cleanBaseURL(baseURL);
  if (!cleaned) return false;
  try {
    const u = new URL(cleaned);
    const host = u.hostname;
    const port = u.port;
    // M-5: 删除 port === '' 分支 —— localhost 无端口不能确定是 Ollama
    // （vLLM、LM Studio、Ollama 的 OpenAI 兼容网关都可能监听 localhost:80/443）
    // 仅在端口明确为 11434/18789 时判定
    if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0') {
      if (port === '11434' || port === '18789') return true;
    }
    // 端口匹配也认为是 Ollama（无论 host）
    if (port === '11434' || port === '18789') return true;
    // M-6: 收紧 /api/ 路径判断 —— 仅匹配 Ollama 原生端点特征路径
    // 避免 /v1/api/... 这类 OpenAI 兼容网关路径误判
    const OLLAMA_API_PREFIXES = ['/api/generate', '/api/chat', '/api/embed',
      '/api/tags', '/api/show', '/api/pull', '/api/push', '/api/version'];
    if (OLLAMA_API_PREFIXES.some((p) => u.pathname === p || u.pathname.startsWith(p + '/') || u.pathname.startsWith(p + '?'))) {
      return true;
    }
    return false;
  } catch {
    // URL 解析失败，做兜底字符串匹配
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
 *
 * @param baseURL 已清洗的 baseURL
 * @param baseBody 基础 body（不含 keep_alive）
 * @param keepAlive keepAlive 配置值，如 "1h"
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
