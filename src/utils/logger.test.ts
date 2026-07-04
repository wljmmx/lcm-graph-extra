import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LogLevel,
  parseLogLevel,
  noopLogger,
  ConsoleLogger,
  createLogger,
  setGlobalLogger,
  getGlobalLogger,
  resolveLogger,
  adaptLogger,
  type Logger,
} from './logger.js';

describe('logger', () => {
  describe('parseLogLevel', () => {
    it('解析名称', () => {
      expect(parseLogLevel('debug')).toBe(LogLevel.DEBUG);
      expect(parseLogLevel('INFO')).toBe(LogLevel.INFO);
      expect(parseLogLevel('warning')).toBe(LogLevel.WARN);
      expect(parseLogLevel('error')).toBe(LogLevel.ERROR);
      expect(parseLogLevel('silent')).toBe(LogLevel.SILENT);
      expect(parseLogLevel('off')).toBe(LogLevel.SILENT);
      expect(parseLogLevel('none')).toBe(LogLevel.SILENT);
    });

    it('解析数字字符串', () => {
      expect(parseLogLevel('10')).toBe(LogLevel.DEBUG);
      expect(parseLogLevel('40')).toBe(LogLevel.ERROR);
    });

    it('未设置/无效时返回 fallback', () => {
      expect(parseLogLevel(undefined)).toBe(LogLevel.INFO);
      expect(parseLogLevel('')).toBe(LogLevel.INFO);
      expect(parseLogLevel('garbage')).toBe(LogLevel.INFO);
      expect(parseLogLevel('garbage', LogLevel.WARN)).toBe(LogLevel.WARN);
    });
  });

  describe('noopLogger', () => {
    it('所有方法都是 no-op 不抛错', () => {
      expect(() => {
        noopLogger.debug('x', { a: 1 });
        noopLogger.info('x');
        noopLogger.warn('x');
        noopLogger.error('x', { err: new Error('e') });
      }).not.toThrow();
    });
  });

  describe('ConsoleLogger', () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('ERROR 级别下只输出 error', () => {
      const logger = new ConsoleLogger(LogLevel.ERROR);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0]).toContain('e');
    });

    it('WARN 级别下输出 warn+error 到 stderr', () => {
      const logger = new ConsoleLogger(LogLevel.WARN);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledTimes(2);
    });

    it('INFO 级别下 debug→stdout 不输出，info→stdout 输出', () => {
      const logger = new ConsoleLogger(LogLevel.INFO);
      logger.debug('d');
      logger.info('i');
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      expect(stdoutSpy.mock.calls[0][0]).toContain('i');
    });

    it('DEBUG 级别下全部输出', () => {
      const logger = new ConsoleLogger(LogLevel.DEBUG);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      // debug/info → stdout, warn/error → stderr
      expect(stdoutSpy).toHaveBeenCalledTimes(2);
      expect(stderrSpy).toHaveBeenCalledTimes(2);
    });

    it('SILENT 级别下不输出任何内容', () => {
      const logger = new ConsoleLogger(LogLevel.SILENT);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('ctx 对象序列化到输出', () => {
      const logger = new ConsoleLogger(LogLevel.INFO);
      logger.info('hello', { user: 'alice', count: 42 });
      const out = String(stdoutSpy.mock.calls[0][0]);
      expect(out).toContain('hello');
      expect(out).toContain('"user":"alice"');
      expect(out).toContain('"count":42');
    });
  });

  describe('全局 logger 单例', () => {
    it('默认返回 noopLogger', () => {
      // 注意：其他测试可能已设置 global，这里先重置
      setGlobalLogger(noopLogger);
      expect(getGlobalLogger()).toBe(noopLogger);
    });

    it('setGlobalLogger 后 getGlobalLogger 返回设置值', () => {
      const custom: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
      setGlobalLogger(custom);
      expect(getGlobalLogger()).toBe(custom);
      // 还原
      setGlobalLogger(noopLogger);
    });
  });

  describe('resolveLogger', () => {
    it('传入有效 logger 优先使用', () => {
      const custom: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
      expect(resolveLogger(custom)).toBe(custom);
    });

    it('传入 null/undefined 降级到 globalLogger', () => {
      setGlobalLogger(noopLogger);
      expect(resolveLogger(null)).toBe(noopLogger);
      expect(resolveLogger(undefined)).toBe(noopLogger);
    });

    it('传入非 logger 对象降级到 globalLogger', () => {
      setGlobalLogger(noopLogger);
      expect(resolveLogger({} as any)).toBe(noopLogger);
      expect(resolveLogger('not a logger' as any)).toBe(noopLogger);
    });
  });

  describe('adaptLogger', () => {
    it('null/undefined 返回 noopLogger', () => {
      expect(adaptLogger(null)).toBe(noopLogger);
      expect(adaptLogger(undefined)).toBe(noopLogger);
      expect(adaptLogger('string')).toBe(noopLogger);
    });

    it('完整 pino-like 对象适配成功', () => {
      const calls: string[] = [];
      const raw = {
        debug: (m: string) => calls.push('debug:' + m),
        info: (m: string) => calls.push('info:' + m),
        warn: (m: string) => calls.push('warn:' + m),
        error: (m: string) => calls.push('error:' + m),
      };
      const adapted = adaptLogger(raw);
      adapted.info('hello');
      adapted.error('boom');
      expect(calls).toEqual(['info:hello', 'error:boom']);
    });

    it('部分方法缺失时降级到 noop', () => {
      const raw = { info: (m: string) => m };
      const adapted = adaptLogger(raw);
      expect(() => adapted.debug('x')).not.toThrow();
      expect(() => adapted.warn('x')).not.toThrow();
      expect(() => adapted.error('x')).not.toThrow();
    });

    it('保留 child 方法', () => {
      const raw = {
        debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
        child: (b: Record<string, unknown>) => ({ ...raw, ...b }),
      };
      const adapted = adaptLogger(raw);
      expect(adapted.child).toBeDefined();
      const child = adapted.child!({ module: 'test' });
      expect(typeof child.info).toBe('function');
    });
  });

  describe('createLogger', () => {
    it('返回 ConsoleLogger 实例', () => {
      const logger = createLogger();
      expect(logger).toBeInstanceOf(ConsoleLogger);
    });
  });
});
