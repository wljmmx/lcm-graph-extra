/**
 * 维护操作 API 封装（模块 4）。
 *
 * 复用 P3 已实现的 invokeMcpTool（POST /api/mcp/invoke），
 * 在其之上提供 9 个语义化的薄封装函数，对应 9 张操作卡片。
 *
 * 后端路由不再新增：所有调用都通过 server/routes/experience.ts
 * 中已注册的 POST /api/mcp/invoke 转发到 OpenClaw MCP host。
 */
import { invokeMcpTool, type McpInvokeResponse } from './experience';
import { apiGet, apiPost, ApiError } from './client';
import {
  startAndPollGmProReembed,
  type GmProReembedTaskSnapshot,
  startAndPollGmProMaintain,
  type GmProMaintainTaskSnapshot,
} from './gm-pro';

/** 图谱维护（dedup / PageRank / community + 债务表对账）。可选 params 如 { source: 'ttl_cleanup' } 用于 TTL 清理变体。 */
export function invokeMaintain(params: Record<string, unknown> = {}): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_maintain', params);
}

/** 系统诊断（lcm.db / qmd MCP / Neo4j / 熔断器 / health metrics 全栈自检） */
export function invokeDiagnose(): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_diagnose', {});
}

/** 触发经验蒸馏：limit 控制单次处理数量 */
export function invokeDistill(limit: number): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_distill', { limit });
}

/** 重试失败经验：重置 FAILED 节点回 PENDING，mode=all|exhausted */
export function invokeDistillRetry(mode: 'all' | 'exhausted' = 'exhausted'): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_distill_retry', { mode });
}

/** 经验回溯：从历史对话中提取经验写入 PENDING 队列 */
export function invokeBackfill(limit: number, force: boolean = false): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_backfill', { limit, force });
}

/** 触发 compact：conversationId 省略时处理最紧急债务 */
export function invokeCompact(conversationId?: number): Promise<McpInvokeResponse> {
  const params: Record<string, unknown> = {};
  if (conversationId !== undefined && conversationId !== null) {
    params.conversationId = conversationId;
  }
  return invokeMcpTool('lcmg_compact', params);
}

/** 重置指定子系统的熔断器（lcm / qmd / neo4j） */
export function invokeResetBreaker(name: string): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_reset_breaker', { name });
}

/** 备份：outputPath 为输出目录（必须在 ~/.openclaw 之下） */
export function invokeBackup(outputPath: string): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_backup', { outputPath });
}

/**
 * 恢复：backupPath 必须在 ~/.openclaw 之下。
 * 强制 dryRun 默认 true（设计文档 6.3 节安全约束）。
 */
export function invokeRestore(
  backupPath: string,
  targets: string = 'all',
  dryRun: boolean = true,
): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_restore', { backupPath, targets, dryRun });
}

/** 同步修复：mode=check 只读审计，mode=repair 实际修复 */
export function invokeSync(mode: string, dryRun: boolean): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_sync', { mode, dryRun });
}

/** 历史导入：source=lcm_messages / memory_files / all */
export function invokeImport(source: string, limit: number): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_import', { source, limit });
}

/**
 * 三级节点重建：完全复用 graph-memory-pro 的 HTTP API（POST /api/extract/rebuild[-all]）。
 * sessionKey 给定 → 单会话重建（同步）；省略 → 批量重建全部会话（v2.4.1 异步化：202+jobId+轮询）。
 * concurrency = 会话内 LLM 并发窗口（1-128，默认 4）；sessionConcurrency = 批量重建时同时处理的会话数（1-32，默认 2）；
 * mode = 提取模式（llm 默认 / heuristic 快速规则提取）；
 * limitSessions = 限制处理会话数（0 不限制）；pageSize = 读取分页大小（默认 2000）；
 * writeBatchSize = 合并写入批上限（默认 500）；progressPath = 断点续传 + 进度落盘路径（传入即启用，同路径再调续跑）。
 *
 * v2.4.1 异步化流程（rebuild-all）：
 *   1. POST /api/extract/rebuild-all → 202 { jobId, status:"running" }
 *   2. GET /api/extract/rebuild-all/job/:jobId → 200 (running/done) | 207 (partial) | 500 (failed)
 *   3. 前端自动轮询直到 done/failed，再包装为 MCP 标准结构返回
 *
 * 单会话 rebuild 仍为同步接口（200/207/500），不走异步 job。
 */
export async function invokeExtractRebuild(opts: {
  sessionKey?: string;
  limit?: number;
  concurrency?: number;
  sessionConcurrency?: number;
  mode?: 'llm' | 'heuristic';
  limitSessions?: number;
  pageSize?: number;
  writeBatchSize?: number;
  progressPath?: string;
  /** 异步 job 轮询间隔（ms，默认 3000） */
  pollIntervalMs?: number;
  /** 异步 job 最大轮询时长（ms，默认 30min，超时返回当前进度） */
  pollTimeoutMs?: number;
} = {}): Promise<McpInvokeResponse> {
  const params: Record<string, unknown> = {};
  if (opts.sessionKey) params.sessionKey = opts.sessionKey;
  if (opts.limit != null) params.limit = opts.limit;
  if (opts.concurrency != null) params.concurrency = opts.concurrency;
  if (opts.sessionConcurrency != null) params.sessionConcurrency = opts.sessionConcurrency;
  if (opts.mode != null) params.mode = opts.mode;
  if (opts.limitSessions != null && opts.limitSessions > 0) params.limitSessions = opts.limitSessions;
  if (opts.pageSize != null) params.pageSize = opts.pageSize;
  if (opts.writeBatchSize != null) params.writeBatchSize = opts.writeBatchSize;
  if (opts.progressPath) params.progressPath = opts.progressPath;
  // 单会话 → rebuild（同步）；批量 → rebuild-all（v2.4.1 异步）
  const isSingle = !!opts.sessionKey;
  const postPath = isSingle
    ? '/api/gm-pro/proxy/extract/rebuild'
    : '/api/gm-pro/proxy/extract/rebuild-all';
  try {
    const resp = await apiPost<{ ok: boolean; data?: any; error?: string; _status?: number }>(postPath, params);
    if (!resp.ok) {
      return { ok: false, error: resp.error ?? '三级节点重建失败' };
    }

    const d0 = (resp.data ?? {}) as Record<string, unknown>;
    const httpStatus = resp._status ?? 200;
    const fallbackMode = opts.mode ?? 'llm';

    // ── 异步分支：rebuild-all 返回 202 + jobId ──
    if (httpStatus === 202 && !isSingle) {
      const jobId = d0.jobId as string | undefined;
      if (!jobId) {
        return { ok: false, error: 'rebuild-all 返回 202 但缺少 jobId' };
      }
      // 轮询 job 状态直到完成
      const pollInterval = opts.pollIntervalMs ?? 3000;
      const pollTimeout = opts.pollTimeoutMs ?? 30 * 60_000;
      const startTime = Date.now();
      let lastData: Record<string, unknown> = d0;
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 20;  // ≈ 1 分钟连续失败，认为不可达，退出

      while (true) {
        if (Date.now() - startTime > pollTimeout) {
          // 超时：返回当前进度（非失败，用户可继续轮询或沿 progressPath 续跑）
          return wrapRebuildResult(lastData, 200, true, fallbackMode);
        }
        await sleep(pollInterval);
        try {
          const jobResp = await apiGet<{ ok: boolean; data?: any; error?: string; _status?: number }>(
            `/api/gm-pro/proxy/extract/rebuild-all/job/${jobId}`,
          );
          consecutiveFailures = 0;
          if (!jobResp.ok) {
            // 代理层业务语义失败（极少见，job 500 已被代理单独透传为 _status=500 走上面分支）
            const errBody = jobResp.error ?? 'rebuild job 查询失败';
            return wrapRebuildResult(
              { ...lastData, message: errBody },
              500,
              false,
              fallbackMode,
            );
          }
          lastData = (jobResp.data ?? {}) as Record<string, unknown>;
          const jobStatus = lastData.status as string | undefined;
          const jobHttpStatus = jobResp._status ?? 200;
          // status: "running" | "done" | "failed"
          // 500 → job.status === "failed" 且代理已透传 _status=500
          if (jobStatus === 'done' || jobStatus === 'failed' || jobHttpStatus >= 500) {
            const finalStatus = jobHttpStatus >= 500
              ? jobHttpStatus
              : (jobStatus === 'failed' ? 500 : 200);
            return wrapRebuildResult(lastData, finalStatus, false, fallbackMode);
          }
          // running → 继续轮询
        } catch (err) {
          // 网络抖动：连续失败达到上限后退出，避免无限死等
          consecutiveFailures++;
          const e = err instanceof Error ? err : new Error(String(err));
          const is404 = e instanceof ApiError && e.status === 404;
          if (is404 || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            return wrapRebuildResult(
              {
                ...lastData,
                message: is404
                  ? `rebuild job ${jobId} 不存在（插件可能已重启，进度文件仍在）`
                  : `连续 ${MAX_CONSECUTIVE_FAILURES} 次查询失败，轮询终止: ${e.message}`,
              },
              500,
              false,
              fallbackMode,
            );
          }
          // 否则视为网络瞬断，继续下一轮
        }
      }
    }

    // ── 同步分支：单会话 rebuild（200/207）或 rebuild-all 兜底 200 ──
    return wrapRebuildResult(d0, httpStatus, false, fallbackMode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `三级节点重建请求失败: ${msg}` };
  }
}

/** 将 gm-pro 返回体包装为 MCP 标准结构（content[].text + details） */
function wrapRebuildResult(
  d: Record<string, unknown>,
  httpStatus: number,
  isTimeout: boolean,
  fallbackMode?: 'llm' | 'heuristic',
): McpInvokeResponse {
  const isPartial = httpStatus === 207 || Number(d.failedSessions ?? 0) > 0;
  const isFailed = httpStatus >= 500;
  const failedSessions = Number(d.failedSessions ?? 0);
  const modeDisplay = (d.mode as 'llm' | 'heuristic' | undefined) ?? fallbackMode ?? 'llm';
  const text = [
    '# 三级节点重建报告',
    '',
    `模式: ${modeDisplay}`,
    `处理会话: ${d.processedSessions ?? 0}/${d.totalSessions ?? 0}`,
    failedSessions > 0 ? `**失败会话: ${failedSessions}**` : '',
    `处理轮次: ${d.processedPairs ?? 0}/${d.totalPairs ?? 0}`,
    `LLM 输出 Token: ${d.llmOutputTokens ?? 0}`,
    `LLM 有输出: ${d.llmHasOutput === true ? '是' : '否'}`,
    typeof d.message === 'string' && d.message ? `状态: ${d.message}` : '',
    isTimeout ? '⚠ 轮询超时，任务仍在后台运行。可沿原进度路径继续轮询或用同一 progressPath 续跑。' : '',
    isPartial && !isTimeout ? '提示: 可沿原进度路径重新触发，断点文件已累计 failedSessions，失败会话未标记 -1、会自动重试。' : '',
    isFailed ? `❌ 重建失败: ${typeof d.message === 'string' ? d.message : '未知错误'}` : '',
  ].filter(Boolean).join('\n');
  const bb = (d.results ?? {}) as Record<string, { processedPairs?: number; totalPairs?: number }>;
  const results = Object.entries(bb).map(([k, v]) => ({
    sessionKey: k,
    processedPairs: v?.processedPairs ?? 0,
    totalPairs: v?.totalPairs ?? 0,
  }));
  return {
    ok: !isFailed,
    result: {
      content: [{ type: 'text', text }],
      details: {
        ok: !isPartial && !isFailed,
        totalSessions: d.totalSessions ?? 0,
        processedSessions: d.processedSessions ?? 0,
        failedSessions,
        totalPairs: d.totalPairs ?? 0,
        processedPairs: d.processedPairs ?? 0,
        mode: modeDisplay,
        llmOutputTokens: d.llmOutputTokens ?? 0,
        llmHasOutput: d.llmHasOutput === true,
        results,
        message: typeof d.message === 'string' ? d.message : undefined,
        httpStatus,
        jobId: d.jobId,
        jobStatus: d.status,
        isTimeout,
      },
    },
  };
}

/** 简单 sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 三级节点重建的运行级进度快照（后端 GET /api/extract-rebuild/progress） */
export interface ExtractRebuildProgress {
  done: boolean;
  startedAt?: string | null;
  updatedAt?: string | null;
  /** 本次一共处理多少会话 */
  totalSessions: number;
  /** 本次分多少批次（每会话一个处理批次） */
  totalBatches: number;
  /** 当前处理第几个会话（1-based，0=尚未开始） */
  currentSession: number;
  /** 当前处理第几个批次（1-based，0=尚未开始） */
  currentBatch: number;
  /** 已完成的会话数 */
  processedSessions: number;
  /** 失败的会话数（v2.4.1：断点文件累计，207 时>0） */
  failedSessions: number;
  /** 本次需处理的总轮次数 */
  totalTurns: number;
  /** 已提取轮次数 */
  processedTurns: number;
  /** 当前正在处理的会话 */
  currentSessionKey?: string | null;
  /** 本次调用期间 LLM 实际输出的 token 累计（heuristic 恒为 0） */
  llmOutputTokens?: number;
  /** 状态文本（"done"/"running"...） */
  status?: unknown;
  /** gm-pro 返回的状态提示（207 部分失败时会带 N failed session(s)） */
  message?: string;
}

export interface ExtractRebuildProgressResponse {
  running: boolean;
  progress: ExtractRebuildProgress | null;
}

/** 拉取三级节点重建实时进度（Dashboard 双进度条轮询）。可选 progressPath 指定读取的进度文件（与用户表单一致）。 */
export function fetchExtractRebuildProgress(progressPath?: string): Promise<ExtractRebuildProgressResponse> {
  const qs = progressPath && progressPath.trim() ? `?path=${encodeURIComponent(progressPath.trim())}` : '';
  return apiGet<ExtractRebuildProgressResponse>(`/api/extract-rebuild/progress${qs}`);
}

/**
 * Bootstrap 反馈工具：用已有图谱节点合成 warmup 反馈，突破冷启动。
 * 原理：以节点 name 作为 query 和 reply，启发式必然命中（name 在 reply 中），
 * 一次性喂入 N 条快速突破冷启动。
 * v2.3.5 新增。
 *
 * ⚠️ 此工具是 graph-memory-pro 的 HTTP API 功能（POST /api/feedback/bootstrap），
 * 不是 MCP 工具，因此走 gm-pro HTTP 代理路径而非 MCP invoke。
 */
export async function invokeBootstrap(limit: number = 100): Promise<McpInvokeResponse> {
  try {
    // graph-memory-pro 的 /api/feedback/bootstrap 读取的是 maxNodes 参数（非 limit）
    const resp = await apiPost<{ ok: boolean; data?: any; error?: string }>(
      '/api/gm-pro/proxy/feedback/bootstrap',
      { maxNodes: limit },
    );
    if (resp.ok) {
      return { ok: true, result: resp.data };
    }
    return { ok: false, error: resp.error ?? 'Bootstrap 反馈失败' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Bootstrap 请求失败: ${msg}` };
  }
}

/**
 * 触发 gm-pro 全节点重新向量化（异步任务模式）。
 * ⚠️ 走 gm-pro HTTP 代理（POST /api/gm-pro/proxy/reembed/start），非 MCP invoke。
 *
 * 上游 gm_reembed 已异步化：start 返回 202 + taskId，后台按批次执行，
 * 不再同步阻塞（消除 stalled-session）。
 *
 * clear=true 时先清库再重导（推荐流程：clear → 导入数据 → 埋点）。
 * v2.8.0 新增，与维护面板 dirty-nodes 卡内按钮对齐。
 *
 * @param onProgress 轮询期间回调最新进度快照（供 UI 展示进度条/百分比）
 */
export async function invokeReembed(
  opts: {
    clear?: boolean;
    batchSize?: number;
    batchIntervalMs?: number;
    pollMs?: number;
    maxWaitMs?: number;
    onProgress?: (snap: GmProReembedTaskSnapshot, taskId: string) => void;
  } = {},
): Promise<McpInvokeResponse> {
  try {
    const resp = await startAndPollGmProReembed({
      clear: opts.clear,
      batchSize: opts.batchSize,
      batchIntervalMs: opts.batchIntervalMs,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
      onProgress: opts.onProgress,
    });
    if (resp.ok) {
      return { ok: true, result: resp.data };
    }
    return { ok: false, error: resp.error ?? '重新向量化失败' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `重新向量化请求失败: ${msg}` };
  }
}

/**
 * 触发 gm-pro 全图维护（异步任务模式，与 reembed 对称）。
 * ⚠️ 走 gm-pro HTTP 代理（POST /api/gm-pro/proxy/maintain/start），非 MCP invoke。
 *
 * 上游 gm_maintain 已异步化：start 返回 202 + taskId，后台按 14 个 phase 顺序执行，
 * 不再同步阻塞（消除 stalled-session 与 MCP 120s 超时截断）。
 * 维护互斥锁被占用时快照标记 lockSkipped=true（本次未真正调度）。
 *
 * @param onProgress 轮询期间回调最新进度快照（供 UI 展示进度条/当前 phase 名）
 */
export async function invokeMaintainAsync(
  opts: {
    pollMs?: number;
    maxWaitMs?: number;
    onProgress?: (snap: GmProMaintainTaskSnapshot, taskId: string) => void;
  } = {},
): Promise<McpInvokeResponse> {
  try {
    const resp = await startAndPollGmProMaintain({
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
      onProgress: opts.onProgress,
    });
    if (resp.ok) {
      return { ok: true, result: resp.data };
    }
    return { ok: false, error: resp.error ?? '图谱维护失败' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `图谱维护请求失败: ${msg}` };
  }
}

// ===== 操作日志查询（对应后端 GET /api/operation-logs，读取 ~/.openclaw/operation_logs.db） =====

/**
 * 后端 /api/operation-logs 返回的单条持久化记录。
 * status 取值：'success' | 'failure'（注意与前端会话态 OperationLogEntry 的 'error' 不同）。
 */
export interface OperationLogRecord {
  id: number;
  ts: number;
  tool: string;
  params: Record<string, unknown>;
  result: unknown;
  status: string;
  durationMs: number;
  error: string | null;
  user?: string | null;
  sessionId?: string | null;
}

interface OperationLogsResponse {
  logs: OperationLogRecord[];
}

/**
 * 拉取持久化的操作日志。
 * 支持按 tool / user / 时间范围过滤；n 控制返回条数（后端默认 50）。
 * 后端按 ts DESC 返回，前端可直接取头部作为“最近”记录。
 */
export function fetchOperationLogs(opts: {
  n?: number;
  tool?: string;
  user?: string;
  fromTs?: number;
  toTs?: number;
} = {}): Promise<OperationLogsResponse> {
  const qs = new URLSearchParams();
  if (opts.n != null) qs.set('n', String(opts.n));
  if (opts.tool) qs.set('tool', opts.tool);
  if (opts.user) qs.set('user', opts.user);
  if (opts.fromTs != null) qs.set('from', String(opts.fromTs));
  if (opts.toTs != null) qs.set('to', String(opts.toTs));
  const query = qs.toString();
  return apiGet<OperationLogsResponse>(`/api/operation-logs${query ? `?${query}` : ''}`);
}
