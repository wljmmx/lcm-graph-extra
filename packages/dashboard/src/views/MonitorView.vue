<script setup lang="ts">
/**
 * 性能监控 Dashboard（模块 1）。
 *
 * 布局（设计文档 4.1 节）：
 *   KPI 卡片行 → 时序图区（压力信号 / 检索延迟 / tier 分布）→ 状态面板区
 *
 * 数据获取（TanStack Query 轮询）：
 *   - health-latest  10s 轮询（KPI + 熔断 + memory 面板）
 *   - health-history 1min 轮询（时序图）
 *   - agent-status   30s 轮询（OpenClaw host）
 *
 * 降级处理：memory 为 null → memory 面板显示"插件未响应"；
 *          db 为 null / 历史空 → KPI与时序图显示"无历史数据"；
 *          agent.error → 警告提示。
 */
import { computed, ref, h } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  NGrid,
  NGi,
  NCard,
  NEmpty,
  NTag,
  NDescriptions,
  NDescriptionsItem,
  NAlert,
  NSpace,
  NSpin,
  NTabs,
  NTabPane,
  NSelect,
  NTable,
  NDivider,
  NButton,
} from 'naive-ui';
import EChart from '../components/EChart.vue';
import KpiCard from '../components/KpiCard.vue';
import StatusIndicator from '../components/StatusIndicator.vue';
import {
  fetchHealthLatest,
  fetchHealthHistory,
  fetchAgentStatus,
  fetchGraphHealth,
  type HealthSnapshot,
  type DashboardSnapshot,
  type AgentStatus,
  type GraphHealthResponse,
} from '../api/health';
import { formatTime, formatTimeWithSeconds, formatBucketLabel, bucketKeyBySize, timeRangeToMs, timeRangeLabel, bucketSizeLabel, type TimeRange, type BucketSize } from '../utils/format';
import { fetchMoaPerformance, type MoaPerformanceData } from '../api/moa';

// ===== 图表颜色语义常量 =====
// 统一语义：蓝=主数据，绿=成功/正向，橙=警告/阈值，红=危险/反向，紫=辅助
const CHART = {
  primary: '#2080f0',
  success: '#18a058',
  warning: '#f0a020',
  danger:  '#d03050',
  info:    '#7c3aed',
  neutral: '#909399',
} as const;

// ===== 时序图：时间范围 + 统计粒度（两个独立维度） =====
// 时间范围：筛选最近 N 时间内的数据（1h/1d/1w/1m）
// 统计粒度：数据点如何分桶聚合（实时/1min/5min/10min/1h）
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

// 根据时间范围决定拉取的数据量（n 条原始点，5min 心跳 = 288/天）
// 多取 ~10% 余量，前端再按 timestamp 精确过滤
const historyN = computed(() => {
  switch (timeRange.value) {
    case '1h': return 24;       // 12 点 + 余量
    case '1d': return 300;      // 288 + 余量
    case '1w': return 2100;     // 2016 + 余量
    case '1m': return 8640;     // 30 天上限
    default: return 24;
  }
});

// ===== 数据获取（轮询） =====
// E1 修复: 解构 isError，HTTP 错误不再被静默吞掉
const { data: latestData, isLoading: latestLoading, isError: latestIsError } = useQuery({
  queryKey: ['health-latest'],
  queryFn: fetchHealthLatest,
  refetchInterval: 10_000,
});
const { data: historyData, isLoading: historyLoading, isError: historyIsError } = useQuery({
  queryKey: ['health-history', historyN], // 粒度变化时重新拉取
  queryFn: () => fetchHealthHistory(historyN.value),
  refetchInterval: 60_000,
});
const { data: agentData, isLoading: agentLoading, isError: agentIsError } = useQuery({
  queryKey: ['agent-status'],
  queryFn: fetchAgentStatus,
  refetchInterval: 30_000,
});
// G-5: 图谱健康（gm-pro getGraphHealth，降级到本地 graphAdapter 推断）
const { data: graphHealthData, isLoading: graphHealthLoading, isError: graphHealthIsError } = useQuery({
  queryKey: ['graph-health'],
  queryFn: fetchGraphHealth,
  refetchInterval: 30_000,
});

// MoA 性能数据（30s 轮询）
const { data: moaPerfData, isLoading: moaPerfLoading } = useQuery({
  queryKey: ['moa-performance'],
  queryFn: fetchMoaPerformance,
  refetchInterval: 30_000,
});

const moaPerf = computed<MoaPerformanceData | null>(() => moaPerfData.value?.data ?? null);

// ===== 派生数据 =====
const db = computed<HealthSnapshot | null>(() => latestData.value?.db ?? null);
const memory = computed<DashboardSnapshot | null>(
  () => latestData.value?.memory ?? null,
);
// DB 返回 DESC（最新在前），时序图需要 ASC（最旧在前）
// v2.2.4: 按时间范围精确过滤（historyN 只是近似拉取量，这里按 timestamp 严格筛选）
const rawHistoryAsc = computed<HealthSnapshot[]>(() => {
  const snaps = historyData.value?.snapshots ?? [];
  if (snaps.length === 0) return [];
  const rangeMs = timeRangeToMs(timeRange.value);
  const cutoff = Date.now() - rangeMs;
  return snaps.filter((s) => s.timestamp >= cutoff).reverse();
});

/**
 * 按统计粒度聚合历史快照。
 *
 * 聚合规则（不同指标用不同聚合函数）：
 * - pendingMessages / summaryFragments → max（峰值更有意义）
 * - maxTokenRatio → avg（平均占用）
 * - lastAssembleMs / lastL2Ms / lastL3Ms / lastL4Ms → avg（平均延迟）
 * - tierLow / tierMedium / tierHigh → sum（累计次数）
 * - cbFailures → max
 * - timestamp → 桶内最新时间戳（用于 X 轴标签）
 *
 * raw 粒度直接返回原始数据（实时记录累计，不聚合）。
 */
const historyAsc = computed<HealthSnapshot[]>(() => {
  const snaps = rawHistoryAsc.value;
  const size = bucketSize.value;
  if (size === 'raw' || snaps.length === 0) return snaps;

  // 按统计粒度分桶
  const buckets = new Map<string, HealthSnapshot[]>();
  for (const s of snaps) {
    const key = bucketKeyBySize(s.timestamp, size);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s);
  }

  // 聚合每个桶
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
    // 取桶内最新时间戳作为标签时间
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
const agent = computed<AgentStatus | null>(() => agentData.value ?? null);
const graphHealth = computed<GraphHealthResponse | null>(
  () => graphHealthData.value ?? null,
);

// G-5: 图谱健康 status → tag type 映射
const graphHealthTagType = computed<'success' | 'warning' | 'error' | 'default'>(() => {
  const s = graphHealth.value?.status;
  if (s === 'healthy') return 'success';
  if (s === 'degraded') return 'warning';
  if (s === 'unhealthy') return 'error';
  return 'default';
});
const graphHealthSourceTagType = computed<'success' | 'warning' | 'default'>(() => {
  const s = graphHealth.value?.source;
  if (s === 'gm-pro') return 'success';
  if (s === 'local') return 'warning';
  return 'default';
});

// ===== KPI 值（db 为 null 时显示 "—"） =====
const kpiPending = computed<number | string>(() =>
  db.value ? db.value.pendingMessages : '—',
);
const kpiTokenRatio = computed<number | string>(() =>
  db.value ? Math.round(db.value.maxTokenRatio * 1000) / 10 : '—',
);
const kpiAssembleMs = computed<number | string>(() =>
  db.value ? db.value.lastAssembleMs : '—',
);
const kpiCbFailures = computed<number | string>(() => {
  if (!db.value) return '—';
  return db.value.cbLcmFailures + db.value.cbQmdFailures + db.value.cbNeo4jFailures;
});

// ===== 最近更新时间（HH:mm:ss） =====
const lastUpdated = computed(() => formatTimeWithSeconds(db.value?.timestamp));

// ===== 时序图 X 轴标签（按统计粒度格式化） =====
const timeLabels = computed(() =>
  historyAsc.value.map((s) => formatBucketLabel(s.timestamp, bucketSize.value)),
);

// 选择器右侧提示：当前时间范围 + 统计粒度 + 数据点数
const rangeBucketHint = computed(() => {
  const pts = historyAsc.value.length;
  const range = timeRangeLabel(timeRange.value);
  const bucket = bucketSizeLabel(bucketSize.value);
  let hint = `${range} · 粒度 ${bucket} · ${pts} 个数据点`;
  if (pts > 2000) hint += '（点数过多，建议选更粗的统计粒度）';
  return hint;
});

// 时序图1：压力信号（双 Y 轴，左：数量，右：比率 0-1）
const pressureOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['待处理消息', '摘要片段', 'Token 占用比'] },
  grid: { left: 56, right: 64, top: 36, bottom: 28 },
  xAxis: { type: 'category', data: timeLabels.value, boundaryGap: false },
  yAxis: [
    { type: 'value', name: '数量', position: 'left' },
    { type: 'value', name: '比率', position: 'right', min: 0, max: 1 },
  ],
  series: [
    {
      name: '待处理消息',
      type: 'line',
      smooth: true,
      yAxisIndex: 0,
      data: historyAsc.value.map((s) => s.pendingMessages),
      lineStyle: { color: CHART.primary },
      itemStyle: { color: CHART.primary },
    },
    {
      name: '摘要片段',
      type: 'line',
      smooth: true,
      yAxisIndex: 0,
      data: historyAsc.value.map((s) => s.summaryFragments),
      lineStyle: { color: CHART.info },
      itemStyle: { color: CHART.info },
    },
    {
      name: 'Token 占用比',
      type: 'line',
      smooth: true,
      yAxisIndex: 1,
      data: historyAsc.value.map((s) => s.maxTokenRatio),
      lineStyle: { color: CHART.danger },
      itemStyle: { color: CHART.danger },
    },
  ],
}));

// 时序图2：检索延迟（Assemble 折线 + L2/L3/L4 独立柱）
// 修复重复累计 bug：原 4 项全部 stack:'latency' 堆叠，导致 Assemble(含L2/L3/L4) + L2 + L3 + L4
// 虚高。且 L2/L3/L4 为 Promise.all 真并行，堆叠相加物理意义错误。
// 改为：Assemble 折线（总耗时趋势）+ L2/L3/L4 独立柱（不堆叠，各层并行耗时对比）
const latencyOption = computed(() => ({
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: { data: ['Assemble', 'L2', 'L3', 'L4'] },
  grid: { left: 56, right: 20, top: 36, bottom: 28 },
  xAxis: { type: 'category', data: timeLabels.value },
  yAxis: { type: 'value', name: 'ms' },
  series: [
    {
      name: 'Assemble',
      type: 'line',
      smooth: true,
      data: historyAsc.value.map((s) => s.lastAssembleMs),
      lineStyle: { width: 2, color: CHART.primary },
      itemStyle: { color: CHART.primary },
      symbol: 'circle',
      symbolSize: 6,
      z: 10,
    },
    {
      name: 'L2',
      type: 'bar',
      data: historyAsc.value.map((s) => s.lastL2Ms),
      itemStyle: { color: CHART.info },
    },
    {
      name: 'L3',
      type: 'bar',
      data: historyAsc.value.map((s) => s.lastL3Ms),
      itemStyle: { color: CHART.warning },
    },
    {
      name: 'L4',
      type: 'bar',
      data: historyAsc.value.map((s) => s.lastL4Ms),
      itemStyle: { color: CHART.success },
    },
  ],
}));

// 时序图3：tier 分布（堆叠面积图，Y 轴次数）
const tierOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['Low', 'Medium', 'High'] },
  grid: { left: 56, right: 20, top: 36, bottom: 28 },
  xAxis: { type: 'category', data: timeLabels.value, boundaryGap: false },
  yAxis: { type: 'value', name: '次数' },
  series: [
    {
      name: 'Low',
      type: 'line',
      stack: 'tier',
      areaStyle: { color: CHART.success },
      lineStyle: { color: CHART.success },
      itemStyle: { color: CHART.success },
      data: historyAsc.value.map((s) => s.tierLow),
    },
    {
      name: 'Medium',
      type: 'line',
      stack: 'tier',
      areaStyle: { color: CHART.warning },
      lineStyle: { color: CHART.warning },
      itemStyle: { color: CHART.warning },
      data: historyAsc.value.map((s) => s.tierMedium),
    },
    {
      name: 'High',
      type: 'line',
      stack: 'tier',
      areaStyle: { color: CHART.danger },
      lineStyle: { color: CHART.danger },
      itemStyle: { color: CHART.danger },
      data: historyAsc.value.map((s) => s.tierHigh),
    },
  ],
}));

// ===== Cascade top 10 Beta 分布柱状图 =====
const cascadeTopArms = computed(
  () => memory.value?.cascade?.topArms?.slice(0, 10) ?? [],
);
// R-2: cascade Tier 1 置信度（来自 memory.health.latest，仅内存态）
const cascadeTier1Confidence = computed<number | null>(() => {
  const v = memory.value?.health?.latest?.cascadeTier1Confidence;
  return typeof v === 'number' ? Math.round(v * 1000) / 1000 : null;
});
const cascadeJudgeSource = computed<'gm-pro' | 'local' | null>(
  () => memory.value?.health?.latest?.cascadeJudgeSource ?? null,
);

// v1.1-7: 降级链路状态 —— 来自 memory.health.latest 的 UX 指标 + 最近一次降级原因
const uxSnapshot = computed(() => memory.value?.health?.latest ?? null);
const lastDegradedReasons = computed<string[]>(() => {
  const r = uxSnapshot.value?.lastDegradedReasons;
  return Array.isArray(r) ? r : [];
});
const uxSummary = computed(() => {
  const s = uxSnapshot.value;
  if (!s) {
    return { degradationRate: 0, tokenSavedRatio: 0, experienceHitRate: 0, totalAssembles: 0, degradedCount: 0 };
  }
  const total = s.totalAssembleCount ?? 0;
  const degraded = s.degradedCount ?? 0;
  const expQuery = s.experienceQueryCount ?? 0;
  const expHit = s.experienceHitCount ?? 0;
  return {
    degradationRate: total > 0 ? degraded / total : 0,
    tokenSavedRatio: s.tokenSavedRatio ?? 0,
    experienceHitRate: expQuery > 0 ? expHit / expQuery : 0,
    totalAssembles: total,
    degradedCount: degraded,
  };
});
// 各检索层当前是否处于降级（基于 lastDegradedReasons 关键字匹配）
const layerStatus = computed(() => {
  const r = lastDegradedReasons.value;
  const has = (kw: string[]) => kw.some((k) => r.some((x) => x.toLowerCase().includes(k)));
  return {
    L1: has(['l1_', 'qmd']),
    L2: has(['l2_', 'circuit']),
    L3: has(['l3_', 'graph']),
    L4: has(['l4_', 'experience']),
    gmPro: has(['gm_pro', 'gmpro', 'cascade']),
  };
});
// 降级率 tag 颜色：>50% error, >10% warning, 否则 success
const degradationTagType = computed<'success' | 'warning' | 'error' | 'default'>(() => {
  const r = uxSummary.value.degradationRate;
  if (r > 0.5) return 'error';
  if (r > 0.1) return 'warning';
  if (uxSummary.value.totalAssembles > 0) return 'success';
  return 'default';
});
const betaOption = computed(() => {
  const arms = cascadeTopArms.value;
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['alpha', 'beta'] },
    grid: { left: 48, right: 16, top: 30, bottom: 48 },
    xAxis: {
      type: 'category',
      data: arms.map((a) =>
        a.armKey.length > 12 ? a.armKey.slice(0, 10) + '…' : a.armKey,
      ),
      axisLabel: { rotate: 30, fontSize: 10 },
    },
    yAxis: { type: 'value' },
    series: [
      { name: 'alpha', type: 'bar', data: arms.map((a) => a.alpha), itemStyle: { color: CHART.primary } },
      { name: 'beta', type: 'bar', data: arms.map((a) => a.beta), itemStyle: { color: CHART.info } },
    ],
  };
});

// ===== 用户画像 top 标签 =====
const topTechStack = computed(() => {
  const ts = memory.value?.userProfile?.techStack ?? [];
  return [...ts].sort((a, b) => b.weight - a.weight).slice(0, 5);
});
const topScenario = computed(() => {
  const sc = memory.value?.userProfile?.scenario ?? [];
  return [...sc].sort((a, b) => b.weight - a.weight).slice(0, 5);
});
const userLanguage = computed(() => memory.value?.userProfile?.language ?? '—');

// ===== Agent 额外字段（排除 online/error） =====
const agentExtraFields = computed(() => {
  const a = agent.value;
  if (!a) return [];
  return Object.entries(a)
    .filter(([k]) => k !== 'online' && k !== 'error')
    .map(([k, v]) => ({
      key: k,
      value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
    }));
});

// 响应式列数（naive-ui 描述符字符串 + responsive="screen"，断点 xs/s/m/l/xl/xxl）
// KPI 卡片：小屏 2 列，宽屏（l≥1280）4 列
const kpiCols = '2 s:2 m:2 l:4';
// 时序图区下半部分：小屏 1 列，中屏（m≥1024）2 列
const chartCols = '1 s:1 m:2';
// 状态面板：小屏 1 列，中屏 2 列，宽屏（l≥1280）3 列
const panelCols = '1 s:1 m:2 l:3';

// H2 修复：聚合错误摘要（供状态面板 Tab 顶部错误条使用）
const failedPanelSummary = computed(() => {
  const failed: string[] = [];
  if (latestIsError.value) failed.push('健康指标 / 熔断 / memory');
  if (graphHealthIsError.value) failed.push('图谱健康');
  if (agentIsError.value) failed.push('Agent 状态');
  return failed.length ? failed.join('、') + ' 加载失败' : '';
});

// S4-2: Tab 分组（KPI / 时序 / 状态面板），降低单屏信息密度
// 默认激活 KPI tab；display-directive="show" 保持所有面板在 DOM（测试可访问文本）
const activeTab = ref<'kpi' | 'charts' | 'panels' | 'moa'>('kpi');

// ===== MoA 辅助函数 =====
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
  return Object.entries(moaPerf.value.errorBreakdown)
    .sort((a, b) => b[1] - a[1]);
});

// ===== MoA 复杂度趋势图（按小时/天聚合，全量 vs MoA 触发） =====
const moaComplexityTrendOption = computed(() => {
  const hourly = moaPerf.value?.complexityHourlyBuckets;
  const moaHistory = moaPerf.value?.complexityHistory;
  if (!hourly || hourly.length === 0) return {};

  // 按小时聚合全量数据
  const allSeries = {
    name: '全量 (小时均)',
    type: 'line',
    data: hourly.map((b) => [b.hour, b.avg]),
    smooth: true,
    lineStyle: { color: CHART.primary, width: 2 },
    itemStyle: { color: CHART.primary },
    symbol: 'circle',
    symbolSize: 6,
  };

  // MoA 触发叠加（按小时桶）
  const moaByHour: Map<string, number[]> = new Map();
  if (moaHistory) {
    for (const h of moaHistory) {
      const d = new Date(h.timestamp);
      const key = `${String(d.getHours()).padStart(2, '0')}:00`;
      if (!moaByHour.has(key)) moaByHour.set(key, []);
      moaByHour.get(key)!.push(h.score);
    }
  }
  const moaSeries = {
    name: 'MoA 触发 (小时均)',
    type: 'line',
    data: hourly.map((b) => {
      const scores = moaByHour.get(b.hour) ?? [];
      return [b.hour, scores.length > 0 ? Math.round(scores.reduce((a, c) => a + c, 0) / scores.length * 1000) / 1000 : null];
    }),
    smooth: true,
    lineStyle: { color: CHART.danger, width: 2 },
    itemStyle: { color: CHART.danger },
    symbol: 'diamond',
    symbolSize: 8,
    connectNulls: false,
  };

  return {
    title: undefined,
    tooltip: { trigger: 'axis', formatter: (params: any) => {
      const items = Array.isArray(params) ? params : [params];
      let html = `${items[0].axisValue}<br/>`;
      for (const p of items) {
        const val = p.data[1];
        html += `${p.marker}${p.seriesName}: ${val !== null && val !== undefined ? (val as number).toFixed(3) : '—'}<br/>`;
      }
      return html;
    }},
    legend: { data: ['全量 (小时均)', 'MoA 触发 (小时均)'], bottom: 0 },
    xAxis: { type: 'category', data: hourly.map((b) => b.hour), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', name: '评分', min: 0, max: 1, axisLabel: { formatter: (v: number) => v.toFixed(1) } },
    series: [allSeries, moaSeries],
    markLine: { silent: true, data: [{ yAxis: 0.6, label: { formatter: '阈值 0.6' }, lineStyle: { color: '#f0a020', type: 'dashed' } }] },
    grid: { left: 50, right: 30, bottom: 45, top: 45 },
  };
});

// ===== MoA 复杂度分布图（全量 vs MoA 触发 分组对比） =====
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
      for (const p of params) {
        html += `${p.marker}${p.seriesName}: ${p.value}<br/>`;
      }
      html += `全量总计: ${allTotal}<br/>`;
      html += `MoA 触发: ${moaTotal} (${allTotal > 0 ? Math.round(moaTotal / allTotal * 100) : 0}%)`;
      return html;
    }},
    legend: { data: ['全量', 'MoA 触发'], bottom: 0 },
    xAxis: { type: 'category', data: ['低 (0-0.4)', '中 (0.4-0.7)', '高 (0.7-1.0)'], axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', name: '次数', minInterval: 1 },
    series: [
      {
        name: '全量',
        type: 'bar',
        data: [allDist.low, allDist.medium, allDist.high],
        itemStyle: { color: CHART.primary },
        label: { show: true, position: 'top', formatter: '{c}' },
      },
      {
        name: 'MoA 触发',
        type: 'bar',
        data: moaDist ? [moaDist.low, moaDist.medium, moaDist.high] : [0, 0, 0],
        itemStyle: { color: CHART.danger },
        label: { show: true, position: 'top', formatter: '{c}' },
      },
    ],
    grid: { left: 50, right: 30, bottom: 60, top: 45 },
  };
});

// ===== MoA 最近运行表格列 =====
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
const moaLatencyPhaseOption = computed(() => {
  const runs = moaPerf.value?.recentRuns;
  if (!runs || runs.length === 0) return {};
  const data = [...runs].slice(0, 10).reverse();
  return {
    title: undefined,
    tooltip: { trigger: 'axis', formatter: (params: any) => { let h = params[0].name + '<br/>'; for (const p of params) h += `${p.marker}${p.seriesName}: ${Number(p.value).toFixed(0)}ms<br/>`; return h; } },
    legend: { data: ['参考模型', '聚合模型'], bottom: 0 },
    xAxis: { type: 'category', data: data.map((r) => r.queryPreview.slice(0, 16) + (r.queryPreview.length > 16 ? '...' : '')), axisLabel: { fontSize: 10, rotate: 30 } },
    yAxis: { type: 'value', name: '耗时 (ms)' },
    series: [
      { name: '参考模型', type: 'bar', stack: 'total', data: data.map((r) => r.refMs), itemStyle: { color: CHART.primary } },
      { name: '聚合模型', type: 'bar', stack: 'total', data: data.map((r) => r.aggMs), itemStyle: { color: CHART.success } },
    ],
    grid: { left: 60, right: 30, bottom: 60, top: 45 },
  };
});
</script>

<template>
  <div class="monitor-view">
    <!-- 标题行 -->
    <div class="monitor-header">
      <h2 style="margin: 0">性能监控</h2>
      <span class="last-updated">最近更新: {{ lastUpdated }}</span>
    </div>

    <NTabs
      v-model:value="activeTab"
      type="line"
      animated
      size="medium"
      style="margin-top: 12px"
      aria-label="监控视图分组"
    >
      <!-- ===== Tab 1: 总览（KPI + 时序图） ===== -->
      <NTabPane
        name="overview"
        tab="总览"
        display-directive="show"
      >
        <NGrid :cols="kpiCols" :x-gap="12" :y-gap="12" responsive="screen">
          <NGi>
            <KpiCard
              label="待处理消息"
              :value="kpiPending"
              :threshold="100"
              :loading="latestLoading"
            />
          </NGi>
          <NGi>
            <KpiCard
              label="Token 占用比"
              :value="kpiTokenRatio"
              unit="%"
              :threshold="80"
              :loading="latestLoading"
            />
          </NGi>
          <NGi>
            <KpiCard
              label="检索延迟 Assemble"
              :value="kpiAssembleMs"
              unit="ms"
              :threshold="2000"
              :loading="latestLoading"
            />
          </NGi>
          <NGi>
            <KpiCard
              label="熔断失败总数"
              :value="kpiCbFailures"
              :threshold="0"
              :loading="latestLoading"
            />
          </NGi>
        </NGrid>

        <NAlert
          v-if="latestIsError"
          type="error"
          :show-icon="true"
          title="健康指标加载失败"
          style="margin-top: 12px"
        >
          后端 /api/health/latest 不可达或返回错误。请检查插件 snapshot 服务（:7423）是否运行。
        </NAlert>
        <NAlert
          v-else-if="agentIsError"
          type="error"
          :show-icon="true"
          title="Agent 状态加载失败"
          style="margin-top: 12px"
        >
          后端 /api/agent/status 不可达。
        </NAlert>
        <NAlert
          v-else-if="graphHealthIsError"
          type="error"
          :show-icon="true"
          title="图谱健康加载失败"
          style="margin-top: 12px"
        >
          后端 /api/graph/health 不可达。
        </NAlert>
        <NAlert
          v-else-if="historyIsError"
          type="error"
          :show-icon="true"
          title="时序图历史加载失败"
          style="margin-top: 12px"
        >
          后端 /api/health/history 不可达。
        </NAlert>
        <NAlert
          v-if="latestLoading && !latestData"
          type="info"
          :show-icon="true"
          title="正在加载最新健康指标…"
          style="margin-top: 12px"
        />

        <NDivider style="margin: 16px 0" />

        <!-- 时间范围 + 统计粒度 -->
        <div class="granularity-bar">
          <span class="granularity-label">时间范围：</span>
          <NSelect
            v-model:value="timeRange"
            :options="timeRangeOptions"
            size="small"
            style="width: 140px"
          />
          <span class="granularity-label" style="margin-left: 12px">统计粒度：</span>
          <NSelect
            v-model:value="bucketSize"
            :options="bucketSizeOptions"
            size="small"
            style="width: 120px"
          />
          <span class="granularity-hint">
            {{ rangeBucketHint }}
          </span>
        </div>
        <NSpace vertical :size="12">
          <NCard title="压力信号（待处理消息 / 摘要片段 / Token 占用比）" size="small">
            <EChart v-if="historyAsc.length" :option="pressureOption" height="280px" />
            <div v-else-if="historyLoading" class="chart-loading">
              <NSpin size="small" />
            </div>
            <NEmpty
              v-else
              :description="historyIsError ? '加载失败，见上方错误提示' : '无历史数据'"
              style="padding: 24px 0"
            />
          </NCard>
          <NGrid :cols="chartCols" :x-gap="12" :y-gap="12" responsive="screen">
            <NGi>
              <NCard title="检索延迟（Assemble 折线 + L2/L3/L4 独立柱）" size="small">
                <EChart v-if="historyAsc.length" :option="latencyOption" height="280px" />
                <div v-else-if="historyLoading" class="chart-loading">
                  <NSpin size="small" />
                </div>
                <NEmpty
                  v-else
                  :description="historyIsError ? '加载失败，见上方错误提示' : '无历史数据'"
                  style="padding: 24px 0"
                />
              </NCard>
            </NGi>
            <NGi>
              <NCard title="tier 分布（Low/Medium/High 堆叠面积）" size="small">
                <EChart v-if="historyAsc.length" :option="tierOption" height="280px" />
                <div v-else-if="historyLoading" class="chart-loading">
                  <NSpin size="small" />
                </div>
                <NEmpty
                  v-else
                  :description="historyIsError ? '加载失败，见上方错误提示' : '无历史数据'"
                  style="padding: 24px 0"
                />
              </NCard>
            </NGi>
          </NGrid>
        </NSpace>
        <div style="margin-top: 4px; font-size: var(--fs-caption); color: var(--color-text-muted);">
          最近更新: {{ historyLastUpdated || '—' }}
        </div>
      </NTabPane>

      

      
      <NTabPane
        name="panels"
        tab="状态面板"
        display-directive="show"
      >
        <!-- 错误态穿透（H2 修复）：聚合错误条，替代把错误误显示为"插件未响应" -->
        <NAlert
          v-if="latestIsError || graphHealthIsError || agentIsError"
          type="error"
          :show-icon="true"
          title="部分状态面板加载失败"
          style="margin-bottom: 12px"
        >
          {{ failedPanelSummary }}。服务恢复后将自动重试。
        </NAlert>
        <NGrid :cols="panelCols" :x-gap="12" :y-gap="12" responsive="screen">
        <!-- 熔断状态 -->
        <NGi>
          <NCard title="熔断状态" size="small">
            <template v-if="db">
              <StatusIndicator
                label="LCM"
                :available="db.cbLcmAvailable"
                :failures="db.cbLcmFailures"
              />
              <StatusIndicator
                label="QMD"
                :available="db.cbQmdAvailable"
                :failures="db.cbQmdFailures"
              />
              <StatusIndicator
                label="Neo4j"
                :available="db.cbNeo4jAvailable"
                :failures="db.cbNeo4jFailures"
              />
            </template>
            <NEmpty v-else description="无历史数据" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <!-- v1.1-7: 降级链路状态（实时展示 L1/L2/L3/L4 + gm-pro 各路径状态） -->
        <NGi>
          <NCard title="降级链路状态" size="small">
            <template v-if="memory">
              <!-- 各检索层状态指示灯（形状+符号双重编码，不单靠颜色） -->
              <ul class="layer-grid" role="list">
                <li class="layer-cell">
                  <span class="dot" :class="layerStatus.L1 ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.L1 ? '✗' : '✓' }}</span>
                  <span class="layer-label">L1 QMD<span class="sr-only">{{ layerStatus.L1 ? '降级' : '正常' }}</span></span>
                </li>
                <li class="layer-cell">
                  <span class="dot" :class="layerStatus.L2 ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.L2 ? '✗' : '✓' }}</span>
                  <span class="layer-label">L2 熔断<span class="sr-only">{{ layerStatus.L2 ? '降级' : '正常' }}</span></span>
                </li>
                <li class="layer-cell">
                  <span class="dot" :class="layerStatus.L3 ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.L3 ? '✗' : '✓' }}</span>
                  <span class="layer-label">L3 图谱<span class="sr-only">{{ layerStatus.L3 ? '降级' : '正常' }}</span></span>
                </li>
                <li class="layer-cell">
                  <span class="dot" :class="layerStatus.L4 ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.L4 ? '✗' : '✓' }}</span>
                  <span class="layer-label">L4 经验<span class="sr-only">{{ layerStatus.L4 ? '降级' : '正常' }}</span></span>
                </li>
                <li class="layer-cell">
                  <span class="dot" :class="layerStatus.gmPro ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.gmPro ? '✗' : '✓' }}</span>
                  <span class="layer-label">gm-pro<span class="sr-only">{{ layerStatus.gmPro ? '降级' : '正常' }}</span></span>
                </li>
              </ul>
              <!-- UX 摘要 -->
              <NDescriptions :column="1" size="small" label-placement="left" bordered style="margin-top: 8px">
                <NDescriptionsItem label="降级率">
                  <NTag :type="degradationTagType" size="small">
                    {{ (uxSummary.degradationRate * 100).toFixed(1) }}%
                  </NTag>
                  <span class="muted mono" style="margin-left: 6px">
                    {{ uxSummary.degradedCount }}/{{ uxSummary.totalAssembles }}
                  </span>
                </NDescriptionsItem>
                <NDescriptionsItem label="Token 节省率">
                  <span class="mono">{{ (uxSummary.tokenSavedRatio * 100).toFixed(1) }}%</span>
                </NDescriptionsItem>
                <NDescriptionsItem label="经验命中率">
                  <span class="mono">{{ (uxSummary.experienceHitRate * 100).toFixed(1) }}%</span>
                </NDescriptionsItem>
              </NDescriptions>
              <!-- 最近一次降级原因 -->
              <div v-if="lastDegradedReasons.length" class="profile-section" style="margin-top: 8px">
                <div class="profile-label">最近降级原因</div>
                <NSpace :size="4">
                  <NTag
                    v-for="r in lastDegradedReasons"
                    :key="r"
                    size="small"
                    type="warning"
                  >
                    {{ r }}
                  </NTag>
                </NSpace>
              </div>
              <div v-else class="muted" style="margin-top: 8px; font-size: var(--fs-caption)">
                最近一次 assemble 未触发降级
              </div>
            </template>
            <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <!-- Cascade 面板 -->
        <NGi>
          <NCard title="Cascade" size="small">
            <template v-if="memory">
              <NDescriptions :column="1" size="small" label-placement="left" bordered>
                <NDescriptionsItem label="arms 数量">
                  {{ memory.cascade?.armsCount ?? 0 }}
                </NDescriptionsItem>
                <NDescriptionsItem label="置信阈值">
                  {{ memory.cascade?.confidenceThreshold ?? '—' }}
                </NDescriptionsItem>
                <NDescriptionsItem label="Tier1 置信度">
                  <span v-if="cascadeTier1Confidence !== null" class="mono">
                    {{ cascadeTier1Confidence }}
                  </span>
                  <span v-else class="muted">—</span>
                  <NTag
                    v-if="cascadeJudgeSource"
                    size="small"
                    :type="cascadeJudgeSource === 'gm-pro' ? 'success' : 'default'"
                    style="margin-left: 6px"
                  >
                    {{ cascadeJudgeSource }}
                  </NTag>
                </NDescriptionsItem>
              </NDescriptions>
              <EChart
                v-if="cascadeTopArms.length"
                :option="betaOption"
                height="220px"
              />
              <NEmpty
                v-else
                size="small"
                description="无 arm 数据"
                style="margin: 12px 0"
              />
            </template>
            <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <!-- 用户画像 -->
        <NGi>
          <NCard title="用户画像" size="small">
            <template v-if="memory">
              <div class="profile-section">
                <div class="profile-label">技术栈 Top5</div>
                <NSpace :size="4" v-if="topTechStack.length">
                  <NTag
                    v-for="t in topTechStack"
                    :key="t.name"
                    size="small"
                    type="info"
                  >
                    {{ t.name }} ({{ t.weight }})
                  </NTag>
                </NSpace>
                <span v-else class="muted">—</span>
              </div>
              <div class="profile-section">
                <div class="profile-label">场景 Top5</div>
                <NSpace :size="4" v-if="topScenario.length">
                  <NTag
                    v-for="s in topScenario"
                    :key="s.name"
                    size="small"
                    type="success"
                  >
                    {{ s.name }} ({{ s.weight }})
                  </NTag>
                </NSpace>
                <span v-else class="muted">—</span>
              </div>
              <div class="profile-section">
                <span class="profile-label">语言：</span>
                <NTag size="small">{{ userLanguage }}</NTag>
              </div>
            </template>
            <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <!-- 债务调度 -->
        <NGi>
          <NCard title="债务调度" size="small">
            <template v-if="memory">
              <NDescriptions :column="1" size="small" label-placement="left" bordered>
                <NDescriptionsItem label="running">
                  {{ memory.debt?.running ?? 0 }}
                </NDescriptionsItem>
                <NDescriptionsItem label="pendingCount">
                  {{ memory.debt?.pendingCount ?? 0 }}
                </NDescriptionsItem>
                <NDescriptionsItem label="pollIntervalMs">
                  {{ memory.debt?.pollIntervalMs ?? 0 }}
                </NDescriptionsItem>
                <NDescriptionsItem label="maxConcurrent">
                  {{ memory.debt?.maxConcurrent ?? 0 }}
                </NDescriptionsItem>
              </NDescriptions>
            </template>
            <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <!-- 检索状态 -->
        <NGi>
          <NCard title="检索状态" size="small">
            <template v-if="memory">
              <NDescriptions :column="1" size="small" label-placement="left" bordered>
                <NDescriptionsItem label="最近查询">
                  <span class="mono">{{ memory.retrieval?.lastQuery || '—' }}</span>
                </NDescriptionsItem>
                <NDescriptionsItem label="性能摘要">
                  <span class="mono">{{ memory.retrieval?.perfSummary || '—' }}</span>
                </NDescriptionsItem>
              </NDescriptions>
              <div class="profile-section">
                <div class="profile-label">图谱适配器</div>
                <StatusIndicator
                  label="connected"
                  :available="!!memory.graphAdapter?.connected"
                  :failures="memory.graphAdapter?.connectFailed ? 1 : 0"
                />
                <div v-if="memory.graphAdapter?.lastError" class="muted mono">
                  {{ memory.graphAdapter.lastError }}
                </div>
              </div>
            </template>
            <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <!-- G-5: 图谱健康卡片（gm-pro getGraphHealth，降级到本地 graphAdapter） -->
        <NGi>
          <NCard title="图谱健康" size="small">
            <div v-if="graphHealthLoading && !graphHealth" class="card-loading">
              <NSpin size="small" />
            </div>
            <template v-else-if="graphHealth">
              <div class="profile-section">
                <NTag :type="graphHealthTagType" size="small">
                  {{ graphHealth.status }}
                </NTag>
                <NTag
                  :type="graphHealthSourceTagType"
                  size="small"
                  style="margin-left: 6px"
                >
                  source: {{ graphHealth.source }}
                </NTag>
              </div>
              <NDescriptions :column="1" size="small" label-placement="left" bordered>
                <NDescriptionsItem label="nodeCount">
                  {{ graphHealth.nodeCount ?? '—' }}
                </NDescriptionsItem>
                <NDescriptionsItem label="relationshipCount">
                  {{ graphHealth.relationshipCount ?? '—' }}
                </NDescriptionsItem>
                <NDescriptionsItem label="graphAdapter">
                  <StatusIndicator
                    label="connected"
                    :available="!!graphHealth.graphAdapterConnected"
                    :failures="0"
                  />
                </NDescriptionsItem>
              </NDescriptions>
              <div v-if="graphHealth.error" class="muted mono" style="margin-top: 6px">
                {{ graphHealth.error }}
              </div>
            </template>
            <NEmpty v-else description="无图谱健康数据" style="padding: 12px 0" />
          </NCard>
        </NGi>

        <!-- Agent 状态 -->
        <NGi>
          <NCard title="Agent 状态" size="small">
            <div v-if="agentLoading && !agent" class="card-loading">
              <NSpin size="small" />
            </div>
            <template v-else-if="agent">
              <div class="profile-section">
                <NTag :type="agent.online ? 'success' : 'error'" size="small">
                  {{ agent.online ? '在线' : '离线' }}
                </NTag>
              </div>
              <NAlert
                v-if="agent.error"
                type="warning"
                :show-icon="true"
                style="margin: 8px 0"
              >
                {{ agent.error }}
              </NAlert>
              <NDescriptions
                v-if="agentExtraFields.length"
                :column="1"
                size="small"
                label-placement="left"
                bordered
              >
                <NDescriptionsItem
                  v-for="f in agentExtraFields"
                  :key="f.key"
                  :label="f.key"
                >
                  <span class="mono">{{ f.value }}</span>
                </NDescriptionsItem>
              </NDescriptions>
            </template>
            <NEmpty v-else description="无 Agent 数据" style="padding: 12px 0" />
          </NCard>
        </NGi>
      </NGrid>
      </NTabPane>

      <!-- ===== Tab 3: MoA 性能 ===== -->
      <NTabPane
        name="moa"
        tab="MoA 性能"
        display-directive="show"
      >
        <div v-if="moaPerfLoading && !moaPerf" class="chart-loading">
          <NSpin size="small" />
        </div>

        <template v-else-if="moaPerf">
          <!-- KPI 概览行 -->
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
              <KpiCard
                label="成功率"
                :value="moaPerf.totalRuns > 0 ? moaSuccessRate : 0"
                unit="%"
                :threshold="90"
              >
                <template #detail>
                  <NTag size="tiny" :type="moaSuccessRateType">{{ moaSuccessRate >= 90 ? '健康' : moaSuccessRate >= 70 ? '注意' : '告警' }}</NTag>
                </template>
              </KpiCard>
            </NGi>
            <NGi>
              <KpiCard
                label="平均耗时"
                :value="Math.round(moaPerf.avgTotalMs / 1000)"
                unit="s"
                :threshold="120"
              >
                <template #detail>
                  <span class="muted">参考 {{ formatMs(moaPerf.avgRefMs) }} / 聚合 {{ formatMs(moaPerf.avgAggMs) }}</span>
                </template>
              </KpiCard>
            </NGi>
          </NGrid>
          <NGrid :cols="'1 s:2 m:3'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
            <NGi>
              <KpiCard
                label="Token 消耗"
                :value="moaPerf.totalTokens"
              >
                <template #detail>
                  <span class="muted">平均 {{ formatTokens(moaPerf.avgTokens) }}/次 · 效率 {{ moaPerf.tokenEfficiency }} 字符/Token</span>
                </template>
              </KpiCard>
            </NGi>
            <NGi>
              <KpiCard
                label="平均复杂度"
                :value="moaPerf.avgComplexityScore"
                :threshold="0.6"
              >
                <template #detail>
                  <NTag size="tiny" :type="moaPerf.avgComplexityScore >= 0.7 ? 'error' : moaPerf.avgComplexityScore >= 0.4 ? 'warning' : 'info'">
                    {{ moaPerf.avgComplexityScore >= 0.7 ? '高' : moaPerf.avgComplexityScore >= 0.4 ? '中' : '低' }}
                  </NTag>
                </template>
              </KpiCard>
            </NGi>
            <NGi>
              <KpiCard
                label="平均响应"
                :value="moaPerf.avgResponseLen"
                unit="字符"
              />
            </NGi>
          </NGrid>

          <!-- 复杂度百分位：全量 + MoA 触发 双行 -->
          <NCard title="复杂度百分位" size="small" style="margin-bottom: 16px">
            <NGrid :cols="'1 s:2 m:4'" :x-gap="12" :y-gap="6" responsive="screen">
              <NGi>
                <span class="muted" style="font-size: var(--fs-caption)">全量 P50</span>
                <div class="mono" style="font-weight: 600">{{ moaPerf.allComplexityPercentiles.p50.toFixed(3) }}</div>
              </NGi>
              <NGi>
                <span class="muted" style="font-size: var(--fs-caption)">全量 P90</span>
                <div class="mono" style="font-weight: 600">{{ moaPerf.allComplexityPercentiles.p90.toFixed(3) }}</div>
              </NGi>
              <NGi>
                <span class="muted" style="font-size: var(--fs-caption)">全量 P95</span>
                <div class="mono" style="font-weight: 600">{{ moaPerf.allComplexityPercentiles.p95.toFixed(3) }}</div>
              </NGi>
              <NGi>
                <span class="muted" style="font-size: var(--fs-caption)">全量 P99</span>
                <div class="mono" style="font-weight: 600">{{ moaPerf.allComplexityPercentiles.p99.toFixed(3) }}</div>
              </NGi>
            </NGrid>
            <NDivider style="margin: 8px 0" />
            <NGrid :cols="'1 s:2 m:4'" :x-gap="12" :y-gap="6" responsive="screen">
              <NGi>
                <span class="muted" style="font-size: var(--fs-caption)">MoA P50</span>
                <div class="mono" style="font-weight: 600; color: var(--color-danger)">{{ moaPerf.complexityPercentiles.p50.toFixed(3) }}</div>
              </NGi>
              <NGi>
                <span class="muted" style="font-size: var(--fs-caption)">MoA P90</span>
                <div class="mono" style="font-weight: 600; color: var(--color-danger)">{{ moaPerf.complexityPercentiles.p90.toFixed(3) }}</div>
              </NGi>
              <NGi>
                <span class="muted" style="font-size: var(--fs-caption)">MoA P95</span>
                <div class="mono" style="font-weight: 600; color: var(--color-danger)">{{ moaPerf.complexityPercentiles.p95.toFixed(3) }}</div>
              </NGi>
              <NGi>
                <span class="muted" style="font-size: var(--fs-caption)">MoA P99</span>
                <div class="mono" style="font-weight: 600; color: var(--color-danger)">{{ moaPerf.complexityPercentiles.p99.toFixed(3) }}</div>
              </NGi>
            </NGrid>
          </NCard>

          <!-- 复杂度趋势图 + 分布图 -->
          <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
            <NGi>
              <NCard title="复杂度趋势（按小时聚合）" size="small" :bordered="true">
                <EChart :option="moaComplexityTrendOption" height="300px" :skip-theme="true" />
              </NCard>
            </NGi>
            <NGi>
              <NCard title="复杂度分布（全量 vs MoA 触发）" size="small" :bordered="true">
                <EChart :option="moaComplexityDistOption" height="300px" :skip-theme="true" />
              </NCard>
            </NGi>
          </NGrid>

          <!-- 延迟百分位 + 阶段耗时分解图 -->
          <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
            <!-- 延迟百分位 -->
            <NGi>
              <NCard title="延迟百分位（P50/P90/P95/P99）" size="small">
                <template v-if="moaPerf.totalRuns > 0">
                  <NDescriptions :column="2" size="small" label-placement="left" bordered>
                    <NDescriptionsItem label="P50 总耗时">
                      <span class="mono">{{ formatMs(moaPerf.latencyPercentiles.p50) }}</span>
                    </NDescriptionsItem>
                    <NDescriptionsItem label="P50 参考">
                      <span class="mono">{{ formatMs(moaPerf.refLatencyPercentiles.p50) }}</span>
                    </NDescriptionsItem>
                    <NDescriptionsItem label="P90 总耗时">
                      <span class="mono">{{ formatMs(moaPerf.latencyPercentiles.p90) }}</span>
                    </NDescriptionsItem>
                    <NDescriptionsItem label="P90 参考">
                      <span class="mono">{{ formatMs(moaPerf.refLatencyPercentiles.p90) }}</span>
                    </NDescriptionsItem>
                    <NDescriptionsItem label="P95 总耗时">
                      <NTag size="tiny" :type="moaPerf.latencyPercentiles.p95 > 120000 ? 'warning' : 'default'">
                        {{ formatMs(moaPerf.latencyPercentiles.p95) }}
                      </NTag>
                    </NDescriptionsItem>
                    <NDescriptionsItem label="P95 聚合">
                      <span class="mono">{{ formatMs(moaPerf.aggLatencyPercentiles.p95) }}</span>
                    </NDescriptionsItem>
                    <NDescriptionsItem label="P99 总耗时">
                      <NTag size="tiny" :type="moaPerf.latencyPercentiles.p99 > 300000 ? 'error' : 'warning'">
                        {{ formatMs(moaPerf.latencyPercentiles.p99) }}
                      </NTag>
                    </NDescriptionsItem>
                    <NDescriptionsItem label="P99 聚合">
                      <span class="mono">{{ formatMs(moaPerf.aggLatencyPercentiles.p99) }}</span>
                    </NDescriptionsItem>
                  </NDescriptions>
                </template>
                <NEmpty v-else description="暂无数据" style="padding: 12px 0" />
              </NCard>
            </NGi>

            <!-- 延迟阶段分解图 -->
            <NGi>
              <NCard title="最近 10 次延迟阶段分解" size="small" :bordered="true">
                <EChart :option="moaLatencyPhaseOption" height="300px" :skip-theme="true" />
              </NCard>
            </NGi>
          </NGrid>

          <!-- 模型级指标 + 错误分布 -->
          <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
            <!-- 模型级细粒度指标 -->
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

            <!-- 错误分布 -->
            <NGi>
              <NCard title="错误类型分布" size="small">
                <template v-if="moaErrorItems.length > 0">
                  <div class="error-list">
                    <div v-for="[type, count] in moaErrorItems" :key="type" class="error-item">
                      <NTag size="small" type="error">{{ type }}</NTag>
                      <span class="error-count">{{ count }} 次</span>
                      <div class="error-bar-track">
                        <div
                          class="error-bar-fill"
                          :style="{ width: moaPerf.failedRuns > 0 ? ((count / moaPerf.failedRuns) * 100).toFixed(0) + '%' : '0%' }"
                        />
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
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.monitor-view {
  width: 100%;
}
.monitor-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.last-updated {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
.profile-section {
  margin-bottom: var(--space-sm);
}
.profile-label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-xs);
}
/* .muted / .mono 已在 tokens.css 全局定义，此处不重复 */
.layer-grid {
  display: grid;
  /* L5 修复：窄屏自适应列数（auto-fill + minmax），避免 5 列在窄屏被挤压 */
  grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  gap: var(--space-sm);
  /* 重置 ul 默认样式 */
  list-style: none;
  margin: 0;
  padding: 0;
}
.layer-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm) 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
/* 状态点：符号居中，双重编码（颜色+符号） */
.layer-cell .dot {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  font-weight: 700;
  line-height: 1;
  /* v2.3.3：符号色用染色表面（白 + 1.5% 蓝），避免纯白 */
  color: var(--color-surface);
}
.layer-cell .dot-ok {
  background: var(--color-success);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-success) 60%, transparent);
}
.layer-cell .dot-fail {
  background: var(--color-danger);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-danger) 60%, transparent);
}
.layer-label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
/* M10 修复：统一加载态样式（图表/卡片内居中 spinner） */
.chart-loading,
.card-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}
/* 时序图时间粒度选择器工具条 */
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
}

/* ===== MoA 性能样式 ===== */
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-label {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
}

.stat-value {
  font-size: var(--fs-h2);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stat-detail {
  display: flex;
  gap: 6px;
  align-items: center;
}

.phase-bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.phase-bar-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.phase-bar-label {
  width: 80px;
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  text-align: right;
  flex-shrink: 0;
}

.phase-bar-track {
  flex: 1;
  height: 10px;
  background: var(--color-border);
  border-radius: 5px;
  overflow: hidden;
}

.phase-bar-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.5s ease;
}

.phase-bar-ref {
  background: var(--color-primary);
}

.phase-bar-agg {
  background: var(--color-success);
}

.phase-bar-value {
  width: 60px;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

/* 模型级指标表格 */
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

/* 错误分布 */
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

/* 运行记录表格 */
.run-table {
  overflow-x: auto;
}

.run-table-header {
  display: flex;
  font-size: var(--fs-caption);
  font-weight: 500;
  color: var(--color-text-tertiary);
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border);
  gap: 8px;
}

.run-row {
  display: flex;
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--fs-body);
  gap: 8px;
  align-items: center;
}

.run-row:last-child {
  border-bottom: none;
}

.run-failed {
  background: rgba(208, 48, 80, 0.04);
}

.col-time { width: 70px; flex-shrink: 0; }
.col-query { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-mode { width: 55px; flex-shrink: 0; text-align: center; }
.col-status { width: 45px; flex-shrink: 0; text-align: center; }
.col-total { width: 65px; flex-shrink: 0; text-align: right; }
.col-ref { width: 100px; flex-shrink: 0; text-align: right; }
.col-agg { width: 95px; flex-shrink: 0; text-align: right; }
.col-tokens { width: 55px; flex-shrink: 0; text-align: right; }

.num {
  font-variant-numeric: tabular-nums;
}
</style>
