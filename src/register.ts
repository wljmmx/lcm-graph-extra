/**
 * lcm-graph-extra — OpenClaw ContextEngine Plugin
 *
 * 职责: CE 引擎, 协调四个能力层:
 *   Layer 1. lossless-claw (OpenClaw 内置) — 会话消息 DAG/摘要/lcm_grep
 *   Layer 2. qmd MCP — 记忆文件 BM25+向量语义搜索
 *   Layer 3. Neo4j/graph-memory-pro — 知识图谱实体关系
 *   Layer 4. experience总结引擎 — 异步精炼, relevanceScore阈值召回
 *
 * lifecycle:
 *   assemble: QmdClient + GraphAdapter + ExperienceStorage → supplement lossless-claw context
 *   afterTurn: extract entities + experience → Neo4j
 *   maintain: TTL + health checks
 */

import pino from 'pino';
import { validateConfig } from './config';
import type { PluginConfig } from './config';
import { onBeforeTurn } from './hooks/before-turn';
import { onHeartbeat } from './hooks/heartbeat';
import { onTurnComplete } from './hooks/turn-complete';
import { onSessionCreated } from './hooks/session-created';
import { onCompaction } from './hooks/compaction';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenClawContext {
  config: Record<string, unknown>;
  hooks?: Record<string, (callback: Function) => void>;
  llmProvider?: {
    chatWithLLM: (messages: Array<{ role: string; content: string }>) => Promise<string>;
    expandQuery: (query: string, options?: Record<string, unknown>) => Promise<string>;
  };
  logger?: pino.Logger;
  memoryDir?: string;
}

export interface PluginInstance {
  config: PluginConfig;
  logger: pino.Logger;
  context: OpenClawContext;
  unregister: () => void;
}

export interface ContextEngineInfo {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
  turnMaintenanceMode?: 'foreground' | 'background';
}

export interface ContextEngineAssemblyResult {
  systemPromptAddition?: string;
  assembledContext: string;
  estimatedTokens: number;
}

export interface ContextEngineIngestResult {
  ingested: number;
  failed: number;
}

export interface ContextEngineBootstrapResult {
  success: boolean;
  message?: string;
}

export interface ContextEngineMaintenanceResult {
  changed: boolean;
  bytesFreed: number;
  rewrittenEntries: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Global registry
// ---------------------------------------------------------------------------

const registeredPlugins = new Map<string, PluginInstance>();

// ---------------------------------------------------------------------------
// Context Engine implementation
// ---------------------------------------------------------------------------

export const info: ContextEngineInfo = {
  id: 'lcm-graph-extra',
  name: 'LCM Graph Extra',
  version: '0.1.0',
  ownsCompaction: true,
  turnMaintenanceMode: 'background',
};

/**
 * Bootstrap — called when a session is created/loaded.
 * lossless-claw 已经作为 OpenClaw 内置组件独立初始化，这里只初始化补充能力
 */
export async function bootstrap(ctx: OpenClawContext): Promise<ContextEngineBootstrapResult> {
  try {
    const logger = ctx.logger ?? pino({ level: 'silent', name: info.id });
    const instance: PluginInstance = {
      config: validateConfig(ctx.config || {}),
      logger,
      context: ctx,
      unregister: () => { registeredPlugins.delete(info.id); },
    };
    registeredPlugins.set(info.id, instance);

    await onSessionCreated(instance);

    // 验证 lossless-claw 是否正常
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('/home/wljmmx/.openclaw/lcm.db');
      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages').get().cnt;
      const summaryCount = db.prepare('SELECT COUNT(*) as cnt FROM summaries').get().cnt;
      logger.info(`lossless-claw healthy: ${msgCount} msgs, ${summaryCount} summaries`);
      db.close();
    } catch (e) {
      logger.warn(`lossless-claw check: ${(e as Error).message}`);
    }

    logger.debug('context engine bootstrap completed');
    return { success: true };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[lcm-graph-extra] bootstrap failed: ${msg}`);
    return { success: false, message: msg };
  }
}

/**
 * Assemble — called before each model turn.
 * lossless-claw 已经完成其上下文组装，这里补充:
 * 1. qmd MCP 语义搜索 (memory 文件)
 * 2. Neo4j 知识图谱查询
 */
export async function assemble(
  ctx: OpenClawContext,
  runtimeCtx?: Record<string, unknown>,
): Promise<ContextEngineAssemblyResult> {
  try {
    const instance = getOrCreateInstance(ctx);
    const context = await onBeforeTurn(instance);
    return {
      assembledContext: context,
      systemPromptAddition: context || undefined,
      estimatedTokens: Math.ceil(context.length / 4) || 0,
    };
  } catch (err) {
    console.error(`[lcm-graph-extra] assemble failed: ${(err as Error).message}`);
    return { assembledContext: '', systemPromptAddition: undefined, estimatedTokens: 0 };
  }
}

/**
 * afterTurn — called after each model turn.
 * lossless-claw 已经接收消息并构建 DAG
 * 这里补充: 实体提取写入 Neo4j, 经验总结
 */
export async function afterTurn(
  ctx: OpenClawContext,
  _runtimeCtx?: Record<string, unknown>,
): Promise<ContextEngineIngestResult> {
  try {
    const instance = getOrCreateInstance(ctx);
    await onTurnComplete(instance);
    return { ingested: 1, failed: 0 };
  } catch (err) {
    console.error(`[lcm-graph-extra] afterTurn failed: ${(err as Error).message}`);
    return { ingested: 0, failed: 1 };
  }
}

/**
 * maintain — periodic background maintenance.
 * lossless-claw 已经执行 compaction
 * 这里补充: TTL 清理 + qmd/Neo4j 健康检测
 */
export async function maintain(ctx: OpenClawContext): Promise<ContextEngineMaintenanceResult> {
  try {
    const instance = getOrCreateInstance(ctx);
    await onHeartbeat(instance);
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: 'heartbeat completed' };
  } catch (err) {
    console.error(`[lcm-graph-extra] maintain failed: ${(err as Error).message}`);
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: (err as Error).message };
  }
}

/**
 * compact — compaction request.
 * lossless-claw 已经处理其 compaction
 * 这里补充: 非必要不处理
 */
export async function compact(ctx: OpenClawContext): Promise<ContextEngineMaintenanceResult> {
  try {
    const instance = getOrCreateInstance(ctx);
    await onCompaction(instance);
    return { changed: true, bytesFreed: 0, rewrittenEntries: 0, reason: 'compaction completed' };
  } catch (err) {
    console.error(`[lcm-graph-extra] compact failed: ${(err as Error).message}`);
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getOrCreateInstance(ctx: OpenClawContext): PluginInstance {
  const existing = registeredPlugins.get(info.id);
  if (existing) return existing;
  const logger = ctx.logger ?? pino({ level: 'silent', name: info.id });
  const instance: PluginInstance = {
    config: validateConfig(ctx.config || {}),
    logger,
    context: ctx,
    unregister: () => { registeredPlugins.delete(info.id); },
  };
  registeredPlugins.set(info.id, instance);
  return instance;
}

/**
 * Legacy hook-based registration (backward-compatible).
 */
export function register(
  pluginId: string = info.id,
  context: OpenClawContext,
): PluginInstance {
  const config = validateConfig(context.config || {});
  const logger = context.logger || pino({ level: 'silent', name: pluginId });

  if (registeredPlugins.has(pluginId)) {
    registeredPlugins.get(pluginId)!.unregister();
  }

  const registeredHooks = new Set<string>();
  if (context.hooks) {
    const hookNames = ['turn_complete', 'heartbeat', 'compaction', 'before_turn', 'session_created'];
    for (const name of hookNames) {
      if (typeof context.hooks[name] === 'function') {
        context.hooks[name](async (..._args: unknown[]) => {
          try {
            const instance = getOrCreateInstance(context);
            switch (name) {
              case 'before_turn': return await onBeforeTurn(instance);
              case 'heartbeat': return await onHeartbeat(instance);
              case 'turn_complete': return await onTurnComplete(instance);
              case 'session_created': return await onSessionCreated(instance);
              case 'compaction': return await onCompaction(instance);
            }
          } catch (err) {
            logger.error({ err }, `hook ${name} failed`);
            return null;
          }
        });
        registeredHooks.add(name);
      }
    }
  }

  const instance: PluginInstance = { config, logger, context, unregister: () => { registeredPlugins.delete(pluginId); } };
  registeredPlugins.set(pluginId, instance);
  return instance;
}

export function getRegisteredPlugin(id: string = info.id): PluginInstance | undefined {
  return registeredPlugins.get(id);
}

/**
 * Return a copy of all registered plugin instances (id → PluginInstance).
 */
export function listRegisteredPlugins(): Map<string, PluginInstance> {
  return new Map(registeredPlugins);
}
