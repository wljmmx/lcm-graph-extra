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
import { useBreakpoints } from '../composables/useBreakpoints';
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

// L2 修复：具名常量（替代魔法数字）
const NODE_BASE_SIZE = 15;
const NODE_SIZE_MULTIPLIER = 25;
const NODE_SIZE_MAX = 45;
const FORCE_REPULSION = 120;
const FORCE_EDGE_LENGTH = 80;
const FORCE_GRAVITY = 0.1;
const CHART_HEIGHT_DESKTOP = '480px';
const CHART_HEIGHT_MOBILE = '360px';

// L2 修复：响应式高度
const breakpoints = useBreakpoints({ xs: 0, s: 640, m: 768, l: 1024, xl: 1280 });
const isNarrowScreen = breakpoints.smaller('m');
const chartHeight = computed(() =>
  isNarrowScreen.value ? CHART_HEIGHT_MOBILE : CHART_HEIGHT_DESKTOP,
);

const hasNodes = computed(() => (props.graph?.nodes?.length ?? 0) > 0);

// ECharts Graph force layout 选项
const graphOption = computed(() => {
  const selId = props.selectedId ?? null;
  const nodes = (props.graph?.nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name || n.id,
    // 节点大小按 pagerank 映射（sqrt 缩放，避免大值过大）
    symbolSize: NODE_BASE_SIZE + Math.min(NODE_SIZE_MAX, Math.sqrt(n.pagerank ?? 0) * NODE_SIZE_MULTIPLIER),
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
        force: { repulsion: FORCE_REPULSION, edgeLength: FORCE_EDGE_LENGTH, gravity: FORCE_GRAVITY },
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
    :height="chartHeight"
    @click="handleClick"
  />
  <NEmpty v-else description="无图谱节点" />
</template>
