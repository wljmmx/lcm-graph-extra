/**
 * OpenClaw MCP 工具调用客户端。
 *
 * 写路径统一通过本模块转发到插件 snapshot server 的 /internal/mcp-invoke 端点。
 *
 * 架构说明：
 * - OpenClaw host 端口 18789 是 LLM API（Ollama 桥接），不暴露 MCP invoke HTTP 端点
 * - 插件 snapshot server 端口 7423 与插件同进程，可直接调用已注册的工具 handler
 * - 因此 dashboard 转发到 snapshot server，而非 OpenClaw host
 *
 * 默认 host: http://127.0.0.1:7423（与 PLUGIN_SNAPSHOT_URL 对齐）
 *
 * 超时策略（v2.2.4 重新设计）：
 * 不同工具的耗时差异巨大（pin 毫秒级，distill 50条本地大模型可达 30 分钟），
 * 单一 30s 超时导致蒸馏/回溯/同步等长任务全部误超时失败。
 * 按工具类别分档设置超时，并支持环境变量 MCP_TIMEOUT_MS 全局覆盖。
 *
 * 本地模型参考（qwen3.6:27b q_4 on 4090+64G，开思考模式）：
 *   - 单条蒸馏 LLM 调用：60-180s（含思考+生成）
 *   - 50条并发3：最长 (50/3) * 180s ≈ 3000s
 *   - backfill 100会话：每会话检测+提取，无 LLM 调用，约 30-120s
 *   - sync repair：SQLite + Neo4j 批量 MERGE，约 60-300s
 *
 * BUGFIX(v2.2.5): Node.js fetch（基于 undici）默认 headersTimeout=300000ms (5min)
 * 和 bodyTimeout=300000ms (5min)，即使 AbortController 设置为 60 分钟，
 * undici 仍会在 5 分钟时因等待响应头超时中断 fetch（报 "fetch failed"）。
 * undici 在 Node.js 中不作为可导入模块暴露，无法通过 Agent 自定义超时。
 * 解决方案：改用 node:http 原生模块，它没有 undici 的 5 分钟默认超时问题，
 * 超时完全由 setTimeout + req.destroy() 控制。
 */

import { request, type RequestOptions } from 'node:http';
import { URL } from 'node:url';

// 与 server/lib/snapshot.ts / routes/config.ts / routes/graph-health.ts 共用 env var
const MCP_HOST = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';

/**
 * 按工具名分档的超时配置（毫秒）。
 *
 * 分档依据：
 * - quick（10s）：单次 Cypher 操作或状态查询，无 LLM 调用
 * - standard（60s）：含少量 Neo4j 操作或轻量 LLM 调用
 * - long（600s / 10min）：含批量 Neo4j 操作或 backfill 提取
 * - heavy（3600s / 60min）：蒸馏（批量 LLM 调用，本地大模型每条 60-180s）
 *
 * 所有值可通过环境变量 MCP_TIMEOUT_MS 全局覆盖（单位毫秒）。
 */
const TOOL_TIMEOUT_MS: Record<string, number> = {
  // quick: 单次 Cypher 操作，无 LLM
  lcmg_pin: 10_000,
  lcmg_forget: 10_000,

  // standard: 轻量操作
  lcmg_maintain: 60_000,        // dedup + PageRank + community
  lcmg_reset_breaker: 10_000,   // 重置熔断器，瞬时操作

  // long: 批量 Neo4j / SQLite 操作
  lcmg_diagnose: 120_000,       // 全栈自检，2min
  lcmg_compact: 300_000,        // 压缩对话，5min
  lcmg_sync: 600_000,           // 同步修复，10min
  lcmg_backup: 300_000,         // 备份，5min
  lcmg_restore: 600_000,        // 恢复，10min
  lcmg_import: 600_000,         // 历史导入，10min
  lcmg_backfill: 900_000,       // 经验回溯，15min（100会话检测+提取，无 LLM）

  // heavy: 批量 LLM 蒸馏
  lcmg_distill: 3_600_000,      // 蒸馏，60min（50条 * 120s/条 / 并发3 ≈ 2000s，留余量）
};

/** 默认超时（未在 TOOL_TIMEOUT_MS 中显式列出的工具） */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 获取指定工具的超时时间（毫秒）。
 *
 * 优先级：
 * 1. 环境变量 MCP_TIMEOUT_MS（全局覆盖，所有工具统一）
 * 2. TOOL_TIMEOUT_MS 中按工具名的分档配置
 * 3. DEFAULT_TIMEOUT_MS 兜底
 */
function getTimeoutForTool(tool: string): number {
  // 环境变量全局覆盖（便于临时调试或特殊环境调整）
  const envTimeout = process.env.MCP_TIMEOUT_MS;
  if (envTimeout) {
    const n = Number(envTimeout);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return TOOL_TIMEOUT_MS[tool] ?? DEFAULT_TIMEOUT_MS;
}

/** MCP 工具调用响应 */
export interface McpInvokeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * 使用 node:http 发送 POST 请求（避免 undici/fetch 的 5 分钟默认超时）。
 *
 * node:http 的 socket 超时需要手动设置，没有 undici 的 headersTimeout/bodyTimeout
 * 限制，适合长任务调用。
 */
function httpPost(
  url: string,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
      res.on('error', reject);
    });

    // 总超时控制：到达超时后销毁请求
    const timer = setTimeout(() => {
      req.destroy(new Error(`TIMEOUT_AFTER_${timeoutMs}ms`));
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on('close', () => {
      clearTimeout(timer);
    });

    req.write(body);
    req.end();
  });
}

/**
 * 调用 OpenClaw MCP 工具。
 *
 * @param tool 工具名，如 "lcmg_maintain"
 * @param params 工具参数
 */
export async function invokeMcpTool(
  tool: string,
  params: Record<string, unknown>,
): Promise<McpInvokeResponse> {
  const timeoutMs = getTimeoutForTool(tool);
  try {
    const { status, body } = await httpPost(
      `${MCP_HOST}/internal/mcp-invoke`,
      JSON.stringify({ tool, params }),
      timeoutMs,
    );
    if (status !== 200) {
      return {
        ok: false,
        error: `MCP host HTTP ${status}: ${body.slice(0, 500)}`,
      };
    }
    const data = JSON.parse(body) as Partial<McpInvokeResponse>;
    return {
      ok: Boolean(data.ok),
      result: data.result,
      error: data.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 超时单独提示，便于排查
    if (msg.startsWith('TIMEOUT_AFTER_')) {
      return { ok: false, error: `MCP 调用超时（${timeoutMs}ms，工具: ${tool}）。该工具超时阈值为 ${Math.round(timeoutMs / 1000)}s，可通过环境变量 MCP_TIMEOUT_MS 调整。` };
    }
    return { ok: false, error: `MCP 调用失败: ${msg}` };
  }
}
