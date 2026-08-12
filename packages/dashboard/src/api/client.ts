/**
 * 前端 API 客户端：基础 fetch 封装，统一错误处理。
 * dev 模式下 /api 由 vite 代理到后端 :7421，生产模式同源直连。
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

/** GET 请求 */
export async function apiGet<T>(path: string): Promise<T> {
  const resp = await fetch(path, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      // 忽略读取错误
    }
    throw new ApiError(
      `GET ${path} 失败: HTTP ${resp.status}${detail ? ` - ${detail}` : ''}`,
      resp.status,
      path,
    );
  }
  return (await resp.json()) as T;
}

/** POST 请求 */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      // 忽略读取错误
    }
    throw new ApiError(
      `POST ${path} 失败: HTTP ${resp.status}${detail ? ` - ${detail}` : ''}`,
      resp.status,
      path,
    );
  }
  return (await resp.json()) as T;
}

/** PATCH 请求 */
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      // 忽略读取错误
    }
    throw new ApiError(
      `PATCH ${path} 失败: HTTP ${resp.status}${detail ? ` - ${detail}` : ''}`,
      resp.status,
      path,
    );
  }
  return (await resp.json()) as T;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      // 忽略读取错误
    }
    throw new ApiError(
      `PUT ${path} 失败: HTTP ${resp.status}${detail ? ` - ${detail}` : ''}`,
      resp.status,
      path,
    );
  }
  return (await resp.json()) as T;
}

/** DELETE 请求 */
export async function apiDelete<T>(path: string): Promise<T> {
  const resp = await fetch(path, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      // 忽略读取错误
    }
    throw new ApiError(
      `DELETE ${path} 失败: HTTP ${resp.status}${detail ? ` - ${detail}` : ''}`,
      resp.status,
      path,
    );
  }
  return (await resp.json()) as T;
}

