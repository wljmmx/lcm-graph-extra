/**
 * 统一日志层 (P3-A)
 *
 * 设计目标：
 *   1. 统一全项目的日志风格 —— 优先使用 logger，禁止生产代码直接 console.*
 *   2. 分级管理 (DEBUG/INFO/WARN/ERROR/SILENT)，可通过环境变量 LOG_LEVEL 控制
 *   3. 优雅降级 —— 宿主未注入 logger 时使用 noopLogger（不污染宿主控制台）
 *   4. 全局单例 —— 供 retrieval-gateway、qmd-client 等无 constructor 注入路径的模块使用
 *
 * 使用约定：
 *   - 宿主注入路径 (index.ts init)：`setGlobalLogger(api.logger ?? createLogger())`
 *   - constructor 注入模块：`constructor(logger?: Logger)` + `this.logger = logger ?? noopLogger`
 *   - 无注入路径：`const logger = getGlobalLogger()`
 *   - 替换 console.*：console.warn(x) → logger.warn(x)；console.debug(x) → logger.debug(x)
 */

// ─── LogLevel ────────────────────────────────────────────────────────────────

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  SILENT = 100,
}

/**
 * 从环境变量 LOG_LEVEL 解析级别。支持名称 (debug/info/warn/error/silent) 与数字。
 * 解析失败或未设置时返回默认值 INFO。
 */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = LogLevel.INFO): LogLevel {
  if (!value) return fallback;
  const lower = value.trim().toLowerCase();
  switch (lower) {
    case 'debug': return LogLevel.DEBUG;
    case 'info': return LogLevel.INFO;
    case 'warn':
    case 'warning': return LogLevel.WARN;
    case 'error': return LogLevel.ERROR;
    case 'silent':
    case 'off':
    case 'none': return LogLevel.SILENT;
    default: {
      const n = Number(lower);
      if (!isNaN(n) && Object.values(LogLevel).includes(n)) return n as LogLevel;
      return fallback;
    }
  }
}

// ─── Logger 接口 ─────────────────────────────────────────────────────────────

/**
 * 统一 Logger 接口。与 pino/openclaw api.logger 形态兼容（debug/info/warn/error + 可选 ctx）。
 * 所有模块的 logger 类型应收敛到本接口，禁止使用 `any`。
 */
export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  /** 可选：pino child logger 支持，便于按模块/会话隔离日志 */
  child?(bindings: Record<string, unknown>): Logger;
}

// ─── noopLogger ──────────────────────────────────────────────────────────────

/**
 * 静默 Logger。所有调用都是 no-op。
 * 用作未注入 logger 时的默认值（避免污染宿主控制台，避免 `logger?.warn?.()` 防御链）。
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── ConsoleLogger ───────────────────────────────────────────────────────────

/**
 * 基于控制台的 Logger 实现，按级别过滤输出。
 * - ERROR/WARN → stderr（不干扰 stdout 管道）
 * - INFO/DEBUG → stdout
 *
 * 主要用于独立运行（测试、CLI、未注入 api.logger 的场景）。
 * 生产环境由宿主注入 pino logger，本实现仅作 fallback。
 */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly prefix: string;

  constructor(level: LogLevel = parseLogLevel(process.env.LOG_LEVEL), prefix = '[lcm-graph-extra]') {
    this.level = level;
    this.prefix = prefix;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) this.emit('debug', msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) this.emit('info', msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    if (this.level <= LogLevel.WARN) this.emit('warn', msg, ctx);
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    if (this.level <= LogLevel.ERROR) this.emit('error', msg, ctx);
  }

  private emit(method: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>): void {
    const line = ctx ? `${this.prefix} ${msg} ${JSON.stringify(ctx)}` : `${this.prefix} ${msg}`;
    if (method === 'error' || method === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

/**
 * 创建 Logger 实例。优先用环境变量 LOG_LEVEL，未设置时用传入级别（默认 INFO）。
 */
export function createLogger(level?: LogLevel, prefix?: string): Logger {
  return new ConsoleLogger(level, prefix);
}

// ─── 全局 Logger 单例 ─────────────────────────────────────────────────────────

let _globalLogger: Logger | null = null;

/**
 * 设置全局 Logger。在插件 init 时由 index.ts 调用：
 *   `setGlobalLogger(api.logger ?? createLogger())`
 */
export function setGlobalLogger(logger: Logger): void {
  _globalLogger = logger;
}

/**
 * 获取全局 Logger。若未设置，返回 noopLogger（不抛错，不污染控制台）。
 *
 * 供 retrieval-gateway、qmd-client、tools 等无 constructor 注入路径的模块使用。
 */
export function getGlobalLogger(): Logger {
  return _globalLogger ?? noopLogger;
}

/**
 * 解析 logger：优先用传入的 logger，否则降级到 globalLogger，再否则 noopLogger。
 *
 * 用于 constructor 接受可选 logger 的模块：
 *   `this.logger = resolveLogger(logger)`
 */
export function resolveLogger(logger?: Logger | null): Logger {
  if (logger && typeof logger === 'object' && typeof (logger as Logger).info === 'function') {
    return logger as Logger;
  }
  return getGlobalLogger();
}

/**
 * 适配任意"类 logger"对象（如宿主 api.logger 可能是 pino，方法签名略不同）为统一 Logger。
 * 容错处理：
 *   - 方法缺失时降级到 noop
 *   - ctx 参数可选（pino 接受对象第一参，本接口第二参）
 */
export function adaptLogger(raw: any): Logger {
  if (!raw || typeof raw !== 'object') return noopLogger;
  const safe = (m: string) => (typeof (raw as any)[m] === 'function' ? (raw as any)[m].bind(raw) : () => {});
  return {
    debug: safe('debug'),
    info: safe('info'),
    warn: safe('warn'),
    error: safe('error'),
    child: typeof raw.child === 'function' ? (b: Record<string, unknown>) => adaptLogger(raw.child(b)) : undefined,
  };
}

// ─── Error 序列化 ─────────────────────────────────────────────────────────────

/**
 * 将 Error 对象序列化为可 JSON 化的普通对象。
 *
 * 问题背景：JSON.stringify(new Error('msg')) 输出 "{}"，
 * 因为 Error 的 message/stack/name 是不可枚举属性。
 * 这导致 logger.error('compact failed', { err }) 的日志输出 {"err":{}}，
 * 真正的错误信息被完全吞掉，运维无法定位问题。
 *
 * 本函数提取 Error 的关键信息到可枚举的普通对象：
 *   - message: 错误消息
 *   - name: 错误类型（Error / TypeError / RangeError 等）
 *   - stack: 调用栈（截断到前 2000 字符避免日志爆炸）
 *   - code: 错误码（如 ENOENT、SQLITE_BUSY，如有）
 *   - cause: 嵌套原因（递归序列化，最多 3 层）
 *
 * 非 Error 值（字符串、数字、普通对象）原样返回。
 */
export function serializeError(err: unknown, depth = 0): Record<string, unknown> | unknown {
  if (depth > 3) return '[max depth reached]';
  if (err instanceof Error) {
    const obj: Record<string, unknown> = {
      message: err.message,
      name: err.name,
    };
    if (err.stack) {
      obj.stack = err.stack.length > 2000 ? err.stack.slice(0, 2000) + '...[truncated]' : err.stack;
    }
    // 常见附加字段（不可枚举但可通过属性访问获取）
    const code = (err as any).code;
    if (code) obj.code = code;
    const cause = (err as any).cause;
    if (cause) obj.cause = serializeError(cause, depth + 1);
    // 保留任何自定义可枚举属性
    const extraKeys = Object.keys(err);
    for (const k of extraKeys) {
      if (!(k in obj)) obj[k] = (err as any)[k];
    }
    return obj;
  }
  // 非 Error：字符串/数字/null 等直接返回
  return err;
}
