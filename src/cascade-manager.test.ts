/**
 * R-2: CascadeManager 单元测试。
 *
 * 覆盖：
 * - makeArmKey 格式一致性（BUG-2 回归测试）
 * - evaluateTier1 空数组语义（BUG 修复：空结果应触发 Tier 2）
 * - thompsonRerank 边界 + 探索性
 * - recordFeedback armKey 必须与 thompsonRerank 匹配
 * - evaluateTier2 超时 + 幻觉 id 过滤
 * - arms LRU 淘汰
 * - 采样函数健壮性（退化输入不崩溃）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CascadeManager, cascadeManager } from './cascade-manager.js';

describe('CascadeManager', () => {
  let mgr: CascadeManager;

  beforeEach(() => {
    mgr = new CascadeManager(0.7);
  });

  describe('makeArmKey', () => {
    it('格式为 scenario:id', () => {
      expect(CascadeManager.makeArmKey('bug-fix', 'exp-1')).toBe('bug-fix:exp-1');
    });

    it('undefined id 回退为 unknown', () => {
      expect(CascadeManager.makeArmKey('default', undefined)).toBe('default:unknown');
    });

    it('undefined scenario 回退为 default', () => {
      expect(CascadeManager.makeArmKey(undefined as any, 'x')).toBe('default:x');
    });

    it('BUG-2 回归：thompsonRerank 与 recordFeedback 必须用同一 key 格式', () => {
      // 模拟 thompsonRerank 创建 arm
      const results = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, matchCount: i, score: 0.5 }));
      mgr.thompsonRerank(results, 'scenario-A');
      // 用 makeArmKey 构造的 key 应能命中已创建的 arm
      // 通过 recordFeedback 更新后再 thompsonRerank，观察 arm 仍存在（间接验证 key 一致）
      const key = CascadeManager.makeArmKey('scenario-A', 'r0');
      expect(() => mgr.recordFeedback(key, true)).not.toThrow();
      // 多次反馈不应创建新 arm（key 一致则更新同一 arm）
      const sizeBefore = (mgr as any).arms.size;
      mgr.recordFeedback(key, false);
      mgr.recordFeedback(key, true);
      expect((mgr as any).arms.size).toBe(sizeBefore);
    });
  });

  describe('evaluateTier1', () => {
    it('空数组应触发 Tier 2（BUG 修复：原返回 needsTier2=false）', () => {
      const r = mgr.evaluateTier1([]);
      expect(r.tier1Score).toBe(0);
      expect(r.needsTier2).toBe(true);
    });

    it('undefined 输入应触发 Tier 2', () => {
      const r = mgr.evaluateTier1(undefined as any);
      expect(r.needsTier2).toBe(true);
    });

    it('高分 + 多结果 + 高 matchCount → 高置信度，不需 Tier 2', () => {
      const r = mgr.evaluateTier1(
        Array.from({ length: 12 }, () => ({ score: 0.9, matchCount: 6, content: 'normal text' })),
      );
      expect(r.tier1Score).toBeGreaterThan(0.7);
      expect(r.needsTier2).toBe(false);
    });

    it('低分 → 低置信度，需 Tier 2', () => {
      const r = mgr.evaluateTier1([{ score: 0.1, content: 'low quality' }]);
      expect(r.tier1Score).toBeLessThan(0.7);
      expect(r.needsTier2).toBe(true);
    });

    it('事实性声明检测（英文关键词）', () => {
      // 低分以确保 needsTier2=true，从而 needsTier3 = needsTier2 && hasFactualClaim
      const r = mgr.evaluateTier1([{ score: 0.2, content: 'Update API version to 2.0' }]);
      expect(r.hasFactualClaim).toBe(true);
      expect(r.needsTier2).toBe(true);
      expect(r.needsTier3).toBe(true); // 低置信 + 事实性 → Tier 3
    });

    it('事实性声明检测（中文关键词）', () => {
      const r = mgr.evaluateTier1([{ score: 0.2, content: '修改配置参数' }]);
      expect(r.hasFactualClaim).toBe(true);
    });

    it('tier1Score 不会为负（下界裁剪）', () => {
      const r = mgr.evaluateTier1([{ score: -10, content: 'x' }]);
      expect(r.tier1Score).toBeGreaterThanOrEqual(0);
      expect(r.tier1Score).toBeLessThanOrEqual(1);
    });

    it('tier1Score 不会超过 1（上界裁剪）', () => {
      const r = mgr.evaluateTier1(
        Array.from({ length: 20 }, () => ({ score: 100, matchCount: 100, content: 'x' })),
      );
      expect(r.tier1Score).toBeLessThanOrEqual(1);
    });
  });

  describe('thompsonRerank', () => {
    it('结果数 ≤ 3 时原样返回（不采样）', () => {
      const results = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.5 }, { id: 'c', score: 0.3 }];
      const out = mgr.thompsonRerank(results, 'test');
      expect(out).toHaveLength(3);
      expect(out.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('结果数 > 3 时返回相同元素集合（不丢数据）', () => {
      const results = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, score: 0.5 }));
      const out = mgr.thompsonRerank(results, 'test');
      expect(out).toHaveLength(6);
      expect(out.map((r) => r.id).sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
    });

    it('多次调用结果稳定（arm 状态持久化）', () => {
      const results = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, matchCount: i * 2, score: 0.5 }));
      // 第一次创建 arm
      mgr.thompsonRerank(results, 's1');
      const sizeAfter1 = (mgr as any).arms.size;
      // 第二次不应创建新 arm
      mgr.thompsonRerank(results, 's1');
      expect((mgr as any).arms.size).toBe(sizeAfter1);
    });

    it('不同 scenario 的相同 id 创建不同 arm', () => {
      const results = [{ id: 'x', matchCount: 1, score: 0.5 }];
      // 需要 > 3 才采样，补充到 4 个
      const r1 = [...results, { id: 'a', score: 0.5 }, { id: 'b', score: 0.5 }, { id: 'c', score: 0.5 }];
      mgr.thompsonRerank(r1, 'scene-1');
      mgr.thompsonRerank(r1, 'scene-2');
      expect((mgr as any).arms.has('scene-1:x')).toBe(true);
      expect((mgr as any).arms.has('scene-2:x')).toBe(true);
    });

    it('不修改原数组', () => {
      const results = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.5 }, { id: 'c', score: 0.3 }, { id: 'd', score: 0.1 }];
      const snapshot = results.map((r) => ({ ...r }));
      mgr.thompsonRerank(results, 'test');
      expect(results).toEqual(snapshot);
    });
  });

  describe('recordFeedback', () => {
    it('成功反馈增加 alpha', () => {
      const key = CascadeManager.makeArmKey('s', 'x');
      mgr.recordFeedback(key, true);
      const arm = (mgr as any).arms.get(key);
      expect(arm.alpha).toBe(2);
      expect(arm.beta).toBe(1);
    });

    it('失败反馈增加 beta', () => {
      const key = CascadeManager.makeArmKey('s', 'x');
      mgr.recordFeedback(key, false);
      const arm = (mgr as any).arms.get(key);
      expect(arm.alpha).toBe(1);
      expect(arm.beta).toBe(2);
    });

    it('alpha/beta 上限 100', () => {
      const key = CascadeManager.makeArmKey('s', 'x');
      for (let i = 0; i < 200; i++) mgr.recordFeedback(key, true);
      const arm = (mgr as any).arms.get(key);
      expect(arm.alpha).toBe(100);
    });
  });

  describe('evaluateTier2', () => {
    it('空 query 返回空数组', async () => {
      const out = await mgr.evaluateTier2('', [{ id: 'a', content: 'x' }], async () => '[]');
      expect(out).toEqual([]);
    });

    it('空 results 返回空数组', async () => {
      const out = await mgr.evaluateTier2('q', [], async () => '[]');
      expect(out).toEqual([]);
    });

    it('过滤 LLM 幻觉出的不存在 id', async () => {
      const results = [{ id: 'real-1', content: 'content 1' }, { id: 'real-2', content: 'content 2' }];
      const llmFn = async () => JSON.stringify([
        { id: 'real-1', relevant: true },
        { id: 'hallucinated', relevant: false }, // 不在 validIds 中，应被过滤
      ]);
      const out = await mgr.evaluateTier2('query', results, llmFn);
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe('real-1');
    });

    it('LLM 返回非 JSON 返回空数组', async () => {
      const out = await mgr.evaluateTier2('q', [{ id: 'a', content: 'x' }], async () => 'not json');
      expect(out).toEqual([]);
    });

    it('LLM 返回非数组返回空数组', async () => {
      const out = await mgr.evaluateTier2('q', [{ id: 'a', content: 'x' }], async () => '{"not":"array"}');
      expect(out).toEqual([]);
    });

    it('LLM 超时（>10s）返回空数组', async () => {
      const slowLlm = async () => new Promise<string>((resolve) => setTimeout(() => resolve('[]'), 12_000));
      const start = Date.now();
      const out = await mgr.evaluateTier2('q', [{ id: 'a', content: 'x' }], slowLlm);
      const elapsed = Date.now() - start;
      expect(out).toEqual([]);
      // 应在 ~10s 超时后返回，而非等待 12s
      expect(elapsed).toBeLessThan(11_500);
    });
  });

  describe('arms LRU 淘汰', () => {
    it('超过上限时淘汰最早插入的 arm', () => {
      // 用低阈值构造一个容易触发淘汰的 manager
      const smallMgr = new (CascadeManager as any)(0.7);
      // 直接操作 arms Map 模拟大量 arm
      const arms = (smallMgr as any).arms;
      for (let i = 0; i < 5500; i++) {
        arms.set(`s:id-${i}`, { alpha: 1, beta: 1 });
      }
      // 触发淘汰（recordFeedback 内部调用 evictArmsIfNeeded）
      smallMgr.recordFeedback('s:trigger', true);
      expect(arms.size).toBeLessThanOrEqual(5000);
      // 最早的 id-0 应被淘汰
      expect(arms.has('s:id-0')).toBe(false);
    });
  });

  describe('采样健壮性', () => {
    it('thompsonRerank 不应在大量调用下崩溃', () => {
      const results = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, matchCount: 0, score: 0.5 }));
      // 多次调用，每次采样都应返回有效结果
      for (let i = 0; i < 100; i++) {
        const out = mgr.thompsonRerank(results, 'stress');
        expect(out).toHaveLength(10);
        for (const r of out) expect(r).toBeDefined();
      }
    });
  });

  describe('reset', () => {
    it('清空所有 arm', () => {
      const results = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, score: 0.5 }));
      mgr.thompsonRerank(results, 's');
      expect((mgr as any).arms.size).toBeGreaterThan(0);
      mgr.reset();
      expect((mgr as any).arms.size).toBe(0);
    });
  });

  describe('全局单例', () => {
    it('cascadeManager 是 CascadeManager 实例', () => {
      expect(cascadeManager).toBeInstanceOf(CascadeManager);
    });
  });

  describe('getArmsCount', () => {
    it('空 manager 返回 0', () => {
      expect(mgr.getArmsCount()).toBe(0);
    });

    it('返回当前 arms 数量', () => {
      // thompsonRerank 创建 arm（>3 才采样）
      const results = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, score: 0.5 }));
      mgr.thompsonRerank(results, 's');
      expect(mgr.getArmsCount()).toBe(5);
    });

    it('不同 scenario 的 arm 分别计数', () => {
      const results = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, score: 0.5 }));
      mgr.thompsonRerank(results, 'scene-1');
      mgr.thompsonRerank(results, 'scene-2');
      expect(mgr.getArmsCount()).toBe(8);
    });
  });

  describe('getArmsSnapshot', () => {
    it('空 manager 返回空数组', () => {
      expect(mgr.getArmsSnapshot()).toEqual([]);
    });

    it('返回 armKey/alpha/beta/sample 字段', () => {
      const results = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, matchCount: i, score: 0.5 }));
      mgr.thompsonRerank(results, 's');
      const snap = mgr.getArmsSnapshot();
      expect(snap.length).toBe(5);
      for (const arm of snap) {
        expect(arm).toHaveProperty('armKey');
        expect(arm).toHaveProperty('alpha');
        expect(arm).toHaveProperty('beta');
        expect(arm).toHaveProperty('sample');
        expect(typeof arm.alpha).toBe('number');
        expect(typeof arm.beta).toBe('number');
        expect(typeof arm.sample).toBe('number');
        expect(arm.sample).toBeGreaterThanOrEqual(0);
        expect(arm.sample).toBeLessThanOrEqual(1);
      }
    });

    it('最多返回 10 个 arm（top 10）', () => {
      // 创建 15 个 arm
      const results = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, score: 0.5 }));
      mgr.thompsonRerank(results, 's');
      const snap = mgr.getArmsSnapshot();
      expect(snap.length).toBe(10);
    });

    it('按 alpha+beta 降序排列', () => {
      // 通过 recordFeedback 制造不同 alpha/beta
      const results = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, score: 0.5 }));
      mgr.thompsonRerank(results, 's');
      // r0 成功多次（alpha 增大）
      for (let i = 0; i < 5; i++) mgr.recordFeedback(CascadeManager.makeArmKey('s', 'r0'), true);
      // r1 失败多次（beta 增大）
      for (let i = 0; i < 3; i++) mgr.recordFeedback(CascadeManager.makeArmKey('s', 'r1'), false);

      const snap = mgr.getArmsSnapshot();
      // r0: alpha=6, beta=1, sum=7; r1: alpha=1, beta=4, sum=5; 其余 alpha=1, beta=1, sum=2
      // r0 应排第一
      expect(snap[0].armKey).toBe('s:r0');
      // 和应递减
      for (let i = 1; i < snap.length; i++) {
        const prevSum = snap[i - 1].alpha + snap[i - 1].beta;
        const currSum = snap[i].alpha + snap[i].beta;
        expect(prevSum).toBeGreaterThanOrEqual(currSum);
      }
    });

    it('armKey 格式为 scenario:id', () => {
      const results = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, score: 0.5 }));
      mgr.thompsonRerank(results, 'bug-fix');
      const snap = mgr.getArmsSnapshot();
      expect(snap[0].armKey).toMatch(/^bug-fix:r\d+$/);
    });

    it('不修改内部 arms 状态（只读）', () => {
      const results = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, score: 0.5 }));
      mgr.thompsonRerank(results, 's');
      const sizeBefore = mgr.getArmsCount();
      mgr.getArmsSnapshot();
      expect(mgr.getArmsCount()).toBe(sizeBefore);
    });
  });
});
