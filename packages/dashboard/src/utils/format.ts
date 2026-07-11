/**
 * 统一格式化工具集 —— 基于 Intl.DateTimeFormat / Intl.NumberFormat。
 *
 * 目的：消除各组件重复手写的 formatTs / fmtTime 实现，
 * 并统一千分位 / 时间 / 时长的展示格式。
 */

// ----- NumberFormatters（缓存，避免每次 new Intl.NumberFormat） -----
const _fmtFloat2 = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 千分位 2 位小数（如 0.85 → "0.85"，score 场景） */
export function formatFloat2(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return _fmtFloat2.format(n);
}

// ----- DateTimeFormatters -----
const _fmtTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const _fmtDateTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const _fmtTimeWithSeconds = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 时间 HH:mm */
export function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return _fmtTime.format(new Date(ts));
}

/** 日期时间 yyyy-MM-dd HH:mm */
export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return _fmtDateTime.format(new Date(ts));
}

/** 时间 HH:mm:ss */
export function formatTimeWithSeconds(ts: number | null | undefined): string {
  if (!ts) return '—';
  return _fmtTimeWithSeconds.format(new Date(ts));
}

// ----- 时序图：时间范围 + 统计粒度（两个独立维度） -----

/**
 * 时间范围：筛选最近 N 时间内的数据。
 * 与统计粒度独立 —— "最近1天"指数据范围，不决定如何分桶。
 */
export type TimeRange = '1h' | '1d' | '1w' | '1m';

/**
 * 统计粒度：数据点如何分桶聚合。
 * - raw: 实时记录累计，不聚合（每个原始点独立显示）
 * - 1min/5min/10min/1h: 按时间窗口分桶，桶内聚合
 */
export type BucketSize = 'raw' | '1min' | '5min' | '10min' | '1h';

const _fmtHourBucket = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
});

/** 时间范围 → 毫秒数 */
export function timeRangeToMs(range: TimeRange): number {
  switch (range) {
    case '1h': return 3_600_000;
    case '1d': return 86_400_000;
    case '1w': return 604_800_000;
    case '1m': return 2_592_000_000; // 30 天
    default: return 3_600_000;
  }
}

/** 时间范围 → 中文标签 */
export function timeRangeLabel(range: TimeRange): string {
  switch (range) {
    case '1h': return '最近 1 小时';
    case '1d': return '最近 1 天';
    case '1w': return '最近 1 周';
    case '1m': return '最近 1 月';
    default: return '';
  }
}

/**
 * 获取时间戳在指定统计粒度下的桶 key（用于分组聚合）。
 * 同一桶的 key 相同，不同桶的 key 不同。
 * raw 粒度返回唯一 key（每个点独立）。
 */
export function bucketKeyBySize(ts: number, size: BucketSize): string {
  switch (size) {
    case '1min': return String(Math.floor(ts / 60_000) * 60_000);
    case '5min': return String(Math.floor(ts / 300_000) * 300_000);
    case '10min': return String(Math.floor(ts / 600_000) * 600_000);
    case '1h': {
      const d = new Date(ts);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    }
    case 'raw':
    default:
      return String(ts);
  }
}

/**
 * 按统计粒度格式化桶标签（X 轴）。
 * - raw/1min/5min/10min: HH:mm（分钟级桶显示时间）
 * - 1h: MM-DD HH:00（小时级桶显示日期+小时）
 */
export function formatBucketLabel(ts: number, size: BucketSize): string {
  if (!ts) return '—';
  const d = new Date(ts);
  switch (size) {
    case '1h':
      return _fmtHourBucket.format(d) + ':00';
    case '1min':
    case '5min':
    case '10min':
    case 'raw':
    default:
      return _fmtTime.format(d);
  }
}

/** 统计粒度 → 中文标签 */
export function bucketSizeLabel(size: BucketSize): string {
  switch (size) {
    case 'raw': return '实时记录';
    case '1min': return '1 分钟';
    case '5min': return '5 分钟';
    case '10min': return '10 分钟';
    case '1h': return '1 小时';
    default: return '';
  }
}

// ----- Duration -----
/**
 * 时长格式化（智能 ms/s）。
 *
 * - < 1000ms → "123ms"
 * - < 60s → "1.23s"
 * - >= 60s → "1m 5s"
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}
