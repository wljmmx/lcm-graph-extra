/**
 * LCM Dashboard 后端入口（Fastify）。
 *
 * 端口规划：
 * - dashboard 后端 :7421（本文件监听）
 * - 前端 dev :7422（vite dev，/api 代理到 7421）
 * - 插件 snapshot :7423（src/dashboard-snapshot.ts，另一任务实现）
 *
 * 生产模式：后端 serve ../dist-client 静态资源；dev 模式跳过（前端由 vite 提供）。
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { registerHealthRoutes } from './routes/health';
import { registerAgentRoutes } from './routes/agent';
import { registerExperienceRoutes } from './routes/experience';
import { registerMemoryRoutes } from './routes/memory';
import { registerGraphHealthRoutes } from './routes/graph-health';
import { registerConfigRoutes } from './routes/config';
import { registerMoaRoutes } from './routes/moa';
import { registerQmdTestRoutes } from './routes/qmd-test';
import { registerBenchmarkRoutes } from './routes/benchmark';
import { registerGmProRoutes } from './routes/gm-pro';
import { closeNeo4j } from './lib/neo4j';
import { requireAuth, isAuthEnabled } from './lib/auth';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 端口/主机从环境变量读取，默认 7421 / 127.0.0.1（仅本机访问）
const PORT = Number(process.env.DASHBOARD_PORT ?? 7421);
const HOST = process.env.DASHBOARD_HOST ?? '127.0.0.1';

// 是否生产模式（serve 前端静态资源）
const isProd = process.env.NODE_ENV === 'production';

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    // BUGFIX: Node.js 18+ 的 http.Server 默认 requestTimeout=300000ms (5min)，
    // 但蒸馏/回溯等长任务可能耗时 30-60 分钟（本地大模型），
    // 禁用 server 级 requestTimeout，让超时由路由层（getTimeoutForTool）统一控制。
    connectionTimeout: 0,
  });

  // 禁用底层 http.Server 的 requestTimeout（Fastify 不直接暴露此选项，
  // 需在 server 实例创建后设置）
  app.addHook('onReady', () => {
    const server = app.server as any;
    if (server && typeof server.requestTimeout !== 'undefined') {
      server.requestTimeout = 0;
    }
  });

  // Basic Auth 中间件（DASHBOARD_AUTH 启用时生效）
  if (isAuthEnabled()) {
    app.addHook('onRequest', (req, reply, done) => {
      const path = req.url.split('?')[0];
      if (path === '/api/ping') {
        done();
        return;
      }
      // 生产模式：除 ping 外所有路径（含 SPA history 路由如 /settings、静态资源）都需要鉴权。
      // 修复前：仅 '/' 与 .html/.js/.css/.svg/.png 需要鉴权，直接访问 /settings 等
      // SPA 路由会绕过鉴权直接命中回退后的 index.html。
      if (path.startsWith('/api/') || isProd) {
        requireAuth(req, reply, done);
      } else {
        done();
      }
    });
    app.log.info('Basic Auth 已启用（DASHBOARD_AUTH）');
  } else if (isProd) {
    // P1-5 安全：生产模式未配置鉴权时打印显著警告
    app.log.warn(
      '⚠ 生产模式未配置 DASHBOARD_AUTH，所有 API 完全开放！' +
        '请设置 DASHBOARD_AUTH=user:pass 或限制 DASHBOARD_HOST=127.0.0.1',
    );
  }

  // P1-4 安全：安全响应头（替代 @fastify/helmet，避免新增依赖）
  // X-Frame-Options 防点击劫持；X-Content-Type-Options 防 MIME 嗅探；
  // Referrer-Policy 控制 Referer 泄露
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // 注册 CORS（仅本机）
  await app.register(cors, {
    origin: (origin, cb) => {
      // 仅允许本机来源（dev 模式下 vite :7422）
      if (!origin) return cb(null, true);
      try {
        const u = new URL(origin);
        if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
          return cb(null, true);
        }
        return cb(new Error('Not allowed by CORS'), false);
      } catch {
        return cb(new Error('Invalid origin'), false);
      }
    },
    credentials: true,
  });

  // v1.2.0-4: Rate Limiting —— 防止暴力枚举 / 滥用 MCP 写操作
  // 配置：DASHBOARD_RATE_LIMIT_MAX（每窗口最大请求数，默认 100）
  //       DASHBOARD_RATE_LIMIT_WINDOW（窗口秒数，默认 60）
  // 健康检查 /api/ping 豁免（避免影响监控探测）
  const rlMax = Number(process.env.DASHBOARD_RATE_LIMIT_MAX) || 100;
  const rlWindow = (Number(process.env.DASHBOARD_RATE_LIMIT_WINDOW) || 60) + ' seconds';
  await app.register(rateLimit, {
    max: rlMax,
    timeWindow: rlWindow,
    // P1-2 安全：使用 req.ip 而非手动读 x-forwarded-for
    // XFF 头可被客户端伪造，直接读取会绕过限流；
    // 若部署在反代后，应配置 Fastify trustProxy 让框架正确解析 req.ip
    keyGenerator: (req) => req.ip,
    // 限流只作用于"写操作"（POST/PATCH/PUT/DELETE），只读 GET 全部豁免。
    // 依据：
    //  - 本服务全部 GET 路由均为纯只读查询/只读代理（经验列表、graph/gm-pro 状态、moa、
    //    extract-rebuild 进度、operation-logs、config 读等；/api/gm-pro/proxy/* 的 GET 走
    //    只读白名单 matchesReadWhitelist）。
    //  - 前端合法轮询强度足以打满全局 100/min：重建进度 GET /api/extract-rebuild/progress
    //    每 2s ≈30/min、任务 job 轮询 GET /api/gm-pro/proxy/extract/rebuild-all/job/:id
    //    每 3s ≈20/min、监控页 gm-pro/moa 轮询 ≈12-15/min，多 Tab 再成倍叠加，
    //    原全局计数会把无关的只读轮询也 429 打断。
    //  - 安全意图（防暴力枚举 / 滥用 MCP 写操作）集中在写请求上：POST /api/mcp/invoke、
    //    config/gm-pro/moa 写、gm-pro 写代理、benchmark run 等均保持限流。
    allowList: (req) => {
      const path = req.url.split('?')[0];
      if (req.method === 'GET') return true;
      if (path === '/api/ping' || path === '/ping') return true;
      return false;
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `请求频率超限：每 ${context.after} 内最多 ${context.max} 次。请稍后重试。`,
    }),
  });
  app.log.info({ max: rlMax, window: rlWindow }, 'Rate Limit 已启用');

  // 生产模式：serve 前端构建产物 dist-client
  const clientDist = resolve(__dirname, '..', 'dist-client');
  if (isProd && existsSync(clientDist)) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
    });
    // SPA history 路由回退（直接输入 /settings、/moa 等地址时，服务端要返回 index.html）。
    // 修复前：fastify-static 找不到对应文件 → 404；只有通过前端菜单跳转（客户端路由）才正常。
    // 仅对"非 /api、非静态资源文件"的 GET 请求回退到 index.html；
    // /api 或带扩展名的资源找不到时仍返回真正的 404。
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      if (req.method !== 'GET' || path === '/api' || path.startsWith('/api/') || path.includes('.')) {
        reply.code(404).send({ error: 'Not Found', path });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
    app.log.info(`生产模式：serve 静态资源 ${clientDist}`);
  } else {
    app.log.info('dev 模式：跳过静态资源 serve（前端由 vite :7422 提供）');
  }

  // 路由前缀 /api
  await app.register(
    async (api) => {
      // 临时 ping 路由，用于验证后端可达
      api.get('/ping', async () => {
        return { ok: true, ts: Date.now() };
      });
      // 鉴权探测路由：受 onRequest 钩子保护（DASHBOARD_AUTH 启用时返回 401 +
      // WWW-Authenticate）。前端"登录"链接以导航方式打开本路由，触发浏览器原生
      // Basic Auth 认证框；认证成功后浏览器会为同源 fetch 自动附带凭据，
      // 监控页轮询在下一个周期自动恢复（无需刷新页面）。
      api.get('/auth/whoami', async () => {
        return { ok: true, authenticated: isAuthEnabled(), ts: Date.now() };
      });
    },
    { prefix: '/api' },
  );

  // 注册模块 1 路由：健康指标 + agent 状态（路由内自带 /api 前缀）
  await registerHealthRoutes(app);
  await registerAgentRoutes(app);
  // 注册模块 2 路由：经验管理 + MCP 写操作转发
  await registerExperienceRoutes(app);
  // 注册模块 3 路由：记忆查询（跨引擎搜索 + 图谱浏览）
  await registerMemoryRoutes(app);
  // 注册模块 4 路由：图谱健康（N-4: G-5 图谱健康对接）
  await registerGraphHealthRoutes(app);
  // v1.1.0-1/2/3: 配置管理路由（运行时配置查看 / schema 文档 / 白名单热更新）
  await registerConfigRoutes(app);
  await registerMoaRoutes(app);
  // v1.2.0: QMD MCP 测试路由（10x/20x 反复测试 + 平均延迟统计）
  await registerQmdTestRoutes(app);
  // v2.2.0: Benchmark 性能压测路由（标准测试集 + 召回率/tokens/压缩率/性能分布 + 报告）
  await registerBenchmarkRoutes(app);
  // v2.1.13: graph-memory-pro HTTP API 代理路由（状态/统计/图谱数据）
  await registerGmProRoutes(app);

  // 优雅关闭
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, '收到退出信号，开始优雅关闭');
    try {
      await app.close();
      // 关闭 Neo4j driver 单例
      await closeNeo4j();
      app.log.info('已关闭');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '关闭过程出错');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 启动监听
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`LCM Dashboard 后端监听: http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error({ err }, '启动失败');
    process.exit(1);
  }
}

main().catch((err) => {
  // 兜底：main 内部已处理日志，此处仅退出
  console.error('LCM Dashboard 后端启动异常:', err);
  process.exit(1);
});
