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
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** OpenClaw 内部 CE 注册表全局单例的 Symbol key */
const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for('openclaw.contextEngineRegistryState');

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** lossless-claw 暴露的完整 ContextEngine 接口（最小子集） */
interface LosslessClawEngine {
  info?: { id: string; name: string; version: string };
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
    [key: string]: any;
  }): Promise<void>;
  bootstrap?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    messages?: any[];
  }): Promise<{ bootstrapped: boolean; importedMessages: number }>;
  maintain?(params: {
    sessionId: string;
    sessionFile: string;
    sessionKey?: string;
    runtimeContext?: any;
  }): Promise<{ changed: boolean; bytesFreed: number; rewrittenEntries: number }>;
  dispose?(): Promise<void>;
  getConversationStore?(): any;
  getSummaryStore?(): any;
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
      // Normalize message content before passing to lossless-claw engine
      const msg = params.message;
      if (msg && Array.isArray(msg.content)) {
        const normalizedContent = msg.content
          .filter((c) => typeof c === 'string' || (typeof c === 'object' && c !== null && 'text' in c))
          .map((c) => (typeof c === 'string' ? c : String(c.text ?? '')))
          .join('
');
        const normalizedParams = { ...params, message: { ...msg, content: normalizedContent } };
        return await this.engine.ingest(normalizedParams);
      }
      if (msg && typeof msg.content !== 'string') {
        const normalizedParams = { ...params, message: { ...msg, content: String(msg.content ?? '') } };
        return await this.engine.ingest(normalizedParams);
      }
      return await this.engine.ingest(params);
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
      const normalizedMessages = (params.messages ?? []).map((msg) => {
        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content
              .filter((c) => typeof c === 'string' || (typeof c === 'object' && c !== null && 'text' in c))
              .map((c) => (typeof c === 'string' ? c : String(c.text ?? '')))
              .join('
'),
          };
        }
        if (typeof msg.content !== 'string') {
          return { ...msg, content: String(msg.content ?? '') };
        }
        return msg;
      });

      const normalizedParams = {
        ...params,
        messages: normalizedMessages,
      };

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
    [key: string]: any;
  }): Promise<void> {
    if (!this._connected || !this.engine) return;
    if (typeof this.engine.afterTurn !== 'function') return;
    try {
      await this.engine.afterTurn(params);
    } catch {
      // 非关键路径，忽略错误
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
      return await this.engine.bootstrap(params);
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
  }> {
    if (!this._connected || !this.engine) {
      throw new Error('LosslessClawAdapter: not connected, cannot compact');
    }
    return this.engine.compact(params);
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
      return null;
    }

    return factory as (ctx: any) => Promise<LosslessClawEngine>;
  }
}
