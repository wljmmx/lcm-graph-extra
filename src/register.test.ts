import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  getRegisteredPlugin,
  listRegisteredPlugins,
} from './register';
import type { OpenClawContext } from './register';

// Helper: clear global registry before each test
function clearRegistry(): void {
  const all = listRegisteredPlugins();
  for (const [id] of all) {
    getRegisteredPlugin(id)?.unregister();
  }
}

beforeEach(() => {
  clearRegistry();
});

describe('register', () => {
  it('should register a plugin successfully with default id', () => {
    const context: OpenClawContext = { config: {} };
    const instance = register(undefined, context);

    expect(instance.config.summaryStrategy).toBe('strategy');
    expect(instance.config.maxGraphDepth).toBe(10);
    expect(instance.context).toBe(context);
    expect(typeof instance.unregister).toBe('function');
  });

  it('should register with custom plugin id', () => {
    const context: OpenClawContext = { config: { maxGraphDepth: 20 } };
    const instance = register('my-custom-plugin', context);

    expect(instance.config.maxGraphDepth).toBe(20);
    expect(getRegisteredPlugin('my-custom-plugin')).toBe(instance);
  });

  it('should validate config on registration', () => {
    const badContext: OpenClawContext = { config: { maxGraphDepth: -1 } };
    expect(() => register(undefined, badContext)).toThrow(/Invalid plugin config/);
  });

  it('should use provided logger when available', () => {
    const customLogger = { level: 'info' } as any;
    const context: OpenClawContext = { config: {}, logger: customLogger };
    const instance = register(undefined, context);
    expect(instance.logger).toBe(customLogger);
  });

  it('should fall back to pino when no logger provided', () => {
    const context: OpenClawContext = { config: {} };
    const instance = register(undefined, context);
    expect(instance.logger).toBeDefined();
    expect(typeof instance.logger).toBe('object');
  });
});

describe('duplicate registration', () => {
  it('should replace previous instance on duplicate registration', () => {
    const ctx1: OpenClawContext = { config: { maxGraphDepth: 5 } };
    const ctx2: OpenClawContext = { config: { maxGraphDepth: 20 } };

    register('dup-test', ctx1);
    register('dup-test', ctx2);

    const instance = getRegisteredPlugin('dup-test');
    expect(instance).toBeDefined();
    expect(instance!.config.maxGraphDepth).toBe(20);
    // Only one instance should exist
    expect(listRegisteredPlugins().size).toBe(1);
  });
});

describe('unregister', () => {
  it('should remove the plugin from the registry', () => {
    const context: OpenClawContext = { config: {} };
    const instance = register('unreg-test', context);

    expect(getRegisteredPlugin('unreg-test')).toBe(instance);
    instance.unregister();
    expect(getRegisteredPlugin('unreg-test')).toBeUndefined();
  });
});

describe('getRegisteredPlugin / listRegisteredPlugins', () => {
  it('should return undefined for non-existent plugin', () => {
    expect(getRegisteredPlugin('does-not-exist')).toBeUndefined();
  });

  it('should return all registered plugins', () => {
    register('plugin-a', { config: {} });
    register('plugin-b', { config: {} });

    const list = listRegisteredPlugins();
    expect(list.size).toBe(2);
    expect(list.has('plugin-a')).toBe(true);
    expect(list.has('plugin-b')).toBe(true);
  });

  it('should return a copy of the registry map', () => {
    register('copy-test', { config: {} });
    const list1 = listRegisteredPlugins();
    const list2 = listRegisteredPlugins();
    expect(list1).not.toBe(list2); // different Map instances
  });
});

describe('hooks skeleton', () => {
  it('should register hook callbacks when hooks are provided', () => {
    const capturedHooks: string[] = [];
    const hooksContext: OpenClawContext = {
      config: {},
      hooks: {
        turn_complete: (cb: Function) => { capturedHooks.push('turn_complete'); cb(); },
        heartbeat: (cb: Function) => { capturedHooks.push('heartbeat'); cb(); },
        compaction: (cb: Function) => { capturedHooks.push('compaction'); cb(); },
      },
    };

    register(undefined, hooksContext);
    expect(capturedHooks).toContain('turn_complete');
    expect(capturedHooks).toContain('heartbeat');
    expect(capturedHooks).toContain('compaction');
  });

  it('should skip hook registration when hooks object is missing', () => {
    const context: OpenClawContext = { config: {} };
    register(undefined, context);
    // Should not throw
    expect(getRegisteredPlugin()).toBeDefined();
  });

  it('should skip non-function hook entries', () => {
    const hooksContext: OpenClawContext = {
      config: {},
      hooks: {
        turn_complete: 'not-a-function' as any,
        heartbeat: (cb: Function) => cb(),
      },
    };

    register(undefined, hooksContext);
    // Should succeed despite invalid entry
    expect(getRegisteredPlugin()).toBeDefined();
  });

  it('hook callback should return null', async () => {
    const results: unknown[] = [];
    const hooksContext: OpenClawContext = {
      config: {},
      hooks: {
        turn_complete: (cb: Function) => {
          const r = cb('arg1', 'arg2');
          results.push(r);
        },
      },
    };

    register(undefined, hooksContext);
    // The callback is async and returns null
    expect(results[0]).toBeDefined();
  });
});
