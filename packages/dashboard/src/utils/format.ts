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
