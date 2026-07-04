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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { registerHealthRoutes } from './routes/health';
import { registerAgentRoutes } from './routes/agent';
import { registerExperienceRoutes } from './routes/experience';
import { registerMemoryRoutes } from './routes/memory';
import { closeNeo4j } from './lib/neo4j';

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

  // 生产模式：serve 前端构建产物 dist-client
  const clientDist = resolve(__dirname, '..', 'dist-client');
  if (isProd && existsSync(clientDist)) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
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
