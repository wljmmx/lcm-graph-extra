import { describe, it, expect, vi } from 'vitest';
import { GraphAdapter, type GraphAdapterConfig } from './graph-adapter';
import type { Neo4jConfig } from '../types';

const nc: Neo4jConfig = { uri: 'bolt://x:7687', user: 'neo4j', password: 'p' };
const ac: GraphAdapterConfig = { enabled: true, searchLimit: 5 };

describe('GraphAdapter', () => {
  it('returns empty when disabled', async () => {
    const a = new GraphAdapter(nc, { ...ac, enabled: false });
    expect(await a.search('t')).toEqual([]);
    expect(await a.searchExperience('t')).toEqual([]);
  });
  it('search returns empty when no server', async () => {
    const a = new GraphAdapter(nc, ac);
    expect(await a.search('t')).toEqual([]);
  });
  it('health false when not connected', async () => {
    const a = new GraphAdapter(nc, ac);
    expect(await a.health()).toBe(false);
  });

  // ─── buildLlmFn 优先用 SDK runtimeContext.llm.complete ───────────────
  // SDK 在 runtimeContext.llm.complete 提供已认证的 LLM 调用能力，
  // buildLlmFn 应优先用它包装成 (system, user) => Promise<string>，
  // 而不是用 apiKey/baseURL 自建 fetch。

  it('extractAndUpsertFromTurn 优先用 SDK complete 函数而非自建 fetch', async () => {
    const a = new GraphAdapter(nc, ac);
    // 模拟 gm-pro 模块已加载 + extractTriplets 可用
    // extractTriplets 真实实现会调用 llmFn(system, user)，这里模拟调用以触发 SDK complete
    const fakeExtractTriplets = vi.fn(async (llmFn: any, _user: string, _assistant: string) => {
      // 模拟 extractTriplets 内部调用 llmFn
      await llmFn('system prompt', 'user prompt');
      return { nodes: [], edges: [] };
    });
    (a as any).mod = { extractTriplets: fakeExtractTriplets };

    const sdkComplete = vi.fn().mockResolvedValue({
      text: 'LLM response from SDK',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });

    await a.extractAndUpsertFromTurn(
      { complete: sdkComplete, model: 'fallback-model' },
      'user text',
      'assistant text',
    );

    // SDK complete 应被调用（通过 extractTriplets 内部 llmFn 调用触发）
    expect(sdkComplete).toHaveBeenCalledTimes(1);
    const callArgs = sdkComplete.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(2);
    expect(callArgs.messages[0].role).toBe('system');
    expect(callArgs.messages[1].role).toBe('user');
    expect(callArgs.purpose).toBe('lcm-graph-extra:triplet-extraction');
    expect(callArgs.maxTokens).toBe(1024);
    expect(callArgs.temperature).toBe(0.3);
  });

  it('extractAndUpsertFromTurn 无 complete 时回退到 apiKey/baseURL 模式', async () => {
    const a = new GraphAdapter(nc, ac);
    const fakeExtractTriplets = vi.fn().mockResolvedValue({ nodes: [], edges: [] });
    (a as any).mod = { extractTriplets: fakeExtractTriplets };

    // 无 complete 字段，仅有 apiKey/baseURL/model
    await a.extractAndUpsertFromTurn(
      { apiKey: 'sk-test', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      'user text',
      'assistant text',
    );

    expect(fakeExtractTriplets).toHaveBeenCalledTimes(1);
    // extractTriplets 收到的 llmFn 应是自建 fetch 的版本（非 SDK 包装）
    const llmFn = fakeExtractTriplets.mock.calls[0][0];
    expect(typeof llmFn).toBe('function');
  });

  it('extractAndUpsertFromTurn 既无 complete 也无 apiKey/model 时返回空', async () => {
    const a = new GraphAdapter(nc, ac);
    (a as any).mod = { extractTriplets: vi.fn() };

    const result = await a.extractAndUpsertFromTurn(
      {} as any,
      'user text',
      'assistant text',
    );
    expect(result).toEqual({ nodes: 0, edges: 0 });
  });
});
