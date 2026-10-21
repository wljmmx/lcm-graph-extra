/**
 * Harnessing P4: distillOne 内容寻址缓存集成测试（mock LLM）。
 * 验证：同内容第二次蒸馏不再调用 LLM，产物派生字段一致、身份字段重新生成。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/llm-call.js', () => ({
  callLlm: vi.fn(),
  isLocalLlm: vi.fn(() => false),
}));

import { callLlm } from '../utils/llm-call.js';
import { distillOne } from './distillation.js';
import { clearDistillCache, getDistillCacheStats } from './distill-cache.js';

const mockedCall = vi.mocked(callLlm);

const LLM = { model: 'test-model', apiKey: 'k', baseURL: 'http://localhost' };
const RAW = { id: 'raw-1', source: 'failure', context: '压缩超时', detail: 'compact 超过 30s 未返回，命令执行失败 exit code 1' };

beforeEach(() => {
  clearDistillCache();
  mockedCall.mockReset();
  delete process.env.LCMG_DISTILL_CACHE;
});

describe('distillOne × 内容寻址缓存（P4）', () => {
  it('第一次实时蒸馏（调 LLM + 写缓存）；第二次命中缓存（零 LLM）', async () => {
    mockedCall.mockResolvedValueOnce({
      text: JSON.stringify({
        title: '压缩超时处理',
        summary: '压缩超时应先降级为直读',
        type: 'fix',
        relevanceScore: 0.8,
        freeTags: ['compaction'],
        relatedConcepts: ['compaction', 'timeout'],
      }),
    });

    const a1 = await distillOne(RAW, LLM);
    expect(a1).not.toBeNull();
    expect(mockedCall).toHaveBeenCalledTimes(1);

    const a2 = await distillOne(RAW, LLM);
    expect(mockedCall).toHaveBeenCalledTimes(1); // 第二次零 LLM
    expect(a2).not.toBeNull();
    // 派生字段一致（来自缓存）
    expect(a2!.title).toBe(a1!.title);
    expect(a2!.summary).toBe(a1!.summary);
    expect(a2!.type).toBe(a1!.type);
    expect(a2!.relevanceScore).toBe(a1!.relevanceScore);
    expect(a2!.relatedConcepts).toEqual(a1!.relatedConcepts);
    // 身份字段重新生成（不共享 id）
    expect(a2!.id).not.toBe(a1!.id);
    expect(a2!.rawIds).toEqual(['raw-1']);
    expect(a2!.matchCount).toBe(0);
    // stats 如实
    const s = getDistillCacheStats();
    expect(s.hits).toBe(1);
    expect(s.stores).toBe(1);
  });

  it('LCMG_DISTILL_CACHE=off → 每次都实时蒸馏', async () => {
    process.env.LCMG_DISTILL_CACHE = 'off';
    mockedCall.mockResolvedValue({
      text: JSON.stringify({ title: 't', summary: 's', type: 'lesson', relevanceScore: 0.5 }),
    });
    await distillOne(RAW, LLM);
    await distillOne(RAW, LLM);
    expect(mockedCall).toHaveBeenCalledTimes(2);
  });

  it('不同内容 → 不同键，各自实时蒸馏', async () => {
    mockedCall.mockResolvedValue({
      text: JSON.stringify({ title: 't', summary: 's', type: 'lesson', relevanceScore: 0.5 }),
    });
    await distillOne(RAW, LLM);
    await distillOne({ ...RAW, id: 'raw-2', detail: '完全不同的失败内容' }, LLM);
    expect(mockedCall).toHaveBeenCalledTimes(2);
  });
});
