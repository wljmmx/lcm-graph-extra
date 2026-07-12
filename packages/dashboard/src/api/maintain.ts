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

/** 图谱维护（dedup / PageRank / community + 债务表对账） */
export function invokeMaintain(): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_maintain', {});
}

/** 系统诊断（lcm.db / qmd MCP / Neo4j / 熔断器 / health metrics 全栈自检） */
export function invokeDiagnose(): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_diagnose', {});
}

/** 触发经验蒸馏：limit 控制单次处理数量 */
export function invokeDistill(limit: number): Promise<McpInvokeResponse> {
  return invokeMcpTool('lcmg_distill', { limit });
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
