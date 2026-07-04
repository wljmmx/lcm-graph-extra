<script setup lang="ts">
/**
 * QualityChart —— 质量分 mini 折线图。
 *
 * - props.points 为 qualityScore 历史点序列
 * - X 轴 timestamp（格式化为 MM-dd HH:mm），Y 轴 qualityScore [0,1]
 * - 单点时显示为散点（避免折线退化为不可见）
 */
import { computed } from 'vue';
import EChart from './EChart.vue';
import type { QualityHistoryPoint } from '../api/experience';

const props = withDefaults(
  defineProps<{
    points: QualityHistoryPoint[];
    height?: string;
  }>(),
  { height: '200px' },
);

// 过滤掉 qualityScore / timestamp 为 null 的点（无法绘制）
const validPoints = computed(() =>
  (props.points ?? []).filter(
    (p) => p.qualityScore !== null && p.timestamp !== null,
  ) as Array<{ qualityScore: number; timestamp: number }>,
);

const xLabels = computed(() =>
  validPoints.value.map((p) => formatTs(p.timestamp)),
);

const yValues = computed(() => validPoints.value.map((p) => p.qualityScore));

function formatTs(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

const option = computed(() => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 40, right: 16, top: 24, bottom: 32 },
  xAxis: {
    type: 'category',
    data: xLabels.value,
    boundaryGap: false,
  },
  yAxis: {
    type: 'value',
    name: 'qualityScore',
    min: 0,
    max: 1,
  },
  series: [
    {
      name: 'qualityScore',
      type: validPoints.value.length > 1 ? 'line' : 'scatter',
      smooth: true,
      symbol: 'circle',
      symbolSize: 8,
      data: yValues.value,
      lineStyle: { width: 2 },
      itemStyle: { color: '#2080f0' },
    },
  ],
}));
</script>

<template>
  <EChart :option="option" :height="height" />
</template>
