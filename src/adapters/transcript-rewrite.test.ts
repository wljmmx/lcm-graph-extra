import { describe, it, expect, afterEach } from 'vitest';
import {
  probeTranscriptRewriteCapability,
  readVisibleTranscriptEntries,
  summarizeTranscriptEntries,
  detectReplayCheckpointEntries,
  buildReplayStripReplacements,
  isTranscriptRewriteEnabled,
  TRANSCRIPT_REWRITE_MAX_ENTRIES,
  COMPACTION_REPLAY_TYPES,
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

/**
 * P2 observe-only：量化「若调用 rewriteTranscriptEntries 剥离 providerReplay 能释放多少」。
 * 判据与字节公式**均复刻宿主实现**（session-DitLEF2L.mjs / transcript-rewrite-BTqyiENC.mjs），
 * 不自造标准 —— 否则会得出与实际改写不一致的收益估算。
 */
describe('detectReplayCheckpointEntries（P2 观察项，纯函数）', () => {
  it('判据取自宿主：仅 assistant + 三类 provider 压缩回放 type', () => {
    expect(COMPACTION_REPLAY_TYPES).toEqual([
      'anthropic-compaction',
      'openai-responses-compaction',
      'openai-responses-retained-compaction',
    ]);

    const entries: VisibleTranscriptEntry[] = [
      // 命中：assistant + 合法 type
      { entryId: 'hit-1', message: { role: 'assistant', providerReplay: { type: 'anthropic-compaction', x: 1 } } },
      // 不命中：user 角色（宿主第一道条件仅 assistant）
      { entryId: 'miss-role', message: { role: 'user', providerReplay: { type: 'anthropic-compaction' } } },
      // 不命中：type 不在宿主白名单
      { entryId: 'miss-type', message: { role: 'assistant', providerReplay: { type: 'other' } } },
      // 不命中：无 providerReplay
      { entryId: 'miss-none', message: { role: 'assistant' } },
    ];

    const report = detectReplayCheckpointEntries(entries);
    expect(report.count).toBe(1);
    expect(report.entryIds).toEqual(['hit-1']);
    expect(report.estimatedBytesFreed).toBeGreaterThan(0);
  });

  it('字节估算与宿主同款公式：byteLength(原 JSON) - byteLength(剥离后 JSON)', () => {
    const message = { role: 'assistant', providerReplay: { type: 'openai-responses-compaction', blob: 'y'.repeat(64) } };
    const stripped = { ...message } as Record<string, unknown>;
    delete stripped.providerReplay;
    const expected =
      Buffer.byteLength(JSON.stringify(message)) - Buffer.byteLength(JSON.stringify(stripped));

    const report = detectReplayCheckpointEntries([{ entryId: 'e1', message }]);
    expect(report.estimatedBytesFreed).toBe(expected);
  });

  it('无命中时返回全零（长期为 0 即说明该宿主路径无需启用写入能力）', () => {
    const report = detectReplayCheckpointEntries([
      { entryId: 'a', message: { role: 'assistant' } },
      { entryId: 'b', message: { role: 'user' } },
    ]);
    expect(report).toEqual({ count: 0, entryIds: [], estimatedBytesFreed: 0 });
  });
});

/**
 * P4：受控写入（opt-out：默认开启）。
 * 关键性质：① 默认执行，仅 `LCMG_TRANSCRIPT_REWRITE=off` 关闭；② 替换内容 = 剥离 providerReplay 的副本；③ 有上限；
 * ④ **天然幂等** —— 剥离后条目不再携带 providerReplay，再次检测必然为 0。
 */
describe('isTranscriptRewriteEnabled（P4 开关，opt-out：默认开启）', () => {
  const original = process.env.LCMG_TRANSCRIPT_REWRITE;
  afterEach(() => {
    if (original === undefined) delete process.env.LCMG_TRANSCRIPT_REWRITE;
    else process.env.LCMG_TRANSCRIPT_REWRITE = original;
  });

  it('未设置 → 开启（默认执行剥离写入）', () => {
    delete process.env.LCMG_TRANSCRIPT_REWRITE;
    expect(isTranscriptRewriteEnabled()).toBe(true);
  });

  it('仅显式 off 才关闭（大小写/空白容忍）', () => {
    process.env.LCMG_TRANSCRIPT_REWRITE = 'off';
    expect(isTranscriptRewriteEnabled()).toBe(false);
    process.env.LCMG_TRANSCRIPT_REWRITE = '  OFF  ';
    expect(isTranscriptRewriteEnabled()).toBe(false);
  });

  it('其他值/空串均视为开启（只认 off 为关闭）', () => {
    process.env.LCMG_TRANSCRIPT_REWRITE = 'on';
    expect(isTranscriptRewriteEnabled()).toBe(true);
    process.env.LCMG_TRANSCRIPT_REWRITE = 'true';
    expect(isTranscriptRewriteEnabled()).toBe(true);
    process.env.LCMG_TRANSCRIPT_REWRITE = 'enforce';
    expect(isTranscriptRewriteEnabled()).toBe(true);
    process.env.LCMG_TRANSCRIPT_REWRITE = '';
    expect(isTranscriptRewriteEnabled()).toBe(true);
  });
});

describe('buildReplayStripReplacements（P4 构造，纯函数）', () => {
  it('替换内容为剥离 providerReplay 的副本，且不修改原消息', () => {
    const message = { role: 'assistant', providerReplay: { type: 'anthropic-compaction' }, text: 'hi' };
    const plan = buildReplayStripReplacements([{ entryId: 'e1', message }]);
    expect(plan.count).toBe(1);
    expect(plan.replacements[0].entryId).toBe('e1');
    expect(plan.replacements[0].message).toEqual({ role: 'assistant', text: 'hi' });
    // 原对象不得被就地修改
    expect((message as Record<string, unknown>).providerReplay).toEqual({ type: 'anthropic-compaction' });
  });

  it('仅纳入宿主判据命中的条目（assistant + 白名单 type）', () => {
    const plan = buildReplayStripReplacements([
      { entryId: 'hit', message: { role: 'assistant', providerReplay: { type: 'openai-responses-compaction' } } },
      { entryId: 'user-role', message: { role: 'user', providerReplay: { type: 'openai-responses-compaction' } } },
      { entryId: 'bad-type', message: { role: 'assistant', providerReplay: { type: 'nope' } } },
      { entryId: 'no-replay', message: { role: 'assistant' } },
    ]);
    expect(plan.replacements.map((r) => r.entryId)).toEqual(['hit']);
    expect(plan.truncated).toBe(0);
  });

  it('受上限截断，且如实报告 truncated（避免一次改动过多条目）', () => {
    const many: VisibleTranscriptEntry[] = Array.from({ length: 5 }, (_, i) => ({
      entryId: `e${i}`,
      message: { role: 'assistant', providerReplay: { type: 'anthropic-compaction' } },
    }));
    const plan = buildReplayStripReplacements(many, 2);
    expect(plan.count).toBe(2);
    expect(plan.truncated).toBe(3);
    expect(TRANSCRIPT_REWRITE_MAX_ENTRIES).toBeGreaterThan(0);
  });

  it('天然幂等：剥离后的消息再次检测不再命中', () => {
    const message = { role: 'assistant', providerReplay: { type: 'anthropic-compaction' } };
    const plan = buildReplayStripReplacements([{ entryId: 'e1', message }]);
    // 用改写后的消息重建条目 → 第二次检测必须为 0，说明不会重复改写
    const after: VisibleTranscriptEntry[] = [{ entryId: 'e1', message: plan.replacements[0].message }];
    expect(detectReplayCheckpointEntries(after).count).toBe(0);
  });
});
