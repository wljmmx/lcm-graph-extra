<script setup lang="ts">
/**
 * 性能监控总览 —— KPI 概览 + 时序图 + 熔断器 + tier 趋势。
 *
 * 数据层：useMonitorData() 统一提供所有轮询查询。
 * 本视图负责：时间范围 / 统计粒度选择、分桶聚合、图表配置、tier 趋势持久化、熔断器重置。
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import {
  NGrid,
  NGi,
  NCard,
  NEmpty,
  NTag,
  NAlert,
  NSpace,
  NSpin,
  NDivider,
  NSelect,
  NProgress,
  NButton,
  NPopconfirm,
  useMessage,
} from 'naive-ui';
import EChart from '../../components/EChart.vue';
import KpiCard from '../../components/KpiCard.vue';
import { useMonitorData } from '../../composables/useMonitorData';
import { useTheme } from '../../composables/useTheme';
import { formatTime, formatTimeWithSeconds, formatBucketLabel, bucketKeyBySize, timeRangeToMs, timeRangeLabel, bucketSizeLabel, type TimeRange, type BucketSize } from '../../utils/format';
import { invokeResetBreaker } from '../../api/maintain';
import type { HealthSnapshot } from '../../api/health';

const { isDark: themeIsDark } = useTheme();

const message = useMessage();

// ── 共享数据层 ──
const {
  latestData, latestLoading, latestIsError,
  historyData, historyLoading, historyIsError, historyN,
  agentIsError,
  graphHealthIsError,
  db, memory,
  refreshStatus,
  CHART,
} = useMonitorData();

// ── UX-14: 窄屏检测 ──
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);
function onResize() { windowWidth.value = window.innerWidth; }
onMounted(() => { window.addEventListener('resize', onResize); });
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); });

// ── 时间范围 + 统计粒度 ──
const timeRangeOptions = [
  { label: '最近 1 小时', value: '1h' as TimeRange },
  { label: '最近 1 天', value: '1d' as TimeRange },
  { label: '最近 1 周', value: '1w' as TimeRange },
  { label: '最近 1 月', value: '1m' as TimeRange },
];
const bucketSizeOptions = [
  { label: '实时记录', value: 'raw' as BucketSize },
  { label: '1 分钟', value: '1min' as BucketSize },
  { label: '5 分钟', value: '5min' as BucketSize },
  { label: '10 分钟', value: '10min' as BucketSize },
  { label: '1 小时', value: '1h' as BucketSize },
];
const timeRange = ref<TimeRange>('1h');
const bucketSize = ref<BucketSize>('raw');

// 根据时间范围更新 historyN（触发重新拉取）
watch(timeRange, (r) => {
  switch (r) {
    case '1h': historyN.value = 24; break;
    case '1d': historyN.value = 300; break;
    case '1w': historyN.value = 2100; break;
    case '1m': historyN.value = 8640; break;
    default: historyN.value = 24;
  }
}, { immediate: true });

// ── 派生数据 ──
const rawHistoryAsc = computed<HealthSnapshot[]>(() => {
  const snaps = historyData.value?.snapshots ?? [];
  if (snaps.length === 0) return [];
  const rangeMs = timeRangeToMs(timeRange.value);
  const cutoff = Date.now() - rangeMs;
  return snaps.filter((s) => s.timestamp >= cutoff).reverse();
});

const historyAsc = computed<HealthSnapshot[]>(() => {
  const snaps = rawHistoryAsc.value;
  const size = bucketSize.value;
  if (size === 'raw' || snaps.length === 0) return snaps;

  const buckets = new Map<string, HealthSnapshot[]>();
  for (const s of snaps) {
    const key = bucketKeyBySize(s.timestamp, size);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s);
  }

  const result: HealthSnapshot[] = [];
  for (const [, group] of buckets) {
    if (group.length === 0) continue;
    const avg = (field: keyof HealthSnapshot): number => {
      const vals = group.map((s) => Number(s[field] ?? 0)).filter((v) => !isNaN(v));
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };
    const max = (field: keyof HealthSnapshot): number => {
      const vals = group.map((s) => Number(s[field] ?? 0)).filter((v) => !isNaN(v));
      return vals.length > 0 ? Math.max(...vals) : 0;
    };
    const sum = (field: keyof HealthSnapshot): number => {
      const vals = group.map((s) => Number(s[field] ?? 0)).filter((v) => !isNaN(v));
      return vals.reduce((a, b) => a + b, 0);
    };
    const latestTs = Math.max(...group.map((s) => s.timestamp));
    result.push({
      timestamp: latestTs,
      pendingMessages: Math.round(max('pendingMessages')),
      summaryFragments: Math.round(max('summaryFragments')),
      maxTokenRatio: Math.round(avg('maxTokenRatio') * 1000) / 1000,
      cbLcmAvailable: group.every((s) => s.cbLcmAvailable),
      cbQmdAvailable: group.every((s) => s.cbQmdAvailable),
      cbNeo4jAvailable: group.every((s) => s.cbNeo4jAvailable),
      cbLcmFailures: Math.round(max('cbLcmFailures')),
      cbQmdFailures: Math.round(max('cbQmdFailures')),
      cbNeo4jFailures: Math.round(max('cbNeo4jFailures')),
      lastAssembleMs: Math.round(avg('lastAssembleMs')),
      lastL2Ms: Math.round(avg('lastL2Ms')),
      lastL3Ms: Math.round(avg('lastL3Ms')),
      lastL4Ms: Math.round(avg('lastL4Ms')),
      pendingExperienceCount: Math.round(max('pendingExperienceCount')),
      distilledExperienceCount: Math.round(max('distilledExperienceCount')),
      tierLow: Math.round(sum('tierLow')),
      tierMedium: Math.round(sum('tierMedium')),
      tierHigh: Math.round(sum('tierHigh')),
    });
  }
  return result;
});

// ── KPI 值 ──
const kpiPending = computed<number | string>(() => db.value ? db.value.pendingMessages : '—');
const kpiTokenRatio = computed<number | string>(() => db.value ? Math.round(db.value.maxTokenRatio * 1000) / 10 : '—');
const kpiAssembleMs = computed<number | string>(() => db.value ? db.value.lastAssembleMs : '—');
const kpiCbFailures = computed<number | string>(() => {
  if (!db.value) return '—';
  return db.value.cbLcmFailures + db.value.cbQmdFailures + db.value.cbNeo4jFailures;
});

// ── KPI 趋势 ──
const kpiTrend = computed(() => {
  const prev = historyAsc.value.length >= 2 ? historyAsc.value[historyAsc.value.length - 2] : null;
  const cur = db.value;
  if (!prev || !cur) return { pending: 0, tokenRatio: 0, assembleMs: 0, cbFailures: 0 };
  return {
    pending: cur.pendingMessages - prev.pendingMessages,
    tokenRatio: Math.round((cur.maxTokenRatio - prev.maxTokenRatio) * 1000) / 10,
    assembleMs: cur.lastAssembleMs - prev.lastAssembleMs,
    cbFailures: (cur.cbLcmFailures + cur.cbQmdFailures + cur.cbNeo4jFailures) -
      (prev.cbLcmFailures + prev.cbQmdFailures + prev.cbNeo4jFailures),
  };
});

const lastUpdated = computed(() => formatTimeWithSeconds(db.value?.timestamp));

// ── 熔断器状态 ──
interface CbSubsystemStat {
  key: string;
  label: string;
  available: boolean;
  failures: number;
  successRate: number;
  openCloseCount: number;
  tagType: 'success' | 'error' | 'default';
}

const cbSubsystemStats = computed<CbSubsystemStat[]>(() => {
  const d = db.value;
  if (!d) return [];

  const memSnapshot = memory.value?.health?.latest;
  const hasGlobalCumulative = memSnapshot != null
    && typeof memSnapshot.cbLcmTotalChecks === 'number'
    && typeof memSnapshot.cbLcmSuccessCount === 'number';

  const calc = (key: string, label: string, currentAvailable: boolean, currentFailures: number) => {
    let successRate: number;
    let transitions: number;

    if (hasGlobalCumulative) {
      let totalChecks: number;
      let successCount: number;
      let transCount: number;
      if (key === 'lcm') {
        totalChecks = memSnapshot!.cbLcmTotalChecks ?? 0;
        successCount = memSnapshot!.cbLcmSuccessCount ?? 0;
        transCount = memSnapshot!.cbLcmTransitions ?? 0;
      } else if (key === 'qmd') {
        totalChecks = memSnapshot!.cbQmdTotalChecks ?? 0;
        successCount = memSnapshot!.cbQmdSuccessCount ?? 0;
        transCount = memSnapshot!.cbQmdTransitions ?? 0;
      } else {
        totalChecks = memSnapshot!.cbNeo4jTotalChecks ?? 0;
        successCount = memSnapshot!.cbNeo4jSuccessCount ?? 0;
        transCount = memSnapshot!.cbNeo4jTransitions ?? 0;
      }
      successRate = totalChecks > 0 ? Math.round((successCount / totalChecks) * 1000) / 10 : 100;
      transitions = transCount;
    } else {
      const history = rawHistoryAsc.value;
      let availableCount = 0;
      let totalCount = 0;
      let trans = 0;
      let prevState: boolean | null = null;

      for (const snap of history) {
        let available: boolean;
        if (key === 'lcm') available = snap.cbLcmAvailable;
        else if (key === 'qmd') available = snap.cbQmdAvailable;
        else available = snap.cbNeo4jAvailable;

        if (available) availableCount++;
        totalCount++;
        if (prevState !== null && prevState !== available) trans++;
        prevState = available;
      }
      successRate = totalCount > 0 ? Math.round((availableCount / totalCount) * 1000) / 10 : 100;
      transitions = trans;
    }

    const tagType: 'success' | 'error' | 'default' = currentAvailable ? 'success' : currentFailures > 0 ? 'error' : 'default';
    return { key, label, available: currentAvailable, failures: currentFailures, successRate, openCloseCount: transitions, tagType };
  };

  return [
    calc('lcm', 'LCM', d.cbLcmAvailable, d.cbLcmFailures),
    calc('qmd', 'QMD', d.cbQmdAvailable, d.cbQmdFailures),
    calc('neo4j', 'Neo4j', d.cbNeo4jAvailable, d.cbNeo4jFailures),
  ];
});

// ── 熔断器重置 ──
const resettingBreaker = ref<string | null>(null);
async function handleResetBreaker(name: string): Promise<void> {
  if (resettingBreaker.value) return;
  resettingBreaker.value = name;
  try {
    const res = await invokeResetBreaker(name);
    if (res.success) {
      message.success(`熔断器 ${name.toUpperCase()} 已重置`);
    } else {
      message.error(`重置失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`重置失败: ${err?.message || String(err)}`);
  } finally {
    resettingBreaker.value = null;
  }
}

// ── 当前压力 Tier ──
type TierLevel = 'low' | 'medium' | 'high';
const currentTier = computed<TierLevel | null>(() => {
  const d = db.value;
  if (!d) return null;
  const low = d.tierLow ?? 0;
  const medium = d.tierMedium ?? 0;
  const high = d.tierHigh ?? 0;
  if (low === 0 && medium === 0 && high === 0) return null;
  if (high >= low && high >= medium) return 'high';
  if (medium >= low && medium >= high) return 'medium';
  return 'low';
});
const currentTierTagType = computed<'success' | 'warning' | 'error' | 'default'>(() => {
  switch (currentTier.value) {
    case 'low': return 'success';
    case 'medium': return 'warning';
    case 'high': return 'error';
    default: return 'default';
  }
});
const currentTierLabel = computed(() => {
  switch (currentTier.value) {
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    default: return '—';
  }
});

const currentTierDistribution = computed(() => {
  const d = db.value;
  const low = d?.tierLow ?? 0;
  const medium = d?.tierMedium ?? 0;
  const high = d?.tierHigh ?? 0;
  const total = low + medium + high;
  return {
    low, medium, high, total,
    lowPct: total > 0 ? (low / total) * 100 : 0,
    mediumPct: total > 0 ? (medium / total) * 100 : 0,
    highPct: total > 0 ? (high / total) * 100 : 0,
  };
});

// ── Tier 趋势持久化 ──
interface TierTrendPoint {
  timestamp: number;
  low: number;
  medium: number;
  high: number;
  total: number;
  lowPct: number;
  mediumPct: number;
  highPct: number;
  dominant: TierLevel | null;
}

const TIER_TREND_STORAGE_KEY = 'dashboard-tier-trend';

function loadPersistedTierTrend(): TierTrendPoint[] {
  try {
    const raw = localStorage.getItem(TIER_TREND_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p: any) => typeof p?.timestamp === 'number');
  } catch { return []; }
}

function savePersistedTierTrend(points: TierTrendPoint[]): void {
  try { localStorage.setItem(TIER_TREND_STORAGE_KEY, JSON.stringify(points)); } catch { /* silently ignore */ }
}

function snapshotToTierPoint(s: HealthSnapshot): TierTrendPoint {
  const low = s.tierLow ?? 0;
  const medium = s.tierMedium ?? 0;
  const high = s.tierHigh ?? 0;
  const total = low + medium + high;
  const pct = (v: number): number => (total > 0 ? (v / total) * 100 : 0);
  let dominant: TierLevel | null = null;
  if (total > 0) {
    if (high >= low && high >= medium) dominant = 'high';
    else if (medium >= low && medium >= high) dominant = 'medium';
    else dominant = 'low';
  }
  return { timestamp: s.timestamp, low, medium, high, total, lowPct: pct(low), mediumPct: pct(medium), highPct: pct(high), dominant };
}

const persistedTierTrend = ref<TierTrendPoint[]>(loadPersistedTierTrend());

watch(historyAsc, (snaps) => {
  if (snaps.length === 0) return;
  const existingMap = new Map<number, TierTrendPoint>();
  for (const p of persistedTierTrend.value) existingMap.set(p.timestamp, p);
  for (const s of snaps) {
    const ageMs = Date.now() - s.timestamp;
    if (ageMs > 2 * 60 * 60 * 1000) continue;
    existingMap.set(s.timestamp, snapshotToTierPoint(s));
  }
  const merged = [...existingMap.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
  persistedTierTrend.value = merged;
  savePersistedTierTrend(merged);
}, { immediate: false });

const recentTierTrend = computed<TierTrendPoint[]>(() => {
  if (persistedTierTrend.value.length > 0) return persistedTierTrend.value;
  const snaps = historyAsc.value.slice(-10);
  return snaps.map(snapshotToTierPoint);
});

// ── 时序图 X 轴标签 ──
const timeLabels = computed(() => historyAsc.value.map((s) => formatBucketLabel(s.timestamp, bucketSize.value)));

const rangeBucketHint = computed(() => {
  const pts = historyAsc.value.length;
  const range = timeRangeLabel(timeRange.value);
  const bucket = bucketSizeLabel(bucketSize.value);
  let hint = `${range} · 粒度 ${bucket} · ${pts} 个数据点`;
  if (pts > 2000) hint += '（点数过多，建议选更粗的统计粒度）';
  return hint;
});

const xAxisLabelRotate = computed(() => windowWidth.value < 768 ? 45 : 0);

// ── ECharts 配置 ──
const pressureOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['待处理消息', '摘要片段', 'Token 占用比'] },
  grid: { left: 56, right: 64, top: 36, bottom: 28 },
  xAxis: { type: 'category', data: timeLabels.value, boundaryGap: false, axisLabel: { rotate: xAxisLabelRotate.value } },
  yAxis: [
    { type: 'value', name: '数量', position: 'left' },
    { type: 'value', name: '比率', position: 'right', min: 0, max: 1 },
  ],
  series: [
    {
      name: '待处理消息', type: 'line', smooth: true, yAxisIndex: 0,
      data: historyAsc.value.map((s) => s.pendingMessages),
      lineStyle: { color: CHART.value.primary }, itemStyle: { color: CHART.value.primary },
      symbol: 'circle', symbolSize: 4,
    },
    {
      name: '摘要片段', type: 'line', smooth: true, yAxisIndex: 0,
      data: historyAsc.value.map((s) => s.summaryFragments),
      lineStyle: { color: CHART.value.info, type: 'dashed' }, itemStyle: { color: CHART.value.info },
      symbol: 'diamond', symbolSize: 4,
    },
    {
      name: 'Token 占用比', type: 'line', smooth: true, yAxisIndex: 1,
      data: historyAsc.value.map((s) => s.maxTokenRatio),
      lineStyle: { color: CHART.value.danger, type: 'dotted' }, itemStyle: { color: CHART.value.danger },
      symbol: 'triangle', symbolSize: 4,
    },
  ],
}));

const latencyOption = computed(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: { data: ['Assemble', 'L2', 'L3', 'L4'] },
  grid: { left: 56, right: 20, top: 36, bottom: 28 },
  xAxis: { type: 'category', data: timeLabels.value, axisLabel: { rotate: xAxisLabelRotate.value } },
  yAxis: { type: 'value', name: 'ms' },
  series: [
    {
      name: 'Assemble', type: 'line', smooth: true,
      data: historyAsc.value.map((s) => s.lastAssembleMs),
      lineStyle: { width: 2, color: CHART.value.primary }, itemStyle: { color: CHART.value.primary },
      symbol: 'circle', symbolSize: 6, z: 10,
    },
    {
      name: 'L2', type: 'bar',
      data: historyAsc.value.map((s) => s.lastL2Ms),
      itemStyle: { color: CHART.value.info },
    },
    {
      name: 'L3', type: 'bar',
      data: historyAsc.value.map((s) => s.lastL3Ms),
      itemStyle: { color: CHART.value.warning },
    },
    {
      name: 'L4', type: 'bar',
      data: historyAsc.value.map((s) => s.lastL4Ms),
      itemStyle: { color: CHART.value.success },
    },
  ],
}));

const tierOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['Low', 'Medium', 'High'] },
  grid: { left: 56, right: 20, top: 36, bottom: 28 },
  xAxis: { type: 'category', data: timeLabels.value, boundaryGap: false, axisLabel: { rotate: xAxisLabelRotate.value } },
  yAxis: { type: 'value', name: '次数' },
  series: [
    {
      name: 'Low', type: 'line', stack: 'tier',
      areaStyle: { color: themeIsDark.value ? 'rgba(54,173,106,0.25)' : 'rgba(24,160,88,0.15)' },
      lineStyle: { color: CHART.value.success }, itemStyle: { color: CHART.value.success },
      symbol: 'circle', symbolSize: 3,
      data: historyAsc.value.map((s) => s.tierLow),
    },
    {
      name: 'Medium', type: 'line', stack: 'tier',
      areaStyle: { color: themeIsDark.value ? 'rgba(252,176,64,0.25)' : 'rgba(240,160,32,0.15)' },
      lineStyle: { color: CHART.value.warning, type: 'dashed' }, itemStyle: { color: CHART.value.warning },
      symbol: 'diamond', symbolSize: 3,
      data: historyAsc.value.map((s) => s.tierMedium),
    },
    {
      name: 'High', type: 'line', stack: 'tier',
      areaStyle: { color: themeIsDark.value ? 'rgba(222,81,105,0.25)' : 'rgba(208,48,80,0.15)' },
      lineStyle: { color: CHART.value.danger, type: 'dotted' }, itemStyle: { color: CHART.value.danger },
      symbol: 'triangle', symbolSize: 3,
      data: historyAsc.value.map((s) => s.tierHigh),
    },
  ],
}));

// ── 响应式列数 ──
const kpiCols = '2 s:2 m:2 l:4';
const chartCols = '1 s:1 m:2';
</script>

<template>
  <div class="overview-view">
    <!-- 标题行 -->
    <div class="overview-header">
      <h2 style="margin: 0">性能监控总览</h2>
      <div class="header-right">
        <NTag :type="refreshStatus.type" size="small" :bordered="false">
          {{ refreshStatus.label }}
        </NTag>
        <span class="last-updated">最近更新: {{ lastUpdated }}</span>
      </div>
    </div>

    <!-- KPI 卡片 -->
    <NGrid :cols="kpiCols" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <KpiCard label="待处理消息" :value="kpiPending" :threshold="100" :trend="kpiTrend.pending" :loading="latestLoading" reverse-indicator />
      </NGi>
      <NGi>
        <KpiCard label="Token 占用比" :value="kpiTokenRatio" unit="%" :threshold="80" :trend="kpiTrend.tokenRatio" :loading="latestLoading" reverse-indicator />
      </NGi>
      <NGi>
        <KpiCard label="检索延迟 Assemble" :value="kpiAssembleMs" unit="ms" :threshold="2000" :trend="kpiTrend.assembleMs" :loading="latestLoading" reverse-indicator />
      </NGi>
      <NGi>
        <KpiCard label="熔断失败总数" :value="kpiCbFailures" :threshold="0" :trend="kpiTrend.cbFailures" :loading="latestLoading" reverse-indicator />
      </NGi>
    </NGrid>

    <!-- 当前压力 Tier 徽章 -->
    <div class="tier-badge-bar">
      <span class="tier-badge-label">当前压力 Tier：</span>
      <NTag v-if="currentTier" :type="currentTierTagType" size="medium" round>{{ currentTierLabel }}</NTag>
      <NTag v-else type="default" size="medium" round>—</NTag>
      <span v-if="db" class="tier-badge-detail muted mono">
        Low: {{ db.tierLow }} · Medium: {{ db.tierMedium }} · High: {{ db.tierHigh }}
      </span>
    </div>

    <!-- 错误告警 -->
    <NAlert v-if="latestIsError" type="error" :show-icon="true" title="健康指标加载失败" style="margin-top: 12px">
      后端 /api/health/latest 不可达或返回错误。请检查插件 snapshot 服务（:7423）是否运行。
    </NAlert>
    <NAlert v-else-if="agentIsError" type="error" :show-icon="true" title="Agent 状态加载失败" style="margin-top: 12px">
      后端 /api/agent/status 不可达。
    </NAlert>
    <NAlert v-else-if="graphHealthIsError" type="error" :show-icon="true" title="图谱健康加载失败" style="margin-top: 12px">
      后端 /api/graph/health 不可达。
    </NAlert>
    <NAlert v-else-if="historyIsError" type="error" :show-icon="true" title="时序图历史加载失败" style="margin-top: 12px">
      后端 /api/health/history 不可达。
    </NAlert>
    <NAlert v-if="latestLoading && !latestData" type="info" :show-icon="true" title="正在加载最新健康指标…" style="margin-top: 12px" />

    <NDivider style="margin: 16px 0" />

    <!-- 时间范围 + 统计粒度 -->
    <div class="granularity-bar">
      <span class="granularity-label">时间范围：</span>
      <NSelect v-model:value="timeRange" :options="timeRangeOptions" size="small" style="width: 140px" aria-label="选择时间范围" />
      <span class="granularity-label" style="margin-left: 12px">统计粒度：</span>
      <NSelect v-model:value="bucketSize" :options="bucketSizeOptions" size="small" style="width: 120px" aria-label="选择统计粒度" />
      <span class="granularity-hint">{{ rangeBucketHint }}</span>
    </div>

    <NSpace vertical :size="12">
      <!-- 压力信号图表 -->
      <NCard title="压力信号（待处理消息 / 摘要片段 / Token 占用比）" size="small">
        <EChart v-if="historyAsc.length" :option="pressureOption" height="280px" aria-label="压力信号时序图：待处理消息、摘要片段和 Token 占用比随时间变化" />
        <div v-else-if="historyLoading" class="chart-loading">
          <NSpin size="small" />
        </div>
        <NEmpty v-else :description="historyIsError ? '加载失败，见上方错误提示' : '暂无压力信号数据'" style="padding: 24px 0">
          <template v-if="!historyIsError" #extra>
            <span class="muted" style="font-size: var(--fs-caption)">启动后端 heartbeat 服务后，数据将自动出现。</span>
          </template>
        </NEmpty>
      </NCard>

      <!-- 检索延迟 + tier 分布 -->
      <NGrid :cols="chartCols" :x-gap="12" :y-gap="12" responsive="screen">
        <NGi>
          <NCard title="检索延迟（Assemble 折线 + L2/L3/L4 独立柱）" size="small">
            <EChart v-if="historyAsc.length" :option="latencyOption" height="280px" aria-label="检索延迟图：Assemble 总耗时折线和 L2/L3/L4 各层耗时柱状图" />
            <div v-else-if="historyLoading" class="chart-loading">
              <NSpin size="small" />
            </div>
            <NEmpty v-else :description="historyIsError ? '加载失败，见上方错误提示' : '暂无检索延迟数据'" style="padding: 24px 0" />
          </NCard>
        </NGi>
        <NGi>
          <NCard title="tier 分布（Low/Medium/High 堆叠面积）" size="small">
            <EChart v-if="historyAsc.length" :option="tierOption" height="280px" aria-label="Tier 分布堆叠面积图：Low、Medium、High 三级压力分布随时间变化" />
            <div v-else-if="historyLoading" class="chart-loading">
              <NSpin size="small" />
            </div>
            <NEmpty v-else :description="historyIsError ? '加载失败，见上方错误提示' : '暂无 tier 分布数据'" style="padding: 24px 0" />
          </NCard>
        </NGi>
      </NGrid>
    </NSpace>

    <!-- 熔断器状态 + tier 趋势 -->
    <NGrid :cols="chartCols" :x-gap="12" :y-gap="12" responsive="screen" style="margin-top: 12px">
      <NGi>
        <NCard title="熔断器状态" size="small">
          <template v-if="cbSubsystemStats.length">
            <NSpace vertical :size="8">
              <div v-for="item in cbSubsystemStats" :key="item.key" class="cb-row">
                <span class="cb-label">{{ item.label }}</span>
                <NTag size="small" :type="item.tagType">
                  {{ item.available ? '可用' : item.failures > 0 ? '熔断' : '未知' }}
                </NTag>
                <span class="cb-failures muted mono">失败 {{ item.failures }} 次</span>
                <span class="cb-stat muted mono">成功率 {{ item.successRate }}% · 开合 {{ item.openCloseCount }} 次</span>
                <NPopconfirm @positive-click="handleResetBreaker(item.key)">
                  <template #trigger>
                    <NButton size="tiny" :type="item.available ? 'default' : 'warning'" :loading="resettingBreaker === item.key" :disabled="resettingBreaker !== null && resettingBreaker !== item.key">
                      重置
                    </NButton>
                  </template>
                  确定要重置 {{ item.label }} 熔断器吗？这将清零失败计数并关闭熔断状态。
                </NPopconfirm>
              </div>
            </NSpace>
          </template>
          <NEmpty v-else description="无历史数据" style="padding: 12px 0" />
        </NCard>
      </NGi>

      <NGi>
        <NCard title="最近 10 次 tier 分布趋势" size="small">
          <template v-if="recentTierTrend.length">
            <div v-if="db" class="tier-current-dist">
              <div class="tier-dist-row">
                <span class="tier-dist-label">Low</span>
                <NProgress type="line" :percentage="currentTierDistribution.lowPct" :color="CHART.value.success" :show-indicator="false" :height="8" style="flex: 1" />
                <span class="tier-dist-value mono">{{ currentTierDistribution.low }} ({{ currentTierDistribution.lowPct.toFixed(0) }}%)</span>
              </div>
              <div class="tier-dist-row">
                <span class="tier-dist-label">Medium</span>
                <NProgress type="line" :percentage="currentTierDistribution.mediumPct" :color="CHART.value.warning" :show-indicator="false" :height="8" style="flex: 1" />
                <span class="tier-dist-value mono">{{ currentTierDistribution.medium }} ({{ currentTierDistribution.mediumPct.toFixed(0) }}%)</span>
              </div>
              <div class="tier-dist-row">
                <span class="tier-dist-label">High</span>
                <NProgress type="line" :percentage="currentTierDistribution.highPct" :color="CHART.value.danger" :show-indicator="false" :height="8" style="flex: 1" />
                <span class="tier-dist-value mono">{{ currentTierDistribution.high }} ({{ currentTierDistribution.highPct.toFixed(0) }}%)</span>
              </div>
            </div>
            <NDivider style="margin: 8px 0" />
            <div class="tier-trend-list">
              <div v-for="point in recentTierTrend" :key="point.timestamp" class="tier-trend-row">
                <span class="tier-trend-time mono">{{ formatTime(point.timestamp) }}</span>
                <div class="tier-trend-bar">
                  <div class="tier-trend-seg tier-low" :style="{ width: point.lowPct + '%' }" />
                  <div class="tier-trend-seg tier-medium" :style="{ width: point.mediumPct + '%' }" />
                  <div class="tier-trend-seg tier-high" :style="{ width: point.highPct + '%' }" />
                </div>
                <NTag size="tiny" :type="point.dominant === 'high' ? 'error' : point.dominant === 'medium' ? 'warning' : point.dominant === 'low' ? 'success' : 'default'">
                  {{ point.dominant ?? '—' }}
                </NTag>
                <span class="tier-trend-total mono muted">{{ point.total }}</span>
              </div>
            </div>
          </template>
          <NEmpty v-else description="无历史数据" style="padding: 12px 0" />
        </NCard>
      </NGi>
    </NGrid>

    <div style="margin-top: 4px; font-size: var(--fs-caption); color: var(--color-text-muted);">
      最近更新: {{ lastUpdated || '—' }}
    </div>
  </div>
</template>

<style scoped>
.overview-view {
  width: 100%;
}
.overview-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.last-updated {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
.chart-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}
.granularity-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.granularity-label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.granularity-hint {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
  flex-shrink: 1;
}
.tier-badge-bar {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: 12px;
  flex-wrap: wrap;
}
.tier-badge-label {
  font-size: var(--fs-body);
  color: var(--color-text-secondary);
}
.tier-badge-detail {
  font-size: var(--fs-caption);
  margin-left: var(--space-xs);
}
.cb-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.cb-label {
  flex: 1;
  font-size: var(--fs-body);
}
.cb-failures {
  font-size: var(--fs-caption);
}
.cb-stat {
  font-size: var(--fs-caption);
}
.tier-current-dist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tier-dist-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tier-dist-label {
  width: 56px;
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.tier-dist-value {
  width: 90px;
  font-size: var(--fs-caption);
  text-align: right;
  flex-shrink: 0;
}
.tier-trend-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tier-trend-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tier-trend-time {
  width: 60px;
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.tier-trend-bar {
  flex: 1;
  height: 10px;
  display: flex;
  border-radius: 5px;
  overflow: hidden;
  background: var(--color-border);
}
.tier-trend-seg {
  height: 100%;
  transition: width 0.4s ease;
}
.tier-trend-seg.tier-low {
  background: var(--color-success);
}
.tier-trend-seg.tier-medium {
  background: var(--color-warning);
}
.tier-trend-seg.tier-high {
  background: var(--color-danger);
}
.tier-trend-total {
  width: 32px;
  font-size: var(--fs-caption);
  text-align: right;
  flex-shrink: 0;
}
@media (max-width: 768px) {
  .granularity-bar {
    flex-wrap: wrap;
  }
}
</style>