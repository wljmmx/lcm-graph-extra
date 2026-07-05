/**
 * N-4: HealthMetricsCollector 单元测试。
 *
 * 覆盖：
 * - collect / getLatest / getHistory
 * - 返回副本不可变性（BUG 修复：原返回内部引用）
 * - recordAssemble 空快照处理 + tier 计数 + 非法 tier 忽略
 * - reset / close 安全性
 * - ring buffer 容量限制
 *
 * 注：DB 持久化部分依赖 node:sqlite + ~/.openclaw/lcm.db，
 * 测试环境可能不可用，故仅测试内存逻辑，DB 失败应静默不影响主流程。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HealthMetricsCollector, healthMetrics } from './health-metrics.js';

describe('HealthMetricsCollector', () => {
  let collector: HealthMetricsCollector;

  beforeEach(() => {
    collector = new HealthMetricsCollector();
  });

  describe('collect + getLatest', () => {
    it('collect 后 getLatest 返回该快照', () => {
      collector.collect({ pendingMessages: 5, maxTokenRatio: 0.7 });
      const latest = collector.getLatest();
      expect(latest).not.toBeNull();
      expect(latest!.pendingMessages).toBe(5);
      expect(latest!.maxTokenRatio).toBe(0.7);
      // 默认值
      expect(latest!.summaryFragments).toBe(0);
      expect(latest!.cbLcmAvailable).toBe(true);
    });

    it('getLatest 空时返回 null', () => {
      expect(collector.getLatest()).toBeNull();
    });

    it('BUG 修复：getLatest 返回副本，修改不影响内部状态', () => {
      collector.collect({ pendingMessages: 3 });
      const latest = collector.getLatest();
      latest!.pendingMessages = 999;
      const again = collector.getLatest();
      expect(again!.pendingMessages).toBe(3); // 内部未被修改
    });

    it('不允许调用方覆盖 timestamp', () => {
      const before = Date.now();
      collector.collect({ timestamp: 12345 } as any);
      const latest = collector.getLatest();
      expect(latest!.timestamp).not.toBe(12345);
      expect(latest!.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getHistory', () => {
    it('返回最近 N 条快照', () => {
      for (let i = 0; i < 5; i++) {
        collector.collect({ pendingMessages: i });
      }
      const history = collector.getHistory(3);
      expect(history).toHaveLength(3);
      // 最近 3 条 = pendingMessages 2,3,4
      expect(history.map((h) => h.pendingMessages)).toEqual([2, 3, 4]);
    });

    it('N 大于实际数量时返回全部', () => {
      collector.collect({ pendingMessages: 1 });
      collector.collect({ pendingMessages: 2 });
      const history = collector.getHistory(100);
      expect(history).toHaveLength(2);
    });

    it('N=0 返回空数组（BUG 修复：原 slice(-0) 返回全部）', () => {
      collector.collect({ pendingMessages: 1 });
      expect(collector.getHistory(0)).toEqual([]);
    });

    it('负数 N 返回空数组', () => {
      collector.collect({ pendingMessages: 1 });
      expect(collector.getHistory(-5)).toEqual([]);
    });

    it('返回深拷贝，修改不影响内部', () => {
      collector.collect({ pendingMessages: 1 });
      const history = collector.getHistory(1);
      history[0].pendingMessages = 999;
      const again = collector.getHistory(1);
      expect(again[0].pendingMessages).toBe(1);
    });
  });

  describe('recordAssemble', () => {
    it('无快照时自动创建占位快照（BUG 修复：原静默丢弃）', () => {
      collector.recordAssemble('low', 100, 30, 40, 30);
      const latest = collector.getLatest();
      expect(latest).not.toBeNull();
      expect(latest!.lastAssembleMs).toBe(100);
      expect(latest!.lastL2Ms).toBe(30);
      expect(latest!.lastL3Ms).toBe(40);
      expect(latest!.lastL4Ms).toBe(30);
      expect(latest!.tierLow).toBe(1);
    });

    it('更新已有快照的 assemble 指标', () => {
      collector.collect({ pendingMessages: 5 });
      collector.recordAssemble('medium', 200, 50, 60, 90);
      const latest = collector.getLatest();
      expect(latest!.pendingMessages).toBe(5); // 原有字段保留
      expect(latest!.lastAssembleMs).toBe(200);
      expect(latest!.tierMedium).toBe(1);
    });

    it('tier 计数累加', () => {
      collector.collect({});
      collector.recordAssemble('low', 100, 1, 1, 1);
      collector.recordAssemble('low', 200, 1, 1, 1);
      collector.recordAssemble('high', 300, 1, 1, 1);
      const latest = collector.getLatest();
      expect(latest!.tierLow).toBe(2);
      expect(latest!.tierHigh).toBe(1);
      expect(latest!.tierMedium).toBe(0);
    });

    it('非法 tier 值被忽略（不归入 high）', () => {
      collector.collect({});
      collector.recordAssemble('typo' as any, 100, 1, 1, 1);
      const latest = collector.getLatest();
      expect(latest!.tierLow).toBe(0);
      expect(latest!.tierMedium).toBe(0);
      expect(latest!.tierHigh).toBe(0);
    });
  });

  describe('recordCascadeConfidence (R-2)', () => {
    it('无快照时自动创建占位快照', () => {
      collector.recordCascadeConfidence(0.85, 'gm-pro');
      const latest = collector.getLatest();
      expect(latest).not.toBeNull();
      expect(latest!.cascadeTier1Confidence).toBe(0.85);
      expect(latest!.cascadeJudgeSource).toBe('gm-pro');
    });

    it('更新已有快照的 cascade 字段（不持久化，仅内存态）', () => {
      collector.collect({ pendingMessages: 5 });
      collector.recordCascadeConfidence(0.42, 'local');
      const latest = collector.getLatest();
      expect(latest!.pendingMessages).toBe(5); // 原有字段保留
      expect(latest!.cascadeTier1Confidence).toBe(0.42);
      expect(latest!.cascadeJudgeSource).toBe('local');
    });

    it('多次调用覆盖前一次值', () => {
      collector.recordCascadeConfidence(0.3, 'local');
      collector.recordCascadeConfidence(0.9, 'gm-pro');
      const latest = collector.getLatest();
      expect(latest!.cascadeTier1Confidence).toBe(0.9);
      expect(latest!.cascadeJudgeSource).toBe('gm-pro');
    });
  });

  describe('ring buffer', () => {
    it('超过 MAX_SNAPSHOTS 时丢弃最旧的', () => {
      // MAX_SNAPSHOTS = 144
      for (let i = 0; i < 150; i++) {
        collector.collect({ pendingMessages: i });
      }
      const history = collector.getHistory(200);
      expect(history).toHaveLength(144);
      // 最旧的应是 pendingMessages = 6（0~5 被丢弃）
      expect(history[0].pendingMessages).toBe(6);
      expect(history[143].pendingMessages).toBe(149);
    });
  });

  describe('readFromDb', () => {
    it('DB 未初始化时返回空数组（不抛错）', async () => {
      // 新实例，未触发过 collect（DB 未初始化）
      const fresh = new HealthMetricsCollector();
      const rows = await fresh.readFromDb(5);
      expect(Array.isArray(rows)).toBe(true);
      // 可能是 [] 或含数据（如果 lcm.db 已存在），关键是 not throw
    });
  });

  describe('close + reset', () => {
    it('close 可安全多次调用', () => {
      expect(() => {
        collector.close();
        collector.close();
        collector.close();
      }).not.toThrow();
    });

    it('reset 清空内存快照', () => {
      collector.collect({ pendingMessages: 5 });
      collector.collect({ pendingMessages: 6 });
      expect(collector.getHistory(100)).toHaveLength(2);
      collector.reset();
      expect(collector.getLatest()).toBeNull();
      expect(collector.getHistory(100)).toEqual([]);
    });

    it('reset 后可继续使用', () => {
      collector.collect({ pendingMessages: 1 });
      collector.reset();
      collector.collect({ pendingMessages: 2 });
      const latest = collector.getLatest();
      expect(latest!.pendingMessages).toBe(2);
    });
  });

  describe('全局单例', () => {
    it('healthMetrics 是 HealthMetricsCollector 实例', () => {
      expect(healthMetrics).toBeInstanceOf(HealthMetricsCollector);
    });
  });
});
