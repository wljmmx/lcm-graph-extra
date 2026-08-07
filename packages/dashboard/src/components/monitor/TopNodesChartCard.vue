<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NEmpty } from 'naive-ui';
import EChart from '../EChart.vue';
import { useTheme } from '../../composables/useTheme';

const props = defineProps<{
  nodes: any[];
}>();

const { isDark } = useTheme();

const CHART = computed(() => ({
  primary: isDark.value ? '#4098fc' : '#2080f0',
  success: isDark.value ? '#36ad6a' : '#18a058',
  warning: isDark.value ? '#fcb040' : '#f0a020',
  danger:  isDark.value ? '#de5169' : '#d03050',
  info:    isDark.value ? '#9270ed' : '#7c3aed',
  neutral: isDark.value ? '#a8abb2' : '#909399',
}));

const top10ChartOption = computed(() => {
  const nodes = props.nodes;
  if (!nodes.length) return null;
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    grid: { left: 12, right: 24, top: 8, bottom: 4, containLabel: true },
    xAxis: {
      type: 'value' as const,
      axisLabel: { fontSize: 10, color: isDark.value ? '#aaa' : '#666' },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category' as const,
      data: nodes.map((n: any) => n.name?.slice(0, 20) ?? n.id?.slice(0, 12) ?? '—').reverse(),
      axisLabel: { fontSize: 10, color: isDark.value ? '#ccc' : '#333' },
      inverse: true,
    },
    series: [{
      type: 'bar',
      data: nodes.map((n: any) => n.pagerank ?? 0).reverse(),
      barWidth: 14,
      itemStyle: {
        borderRadius: [0, 3, 3, 0],
        color: CHART.value.primary,
      },
    }],
  };
});
</script>

<template>
  <NCard title="Top 10 PageRank" size="small">
    <template v-if="nodes.length">
      <EChart v-if="top10ChartOption" :option="top10ChartOption" :height="240" />
      <NEmpty v-else description="无图表数据" style="padding:8px 0" />
    </template>
    <NEmpty v-else description="无 Top 节点数据" style="padding:12px 0" />
  </NCard>
</template>