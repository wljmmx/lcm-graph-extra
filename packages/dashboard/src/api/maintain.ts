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
import { apiGet, apiPost } from './client';

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
 * 触发 gm-pro 全节点重新向量化 / 清库重导。
 * ⚠️ 走 gm-pro HTTP 代理（POST /api/gm-pro/proxy/reembed），非 MCP invoke。
 * clear=true 时先清库再重导（推荐流程：clear → 导入数据 → 埋点）。
 * v2.8.0 新增，与维护面板 dirty-nodes 卡内按钮对齐。
 */
export async function invokeReembed(opts: { clear?: boolean } = {}): Promise<McpInvokeResponse> {
  try {
    const resp = await apiPost<{ ok: boolean; data?: any; error?: string }>(
      '/api/gm-pro/proxy/reembed',
      opts,
    );
    if (resp.ok) {
      return { ok: true, result: resp.data };
    }
    return { ok: false, error: resp.error ?? '重新向量化失败' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `重新向量化请求失败: ${msg}` };
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
