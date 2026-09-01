/**
 * 前端 API 客户端：基础 fetch 封装 + 统一错误处理 + 冷启动 race 自愈重试。
 *
 * dev 模式下 /api 由 vite 代理到后端 :7421，生产模式同源直连。
 *
 * ── 冷启动 race 修复 ──
 * TanStack Query 首次请求若发生在 dashboard server 尚未 listen 的瞬间，
 * fetch 会抛 TypeError("Failed to fetch")，TanStack 会将 isError 置 true
 * 并在用户侧显示 "不可达" 横幅。
 *
 * 本层对 "网络层 transient 错误" (TypeError / AbortError / 连接失败) 做
 * 自重试：首次失败后 3 次指数退避（200ms → 400ms → 800ms），
 * 让后端在首轮 TanStack refetch 到来前就恢复。
 *
 * 业务层 HTTP 非 2xx 不走重试——那是确定性的错误（鉴权、不存在、限流），
 * 重试只会浪费资源。
 *
 * 注意：写入方法(POST/PUT/PATCH/DELETE) 的重试仅限于
 * "请求在到达后端之前就因为网络层失败而中断" 的场景，
 * 不会造成两次资源创建（因为后端根本没收到第一次请求）。
 */

/** API 错误（统一形态） */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 冷启动 transient 错误判定：
 * - TypeError: Failed to fetch (连接被拒 / 目标端口未监听)
 * - AbortError (浏览器/中间层超时中断)
 * - TypeError 内含 "NetworkError" 或 "fetch failed"
 */
function isNetworkTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  if (err instanceof TypeError) return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('fetch failed')
  );
}

async function withNetworkRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const MAX_ATTEMPTS = 4; // 1 次首尝试 + 3 次重试
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isNetworkTransient(err) || attempt === MAX_ATTEMPTS) throw err;
      // 指数退避：200ms → 400ms → 800ms
      const delay = 200 * Math.pow(2, attempt - 1);
      // eslint-disable-next-line no-console
      console.debug(`[api-client] ${label} transient network error, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // 理论上不会走到这里（throw 在循环内）
  throw lastErr;
}

/** 执行 HTTP 请求 + 网络层重试 + 统一错误形态 */
async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return withNetworkRetry(async () => {
    const headers: Record<string, string> = { accept: 'application/json' };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(path, init);
    if (!resp.ok) {
      let detail = '';
      try {
        detail = await resp.text();
      } catch {
        // 忽略读取错误
      }
      throw new ApiError(
        `${method} ${path} 失败: HTTP ${resp.status}${detail ? ` - ${detail}` : ''}`,
        resp.status,
        path,
      );
    }
    return (await resp.json()) as T;
  }, `${method} ${path}`);
}

/** GET 请求 */
export async function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

/** POST 请求 */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>('POST', path, body ?? {});
}

/** PATCH 请求 */
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PATCH', path, body ?? {});
}

/** PUT 请求 */
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, body ?? {});
}

/** DELETE 请求 */
export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}
