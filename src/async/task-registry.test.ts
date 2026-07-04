import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BackgroundTaskRegistry } from './task-registry.js';

describe('BackgroundTaskRegistry', () => {
  let registry: BackgroundTaskRegistry;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
  });

  it('register + awaitAll: 等待任务完成', async () => {
    let resolved = false;
    registry.register('test', new Promise<void>((resolve) => {
      setTimeout(() => { resolved = true; resolve(); }, 50);
    }));
    expect(registry.pendingCount).toBe(1);
    await registry.awaitAll(1000);
    expect(resolved).toBe(true);
    expect(registry.pendingCount).toBe(0);
  });

  it('register 自动吞掉 rejection（不抛 unhandledRejection）', async () => {
    registry.register('fail', Promise.reject(new Error('boom')));
    await registry.awaitAll(1000);
    // 不抛错即通过
    expect(registry.pendingCount).toBe(0);
  });

  it('awaitAll 超时后强制返回', async () => {
    let resolved = false;
    registry.register('slow', new Promise<void>((resolve) => {
      setTimeout(() => { resolved = true; resolve(); }, 1000);
    }));
    await registry.awaitAll(50); // 50ms 超时
    expect(resolved).toBe(false); // 任务未完成
  });

  it('shuttingDown 后 register 被拒绝', async () => {
    await registry.awaitAll(0);
    expect(registry.isShuttingDown).toBe(true);
    registry.register('after-shutdown', Promise.resolve());
    expect(registry.pendingCount).toBe(0);
  });

  it('空 registry 的 awaitAll 立即返回', async () => {
    const start = Date.now();
    await registry.awaitAll(1000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('并发注册多个任务全部被等待', async () => {
    let count = 0;
    for (let i = 0; i < 5; i++) {
      registry.register(`task-${i}`, new Promise<void>((resolve) => {
        setTimeout(() => { count++; resolve(); }, 30);
      }));
    }
    expect(registry.pendingCount).toBe(5);
    await registry.awaitAll(1000);
    expect(count).toBe(5);
    expect(registry.pendingCount).toBe(0);
  });

  it('pendingNames 反映在途任务', async () => {
    registry.register('alpha', new Promise<void>((resolve) => setTimeout(resolve, 100)));
    registry.register('beta', new Promise<void>((resolve) => setTimeout(resolve, 100)));
    const names = registry.pendingNames;
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    await registry.awaitAll(500);
  });
});
