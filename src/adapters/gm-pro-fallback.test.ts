/**
 * gm-pro-fallback 单元测试
 *
 * 覆盖：
 * - probeGmPro: 模块不存在 / 模块存在且有 runMaintenance|Recaller|searchNodes / 模块存在但缺少关键 API / 幂等性
 * - withGmProFallback: 不可用走 fallback / API 缺失走 fallback / 正常走 gm-pro / gm-pro 抛异常走 fallback
 * - _resetGmProProbe: 重置后可重新探测，重置后 source/mod 恢复初始值
 * - _hasApi: 顶层函数检查 / dot 路径嵌套检查 / 非函数值 / 中间值为 null（间接通过 withGmProFallback 测试）
 * - 类型定义验证: 新增的 consolidateBuffer/linkNodes/markDirty/incrementalMaintain 等类型契约
 *
 * Mock 策略：
 * - resolveGmProPath 通过 vi.mock 持久 mock（返回 mockState.path 控制的路径）
 * - dynamic import('.../dist/index.js') 通过 vi.mock 持久 mock，factory 返回 Proxy：
 *   - get trap 始终读取 mockState.mod[key]，确保 delete/赋值对后续属性访问可见
 *   - has trap 对所有 string key 返回 true，防止 vitest mock module Proxy 在
 *     _hasApi 执行 mod[apiName]（apiName 含 dot 如 'Recaller.prototype.recall'）
 *     时抛出 "No export is defined" 错误（真实 ESM namespace 返回 undefined）
 * - mockState.mod 为可变对象，测试通过 delete/赋值控制模块 API 形态
 * - vi.hoisted 保证 mockState 在 vi.mock factory 执行前已初始化
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ConsolidateBufferParams,
  ConsolidateBufferResult,
  LinkNodesParams,
  LinkNodesResult,
  MarkDirtyParams,
  IncrementalMaintainParams,
  IncrementalMaintainResult,
  GmNode,
  JudgeRecallParams,
  JudgeRecallResult,
  UpsertFeedbackParams,
  GetNodesByTimeRangeParams,
  TimeRangeNode,
  EvolveNodeParams,
  EvolveNodeResult,
  GraphHealthSnapshot,
} from './gm-pro-fallback.js';

// ─── Mock 状态控制 ─────────────────────────────────────────────────────────
// vi.hoisted 保证 mockState 在 vi.mock factory 执行前已初始化
const mockState = vi.hoisted(() => {
  const mod: Record<string, any> = {
    // probeGmPro 识别函数（三选一即可标记为可用）
    runMaintenance: () => {},
    Recaller: () => {},
    searchNodes: () => {},
    // 扩展 API（供 withGmProFallback 调用）
    consolidateBuffer: () => {},
    linkNodes: () => {},
    markDirty: () => {},
    incrementalMaintain: () => {},
    judgeRecall: () => {},
    upsertFeedback: () => {},
    getNodesByTimeRange: () => {},
    evolveNode: () => {},
    getGraphHealth: () => {},
  };
  return {
    // resolveGmProPath 返回的路径；改为不存在的路径可让 dynamic import 失败
    path: '/test-fake-gm-pro',
    // 动态 import 返回的模块对象（同一引用，测试可 mutate 模拟不同 API 形态）
    mod,
  };
});

// Mock graph-adapter.js 的 resolveGmProPath（gm-pro-fallback 唯一外部依赖）
vi.mock('./graph-adapter.js', () => ({
  resolveGmProPath: () => ({ path: mockState.path, source: 'env' as const }),
}));

// Mock 动态 import('/test-fake-gm-pro/dist/index.js')
// 使用 Proxy 保证：
// - get: 始终读取 mockState.mod[key] 的最新状态（live，delete/赋值对后续访问可见）
// - has: 对所有 string key 返回 true，防止 vitest mock module Proxy 在
//        _hasApi 执行 mod[apiName]（apiName 含 dot 如 'Recaller.prototype.recall'）
//        时抛出 "No export is defined" 错误（真实 ESM namespace 对未定义 export 返回 undefined）
vi.mock('/test-fake-gm-pro/dist/index.js', () => {
  return new Proxy({}, {
    has() {
      return true;
    },
    get(_t, prop) {
      if (typeof prop === 'string') {
        return mockState.mod[prop];
      }
      return undefined;
    },
  });
});

// Mock capability-profiles.js：测试中所有 API 都视为已启用（绕过能力档次检查，
// 避免默认 'balanced' 档次仅启用 judgeRecall/getGraphHealth 导致其余 API 走 fallback）
vi.mock('../capability-profiles.js', () => ({
  isApiEnabled: vi.fn(() => true),
  getCurrentProfile: vi.fn(() => ({ enabledApis: [], features: {} })),
}));

// 测试用 logger（验证 debug 日志在异常路径被调用）
const testLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** 恢复 mod 到完整状态（beforeEach 调用，确保测试隔离） */
function restoreMod(): void {
  mockState.mod.runMaintenance = () => {};
  mockState.mod.Recaller = () => {};
  mockState.mod.searchNodes = () => {};
  mockState.mod.consolidateBuffer = () => {};
  mockState.mod.linkNodes = () => {};
  mockState.mod.markDirty = () => {};
  mockState.mod.incrementalMaintain = () => {};
  mockState.mod.judgeRecall = () => {};
  mockState.mod.upsertFeedback = () => {};
  mockState.mod.getNodesByTimeRange = () => {};
  mockState.mod.evolveNode = () => {};
  mockState.mod.getGraphHealth = () => {};
}

describe('gm-pro-fallback', () => {
  // 动态导入的测试目标引用（每个 beforeEach 重新导入以获取全新实例）
  let probeGmPro: typeof import('./gm-pro-fallback.js').probeGmPro;
  let withGmProFallback: typeof import('./gm-pro-fallback.js').withGmProFallback;
  let _resetGmProProbe: typeof import('./gm-pro-fallback.js')._resetGmProProbe;
  let getGmProMod: typeof import('./gm-pro-fallback.js').getGmProMod;
  let getGmProSource: typeof import('./gm-pro-fallback.js').getGmProSource;

  beforeEach(async () => {
    // 重置模块缓存，确保 gm-pro-fallback.js 获取全新模块实例（内部状态重置）
    vi.resetModules();
    // 重新导入测试目标，获取全新模块实例（_gmProProbed 等内部状态重置）
    // vi.mock 已在顶层注册，vi.resetModules 不会清除 vi.mock 注册的 mock
    const fresh = await import('./gm-pro-fallback.js');
    probeGmPro = fresh.probeGmPro;
    withGmProFallback = fresh.withGmProFallback;
    _resetGmProProbe = fresh._resetGmProProbe;
    getGmProMod = fresh.getGmProMod;
    getGmProSource = fresh.getGmProSource;

    // 重置状态
    _resetGmProProbe();
    mockState.path = '/test-fake-gm-pro';
    restoreMod();
    testLogger.debug.mockClear();
    testLogger.info.mockClear();
    testLogger.warn.mockClear();
    testLogger.error.mockClear();
  });

  // ─── probeGmPro ─────────────────────────────────────────────────────────

  describe('probeGmPro', () => {
    it('模块不存在（import 失败）时返回 false', async () => {
      mockState.path = '/__non_existent_gm_pro_path__';
      const result = await probeGmPro();
      expect(result).toBe(false);
      expect(getGmProMod()).toBeNull();
    });

    it('模块存在且有 runMaintenance 时返回 true', async () => {
      // 仅保留 runMaintenance，删除另两个识别函数
      delete mockState.mod.Recaller;
      delete mockState.mod.searchNodes;
      const result = await probeGmPro();
      expect(result).toBe(true);
      expect(getGmProMod()).not.toBeNull();
      expect(getGmProSource()).toBe('env');
    });

    it('模块存在且有 Recaller 时返回 true', async () => {
      delete mockState.mod.runMaintenance;
      delete mockState.mod.searchNodes;
      const result = await probeGmPro();
      expect(result).toBe(true);
    });

    it('模块存在且有 searchNodes 时返回 true', async () => {
      delete mockState.mod.runMaintenance;
      delete mockState.mod.Recaller;
      const result = await probeGmPro();
      expect(result).toBe(true);
    });

    it('模块存在但缺少所有三个识别函数时返回 false', async () => {
      delete mockState.mod.runMaintenance;
      delete mockState.mod.Recaller;
      delete mockState.mod.searchNodes;
      const result = await probeGmPro();
      expect(result).toBe(false);
      expect(getGmProMod()).toBeNull();
    });

    it('探测结果幂等：第二次调用不重新 import', async () => {
      const result1 = await probeGmPro();
      // 第二次调用前删除所有识别函数
      delete mockState.mod.runMaintenance;
      delete mockState.mod.Recaller;
      delete mockState.mod.searchNodes;
      const result2 = await probeGmPro();
      // 第一次 true，第二次应返回缓存结果 true（不重新 import）
      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    it('getGmProSource 返回 resolveGmProPath 的 source', async () => {
      await probeGmPro();
      expect(getGmProSource()).toBe('env');
    });
  });

  // ─── withGmProFallback ──────────────────────────────────────────────────

  describe('withGmProFallback', () => {
    it('gm-pro 不可用时走 fallback', async () => {
      mockState.path = '/__non_existent_gm_pro_path__';
      const fallback = vi.fn().mockResolvedValue('fallback-result');
      const result = await withGmProFallback(
        'someApi',
        async () => 'gm-pro-result',
        fallback,
        { logger: testLogger as any },
      );
      expect(result).toBe('fallback-result');
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('gm-pro 可用但 API 缺失时走 fallback', async () => {
      // 模块可用（有 runMaintenance），但调用的 API 不存在
      const fallback = vi.fn().mockResolvedValue('fallback-result');
      const result = await withGmProFallback(
        'someMissingApi',
        async () => 'gm-pro-result',
        fallback,
        { logger: testLogger as any },
      );
      expect(result).toBe('fallback-result');
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('gm-pro 可用且 API 存在时走 gm-pro', async () => {
      mockState.mod.consolidateBuffer = vi.fn().mockResolvedValue({ consolidatedIds: ['n1'] });
      const fallback = vi.fn().mockResolvedValue('fallback-should-not-be-called');
      const result = await withGmProFallback(
        'consolidateBuffer',
        async (mod) => mod.consolidateBuffer({ nodes: [] }),
        fallback,
        { logger: testLogger as any },
      );
      expect(result).toEqual({ consolidatedIds: ['n1'] });
      expect(fallback).not.toHaveBeenCalled();
    });

    it('gm-pro 调用抛异常时走 fallback', async () => {
      mockState.mod.consolidateBuffer = vi.fn().mockRejectedValue(new Error('gm-pro boom'));
      const fallback = vi.fn().mockResolvedValue('fallback-result');
      const result = await withGmProFallback(
        'consolidateBuffer',
        async (mod) => mod.consolidateBuffer({ nodes: [] }),
        fallback,
        { logger: testLogger as any },
      );
      expect(result).toBe('fallback-result');
      expect(fallback).toHaveBeenCalledTimes(1);
      // 异常路径应记录 debug 日志
      expect(testLogger.debug).toHaveBeenCalledTimes(1);
      const [msg, ctx] = testLogger.debug.mock.calls[0];
      expect(msg).toContain('consolidateBuffer');
      expect(msg).toContain('falling back');
      expect(ctx).toHaveProperty('err');
    });

    it('label 自定义覆盖 apiName 出现在日志中', async () => {
      mockState.mod.consolidateBuffer = vi.fn().mockRejectedValue(new Error('boom'));
      await withGmProFallback(
        'consolidateBuffer',
        async (mod) => mod.consolidateBuffer({ nodes: [] }),
        async () => 'fallback',
        { logger: testLogger as any, label: 'my-custom-label' },
      );
      expect(testLogger.debug).toHaveBeenCalledTimes(1);
      expect(testLogger.debug.mock.calls[0][0]).toContain('my-custom-label');
    });

    it('gm-pro 抛异常时 fallback 返回值正确传递', async () => {
      mockState.mod.linkNodes = vi.fn().mockRejectedValue(new Error('link boom'));
      const fallback = vi.fn().mockResolvedValue({ created: false, reason: 'fallback' });
      const result = await withGmProFallback(
        'linkNodes',
        async (mod) => mod.linkNodes({ fromId: 'a', toId: 'b', type: 'RELATED_TO' }),
        fallback,
        { logger: testLogger as any },
      );
      expect(result).toEqual({ created: false, reason: 'fallback' });
    });

    it('gm-pro 不可用时不记录 debug 日志（无异常）', async () => {
      mockState.path = '/__non_existent_gm_pro_path__';
      await withGmProFallback(
        'someApi',
        async () => 'gm-pro',
        async () => 'fallback',
        { logger: testLogger as any },
      );
      expect(testLogger.debug).not.toHaveBeenCalled();
    });

    it('opts.logger 未提供时使用默认 logger 不抛错', async () => {
      mockState.path = '/__non_existent_gm_pro_path__';
      const result = await withGmProFallback(
        'someApi',
        async () => 'gm-pro',
        async () => 'fallback',
      );
      expect(result).toBe('fallback');
    });

    it('fallbackFn 返回同步值（非 Promise）正确处理', async () => {
      // gm-pro 可用但 API 缺失，走 fallback
      const result = await withGmProFallback(
        'someMissingApi',
        async () => 'gm-pro',
        () => 'sync-fallback',
      );
      expect(result).toBe('sync-fallback');
    });

    it('gmProFn 接收已加载的 mod 作为参数', async () => {
      mockState.mod.judgeRecall = vi.fn().mockResolvedValue('ok');
      const gmProFn = vi.fn(async (mod: any) => mod.judgeRecall({ query: 'q', recalledNodeIds: [] }));
      await withGmProFallback('judgeRecall', gmProFn, async () => 'fallback', {
        logger: testLogger as any,
      });
      expect(gmProFn).toHaveBeenCalledTimes(1);
      const passedMod = gmProFn.mock.calls[0][0];
      // mod 是模块命名空间（通过 getter 访问），其 judgeRecall 应返回 mockState.mod.judgeRecall
      expect(passedMod.judgeRecall).toBe(mockState.mod.judgeRecall);
      expect(mockState.mod.judgeRecall).toHaveBeenCalledTimes(1);
    });
  });

  // ─── _resetGmProProbe ───────────────────────────────────────────────────

  describe('_resetGmProProbe', () => {
    it('重置后 getGmProMod 返回 null', async () => {
      await probeGmPro();
      expect(getGmProMod()).not.toBeNull();
      _resetGmProProbe();
      expect(getGmProMod()).toBeNull();
    });

    it('重置后 getGmProSource 恢复默认 extensions-global', async () => {
      await probeGmPro();
      expect(getGmProSource()).toBe('env');
      _resetGmProProbe();
      expect(getGmProSource()).toBe('extensions-global');
    });

    it('重置后可重新探测（之前可用变为可用）', async () => {
      const r1 = await probeGmPro();
      expect(r1).toBe(true);
      _resetGmProProbe();
      const r2 = await probeGmPro();
      expect(r2).toBe(true);
      expect(getGmProMod()).not.toBeNull();
    });

    it('重置后可重新探测（之前不可用变为可用）', async () => {
      // 第一次：模块不可用
      mockState.path = '/__non_existent_gm_pro_path__';
      const r1 = await probeGmPro();
      expect(r1).toBe(false);

      // 重置后改为可用路径
      _resetGmProProbe();
      mockState.path = '/test-fake-gm-pro';
      const r2 = await probeGmPro();
      expect(r2).toBe(true);
    });

    it('重置后再次探测会重新执行 import（_gmProProbed 被重置）', async () => {
      // 第一次探测：模块有 runMaintenance
      delete mockState.mod.Recaller;
      delete mockState.mod.searchNodes;
      const r1 = await probeGmPro();
      expect(r1).toBe(true);

      // 重置
      _resetGmProProbe();

      // 删除所有识别函数，模拟模块变化
      delete mockState.mod.runMaintenance;
      const r2 = await probeGmPro();
      // 现在 mod 没有任何识别函数，应返回 false（重新 import 检测到变化）
      expect(r2).toBe(false);
    });
  });

  // ─── _hasApi（间接测试，通过 withGmProFallback 触发） ──────────────────

  describe('_hasApi (间接通过 withGmProFallback 测试)', () => {
    it('API 存在（顶层函数）时走 gm-pro', async () => {
      mockState.mod.judgeRecall = vi.fn().mockResolvedValue({
        judgments: [],
        tier1Confidence: 0.9,
      });
      const fallback = vi.fn();
      const result = await withGmProFallback(
        'judgeRecall',
        async (mod) => mod.judgeRecall({ query: 'q', recalledNodeIds: ['n1'] }),
        fallback,
        { logger: testLogger as any },
      );
      expect(result).toEqual({ judgments: [], tier1Confidence: 0.9 });
      expect(fallback).not.toHaveBeenCalled();
    });

    it('API 不存在时走 fallback', async () => {
      const fallback = vi.fn().mockResolvedValue('fallback');
      const result = await withGmProFallback(
        'nonExistentApi',
        async () => 'gm-pro',
        fallback,
      );
      expect(result).toBe('fallback');
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('API 为非函数值时走 fallback', async () => {
      mockState.mod.judgeRecall = 'not a function';
      const fallback = vi.fn().mockResolvedValue('fallback');
      const result = await withGmProFallback(
        'judgeRecall',
        async () => 'gm-pro',
        fallback,
      );
      expect(result).toBe('fallback');
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('API 名带 dot 路径时支持嵌套查找', async () => {
      // 设置嵌套结构 mod.Recaller.prototype.recall = function
      mockState.mod.Recaller = function MockRecaller() {};
      (mockState.mod.Recaller as any).prototype.recall = function () {};

      const fallback = vi.fn().mockResolvedValue('fallback');
      const result = await withGmProFallback(
        'Recaller.prototype.recall',
        async () => 'gm-pro-result',
        fallback,
        { logger: testLogger as any },
      );
      expect(result).toBe('gm-pro-result');
      expect(fallback).not.toHaveBeenCalled();
    });

    it('API 名带 dot 路径但最终值不是函数时走 fallback', async () => {
      mockState.mod.Recaller = function MockRecaller() {};
      (mockState.mod.Recaller as any).prototype.recall = 'not a function';
      const fallback = vi.fn().mockResolvedValue('fallback');
      const result = await withGmProFallback(
        'Recaller.prototype.recall',
        async () => 'gm-pro',
        fallback,
      );
      expect(result).toBe('fallback');
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('API 名带 dot 路径但中间值为 null 时走 fallback', async () => {
      // mod.Foo 不存在，遍历时 cur 变为 undefined
      const fallback = vi.fn().mockResolvedValue('fallback');
      const result = await withGmProFallback(
        'Foo.bar.baz',
        async () => 'gm-pro',
        fallback,
      );
      expect(result).toBe('fallback');
      expect(fallback).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 类型定义验证 ────────────────────────────────────────────────────────

  describe('类型定义验证', () => {
    it('ConsolidateBufferParams: nodes 必填, sessionId 可选', () => {
      const withSession: ConsolidateBufferParams = {
        nodes: [{ id: 'n1', type: 'TASK', name: 'task1', description: '', content: '' }],
        sessionId: 'sess-1',
      };
      const withoutSession: ConsolidateBufferParams = { nodes: [] };
      expect(withSession.nodes).toHaveLength(1);
      expect(withSession.sessionId).toBe('sess-1');
      expect(withoutSession.sessionId).toBeUndefined();
    });

    it('ConsolidateBufferResult: consolidatedIds 必填, skippedIds/reason 可选', () => {
      const full: ConsolidateBufferResult = {
        consolidatedIds: ['n1', 'n2'],
        skippedIds: ['n3'],
        reason: 'already exists',
      };
      const minimal: ConsolidateBufferResult = { consolidatedIds: [] };
      expect(full.consolidatedIds).toHaveLength(2);
      expect(full.skippedIds).toHaveLength(1);
      expect(minimal.skippedIds).toBeUndefined();
      expect(minimal.reason).toBeUndefined();
    });

    it('LinkNodesParams: fromId/toId/type 必填, instruction 可选', () => {
      const full: LinkNodesParams = {
        fromId: 'a',
        toId: 'b',
        type: 'RELATED_TO',
        instruction: 'derived from',
      };
      const minimal: LinkNodesParams = { fromId: 'a', toId: 'b', type: 'DERIVED_FROM' };
      expect(full.type).toBe('RELATED_TO');
      expect(minimal.instruction).toBeUndefined();
    });

    it('LinkNodesResult: created 必填, edgeId/reason 可选', () => {
      const full: LinkNodesResult = { created: true, edgeId: 'e1', reason: 'new link' };
      const minimal: LinkNodesResult = { created: false };
      expect(full.created).toBe(true);
      expect(minimal.edgeId).toBeUndefined();
    });

    it('MarkDirtyParams: nodeIds 必填, reason 可选', () => {
      const full: MarkDirtyParams = { nodeIds: ['n1', 'n2'], reason: 'content updated' };
      const minimal: MarkDirtyParams = { nodeIds: [] };
      expect(full.nodeIds).toHaveLength(2);
      expect(minimal.reason).toBeUndefined();
    });

    it('IncrementalMaintainParams: 全部字段可选', () => {
      const full: IncrementalMaintainParams = { nodeIds: ['n1'], maxBatchSize: 100 };
      const empty: IncrementalMaintainParams = {};
      expect(full.maxBatchSize).toBe(100);
      expect(empty.nodeIds).toBeUndefined();
      expect(empty.maxBatchSize).toBeUndefined();
    });

    it('IncrementalMaintainResult: processedCount/remainingCount 必填, durationMs 可选', () => {
      const full: IncrementalMaintainResult = {
        processedCount: 10,
        remainingCount: 2,
        durationMs: 500,
      };
      const minimal: IncrementalMaintainResult = { processedCount: 0, remainingCount: 0 };
      expect(full.processedCount).toBe(10);
      expect(minimal.durationMs).toBeUndefined();
    });

    it('GmNode: 必填字段 + 可选字段 + 扩展字段', () => {
      const node: GmNode = {
        id: 'n1',
        type: 'TASK',
        name: 'Task 1',
        description: 'desc',
        content: 'content',
        status: 'active',
        pagerank: 0.5,
      };
      expect(node.id).toBe('n1');
      expect(node.status).toBe('active');
      // 允许扩展字段（[key: string]: any）
      (node as any).customField = 'custom';
      expect((node as any).customField).toBe('custom');
    });

    it('JudgeRecallParams: query/recalledNodeIds 必填, scenario 可选', () => {
      const full: JudgeRecallParams = {
        query: 'q',
        recalledNodeIds: ['n1', 'n2'],
        scenario: 'bug-fix',
      };
      const minimal: JudgeRecallParams = { query: 'q', recalledNodeIds: [] };
      expect(full.recalledNodeIds).toHaveLength(2);
      expect(minimal.scenario).toBeUndefined();
    });

    it('JudgeRecallResult: judgments + tier1Confidence (0-1)', () => {
      const result: JudgeRecallResult = {
        judgments: [{ id: 'n1', relevant: true, confidence: 0.9, reason: 'high score' }],
        tier1Confidence: 0.85,
      };
      expect(result.judgments[0].relevant).toBe(true);
      expect(result.tier1Confidence).toBeGreaterThanOrEqual(0);
      expect(result.tier1Confidence).toBeLessThanOrEqual(1);
    });

    it('UpsertFeedbackParams: nodeId/query/relevant/score 必填, delta 可选', () => {
      const full: UpsertFeedbackParams = {
        nodeId: 'n1',
        query: 'q',
        relevant: true,
        score: 0.8,
        delta: 0.1,
      };
      const minimal: UpsertFeedbackParams = {
        nodeId: 'n1',
        query: 'q',
        relevant: false,
        score: 0.2,
      };
      expect(full.score).toBeLessThanOrEqual(1);
      expect(minimal.delta).toBeUndefined();
    });

    it('GetNodesByTimeRangeParams: from/to 必填, limit/label 可选', () => {
      const full: GetNodesByTimeRangeParams = {
        from: Date.now() - 86400000,
        to: Date.now(),
        limit: 10,
        label: 'EXPERIENCE',
      };
      const minimal: GetNodesByTimeRangeParams = { from: 0, to: 1000 };
      expect(full.from).toBeLessThan(full.to);
      expect(minimal.limit).toBeUndefined();
    });

    it('TimeRangeNode: id 必填, 其他可选', () => {
      const minimal: TimeRangeNode = { id: 'n1' };
      const full: TimeRangeNode = {
        id: 'n2',
        type: 'EXPERIENCE',
        title: 't',
        summary: 's',
        createdAt: 1,
        updatedAt: 2,
        pagerank: 0.5,
        state: 'active',
      };
      expect(minimal.id).toBe('n1');
      expect(full.title).toBe('t');
    });

    it('EvolveNodeParams: nodeId + updates', () => {
      const params: EvolveNodeParams = {
        nodeId: 'n1',
        updates: { state: 'validated', validatedCount: 5 },
      };
      expect(params.nodeId).toBe('n1');
      expect(params.updates.state).toBe('validated');
    });

    it('EvolveNodeResult: evolved 必填, 其他可选', () => {
      const full: EvolveNodeResult = {
        evolved: true,
        previousState: 'pending',
        newState: 'validated',
        reason: 'feedback positive',
      };
      const minimal: EvolveNodeResult = { evolved: false };
      expect(full.evolved).toBe(true);
      expect(minimal.previousState).toBeUndefined();
    });

    it('GraphHealthSnapshot: status 限制为四种值', () => {
      const statuses: GraphHealthSnapshot['status'][] = [
        'healthy',
        'degraded',
        'unhealthy',
        'unknown',
      ];
      for (const status of statuses) {
        const snap: GraphHealthSnapshot = { status };
        expect(snap.status).toBe(status);
      }
    });
  });

  // ─── 集成场景: 真实 API 调用流程 ────────────────────────────────────────

  describe('集成场景: 真实 API 调用流程', () => {
    it('consolidateBuffer 完整流程（gm-pro 可用）', async () => {
      const expected: ConsolidateBufferResult = {
        consolidatedIds: ['n1', 'n2'],
        skippedIds: [],
      };
      mockState.mod.consolidateBuffer = vi.fn().mockResolvedValue(expected);
      const result = await withGmProFallback(
        'consolidateBuffer',
        async (mod) => mod.consolidateBuffer({ nodes: [], sessionId: 's1' }),
        async () => ({ consolidatedIds: [], reason: 'fallback' }),
        { logger: testLogger as any },
      );
      expect(result).toEqual(expected);
      expect(mockState.mod.consolidateBuffer).toHaveBeenCalledTimes(1);
    });

    it('markDirty 完整流程（gm-pro 可用）', async () => {
      mockState.mod.markDirty = vi.fn().mockResolvedValue(undefined);
      const result = await withGmProFallback(
        'markDirty',
        async (mod) => mod.markDirty({ nodeIds: ['n1'], reason: 'updated' }),
        async () => undefined,
        { logger: testLogger as any },
      );
      expect(result).toBeUndefined();
      expect(mockState.mod.markDirty).toHaveBeenCalledTimes(1);
    });

    it('incrementalMaintain 完整流程（gm-pro 可用）', async () => {
      const expected: IncrementalMaintainResult = {
        processedCount: 5,
        remainingCount: 0,
        durationMs: 100,
      };
      mockState.mod.incrementalMaintain = vi.fn().mockResolvedValue(expected);
      const result = await withGmProFallback(
        'incrementalMaintain',
        async (mod) => mod.incrementalMaintain({ maxBatchSize: 10 }),
        async () => ({ processedCount: 0, remainingCount: 0 }),
        { logger: testLogger as any },
      );
      expect(result).toEqual(expected);
      expect(mockState.mod.incrementalMaintain).toHaveBeenCalledTimes(1);
    });

    it('linkNodes 完整流程（gm-pro 不可用走 fallback）', async () => {
      mockState.path = '/__non_existent_gm_pro_path__';
      const fallbackResult: LinkNodesResult = { created: false, reason: 'gm-pro unavailable' };
      const result = await withGmProFallback(
        'linkNodes',
        async (mod) => mod.linkNodes({ fromId: 'a', toId: 'b', type: 'RELATED_TO' }),
        async () => fallbackResult,
        { logger: testLogger as any },
      );
      expect(result).toEqual(fallbackResult);
    });

    it('getGraphHealth 完整流程（gm-pro 抛异常走 fallback）', async () => {
      mockState.mod.getGraphHealth = vi.fn().mockRejectedValue(new Error('health check failed'));
      const fallbackSnapshot: GraphHealthSnapshot = { status: 'unknown' };
      const result = await withGmProFallback(
        'getGraphHealth',
        async (mod) => mod.getGraphHealth(),
        async () => fallbackSnapshot,
        { logger: testLogger as any },
      );
      expect(result).toEqual(fallbackSnapshot);
      expect(testLogger.debug).toHaveBeenCalledTimes(1);
    });
  });
});
