/**
 * graph-memory-pro HTTP API 代理路由。
 *
 * 将 dashboard 前端的请求代理到 graph-memory-pro 的独立 HTTP API 服务器。
 *
 * **重要：graph-memory-pro v2.3.3+ 使用独立 HTTP 服务器（node:http），
 * 不再通过 api.registerHttpRoute() 注册到 OpenClaw Gateway。**
 * 默认监听 http://127.0.0.1:7850（与 MCP :7800 区分）。
 *
 * 代理路径映射：
 *   GET  /api/gm-pro/proxy/status       → {GM_PRO_HTTP_URL}/api/status
 *   GET  /api/gm-pro/proxy/stats        → {GM_PRO_HTTP_URL}/api/stats
 *   GET  /api/gm-pro/proxy/health       → {GM_PRO_HTTP_URL}/api/health
 *   GET  /api/gm-pro/proxy/search?...   → {GM_PRO_HTTP_URL}/api/search?...
 *   ... 等所有 graph-memory-pro HTTP API 路由
 *
 * 配置：
 *   GM_PRO_HTTP_URL —— graph-memory-pro 独立 API 服务器地址（默认 http://127.0.0.1:7850）
 *   GM_PRO_HTTP_TIMEOUT —— 代理超时（ms），默认 10s
 *   鉴权令牌 —— 从 openclaw.json 中 graph-memory-pro 配置段 apiServer.authToken 读取（无需环境变量）
 *
 * 安全：
 *   - GET 仅允许只读路径（白名单校验），拒绝其他写操作
 *   - POST 仅允许白名单中的写路径（如 /api/feedback/bootstrap）
 *   - 路径白名单校验，防止 SSRF 遍历
 *   - 携带 X-Auth-Token 头（取自 openclaw.json 的 apiServer.authToken），对应 graph-memory-pro 的 authToken 配置
 *   - 独立服务器自带 CORS 支持，不依赖 Gateway 的 Basic Auth
 *
 * ⚠️ 鉴权依赖：
 *   graph-memory-pro HTTP 服务器将以下路径标记为敏感读路径（需 X-Auth-Token 鉴权）：
 *     /api/health, /api/metrics, /api/usage, /api/doctor
 *   若 openclaw.json 未配置 apiServer.authToken 而 graph-memory-pro 配置了 authToken，
 *   这些路径将返回 401 Unauthorized。请确保两端配置一致。
 */
import type { FastifyInstance } from 'fastify';
import { readGmProRawConfig } from './config';

/** graph-memory-pro 独立 API 服务器地址（默认 http://127.0.0.1:7850） */
const GM_PRO_HTTP_URL = process.env.GM_PRO_HTTP_URL ?? 'http://127.0.0.1:7850';
const GM_PRO_HTTP_TIMEOUT = Number(process.env.GM_PRO_HTTP_TIMEOUT ?? 10_000);

/**
 * graph-memory-pro 鉴权令牌（X-Auth-Token）。
 * 来源：openclaw.json 中 graph-memory-pro 插件配置段 apiServer.authToken，
 * 与 graph-memory-pro 独立 HTTP 服务使用同一配置，无需额外环境变量。
 */
function resolveGmProAuthToken(): string {
  const cfg = readGmProRawConfig();
  return (cfg.apiServer as { authToken?: string } | undefined)?.authToken ?? '';
}

/** graph-memory-pro 已知的只读 API 路径白名单 */
const ALLOWED_GM_PRO_PATHS = new Set([
  '/api/status',
  '/api/stats',
  '/api/health',
  '/api/nodes',
  '/api/search',
  '/api/top',
  '/api/nodes-by-type',
  '/api/communities',
  '/api/graph/walk',
  '/api/schema',
  '/api/maintain/dirty-nodes',
  '/api/metrics',
  '/api/auto-tuner/state',
  '/api/association-matrix/state',
  '/api/association-matrix/history',
  '/api/association-matrix/visual',
  '/api/doctor',
  '/api/usage',
  '/api/config',
  '/api/ops/services',
]);

/** graph-memory-pro 允许的 POST 写 API 路径白名单（v2.3.5+） */
const ALLOWED_GM_PRO_POST_PATHS = new Set([
  '/api/feedback/bootstrap',
  // 关联矩阵 M 持久化（save / load）
  '/api/association-matrix/save',
  '/api/association-matrix/load',
]);

export async function registerGmProRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/gm-pro/proxy/*
   *
   * 将请求路径中 /api/gm-pro/proxy/ 之后的部分拼接到 Gateway HTTP URL。
   */
  app.get('/api/gm-pro/proxy/*', async (req, reply) => {
    // 提取代理路径：/api/gm-pro/proxy/status → /api/status
    // 示例：GET /api/gm-pro/proxy/status → proxy to {GM_PRO_HTTP_URL}/api/status
    // v2.7.0 P1-FIX: 修复前 urlPath.replace('/api/gm-pro/proxy', '') 把 /api 也 strip 了，
    // 导致 proxyPath = /status 而非 /api/status，白名单校验失败返回 403。
    const urlPath = req.url.split('?')[0];
    const proxyPath = urlPath.replace('/gm-pro/proxy', '');

    // 路径白名单校验（前缀匹配，/api/nodes/abc 匹配 /api/nodes）
    const basePath = '/' + proxyPath.split('/').filter(Boolean).slice(0, 3).join('/');
    const isAllowed = [...ALLOWED_GM_PRO_PATHS].some(
      (allowed) => proxyPath === allowed || proxyPath.startsWith(allowed + '/'),
    );
    if (!isAllowed) {
      reply.code(403);
      return { ok: false, error: `路径不在白名单中: ${proxyPath}` };
    }

    const targetUrl = `${GM_PRO_HTTP_URL}${proxyPath}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GM_PRO_HTTP_TIMEOUT);

    // 构建出站请求头
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    // 携带 graph-memory-pro 独立服务器鉴权令牌（X-Auth-Token，来自 openclaw.json 配置）
    const authToken = resolveGmProAuthToken();
    if (authToken) {
      headers['x-auth-token'] = authToken;
    }

    try {
      const resp = await fetch(targetUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!resp.ok) {
        let body: unknown;
        try { body = await resp.json(); } catch { body = { error: `graph-memory-pro returned ${resp.status}` }; }
        return { ok: false, error: `graph-memory-pro HTTP ${resp.status}`, detail: body };
      }

      const contentType = resp.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return { ok: false, error: `graph-memory-pro 响应非 JSON (Content-Type: ${contentType || '空'})` };
      }

      const data = await resp.json();
      return { ok: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const error = isTimeout
        ? `graph-memory-pro 请求超时（${GM_PRO_HTTP_TIMEOUT}ms）`
        : `graph-memory-pro 不可达: ${msg}`;
      req.log.warn({ err: error, targetUrl }, 'graph-memory-pro 代理失败');
      // 返回 200 让前端能解析结构化错误信息，而非被 apiGet 直接 throw
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  });

  /**
   * POST /api/gm-pro/proxy/*
   *
   * 代理 graph-memory-pro 的写 API 请求。
   * 仅允许 ALLOWED_GM_PRO_POST_PATHS 白名单中的路径。
   * v2.3.5 新增：用于 Bootstrap 反馈工具（POST /api/feedback/bootstrap）。
   */
  app.post('/api/gm-pro/proxy/*', async (req, reply) => {
    const urlPath = req.url.split('?')[0];
    const proxyPath = urlPath.replace('/gm-pro/proxy', '');

    // POST 白名单校验（精确匹配，不支持前缀）
    if (!ALLOWED_GM_PRO_POST_PATHS.has(proxyPath)) {
      reply.code(403);
      return { ok: false, error: `POST 路径不在白名单中: ${proxyPath}` };
    }

    const targetUrl = `${GM_PRO_HTTP_URL}${proxyPath}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GM_PRO_HTTP_TIMEOUT);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    const authToken = resolveGmProAuthToken();
    if (authToken) {
      headers['x-auth-token'] = authToken;
    }

    try {
      const body = req.body ? JSON.stringify(req.body) : undefined;
      const resp = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!resp.ok) {
        let errBody: unknown;
        try { errBody = await resp.json(); } catch { errBody = { error: `graph-memory-pro returned ${resp.status}` }; }
        return { ok: false, error: `graph-memory-pro HTTP ${resp.status}`, detail: errBody };
      }

      const contentType = resp.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return { ok: false, error: `graph-memory-pro 响应非 JSON (Content-Type: ${contentType || '空'})` };
      }

      const data = await resp.json();
      return { ok: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const error = isTimeout
        ? `graph-memory-pro 请求超时（${GM_PRO_HTTP_TIMEOUT}ms）`
        : `graph-memory-pro 不可达: ${msg}`;
      req.log.warn({ err: error, targetUrl }, 'graph-memory-pro POST 代理失败');
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  });
}