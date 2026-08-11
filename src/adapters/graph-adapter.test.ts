import { describe, it, expect, vi } from 'vitest';
import { GraphAdapter, type GraphAdapterConfig } from './graph-adapter';
import type { Neo4jConfig } from '../types';

const nc: Neo4jConfig = { uri: 'bolt://x:7687', user: 'neo4j', password: 'p' };
const ac: GraphAdapterConfig = { enabled: true, searchLimit: 5 };

// Mock neo4j-driver
vi.mock('neo4j-driver', () => {
  const isInt = (v: any) => typeof v === 'object' && v !== null && 'toNumber' in v;
  return {
    default: {
      driver: vi.fn(),
      auth: { basic: vi.fn().mockReturnValue({}) },
    },
    isInt,
    int: (v: number) => ({ toNumber: () => v }),
  };
});

// Mock connection-pool
vi.mock('./connection-pool', () => ({
  acquireDriver: vi.fn().mockResolvedValue(null),
  releaseDriver: vi.fn().mockResolvedValue(undefined),
}));

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

  describe('health() 重试计数', () => {
    it('driver=null 时多次 health() 失败，_connectRetryCount 应递增而非重置', async () => {
      const a = new GraphAdapter(nc, ac);
      expect((a as any)._connectRetryCount).toBe(0);
      expect((a as any)._connectFailed).toBe(false);

      await a.health();
      const countAfter1 = (a as any)._connectRetryCount;
      expect(countAfter1).toBeGreaterThan(0);

      await a.health();
      const countAfter2 = (a as any)._connectRetryCount;
      expect(countAfter2).toBeGreaterThanOrEqual(countAfter1);
    });

    it('maxRetries 次失败后 _connectFailed 应为 true', async () => {
      const a = new GraphAdapter(nc, ac);
      const maxRetries = (a as any).maxRetries;

      for (let i = 0; i < maxRetries + 1; i++) {
        await a.health();
      }
      expect((a as any)._connectFailed).toBe(true);
    });
  });

  describe('health() gm-pro 懒加载 driver', () => {
    it('mod.getDriver() 后来返回 driver 时，health() 应获取并恢复连接', async () => {
      const a = new GraphAdapter(nc, ac);
      const fakeDriver = { verifyConnectivity: vi.fn().mockResolvedValue(undefined) };
      const fakeRecaller = { setEmbedFn: vi.fn() };
      let driverAvailable = false;

      (a as any).mod = {
        getDriver: () => driverAvailable ? fakeDriver : null,
        Recaller: vi.fn().mockImplementation(() => fakeRecaller),
      };

      expect(await a.health()).toBe(false);
      expect((a as any).driver).toBeNull();

      driverAvailable = true;
      const result = await a.health();
      expect(result).toBe(true);
      expect((a as any).driver).toBe(fakeDriver);
      expect((a as any)._connectFailed).toBe(false);
      expect((a as any)._connectRetryCount).toBe(0);
    });
  });

  // ===================== Recaller 复用（关联矩阵 M 分叉修复）==============

  function makeRecaller() {
    return {
      setEmbedFn: vi.fn(),
      setJudgeManager: vi.fn(),
      setAssociationMatrix: vi.fn(),
      getJudgeManager: vi.fn().mockReturnValue(null),
      getAssociationMatrix: vi.fn().mockReturnValue(null),
    };
  }

  describe('_initRecaller: 复用 gm-pro 模块级 Recaller(A)', () => {
    it('getRecaller 命中时复用 A，不 new Recaller，_recallerFromGmPro=true', async () => {
      const a = new GraphAdapter(nc, ac);
      const shared = makeRecaller();
      const RecallerCtor = vi.fn();
      (a as any).mod = {
        getRecaller: vi.fn().mockReturnValue(shared),
        Recaller: RecallerCtor,
      };
      (a as any).driver = {};

      await (a as any)._initRecaller();

      expect((a as any)._recaller).toBe(shared);
      expect((a as any)._recallerFromGmPro).toBe(true);
      expect(RecallerCtor).not.toHaveBeenCalled();
    });

    it('getRecaller 返回 null 时回退自建 B，_recallerFromGmPro=false', async () => {
      const a = new GraphAdapter(nc, ac);
      const selfBuilt = makeRecaller();
      const RecallerCtor = vi.fn().mockImplementation(() => selfBuilt);
      (a as any).mod = {
        // 5×300ms 轮询后仍返回 null → 触发自建兜底
        getRecaller: vi.fn().mockReturnValue(null),
        Recaller: RecallerCtor,
      };
      (a as any).driver = {};

      await (a as any)._initRecaller();

      expect((a as any)._recallerFromGmPro).toBe(false);
      expect(RecallerCtor).toHaveBeenCalledTimes(1);
      expect((a as any)._recaller).toBe(selfBuilt);
    });

    it('gm-pro 未导出 getRecaller 时回退自建 B', async () => {
      const a = new GraphAdapter(nc, ac);
      const selfBuilt = makeRecaller();
      const RecallerCtor = vi.fn().mockImplementation(() => selfBuilt);
      (a as any).mod = { Recaller: RecallerCtor };
      (a as any).driver = {};

      await (a as any)._initRecaller();

      expect((a as any)._recallerFromGmPro).toBe(false);
      expect(RecallerCtor).toHaveBeenCalledTimes(1);
    });

    it('复用 A 时复用其已有的 JudgeManager / AssociationMatrix（不重复注入）', async () => {
      const a = new GraphAdapter(nc, { ...ac, associationMatrix: { enabled: true } });
      const judge = { tier: 1 };
      const am = { isEnabled: () => true };
      const shared = {
        setEmbedFn: vi.fn(),
        setJudgeManager: vi.fn(),
        setAssociationMatrix: vi.fn(),
        getJudgeManager: vi.fn().mockReturnValue(judge),
        getAssociationMatrix: vi.fn().mockReturnValue(am),
      };
      (a as any).mod = { getRecaller: vi.fn().mockReturnValue(shared) };
      (a as any).driver = {};

      await (a as any)._initRecaller();

      expect((a as any)._judgeManager).toBe(judge);
      expect((a as any)._associationMatrix).toBe(am);
      expect(shared.setJudgeManager).not.toHaveBeenCalled();
      expect(shared.setAssociationMatrix).not.toHaveBeenCalled();
    });
  });

  describe('_ensureRecaller: 幂等（不重复 new）', () => {
    it('_recaller 已存在时直接返回，不重复初始化', async () => {
      const a = new GraphAdapter(nc, ac);
      const existing = makeRecaller();
      (a as any)._recaller = existing;
      const initSpy = vi.spyOn(a as any, '_initRecaller');

      await (a as any)._ensureRecaller();

      expect(initSpy).not.toHaveBeenCalled();
      expect((a as any)._recaller).toBe(existing);
    });

    it('_recaller 不存在但 mod/driver 完整时初始化一次', async () => {
      const a = new GraphAdapter(nc, ac);
      const initSpy = vi.spyOn(a as any, '_initRecaller').mockResolvedValue(undefined);
      (a as any).mod = {};
      (a as any).driver = {};

      await (a as any)._ensureRecaller();

      expect(initSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===================== _withSession 重试机制 ========================

  describe('_withSession: session 重试机制', () => {
    it('session 操作成功时正常返回结果', async () => {
      const a = new GraphAdapter(nc, ac);
      const mockSession = {
        run: vi.fn().mockResolvedValue({ records: [] }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockDriver = {
        session: vi.fn().mockReturnValue(mockSession),
        verifyConnectivity: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (a as any).driver = mockDriver;

      const result = await (a as any)._withSession('test', async (session: any) => {
        return await session.run('RETURN 1');
      });

      expect(result).toEqual({ records: [] });
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('连接错误时触发恢复并重试一次', async () => {
      const a = new GraphAdapter(nc, ac);

      const mockSessionFail = {
        run: vi.fn().mockRejectedValue(new Error('session closed')),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockSessionSuccess = {
        run: vi.fn().mockResolvedValue({ records: [{ toObject: () => ({ n: 1 }) }] }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDriver = {
        session: vi.fn()
          .mockReturnValueOnce(mockSessionFail)
          .mockReturnValueOnce(mockSessionSuccess),
        verifyConnectivity: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (a as any).driver = mockDriver;
      // Mock _tryRecoverConnection 返回 true 以触发重试
      (a as any)._tryRecoverConnection = vi.fn().mockResolvedValue(true);

      const result = await (a as any)._withSession('test-retry', async (session: any) => {
        return await session.run('RETURN 1');
      });

      expect(result).toBeDefined();
      // 应调用了两次 session()（第一次失败 + 重试）
      expect(mockDriver.session).toHaveBeenCalledTimes(2);
    });

    it('重试后仍失败则抛出错误', async () => {
      const a = new GraphAdapter(nc, ac);

      const mockSession = {
        run: vi.fn().mockRejectedValue(new Error('session closed')),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockDriver = {
        session: vi.fn().mockReturnValue(mockSession),
        verifyConnectivity: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (a as any).driver = mockDriver;

      await expect(
        (a as any)._withSession('test-fail', async (session: any) => {
          return await session.run('RETURN 1');
        }),
      ).rejects.toThrow('session closed');
    });

    it('driver 未初始化时抛出错误', async () => {
      const a = new GraphAdapter(nc, ac);
      (a as any).driver = null;

      await expect(
        (a as any)._withSession('test-no-driver', async () => {}),
      ).rejects.toThrow('Neo4j driver not initialized');
    });

    it('异常时 session 被正确关闭', async () => {
      const a = new GraphAdapter(nc, ac);
      const mockSession = {
        run: vi.fn().mockRejectedValue(new Error('query failed')),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockDriver = {
        session: vi.fn().mockReturnValue(mockSession),
        verifyConnectivity: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      (a as any).driver = mockDriver;

      await expect(
        (a as any)._withSession('test-close', async (session: any) => {
          return await session.run('RETURN 1');
        }),
      ).rejects.toThrow('query failed');

      // session.close() 在 finally 块中被调用
      expect(mockSession.close).toHaveBeenCalled();
    });
  });
});
