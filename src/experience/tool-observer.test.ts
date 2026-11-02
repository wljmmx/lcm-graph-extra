/**
 * after_tool_call 经验观察器单元测试。
 *
 * 覆盖：
 *   - failure 判定（error 字段 / isError / details.ok=false / content block）
 *   - 签名配对（同工具 + 同参数才算 fix_success）
 *   - failure 去重（DEDUPE_TTL_MS 内不重复写）
 *   - 非学习型会话（cron/heartbeat）被忽略
 *   - triggers 配置门控
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createToolExperienceObserver,
  describeToolCallFailure,
  isToolCallFailure,
  toolCallSignature,
} from './tool-observer.js';
import type { RawExperience } from './types.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeObserver(overrides: {
  store?: { saveRaw(raw: RawExperience): Promise<void> };
  triggers?: string[];
  enabled?: boolean;
} = {}) {
  const saved: RawExperience[] = [];
  const store = overrides.store ?? {
    saveRaw: vi.fn(async (raw: RawExperience) => { saved.push(raw); }),
  };
  let clock = 1_000_000;
  const onSaved = vi.fn();
  const observer = createToolExperienceObserver({
    getStore: () => store,
    isEnabled: () => overrides.enabled !== false,
    getTriggers: () => (overrides.triggers ?? ['failure', 'fix_success']) as any,
    onSaved,
    now: () => clock,
  });
  return {
    observer,
    saved,
    onSaved,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('isToolCallFailure', () => {
  it('识别 error 字段', () => {
    expect(isToolCallFailure({ toolName: 'exec', error: 'boom' })).toBe(true);
    expect(isToolCallFailure({ toolName: 'exec', error: '   ' })).toBe(false);
  });

  it('识别 result.isError / is_error', () => {
    expect(isToolCallFailure({ toolName: 'exec', result: { isError: true } })).toBe(true);
    expect(isToolCallFailure({ toolName: 'exec', result: { is_error: true } })).toBe(true);
  });

  it('识别 details.ok === false', () => {
    expect(isToolCallFailure({ toolName: 'lcmg_diagnose', result: { details: { ok: false } } })).toBe(true);
  });

  it('识别 content block 里的 isError', () => {
    expect(isToolCallFailure({
      toolName: 'exec',
      result: { content: [{ type: 'text', text: 'failed', isError: true }] },
    })).toBe(true);
  });

  it('正常结果不误判', () => {
    expect(isToolCallFailure({
      toolName: 'exec',
      result: { content: [{ type: 'text', text: 'ok' }], details: { ok: true } },
    })).toBe(false);
  });
});

describe('toolCallSignature', () => {
  it('同工具同参数签名稳定', () => {
    const a = toolCallSignature('exec', { command: 'npm test' });
    const b = toolCallSignature('exec', { command: 'npm test' });
    expect(a).toBe(b);
  });

  it('参数不同签名不同', () => {
    expect(toolCallSignature('exec', { command: 'npm test' }))
      .not.toBe(toolCallSignature('exec', { command: 'npm build' }));
  });

  it('工具名不同签名不同', () => {
    expect(toolCallSignature('exec', { command: 'ls' }))
      .not.toBe(toolCallSignature('read', { command: 'ls' }));
  });
});

describe('describeToolCallFailure', () => {
  it('优先使用 error 字段并截断到首行', () => {
    expect(describeToolCallFailure({ toolName: 'exec', error: 'ENOENT: missing\nstack...' }))
      .toBe('ENOENT: missing');
  });

  it('无 error 时回退到 details.message / content', () => {
    expect(describeToolCallFailure({ toolName: 'exec', result: { details: { message: 'permission denied' } } }))
      .toBe('permission denied');
    expect(describeToolCallFailure({ toolName: 'exec', result: { content: [{ text: 'syntax error' }] } }))
      .toBe('syntax error');
  });
});

describe('createToolExperienceObserver', () => {
  it('failure 写入 PENDING 经验并触发缓存失效', async () => {
    const { observer, saved, onSaved } = makeObserver();
    observer.handle(
      { toolName: 'exec', params: { command: 'npm test' }, error: 'exit code 1' },
      { sessionKey: 'sess-1' },
    );
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0].source).toBe('failure');
    expect(saved[0].sessionId).toBe('sess-1');
    expect(saved[0].context).toContain('失败: exec');
    expect(onSaved).toHaveBeenCalled();
  });

  it('同签名 failure 在去重窗口内不重复写入', async () => {
    const { observer, saved, advance } = makeObserver();
    const event = { toolName: 'exec' as const, params: { command: 'npm test' }, error: 'exit code 1' };
    observer.handle(event, { sessionKey: 'sess-1' });
    await flush();
    advance(1_000);
    observer.handle({ ...event, error: 'exit code 2' }, { sessionKey: 'sess-1' });
    await flush();
    expect(saved).toHaveLength(1);

    advance(5 * 60 * 1000 + 1);
    observer.handle(event, { sessionKey: 'sess-1' });
    await flush();
    expect(saved).toHaveLength(2);
  });

  it('同签名先失败后成功 → fix_success，且只写一次', async () => {
    const { observer, saved } = makeObserver();
    const call = { toolName: 'exec', params: { command: 'npm test' } };
    observer.handle({ ...call, error: 'exit code 1' }, { sessionKey: 'sess-1' });
    await flush();
    observer.handle({ ...call, result: { content: [{ text: 'All tests passed' }] } }, { sessionKey: 'sess-1' });
    await flush();

    expect(saved.map((r) => r.source)).toEqual(['failure', 'fix_success']);
    expect(saved[1].context).toContain('修复通过: exec');

    // 再次成功（签名已消费）不再写 fix_success
    observer.handle({ ...call, result: { content: [{ text: 'All tests passed' }] } }, { sessionKey: 'sess-1' });
    await flush();
    expect(saved).toHaveLength(2);
  });

  it('参数不同的成功不算 fix_success', async () => {
    const { observer, saved } = makeObserver();
    observer.handle({ toolName: 'exec', params: { command: 'npm test' }, error: 'exit code 1' }, { sessionKey: 'sess-1' });
    await flush();
    observer.handle({ toolName: 'exec', params: { command: 'npm build' }, result: { content: [{ text: 'ok' }] } }, { sessionKey: 'sess-1' });
    await flush();
    expect(saved.map((r) => r.source)).toEqual(['failure']);
  });

  it('cron / heartbeat 会话被忽略（不跟踪也不写入）', async () => {
    const { observer, saved } = makeObserver();
    const event = { toolName: 'exec', params: { command: 'npm test' }, error: 'exit code 1' };
    observer.handle(event, { sessionKey: 'agent:main:cron:nightly' });
    observer.handle(event, { sessionKey: 'heartbeat:main' });
    observer.handle(event, {});
    await flush();
    expect(saved).toHaveLength(0);
  });

  it('triggers 未启用 failure 时不写 failure，但仍可用于 fix 配对', async () => {
    const { observer, saved } = makeObserver({ triggers: ['fix_success'] });
    const call = { toolName: 'exec', params: { command: 'npm test' } };
    observer.handle({ ...call, error: 'exit code 1' }, { sessionKey: 'sess-1' });
    await flush();
    observer.handle({ ...call, result: { content: [{ text: 'ok' }] } }, { sessionKey: 'sess-1' });
    await flush();
    expect(saved.map((r) => r.source)).toEqual(['fix_success']);
  });

  it('experience.enabled=false 时完全不写', async () => {
    const { observer, saved } = makeObserver({ enabled: false });
    observer.handle({ toolName: 'exec', params: { command: 'ls' }, error: 'boom' }, { sessionKey: 'sess-1' });
    await flush();
    expect(saved).toHaveLength(0);
  });

  it('store 未就绪（初始化前）时安全跳过', async () => {
    const saved: RawExperience[] = [];
    let store: { saveRaw(raw: RawExperience): Promise<void> } | null = null;
    const observer = createToolExperienceObserver({
      getStore: () => store,
      getTriggers: () => ['failure', 'fix_success'],
      now: () => 1_000_000,
    });
    observer.handle({ toolName: 'exec', error: 'boom' }, { sessionKey: 'sess-1' });
    await flush();
    expect(saved).toHaveLength(0);

    store = { saveRaw: async (raw) => { saved.push(raw); } };
    observer.handle({ toolName: 'exec', error: 'boom-2' }, { sessionKey: 'sess-1' });
    await flush();
    expect(saved).toHaveLength(1);
  });
});
