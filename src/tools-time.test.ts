/**
 * S-8': parseTimeRange 单元测试。
 *
 * 覆盖：
 * - 相对时间（7d / 24h / 30m）
 * - 中文关键词（今天 / 昨天 / 本周 / 本月）
 * - 英文关键词（today / yesterday / this week / this month）
 * - ISO 8601 日期
 * - 空值 / undefined / 无效值
 * - from / to 语义
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseTimeRange } from './tools.js';

describe('parseTimeRange', () => {
  const NOW = new Date('2026-07-04T12:00:00.000Z').getTime();
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    originalDateNow = Date.now;
    Date.now = () => NOW;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  describe('空值与无效输入', () => {
    it('两个参数都未传返回 null/null', () => {
      expect(parseTimeRange()).toEqual({ fromTs: null, toTs: null });
    });

    it('空字符串返回 null', () => {
      expect(parseTimeRange('', '')).toEqual({ fromTs: null, toTs: null });
    });

    it('空白字符串返回 null', () => {
      expect(parseTimeRange('  ', '  ')).toEqual({ fromTs: null, toTs: null });
    });

    it('无效字符串返回 null', () => {
      expect(parseTimeRange('abc', 'xyz')).toEqual({ fromTs: null, toTs: null });
    });
  });

  describe('相对时间', () => {
    it('"7d" from = 7 天前, to = now', () => {
      const r = parseTimeRange('7d', '7d');
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(r.fromTs).toBe(NOW - sevenDaysMs);
      expect(r.toTs).toBe(NOW);
    });

    it('"24h" = 24 小时前', () => {
      const r = parseTimeRange('24h');
      expect(r.fromTs).toBe(NOW - 24 * 60 * 60 * 1000);
      expect(r.toTs).toBeNull();
    });

    it('"30m" = 30 分钟前', () => {
      const r = parseTimeRange('30m');
      expect(r.fromTs).toBe(NOW - 30 * 60 * 1000);
    });

    it('大小写不敏感', () => {
      const r1 = parseTimeRange('7D');
      const r2 = parseTimeRange('7d');
      expect(r1.fromTs).toBe(r2.fromTs);
    });

    it('to 用相对时间默认为 now', () => {
      const r = parseTimeRange('7d', '3d');
      // to 参数是相对时间时返回 now（而非 3 天前）
      expect(r.toTs).toBe(NOW);
    });
  });

  describe('中文关键词', () => {
    it('"今天" from = 当天 0 点', () => {
      const r = parseTimeRange('今天');
      const expected = new Date(NOW).setHours(0, 0, 0, 0);
      expect(r.fromTs).toBe(expected);
    });

    it('"昨天" from = 昨天 0 点, to = 昨天 23:59:59.999', () => {
      const r = parseTimeRange('昨天', '昨天');
      const y = new Date(NOW);
      y.setDate(y.getDate() - 1);
      expect(r.fromTs).toBe(y.setHours(0, 0, 0, 0));
      // to 需重新计算（setHours 改变对象）
      const y2 = new Date(NOW);
      y2.setDate(y2.getDate() - 1);
      expect(r.toTs).toBe(y2.setHours(23, 59, 59, 999));
    });

    it('"本周" from = 本周一 0 点', () => {
      const r = parseTimeRange('本周');
      const d = new Date(NOW);
      const day = d.getDay() || 7;
      d.setDate(d.getDate() - day + 1);
      expect(r.fromTs).toBe(d.setHours(0, 0, 0, 0));
    });

    it('"本月" from = 本月 1 号 0 点', () => {
      const r = parseTimeRange('本月');
      const d = new Date(NOW);
      d.setDate(1);
      expect(r.fromTs).toBe(d.setHours(0, 0, 0, 0));
    });
  });

  describe('英文关键词', () => {
    it('"today" 等同 "今天"', () => {
      const r1 = parseTimeRange('today');
      const r2 = parseTimeRange('今天');
      expect(r1.fromTs).toBe(r2.fromTs);
    });

    it('"yesterday" 等同 "昨天"', () => {
      const r1 = parseTimeRange('yesterday', 'yesterday');
      const r2 = parseTimeRange('昨天', '昨天');
      expect(r1.fromTs).toBe(r2.fromTs);
      expect(r1.toTs).toBe(r2.toTs);
    });

    it('"this week" 等同 "本周"', () => {
      const r1 = parseTimeRange('this week');
      const r2 = parseTimeRange('本周');
      expect(r1.fromTs).toBe(r2.fromTs);
    });

    it('"this month" 等同 "本月"', () => {
      const r1 = parseTimeRange('this month');
      const r2 = parseTimeRange('本月');
      expect(r1.fromTs).toBe(r2.fromTs);
    });
  });

  describe('ISO 8601', () => {
    it('完整 ISO 8601', () => {
      const r = parseTimeRange('2024-01-15T00:00:00Z');
      expect(r.fromTs).toBe(Date.parse('2024-01-15T00:00:00Z'));
    });

    it('仅日期', () => {
      const r = parseTimeRange('2024-01-15');
      expect(r.fromTs).toBe(Date.parse('2024-01-15'));
    });

    it('from + to 都是 ISO', () => {
      const r = parseTimeRange('2024-01-01', '2024-12-31');
      expect(r.fromTs).toBe(Date.parse('2024-01-01'));
      expect(r.toTs).toBe(Date.parse('2024-12-31'));
    });
  });

  describe('混合格式', () => {
    it('from=相对, to=ISO', () => {
      const r = parseTimeRange('7d', '2024-12-31');
      expect(r.fromTs).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
      expect(r.toTs).toBe(Date.parse('2024-12-31'));
    });

    it('from=中文, to=相对', () => {
      const r = parseTimeRange('今天', '6h');
      const todayStart = new Date(NOW).setHours(0, 0, 0, 0);
      expect(r.fromTs).toBe(todayStart);
      expect(r.toTs).toBe(NOW);
    });
  });

  describe('返回值类型', () => {
    it('返回的对象有 fromTs 和 toTs 字段', () => {
      const r = parseTimeRange();
      expect(r).toHaveProperty('fromTs');
      expect(r).toHaveProperty('toTs');
    });

    it('非空时间戳是数字类型', () => {
      const r = parseTimeRange('7d');
      expect(typeof r.fromTs).toBe('number');
    });
  });
});
