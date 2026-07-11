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

// ----- 按时间粒度格式化（时序图聚合分析用） -----
const _fmtHour = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
});
const _fmtDay = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
});
const _fmtMonth = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
});

/** 时间粒度类型 */
export type TimeGranularity = 'raw' | 'hour' | 'day' | 'week' | 'month';

/**
 * 按时间粒度格式化时间戳。
 * - raw: HH:mm
 * - hour: MM-DD HH
 * - day: MM-DD
 * - week: 第 N 周（基于 ISO 周计算）
 * - month: YYYY-MM
 */
export function formatByGranularity(ts: number, g: TimeGranularity): string {
  if (!ts) return '—';
  const d = new Date(ts);
  switch (g) {
    case 'hour':
      return _fmtHour.format(d) + ':00';
    case 'day':
      return _fmtDay.format(d);
    case 'week': {
      // ISO 周数计算
      const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const dayNum = tmp.getUTCDay() || 7;
      tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    }
    case 'month':
      return _fmtMonth.format(d);
    case 'raw':
    default:
      return _fmtTime.format(d);
  }
}

/**
 * 获取时间戳在指定粒度下的桶 key（用于分组聚合）。
 * 同一桶的 key 相同，不同桶的 key 不同。
 */
export function timeBucketKey(ts: number, g: TimeGranularity): string {
  const d = new Date(ts);
  switch (g) {
    case 'hour':
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    case 'day':
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    case 'week': {
      const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const dayNum = tmp.getUTCDay() || 7;
      tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    }
    case 'month':
      return `${d.getFullYear()}-${d.getMonth()}`;
    case 'raw':
    default:
      return String(ts);
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
