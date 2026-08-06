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
 *   GM_PRO_AUTH_TOKEN —— graph-memory-pro apiServer.authToken，用于 X-Auth-Token 鉴权
 *
 * 安全：
 *   - 仅允许 GET 请求（只读），拒绝 POST/PATCH/PUT/DELETE 写操作
 *   - 路径白名单校验，防止 SSRF 遍历
 *   - 携带 X-Auth-Token 头（若配置了 GM_PRO_AUTH_TOKEN），对应 graph-memory-pro 的 authToken 配置
 *   - 独立服务器自带 CORS 支持，不依赖 Gateway 的 Basic Auth
 */
import type { FastifyInstance } from 'fastify';

/** graph-memory-pro 独立 API 服务器地址（默认 http://127.0.0.1:7850） */
const GM_PRO_HTTP_URL = process.env.GM_PRO_HTTP_URL ?? 'http://127.0.0.1:7850';
const GM_PRO_HTTP_TIMEOUT = Number(process.env.GM_PRO_HTTP_TIMEOUT ?? 10_000);
const GM_PRO_AUTH_TOKEN = process.env.GM_PRO_AUTH_TOKEN ?? '';

/** graph-memory-pro 已知的只读 API 路径白名单 */
const ALLOWED_GM_PRO_PATHS = new Set([
  '/api/status',
  '/api/stats',
  '/api/health',
  '/api/nodes',
  '/api/search',
  '/api/top',
  '/api/nodes-by-type',
  '/api/maintain/dirty-nodes',
  '/api/metrics',
  '/api/auto-tuner/state',
  '/api/association-matrix/state',
  '/api/doctor',
  '/api/usage',
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
    const urlPath = req.url.split('?')[0];
    const proxyPath = urlPath.replace('/api/gm-pro/proxy', '');

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
    // graph-memory-pro 独立服务器使用 X-Auth-Token 鉴权（对应 apiServer.authToken 配置）
    if (GM_PRO_AUTH_TOKEN) {
      headers['x-auth-token'] = GM_PRO_AUTH_TOKEN;
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
}