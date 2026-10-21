/**
 * audit wrapper 自动信号收集挂点测试。
 * 验证：工具失败（isError / 抛错）→ 记入信号池；abort → 不记录。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuditWrapper, _resetRegisteredToolHandlers } from './shared.js';
import { peekHarnessSignals, resetHarnessingDiagnostics, drainHarnessSignals } from '../harnessing/signal-collector.js';

beforeEach(() => {
  _resetRegisteredToolHandlers();
  resetHarnessingDiagnostics();
});

describe('createAuditWrapper × 信号收集（Harnessing 自动介入）', () => {
  it('isError 失败 → 记入信号池（source=工具名，含 details.error 摘要）', async () => {
    const registered: any[] = [];
    const register = createAuditWrapper((t: any) => { registered.push(t); return t; });
    register({
      name: 'lcmg_search',
      execute: async () => ({
        content: [{ type: 'text', text: 'fail' }],
        details: { ok: false, error: 'boom: connection refused' },
        isError: true,
      }),
    });
    const tool = registered[0];
    await tool.execute('call-1', {});
    const drained = drainHarnessSignals();
    expect(drained).toHaveLength(1);
    expect(drained[0].source).toBe('lcmg_search');
    expect(drained[0].text).toContain('工具 lcmg_search 调用失败');
    expect(drained[0].text).toContain('connection refused');
    // 错误文本含 "connection refused" → 环境契约失配（基础设施类，优先于动作实现）
    expect(drained[0].kind).toBe('environment-contract');
  });

  it('abort 返回（details.aborted）→ 不记录', async () => {
    const registered: any[] = [];
    const register = createAuditWrapper((t: any) => { registered.push(t); return t; });
    register({
      name: 'lcmg_distill',
      execute: async () => ({
        content: [{ type: 'text', text: 'aborted' }],
        details: { ok: false, aborted: true },
        isError: true,
      }),
    });
    await registered[0].execute('call-2', {});
    expect(peekHarnessSignals().count).toBe(0);
  });

  it('execute 抛错 → 记入信号池（含异常消息）', async () => {
    const registered: any[] = [];
    const register = createAuditWrapper((t: any) => { registered.push(t); return t; });
    register({
      name: 'lcmg_backup',
      execute: async () => { throw new Error('disk full'); },
    });
    await expect(registered[0].execute('call-3', {})).rejects.toThrow('disk full');
    const drained = drainHarnessSignals();
    expect(drained).toHaveLength(1);
    expect(drained[0].source).toBe('lcmg_backup');
    expect(drained[0].text).toContain('disk full');
  });

  it('成功调用 → 不记录', async () => {
    const registered: any[] = [];
    const register = createAuditWrapper((t: any) => { registered.push(t); return t; });
    register({
      name: 'lcmg_pin',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: { ok: true } }),
    });
    await registered[0].execute('call-4', {});
    expect(peekHarnessSignals().count).toBe(0);
  });
});
