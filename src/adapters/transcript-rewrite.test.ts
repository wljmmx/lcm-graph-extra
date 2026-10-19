import { describe, it, expect } from 'vitest';
import {
  probeTranscriptRewriteCapability,
  readVisibleTranscriptEntries,
  summarizeTranscriptEntries,
  type VisibleTranscriptEntry,
} from './transcript-rewrite';

/**
 * SDK 2026.10.4 转录能力只读适配的契约锁定测试。
 *
 * 覆盖两条必须成立的规则（均来自宿主源码，非推测）：
 *  1) `rewriteTranscriptEntries` 仅在 maintain 注入，且宿主实现开头校验 sessionKey，
 *     缺失即 throw ⇒ 探测必须把「缺 sessionKey」判为不可用，调用方才能规避。
 *  2) 读取子路径为 JS-only 内部子路径，跨版本可能缺失 ⇒ 必须全程软失败（返回空数组，不抛错）。
 */
describe('probeTranscriptRewriteCapability（P0）', () => {
  const fn = () => Promise.resolve({ changed: false, bytesFreed: 0, rewrittenEntries: 0 });

  it('runtimeContext 未提供回调 → not_provided', () => {
    expect(probeTranscriptRewriteCapability({}, 'sk-1')).toEqual({
      available: false,
      reason: 'not_provided',
    });
    expect(probeTranscriptRewriteCapability(undefined, 'sk-1')).toEqual({
      available: false,
      reason: 'not_provided',
    });
  });

  it('提供了回调但缺 sessionKey → missing_session_key（宿主会 throw，必须提前判不可用）', () => {
    expect(probeTranscriptRewriteCapability({ rewriteTranscriptEntries: fn }, undefined)).toEqual({
      available: false,
      reason: 'missing_session_key',
    });
    expect(probeTranscriptRewriteCapability({ rewriteTranscriptEntries: fn }, '')).toEqual({
      available: false,
      reason: 'missing_session_key',
    });
    expect(probeTranscriptRewriteCapability({ rewriteTranscriptEntries: fn }, '   ')).toEqual({
      available: false,
      reason: 'missing_session_key',
    });
  });

  it('回调存在且 sessionKey 有效 → available', () => {
    expect(probeTranscriptRewriteCapability({ rewriteTranscriptEntries: fn }, 'sk-1')).toEqual({
      available: true,
    });
  });
});

describe('readVisibleTranscriptEntries（P1，只读、软失败）', () => {
  it('缺 sessionKey 时不发起读取，返回空数组', async () => {
    await expect(readVisibleTranscriptEntries({})).resolves.toEqual([]);
    await expect(readVisibleTranscriptEntries({ sessionKey: '   ' })).resolves.toEqual([]);
  });

  it('SDK 子路径不可解析（旧宿主 / 测试环境无 openclaw）时软失败返回空数组', async () => {
    // 测试环境未安装 openclaw，动态 import 必然失败 —— 正好锁定「绝不抛错」的降级契约
    const out = await readVisibleTranscriptEntries({
      sessionKey: 'sk-1',
      sessionId: 'sid-1',
      agentId: 'agent-1',
      storePath: '/store',
    });
    expect(out).toEqual([]);
  });
});

describe('summarizeTranscriptEntries（P1，纯函数）', () => {
  it('按 role 计数，缺失 role 归入 unknown', () => {
    const entries: VisibleTranscriptEntry[] = [
      { entryId: 'e1', role: 'user' },
      { entryId: 'e2', role: 'user' },
      { entryId: 'e3', role: 'assistant' },
      { entryId: 'e4' },
    ];
    expect(summarizeTranscriptEntries(entries)).toEqual({
      total: 4,
      byRole: { user: 2, assistant: 1, unknown: 1 },
    });
  });

  it('空输入返回全零', () => {
    expect(summarizeTranscriptEntries([])).toEqual({ total: 0, byRole: {} });
  });
});
