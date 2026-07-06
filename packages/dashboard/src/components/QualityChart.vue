<script setup lang="ts">
/**
 * QualityChart —— 质量分折线图（含完整时序与 source 标记）。
 *
 * - props.points 为 qualityScore 历史点序列（含 delta / source）
 * - X 轴 timestamp（格式化为 MM-dd HH:mm），Y 轴 qualityScore [0,1]
 * - 单点时显示为散点（避免折线退化为不可见）
 * - gm-pro 来源用绿色，local 用蓝色（视觉区分）
 * - tooltip 显示 delta（质量变化方向）
 */
import { computed } from 'vue';
import EChart from './EChart.vue';
import type { QualityHistoryPoint } from '../api/experience';
import { echartsThemeColors } from '../styles/theme';

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
  ) as Array<{
    qualityScore: number;
    timestamp: number;
    delta?: number | null;
    source?: 'gm-pro' | 'local' | null;
  }>,
);

const xLabels = computed(() =>
  validPoints.value.map((p) => formatTs(p.timestamp)),
);

// 系列数据：gm-pro 点（绿色）与 local 点（蓝色）分开渲染
const gmProPoints = computed(() =>
  validPoints.value.map((p) =>
    p.source === 'gm-pro' ? p.qualityScore : null,
  ),
);

const localPoints = computed(() =>
  validPoints.value.map((p) =>
    p.source !== 'gm-pro' ? p.qualityScore : null,
  ),
);

// tooltip formatter：显示 score / delta / source
const tooltipFormatter = (params: any): string => {
  if (!Array.isArray(params) || params.length === 0) return '';
  const idx = params[0].dataIndex;
  const p = validPoints.value[idx];
  if (!p) return '';
  const deltaStr =
    p.delta != null
      ? p.delta >= 0
        ? `+${p.delta.toFixed(2)}`
        : p.delta.toFixed(2)
      : '—';
  const sourceStr = p.source ?? 'local';
  return `${formatTs(p.timestamp)}<br/>score: ${p.qualityScore.toFixed(2)}<br/>delta: ${deltaStr}<br/>source: ${sourceStr}`;
};

function formatTs(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

const option = computed(() => ({
  tooltip: {
    trigger: 'axis',
    formatter: tooltipFormatter,
  },
  legend: {
    data: ['gm-pro', 'local'],
    top: 0,
    textStyle: { fontSize: 11 },
  },
  grid: { left: 40, right: 16, top: 32, bottom: 32 },
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
      name: 'gm-pro',
      type: validPoints.value.length > 1 ? 'line' : 'scatter',
      smooth: true,
      symbol: 'circle',
      symbolSize: 8,
      data: gmProPoints.value,
      connectNulls: true,
      lineStyle: { width: 2, color: echartsThemeColors[1] }, // success 绿
      itemStyle: { color: echartsThemeColors[1] },
    },
    {
      name: 'local',
      type: validPoints.value.length > 1 ? 'line' : 'scatter',
      smooth: true,
      symbol: 'circle',
      symbolSize: 8,
      data: localPoints.value,
      connectNulls: true,
      lineStyle: { width: 2, color: echartsThemeColors[0] }, // primary 蓝
      itemStyle: { color: echartsThemeColors[0] },
    },
  ],
}));
</script>

<template>
  <EChart :option="option" :height="height" />
</template>
