/**
 * gm-message-contract 单测。
 *
 * 守护两组不变量：
 *  1. **哈希算法正确性** —— 用 FNV 官方规范的公开测试向量（非取自上游源码），
 *     保证与 graph-memory-pro `messageContentHash` 逐位一致；
 *  2. **写入契约对齐** —— id 形状、role 过滤、turnIndex/occurrence 语义、
 *     sessionKey 回退链与上游 `planMessagePersist` / `agent_end` 一致。
 */
import { describe, it, expect } from 'vitest';
import {
  messageContentHash,
  buildMessageId,
  normalizeGmRole,
  resolveGmSessionKey,
  planGmMessageRows,
  flattenGmMessageContent,
  type GmMessageSourceRow,
} from './gm-message-contract.js';

describe('messageContentHash（64-bit FNV-1a 全文指纹）', () => {
  // FNV 官方规范公开测试向量（http://www.isthe.com/chongo/tech/comp/fnv/）
  // 独立于上游源码，用于锁定算法本身未被改坏。
  it('匹配 FNV 规范公开测试向量', () => {
    expect(messageContentHash('')).toBe('cbf29ce484222325');
    expect(messageContentHash('a')).toBe('af63dc4c8601ec8c');
    expect(messageContentHash('foobar')).toBe('85944171f73967e8');
  });

  it('输出恒为 16 位小写十六进制', () => {
    for (const s of ['', 'a', '你好世界', '🧠 emoji', 'x'.repeat(3000)]) {
      expect(messageContentHash(s)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('全文而非前 200 字参与指纹（前 200 字相同的不同消息必须不同）', () => {
    const head = 'x'.repeat(200);
    expect(messageContentHash(head + '-A')).not.toBe(messageContentHash(head + '-B'));
  });

  it('中文与 emoji（代理对）稳定可复现', () => {
    expect(messageContentHash('你好世界')).toBe('4bec0f6a8e22cfd4');
    expect(messageContentHash('🧠 emoji')).toBe('57f93a1faa251041');
    expect(messageContentHash('🧠 emoji')).toBe(messageContentHash('🧠 emoji'));
  });
});

describe('buildMessageId（稳定键，与上游同形）', () => {
  it('形状为 gm:<sessionKey>:<role>:<hash>:<seq>', () => {
    const h = messageContentHash('hello');
    expect(buildMessageId('sess-1', 'user', h, 0)).toBe(`gm:sess-1:user:${h}:0`);
    expect(buildMessageId('sess-1', 'assistant', h, 2)).toBe(`gm:sess-1:assistant:${h}:2`);
  });

  it('同内容重复消息靠 seq 区分，互相不覆盖', () => {
    const h = messageContentHash('继续');
    expect(buildMessageId('s', 'user', h, 0)).not.toBe(buildMessageId('s', 'user', h, 1));
  });

  it('不含位置分量：不同 role/sessionKey 必然不同 id', () => {
    const h = messageContentHash('same');
    const ids = new Set([
      buildMessageId('s1', 'user', h, 0),
      buildMessageId('s2', 'user', h, 0),
      buildMessageId('s1', 'assistant', h, 0),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe('normalizeGmRole（与上游过滤一致）', () => {
  it('user / human 变体归一为 user', () => {
    for (const r of ['user', 'USER', 'Human', 'human']) expect(normalizeGmRole(r)).toBe('user');
  });

  it('assistant 变体归一为 assistant', () => {
    for (const r of ['assistant', 'ASSISTANT', 'Assistant']) expect(normalizeGmRole(r)).toBe('assistant');
  });

  it('system / tool / 空值一律不持久化（null）', () => {
    for (const r of ['system', 'tool', 'developer', '', null, undefined, 42]) {
      expect(normalizeGmRole(r as unknown)).toBeNull();
    }
  });
});

describe('resolveGmSessionKey（上游 agent_end 回退链）', () => {
  it('优先 session_key', () => {
    expect(resolveGmSessionKey('sk', 'sid')).toBe('sk');
  });

  it('session_key 缺失/空白时回退 session_id（= 上游 ctx.sessionKey ?? ctx.sessionId）', () => {
    expect(resolveGmSessionKey(null, 'sid')).toBe('sid');
    expect(resolveGmSessionKey('   ', 'sid')).toBe('sid');
    expect(resolveGmSessionKey('', 'sid')).toBe('sid');
  });

  it('两列皆空返回空串 —— 调用方须跳过（对齐上游「取不到则整轮跳过写入」）', () => {
    expect(resolveGmSessionKey(null, null)).toBe('');
    expect(resolveGmSessionKey('', '  ')).toBe('');
  });

  it('不再自造 conv:<id> 合成键（上游无此约定）', () => {
    expect(resolveGmSessionKey(null, null)).not.toContain('conv:');
  });
});

describe('flattenGmMessageContent（与上游 extractMessageText 对齐）', () => {
  it('字符串原样返回（不 trim，trim 会改变指纹）', () => {
    expect(flattenGmMessageContent('  hello  ')).toBe('  hello  ');
    expect(flattenGmMessageContent('')).toBe('');
  });

  it('文本块数组以 \\n 连接，保留未 trim 的原文', () => {
    expect(flattenGmMessageContent([
      { type: 'text', text: '  a  ' },
      { type: 'text', text: 'b' },
    ])).toBe('  a  \nb');
  });

  it('忽略非文本块，但保留字符串元素', () => {
    expect(flattenGmMessageContent([
      'raw',
      { type: 'tool_use', id: 'x' },
      { type: 'text', text: 'tail' },
    ])).toBe('raw\ntail');
  });

  it('非字符串/非数组内容视为空', () => {
    expect(flattenGmMessageContent(null)).toBe('');
    expect(flattenGmMessageContent(undefined)).toBe('');
    expect(flattenGmMessageContent(42)).toBe('');
    expect(flattenGmMessageContent({ type: 'text', text: 'x' })).toBe('');
  });

  it('块数组经 planGmMessageRows 后参与 id 指纹（两种来源共用同一规则）', () => {
    const blocks = [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }];
    const fromArray = planGmMessageRows([{ role: 'assistant', content: blocks }], 's');
    const fromString = planGmMessageRows([{ role: 'assistant', content: 'line1\nline2' }], 's');
    expect(fromArray.rows[0].content).toBe('line1\nline2');
    expect(fromArray.rows[0].id).toBe(fromString.rows[0].id);
  });
});

describe('planGmMessageRows（与上游 planMessagePersist 对齐）', () => {
  const src = (role: string, content: string): GmMessageSourceRow => ({ role, content });

  it('过滤 system/tool，仅保留 user/assistant 且文本非空', () => {
    const plan = planGmMessageRows(
      [src('user', 'hi'), src('system', 'you are...'), src('assistant', 'ok'), src('tool', '{"a":1}'), src('user', '   ')],
      'sess',
    );
    expect(plan.rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(plan.skippedNonConversational).toBe(2);
    expect(plan.skippedEmpty).toBe(1);
  });

  it('turnIndex 为过滤后的 0 基递增序号（不是「第几个 user 轮」）', () => {
    const plan = planGmMessageRows(
      [src('user', 'u1'), src('assistant', 'a1'), src('user', 'u2'), src('assistant', 'a2')],
      'sess',
    );
    expect(plan.rows.map((r) => r.turnIndex)).toEqual([0, 1, 2, 3]);
  });

  it('同内容同 role 的 occurrence 递增；不同 role 各自独立计数', () => {
    const plan = planGmMessageRows(
      [src('user', '继续'), src('user', '继续'), src('assistant', '继续')],
      'sess',
    );
    expect(plan.rows.map((r) => r.occurrence)).toEqual([0, 1, 0]);
    expect(new Set(plan.rows.map((r) => r.id)).size).toBe(3);
  });

  it('id 使用传入的 sessionKey，且不再包含 sessionId 或 seq 下标', () => {
    const plan = planGmMessageRows([src('user', 'hi')], 'host-session-key');
    const [row] = plan.rows;
    expect(row.id).toBe(buildMessageId('host-session-key', 'user', messageContentHash('hi'), 0));
    expect(row.id.startsWith('gm:host-session-key:user:')).toBe(true);
  });

  it('内容不截断（截断会同时改变指纹与 id，且丢数据）', () => {
    const long = 'y'.repeat(9000);
    const plan = planGmMessageRows([src('user', long)], 's');
    expect(plan.rows[0].content).toBe(long);
    expect(plan.rows[0].id).toContain(messageContentHash(long));
  });

  it('createdAt 由源行透传（上游取宿主消息时间戳，非导入时刻）', () => {
    const plan = planGmMessageRows(
      [{ role: 'user', content: 'hi', createdAt: 1_700_000_000_000 }],
      's',
    );
    expect(plan.rows[0].createdAt).toBe(1_700_000_000_000);
  });

  it('空输入返回空计划', () => {
    const plan = planGmMessageRows([], 's');
    expect(plan.rows).toEqual([]);
    expect(plan.skippedNonConversational).toBe(0);
    expect(plan.skippedEmpty).toBe(0);
  });
});