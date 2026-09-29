/**
 * compact 早退结果单测。
 *
 * 验证目标（对应"早退走真实报错，不要污染正确压缩结果"）：
 *  1. 早退恒为 ok=false / compacted=false —— 绝不伪装成压缩成功；
 *  2. 必带非空 error（真实报错），不是只有原因码；
 *  3. 不携带 result / summary / tokensBefore / tokensAfter / firstKeptEntryId /
 *     summaryId —— 不伪造"正确压缩结果"的载体字段；
 *  4. reason 原样保留（稳定原因码，供日志与分支判断）。
 */
import { describe, it, expect } from 'vitest';
import { compactEarlyExit } from './compact-result.js';

/** "正确压缩结果"的载体字段：早退路径一律不得出现 */
const RESULT_PAYLOAD_KEYS = [
  'result',
  'summary',
  'summaryId',
  'tokensBefore',
  'tokensAfter',
  'firstKeptEntryId',
  'exhausted',
  'sessionId',
  'sessionFile',
];

describe('compactEarlyExit', () => {
  it('恒为 ok=false / compacted=false（不伪装成压缩成功）', () => {
    const r = compactEarlyExit('cooldown', 'compact skipped: cooldown active');
    expect(r.ok).toBe(false);
    expect(r.compacted).toBe(false);
    expect(r.compacted).not.toBe(true);
  });

  it('保留稳定原因码 + 带可读 error', () => {
    const r = compactEarlyExit('main_turn_active', 'compact deferred: main turn active');
    expect(r.reason).toBe('main_turn_active');
    expect(r.error).toBe('compact deferred: main turn active');
  });

  it('不携带任何结果载体字段（不污染正确压缩结果）', () => {
    const r = compactEarlyExit('cooldown', 'skipped') as Record<string, unknown>;
    for (const k of RESULT_PAYLOAD_KEYS) {
      expect(r[k], `早退结果不应含字段 ${k}`).toBeUndefined();
    }
    // 形状封闭：只有契约声明的四个字段
    expect(Object.keys(r).sort()).toEqual(['compacted', 'error', 'ok', 'reason']);
  });

  it('即使 reason 看起来像成功语义，也不会泄漏 compacted:true', () => {
    const r = compactEarlyExit('compaction completed', 'not really completed');
    expect(r.compacted).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('空白/缺失 error 回退为 reason（避免空报错）', () => {
    expect(compactEarlyExit('cooldown', '').error).toBe('cooldown');
    expect(compactEarlyExit('cooldown', '   ').error).toBe('cooldown');
    expect(compactEarlyExit('cooldown', undefined as unknown as string).error).toBe('cooldown');
  });

  it('覆盖引擎层全部早退原因码，形状一致', () => {
    const cases: Array<[string, string]> = [
      ['compaction aborted', 'compact aborted: host abortSignal already aborted before compaction started'],
      ['aborted', 'compact aborted: signal already aborted before compaction started'],
      ['init failed: boom', 'compact init failed: boom'],
      ['main_turn_active', 'compact deferred: main turn active'],
      ['cooldown', 'compact skipped: cooldown 120000ms'],
    ];
    for (const [reason, error] of cases) {
      const r = compactEarlyExit(reason, error);
      expect(r.ok).toBe(false);
      expect(r.compacted).toBe(false);
      expect(r.reason).toBe(reason);
      expect(r.error).toBe(error);
      expect((r as Record<string, unknown>).result).toBeUndefined();
    }
  });
});