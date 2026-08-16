/**
 * afterTurn 三元组提取 LLM 配置解析测试（G-MODEL-SYNC）。
 *
 * 验证 resolveLlmConfig 的优先级：
 *   1. 会话级本地主模型快照 → 自建 complete 强制主模型（避免 cron 等后台会话
 *      走 SDK complete 被解析成蒸馏配置模型，造成本地模型反复加载/卸载）
 *   2. 无本地快照时回退 SDK runtimeContext.llm.complete
 *   3. 再回退 resolveDistillationLlm
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const snapshotModule = vi.hoisted(() => ({
  buildLocalLlmComplete: vi.fn((snap: any) => async () => ({ text: 'ok', provider: 'ollama', model: snap.model })),
  getSessionLlmSnapshot: vi.fn(),
  getActiveLocalLlmSnapshot: vi.fn(),
}));

vi.mock('../plugin/distillation.js', () => snapshotModule);

import { resolveLlmConfig } from './experience.js';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    api: { pluginConfig: {} },
    resolveDistillationLlm: () => ({ model: 'fallback-model', baseURL: 'http://x/v1', apiKey: '', keepAlive: '1h' }),
    ...overrides,
  } as any;
}

describe('resolveLlmConfig G-MODEL-SYNC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('会话存在本地主模型快照时，自建 complete 强制主模型（优先于 SDK complete）', () => {
    snapshotModule.getSessionLlmSnapshot.mockReturnValue({ model: 'qwen3.8:27b', baseURL: 'http://127.0.0.1:18789/v1' });
    const sdkComplete = vi.fn();
    const cfg = resolveLlmConfig(
      makeCtx(),
      { sessionKey: 'agent:main:qqbot', runtimeContext: { llm: { complete: sdkComplete } } },
    );

    expect(snapshotModule.buildLocalLlmComplete).toHaveBeenCalled();
    expect(cfg.model).toBe('qwen3.8:27b');
    // 返回的是自建 complete，而非 SDK complete（否则模型会被 SDK 覆盖为配置模型）
    expect(cfg.complete).not.toBe(sdkComplete);
    expect(typeof cfg.complete).toBe('function');
  });

  it('cron 会话（无 sessionKey 快照）时回退到最近活跃本地模型', () => {
    snapshotModule.getSessionLlmSnapshot.mockReturnValue(null);
    snapshotModule.getActiveLocalLlmSnapshot.mockReturnValue({ model: 'qwen3.8:27b', baseURL: null });
    const sdkComplete = vi.fn();
    const cfg = resolveLlmConfig(
      makeCtx(),
      { sessionKey: 'agent:main:cron:abc', runtimeContext: { llm: { complete: sdkComplete } } },
    );

    expect(cfg.model).toBe('qwen3.8:27b');
    expect(cfg.complete).not.toBe(sdkComplete);
  });

  it('无本地快照时回退 SDK runtimeContext.llm.complete', () => {
    snapshotModule.getSessionLlmSnapshot.mockReturnValue(null);
    snapshotModule.getActiveLocalLlmSnapshot.mockReturnValue(null);
    const sdkComplete = vi.fn();
    const cfg = resolveLlmConfig(
      makeCtx(),
      { runtimeContext: { llm: { complete: sdkComplete } } },
    );

    expect(cfg.complete).toBe(sdkComplete);
  });

  it('无本地快照且无 SDK complete 时回退 resolveDistillationLlm', () => {
    snapshotModule.getSessionLlmSnapshot.mockReturnValue(null);
    snapshotModule.getActiveLocalLlmSnapshot.mockReturnValue(null);
    const cfg = resolveLlmConfig(makeCtx(), {});

    expect(cfg.complete).toBeUndefined();
    expect(cfg.model).toBe('fallback-model');
  });
});
