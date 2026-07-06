<script setup lang="ts">
/**
 * MemoryGraphView —— 图谱可视化（ECharts Graph force layout）。
 *
 * - 节点大小按 pagerank 映射
 * - 节点颜色按 type 区分（categories）
 * - 点击节点高亮 + emit node-click(id)
 */
import { computed } from 'vue';
import { NSpin, NEmpty } from 'naive-ui';
import EChart from './EChart.vue';
import type { MemoryGraphResponse } from '../api/memory';
import { echartsThemeColors } from '../styles/theme';

const props = defineProps<{
  graph: MemoryGraphResponse | null | undefined;
  loading?: boolean;
  /** 当前选中节点 id（高亮） */
  selectedId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'node-click', id: string): void;
}>();

const hasNodes = computed(() => (props.graph?.nodes?.length ?? 0) > 0);

// ECharts Graph force layout 选项
const graphOption = computed(() => {
  const selId = props.selectedId ?? null;
  const nodes = (props.graph?.nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name || n.id,
    // 节点大小按 pagerank 映射（sqrt 缩放，避免大值过大）
    symbolSize: 15 + Math.min(45, Math.sqrt(n.pagerank ?? 0) * 25),
    category: n.type || 'UNKNOWN',
    value: n.pagerank ?? 0,
    // 选中节点高亮边框（用 warning 色，区别于分类色）
    itemStyle: n.id === selId ? { borderColor: echartsThemeColors[2], borderWidth: 3 } : undefined,
  }));
  const edges = (props.graph?.edges ?? []).map((e) => ({
    source: e.source,
    target: e.target,
    value: e.type,
  }));
  const categories = Array.from(
    new Set((props.graph?.nodes ?? []).map((n) => n.type || 'UNKNOWN')),
  ).map((c) => ({ name: c }));

  return {
    tooltip: {
      formatter: (p: { dataType: string; data?: { name?: string; value?: number; source?: string; target?: string } }) => {
        if (p.dataType === 'node') return `${p.data?.name ?? ''} (pagerank=${p.data?.value ?? 0})`;
        if (p.dataType === 'edge') return `${p.data?.source} → ${p.data?.target}`;
        return '';
      },
    },
    legend: [{ data: categories.map((c) => c.name) }],
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        label: { show: true, position: 'right' },
        force: { repulsion: 120, edgeLength: 80, gravity: 0.1 },
        categories,
        data: nodes,
        links: edges,
        lineStyle: { color: 'source', curveness: 0.1 },
        emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
      },
    ],
  };
});

/** ECharts click 事件 → 提取节点 id 并 emit */
function handleClick(payload: unknown): void {
  const p = payload as { dataType?: string; data?: { id?: string } };
  if (p?.dataType === 'node' && p?.data?.id) {
    emit('node-click', p.data.id);
  }
}
</script>

<template>
  <NSpin v-if="props.loading" size="small">
    <template #default>加载图谱中…</template>
  </NSpin>
  <EChart
    v-else-if="hasNodes"
    :option="graphOption"
    height="480px"
    @click="handleClick"
  />
  <NEmpty v-else description="无图谱节点" />
</template>
