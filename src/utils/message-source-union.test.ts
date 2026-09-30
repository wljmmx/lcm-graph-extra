/**
 * 会话级来源并集单测。
 *
 * 覆盖的正是曾经导致"整段会话静默丢失、永不进图"的那段逻辑：
 * 旧实现是互斥早退（官方有数据就 return），这些用例把它钉成并集语义。
 */
import { describe, it, expect } from 'vitest';
import { mergeMessageSourceSessions, type MessageSourceSessionLike } from './message-source-union';

function s(sessionKey: string, sessionId = `sess-${sessionKey}`, msgs: number = 1): MessageSourceSessionLike {
  return {
    sessionKey,
    sessionId,
    msgs: Array.from({ length: msgs }, (_, i) => ({ role: 'user', content: `m${i}`, createdAt: i })),
  };
}

describe('mergeMessageSourceSessions', () => {
  it('官方为空 → 全部来自 lcm.db（回退语义不变）', () => {
    const r = mergeMessageSourceSessions([], [s('sk-a'), s('sk-b')]);
    expect(r.sessions.map((x) => x.sessionKey)).toEqual(['sk-a', 'sk-b']);
    expect(r.officialSessions).toBe(0);
    expect(r.lcmOnlySessions).toBe(2);
    expect(r.overlapSessions).toBe(0);
  });

  it('官方全覆盖 → 不加任何 lcm 会话，全部按官方为准', () => {
    const official = [s('sk-a'), s('sk-b')];
    const lcm = [s('sk-a', 'sess-other'), s('sk-b')];
    const r = mergeMessageSourceSessions(official, lcm);
    expect(r.sessions).toHaveLength(2);
    expect(r.officialSessions).toBe(2);
    expect(r.lcmOnlySessions).toBe(0);
    expect(r.overlapSessions).toBe(2);
  });

  it('部分覆盖（关键回归）→ 仅存在于 lcm.db 的会话必须被补入', () => {
    const r = mergeMessageSourceSessions([s('sk-official'), s('sk-both')], [s('sk-both'), s('sk-lcm-only')]);
    const keys = r.sessions.map((x) => x.sessionKey);
    expect(keys).toEqual(['sk-official', 'sk-both', 'sk-lcm-only']);
    expect(r.officialSessions).toBe(2);
    expect(r.lcmOnlySessions).toBe(1);
    expect(r.overlapSessions).toBe(1);
  });

  it('同 key 冲突时保留官方版本的消息体（不混源，避免重复节点）', () => {
    const r = mergeMessageSourceSessions(
      [s('sk-a', 'sess-official', 3)],
      [s('sk-a', 'sess-lcm', 9)],
    );
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].sessionId).toBe('sess-official');
    expect(r.sessions[0].msgs).toHaveLength(3);
    expect(r.overlapSessions).toBe(1);
  });

  it('官方侧内部重复 key 会被去重，且不影响 lcmOnly 计数', () => {
    const r = mergeMessageSourceSessions([s('sk-a'), s('sk-a')], [s('sk-b')]);
    expect(r.sessions.map((x) => x.sessionKey)).toEqual(['sk-a', 'sk-b']);
    expect(r.officialSessions).toBe(1);
    expect(r.lcmOnlySessions).toBe(1);
  });

  it('空 key 一律忽略（与 resolveGmSessionKey 的过滤保持一致）', () => {
    const r = mergeMessageSourceSessions([s('')], [s(''), s('sk-a')]);
    expect(r.sessions.map((x) => x.sessionKey)).toEqual(['sk-a']);
    expect(r.officialSessions).toBe(0);
    expect(r.lcmOnlySessions).toBe(1);
  });

  it('两侧皆空 → 空并集，不抛错', () => {
    const r = mergeMessageSourceSessions([], []);
    expect(r.sessions).toEqual([]);
    expect(r.lcmSessions).toBe(0);
  });
});