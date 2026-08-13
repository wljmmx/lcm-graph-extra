<script setup lang="ts">
/**
 * 关联矩阵 M · 热力网格：降采样热力网格 + 学习集中度标量。
 *
 * 数据来源于 AssociationMatrixCard 拆分而来，仅保留热力可视化。
 */
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { NCard, NButton, NEmpty } from 'naive-ui';
import CardState from './CardState.vue';
import EChart from '../EChart.vue';
import {
  fetchGmProAssociationMatrixVisual,
  type GmProAssociationMatrixState,
  type GmProAssociationMatrixVisual,
} from '../../api/gm-pro';

const props = defineProps<{
  am: GmProAssociationMatrixState | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

// ── 热力网格（独立端点，降采样） ─────────────────────────────────
const visualMax = 48; // 降采样网格尺寸
const {
  data: visualRes,
  isFetching: visualFetching,
  isError: visualIsError,
  refetch: refetchVisual,
} = useQuery({
  queryKey: ['gm-pro-association-matrix-visual', visualMax],
  queryFn: () => fetchGmProAssociationMatrixVisual(visualMax),
  refetchInterval: (query) => (query.state.data?.ok ? 180_000 : false),
  staleTime: 120_000,
  retry: 1,
});
// 仅"尚无数据"的首次加载时显示转圈，避免就绪后的后台 refetch 再触发。
const visualLoading = computed(() => visualFetching.value && !visual.value?.grid && !visualIsError.value);
const visual = computed<GmProAssociationMatrixVisual | null>(() =>
  visualRes.value?.ok ? (visualRes.value.data ?? null) : null,
);

/** 热力图数据 [x, y, value]，x=列 y=行 */
const heatmapData = computed<Array<[number, number, number]>>(() => {
  const v = visual.value;
  const grid = v?.grid ?? 0;
  const values = v?.values ?? [];
  const out: Array<[number, number, number]> = [];
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      out.push([r, c, values[r * grid + c] ?? 0]);
    }
  }
  return out;
});

/** 热力图颜色区间：以对角 + 白（0）为对称，负蓝正红 */
const heatmapMinMax = computed(() => {
  const v = heatmapData.value;
  if (!v.length) return { min: -1, max: 1 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [, , val] of v) {
    if (val < min) min = val;
    if (val > max) max = val;
  }
  const bound = Math.max(Math.abs(min), Math.abs(max), 1e-6);
  return { min: -bound, max: bound };
});

const heatmapOption = computed<Record<string, unknown>>(() => {
  const v = visual.value;
  const grid = v?.grid ?? 0;
  if (!grid || !heatmapData.value.length) return {};
  const { min, max } = heatmapMinMax.value;
  return {
    tooltip: {
      position: 'top',
      formatter: (p: { value: [number, number, number] }) => {
        const [r, c, val] = p.value;
        return `维度 ${r} × ${c}<br/>值: ${val.toFixed(4)}`;
      },
    },
    grid: { left: 40, right: 24, top: 8, bottom: 32 },
    xAxis: { type: 'category', data: Array.from({ length: grid }, (_, i) => i), splitArea: { show: true } },
    yAxis: { type: 'category', data: Array.from({ length: grid }, (_, i) => i), splitArea: { show: true } },
    visualMap: {
      min, max,
      calculable: true,
      orient: 'vertical',
      right: 0,
      top: 'center',
      inRange: { color: ['#313695', '#4575b4', '#74add1', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027'] },
    },
    series: [{
      type: 'heatmap',
      data: heatmapData.value,
      label: { show: false },
      emphasis: { itemStyle: { shadowBlur: 4, shadowColor: 'rgba(0,0,0,0.5)' } },
    }],
  };
});

/** 学习集中度标量 */
const visualScalars = computed(() => {
  const v = visual.value;
  if (!v) return null;
  return [
    { label: '对角偏差', value: v.diagDeviation?.toFixed(4) ?? '—' },
    { label: 'Frobenius', value: v.frobenius?.toFixed(3) ?? '—' },
    { label: '接近单位阵', value: v.identityRatio != null ? `${(v.identityRatio * 100).toFixed(1)}%` : '—' },
  ];
});
</script>

<template>
  <NCard title="关联矩阵 M · 热力网格" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!am"
      empty-text="暂无关联矩阵数据"
      error-text="关联矩阵请求失败"
      @retry="emit('retry')"
    >
      <template v-if="am?.available !== false">
        <div class="ratio-label">
          <span class="muted" style="font-size:var(--fs-caption)">热力网格（{{ visual?.grid ?? '—' }}×{{ visual?.grid ?? '—' }} 降采样）</span>
          <span v-if="visualLoading && !visual?.grid && !visualIsError" class="muted" style="font-size:var(--fs-caption)">加载中…</span>
        </div>

        <div v-if="visualIsError">
          <NEmpty description="热力网格加载失败" style="padding:8px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
          <NButton size="tiny" secondary @click="refetchVisual">重试</NButton>
        </div>
        <NEmpty v-else-if="!visual?.grid" description="暂无网格数据" style="padding:8px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
        <EChart v-else :option="heatmapOption" height="260px" aria-label="关联矩阵M降采样热力网格" />

        <div v-if="visualScalars && !visualIsError" class="scalars">
          <span v-for="s in visualScalars" :key="s.label" class="muted" style="font-size:var(--fs-caption)">
            {{ s.label }}: <span class="mono">{{ s.value }}</span>
          </span>
        </div>
      </template>

      <template v-else>
        <div class="muted" style="font-size:var(--fs-caption)">
          {{ am.reason ?? '关联矩阵未启用' }}。
        </div>
      </template>
    </CardState>
  </NCard>
</template>

<style scoped>
.ratio-label { display: flex; justify-content: space-between; margin-bottom: 2px; }
.scalars { display: flex; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
</style>