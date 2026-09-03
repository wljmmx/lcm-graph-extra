/**
 * SDK 2026.8.1 会话重置（/new）闭环测试。
 *
 * 场景：host 在 /new 时触发 before_reset typed hook（ctx: sessionKey 不变、
 * sessionId 为旧值），引擎必须失效旧会话的会话级缓存，否则 dedup 窗口、
 * goal、overhead、MoA 结果等陈旧数据泄漏进新会话的首轮 assemble/afterTurn。
 */
import { describe, it, expect } from 'vitest';
import { invalidateSessionStateForReset } from './session-reset';
import { setOverhead, getOverhead, getSdkOverhead } from './plugin/overhead-cache';
import { SDK_OVERHEAD_TOKENS } from './config';
import { cacheGoal, getGoal } from './plugin/goal-cache';
import { setMoaResultCache, peekMoaResultCache } from './moa/orchestrator';
import { getSessionDedup } from './plugin/dedup-cache';

describe('session reset closure (before_reset / bootstrap finally 共享清理)', () => {
  it('清除按 sessionKey 键控的会话级缓存（overhead / goal / dedup / MoA）', async () => {
    const sk = 'sk-reset-test';
    setOverhead(sk, 999);
    cacheGoal(sk, '旧会话目标');
    setMoaResultCache('旧会话 MoA 结果');
    // dedup 桶按需创建（getSessionDedup 即创建），验证清理后重新初始化
    getSessionDedup(sk);

    await invalidateSessionStateForReset(sk, 'sid-prev-001');

    // overhead：清空后回退默认（0 / SDK 默认开销）
    expect(getOverhead(sk)).toBe(0);
    expect(getSdkOverhead(sk)).toBe(SDK_OVERHEAD_TOKENS);
    // goal：清空
    expect(getGoal(sk)).toBe('');
    // MoA：全局缓存被消费清空
    expect(peekMoaResultCache()).toBeNull();
  });

  it('身份信息为空时不抛错（host 可能不携带 sessionId 触发 reset）', async () => {
    await expect(invalidateSessionStateForReset('', '')).resolves.toBeUndefined();
  });

  it('空身份触发时不误清其他会话的缓存', async () => {
    const other = 'sk-other-session';
    setOverhead(other, 42);
    await invalidateSessionStateForReset('', '');
    expect(getOverhead(other)).toBe(42);
  });
});
