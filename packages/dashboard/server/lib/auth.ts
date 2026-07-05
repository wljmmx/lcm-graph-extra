/**
 * Dashboard Basic Auth 中间件。
 *
 * 通过环境变量 DASHBOARD_AUTH 启用，格式: "user:pass"
 * 未设置时不启用鉴权（默认单机无鉴权模式）。
 *
 * 保护范围：
 * - 所有 /api/* 路由（除 /api/ping 用于健康检查）
 * - 前端静态资源（生产模式下）
 */

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

interface AuthConfig {
  enabled: boolean;
  username: string;
  password: string;
}

let _config: AuthConfig | null = null;

function getAuthConfig(): AuthConfig {
  if (_config) return _config;
  const raw = process.env.DASHBOARD_AUTH;
  if (!raw || !raw.includes(':')) {
    _config = { enabled: false, username: '', password: '' };
    return _config;
  }
  const [username, ...rest] = raw.split(':');
  const password = rest.join(':');
  _config = {
    enabled: Boolean(username && password),
    username: username ?? '',
    password: password ?? '',
  };
  return _config;
}

export function isAuthEnabled(): boolean {
  return getAuthConfig().enabled;
}

function parseBasicAuth(authHeader: string | undefined): { username: string; password: string } | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function sendUnauthorized(reply: FastifyReply, message: string = 'Authentication required'): void {
  reply.code(401).header('WWW-Authenticate', 'Basic realm="LCM Dashboard"').send({
    ok: false,
    error: message,
  });
}

export function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const cfg = getAuthConfig();
  if (!cfg.enabled) {
    done();
    return;
  }
  const creds = parseBasicAuth(req.headers.authorization);
  if (!creds) {
    sendUnauthorized(reply);
    return;
  }
  if (creds.username !== cfg.username || creds.password !== cfg.password) {
    sendUnauthorized(reply, 'Invalid credentials');
    return;
  }
  done();
}

export function requireAuthForPath(path: string): boolean {
  if (!isAuthEnabled()) return false;
  if (path === '/api/ping') return false;
  if (path.startsWith('/api/')) return true;
  if (process.env.NODE_ENV === 'production') {
    if (path === '/' || path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css')) {
      return true;
    }
  }
  return false;
}

export function _resetAuthConfig(): void {
  _config = null;
}
