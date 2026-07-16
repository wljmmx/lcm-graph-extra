<script setup lang="ts">
/**
 * MoA 性能监控页面。
 *
 * 展示 MoA 管道的运行性能数据，包含：
 * - 总览 KPI（运行次数、成功率、平均延迟、平均复杂度评分）
 * - 复杂度评分趋势图（最近 20 次运行奇异值变化）
 * - 复杂度分布图（低/中/高 区间柱状图）
 * - 复杂度百分位卡片
 * - 延迟阶段分解图
 * - 最近运行记录表格
 *
 * 数据获取：TanStack Query 10s 轮询 /api/moa/performance
 */
import { computed, h } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  NGrid,
  NGi,
  NCard,
  NEmpty,
  NTag,
  NTable,
  NSpin,
} from 'naive-ui';
import EChart from '../components/EChart.vue';
import KpiCard from '../components/KpiCard.vue';
import { fetchMoaPerformance, type MoaPerformanceData } from '../api/moa';

// ===== 数据获取 =====
const { data: perfResp, isLoading, isError } = useQuery({
  queryKey: ['moa-performance'],
  queryFn: () => fetchMoaPerformance(),
  refetchInterval: 10_000,
});

const perf = computed<MoaPerformanceData | null>(() => perfResp.value?.data ?? null);

// ===== 复杂度趋势图配置 =====
const complexityTrendOption = computed(() => {
  const history = perf.value?.complexityHistory ?? [];
  if (history.length === 0) return {};

  return {
    title: { text: '复杂度评分趋势', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        return `时间: ${new Date(p.data[0]).toLocaleTimeString()}<br/>复杂度: ${p.data[1].toFixed(3)}`;
      },
    },
    xAxis: {
      type: 'time',
      name: '时间',
      axisLabel: { formatter: (v: number) => new Date(v).toLocaleTimeString() },
    },
    yAxis: {
      type: 'value',
      name: '评分',
      min: 0,
      max: 1,
      axisLabel: { formatter: (v: number) => v.toFixed(1) },
    },
    series: [{
      name: '复杂度评分',
      type: 'line',
      data: history.map((h) => [h.timestamp, h.score]),
      smooth: true,
      markLine: {
        silent: true,
        data: [
          { yAxis: 0.6, label: { formatter: '阈值 0.6' }, lineStyle: { color: '#f0a020', type: 'dashed' } },
        ],
      },
      markArea: {
        silent: true,
        data: [
          [
            { yAxis: 0, itemStyle: { color: 'rgba(24, 160, 88, 0.06)' } },
            { yAxis: 0.4 },
          ],
          [
            { yAxis: 0.4, itemStyle: { color: 'rgba(240, 160, 32, 0.06)' } },
            { yAxis: 0.7 },
          ],
          [
            { yAxis: 0.7, itemStyle: { color: 'rgba(208, 48, 80, 0.06)' } },
            { yAxis: 1 },
          ],
        ],
      },
    }],
    grid: { left: 50, right: 30, bottom: 40, top: 50 },
  };
});

// ===== 复杂度分布图配置 =====
const complexityDistOption = computed(() => {
  const dist = perf.value?.complexityDistribution;
  if (!dist) return {};

  return {
    title: { text: '复杂度触发分布', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: ['低 (0.0-0.4)', '中 (0.4-0.7)', '高 (0.7-1.0)'],
      axisLabel: { fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: '运行次数',
      minInterval: 1,
    },
    series: [{
      name: '运行次数',
      type: 'bar',
      data: [
        { value: dist.low, itemStyle: { color: '#18a058' } },
        { value: dist.medium, itemStyle: { color: '#f0a020' } },
        { value: dist.high, itemStyle: { color: '#d03050' } },
      ],
      label: { show: true, position: 'top', formatter: '{c}' },
    }],
    grid: { left: 50, right: 30, bottom: 40, top: 50 },
  };
});

// ===== 延迟阶段分解图配置 =====
const latencyPhaseOption = computed(() => {
  const runs = perf.value?.recentRuns ?? [];
  if (runs.length === 0) return {};

  const data = runs.slice(0, 10).reverse();
  return {
    title: { text: '最近 10 次延迟阶段分解', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        let html = params[0].name + '<br/>';
        for (const p of params) {
          html += `${p.marker}${p.seriesName}: ${p.value}ms<br/>`;
        }
        return html;
      },
    },
    legend: { data: ['参考模型阶段', '聚合模型阶段'], bottom: 0 },
    xAxis: {
      type: 'category',
      data: data.map((r) => r.queryPreview.slice(0, 20) + (r.queryPreview.length > 20 ? '...' : '')),
      axisLabel: { fontSize: 10, rotate: 30 },
    },
    yAxis: {
      type: 'value',
      name: '耗时 (ms)',
    },
    series: [
      {
        name: '参考模型阶段',
        type: 'bar',
        stack: 'total',
        data: data.map((r) => r.refMs),
        itemStyle: { color: '#2080f0' },
      },
      {
        name: '聚合模型阶段',
        type: 'bar',
        stack: 'total',
        data: data.map((r) => r.aggMs),
        itemStyle: { color: '#18a058' },
      },
    ],
    grid: { left: 60, right: 30, bottom: 60, top: 45 },
  };
});

// ===== 最近运行表格列 =====
const runsColumns = [
  { title: '时间', key: 'timestamp', render: (row: any) => new Date(row.timestamp).toLocaleTimeString() },
  { title: '查询', key: 'queryPreview', render: (row: any) => row.queryPreview.slice(0, 30) + (row.queryPreview.length > 30 ? '...' : ''), width: 200 },
  { title: '复杂度', key: 'complexityScore', render: (row: any) => row.complexityScore !== undefined ? row.complexityScore.toFixed(3) : '—' },
  { title: '总耗时', key: 'totalMs', render: (row: any) => `${(row.totalMs / 1000).toFixed(1)}s` },
  { title: '参考阶段', key: 'refMs', render: (row: any) => `${(row.refMs / 1000).toFixed(1)}s` },
  { title: '聚合阶段', key: 'aggMs', render: (row: any) => `${(row.aggMs / 1000).toFixed(1)}s` },
  { title: 'Token', key: 'totalTokens' },
  { title: '状态', key: 'success', render: (row: any) => h(NTag, { type: row.success ? 'success' : 'error', size: 'small' }, { default: () => row.success ? '成功' : '失败' }) },
  { title: '模式', key: 'mode' },
];

</script>

<template>
  <NSpin :show="isLoading">
    <div style="max-width: 1400px; margin: 0 auto;">
      <h2 style="margin-bottom: 16px; font-weight: 600;">MoA 性能监控</h2>

      <!-- 错误状态 -->
      <NCard v-if="isError" size="small" style="margin-bottom: 16px;">
        <NEmpty description="无法获取 MoA 性能数据，请检查 MoA 是否已启用" />
      </NCard>

      <!-- 无数据状态 -->
      <NCard v-else-if="!perf || perf.totalRuns === 0" size="small" style="margin-bottom: 16px;">
        <NEmpty description="暂无 MoA 运行记录" />
      </NCard>

      <template v-else>
        <!-- ==================== KPI 行 1：总览 ==================== -->
        <NGrid :cols="4" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px;">
          <NGi>
            <KpiCard label="总运行次数" :value="perf.totalRuns" />
          </NGi>
          <NGi>
            <KpiCard
              label="成功率"
              :value="perf.totalRuns > 0 ? perf.successRuns / perf.totalRuns * 100 : 0"
              unit="%"
              :threshold="95"
            />
          </NGi>
          <NGi>
            <KpiCard label="平均延迟" :value="Math.round(perf.avgTotalMs / 1000)" unit="s" />
          </NGi>
          <NGi>
            <KpiCard
              label="平均复杂度评分"
              :value="perf.avgComplexityScore"
              :threshold="0.6"
            />
          </NGi>
        </NGrid>

        <!-- ==================== 图表行 1：复杂度趋势 + 复杂度分布 ==================== -->
        <NGrid :cols="2" :x-gap="12" :y-gap="12" style="margin-bottom: 16px;">
          <NGi>
            <NCard size="small" :bordered="true">
              <EChart
                :option="complexityTrendOption"
                height="320px"
                :skip-theme="true"
              />
            </NCard>
          </NGi>
          <NGi>
            <NCard size="small" :bordered="true">
              <EChart
                :option="complexityDistOption"
                height="320px"
                :skip-theme="true"
              />
            </NCard>
          </NGi>
        </NGrid>

        <!-- ==================== KPI 行 2：复杂度百分位 ==================== -->
        <NGrid :cols="4" :x-gap="12" :y-gap="12" style="margin-bottom: 16px;">
          <NGi>
            <KpiCard label="复杂度 P50" :value="perf.complexityPercentiles.p50" />
          </NGi>
          <NGi>
            <KpiCard label="复杂度 P90" :value="perf.complexityPercentiles.p90" />
          </NGi>
          <NGi>
            <KpiCard label="复杂度 P95" :value="perf.complexityPercentiles.p95" />
          </NGi>
          <NGi>
            <KpiCard label="复杂度 P99" :value="perf.complexityPercentiles.p99" />
          </NGi>
        </NGrid>

        <!-- ==================== 图表行 2：延迟阶段分解 ==================== -->
        <NGrid :cols="1" :x-gap="12" :y-gap="12" style="margin-bottom: 16px;">
          <NGi>
            <NCard size="small" :bordered="true">
              <EChart
                :option="latencyPhaseOption"
                height="320px"
                :skip-theme="true"
              />
            </NCard>
          </NGi>
        </NGrid>

        <!-- ==================== 最近运行记录 ==================== -->
        <NCard size="small" :bordered="true" title="最近运行记录">
          <NTable
            :data="perf.recentRuns"
            :columns="runsColumns"
            :bordered="false"
            :single-line="false"
            size="small"
            :max-height="400"
            striped
          />
        </NCard>
      </template>
    </div>
  </NSpin>
</template>