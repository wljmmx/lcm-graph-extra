<script setup lang="ts">
/**
 * MoA 多模型性能监控 —— 复杂度分析、延迟百分位、模型级指标、运行记录。
 *
 * 数据层：useMonitorData() 统一提供 moaPerf 性能数据（30s 轮询）。
 */
import { computed, ref, h } from 'vue';
import {
  NGrid,
  NGi,
  NCard,
  NEmpty,
  NTag,
  NSpace,
  NSpin,
  NDivider,
  NSelect,
  NButton,
  NTable,
  NDataTable,
  NCollapse,
  NCollapseItem,
  NDescriptions,
  NDescriptionsItem,
} from 'naive-ui';
import MoaStatusBadge from '../../components/MoaStatusBadge.vue';
import KpiCard from '../../components/KpiCard.vue';
import EChart from '../../components/EChart.vue';
import { useMonitorData } from '../../composables/useMonitorData';
import { timeRangeToMs, type TimeRange } from '../../utils/format';

const { moaPerf: rawMoaPerf, moaPerfLoading, CHART } = useMonitorData();

// 防御性补全：上游响应可能缺失部分字段（如 snapshot 服务返回非 200 时 fallback 不完整）
const moaPerf = computed(() => {
  if (!rawMoaPerf.value) return null;
  const d = rawMoaPerf.value as any;
  return {
    ...d,
    allComplexityPercentiles: d.allComplexityPercentiles ?? { p50: 0, p90: 0, p95: 0, p99: 0 },
    complexityPercentiles: d.complexityPercentiles ?? { p50: 0, p90: 0, p95: 0, p99: 0 },
    allComplexityHistory: d.allComplexityHistory ?? [],
    complexityHistory: d.complexityHistory ?? [],
    allComplexityDistribution: d.allComplexityDistribution ?? { low: 0, medium: 0, high: 0 },
    complexityDistribution: d.complexityDistribution ?? { low: 0, medium: 0, high: 0 },
    complexityHourlyBuckets: d.complexityHourlyBuckets ?? [],
    complexityDailyBuckets: d.complexityDailyBuckets ?? [],
    latencyPercentiles: d.latencyPercentiles ?? { p50: 0, p90: 0, p95: 0, p99: 0 },
    refLatencyPercentiles: d.refLatencyPercentiles ?? { p50: 0, p90: 0, p95: 0, p99: 0 },
    aggLatencyPercentiles: d.aggLatencyPercentiles ?? { p50: 0, p90: 0, p95: 0, p99: 0 },
    modelBreakdown: d.modelBreakdown ?? [],
    errorBreakdown: d.errorBreakdown ?? {},
    recentRuns: d.recentRuns ?? [],
    // v2: 价值指标默认值
    avgNetValue: d.avgNetValue ?? 0,
    avgExpectedUplift: d.avgExpectedUplift ?? 0,
    avgCapabilityGap: d.avgCapabilityGap ?? 0,
    meetTargetRate: d.meetTargetRate ?? 0,
    belowTargetCount: d.belowTargetCount ?? 0,
    netValueHistory: d.netValueHistory ?? [],
    lastDecision: d.lastDecision ?? null,
    taskBreakdown: d.taskBreakdown ?? [],
    learning: d.learning ?? { capability: [], tokens: [] },
  };
});

// ── 辅助函数 ──
function formatMs(ms: number): string {
  if (ms <= 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTimeHMS(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ── 复杂度趋势：聚合维度 + 时间范围 ──
type ComplexityAggregation = 'raw' | 'hourly' | 'daily';
const complexityAggregation = ref<ComplexityAggregation>('raw');
const complexityTimeRange = ref<TimeRange>('1h');
const complexityAggOptions = [
  { label: '实时记录', value: 'raw' as ComplexityAggregation },
  { label: '按小时', value: 'hourly' as ComplexityAggregation },
  { label: '按天', value: 'daily' as ComplexityAggregation },
];
const complexityTimeRangeOptions = [
  { label: '最近 1 小时', value: '1h' as TimeRange },
  { label: '最近 1 天', value: '1d' as TimeRange },
  { label: '最近 1 周', value: '1w' as TimeRange },
];

// ── 派生计算 ──
const moaSuccessRate = computed(() => {
  if (!moaPerf.value || moaPerf.value.totalRuns === 0) return 0;
  return (moaPerf.value.successRuns / moaPerf.value.totalRuns) * 100;
});

const moaSuccessRateType = computed(() => {
  const r = moaSuccessRate.value;
  return r >= 90 ? 'success' : r >= 70 ? 'warning' : 'error';
});

// ── 错误类型中文说明 ──
const errorTypeLabels: Record<string, string> = {
  timeout: '超时',
  aborted: '中止/取消',
  sync_budget_exceeded: '同步预算超限',
  dns_error: 'DNS解析失败',
  ssl_error: 'SSL/TLS证书错误',
  connection: '连接/网络错误',
  rate_limit: '限流/配额超限',
  auth_error: '认证/授权失败',
  model_not_found: '模型不存在',
  context_length: '上下文长度超限',
  server_error: '服务端错误(500/502/504)',
  overloaded: '服务过载(503)',
  content_filter: '内容安全拦截',
  parse_error: '解析错误',
  empty_response: '空响应',
  stream_error: '流式传输错误',
  memory_error: '内存不足',
  config_error: '配置错误',
  unknown: '未知错误',
  other: '其他',
};

const moaErrorItems = computed(() => {
  if (!moaPerf.value?.errorBreakdown) return [];
  return Object.entries(moaPerf.value.errorBreakdown).sort((a, b) => b[1] - a[1]);
});

// ── 复杂度趋势图 ──
const moaComplexityTrendOption = computed(() => {
  const agg = complexityAggregation.value;
  const rangeMs = timeRangeToMs(complexityTimeRange.value);
  const now = Date.now();

  if (agg === 'raw') {
    const allHistory = moaPerf.value?.allComplexityHistory;
    const moaHistory = moaPerf.value?.complexityHistory;
    if (!allHistory || allHistory.length === 0) return {};

    const sorted = [...allHistory]
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((r) => now - r.timestamp <= rangeMs)
      .slice(-30);

    if (sorted.length === 0) return {};

    const xLabels = sorted.map((r) => {
      const d = new Date(r.timestamp);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    });

    const allSeries = {
      name: '全量复杂度',
      type: 'line',
      data: sorted.map((r, i) => [i, r.score]),
      smooth: true,
      lineStyle: { color: CHART.value.primary, width: 2 },
      itemStyle: { color: CHART.value.primary },
      symbol: 'circle',
      symbolSize: 6,
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { color: CHART.value.warning, type: 'dashed' },
        data: [{ yAxis: 0.6, label: { formatter: '阈值 0.6' } }],
      },
    };

    const moaTimestamps = new Set((moaHistory ?? []).map((r) => r.timestamp));
    const sortedIndexMap = new Map(sorted.map((r, i) => [r.timestamp, i]));
    const moaPoints = sorted
      .filter((r) => moaTimestamps.has(r.timestamp))
      .map((r) => [sortedIndexMap.get(r.timestamp) ?? 0, r.score]);

    const moaSeries = moaPoints.length > 0 ? {
      name: 'MoA 触发',
      type: 'scatter',
      data: moaPoints,
      symbolSize: 10,
      itemStyle: { color: CHART.value.danger },
      symbol: 'diamond',
      z: 10,
    } : undefined;

    const series = moaSeries ? [allSeries, moaSeries] : [allSeries];

    return {
      title: undefined,
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params];
          const idx = items[0]?.data?.[0];
          const label = idx !== undefined && idx < xLabels.length ? xLabels[idx] : '';
          let html = `${label}<br/>`;
          for (const p of items) {
            const val = p.data?.[1];
            html += `${p.marker}${p.seriesName}: ${val !== null && val !== undefined ? (val as number).toFixed(3) : '—'}<br/>`;
          }
          return html;
        },
      },
      legend: { data: moaSeries ? ['全量复杂度', 'MoA 触发'] : ['全量复杂度'], bottom: 0 },
      xAxis: { type: 'category', data: xLabels, axisLabel: { fontSize: 10, rotate: 45 }, name: '时间', nameLocation: 'middle', nameGap: 30 },
      yAxis: { type: 'value', name: '评分', min: 0, max: 1, axisLabel: { formatter: (v: number) => v.toFixed(1) } },
      series,
      grid: { left: 50, right: 30, bottom: 55, top: 45 },
    };
  }

  if (agg === 'hourly') {
    const hourly = moaPerf.value?.complexityHourlyBuckets;
    if (!hourly || hourly.length === 0) return {};

    const maxHours = Math.ceil(rangeMs / 3600_000);
    const filtered = hourly.slice(-Math.min(maxHours, hourly.length));
    if (filtered.length === 0) return {};

    const allSeries = {
      name: '全量 (小时均)',
      type: 'line',
      data: filtered.map((b) => [b.hour, b.avg]),
      smooth: true,
      lineStyle: { color: CHART.value.primary, width: 2 },
      itemStyle: { color: CHART.value.primary },
      symbol: 'circle', symbolSize: 6,
      areaStyle: { color: 'rgba(32,128,240,0.08)' },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: CHART.value.warning, type: 'dashed' },
        data: [{ yAxis: 0.6, label: { formatter: '阈值 0.6' } }],
      },
    };

    const moaHistory = moaPerf.value?.complexityHistory;
    const moaByHour: Map<string, number[]> = new Map();
    if (moaHistory) {
      for (const h of moaHistory) {
        if (now - h.timestamp > rangeMs) continue;
        const d = new Date(h.timestamp);
        const key = `${String(d.getHours()).padStart(2, '0')}:00`;
        if (!moaByHour.has(key)) moaByHour.set(key, []);
        moaByHour.get(key)!.push(h.score);
      }
    }
    const moaData = filtered.map((b) => {
      const scores = moaByHour.get(b.hour) ?? [];
      return [b.hour, scores.length > 0 ? Math.round(scores.reduce((a, c) => a + c, 0) / scores.length * 1000) / 1000 : null];
    });
    const hasMoaData = moaData.some((d) => d[1] !== null);

    const moaSeries = hasMoaData ? {
      name: 'MoA 触发 (小时均)',
      type: 'line',
      data: moaData,
      smooth: true,
      lineStyle: { color: CHART.value.danger, width: 2 },
      itemStyle: { color: CHART.value.danger },
      symbol: 'diamond', symbolSize: 8,
      connectNulls: false,
    } : undefined;

    const series = moaSeries ? [allSeries, moaSeries] : [allSeries];

    return {
      title: undefined,
      tooltip: { trigger: 'axis', formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        let html = `${items[0].axisValue}<br/>`;
        for (const p of items) {
          const val = p.data?.[1];
          html += `${p.marker}${p.seriesName}: ${val !== null && val !== undefined ? (val as number).toFixed(3) : '—'}<br/>`;
        }
        return html;
      }},
      legend: { data: moaSeries ? ['全量 (小时均)', 'MoA 触发 (小时均)'] : ['全量 (小时均)'], bottom: 0 },
      xAxis: { type: 'category', data: filtered.map((b) => b.hour), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: '评分', min: 0, max: 1, axisLabel: { formatter: (v: number) => v.toFixed(1) } },
      series,
      grid: { left: 50, right: 30, bottom: 45, top: 45 },
    };
  }

  // 按天模式
  const daily = moaPerf.value?.complexityDailyBuckets;
  if (!daily || daily.length === 0) return {};

  const maxDays = Math.ceil(rangeMs / 86_400_000);
  const filtered = daily.slice(-Math.min(maxDays, daily.length));
  if (filtered.length === 0) return {};

  const allSeries = {
    name: '全量 (日均)',
    type: 'line',
    data: filtered.map((b) => [b.date, b.avg]),
    smooth: true,
    lineStyle: { color: CHART.value.primary, width: 2 },
    itemStyle: { color: CHART.value.primary },
    symbol: 'circle', symbolSize: 8,
    areaStyle: { color: 'rgba(32,128,240,0.08)' },
    markLine: {
      silent: true, symbol: 'none',
      lineStyle: { color: CHART.value.warning, type: 'dashed' },
      data: [{ yAxis: 0.6, label: { formatter: '阈值 0.6' } }],
    },
  };

  const moaHistory = moaPerf.value?.complexityHistory;
  const moaByDay: Map<string, number[]> = new Map();
  if (moaHistory) {
    for (const h of moaHistory) {
      if (now - h.timestamp > rangeMs) continue;
      const d = new Date(h.timestamp);
      const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!moaByDay.has(key)) moaByDay.set(key, []);
      moaByDay.get(key)!.push(h.score);
    }
  }
  const moaData = filtered.map((b) => {
    const scores = moaByDay.get(b.date) ?? [];
    return [b.date, scores.length > 0 ? Math.round(scores.reduce((a, c) => a + c, 0) / scores.length * 1000) / 1000 : null];
  });
  const hasMoaData = moaData.some((d) => d[1] !== null);

  const moaSeries = hasMoaData ? {
    name: 'MoA 触发 (日均)',
    type: 'line',
    data: moaData,
    smooth: true,
    lineStyle: { color: CHART.value.danger, width: 2 },
    itemStyle: { color: CHART.value.danger },
    symbol: 'diamond', symbolSize: 8,
    connectNulls: false,
  } : undefined;

  const series = moaSeries ? [allSeries, moaSeries] : [allSeries];

  return {
    title: undefined,
    tooltip: { trigger: 'axis', formatter: (params: any) => {
      const items = Array.isArray(params) ? params : [params];
      let html = `${items[0].axisValue}<br/>`;
      for (const p of items) {
        const val = p.data?.[1];
        html += `${p.marker}${p.seriesName}: ${val !== null && val !== undefined ? (val as number).toFixed(3) : '—'}<br/>`;
      }
      return html;
    }},
    legend: { data: moaSeries ? ['全量 (日均)', 'MoA 触发 (日均)'] : ['全量 (日均)'], bottom: 0 },
    xAxis: { type: 'category', data: filtered.map((b) => b.date), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', name: '评分', min: 0, max: 1, axisLabel: { formatter: (v: number) => v.toFixed(1) } },
    series,
    grid: { left: 50, right: 30, bottom: 45, top: 45 },
  };
});

// ── 复杂度分布图 ──
const moaComplexityDistOption = computed(() => {
  const moaDist = moaPerf.value?.complexityDistribution;
  const allDist = moaPerf.value?.allComplexityDistribution;
  if (!allDist) return {};

  const allTotal = allDist.low + allDist.medium + allDist.high;
  const moaTotal = moaDist ? moaDist.low + moaDist.medium + moaDist.high : 0;

  return {
    title: undefined,
    tooltip: { trigger: 'axis', formatter: (params: any) => {
      let html = '';
      for (const p of params) html += `${p.marker}${p.seriesName}: ${p.value}<br/>`;
      html += `全量总计: ${allTotal}<br/>`;
      html += `MoA 触发: ${moaTotal} (${allTotal > 0 ? Math.round(moaTotal / allTotal * 100) : 0}%)`;
      return html;
    }},
    legend: { data: ['全量', 'MoA 触发'], bottom: 0 },
    xAxis: { type: 'category', data: ['低 (0-0.4)', '中 (0.4-0.7)', '高 (0.7-1.0)'], axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', name: '次数', minInterval: 1 },
    series: [
      {
        name: '全量', type: 'bar',
        data: [allDist.low, allDist.medium, allDist.high],
        itemStyle: { color: CHART.value.primary },
        label: { show: true, position: 'top', formatter: '{c}' },
      },
      {
        name: 'MoA 触发', type: 'bar',
        data: moaDist ? [moaDist.low, moaDist.medium, moaDist.high] : [0, 0, 0],
        itemStyle: { color: CHART.value.danger },
        label: { show: true, position: 'top', formatter: '{c}' },
      },
    ],
    grid: { left: 50, right: 30, bottom: 60, top: 45 },
  };
});

// ── 延迟阶段分解图 ──
const moaLatencyPhaseOption = computed(() => {
  const runs = moaPerf.value?.recentRuns;
  if (!runs || runs.length === 0) return {};
  const data = [...runs].slice(0, 10).reverse();
  return {
    title: undefined,
    tooltip: { trigger: 'axis', formatter: (params: any) => {
      let h = params[0].name + '<br/>';
      for (const p of params) h += `${p.marker}${p.seriesName}: ${(Number(p.value) / 1000).toFixed(2)}s<br/>`;
      return h;
    }},
    legend: { data: ['参考模型', '聚合模型'], bottom: 0 },
    xAxis: { type: 'category', data: data.map((r) => r.queryPreview.slice(0, 16) + (r.queryPreview.length > 16 ? '...' : '')), axisLabel: { fontSize: 10, rotate: 30 } },
    yAxis: { type: 'value', name: '耗时 (s)', axisLabel: { formatter: (v: number) => (v / 1000).toFixed(1) } },
    series: [
      { name: '参考模型', type: 'bar', stack: 'total', data: data.map((r) => r.refMs), itemStyle: { color: CHART.value.primary } },
      { name: '聚合模型', type: 'bar', stack: 'total', data: data.map((r) => r.aggMs), itemStyle: { color: CHART.value.success } },
    ],
    grid: { left: 60, right: 30, bottom: 60, top: 45 },
  };
});

// ── Token 按模型分布（饼图）──
const moaTokenByModelOption = computed(() => {
  const breakdown = moaPerf.value?.modelBreakdown;
  if (!breakdown || breakdown.length === 0) return {};
  const items = (breakdown as any[])
    .filter((m) => m.totalTokens > 0)
    .map((m) => ({ name: m.model, value: m.totalTokens }));
  if (items.length === 0) return {};
  const total = items.reduce((s, i) => s + i.value, 0);
  const palette = [CHART.value.primary, CHART.value.success, CHART.value.warning, CHART.value.danger, CHART.value.info, CHART.value.neutral];
  return {
    title: undefined,
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => {
        const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : '0.0';
        return `${p.name}<br/>${p.marker}Token: ${formatTokens(p.value)} (${pct}%)`;
      },
    },
    legend: { type: 'scroll', orient: 'vertical', right: 10, top: 'center', textStyle: { fontSize: 11 } },
    series: [
      {
        name: 'Token 占比',
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['38%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { show: true, formatter: '{d}%' },
        data: items.map((i, idx) => ({ ...i, itemStyle: { color: palette[idx % palette.length] } })),
      },
    ],
  };
});

// ── 响应时间按模型分布（横向柱状图）──
const moaLatencyByModelOption = computed(() => {
  const breakdown = moaPerf.value?.modelBreakdown;
  if (!breakdown || breakdown.length === 0) return {};
  const items = (breakdown as any[])
    .filter((m) => m.avgLatencyMs > 0)
    .sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)
    .slice(-10);
  if (items.length === 0) return {};
  return {
    title: undefined,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        return `${p.name}<br/>${p.marker}平均耗时: ${(Number(p.value) / 1000).toFixed(2)}s`;
      },
    },
    grid: { left: 10, right: 50, bottom: 10, top: 30, containLabel: true },
    xAxis: { type: 'value', name: '耗时 (s)', axisLabel: { formatter: (v: number) => (v / 1000).toFixed(1) } },
    yAxis: { type: 'category', data: items.map((m) => m.model), axisLabel: { fontSize: 10 } },
    series: [
      {
        name: '平均响应时间',
        type: 'bar',
        data: items.map((m) => m.avgLatencyMs),
        itemStyle: { color: CHART.value.primary },
        label: { show: true, position: 'right', formatter: (p: any) => `${(Number(p.value) / 1000).toFixed(2)}s` },
      },
    ],
  };
});

// ── 模型级图表数据可用性（用于模板 v-if）──
const moaHasTokenByModel = computed(() => {
  const breakdown = moaPerf.value?.modelBreakdown as any[] | undefined;
  return !!breakdown && breakdown.length > 0 && breakdown.some((m) => m.totalTokens > 0);
});

const moaHasLatencyByModel = computed(() => {
  const breakdown = moaPerf.value?.modelBreakdown as any[] | undefined;
  return !!breakdown && breakdown.length > 0 && breakdown.some((m) => m.avgLatencyMs > 0);
});

// ── 最近运行表格列 ──
const moaRunsColumns = computed(() => [
  { title: '时间', key: 'timestamp', width: 80, render: (row: any) => h('span', { class: 'mono' }, formatTimeHMS(row.timestamp)) },
  { title: '查询', key: 'queryPreview', ellipsis: { tooltip: true }, render: (row: any) => row.queryPreview.slice(0, 50) },
  { title: '复杂度', key: 'complexityScore', width: 80, render: (row: any) => row.complexityScore !== undefined ? row.complexityScore.toFixed(3) : '—' },
  { title: '模式', key: 'mode', width: 80, render: (row: any) => h(NTag, { size: 'tiny', type: row.mode === 'parallel' ? 'info' : 'default' }, { default: () => row.mode }) },
  { title: '状态', key: 'success', width: 70, render: (row: any) => h(NTag, { size: 'tiny', type: row.success ? 'success' : 'error' }, { default: () => row.success ? '成功' : '失败' }) },
  { title: '总耗时', key: 'totalMs', width: 80, render: (row: any) => h('span', { class: 'mono' }, formatMs(row.totalMs)) },
  { title: '参考', key: 'refCount', width: 120, render: (row: any) => h('span', { class: 'mono' }, `${row.validRefCount}/${row.refCount} (${formatMs(row.refMs)})`) },
  { title: '聚合', key: 'aggMs', width: 100, render: (row: any) => h('span', { class: 'mono' }, formatMs(row.aggMs)) },
  { title: 'Tokens', key: 'totalTokens', width: 80, render: (row: any) => h('span', { class: 'mono' }, formatTokens(row.totalTokens)) },
]);

// 任务类型净收益维度表（收敛自定义 model-table → NDataTable）
const taskBreakdownColumns = [
  { title: '任务类型', key: 'task', render: (row: any) => row.task || '未分类' },
  { title: '运行次数', key: 'runCount', width: 90, align: 'right', render: (row: any) => h('span', { class: 'mono' }, row.runCount) },
  { title: '平均能力差距', key: 'avgCapabilityGap', width: 110, align: 'right', render: (row: any) => h('span', { class: 'mono' }, row.avgCapabilityGap.toFixed(3)) },
  { title: '平均净收益', key: 'avgNetValue', width: 110, align: 'right', render: (row: any) => h('span', { class: 'mono' }, row.avgNetValue.toFixed(3)) },
  { title: '达标率', key: 'meetTargetRate', width: 90, align: 'right', render: (row: any) => h(NTag, { size: 'tiny', type: row.meetTargetRate >= 0.9 ? 'success' : row.meetTargetRate >= 0.7 ? 'warning' : 'error' }, { default: () => `${(row.meetTargetRate * 100).toFixed(0)}%` }) },
];
const taskBreakdownRows = computed(() => moaPerf.value.taskBreakdown ?? []);

// 模型能力校准表（收敛自定义 model-table → NDataTable）
const calibrationColumns = [
  { title: '模型', key: 'model', render: (row: any) => h('span', { class: 'mono' }, row.model) },
  { title: '任务', key: 'task', render: (row: any) => row.task || '—' },
  { title: '可靠性', key: 'reliability', width: 90, align: 'right', render: (row: any) => h(NTag, { size: 'tiny', type: row.reliability >= 0.8 ? 'success' : row.reliability >= 0.5 ? 'warning' : 'error' }, { default: () => `${(row.reliability * 100).toFixed(0)}%` }) },
  { title: '样本', key: 'total', width: 80, align: 'right', render: (row: any) => h('span', { class: 'mono' }, row.total) },
];
const calibrationRows = computed(() => moaCalibratedModels.value ?? []);

// 模型级指标表（收敛自定义 model-table → NDataTable）
const modelBreakdownColumns = [
  { title: '模型', key: 'model', render: (row: any) => h('span', { class: 'mono' }, row.model) },
  { title: '角色', key: 'role', width: 80, render: (row: any) => h(NTag, { size: 'tiny', type: row.role === 'agg' ? 'success' : 'info', title: row.role === 'agg' ? '聚合模型' : '参考模型' }, { default: () => row.role === 'agg' ? '聚合' : '参考' }) },
  { title: '次数', key: 'runCount', width: 70, align: 'right', render: (row: any) => h('span', { class: 'mono' }, row.runCount) },
  { title: '成功率', key: 'successRate', width: 80, align: 'right', render: (row: any) => row.runCount > 0 ? h(NTag, { size: 'tiny', type: row.successCount / row.runCount >= 0.9 ? 'success' : 'warning' }, { default: () => `${((row.successCount / row.runCount) * 100).toFixed(0)}%` }) : h('span', { class: 'mono' }, '--') },
  { title: 'P50', key: 'p50LatencyMs', width: 80, align: 'right', render: (row: any) => h('span', { class: 'mono' }, formatMs(row.p50LatencyMs)) },
  { title: 'P95', key: 'p95LatencyMs', width: 80, align: 'right', render: (row: any) => h('span', { class: 'mono' }, formatMs(row.p95LatencyMs)) },
  { title: '平均耗时', key: 'avgLatencyMs', width: 90, align: 'right', render: (row: any) => h('span', { class: 'mono' }, formatMs(row.avgLatencyMs)) },
  { title: 'Avg Tokens', key: 'avgTokens', width: 100, align: 'right', render: (row: any) => h('span', { class: 'mono' }, formatTokens(row.avgTokens)) },
  { title: '总 Token', key: 'totalTokens', width: 100, align: 'right', render: (row: any) => h('span', { class: 'mono' }, formatTokens(row.totalTokens)) },
];
const modelBreakdownRows = computed(() => moaPerf.value.modelBreakdown ?? []);

// ── v2: 价值指标（能力提升 vs 成本）──
const moaMeetTargetRateType = computed(() => {
  const r = moaPerf.value.meetTargetRate * 100;
  return r >= 90 ? 'success' : r >= 70 ? 'warning' : 'error';
});

// 净收益趋势图（净收益 vs 动态门槛线，误触发标红）
const moaNetValueTrendOption = computed(() => {
  const history = moaPerf.value.netValueHistory;
  if (!history || history.length === 0) return {};
  const times = history.map((h) => formatTimeHMS(h.timestamp));
  const netValues = history.map((h) => h.netValue);
  const thresholds = history.map((h) => h.threshold);
  return {
    title: undefined,
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const list = Array.isArray(params) ? params : [params];
        const i = list[0]?.dataIndex ?? 0;
        const rec = history[i];
        const lines = list.map((p: any) => `${p.marker}${p.seriesName}: ${Number(p.value).toFixed(3)}`);
        return `${formatTimeHMS(rec.timestamp)}<br/>${lines.join('<br/>')}<br/>触发: ${rec.triggered ? '是' : '否'}`;
      },
    },
    legend: { data: ['净收益', '生效门槛'], top: 0, right: 0, textStyle: { fontSize: 11 } },
    grid: { left: 40, right: 16, bottom: 24, top: 28, containLabel: true },
    xAxis: { type: 'category', data: times, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', name: '净收益', axisLabel: { formatter: (v: number) => v.toFixed(2) } },
    series: [
      {
        name: '净收益',
        type: 'line',
        data: netValues,
        smooth: true,
        symbolSize: 7,
        itemStyle: {
          color: (p: any) => {
            const rec = history[p.dataIndex];
            return rec.triggered && rec.netValue < rec.threshold ? CHART.value.danger : CHART.value.primary;
          },
        },
      },
      { name: '生效门槛', type: 'line', data: thresholds, lineStyle: { type: 'dashed', color: CHART.value.warning }, symbol: 'none' },
    ],
  };
});

const moaHasValueData = computed(() => moaPerf.value.netValueHistory.length > 0);

// ── 模式分布（parallel/serial 等）──
const moaModeDistribution = computed(() => {
  const map: Record<string, number> = {};
  for (const r of moaPerf.value.recentRuns) {
    if (r.mode) map[r.mode] = (map[r.mode] ?? 0) + 1;
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
});

// ── 学习校准：capability 可靠性 / tokens ──
const moaCalibratedModels = computed(() => {
  const cap = moaPerf.value.learning.capability ?? [];
  return cap
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);
});
const moaHasCalibration = computed(() => moaCalibratedModels.value.length > 0);
</script>

<template>
  <div class="moa-view">
    <div v-if="moaPerfLoading && !moaPerf" class="chart-loading">
      <NSpin size="small" />
    </div>

    <template v-else-if="moaPerf">
      <!-- MoA 状态徽章 -->
      <div class="moa-badge-bar">
        <MoaStatusBadge />
      </div>

      <!-- KPI 概览行 1 -->
      <NGrid :cols="'1 s:2 m:3'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <KpiCard label="总运行次数" :value="moaPerf.totalRuns" :threshold="0">
            <template #detail>
              <NSpace :size="4">
                <NTag size="tiny" type="success">{{ moaPerf.successRuns }} 成功</NTag>
                <NTag v-if="moaPerf.failedRuns > 0" size="tiny" type="error">{{ moaPerf.failedRuns }} 失败</NTag>
                <NTag v-if="moaPerf.fallbackCount > 0" size="tiny" type="warning">{{ moaPerf.fallbackCount }} 回退</NTag>
              </NSpace>
            </template>
          </KpiCard>
        </NGi>
        <NGi>
          <KpiCard label="成功率" :value="moaPerf.totalRuns > 0 ? moaSuccessRate : 0" unit="%" :threshold="90">
            <template #detail>
              <NTag size="tiny" :type="moaSuccessRateType">{{ moaSuccessRate >= 90 ? '健康' : moaSuccessRate >= 70 ? '注意' : '告警' }}</NTag>
            </template>
          </KpiCard>
        </NGi>
        <NGi>
          <KpiCard label="平均耗时" :value="Math.round(moaPerf.avgTotalMs / 1000)" unit="s" :threshold="120">
            <template #detail>
              <span class="muted">参考 {{ formatMs(moaPerf.avgRefMs) }} / 聚合 {{ formatMs(moaPerf.avgAggMs) }}</span>
            </template>
          </KpiCard>
        </NGi>
      </NGrid>

      <!-- KPI 概览行 2 -->
      <NGrid :cols="'1 s:2 m:3'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <KpiCard label="Token 消耗" :value="moaPerf.totalTokens">
            <template #detail>
              <span class="muted">平均 {{ formatTokens(moaPerf.avgTokens) }}/次 · 效率 {{ moaPerf.tokenEfficiency }} 字符/Token</span>
            </template>
          </KpiCard>
        </NGi>
        <NGi>
          <KpiCard label="平均复杂度" :value="moaPerf.avgComplexityScore" :threshold="0.6">
            <template #detail>
              <NTag size="tiny" :type="moaPerf.avgComplexityScore >= 0.7 ? 'error' : moaPerf.avgComplexityScore >= 0.4 ? 'warning' : 'info'">
                {{ moaPerf.avgComplexityScore >= 0.7 ? '高' : moaPerf.avgComplexityScore >= 0.4 ? '中' : '低' }}
              </NTag>
            </template>
          </KpiCard>
        </NGi>
        <NGi>
          <KpiCard label="平均响应" :value="moaPerf.avgResponseLen" unit="字符" />
        </NGi>
      </NGrid>

      <!-- 价值指标（进阶，默认折叠以降低首屏信息密度） -->
      <NCollapse :default-expanded-names="[]" style="margin-bottom: 16px">
        <NCollapseItem name="value" title="MoA 价值指标（能力提升 vs 成本）">
          <!-- KPI 概览行 3：MoA 价值指标 -->
          <NGrid :cols="'1 s:2 m:4'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <KpiCard label="净收益达标率" :value="moaPerf.meetTargetRate * 100" unit="%" :threshold="90">
            <template #detail>
              <span class="muted">达标次数 {{ (moaPerf.netValueHistory || []).filter((h: any) => h.netValue >= h.threshold).length }} / {{ (moaPerf.netValueHistory || []).length }}</span>
            </template>
          </KpiCard>
        </NGi>
        <NGi>
          <KpiCard label="平均净收益" :value="moaPerf.avgNetValue">
            <template #detail>
              <span class="muted">生效门槛 {{ moaPerf.lastDecision?.effectiveThreshold ?? 0 }}</span>
            </template>
          </KpiCard>
        </NGi>
        <NGi>
          <KpiCard label="平均能力提升" :value="moaPerf.avgExpectedUplift">
            <template #detail>
              <span class="muted">净收益门槛 ≥ {{ (moaPerf.lastDecision?.effectiveBenefit ?? moaPerf.lastDecision?.benefitThreshold ?? 0.10).toFixed(3) }}</span>
            </template>
          </KpiCard>
        </NGi>
        <NGi>
          <KpiCard label="平均能力差距" :value="moaPerf.avgCapabilityGap">
            <template #detail>
              <NTag v-if="moaPerf.belowTargetCount > 0" size="tiny" type="warning">{{ moaPerf.belowTargetCount }} 次未达标</NTag>
              <span v-else class="muted">主模型 vs 聚合后</span>
            </template>
          </KpiCard>
        </NGi>
      </NGrid>

      <!-- 净收益趋势 + 最近决策 -->
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <NCard title="净收益趋势（能力提升 − 成本惩罚）" size="small" :bordered="true">
            <template #header-extra>
              <span class="muted" style="font-size: var(--fs-caption)">红点为误触发（净收益低于门槛）</span>
            </template>
            <template v-if="moaHasValueData">
              <EChart :option="moaNetValueTrendOption" height="260px" :skip-theme="true" aria-label="MoA 净收益趋势图：每次触发的净收益与生效门槛对比" />
            </template>
            <NEmpty v-else description="暂无价值决策数据，启用 MoA 后自动收集" style="padding: 12px 0" />
          </NCard>
        </NGi>
        <NGi>
          <NCard title="最近一次 MoA 决策" size="small" :bordered="true">
            <template v-if="moaPerf.lastDecision">
              <NDescriptions :column="2" size="small" label-placement="left" bordered>
                <NDescriptionsItem label="触发时机">
                  <NTag size="tiny" :type="moaPerf.lastDecision.triggered ? 'success' : 'default'">{{ moaPerf.lastDecision.triggered ? '已触发' : '未触发' }}</NTag>
                </NDescriptionsItem>
                <NDescriptionsItem label="时间">{{ formatTimeHMS(moaPerf.lastDecision.timestamp) }}</NDescriptionsItem>
                <NDescriptionsItem label="主模型能力">{{ moaPerf.lastDecision.mainModelStrength?.toFixed(3) }}</NDescriptionsItem>
                <NDescriptionsItem label="聚合后能力">{{ moaPerf.lastDecision.aggregateStrength?.toFixed(3) }}</NDescriptionsItem>
                <NDescriptionsItem label="能力差距">{{ moaPerf.lastDecision.capabilityGap?.toFixed(3) }}</NDescriptionsItem>
                <NDescriptionsItem label="期望提升">{{ moaPerf.lastDecision.expectedUplift?.toFixed(3) }}</NDescriptionsItem>
                <NDescriptionsItem label="成本惩罚">{{ moaPerf.lastDecision.costPenalty?.toFixed(3) }}</NDescriptionsItem>
                <NDescriptionsItem label="净收益">
                  <NTag size="tiny" :type="moaPerf.lastDecision.netValue >= moaPerf.lastDecision.effectiveThreshold ? 'success' : 'error'">{{ moaPerf.lastDecision.netValue?.toFixed(3) }}</NTag>
                </NDescriptionsItem>
                <NDescriptionsItem v-if="moaPerf.lastDecision.reasons && moaPerf.lastDecision.reasons.length" label="决策原因" :span="2">
                  <div class="reason-list">
                    <NTag v-for="(r, i) in moaPerf.lastDecision.reasons" :key="i" size="tiny" type="info">{{ r }}</NTag>
                  </div>
                </NDescriptionsItem>
              </NDescriptions>
            </template>
            <NEmpty v-else description="暂无决策记录" style="padding: 12px 0" />
          </NCard>
        </NGi>
      </NGrid>

      <!-- 任务类型维度价值指标 -->
      <NCard title="任务类型净收益维度" size="small" style="margin-bottom: 16px">
        <template v-if="moaPerf.taskBreakdown.length > 0">
          <NDataTable
            :columns="taskBreakdownColumns"
            :data="taskBreakdownRows"
            :bordered="false"
            size="small"
            :scroll-x="580"
          />
        </template>
        <NEmpty v-else description="暂无任务类型数据" style="padding: 12px 0" />
      </NCard>
        </NCollapseItem>
      </NCollapse>

      <!-- 模式分布 + 学习校准 -->
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <NCard title="调度模式分布" size="small" :bordered="true">
            <template v-if="moaModeDistribution.length > 0">
              <div class="error-list">
                <div v-for="[mode, count] in moaModeDistribution" :key="mode" class="error-item">
                  <NTag size="small" :type="mode === 'parallel' ? 'info' : 'default'">{{ mode }}</NTag>
                  <span class="error-count">{{ count }} 次</span>
                  <div class="error-bar-track">
                    <div class="error-bar-fill" :style="{ width: moaPerf.recentRuns.length > 0 ? ((count / moaPerf.recentRuns.length) * 100).toFixed(0) + '%' : '0%' }" />
                  </div>
                </div>
              </div>
            </template>
            <NEmpty v-else description="暂无模式数据" style="padding: 12px 0" />
          </NCard>
        </NGi>
        <NGi>
          <NCard title="模型能力校准（贝叶斯可靠性）" size="small" :bordered="true">
            <template #header-extra>
              <span class="muted" style="font-size: var(--fs-caption)">随使用自动更新</span>
            </template>
            <template v-if="moaHasCalibration">
              <NDataTable
                :columns="calibrationColumns"
                :data="calibrationRows"
                :bordered="false"
                size="small"
                :scroll-x="420"
              />
            </template>
            <NEmpty v-else description="暂无学习样本，使用后自动校准" style="padding: 12px 0" />
          </NCard>
        </NGi>
      </NGrid>

      <!-- Token 按模型分布 -->
      <NCard title="Token 消耗按模型分布" size="small" style="margin-bottom: 16px">
        <template v-if="moaHasTokenByModel">
          <EChart :option="moaTokenByModelOption" height="280px" :skip-theme="true" aria-label="MoA Token 消耗按模型分布饼图：每个模型的 Token 占比" />
        </template>
        <NEmpty v-else description="暂无模型级 Token 数据" style="padding: 12px 0" />
      </NCard>

      <!-- 复杂度百分位 -->
      <NCard title="复杂度百分位" size="small" style="margin-bottom: 16px">
        <NGrid :cols="'1 s:2 m:4'" :x-gap="12" :y-gap="6" responsive="screen">
          <NGi><span class="muted" style="font-size: var(--fs-caption)">全量 P50</span><div class="mono" style="font-weight: 600">{{ moaPerf.allComplexityPercentiles.p50.toFixed(3) }}</div></NGi>
          <NGi><span class="muted" style="font-size: var(--fs-caption)">全量 P90</span><div class="mono" style="font-weight: 600">{{ moaPerf.allComplexityPercentiles.p90.toFixed(3) }}</div></NGi>
          <NGi><span class="muted" style="font-size: var(--fs-caption)">全量 P95</span><div class="mono" style="font-weight: 600">{{ moaPerf.allComplexityPercentiles.p95.toFixed(3) }}</div></NGi>
          <NGi><span class="muted" style="font-size: var(--fs-caption)">全量 P99</span><div class="mono" style="font-weight: 600">{{ moaPerf.allComplexityPercentiles.p99.toFixed(3) }}</div></NGi>
        </NGrid>
        <NDivider style="margin: 8px 0" />
        <NGrid :cols="'1 s:2 m:4'" :x-gap="12" :y-gap="6" responsive="screen">
          <NGi><span class="muted" style="font-size: var(--fs-caption)">MoA P50</span><div class="mono" style="font-weight: 600; color: var(--color-danger)">{{ moaPerf.complexityPercentiles.p50.toFixed(3) }}</div></NGi>
          <NGi><span class="muted" style="font-size: var(--fs-caption)">MoA P90</span><div class="mono" style="font-weight: 600; color: var(--color-danger)">{{ moaPerf.complexityPercentiles.p90.toFixed(3) }}</div></NGi>
          <NGi><span class="muted" style="font-size: var(--fs-caption)">MoA P95</span><div class="mono" style="font-weight: 600; color: var(--color-danger)">{{ moaPerf.complexityPercentiles.p95.toFixed(3) }}</div></NGi>
          <NGi><span class="muted" style="font-size: var(--fs-caption)">MoA P99</span><div class="mono" style="font-weight: 600; color: var(--color-danger)">{{ moaPerf.complexityPercentiles.p99.toFixed(3) }}</div></NGi>
        </NGrid>
      </NCard>

      <!-- 复杂度趋势图 + 分布图 -->
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <NCard size="small" :bordered="true">
            <template #header>
              <div class="trend-header">
                <span>复杂度趋势</span>
                <div class="trend-selectors">
                  <NSelect v-model:value="complexityAggregation" :options="complexityAggOptions" size="tiny" style="width: 90px" placeholder="聚合" aria-label="选择复杂度聚合维度" />
                  <NSelect v-model:value="complexityTimeRange" :options="complexityTimeRangeOptions" size="tiny" style="width: 110px" placeholder="时间范围" aria-label="选择复杂度时间范围" />
                </div>
              </div>
            </template>
            <EChart :option="moaComplexityTrendOption" height="300px" :skip-theme="true" aria-label="MoA 复杂度趋势图：全量查询复杂度和 MoA 触发点随时间变化" />
          </NCard>
        </NGi>
        <NGi>
          <NCard title="复杂度分布（全量 vs MoA 触发）" size="small" :bordered="true">
            <EChart :option="moaComplexityDistOption" height="300px" :skip-theme="true" aria-label="MoA 复杂度分布对比柱状图：全量查询与 MoA 触发在低中高三个复杂度区间的分布" />
          </NCard>
        </NGi>
      </NGrid>

      <!-- 延迟百分位 + 阶段耗时分解图 -->
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <NCard title="延迟百分位（P50/P90/P95/P99）" size="small">
            <template v-if="moaPerf.totalRuns > 0">
              <NDescriptions :column="2" size="small" label-placement="left" bordered>
                <NDescriptionsItem label="P50 总耗时"><span class="mono">{{ formatMs(moaPerf.latencyPercentiles.p50) }}</span></NDescriptionsItem>
                <NDescriptionsItem label="P50 参考"><span class="mono">{{ formatMs(moaPerf.refLatencyPercentiles.p50) }}</span></NDescriptionsItem>
                <NDescriptionsItem label="P90 总耗时"><span class="mono">{{ formatMs(moaPerf.latencyPercentiles.p90) }}</span></NDescriptionsItem>
                <NDescriptionsItem label="P90 参考"><span class="mono">{{ formatMs(moaPerf.refLatencyPercentiles.p90) }}</span></NDescriptionsItem>
                <NDescriptionsItem label="P95 总耗时">
                  <NTag size="tiny" :type="moaPerf.latencyPercentiles.p95 > 120000 ? 'warning' : 'default'">{{ formatMs(moaPerf.latencyPercentiles.p95) }}</NTag>
                </NDescriptionsItem>
                <NDescriptionsItem label="P95 聚合"><span class="mono">{{ formatMs(moaPerf.aggLatencyPercentiles.p95) }}</span></NDescriptionsItem>
                <NDescriptionsItem label="P99 总耗时">
                  <NTag size="tiny" :type="moaPerf.latencyPercentiles.p99 > 300000 ? 'error' : 'warning'">{{ formatMs(moaPerf.latencyPercentiles.p99) }}</NTag>
                </NDescriptionsItem>
                <NDescriptionsItem label="P99 聚合"><span class="mono">{{ formatMs(moaPerf.aggLatencyPercentiles.p99) }}</span></NDescriptionsItem>
              </NDescriptions>
            </template>
            <NEmpty v-else description="暂无数据" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <NGi>
          <NCard title="最近 10 次延迟阶段分解" size="small" :bordered="true">
            <EChart :option="moaLatencyPhaseOption" height="300px" :skip-theme="true" aria-label="MoA 最近 10 次延迟阶段分解堆叠柱状图：参考模型和聚合模型耗时对比" />
          </NCard>
        </NGi>
      </NGrid>

      <!-- 响应时间按模型分布 -->
      <NCard title="平均响应时间按模型分布" size="small" style="margin-bottom: 16px">
        <template v-if="moaHasLatencyByModel">
          <EChart :option="moaLatencyByModelOption" height="280px" :skip-theme="true" aria-label="MoA 平均响应时间按模型分布横向柱状图：每个模型的平均耗时（秒）" />
        </template>
        <NEmpty v-else description="暂无模型级延迟数据" style="padding: 12px 0" />
      </NCard>

      <!-- 模型级指标 + 错误分布 -->
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <NCard title="模型级指标" size="small">
            <template v-if="moaPerf.modelBreakdown.length > 0">
              <NDataTable
                :columns="modelBreakdownColumns"
                :data="modelBreakdownRows"
                :bordered="false"
                size="small"
                :scroll-x="760"
              />
            </template>
            <NEmpty v-else description="暂无模型级数据" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <NGi>
          <NCard title="错误类型分布" size="small">
            <template #header-extra>
              <span class="muted" style="font-size: var(--fs-caption)">悬停查看错误说明</span>
            </template>
            <template v-if="moaErrorItems.length > 0">
              <div class="error-list">
                <div v-for="[type, count] in moaErrorItems" :key="type" class="error-item">
                  <NTag size="small" type="error" :title="`${type} · ${errorTypeLabels[type] || type}`">
                    {{ errorTypeLabels[type] || type }}
                  </NTag>
                  <span class="error-count">{{ count }} 次</span>
                  <div class="error-bar-track">
                    <div class="error-bar-fill" :style="{ width: moaPerf.failedRuns > 0 ? ((count / moaPerf.failedRuns) * 100).toFixed(0) + '%' : '0%' }" />
                  </div>
                </div>
              </div>
            </template>
            <NEmpty v-else description="暂无错误记录" style="padding: 12px 0" />
          </NCard>
        </NGi>
      </NGrid>

      <!-- 最近运行记录 -->
      <NCard title="最近运行记录" size="small">
        <template v-if="moaPerf.recentRuns.length === 0">
          <NEmpty description="暂无 MoA 运行记录" style="padding: 24px 0">
            <template #extra>
              <NButton size="small" @click="() => $router.push('/settings')">前往设置启用 MoA</NButton>
            </template>
          </NEmpty>
        </template>
        <NTable
          v-else
          :data="moaPerf.recentRuns"
          :columns="moaRunsColumns"
          :bordered="false"
          :single-line="false"
          size="small"
          :max-height="400"
          striped
        />
      </NCard>
    </template>

    <NEmpty v-else description="暂无 MoA 性能数据" style="padding: 24px 0">
      <template #extra>
        <NButton size="small" @click="() => $router.push('/settings')">前往设置启用 MoA</NButton>
      </template>
    </NEmpty>
  </div>
</template>

<style scoped>
.moa-view {
  width: 100%;
}
.moa-badge-bar {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}
.chart-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}
.trend-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.trend-selectors {
  display: flex;
  align-items: center;
  gap: 6px;
}
.model-name-cell {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.num {
  font-variant-numeric: tabular-nums;
}
.reason-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.error-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.error-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.error-count {
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
  min-width: 40px;
}
.error-bar-track {
  flex: 1;
  height: 6px;
  background: var(--color-border);
  border-radius: 3px;
  overflow: hidden;
}
.error-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--color-danger);
  transition: width 0.5s ease;
}
@media (max-width: 768px) {
  .trend-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .trend-selectors {
    width: 100%;
  }
}
</style>