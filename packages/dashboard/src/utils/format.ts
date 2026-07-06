/**
 * 统一格式化工具集 —— 基于 Intl.DateTimeFormat / Intl.NumberFormat。
 *
 * 目的：消除各组件重复手写的 formatTs / fmtTime 实现（共 5+ 处），
 * 并统一千分位 / 百分比 / 时间 / 字节的展示格式。
 */

// ----- NumberFormatters（缓存，避免每次 new Intl.NumberFormat） -----
const _fmtInt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const _fmtFloat2 = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const _fmtPercent0 = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  maximumFractionDigits: 0,
});
const _fmtPercent1 = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** 千分位整数（如 1,234,567） */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return _fmtInt.format(n);
}

/** 千分位 2 位小数（如 0.85 → "0.85"，score 场景） */
export function formatFloat2(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return _fmtFloat2.format(n);
}

/** 百分比（0-1 → 0%-100%），整数显示 */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return _fmtPercent0.format(ratio);
}

/** 百分比 1 位小数（如 0.123 → "12.3%"） */
export function formatPercent1(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return _fmtPercent1.format(ratio);
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

/** 相对时间（如 "3 分钟前"） */
export function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const now = Date.now();
  const diff = now - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return formatDateTime(ts);
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

// ----- Bytes -----
/**
 * 字节数格式化（1024 进制）。
 *
 * - < 1024 → "123 B"
 * - < 1024² → "12.34 KB"
 * - < 1024³ → "1.23 MB"
 * - else → "1.23 GB"
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}
