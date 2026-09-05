import { describe, it, expect } from 'vitest';
import { ensureFinalUserMessage, appendRecentUser } from './ensure-final-user.js';

const u = (c: string) => ({ role: 'user', content: c });
const a = (c: string) => ({ role: 'assistant', content: c });
const sys = (c: string) => ({ role: 'system', content: c });
const dev = (c: string) => ({ role: 'developer', content: c });

describe('ensureFinalUserMessage', () => {
  it('只要含 ≥1 条非空 user，即便以 assistant 结尾也原样放行（不污染）', () => {
    const msgs = [u('任务A'), a('回答A')];
    const r = ensureFinalUserMessage(msgs, msgs);
    expect(r.note).toBe('ok');
    expect(r.messages).toBe(msgs); // 不改动引用
  });

  it('多段 user + 尾部 assistant/system 均不干预', () => {
    const msgs = [u('q1'), a('r1'), u('q2'), a('r2'), dev('drop')];
    const r = ensureFinalUserMessage(msgs, msgs);
    expect(r.note).toBe('ok');
    expect(r.messages).toBe(msgs);
  });

  it('重建结果全无 user，但原始转录有 user 时回退原始转录（真实内容）', () => {
    const rebuilt = [sys('摘要'), dev('x'), a('摘要回复')]; // 无 user
    const original = [u('真实问题'), a('旧回答')];
    const r = ensureFinalUserMessage(rebuilt, original);
    expect(r.note).toBe('from_original');
    expect(r.messages).toBe(original);
  });

  it('总 wedge：转录与重建都无 user 时 fail-closed，不伪造 user', () => {
    const msgs = [sys('a'), dev('b'), a('c')];
    const original = [sys('o'), a('p')];
    const r = ensureFinalUserMessage(msgs, original);
    expect(r.note).toBe('none');
    expect(r.messages).toEqual(msgs); // 原样保留，不伪造
  });

  it('空消息/空数组原样返回 ok', () => {
    expect(ensureFinalUserMessage([], []).note).toBe('ok');
    const empty = ensureFinalUserMessage([], [u('只在原件有')]);
    expect(empty.note).toBe('ok');
    expect(empty.messages).toEqual([]);
  });

  it('空白 content 的 user 视为无效（不满足非空 user）', () => {
    const blankUser = [{ role: 'user', content: '   ' }, a('x')];
    const original = [u('真实')];
    const r = ensureFinalUserMessage(blankUser, original);
    // 重建无有效 user → 回退原始（原始有 user）
    expect(r.note).toBe('from_original');
  });
});
describe('appendRecentUser', () => {
  it('built 已含非空 user 时原样返回（不重复追加）', () => {
    const built = [sys('s'), u('q'), a('r')];
    expect(appendRecentUser(built, [u('x')])).toBe(built);
  });

  it('built 无 user 时从 source 补最近一条真实 user（末尾追加）', () => {
    const built = [sys('s'), a('回答')];
    const source = [u('旧问题'), a('旧答'), u('最近问题'), a('最近答')];
    const out = appendRecentUser(built, source);
    expect(out.length).toBe(built.length + 1);
    expect(out[out.length - 1]).toEqual(u('最近问题'));
  });

  it('source 也无 user 时原样返回（不伪造）', () => {
    const built = [sys('s'), a('r')];
    expect(appendRecentUser(built, [sys('o'), a('p')])).toBe(built);
  });

  it('source 非数组时原样返回', () => {
    const built = [a('r')];
    expect(appendRecentUser(built, null as any)).toBe(built);
  });
});
