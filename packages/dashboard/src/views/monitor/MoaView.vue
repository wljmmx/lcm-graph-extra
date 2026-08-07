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
      for (const p of params) h += `${p.marker}${p.seriesName}: ${Number(p.value).toFixed(0)}ms<br/>`;
      return h;
    }},
    legend: { data: ['参考模型', '聚合模型'], bottom: 0 },
    xAxis: { type: 'category', data: data.map((r) => r.queryPreview.slice(0, 16) + (r.queryPreview.length > 16 ? '...' : '')), axisLabel: { fontSize: 10, rotate: 30 } },
    yAxis: { type: 'value', name: '耗时 (ms)' },
    series: [
      { name: '参考模型', type: 'bar', stack: 'total', data: data.map((r) => r.refMs), itemStyle: { color: CHART.value.primary } },
      { name: '聚合模型', type: 'bar', stack: 'total', data: data.map((r) => r.aggMs), itemStyle: { color: CHART.value.success } },
    ],
    grid: { left: 60, right: 30, bottom: 60, top: 45 },
  };
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

      <!-- 模型级指标 + 错误分布 -->
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
        <NGi>
          <NCard title="模型级指标" size="small">
            <template v-if="moaPerf.modelBreakdown.length > 0">
              <div class="model-table-wrap">
                <table class="model-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>次数</th>
                      <th>成功率</th>
                      <th>P50</th>
                      <th>P95</th>
                      <th>Avg Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="m in moaPerf.modelBreakdown" :key="m.model">
                      <td class="mono model-name-cell">{{ m.model }}</td>
                      <td class="num">{{ m.runCount }}</td>
                      <td class="num">
                        <NTag size="tiny" :type="m.runCount > 0 && m.successCount / m.runCount >= 0.9 ? 'success' : 'warning'">
                          {{ m.runCount > 0 ? ((m.successCount / m.runCount) * 100).toFixed(0) + '%' : '--' }}
                        </NTag>
                      </td>
                      <td class="num">{{ formatMs(m.p50LatencyMs) }}</td>
                      <td class="num">{{ formatMs(m.p95LatencyMs) }}</td>
                      <td class="num">{{ formatTokens(m.avgTokens) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
            <NEmpty v-else description="暂无模型级数据" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <NGi>
          <NCard title="错误类型分布" size="small">
            <template v-if="moaErrorItems.length > 0">
              <div class="error-list">
                <div v-for="[type, count] in moaErrorItems" :key="type" class="error-item">
                  <NTag size="small" type="error">{{ type }}</NTag>
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
.model-table-wrap {
  overflow-x: auto;
}
.model-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-caption);
}
.model-table th {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-tertiary);
  font-weight: 500;
  white-space: nowrap;
}
.model-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border-subtle);
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
  .model-table-wrap {
    font-size: var(--fs-caption);
  }
  .model-table th,
  .model-table td {
    padding: 4px 4px;
  }
  .model-name-cell {
    max-width: 80px;
  }
}
</style>