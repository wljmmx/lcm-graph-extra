/**
 * lossless-claw Adapter
 *
 * 中间层适配器，通过内部 CE 注册表获取 lossless-claw 的 ContextEngine 实例，
 * 以受控方式调用其 DAG 压缩能力（compact）。
 *
 * 设计原则：
 * - lossless-claw 不作为活跃 CE 使用，其 CE factory 在插件加载时已写入注册表
 * - 适配器通过文件系统动态发现 openclaw 内部 registry 模块路径
 * - 使用 Node.js ES 模块单例机制，获取同一个已初始化的 engine 实例
 * - 调用失败时优雅降级，不阻塞主流程
 *
 * @module middleware/lossless-claw-adapter
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface LosslessClawCompactParams {
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
}

interface LosslessClawCompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: any;
}

/** lossless-claw 的 ContextEngine 最小接口 */
interface LosslessClawEngine {
  compact(params: LosslessClawCompactParams): Promise<LosslessClawCompactResult>;
  dispose?: () => Promise<void>;
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
      // factory 内部: () => shared.getCachedEngine() ?? shared.waitForEngine()
      // shared.getCachedEngine() 返回 gateway_start 时初始化的实例
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

  // ── 核心能力：DAG 压缩 ──

  /**
   * 调用 lossless-claw 的 DAG 压缩。
   *
   * @throws {Error} 如果未连接
   */
  async compact(params: LosslessClawCompactParams): Promise<LosslessClawCompactResult> {
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
   * 通过文件系统动态发现 openclaw 内部 CE 注册表模块，
   * 调用 getContextEngineFactory("lossless-claw") 获取 factory。
   *
   * 原理：
   *   1. 解析 openclaw/plugin-sdk 获取 plugin-sdk/index.js 的路径
   *   2. 读取文件内容，发现 import 语句中的 registry 模块哈希文件名
   *   3. 动态导入 registry 模块（Node.js ES module 单例）
   *   4. 调用 getContextEngineFactory("lossless-claw")
   */
  private async _discoverCEFactory():
    Promise<((ctx: any) => Promise<LosslessClawEngine>) | null>
  {
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
    const distDir = dirname(dirname(sdkPath)); // /openclaw/dist/plugin-sdk/ → /openclaw/dist/
    const registryPath = join(distDir, importMatch[1]);

    // Step 4: 动态导入 registry 模块
    // Node.js 缓存 ES 模块，确保用同一个单例
    const regModule: Record<string, any> = await import(pathToFileURL(registryPath).href);
    if (!regModule || typeof regModule !== 'object') {
      throw new Error(`Invalid registry module: ${importMatch[1]}`);
    }

    // Step 5: 获取 getContextEngineFactory 函数
    // 内部导出: getContextEngineFactory as n
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

    // factory 存在说明 lossless-claw 已安装并注册了 CE
    // factory 不存在说明 lossless-claw 未安装
    if (typeof factory !== 'function') {
      return null;
    }

    return factory as (ctx: any) => Promise<LosslessClawEngine>;
  }
}
