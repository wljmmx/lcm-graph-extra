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
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Logger } from '../utils/logger.js';
import { resolveLogger, serializeError } from '../utils/logger.js';
import { getSessionLlmSnapshot, getActiveLocalLlmSnapshot, buildLocalLlmComplete, resolveLocalSnapshotForModel, isSessionRemoteModel, resolveConfiguredDistillationLlm, buildConfiguredLlmComplete, isOllamaModel } from '../plugin/distillation.js';

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
    runtimeSettings?: any;
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
    runtimeSettings?: any;
    legacyCompactionParams?: Record<string, unknown>;
    sessionTarget?: Record<string, unknown>;
  }): Promise<void>;
  // OpenClaw 2026.7.2+ durable-turn 契约：功率等写入逻辑轮，返回 committed/duplicate
  commitTurn?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: any; // SDK: ContextEngineSessionTarget
    advancementKey: string;
    admission: any;
    terminal: any; // SDK: TranscriptEntryAnchor
    messages: any[];
    runtimeContext?: Record<string, unknown>;
    runtimeSettings?: any;
    isHeartbeat?: boolean;
  }): Promise<{ status: 'committed' | 'duplicate'; committedAt?: string }>;
  bootstrap?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    messages?: any[];
    runtimeSettings?: any;
  }): Promise<{ bootstrapped: boolean; importedMessages: number; reason?: string }>;
  assemble?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: any[];
    tokenBudget?: number;
    prompt?: string;
    model?: string;
    runtimeContext?: Record<string, unknown>;
    runtimeSettings?: any;
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
    runtimeSettings?: any;
  }): Promise<{ changed: boolean; bytesFreed: number; rewrittenEntries: number; reason?: string }>;
  dispose?(): Promise<void>;
  getConversationStore?(): any;
  getSummaryStore?(): any;
}


/** Minimal wrapper that delegates to lossless-claw's inner engine.
 * Used when we access the engine via shared-init rather than factory registry. */
class MemorySupplementCtxEngine implements LosslessClawEngine {
  constructor(private inner: any) {}
  get info() { return this.inner.info; }
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
  async commitTurn(params: any): Promise<any> {
    return this.inner.commitTurn?.(params) ?? { status: 'committed' };
  }
  async assemble(params: any): Promise<any> {
    return this.inner.assemble?.(params) ?? { messages: params.messages ?? [], estimatedTokens: 0 };
  }
  async maintain(params: any): Promise<any> {
    return this.inner.maintain?.(params) ?? { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
  }
  getConversationStore(): any {
    return this.inner.getConversationStore?.();
  }
  getSummaryStore(): any {
    return this.inner.getSummaryStore?.();
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
  /** 同会话在途压缩去重（sessionKey → 标记）；防多轮 fire-and-forget compact 叠加打爆本地 LLM */
  private static readonly _inFlightCompactions = new Set<string>();

  /** 缓存的 engine 实例 */
  private engine: LosslessClawEngine | null = null;

  /** 当前状态 */
  private _connected = false;
  private _connecting: Promise<boolean> | null = null;
  private _initError: string | null = null;
  /** 是否已经尝试过连接（无论成功失败），用于防止重复日志 */
  private _connectionAttempted = false;
  /** Path 1 (Symbol registry) 返回的 factory 是否来自 read-only 注册（引擎未初始化），
   *  若为 true 则跳过 Path 1，走 Path 2/3/4 触发真正的引擎初始化 */
  private _skipPath1 = false;

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
    if (this._connectionAttempted) return false;
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect();
    return this._connecting;
  }

  /**
   * 指数退避重试连接 lossless-claw。
   *
   * 问题：lcm-graph-extra 的 ensureInitialized() 在 register() 阶段被
   * fire-and-forget 调用，此时 lossless-claw 插件可能尚未完成引擎初始化
   * （DB 迁移、引擎启动等），导致 shared state Map 为空，所有发现路径失败。
   *
   * 修复：在 _doConnect 内部以 1s/2s/4s/8s 指数退避重试最多 4 次，
   * 总耗时约 15s，给 lossless-claw 引擎初始化留出时间窗口。
   * 重试间隔远小于 5min 心跳间隔，不会影响用户体验。
   */
  private async _doConnect(): Promise<boolean> {
    const maxRetries = 4;
    const baseDelayMs = 1000;

    let lastError: string | null = null;
    let lastErrorDetail: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const factory = await this._discoverCEFactory();
        if (!factory) {
          lastError = 'lossless-claw CE factory not found in registry';
          lastErrorDetail = 'all discovery paths exhausted';
          if (attempt < maxRetries) {
            const delay = baseDelayMs * Math.pow(2, attempt);
            this.logger?.info?.(`[lcm] connect attempt ${attempt + 1}/${maxRetries + 1}: factory not found, retrying in ${delay}ms`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          break;
        }

        // 调用工厂获取已初始化的 engine 实例
        // factory 接收 factoryCtx: { config?, agentDir?, workspaceDir? }
        // lossless-claw 内部: () => shared.waitForEngine() 返回已初始化的单例
        // 加 60s 超时兜底，防止 waitForEngine() 永不 resolve 导致挂死
        const FACTORY_TIMEOUT_MS = 60_000;
        let factoryTimer: ReturnType<typeof setTimeout> | null = null;
        let engine: any;
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            factoryTimer = setTimeout(
              () => reject(new Error(`factory({}) timed out after ${FACTORY_TIMEOUT_MS}ms`)),
              FACTORY_TIMEOUT_MS,
            );
          });
          engine = await Promise.race([factory({}), timeoutPromise]);
        } finally {
          if (factoryTimer) clearTimeout(factoryTimer);
        }

        if (!engine) {
          lastError = 'lossless-claw factory returned null/undefined engine';
          lastErrorDetail = 'engine is null or undefined';
          this.logger?.warn?.(`[lcm] connect attempt ${attempt + 1}/${maxRetries + 1}: factory returned null/undefined engine`);
        } else if (typeof engine.compact !== 'function') {
          // 诊断：列出 engine 上实际有哪些 key，帮助定位为何 compact 缺失
          const keys = Object.keys(engine).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(engine)));
          const uniqueKeys = [...new Set(keys)].filter(k => k !== 'constructor');
          lastError = 'lossless-claw factory returned invalid engine (missing compact)';
          lastErrorDetail = `engine keys: [${uniqueKeys.join(', ')}]`;
          this.logger?.warn?.(`[lcm] connect attempt ${attempt + 1}/${maxRetries + 1}: engine missing compact, type=${typeof engine}, keys=[${uniqueKeys.join(', ')}]`);
          this.engine = null;
        } else {
          // 成功
          this.engine = engine;
          this._connected = true;
          this._connectionAttempted = true;
          this._connecting = null;
          this.logger?.info?.('[lcm] lossless-claw adapter connected successfully');
          return true;
        }
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        const errName = (err as Error).name ?? 'Error';
        lastError = errMsg;
        lastErrorDetail = `stack: ${(err as Error).stack?.substring(0, 200) ?? 'N/A'}`;
        this.logger?.warn?.(`[lcm] connect attempt ${attempt + 1}/${maxRetries + 1}: factory({}) threw ${errName}: ${errMsg}`);

        // 如果 lossless-claw 插件处于 read-only 注册模式（引擎未初始化），
        // 标记跳过 Path 1 (Symbol registry)，后续重试走 Path 2/3/4 触发真正的引擎初始化。
        // 同样地：factory({}) 抛任意错误（含 lossless-claw 内部 waitForEngine 重抛的
        // 已记录 initError——如 DB 锁导致的 deferred init 失败已固化进 shared init）时，
        // 重试同一条 Path 1 工厂必然再次抛同一错误，必须跳过 Path 1 让后续尝试走
        // Path 2 (cached engine) / Path 3 (fresh register) 恢复。
        const looksReadOnly = errMsg.includes('read-only') || errMsg.includes('disabled during');
        if (looksReadOnly || /typeerror|undefined\b/.test(errMsg)) {
          this._skipPath1 = true;
          this.logger?.info?.('[lcm] factory threw, marking Symbol registry factory broken, falling back to Path 2/3/4', { err: errMsg });
        }
      }

      // 走到这里说明本次尝试失败，若还有重试机会则等待后重试
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }

    this._initError = lastError ?? 'lossless-claw CE factory not found in registry';
    this._connected = false;
    this._connectionAttempted = true;
    this._connecting = null;
    this.logger?.warn?.('[lcm] lossless-claw adapter connection failed after all retries', {
      err: this._initError,
      detail: lastErrorDetail,
    });
    return false;
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
    runtimeSettings?: any;
    legacyCompactionParams?: Record<string, unknown>;
    sessionTarget?: Record<string, unknown>;
  }): Promise<void> {
    if (!this._connected || !this.engine) return;
    if (typeof this.engine.afterTurn !== 'function') return;
    try {
      const normalizedMessages = (params.messages ?? []).map(normalizeMessageContent);

      let normalizedParams: any = coerceSessionId({
        ...params,
        messages: normalizedMessages,
        prePromptMessageCount: params.prePromptMessageCount ?? 0,
      });

      // ── G-MODEL-SYNC（与 compact 对齐）：按会话主模型注入 LLM ──
      // lossless-claw 的 afterTurn（轮后维护 / 后台压缩）会调用 runtime.llm.complete。
      // 若原样透传 SDK 注入的 runtimeContext.llm（网关 127.0.0.1:18789），
      // 新版网关 /v1/chat/completions 需要鉴权 → 401 → 降级到备用远程模型。
      // 分支契约（resolveEngineLlmInjection）：本地模型 → 直连本地 complete；
      // 远程模型 → distillationLlm 配置；无法判定 → 不改动 params。
      // 覆盖三个读取位置（顶层 / runtimeContext / legacyCompactionParams）。
      try {
        const _inj = this.resolveEngineLlmInjection(params);
        if (_inj) {
          normalizedParams = {
            ...normalizedParams,
            llm: _inj.llm,
            runtimeContext: { ...(normalizedParams.runtimeContext ?? {}), llm: _inj.llm },
            legacyCompactionParams: { ...(normalizedParams.legacyCompactionParams ?? {}), llm: _inj.llm },
          };
          this.logger?.info?.('[lossless-claw-adapter] afterTurn llm injection', {
            source: _inj.source,
            model: _inj.model,
            baseURL: _inj.baseURL ?? null,
          });
        }
      } catch (lcInjectErr) {
        this.logger?.warn?.('[lossless-claw-adapter] afterTurn llm injection failed, using default', {
          err: lcInjectErr instanceof Error ? lcInjectErr.message : String(lcInjectErr),
        });
      }

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
    runtimeSettings?: any;
  }): Promise<{ bootstrapped: boolean; importedMessages: number; reason?: string }> {
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
        if (existing && existing.bootstrappedAt) {
          // Already bootstrapped, no-op
          return { bootstrapped: true, importedMessages: 0 };
        }
      } catch (e) {
        // Fallback: 直接调用 bootstrap（幂等）
        this.logger?.debug?.("[lossless-claw-adapter] bootstrap status check failed, falling back to direct call", { err: e instanceof Error ? e.message : String(e) });
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
   * G-MODEL-SYNC 统一注入判定：按会话主模型决定压缩/轮后维护使用的 LLM。
   *
   * 分支（用户契约："本地模型复用本地模型，非本地模型用配置数据"）：
   *  1. 本地模型（会话快照命中，或未记录时回退活跃快照/按模型名解析）：
   *     → 注入直连本地的自建 complete（真实端点 + keep_alive，绕开网关 401/404）
   *  2. 远程模型（isSessionRemoteModel 已标记）：→ 注入 distillationLlm 配置的
   *     complete，不复用其他会话的本地快照（防跨会话串用），也不透传 SDK
   *     网关 llm
   *  3. 无法判定：返回 null，调用方不改动 params（lossless-claw 用自身配置）
   *
   * @returns 注入用的 llm 对象与描述；null 表示不注入
   */
  private resolveEngineLlmInjection(params: any): {
    llm: { complete: (p: any) => Promise<any> };
    source: 'local-snapshot' | 'active-local' | 'model-resolve' | 'configured';
    model: string;
    baseURL?: string | null;
  } | null {
    const _sk = (typeof params.sessionKey === 'string' && params.sessionKey.trim())
      ? params.sessionKey.trim()
      : (typeof params.session_id === 'string' ? params.session_id.trim() : '');

    // ① 本会话已判定为远程 → 用插件配置（不回退活跃本地快照，防跨会话串用）
    if (_sk && isSessionRemoteModel(_sk)) {
      try {
        const cfg = resolveConfiguredDistillationLlm();
        if (cfg?.model && cfg?.baseURL) {
          return {
            llm: { complete: buildConfiguredLlmComplete(cfg) },
            source: 'configured',
            model: cfg.model,
            baseURL: cfg.baseURL,
          };
        }
      } catch { /* 配置解析失败，继续走兜底 */ }
      return null;
    }

    // ② 本地快照：优先本会话；无 sessionKey 或尚未记录（首轮前）时回退活跃本地模型
    let _snap = _sk
      ? (getSessionLlmSnapshot(_sk) ?? getActiveLocalLlmSnapshot())
      : getActiveLocalLlmSnapshot();
    if (_snap?.model) {
      return {
        llm: { complete: buildLocalLlmComplete(_snap) },
        source: _sk && getSessionLlmSnapshot(_sk) ? 'local-snapshot' : 'active-local',
        model: _snap.model,
        baseURL: _snap.baseURL,
      };
    }

    // ③ 无快照但本次携带了本地 agent 模型名 → 按模型名 + provider 配置解析
    _snap = resolveLocalSnapshotForModel((params as any).model, (params as any).baseURL);
    if (_snap?.model) {
      return {
        llm: { complete: buildLocalLlmComplete(_snap) },
        source: 'model-resolve',
        model: _snap.model,
        baseURL: _snap.baseURL,
      };
    }

    // ④ 非本地（模型名可判定远程）→ 插件配置；否则不注入
    const _model = typeof (params as any).model === 'string' ? (params as any).model : '';
    if (_model && !isOllamaModel(_model)) {
      try {
        const cfg = resolveConfiguredDistillationLlm();
        if (cfg?.model && cfg?.baseURL) {
          return {
            llm: { complete: buildConfiguredLlmComplete(cfg) },
            source: 'configured',
            model: cfg.model,
            baseURL: cfg.baseURL,
          };
        }
      } catch { /* fallthrough */ }
    }
    return null;
  }

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
    runtimeSettings?: any;
    legacyParams?: any;
    runtimeModelOverride?: string;
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

    // ── 在途去重：同一会话已有 compact 在跑时直接跳过 ──
    // 背景：assemble 预压缩 / medium-tier / S-9 主题切换 / hooks 压力响应都是
    // fire-and-forget backgroundTasks，连续多轮触发会对同一 session 叠加多个
    // compact。每个 compact 内部要跑 LLM 摘要，本地 Ollama 串行排队时这些任务
    // 互相挤压 + 与主模型生成争抢 → 主生成 stall（"stopped making progress"）。
    // 去重后同 session 最多一个在途 compact；跳过是安全的——已在跑的那个会
    // 完成本轮需要的压缩（force 压缩除外，见下方 force 直通）。
    const _dedupSk = (typeof params.sessionKey === 'string' && params.sessionKey.trim())
      || (typeof params.sessionId === 'string' && params.sessionId.trim())
      || '';
    if (_dedupSk && !params.force) {
      if (LosslessClawAdapter._inFlightCompactions.has(_dedupSk)) {
        this.logger?.info?.('[lossless-claw-adapter] compact skipped: another compaction already in flight for session', {
          sessionKey: _dedupSk,
        });
        return { ok: true, compacted: false, reason: 'already_in_flight' };
      }
      LosslessClawAdapter._inFlightCompactions.add(_dedupSk);
    }
    const _dedupHeld = _dedupSk && !params.force;

    // ── G-MODEL-SYNC: 按会话主模型决定 lossless-claw 压缩使用的 LLM ──
    // 统一在此注入，覆盖所有 compact 调用方（/compact 主路径、assemble 预压缩、
    // S-9 主题切换、hooks 压力响应等），避免每处重复实现。
    // 分支契约（resolveEngineLlmInjection）：
    //  - 本地模型 → 自建 llm.complete 直连本地端点（keep_alive，绕开网关 401/404）
    //  - 远程模型 → distillationLlm 配置的模型与地址（不复用其他会话的本地快照）
    //  - 无法判定 → 不改动 params，lossless-claw 回退到其自身 LLM 配置。
    // 自建 complete 绕过 OpenClaw SDK 对 llm.allowModelOverride 的策略检查（我们自行 fetch）。
    try {
      const _inj = this.resolveEngineLlmInjection(params);
      if (_inj) {
        const _lcRt = { ...((params as any).runtimeContext ?? {}), llm: _inj.llm };
        const _lcLg = { ...((params as any).legacyParams ?? {}), llm: _inj.llm };
        params = {
          ...params,
          runtimeContext: _lcRt,
          legacyParams: _lcLg,
          runtimeModelOverride: _inj.model,
        };
        this.logger?.info?.('[lossless-claw-adapter] compact llm injection', {
          source: _inj.source,
          model: _inj.model,
          baseURL: _inj.baseURL ?? null,
        });
      }
    } catch (lcInjectErr) {
      this.logger?.warn?.('[lossless-claw-adapter] compact llm injection failed, using default', {
        err: lcInjectErr instanceof Error ? lcInjectErr.message : String(lcInjectErr),
      });
    }

    try {
      // Call lossless-claw's compact engine
      // BUGFIX(P0-3): compact 是唯一 throw 的调用，若 lossless-claw 内部挂起
      // （如 LLM 摘要请求无响应、replay 死锁），调用方将无限等待。
      // 用 Promise.race 加超时兜底：默认 300s，可通过 LCMG_COMPACT_TIMEOUT_MS 覆盖。
      // 超时后返回 { ok:false, reason:'timeout' } 而非 throw，与 catch 分支行为一致.
      this.logger?.info?.('[lossless-claw-adapter] compact start', {
        sessionId: params.sessionId,
        tokenBudget: params.tokenBudget,
        force: params.force,
        compactionTarget: params.compactionTarget,
        currentTokenCount: params.currentTokenCount,
      });
      const compactTimeoutMs = (() => {
        const raw = process.env.LCMG_COMPACT_TIMEOUT_MS;
        if (raw) { const n = Number(raw); if (Number.isFinite(n) && n > 0) return n; }
        return 300_000; // 5min 默认上限
      })();
      let compactTimer: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        compactTimer = setTimeout(
          () => reject(new Error(`compact timeout after ${compactTimeoutMs}ms`)),
          compactTimeoutMs,
        );
      });
      let lcResult: any;
      try {
        lcResult = await Promise.race([this.engine.compact(params), timeoutPromise]);
      } finally {
        if (compactTimer) clearTimeout(compactTimer);
      }

      this.logger?.info?.('[lossless-claw-adapter] compact engine returned', {
        ok: lcResult?.ok,
        compacted: lcResult?.compacted,
        reason: lcResult?.reason,
        summaryId: lcResult?.summaryId,
        exhausted: lcResult?.exhausted,
        resultTokensBefore: lcResult?.result?.tokensBefore,
        resultTokensAfter: lcResult?.result?.tokensAfter,
      });

      // Map CompactResult (openclaw-bridge) to lcm-graph-extra expected format:
      // engine returns: { ok, compacted, reason, result: { tokensBefore, tokensAfter, details }, exhausted }
      // adapter must forward this correctly so index.ts handler can detect success
      const actionTaken = lcResult.compacted === true;
      const createdSummaryId = lcResult.summaryId;
      const tokensInfo = lcResult.result ?? {};

      let summaryContent: string | undefined;
      // 当 compaction 执行后（无论是否创建了新摘要），都尝试获取最新的摘要内容。
      // 场景：DAG 已在之前压缩过，本次 compact 未生成新摘要（createdSummaryId=null），
      // 但 SDK 仍需要 summary 来更新上下文。此时获取已有摘要返回给 SDK。
      if (actionTaken) {
        try {
          // Use the correct DAG API: SummaryStore.getContextItems + getSummary
          // (NOT convStore.listSummaries which does not exist on ConversationStore)
          const summaryStore = this.engine.getSummaryStore?.();
          if (summaryStore && typeof summaryStore.getContextItems === 'function') {
            const convStore = this.engine.getConversationStore?.();
            const conversation = await convStore?.getConversationForSession?.({ sessionId: params.sessionId });
            if (conversation) {
              const contextItems = await summaryStore.getContextItems(conversation.conversationId);
              const summaryItems = (contextItems ?? [])
                .filter((item: any) => item.itemType === 'summary' && item.summaryId)
                .slice(-1);
              for (const item of summaryItems) {
                if (typeof summaryStore.getSummary === 'function') {
                  const s = await summaryStore.getSummary(item.summaryId);
                  if (s) {
                    summaryContent = s.content;
                    break;
                  }
                }
              }
            }
          }
          if (summaryContent) {
            this.logger?.info?.('[lossless-claw-adapter] summary fetched', {
              createdNewSummary: !!createdSummaryId,
              summaryLength: summaryContent?.length ?? 0,
              summaryPreview: summaryContent?.substring(0, 100),
            });
          }
        } catch (e) {
          this.logger?.debug?.("[lossless-claw-adapter] summary content fetch failed, using summary ID as indicator", { err: e instanceof Error ? e.message : String(e) });
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
          // SDK CompactResult.result 期望的可选字段透传（lossless-claw 提供）
          firstKeptEntryId: tokensInfo.firstKeptEntryId,
          sessionId: tokensInfo.sessionId,
          sessionFile: tokensInfo.sessionFile,
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
    } finally {
      // 在途去重标记释放：无论成功/失败/超时都必须释放，否则该会话永久无法再压缩
      if (_dedupHeld) LosslessClawAdapter._inFlightCompactions.delete(_dedupSk);
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

  /** 透传给 lossless-claw 的 commitTurn（OpenClaw durable-turn 逻辑轮提交） */
  async commitTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: any; // SDK: ContextEngineSessionTarget
    advancementKey: string;
    admission: any;
    terminal: any; // SDK: TranscriptEntryAnchor
    messages: any[];
    runtimeContext?: Record<string, unknown>;
    runtimeSettings?: any;
    isHeartbeat?: boolean;
  }): Promise<{ status: 'committed' | 'duplicate'; committedAt?: string }> {
    if (!this._connected || !this.engine || typeof this.engine.commitTurn !== 'function') {
      // 无下游契约（旧版 lossless-claw）时乐观提交，交由上层 CE 幂等去重兜底
      return { status: 'committed' };
    }
    try {
      const normalizedMessages = (params.messages ?? []).map(normalizeMessageContent);
      const normalizedParams = coerceSessionId({ ...params, messages: normalizedMessages });
      const result: any = await this.engine.commitTurn(normalizedParams);
      // lossless-claw 1.0.0 兼容：内层 commitTurn resolve 即持久化成功，但可能
      // 不按契约返回 status 字段（返回 void / 其他形状）。此处规范化为
      // { status: 'committed' }，避免上层 CE 判定 indeterminate 抛错、host
      // 无限重试并逐轮降级 legacy 引擎。
      if (result && (result.status === 'committed' || result.status === 'duplicate')) {
        return result;
      }
      this.logger?.warn?.('[lossless-claw-adapter] commitTurn: inner engine resolved without status, normalizing to committed', {
        resultShape: result == null ? 'nullish' : Object.keys(result).join(','),
      });
      return { status: 'committed' };
    } catch (err) {
      this.logger?.warn?.('[lossless-claw-adapter] commitTurn failed', { err: serializeError(err) });
      return { status: 'committed' };
    }
  }

  /** 透传给 lossless-claw 的 maintain */
  async maintain(params: {
    sessionId: string;
    sessionFile: string;
    sessionKey?: string;
    sessionTarget?: any; // SDK: ContextEngineSessionTarget
    runtimeContext?: Record<string, unknown>;
    runtimeSettings?: any;
    /** SDK 2026.8.1：host 在 stop/shutdown 时 abort，下游应在中止时及时停止维护工作 */
    abortSignal?: AbortSignal;
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

  async getSummaries(sessionId: string, limit: number = 1): Promise<Array<{ summaryId: string; content: string; tokenCount: number; earliestAt: string | null; latestAt: string | null; entryCount: number; startOrdinal: number | null }>> {
    if (!this._connected || !this.engine) {
      return [];
    }
    try {
      // Step 1: Resolve sessionId → conversationId via ConversationStore
      const convStore = this.engine.getConversationStore?.();
      if (!convStore || typeof convStore.getConversationForSession !== 'function') {
        return [];
      }
      const conversation = await convStore.getConversationForSession({ sessionId });
      if (!conversation) {
        return [];
      }

      // Step 2: Get context items from SummaryStore (the correct DAG API)
      const summaryStore = this.engine.getSummaryStore?.();
      if (!summaryStore || typeof summaryStore.getContextItems !== 'function') {
        return [];
      }
      const contextItems = await summaryStore.getContextItems(conversation.conversationId);

      // Step 3: Filter for summary items, get newest ones (highest ordinal last).
      const summaryItemPairs = (contextItems ?? [])
        .filter((item: any) => item.itemType === 'summary' && item.summaryId)
        .slice(-limit)
        .map((item: any) => ({ item, summaryId: item.summaryId }));

      // Step 4: Fetch summary content for each summary item
      const result: Array<{ summaryId: string; content: string; tokenCount: number; earliestAt: string | null; latestAt: string | null; entryCount: number; startOrdinal: number | null }> = [];
      for (const { item, summaryId } of summaryItemPairs) {
        if (typeof summaryStore.getSummary !== 'function') continue;
        const summary = await summaryStore.getSummary(summaryId);
        if (summary) {
          const earliestAtVal = summary.earliestAt instanceof Date
            ? summary.earliestAt.toISOString()
            : (summary.earliestAt ?? null);
          const latestAtVal = summary.latestAt instanceof Date
            ? summary.latestAt.toISOString()
            : (summary.latestAt != null ? String(summary.latestAt) : null);
          const entryCountVal = typeof item.entryCount === 'number' ? item.entryCount
            : typeof summary.entryCount === 'number' ? summary.entryCount
            : 0;
          // BUGFIX: 提取 DAG context item 的 ordinal，用于构建精确的时序段列表。
          // 修复前：仅有 entryCount，无法知道 summary 在消息序列中的确切位置，
          // 只能假定所有未压缩消息都在末尾，导致 summary+raw 无法按实际时序交错排列。
          const startOrdinalVal = typeof item.ordinal === 'number' ? item.ordinal
            : typeof item.startOrdinal === 'number' ? item.startOrdinal
            : null;
          result.push({
            summaryId: summary.summaryId ?? '',
            content: summary.content ?? '',
            tokenCount: summary.tokenCount ?? 0,
            earliestAt: earliestAtVal,
            latestAt: latestAtVal,
            entryCount: entryCountVal,
            startOrdinal: startOrdinalVal,
          });
        }
      }
      return result;
    } catch (e) {
      this.logger?.debug?.('[lossless-claw-adapter] getSummaries failed', { err: e instanceof Error ? e.message : String(e), sessionId });
      return [];
    }
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
    this._connectionAttempted = false;
    this._initError = null;
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
    if (this._skipPath1) {
      this.logger.info("[lcm] path 1/4: SKIPPED (Symbol registry factory is read-only, engine not initialized)");
    } else {
      this.logger.debug("[lcm] path 1/4: Primary Symbol registry");
      try {
        const state: Record<string, any> | undefined =
          (globalThis as any)[CONTEXT_ENGINE_REGISTRY_STATE];
        if (state?.engines instanceof Map) {
          const entry = state.engines.get('lossless-claw');
          if (entry && typeof entry.factory === 'function') {
            this.logger.info("[lcm] _discoverCEFactory: path 1/4 SUCCESS (Symbol registry)");
            return entry.factory as (ctx: any) => Promise<LosslessClawEngine>;
          }
        }
      } catch (e) {
        // Symbol 方式失败，走 Fallback
        this.logger?.debug?.("[lcm] _discoverCEFactory: path 1/4 Symbol registry failed", { err: e instanceof Error ? e.message : String(e) });
      }
      this.logger.debug("[lcm] _discoverCEFactory: path 1/4 FAILED (Symbol registry)");
    }

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
            this.logger.info("[lcm] _discoverCEFactory: path 2/4 SUCCESS (Shared State, cached engine)");
            return async () => new MemorySupplementCtxEngine(engine);
          }
          // Engine not ready yet, try waitForEngine
          const waitFn = init.waitForEngine;
          if (typeof waitFn === 'function') {
            this.logger.info("[lcm] _discoverCEFactory: path 2/4 SUCCESS (Shared State, waitForEngine)");
            return async () => {
              const e = await waitFn();
              return new MemorySupplementCtxEngine(e);
            };
          }
        }
      }
      this.logger.debug("[lcm] _discoverCEFactory: path 2/4 FAILED (Shared State)");
    } catch (e) {
      // shared state not available, continue
      this.logger?.debug?.("[lcm] _discoverCEFactory: path 2/4 Shared State failed", { err: e instanceof Error ? e.message : String(e) });
    }
    this.logger.debug("[lcm] path 3/4: Direct FS scan");

    // ── Direct FS: 扫描 projects/ 找 lossless-claw dist，import 触发初始化 ──
    // P0-4 SEC-2: 加路径白名单校验。任何能写入 ~/.openclaw/npm/projects/*/node_modules
    // 的进程可注入任意代码并经 pluginEntry.register(mockApi) 执行。此处严格校验：
    //   1) entry.name 必须是安全的目录名（无路径分隔符、无 ..）
    //   2) candidatePath 必须仍在 projectsDir 之下（防路径穿越，使用原始路径而非 realpath，
    //      因为 npm scoped packages 的 node_modules 常为符号链接，realpath 会解析到
    //      全局缓存目录，导致误判）
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
          // 安全校验：原始路径必须在 projectsDir 内（不使用 realpath，
          // 因为 node_modules 中的 scoped packages 可能是符号链接）
          const sep = candidatePath.includes('/') ? '/' : '\\';
          if (!candidatePath.startsWith(projectsDir + sep) && candidatePath !== projectsDir) {
            this.logger.debug(`[lcm] _discoverCEFactory: reject path escaping projectsDir: ${candidatePath}`);
            continue;
          }

          // 使用 realpath 验证文件存在并解析符号链接，获取实际路径用于 import
          let realCandidatePath: string;
          try {
            realCandidatePath = await realpath(candidatePath);
          } catch {
            // 文件不存在，跳过
            continue;
          }

          const lcModule = await import(pathToFileURL(realCandidatePath).href);
          // dist/index.js default export is the plugin entry with register()
          const pluginEntry = lcModule.default;
          if (pluginEntry && typeof pluginEntry.register === 'function') {
            // 构建更完整的 mockApi，让 lossless-claw 能正确初始化 DB 和引擎。
            // 修复前：getConfig() 返回 {} 导致 DB path 无法解析，引擎初始化失败。
            // 修复后：从环境变量和常见路径推断 workspace/agent 目录，提供合理的默认配置。
            const home = homedir();
            const openclawDir = process.env.OPENCLAW_DIR || join(home, '.openclaw');
            const mockApi: Record<string, any> = {
              getConfig: () => ({
                // 默认 DB 路径：~/.openclaw/data/lossless-claw.db
                dbPath: join(openclawDir, 'data', 'lossless-claw.db'),
              }),
              getRuntimeInfo: () => ({
                version: process.env.OPENCLAW_VERSION || '2026.5.28',
                mode: 'direct-fs',
                workspaceDir: process.env.OPENCLAW_WORKSPACE || home,
                agentDir: process.env.OPENCLAW_AGENT_DIR || join(openclawDir, 'agent'),
                dataDir: join(openclawDir, 'data'),
              }),
              // P0-FIX: lossless-claw 1.0.0 的 register() 会读取 api.runtime.llm.complete
              // （getRuntimeLlm）与 api.runtime.config（readRuntimeConfigSnapshot）。
              // 之前 mock 缺 runtime 字段 → getRuntimeLlm 抛 "Cannot read properties of
              // undefined (reading 'llm')" → Path 3 的新鲜 register 恢复路径永远失败。
              // 补上无副作用的最小 runtime 桩：llm.complete 为 no-op，config.current()
              // 返回空配置快照（readRuntimeModelContext 等读取均为防御式，缺字段安全）。
              runtime: {
                llm: {
                  complete: async () => ({ role: 'assistant', content: '' }),
                },
                config: {
                  current: () => ({ models: { providers: {} }, agents: { defaults: {} }, plugins: { entries: {} } }),
                },
              },
              // pluginConfig 供 lossless-claw 读取自身配置
              pluginConfig: {},
              registerContextEngine: (_id: string, _fn: Function) => {},
              registerTool: () => {},
              registerCommand: () => {},
              on: () => {},
              logger: this.logger,
            };
            // register() 返回 void 但内部会同步设置 shared-init state
            pluginEntry.register(mockApi);

            // Re-check shared state after plugin init
            const retryShared: Map<string, any> | undefined =
              (globalThis as any)[SHARED_INIT_STATE];
            if (retryShared instanceof Map && retryShared.size > 0) {
              for (const init of retryShared.values()) {
                const engine = init.getCachedEngine?.();
                if (engine) {
                  this.logger.info("[lcm] path 3/4: found cached engine via shared state");
                  return async () => new MemorySupplementCtxEngine(engine);
                }
                const waitFn = init.waitForEngine;
                if (typeof waitFn === 'function') {
                  this.logger.info("[lcm] path 3/4: found waitForEngine via shared state");
                  return async () => {
                    const e = await waitFn();
                    return new MemorySupplementCtxEngine(e);
                  };
                }
              }
            }
            this.logger.debug("[lcm] path 3/4: pluginEntry.register() called but shared state is empty or missing engine");
          }
        } catch (e) {
          // candidate not found or import failed
          this.logger?.debug?.("[lcm] _discoverCEFactory: path 3/4 candidate not found or import failed", { err: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      // projects dir scan failed, fall through to Fallback
      this.logger?.debug?.("[lcm] _discoverCEFactory: path 3/4 projects dir scan failed", { err: e instanceof Error ? e.message : String(e) });
    }
    this.logger.debug("[lcm] path 4/4: Fallback registry");

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
      this.logger.info("[lcm] _discoverCEFactory: all 4 discovery paths exhausted, lossless-claw not reachable (will retry if configured)");
      return null;
    }

    this.logger.info("[lcm] _discoverCEFactory: path 4/4 SUCCESS, found factory via fallback registry");
    return factory as (ctx: any) => Promise<LosslessClawEngine>;
  }
}

// ---------------------------------------------------------------------------
// 进程级单例
// ---------------------------------------------------------------------------

/**
 * OpenClaw 会为每个 worker/agent 上下文调用一次 register()，
 * 每个 register() 闭包创建独立的 LosslessClawAdapter 实例，
 * 导致 "lossless-claw adapter connection failed" 日志重复 4 次。
 *
 * 此处提供进程级单例，确保同一进程中只创建一个适配器实例，
 * connect() 只执行一次，日志只输出一次。
 */
let _sharedAdapter: LosslessClawAdapter | null = null;

export function getOrCreateLosslessClawAdapter(logger?: any): LosslessClawAdapter {
  if (!_sharedAdapter) {
    _sharedAdapter = new LosslessClawAdapter(logger);
  }
  return _sharedAdapter;
}

/**
 * 重置进程级单例，允许 dispose 后重新创建 adapter 实例。
 * 应在 index.ts 的 dispose 闭包中调用，确保热重载后能重新连接。
 */
export function resetSharedAdapter(): void {
  _sharedAdapter = null;
}
