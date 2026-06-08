/**
 * lcm-graph-extra — ContextEngine 实现
 *
 * 实现 OpenClaw SDK 的 ContextEngine 接口，桥接到现有的 hook 模块。
 *
 * 生命周期：
 *   bootstrap  →  onSessionCreated
 *   ingest     →  消息接收处理
 *   ingestBatch → 批量消息接收
 *   assemble   →  onBeforeTurn
 *   afterTurn  →  onTurnComplete
 *   compact    →  Adapter中间层: lossless-claw DAG压缩 + onCompaction
 *   maintain   →  onHeartbeat
 */

import { validateConfig } from './config';
import type { PluginConfig } from './config';
import { onBeforeTurn } from './hooks/before-turn';
import { onHeartbeat } from './hooks/heartbeat';
import { onTurnComplete } from './hooks/turn-complete';
import { onSessionCreated } from './hooks/session-created';
import { onCompaction } from './hooks/compaction';
import { LosslessClawAdapter } from './middleware/lossless-claw-adapter';
import { DreamingEngine } from './experience/dreaming';
import pino from 'pino';

// ---------------------------------------------------------------------------
// 简化的上下文类型（桥接新旧接口）
// ---------------------------------------------------------------------------

interface EngineContext {
  config: Record<string, unknown>;
  logger: pino.Logger;
  memoryDir?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  [key: string]: unknown;
}

function buildContext(sdkCtx: Record<string, unknown>, extra?: Record<string, unknown>): EngineContext {
  return {
    config: (sdkCtx.config ?? {}) as Record<string, unknown>,
    logger: pino({ level: 'info', name: 'lcm-graph-extra' }),
    memoryDir: (sdkCtx.workspaceDir ?? process.env.HOME) as string,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// ContextEngine 实现
// ---------------------------------------------------------------------------

export class LCMMemoryEngine {
  readonly info = {
    id: 'lcm-graph-extra',
    name: 'LCM Graph Extra',
    version: '0.2.0',
    ownsCompaction: true,
    turnMaintenanceMode: 'background' as const,
  };

  private sdkCtx: Record<string, unknown>;
  private engineCtx: EngineContext;
  private pluginInstance: any = null;
  private runtimeApi: any = null;
  private lcmAdapter = new LosslessClawAdapter();

  constructor(sdkCtx: Record<string, unknown>) {
    this.sdkCtx = sdkCtx;
    this.engineCtx = buildContext(sdkCtx);
  }

  async init(api?: any): Promise<void> {
    this.runtimeApi = api ?? null;
    const config = validateConfig(this.engineCtx.config);
    this.pluginInstance = {
      config,
      logger: this.engineCtx.logger,
      context: this.engineCtx,
      unregister: () => {},
    };

    // 异步连接 lossless-claw adapter（非阻塞，compact 时再 await）
    this.lcmAdapter.connect().then((ok: boolean) => {
      if (ok) {
        this.engineCtx.logger.info?.('[lcm-graph-extra] lossless-claw adapter: connected');
      } else {
        this.engineCtx.logger.info?.(
          '[lcm-graph-extra] lossless-claw adapter: unavailable - ' +
          (this.lcmAdapter.initError ?? 'unknown'),
        );
      }
    });
  }

  // -- bootstrap -----------------------------------------------------------

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<{ bootstrapped: boolean; importedMessages?: number; reason?: string }> {
    this.engineCtx = buildContext(this.sdkCtx, {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
    });
    this.pluginInstance.context = this.engineCtx;

    try {
      await onSessionCreated(this.pluginInstance, params.sessionId);
      this.engineCtx.logger.info?.('bootstrap: session initialized');
      return { bootstrapped: true, importedMessages: 0 };
    } catch (err) {
      this.engineCtx.logger.error?.({ err }, 'bootstrap: failed');
      return { bootstrapped: false, reason: (err as Error).message };
    }
  }

  // -- ingest --------------------------------------------------------------

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: any;
    isHeartbeat?: boolean;
  }): Promise<{ ingested: boolean }> {
    return { ingested: true };
  }

  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: any[];
    isHeartbeat?: boolean;
  }): Promise<{ ingestedCount: number }> {
    return { ingestedCount: params.messages.length };
  }

  // -- assemble ------------------------------------------------------------

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: any[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: string;
    model?: string;
    prompt?: string;
  }): Promise<{
    messages: any[];
    estimatedTokens: number;
    systemPromptAddition?: string;
    promptAuthority?: string;
  }> {
    try {
      const contextStr = await onBeforeTurn(this.pluginInstance, params.prompt);
      return {
        messages: params.messages,
        estimatedTokens: Math.ceil(contextStr.length / 4),
        systemPromptAddition: contextStr || undefined,
        promptAuthority: 'assembled',
      };
    } catch (err) {
      this.engineCtx.logger.error?.({ err }, 'assemble: failed');
      return {
        messages: params.messages,
        estimatedTokens: 0,
        systemPromptAddition: undefined,
        promptAuthority: 'assembled',
      };
    }
  }

  // -- compact (Phase 1-3) -----------------------------------------------
  //
  // ownsCompaction: true → OpenClaw 跳过内置压缩，调用此方法。
  // 本方法负责：
  //   1. 通过 LosslessClawAdapter 中间层调用 lossless-claw DAG 压缩
  //   2. 备份 memory 文件
  //   3. Neo4j 事件日志 + marker
  //
  // lossless-claw 不作为活跃 CE，其 engine 通过内部 CE 注册表获取。
  // 适配器通过文件系统动态发现 registry 模块路径，调用工厂获取同个实例。
  // -------------------------------------------------------------------------

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: 'budget' | 'threshold';
    customInstructions?: string;
    runtimeContext?: any;
    abortSignal?: AbortSignal;
  }): Promise<{ ok: boolean; compacted: boolean; reason?: string; result?: any }> {
    if (params.abortSignal?.aborted) {
      return { ok: false, compacted: false, reason: 'aborted' };
    }

    const logger = this.engineCtx.logger;

    try {
      // --- Step 1: 通过 Adapter 中间层调用 lossless-claw 的 DAG 压缩 ---
      // adapter 通过内部 CE 注册表获取已初始化的 lossless-claw engine
      try {
        if (this.lcmAdapter.connected) {
          await this.lcmAdapter.compact({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            force: true,
          });
          logger.info?.('compact: lossless-claw DAG compact completed');
        } else {
          logger.info?.(
            'compact: lossless-claw not connected (' +
            (this.lcmAdapter.initError ?? 'unknown') +
            '), skipping DAG compression',
          );
        }
      } catch (lcmErr) {
        // lossless-claw 调用失败不阻塞后续备份流程
        logger.warn?.({ err: (lcmErr as Error).message }, 'compact: lossless-claw delegation failed, continuing with backup');
      }

      // 再次检查是否已取消
      if (params.abortSignal?.aborted) {
        logger.warn?.('compact: aborted before step 2');
        return { ok: false, compacted: false, reason: 'aborted' };
      }

      // --- Step 2: 文件备份 + Neo4j 日志 + marker ---
      await onCompaction(this.pluginInstance);

      return {
        ok: true,
        compacted: true,
        reason: 'lossless-claw DAG compact + backup completed',
      };
    } catch (err) {
      logger.error?.({ err }, 'compact: failed');
      return {
        ok: false,
        compacted: false,
        reason: (err as Error).message,
      };
    }
  }

  // -- afterTurn -----------------------------------------------------------

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: any[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: any;
  }): Promise<void> {
    this.engineCtx = buildContext(this.sdkCtx, {
      ...this.engineCtx,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      recentMessages: params.messages.slice(params.prePromptMessageCount),
      priorMessages: params.messages.slice(0, params.prePromptMessageCount),
    });
    this.pluginInstance.context = this.engineCtx;

    try {
      await onTurnComplete(this.pluginInstance);
    } catch (err) {
      this.engineCtx.logger.error?.({ err }, 'afterTurn: failed');
    }
  }

  // -- maintain ------------------------------------------------------------

  async maintain(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeContext?: any;
  }): Promise<{ rewrittenEntries?: number; reason?: string } | void> {
    try {
      await onHeartbeat(this.pluginInstance);
      return { rewrittenEntries: 0, reason: 'heartbeat completed' };
    } catch (err) {
      return { rewrittenEntries: 0, reason: (err as Error).message };
    }
  }

  // -- dreaming -------------------------------------------------------------

  /**
   * 在 maintain() 之后触发 Dreaming 批量总结（可选）。
   * 调用前需确保 Neo4j 连接可用。
   *
   * 建议配置：每 N 次 maintain() 调用一次（通过心跳间隔控制）。
   */
  async runDreaming(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const { GraphAdapter } = await import('./adapters/graph-adapter');
      const { ExperienceStorage } = await import('./experience');
      const { DreamingEngine } = await import('./experience/dreaming');
      const { resolveNeo4jConfig } = await import('./config/neo4j-helper');
      const neo4jConf = resolveNeo4jConfig(this.sdkCtx.config);
      const adapter = new GraphAdapter(neo4jConf, { enabled: true, searchLimit: 5 });
      const storage = new ExperienceStorage(adapter);

      // 构建 summarizeFn：复用运行时 LLM 能力
      // 通过 api.runtime.llm.complete 或 lossless-claw CLI 接口
      const summarizeFn = this.buildDreamingSummarizer();

      const engine = new DreamingEngine(storage, undefined, this.engineCtx.logger, summarizeFn);
      const result = await engine.dream();
      this.engineCtx.logger.info(
        { processed: result.processed, distilled: result.distilled },
        'dreaming: batch summarization completed',
      );
      return { ok: true, reason: `${result.processed} processed, ${result.distilled} distilled` };
    } catch (err) {
      this.engineCtx.logger.error?.({ err: (err as Error).message }, 'dreaming: failed');
      return { ok: false, reason: (err as Error).message };
    }
  }

  /**
   * 构建 Dreaming 的 LLM 总结函数。
   *
   * 降级链路：
   *   1. api.runtime.llm.complete （标准运行时 LLM 接口）
   *   2. api.runtime.logging （仅日志，不调用 LLM）
   *   3. null → DreamingEngine 回退到 deterministic 合并
   */
  private buildDreamingSummarizer(): ((cluster: any[], prompt: string) => Promise<string>) | null {
    const api = this.runtimeApi;
    if (!api) return null;

    // 尝试从运行时获取 LLM complete 函数
    const llmComplete = api.runtime?.llm?.complete;
    if (typeof llmComplete === 'function') {
      const logger = this.engineCtx.logger;
      return async (_cluster: any[], prompt: string): Promise<string> => {
        try {
          const result = await llmComplete({ messages: [{ role: 'user', content: prompt }] });
          return result?.content ?? '';
        } catch (err) {
          logger.warn?.({ err: (err as Error).message }, 'dreaming: llm.complete failed');
          throw err;
        }
      };
    }

    // 无 LLM 可用
    this.engineCtx.logger.debug?.('dreaming: no runtime LLM available, will use deterministic merge');
    return null;
  }
}
