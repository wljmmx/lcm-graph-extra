<script setup lang="ts">
import { computed } from 'vue';
import { NCard } from 'naive-ui';
import CardState from './CardState.vue';
import EChart from '../EChart.vue';
import { useTheme } from '../../composables/useTheme';

const props = defineProps<{
  nodes: any[];
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{
  retry: [];
  'node-click': [id: string];
}>();

const { isDark } = useTheme();

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
      // 携带 nodeId 以支持点击回传（echarts click 事件的 payload.data 即此对象）
      data: nodes.map((n: any) => ({ value: n.pagerank ?? 0, nodeId: n.id })).reverse(),
      barWidth: 14,
      itemStyle: {
        borderRadius: [0, 3, 3, 0],
        color: isDark.value ? '#4098fc' : '#2080f0',
      },
    }],
  };
});

function onChartClick(payload: any) {
  const nodeId = payload?.data?.nodeId;
  if (nodeId != null) emit('node-click', String(nodeId));
}
</script>

<template>
  <NCard title="Top 10 PageRank" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="nodes.length > 0"
      empty-text="暂无 Top 节点数据"
      error-text="Top 节点请求失败"
      empty-hint="请确认 graph-memory-pro 服务已启动。"
      @retry="emit('retry')"
    >
      <EChart
        v-if="top10ChartOption"
        :option="top10ChartOption"
        :height="240"
        aria-label="Top 10 PageRank 图表"
        @click="onChartClick"
      />
    </CardState>
  </NCard>
</template>
