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
import { computed, ref } from 'vue';
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
import { formatTime, formatTimeWithSeconds, formatByGranularity, timeBucketKey, type TimeGranularity } from '../utils/format';

// ===== 时序图时间粒度选择 =====
// 用户可选择按原始(5min)/小时/天/周/月聚合分析，而非仅按时间堆积
const granularityOptions = [
  { label: '原始 (5min)', value: 'raw' as TimeGranularity },
  { label: '按小时', value: 'hour' as TimeGranularity },
  { label: '按天', value: 'day' as TimeGranularity },
  { label: '按周', value: 'week' as TimeGranularity },
  { label: '按月', value: 'month' as TimeGranularity },
];
const timeGranularity = ref<TimeGranularity>('raw');

// 根据粒度决定拉取的数据量（n 条原始点）
// raw: 144 (12h) / hour: 288 (24h) / day: 2016 (7天) / week: 8640 (30天) / month: 8640 (30天)
const historyN = computed(() => {
  switch (timeGranularity.value) {
    case 'hour': return 288;
    case 'day': return 2016;
    case 'week': return 8640;
    case 'month': return 8640;
    case 'raw':
    default: return 144;
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

// ===== 派生数据 =====
const db = computed<HealthSnapshot | null>(() => latestData.value?.db ?? null);
const memory = computed<DashboardSnapshot | null>(
  () => latestData.value?.memory ?? null,
);
// DB 返回 DESC（最新在前），时序图需要 ASC（最旧在前）
const rawHistoryAsc = computed<HealthSnapshot[]>(() => {
  const snaps = historyData.value?.snapshots ?? [];
  return [...snaps].reverse();
});

/**
 * 按时间粒度聚合历史快照。
 *
 * 聚合规则（不同指标用不同聚合函数）：
 * - pendingMessages / summaryFragments → max（峰值更有意义）
 * - maxTokenRatio → avg（平均占用）
 * - lastAssembleMs / lastL2Ms / lastL3Ms / lastL4Ms → avg（平均延迟）
 * - tierLow / tierMedium / tierHigh → sum（累计次数）
 * - cbFailures → max
 * - timestamp → 桶内最新时间戳（用于 X 轴标签）
 *
 * raw 粒度直接返回原始数据。
 */
const historyAsc = computed<HealthSnapshot[]>(() => {
  const snaps = rawHistoryAsc.value;
  const g = timeGranularity.value;
  if (g === 'raw' || snaps.length === 0) return snaps;

  // 按时间桶分组
  const buckets = new Map<string, HealthSnapshot[]>();
  for (const s of snaps) {
    const key = timeBucketKey(s.timestamp, g);
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

// ===== 时序图 X 轴标签（按粒度格式化） =====
const timeLabels = computed(() =>
  historyAsc.value.map((s) => formatByGranularity(s.timestamp, timeGranularity.value)),
);

// 粒度选择器右侧提示：说明当前粒度覆盖的时间范围与聚合方式
const granularityHint = computed(() => {
  switch (timeGranularity.value) {
    case 'hour': return '每小时聚合（max/avg），覆盖最近 24h';
    case 'day': return '每天聚合，覆盖最近 7 天';
    case 'week': return '每周聚合，覆盖最近 30 天';
    case 'month': return '每月聚合，覆盖最近 30 天';
    case 'raw':
    default: return '原始 5min 采样，覆盖最近 12h';
  }
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
    },
    {
      name: '摘要片段',
      type: 'line',
      smooth: true,
      yAxisIndex: 0,
      data: historyAsc.value.map((s) => s.summaryFragments),
    },
    {
      name: 'Token 占用比',
      type: 'line',
      smooth: true,
      yAxisIndex: 1,
      data: historyAsc.value.map((s) => s.maxTokenRatio),
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
      lineStyle: { width: 2 },
      symbol: 'circle',
      symbolSize: 6,
      z: 10,
    },
    {
      name: 'L2',
      type: 'bar',
      data: historyAsc.value.map((s) => s.lastL2Ms),
    },
    {
      name: 'L3',
      type: 'bar',
      data: historyAsc.value.map((s) => s.lastL3Ms),
    },
    {
      name: 'L4',
      type: 'bar',
      data: historyAsc.value.map((s) => s.lastL4Ms),
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
      areaStyle: {},
      data: historyAsc.value.map((s) => s.tierLow),
    },
    {
      name: 'Medium',
      type: 'line',
      stack: 'tier',
      areaStyle: {},
      data: historyAsc.value.map((s) => s.tierMedium),
    },
    {
      name: 'High',
      type: 'line',
      stack: 'tier',
      areaStyle: {},
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
      { name: 'alpha', type: 'bar', data: arms.map((a) => a.alpha) },
      { name: 'beta', type: 'bar', data: arms.map((a) => a.beta) },
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
const activeTab = ref<'kpi' | 'charts' | 'panels'>('kpi');
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
      <!-- ===== Tab 1: KPI 概览 ===== -->
      <NTabPane
        name="kpi"
        tab="KPI 概览"
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

        <!-- E1 修复: 接口报错时显式提示，避免用户误判"无数据" -->
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

        <!-- 首次加载提示 -->
        <NAlert
          v-if="latestLoading && !latestData"
          type="info"
          :show-icon="true"
          title="正在加载最新健康指标…"
          style="margin-top: 12px"
        />
      </NTabPane>

      <!-- ===== Tab 2: 时序图 ===== -->
      <NTabPane
        name="charts"
        tab="时序图"
        display-directive="show"
      >
        <!-- 错误态穿透（H2 修复）：接口报错时在该 Tab 顶部提示，而非混入"无历史数据" -->
        <NAlert
          v-if="historyIsError"
          type="error"
          :show-icon="true"
          title="时序图历史加载失败"
          style="margin-bottom: 12px"
        >
          后端 /api/health/history 不可达。服务恢复后将自动重试（每 60 秒轮询）。
        </NAlert>
        <!-- 时间粒度选择器：支持按原始/小时/天/周/月聚合分析，而非仅按时间堆积 -->
        <div class="granularity-bar">
          <span class="granularity-label">时间粒度：</span>
          <NSelect
            v-model:value="timeGranularity"
            :options="granularityOptions"
            size="small"
            style="width: 160px"
          />
          <span class="granularity-hint">
            {{ granularityHint }}
          </span>
        </div>
        <NSpace vertical :size="12">
          <!-- 压力信号（全宽） -->
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

          <!-- 检索延迟 + tier 分布（2 列） -->
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
      </NTabPane>

      <!-- ===== Tab 3: 状态面板 ===== -->
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
</style>
