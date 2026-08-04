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
import {
  HealthMetricsCollector,
  LatencyHistogram,
  BusinessMetricsCollector,
  healthMetrics,
  latencyHistograms,
  businessMetrics,
} from './health-metrics.js';

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

    it('M1 修复: 允许传入有效 timestamp', () => {
      const before = Date.now();
      collector.collect({ timestamp: 12345 } as any);
      const latest = collector.getLatest();
      // M1 修复后：传入的有效 timestamp 应被保留
      expect(latest!.timestamp).toBe(12345);
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

// ============================================================================
// H5: LatencyHistogram 优化测试
// ============================================================================

describe('LatencyHistogram (H5: 一次性排序优化)', () => {
  let hist: LatencyHistogram;

  beforeEach(() => {
    hist = new LatencyHistogram();
  });

  describe('observe', () => {
    it('记录正常延迟值', () => {
      hist.observe(100);
      hist.observe(200);
      hist.observe(300);
      const stats = hist.getStats();
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(100);
      expect(stats.max).toBe(300);
    });

    it('忽略负数', () => {
      hist.observe(-1);
      expect(hist.getStats().count).toBe(0);
    });

    it('忽略 NaN', () => {
      hist.observe(NaN);
      expect(hist.getStats().count).toBe(0);
    });

    it('忽略 Infinity', () => {
      hist.observe(Infinity);
      expect(hist.getStats().count).toBe(0);
    });
  });

  describe('getStats (H5: 一次性排序)', () => {
    it('空直方图返回全零', () => {
      const stats = hist.getStats();
      expect(stats.count).toBe(0);
      expect(stats.avg).toBe(0);
      expect(stats.p50).toBe(0);
      expect(stats.p90).toBe(0);
      expect(stats.p95).toBe(0);
      expect(stats.p99).toBe(0);
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(0);
    });

    it('单样本时所有百分位相同', () => {
      hist.observe(100);
      const stats = hist.getStats();
      expect(stats.p50).toBe(100);
      expect(stats.p90).toBe(100);
      expect(stats.p95).toBe(100);
      expect(stats.p99).toBe(100);
    });

    it('多样本时正确计算百分位', () => {
      // 1-100 的延迟值
      for (let i = 1; i <= 100; i++) {
        hist.observe(i);
      }
      const stats = hist.getStats();
      expect(stats.count).toBe(100);
      expect(stats.p50).toBe(50);
      expect(stats.p90).toBe(90);
      expect(stats.p95).toBe(95);
      expect(stats.p99).toBe(99);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
    });

    it('getStats 多次调用返回一致结果（幂等）', () => {
      for (let i = 1; i <= 50; i++) {
        hist.observe(i * 10);
      }
      const stats1 = hist.getStats();
      const stats2 = hist.getStats();
      expect(stats1).toEqual(stats2);
    });

    it('滑动窗口丢弃最旧样本', () => {
      const smallHist = new LatencyHistogram(10); // maxSamples = 10
      for (let i = 1; i <= 15; i++) {
        smallHist.observe(i * 100);
      }
      const stats = smallHist.getStats();
      expect(stats.count).toBe(10);
      // 最旧的 5 个被丢弃，保留 600-1500
      expect(stats.min).toBe(600);
      expect(stats.max).toBe(1500);
    });
  });

  describe('percentile (单独调用)', () => {
    it('单独 percentile 也可用', () => {
      for (let i = 1; i <= 100; i++) {
        hist.observe(i);
      }
      expect(hist.percentile(50)).toBe(50);
      expect(hist.percentile(99)).toBe(99);
    });

    it('空直方图 percentile 返回 0', () => {
      expect(hist.percentile(50)).toBe(0);
    });
  });

  describe('reset', () => {
    it('reset 清空所有样本', () => {
      hist.observe(100);
      hist.observe(200);
      hist.reset();
      expect(hist.getStats().count).toBe(0);
    });
  });
});

// ============================================================================
// BusinessMetricsCollector 测试
// ============================================================================

describe('BusinessMetricsCollector', () => {
  let bm: BusinessMetricsCollector;

  beforeEach(() => {
    bm = new BusinessMetricsCollector();
  });

  describe('recordExperienceQuality', () => {
    it('低质量分归入 low 桶', () => {
      bm.recordExperienceQuality(0.2);
      expect(bm.getExpQualityDistribution().low).toBe(1);
    });

    it('中等质量分归入 medium 桶', () => {
      bm.recordExperienceQuality(0.5);
      expect(bm.getExpQualityDistribution().medium).toBe(1);
    });

    it('高质量分归入 high 桶', () => {
      bm.recordExperienceQuality(0.8);
      expect(bm.getExpQualityDistribution().high).toBe(1);
    });

    it('忽略 NaN 分数', () => {
      bm.recordExperienceQuality(NaN);
      const dist = bm.getExpQualityDistribution();
      expect(dist.low + dist.medium + dist.high).toBe(0);
    });
  });

  describe('recordTtlAccess', () => {
    it('TTL 命中率正确计算', () => {
      bm.recordTtlAccess(true);
      bm.recordTtlAccess(true);
      bm.recordTtlAccess(false);
      expect(bm.getTtlHitRate()).toBe(2 / 3);
    });

    it('无记录时 TTL 命中率为 0', () => {
      expect(bm.getTtlHitRate()).toBe(0);
    });
  });

  describe('recordDistill', () => {
    it('蒸馏成功率正确计算', () => {
      bm.recordDistill(true);
      bm.recordDistill(true);
      bm.recordDistill(false);
      expect(bm.getDistillSuccessRate()).toBe(2 / 3);
    });
  });

  describe('getSummary', () => {
    it('返回完整摘要', () => {
      bm.recordExperienceQuality(0.3);
      bm.recordTtlAccess(true);
      bm.recordDistill(true);

      const summary = bm.getSummary();
      expect(summary.expQuality.low).toBe(1);
      expect(summary.ttlHits).toBe(1);
      expect(summary.distillSuccess).toBe(1);
    });
  });

  describe('reset', () => {
    it('reset 清空所有计数', () => {
      bm.recordExperienceQuality(0.5);
      bm.recordTtlAccess(true);
      bm.reset();
      expect(bm.getExpQualityDistribution().medium).toBe(0);
      expect(bm.getTtlHitRate()).toBe(0);
    });
  });
});

// ============================================================================
// 全局单例延迟直方图
// ============================================================================

describe('全局 latencyHistograms', () => {
  it('latencyHistograms.assemble 是 LatencyHistogram 实例', () => {
    expect(latencyHistograms.assemble).toBeInstanceOf(LatencyHistogram);
  });

  it('latencyHistograms.l2_qmd 是 LatencyHistogram 实例', () => {
    expect(latencyHistograms.l2_qmd).toBeInstanceOf(LatencyHistogram);
  });

  it('latencyHistograms.l3_graph 是 LatencyHistogram 实例', () => {
    expect(latencyHistograms.l3_graph).toBeInstanceOf(LatencyHistogram);
  });

  it('latencyHistograms.l4_experience 是 LatencyHistogram 实例', () => {
    expect(latencyHistograms.l4_experience).toBeInstanceOf(LatencyHistogram);
  });
});

// ============================================================================
// M1: collect() 接受外部 timestamp 测试
// ============================================================================

describe('HealthMetricsCollector M1: collect() 接受外部 timestamp', () => {
  let collector: HealthMetricsCollector;

  beforeEach(() => {
    collector = new HealthMetricsCollector();
  });

  it('传入有效 timestamp 时使用传入值', () => {
    const customTs = 1700000000000;
    collector.collect({ pendingMessages: 5, timestamp: customTs });
    const latest = collector.getLatest();
    expect(latest!.timestamp).toBe(customTs);
  });

  it('不传 timestamp 时使用 Date.now()', () => {
    const before = Date.now();
    collector.collect({ pendingMessages: 5 });
    const latest = collector.getLatest();
    expect(latest!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('传入 0 时使用 Date.now()（无效值回退）', () => {
    const before = Date.now();
    collector.collect({ pendingMessages: 5, timestamp: 0 });
    const latest = collector.getLatest();
    expect(latest!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('传入负数时使用 Date.now()（无效值回退）', () => {
    const before = Date.now();
    collector.collect({ pendingMessages: 5, timestamp: -1 });
    const latest = collector.getLatest();
    expect(latest!.timestamp).toBeGreaterThanOrEqual(before);
  });
});
