/**
 * LCM Dashboard 快照端点 —— 轻量 HTTP 服务，仅供本机 dashboard 读取内存态。
 *
 * 设计要点：
 * - 用 node:http，零新依赖
 * - 仅监听 127.0.0.1（默认），不暴露外网
 * - 数据通过注入的 providers 延迟求值，每次请求读取最新状态
 * - 不暴露给 agent，仅本机 dashboard 访问
 *
 * 端口冲突处理（解决 EADDRINUSE 导致整个插件崩溃）：
 * - 启动前探测端口是否被占
 *   - 若被占且响应 /internal/health 为 ok → 视为上一个实例残留
 *     （常见场景：插件进程被 kill -9 未走 dispose），
 *     放弃启动并返回 started:false，让上层降级（不阻塞插件）
 *   - 若被占且非自身实例 → 同样放弃启动，记录 warn
 * - listen 失败（含 EADDRINUSE）通过 error 事件 + Promise reject 捕获，
 *   不再作为 unhandled error 抛出
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { getGlobalLogger } from './utils/logger.js';

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

/** 启动选项 */
export interface StartSnapshotServerOpts {
  port: number;
  host: string;
  providers: SnapshotProviders;
  /**
   * 启动前端口探测超时（ms）。默认 500ms。
   * 探测期间如果端口被占，会尝试 fetch /internal/health 判断是否上一个实例残留。
   */
  probeTimeoutMs?: number;
}

/** 启动结果 */
export interface SnapshotServerHandle {
  /** 是否成功启动。false 表示端口被占或监听失败，调用方应降级处理。 */
  started: boolean;
  /** 停止函数（幂等，可多次调用）。即使 started=false 也可安全调用。 */
  stop: () => Promise<void>;
  /** 失败原因（started=false 时有值） */
  failureReason?: string;
}

/**
 * 探测端口是否被占。
 * - 若被占且响应 /internal/health 为 ok → 返回 'self-stale'（上一个自身实例残留）
 * - 若被占但不响应 health → 返回 'occupied-foreign'
 * - 若端口空闲（连接被拒绝）→ 返回 'free'
 */
async function probePort(host: string, port: number, timeoutMs: number): Promise<'free' | 'self-stale' | 'occupied-foreign'> {
  const url = `http://${host}:${port}/internal/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (resp.ok) {
      const body = await resp.json().catch(() => null);
      if (body && (body as any).ok === true) return 'self-stale';
    }
    return 'occupied-foreign';
  } catch {
    // 连接被拒绝 → 端口空闲
    return 'free';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 启动 dashboard 快照 HTTP 服务。
 *
 * 路由：
 * - GET /internal/snapshot → 聚合 JSON
 * - GET /internal/health   → { ok: true, ts }
 * - 其他 → 404
 *
 * 端口冲突处理：
 * - 启动前探测端口，若被占（自身残留或他进程）则放弃启动，返回 started:false
 * - listen 期间的 error 事件被捕获（EADDRINUSE / EACCES 等），不再作为 unhandled error 抛出
 *
 * @returns handle，含 started 标志与 stop 函数（幂等，可多次调用）
 */
export function startDashboardSnapshotServer(opts: StartSnapshotServerOpts): SnapshotServerHandle {
  const { port, host, providers, probeTimeoutMs = 500 } = opts;

  // 标记是否真正启动（用于 stop 幂等）
  let server: Server | null = null;
  let closed = false;

  // 用 Promise 包装 listen，但整体函数保持同步返回（调用方不需 await）
  // 启动失败通过 handle.started = false 体现
  const handle: SnapshotServerHandle = {
    started: false,
    stop: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        if (!server) {
          resolve();
          return;
        }
        // M-12: 未 listen 的 server 调 close 回调可能不触发，
        // 检查 server.listening 避免依赖兜底 setTimeout（节省 1s 延迟）
        if (!server.listening) {
          resolve();
          return;
        }
        // M-1: 保存兜底 timer handle，close 回调触发后 clearTimeout
        // 避免进程退出时 timer 仍存活导致延迟 1s
        let fallbackTimer: NodeJS.Timeout | undefined;
        server.close(() => {
          if (fallbackTimer) clearTimeout(fallbackTimer);
          resolve();
        });
        // 兜底：即使 close 回调未触发也 resolve
        fallbackTimer = setTimeout(() => resolve(), 1000);
      }),
  };

  // 异步执行：探测端口 → 启动 listen
  // 注意：这里不返回 Promise，调用方通过 handle.started 读取最终状态。
  // 探测+listen 在毫秒级完成，dashboard 第一次 fetch 通常晚于这个时间窗口。
  // 如果探测+listen 未完成时 dashboard 就 fetch，会被 catch 降级（fetchPluginSnapshot 已有 5s 超时 + null 降级）。
  (async () => {
    try {
      const probeResult = await probePort(host, port, probeTimeoutMs);
      if (probeResult !== 'free') {
        handle.failureReason = probeResult === 'self-stale'
          ? `port ${host}:${port} occupied by a stale previous instance of this plugin (likely killed without dispose). Snapshot server disabled.`
          : `port ${host}:${port} occupied by unknown process. Snapshot server disabled.`;
        // 不启动 server，started 保持 false
        return;
      }

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
      });

      // 关键：注册 error 事件，避免 EADDRINUSE 等作为 unhandled error 抛出
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (!handle.started) {
          // listen 阶段失败
          handle.failureReason = `listen error: ${err.code || err.name} ${err.message}`;
          handle.started = false;
          server = null;
        } else {
          // C-4: 运行时出错（如 ECONNRESET、socket 异常），上报 logger 不再静默
          // 不停止服务，下次请求可能仍能正常响应
          try {
            getGlobalLogger().warn('dashboard snapshot server runtime error', {
              code: err.code,
              message: err.message,
            });
          } catch {
            // logger 自身不可用时降级 console.warn，避免静默
            // eslint-disable-next-line no-console
            console.warn('[dashboard-snapshot] runtime error:', err.code, err.message);
          }
        }
      });

      // 用 Promise 包装 listen，等监听成功后才标记 started = true
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server?.removeListener('error', onError);
          reject(err);
        };
        server!.once('error', onError);
        server!.listen(port, host, () => {
          server!.removeListener('error', onError);
          resolve();
        });
      });

      // listen 成功
      handle.started = true;
    } catch (err: any) {
      handle.started = false;
      handle.failureReason = handle.failureReason || `startup failed: ${err?.message || String(err)}`;
      // 清理 server 引用
      if (server) {
        try { server.close(); } catch {}
        server = null;
      }
    }
  })();

  return handle;
}
