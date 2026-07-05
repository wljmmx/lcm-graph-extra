/**
 * lossless-claw Adapter — Hybrid CE Factory Discovery
 *
 * 中间层适配器，通过两种方式获取 lossless-claw 的 ContextEngine 实例：
 *
 *   Primary (B-hybrid):
 *     globalThis[Symbol.for("openclaw.contextEngineRegistryState")]
 *     → state.engines.get('lossless-claw')?.factory
 *     直接访问 registry 全局单例，无文件 IO，无路径解析，绝对可靠。
 *
 *   Fallback:
 *     文件系统动态发现 openclaw 内部 registry 模块路径，
 *     用于 Symbol 方式不可用的遗留版本。
 *
 * 设计原则：
 * - lossless-claw 不作为活跃 CE 使用，其 CE factory 在插件加载时已写入注册表
 * - Primary 方式利用 Node.js 同一个 globalThis，无模块缓存争议
 * - 适配器代理所有 CE 生命周期方法（ingest、ingestBatch、compact 等）
 * - 调用失败时优雅降级，不阻塞主流程
 *
 * @module middleware/lossless-claw-adapter
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Logger } from '../utils/logger.js';
import { resolveLogger, serializeError } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** OpenClaw 内部 CE 注册表全局单例的 Symbol key */
const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for('openclaw.contextEngineRegistryState');
/** lossless-claw shared-init global state key */
const SHARED_INIT_STATE = Symbol.for('@martian-engineering/lossless-claw/shared-init');

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** lossless-claw 暴露的完整 ContextEngine 接口（最小子集） */
interface LosslessClawEngine {
  info?: { id: string; name: string; version: string; ownsCompaction?: boolean; turnMaintenanceMode?: 'background' | 'inline' | string };
  ingest?(params: {
    sessionId: string;
    sessionKey?: string;
    message: any;
  }): Promise<{ ingested: boolean }>;
  ingestBatch?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: any[];
    isHeartbeat?: boolean;
  }): Promise<{ ingestedCount: number }>;
  compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: 'budget' | 'threshold';
    customInstructions?: string;
    runtimeContext?: any;
    legacyParams?: any;
  }): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    summaryId?: string;
    error?: string;
    result?: any;
    exhausted?: boolean;
  }>;
  afterTurn?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: any[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    currentTokenCount?: number;
    runtimeContext?: Record<string, unknown>;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void>;
  bootstrap?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    messages?: any[];
  }): Promise<{ bootstrapped: boolean; importedMessages: number; reason?: string }>;
  assemble?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: any[];
    tokenBudget?: number;
    prompt?: string;
    model?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<{
    messages: any[];
    estimatedTokens: number;
    systemPromptAddition?: string;
    contextProjection?: { mode: "per_turn" | "thread_bootstrap"; epoch?: string; fingerprint?: string };
  }>;
  maintain?(params: {
    sessionId: string;
    sessionFile: string;
    sessionKey?: string;
    runtimeContext?: any;
  }): Promise<{ changed: boolean; bytesFreed: number; rewrittenEntries: number; reason?: string }>;
  dispose?(): Promise<void>;
  getConversationStore?(): any;
  getSummaryStore?(): any;
}


/** Minimal wrapper that delegates to lossless-claw's inner engine.
 * Used when we access the engine via shared-init rather than factory registry. */
class MemorySupplementCtxEngine implements LosslessClawEngine {
  constructor(private inner: any) {}
  async bootstrap(params: any): Promise<any> {
    return this.inner.bootstrap?.(params) ?? {};
  }
  ingest(params: any): Promise<{ ingested: boolean }> {
    return this.inner.ingest?.(params) ?? Promise.resolve({ ingested: false });
  }
  async ingestBatch(params: any): Promise<{ ingestedCount: number }> {
    return this.inner.ingestBatch?.(params) ?? { ingestedCount: 0 };
  }
  compact(params: any): Promise<any> {
    return this.inner.compact?.(params);
  }
  async afterTurn(params: any): Promise<void> {
    await this.inner.afterTurn?.(params);
  }
  async dispose(): Promise<void> {
    this.inner.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * P2-2 H-14: 统一 message content 归一化逻辑。
 * 修复前 ingest/ingestBatch/afterTurn/bootstrap/ensureBootstrapped/assemble 6 处
 * 重复实现"数组 content → string"变换，filter 谓词、join 分隔符、兜底逐字符相同。
 * 此处抽取为单一函数，归一化规则变更只需改一处。
 *
 * - 数组 content：仅保留 string 或带 text 字段的部分，按 '\n' 拼接
 * - 非字符串 content（number/boolean/null/undefined 等）：String() 强制转换
 * - 字符串 content：原样返回 msg（不创建新对象，保持引用相等）
 *
 * 非 text 类型（image/tool_use/tool_result 等）会被静默丢弃，与历史行为一致。
 */
function normalizeMessageContent<T extends { content?: unknown }>(msg: T): T {
  if (Array.isArray(msg.content)) {
    const normalized = (msg.content as any[])
      .filter((c: any) => typeof c === 'string' || (typeof c === 'object' && c !== null && 'text' in c))
      .map((c: any) => (typeof c === 'string' ? c : String(c.text ?? '')))
      .join('\n');
    return { ...msg, content: normalized };
  }
  if (typeof msg.content !== 'string') {
    return { ...msg, content: String(msg.content ?? '') };
  }
  return msg;
}

/**
 * P0-AUDIT: 统一 sessionId String 化。
 *
 * lossless-claw 在 shouldIgnoreSession (engine.ts L540) 和 resolveSessionQueueKey (L634)
 * 中对每个公共方法都调用 sessionId?.trim()。`?.` 仅防 null/undefined，不防 number。
 * 若 sessionId 是 number（如 getConversationId() 返回的 conversationId），会抛
 * TypeError: sessionId?.trim is not a function。
 *
 * 此 helper 在所有调用 engine 前统一 String 化，作为防御性兜底。
 */
function coerceSessionId<T extends { sessionId?: unknown }>(params: T): T {
  if (params.sessionId != null && typeof params.sessionId !== 'string') {
    return { ...params, sessionId: String(params.sessionId) };
  }
  return params;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class LosslessClawAdapter {
  /** 缓存的 engine 实例 */
  private engine: LosslessClawEngine | null = null;

  /** 当前状态 */
  private _connected = false;
  private _connecting: Promise<boolean> | null = null;
  private _initError: string | null = null;

  /** 日志器 (P3-B2: 类型 any → Logger，缺失时降级到 globalLogger) */
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = resolveLogger(logger);
  }

  // ── 状态只读属性 ──

  /** 是否已成功连接到 lossless-claw engine */
  get connected(): boolean {
    return this._connected;
  }

  /** 连接失败的原因（如有） */
  get initError(): string | null {
    return this._initError;
  }

  /** 底层 engine 实例（外部只读使用） */
  get rawEngine(): LosslessClawEngine | null {
    return this.engine;
  }

  // ── 连接 ──

  /**
   * 连接到 lossless-claw 的 ContextEngine。
   * 异步操作，首次调用后缓存结果。
   */
  async connect(): Promise<boolean> {
    if (this._connected) return true;
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect();
    return this._connecting;
  }

  private async _doConnect(): Promise<boolean> {
    try {
      const factory = await this._discoverCEFactory();
      if (!factory) {
        this._initError = 'lossless-claw CE factory not found in registry';
        return false;
      }

      // 调用工厂获取已初始化的 engine 实例
      // factory 接收 factoryCtx: { config?, agentDir?, workspaceDir? }
      // lossless-claw 内部: () => shared.waitForEngine() 返回已初始化的单例
      this.engine = await factory({});
      if (!this.engine || typeof this.engine.compact !== 'function') {
        this._initError = 'lossless-claw factory returned invalid engine';
        this.engine = null;
        return false;
      }

      this._connected = true;
      return true;
    } catch (err) {
      this._initError = (err as Error).message;
      this._connected = false;
      return false;
    }
  }

  // ── CE 生命周期代理 ──

  /** 透传给 lossless-claw 的 ingest */
  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: any;
  }): Promise<{ ingested: boolean }> {
    if (!this._connected || !this.engine) {
      return { ingested: false };
    }
    if (typeof this.engine.ingest !== 'function') {
      return { ingested: false };
    }
    try {
      const msg = params.message;
      let normalizedParams = params;
      if (msg && (Array.isArray(msg.content) || typeof msg.content !== 'string')) {
        normalizedParams = { ...params, message: normalizeMessageContent(msg) };
      }
      normalizedParams = coerceSessionId(normalizedParams);
      return await this.engine.ingest(normalizedParams);
    } catch {
      return { ingested: false };
    }
  }

  /** 透传给 lossless-claw 的 ingestBatch */
  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: any[];
    isHeartbeat?: boolean;
  }): Promise<{ ingestedCount: number }> {
    if (!this._connected || !this.engine) {
      return { ingestedCount: 0 };
    }
    if (typeof this.engine.ingestBatch !== 'function') {
      return { ingestedCount: (params.messages ?? []).length };
    }
    try {
      // Normalize messages before passing to lossless-claw engine
      // OpenClaw may pass content as arrays (rich text/images), but engine expects strings
      const normalizedMessages = (params.messages ?? []).map(normalizeMessageContent);

      const normalizedParams = coerceSessionId({
        ...params,
        messages: normalizedMessages,
      });

      return await this.engine.ingestBatch(normalizedParams);
    } catch {
      return { ingestedCount: 0 };
    }
  }

  /** 透传给 lossless-claw 的 afterTurn */
  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: any[];
    prePromptMessageCount?: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    currentTokenCount?: number;
    runtimeContext?: Record<string, unknown>;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void> {
    if (!this._connected || !this.engine) return;
    if (typeof this.engine.afterTurn !== 'function') return;
    try {
      const normalizedMessages = (params.messages ?? []).map(normalizeMessageContent);

      const normalizedParams = coerceSessionId({
        ...params,
        messages: normalizedMessages,
        prePromptMessageCount: params.prePromptMessageCount ?? 0,
      });

      await this.engine.afterTurn(normalizedParams);
    } catch (err) {
      this.logger?.warn?.('[lossless-claw-adapter] afterTurn failed', { err: serializeError(err) });
    }
  }

  /** 透传给 lossless-claw 的 bootstrap */
  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    messages?: any[];
  }): Promise<{ bootstrapped: boolean; importedMessages: number }> {
    if (!this._connected || !this.engine) {
      return { bootstrapped: false, importedMessages: 0 };
    }
    if (typeof this.engine.bootstrap !== 'function') {
      return { bootstrapped: false, importedMessages: 0 };
    }
    try {
      const normalizedMessages = (params.messages ?? []).map(normalizeMessageContent);

      const normalizedParams = coerceSessionId({
        ...params,
        messages: normalizedMessages,
      });

      return await this.engine.bootstrap(normalizedParams);
    } catch {
      return { bootstrapped: false, importedMessages: 0 };
    }
  }

  // ── Auto-bootstrap guard ──

  /**
   * 确保当前 conversation 已完成 bootstrap。
   * 如果未 bootstrap（如 Gateway 重启后），自动触发 bootstrap。
   * 幂等操作——已 bootstrap 的 conversation 不重复执行。
   */
  async ensureBootstrapped(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    messages?: any[];
  }): Promise<{ bootstrapped: boolean; importedMessages: number }> {
    if (!this._connected || !this.engine) {
      return { bootstrapped: false, importedMessages: 0 };
    }

    // Step 1: 检查是否已 bootstrap（通过 getConversationStore）
    const convStore = this.engine.getConversationStore?.();
    if (convStore) {
      try {
        const existing = await convStore.getConversationForSession?.({
          sessionId: params.sessionId != null ? String(params.sessionId) : undefined,
          sessionKey: params.sessionKey,
        });
        if (existing && existing.bootstrapped_at) {
          // Already bootstrapped, no-op
          return { bootstrapped: true, importedMessages: 0 };
        }
      } catch {
        // Fallback: 直接调用 bootstrap（幂等）
      }
    }

    // Step 2: 未 bootstrap，自动触发
    if (typeof this.engine.bootstrap !== 'function') {
      return { bootstrapped: false, importedMessages: 0 };
    }

    try {
      const normalizedMessages = (params.messages ?? []).map(normalizeMessageContent);

      const normalizedParams = coerceSessionId({
        ...params,
        messages: normalizedMessages,
      });

      const result = await this.engine.bootstrap(normalizedParams);
      return result ?? { bootstrapped: false, importedMessages: 0 };
    } catch {
      return { bootstrapped: false, importedMessages: 0 };
    }
  }

  // ── 核心能力：DAG 压缩 ──

  /**
   * 调用 lossless-claw 的 DAG 压缩。
   *
   * @throws {Error} 如果未连接
   */
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
    legacyParams?: any;
  }): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    summaryId?: string;
    summary?: string;
    error?: string;
    result?: any;
    exhausted?: boolean;
  }> {
    if (!this._connected || !this.engine) {
      throw new Error('LosslessClawAdapter: not connected, cannot compact');
    }

    // P0-AUDIT: 统一用 coerceSessionId 强制 sessionId String 化
    // 避免 lossless-claw 内部 sessionId.trim() 抛 TypeError
    params = coerceSessionId(params);

    try {
      // Call lossless-claw's compact engine
      const lcResult = await this.engine.compact(params);

      // Map CompactResult (openclaw-bridge) to lcm-graph-extra expected format:
      // engine returns: { ok, compacted, reason, result: { tokensBefore, tokensAfter, details }, exhausted }
      // adapter must forward this correctly so index.ts handler can detect success
      const actionTaken = lcResult.compacted === true;
      const createdSummaryId = lcResult.summaryId;
      const tokensInfo = lcResult.result ?? {};

      let summaryContent: string | undefined;
      if (actionTaken && createdSummaryId) {
        try {
          const convStore = this.engine.getConversationStore?.();
          if (convStore) {
            const summaries = await convStore.listSummaries?.(params.sessionId, 1);
            if (summaries?.length > 0) {
              summaryContent = summaries[0].content;
            }
          }
        } catch {
          // Fallback: use summary ID as indicator
        }
      }

      return {
        ok: lcResult.ok !== false,
        compacted: actionTaken,
        reason: lcResult.reason || (actionTaken ? 'compaction completed' : 'compaction attempted but no summary produced'),
        summaryId: createdSummaryId,
        summary: summaryContent,
        result: {
          actionTaken,
          tokensBefore: tokensInfo.tokensBefore ?? 0,
          tokensAfter: tokensInfo.tokensAfter ?? 0,
          condensed: false,
          createdSummaryId,
          summary: summaryContent,
        },
        exhausted: lcResult.exhausted,
      };
    } catch (err) {
      // FIX-AUDIT: serializeError 提取 Error 的 message/stack/name，
      // 修复前 JSON.stringify(Error) = {} 导致日志输出 {"err":{}}，真实错误被吞掉。
      this.logger?.error?.('[lossless-claw-adapter] compact failed', { err: serializeError(err) });
      // 兼容字符串错误（lossless-claw 某些路径 throw "replay refused" 而非 new Error）
      const errMsg = typeof err === 'string' ? err : (err as Error)?.message ?? String(err);
      return {
        ok: false,
        compacted: false,
        reason: errMsg,
        error: errMsg,
      };
    }
  }

  /** 透传给 lossless-claw 的 assemble */
  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: any[];
    tokenBudget?: number;
    prompt?: string;
    model?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<{
    messages: any[];
    estimatedTokens: number;
    systemPromptAddition?: string;
    contextProjection?: { mode: "per_turn" | "thread_bootstrap"; epoch?: string; fingerprint?: string };
  }> {
    if (!this._connected || !this.engine) {
      return { messages: params.messages ?? [], estimatedTokens: 0 };
    }
    if (typeof this.engine.assemble !== 'function') {
      return { messages: params.messages ?? [], estimatedTokens: 0 };
    }
    try {
      const normalizedMessages = (params.messages ?? []).map(normalizeMessageContent);

      const normalizedParams = coerceSessionId({
        ...params,
        messages: normalizedMessages,
      });

      return await this.engine.assemble(normalizedParams);
    } catch (err) {
      this.logger?.warn?.('[lossless-claw-adapter] assemble failed', { err: serializeError(err) });
      return { messages: params.messages ?? [], estimatedTokens: 0 };
    }
  }

  /** 透传给 lossless-claw 的 maintain */
  async maintain(params: {
    sessionId: string;
    sessionFile: string;
    sessionKey?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<{ changed: boolean; bytesFreed: number; rewrittenEntries: number; reason?: string }> {
    if (!this._connected || !this.engine) {
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
    }
    if (typeof this.engine.maintain !== 'function') {
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
    }
    try {
      const normalizedParams = coerceSessionId(params);
      return await this.engine.maintain(normalizedParams);
    } catch (err) {
      this.logger?.warn?.('[lossless-claw-adapter] maintain failed', { err: serializeError(err) });
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: (err as Error).message };
    }
  }

  getConversationStore(): any {
    if (!this._connected || !this.engine) {
      return null;
    }
    return this.engine.getConversationStore?.();
  }

  getSummaryStore(): any {
    if (!this._connected || !this.engine) {
      return null;
    }
    return this.engine.getSummaryStore?.();
  }

  // ── 销毁 ──

  async dispose(): Promise<void> {
    if (this.engine && typeof this.engine.dispose === 'function') {
      try {
        await this.engine.dispose();
      } catch {
        // 忽略销毁错误
      }
    }
    this.engine = null;
    this._connected = false;
    this._connecting = null;
  }

  // ── 内部：发现 CE Factory ──

  /**
   * Hybrid 方式发现 lossless-claw 的 CE Factory：
   *
   *   Primary (B-hybrid):
   *     通过 globalThis[Symbol.for("openclaw.contextEngineRegistryState")]
   *     直接访问 registry 全局单例，获取 lossless-claw 的 factory。
   *     与 OpenClaw 核心使用同一个 globalThis，无模块缓存争议。
   *
   *   Fallback:
   *     文件系统动态发现 openclaw 内部 CE 注册表模块的哈希路径，
   *     通过 Node.js ES 模块单例机制动态导入。
   */
  private async _discoverCEFactory():
    Promise<((ctx: any) => Promise<LosslessClawEngine>) | null>
  {
    // ── Primary: globalThis Symbol 方式 ──
    this.logger.debug("[lcm] path 1/4: Primary Symbol registry");
    try {
      const state: Record<string, any> | undefined =
        (globalThis as any)[CONTEXT_ENGINE_REGISTRY_STATE];
      if (state?.engines instanceof Map) {
        const entry = state.engines.get('lossless-claw');
        if (entry && typeof entry.factory === 'function') {
          return entry.factory as (ctx: any) => Promise<LosslessClawEngine>;
        }
      }
    } catch {
      // Symbol 方式失败，走 Fallback
    }
      this.logger.debug("[lcm] _discoverCEFactory: path 1/4 FAILED (Symbol registry)");

    this.logger.debug("[lcm] path 2/4: Shared State");
    // ── Shared State: 直接通过 lossless-claw 的 globalThis Symbol shared-init 获取 engine ──
    // 如果 lossless-claw 插件已被 OpenClaw 加载（即使非活跃 CE），shared state 里就有引擎实例。
    // 这比走 factory registry 更直接——类似于 GraphAdapter 直连 Neo4j 而不是经过 plugin SDK。
    try {
      const sharedStore: Map<string, any> | undefined =
        (globalThis as any)[SHARED_INIT_STATE];
      if (sharedStore instanceof Map) {
        // Find any entry (lossless-claw uses db path as key)
        for (const init of sharedStore.values()) {
          const engine = init.getCachedEngine?.();
          if (engine) {
            return async () => new MemorySupplementCtxEngine(engine);
          }
          // Engine not ready yet, try waitForEngine
          const waitFn = init.waitForEngine;
          if (typeof waitFn === 'function') {
            return async () => {
              const e = await waitFn();
              return new MemorySupplementCtxEngine(e);
            };
          }
        }
      }
      this.logger.debug("[lcm] _discoverCEFactory: path 2/4 FAILED (Shared State)");
    } catch {
      // shared state not available, continue
    }
    this.logger.debug("[lcm] path 3/4: Direct FS scan");

    // ── Direct FS: 扫描 projects/ 找 lossless-claw dist，import 触发初始化 ──
    // P0-4 SEC-2: 加路径白名单校验。任何能写入 ~/.openclaw/npm/projects/*/node_modules
    // 的进程可注入任意代码并经 pluginEntry.register(mockApi) 执行。此处严格校验：
    //   1) entry.name 必须是安全的目录名（无路径分隔符、无 ..）
    //   2) realpath(candidatePath) 必须仍在 projectsDir 之下（防符号链接逃逸）
    //   3) 候选路径必须严格匹配预期形状（@martian-engineering/lossless-claw/dist/index.js）
    try {
      const projectsDir = join(homedir(), '.openclaw', 'npm', 'projects');
      const entries = await readdir(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // 安全目录名校验：仅允许 [A-Za-z0-9._-]
        if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
        const candidatePath = join(
          projectsDir,
          entry.name,
          'node_modules',
          '@martian-engineering',
          'lossless-claw',
          'dist',
          'index.js',
        );
        try {
          // realpath 校验，防止符号链接逃逸到 projectsDir 之外
          const [realCandidate, realProjectsDir] = await Promise.all([
            realpath(candidatePath),
            realpath(projectsDir),
          ]);
          if (!realCandidate.startsWith(realProjectsDir + sep) && realCandidate !== realProjectsDir) {
            this.logger.debug(`[lcm] _discoverCEFactory: reject path escaping projectsDir: ${candidatePath}`);
            continue;
          }
          await stat(candidatePath);
          const lcModule = await import(pathToFileURL(candidatePath).href);
          // dist/index.js default export is the plugin entry with register()
          const pluginEntry = lcModule.default;
          if (pluginEntry && typeof pluginEntry.register === 'function') {
            const mockApi: Record<string, any> = {
              getConfig: () => ({}),
              getRuntimeInfo: () => ({ version: 'mock', mode: 'direct-fs' }),
              registerContextEngine: (_id: string, _fn: Function) => {},
              registerTool: () => {},
              registerCommand: () => {},
              on: () => {},
            };
            pluginEntry.register(mockApi);

            // Re-check shared state after plugin init
            const retryShared: Map<string, any> | undefined =
              (globalThis as any)[SHARED_INIT_STATE];
            if (retryShared instanceof Map) {
              for (const init of retryShared.values()) {
                const engine = init.getCachedEngine?.();
                if (engine) {
                  return async () => new MemorySupplementCtxEngine(engine);
                }
                const waitFn = init.waitForEngine;
                if (typeof waitFn === 'function') {
                  return async () => {
                    const e = await waitFn();
                    return new MemorySupplementCtxEngine(e);
                  };
                }
              }
            }
          }
        } catch {
          // candidate not found or import failed
        }
      }
    } catch {
      // projects dir scan failed, fall through to Fallback
    this.logger.debug("[lcm] path 4/4: Fallback registry");
    }

    // ── Fallback: 文件系统 Registry 发现 ──

    // Step 1: 解析 openclaw/plugin-sdk 的绝对路径
    let sdkUrl: string;
    try {
      sdkUrl = await import.meta.resolve('openclaw/plugin-sdk');
    } catch {
      throw new Error('Cannot resolve openclaw/plugin-sdk');
    }
    const sdkPath = fileURLToPath(sdkUrl);

    // Step 2: 读取文件，发现 registry 模块的动态哈希文件名
    const sdkContent = await readFile(sdkPath, 'utf-8');
    const importMatch = sdkContent.match(/from\s+"\.\.\/(registry-\w+\.js)"/);
    if (!importMatch) {
      throw new Error('Cannot discover CE registry module: no matching import in plugin-sdk/index.js');
    }

    // Step 3: 构建 registry 模块的完整路径
    const distDir = dirname(dirname(sdkPath));
    const registryPath = join(distDir, importMatch[1]);

    // Step 4: 动态导入 registry 模块
    const regModule: Record<string, any> = await import(pathToFileURL(registryPath).href);
    if (!regModule || typeof regModule !== 'object') {
      throw new Error('Invalid registry module: ' + importMatch[1]);
    }

    // Step 5: 获取 getContextEngineFactory 函数
    const getFactory: (id: string) => Function | undefined =
      typeof regModule.getContextEngineFactory === 'function'
        ? regModule.getContextEngineFactory
        : typeof regModule.n === 'function'
          ? regModule.n
          : null;

    if (!getFactory) {
      throw new Error('getContextEngineFactory not found in registry module');
    }

    // Step 6: 获取 lossless-claw 的 CE factory
    const factory = getFactory('lossless-claw');

    if (typeof factory !== 'function') {
      this.logger.debug("[lcm] _discoverCEFactory: path 4/4 FAILED, factory not a function");
      return null;
    }

    this.logger.debug("[lcm] _discoverCEFactory: path 4/4 FOUND factory");
    return factory as (ctx: any) => Promise<LosslessClawEngine>;
  }
}
