/**
 * resolveSessionCacheKey 单测。
 *
 * 背景：OpenClaw 的 sessionKey 在 QQ bot /new 后保持不变（稳定路由桶），
 * 而 sessionId 会在 /new 后换新。若会话级缓存（goal/overhead/dedup/tool-guidance）
 * 用 sessionKey 当 key，/new 后仍读写上一会话的缓存桶，导致串会话数据泄漏。
 *
 * 因此统一以 sessionId 优先作为缓存 key：/new 后 key 换新 → 天然隔离。
 */
import { describe, it, expect } from 'vitest';
import { resolveSessionCacheKey } from './session-key.js';

describe('resolveSessionCacheKey', () => {
  it('优先使用 sessionId（/new 后换新，天然隔离）', () => {
    expect(resolveSessionCacheKey({ sessionId: 'sid-1', sessionKey: 'sk-stable' }))
      .toBe('sid-1');
  });

  it('sessionId 不存在时回退到 sessionKey', () => {
    expect(resolveSessionCacheKey({ sessionKey: 'sk-stable' }))
      .toBe('sk-stable');
  });

  it('sessionId 为空字符串时回退到 sessionKey', () => {
    expect(resolveSessionCacheKey({ sessionId: '', sessionKey: 'sk-stable' }))
      .toBe('sk-stable');
  });

  it('sessionId 为空白时回退到 sessionKey', () => {
    expect(resolveSessionCacheKey({ sessionId: '   ', sessionKey: 'sk-stable' }))
      .toBe('sk-stable');
  });

  it('sessionKey 也不存在时回退到 session_id', () => {
    expect(resolveSessionCacheKey({ sessionId: undefined, session_id: 'legacy-id' }))
      .toBe('legacy-id');
  });

  it('再回退到 conversationId', () => {
    expect(resolveSessionCacheKey({ sessionId: null, sessionKey: '', conversationId: 'conv-9' }))
      .toBe('conv-9');
  });

  it('全部缺失时返回空字符串', () => {
    expect(resolveSessionCacheKey({})).toBe('');
  });

  it('非字符串 sessionId 也会被字符串化（兼容未知字段类型）', () => {
    expect(resolveSessionCacheKey({ sessionId: 42 })).toBe('42');
  });
});