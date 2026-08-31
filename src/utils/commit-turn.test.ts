import { describe, expect, it } from 'vitest';
import { evaluateTurnCommit } from './commit-turn.js';

describe('evaluateTurnCommit (durable-turn 幂等判定)', () => {
  it('正常首提：advancementKey 与 logicalTurnId 一致且未见 → 非重复', () => {
    const r = evaluateTurnCommit({
      sessionId: 'conv-1',
      advancementKey: 't-5',
      logicalTurnId: 't-5',
      seen: new Set(),
    });
    expect(r.duplicate).toBe(false);
    expect(r.keyMismatch).toBe(false);
    expect(r.turnId).toBe('t-5');
    expect(r.key).toBe('conv-1|t-5');
  });

  it('同一会话+turnId 已提交 → duplicate', () => {
    const seen = new Set(['conv-1|t-5']);
    const r = evaluateTurnCommit({
      sessionId: 'conv-1',
      advancementKey: 't-5',
      logicalTurnId: 't-5',
      seen,
    });
    expect(r.duplicate).toBe(true);
    expect(r.keyMismatch).toBe(false);
  });

  it('advancementKey 与 logicalTurnId 不一致（陈旧 admission）→ duplicate', () => {
    const r = evaluateTurnCommit({
      sessionId: 'conv-1',
      advancementKey: 't-3',
      logicalTurnId: 't-5',
      seen: new Set(),
    });
    expect(r.duplicate).toBe(true);
    expect(r.keyMismatch).toBe(true);
  });

  it('跨会话同一 turnId 不误判（key 含 sessionId 前缀）', () => {
    const seen = new Set(['conv-1|t-5']);
    const r = evaluateTurnCommit({
      sessionId: 'conv-9',
      advancementKey: 't-5',
      logicalTurnId: 't-5',
      seen,
    });
    expect(r.duplicate).toBe(false);
    expect(r.key).toBe('conv-9|t-5');
  });

  it('logicalTurnId 缺失时以 advancementKey 作为 turnId', () => {
    const r = evaluateTurnCommit({
      sessionId: 'conv-1',
      advancementKey: 't-7',
      logicalTurnId: undefined,
      seen: new Set(),
    });
    expect(r.duplicate).toBe(false);
    expect(r.turnId).toBe('t-7');
  });

  it('sessionId String 化：number 型 sessionId 也能生成稳定 key', () => {
    const r = evaluateTurnCommit({
      sessionId: String(2423),
      advancementKey: 't-1',
      logicalTurnId: 't-1',
      seen: new Set(['2423|t-1']),
    });
    expect(r.duplicate).toBe(true);
  });
});