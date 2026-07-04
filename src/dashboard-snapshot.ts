/**
 * LCM Dashboard 快照端点 —— 轻量 HTTP 服务，仅供本机 dashboard 读取内存态。
 *
 * 设计要点：
 * - 用 node:http，零新依赖
 * - 仅监听 127.0.0.1（默认），不暴露外网
 * - 数据通过注入的 providers 延迟求值，每次请求读取最新状态
 * - 不暴露给 agent，仅本机 dashboard 访问
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

/** Dashboard 快照聚合数据结构 */
export interface DashboardSnapshot {
  cascade: {
    armsCount: number;
    topArms: Array<{ armKey: string; alpha: number; beta: number; sample: number }>;
    confidenceThreshold: number;
  };
  userProfile: {
    techStack: Array<{ name: string; weight: number }>;
    scenario: Array<{ name: string; weight: number }>;
    language: 'zh' | 'en' | 'mixed';
  };
  graphAdapter: {
    connected: boolean;
    connectFailed: boolean;
    lastError?: string;
  };
  debt: {
    running: number;
    pendingCount: number;
    pollIntervalMs: number;
    maxConcurrent: number;
  };
  retrieval: {
    lastQuery: string;
    perfSummary: string;
  };
  health: {
    latest: unknown | null; // healthMetrics.getLatest()
  };
  timestamp: number;
}

/**
 * 数据采集 providers —— 由 index.ts 注入，每次请求时调用以读取最新内存态。
 * 设计为函数形式便于：(1) 延迟求值（register 时单例可能未初始化）；(2) 测试注入 mock。
 */
export interface SnapshotProviders {
  getCascadeSnapshot: () => DashboardSnapshot['cascade'];
  getUserProfile: () => DashboardSnapshot['userProfile'];
  getGraphAdapterState: () => DashboardSnapshot['graphAdapter'];
  getDebtStats: () => DashboardSnapshot['debt'];
  getRetrievalState: () => DashboardSnapshot['retrieval'];
  getHealthLatest: () => DashboardSnapshot['health']['latest'];
}

/**
 * 聚合所有 providers 数据为完整快照。
 * 单独导出便于测试（不依赖 HTTP 层）。
 */
export function buildSnapshot(providers: SnapshotProviders): DashboardSnapshot {
  return {
    cascade: providers.getCascadeSnapshot(),
    userProfile: providers.getUserProfile(),
    graphAdapter: providers.getGraphAdapterState(),
    debt: providers.getDebtStats(),
    retrieval: providers.getRetrievalState(),
    health: { latest: providers.getHealthLatest() },
    timestamp: Date.now(),
  };
}

/**
 * 启动 dashboard 快照 HTTP 服务。
 *
 * 路由：
 * - GET /internal/snapshot → 聚合 JSON
 * - GET /internal/health   → { ok: true, ts }
 * - 其他 → 404
 *
 * @returns { stop } 停止函数（幂等，可多次调用）
 */
export function startDashboardSnapshotServer(opts: {
  port: number;
  host: string;
  providers: SnapshotProviders;
}): { stop: () => Promise<void> } {
  const { port, host, providers } = opts;

  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      // 仅允许 GET
      if (req.method !== 'GET') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const url = req.url ?? '';

      if (url === '/internal/snapshot') {
        try {
          const snapshot = buildSnapshot(providers);
          const body = JSON.stringify(snapshot);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'snapshot build failed', message: String(err) }));
        }
        return;
      }

      if (url === '/internal/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: Date.now() }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    },
  );

  // 同步监听，stop 函数封装关闭逻辑（幂等）
  let closed = false;
  server.listen(port, host);

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        server.close(() => resolve());
        // 即使 close 回调未触发（无活动连接时立即触发），也兜底 resolve
        setTimeout(() => resolve(), 1000);
      }),
  };
}
