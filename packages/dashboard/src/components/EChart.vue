<script setup lang="ts">
/**
 * ECharts 通用封装组件。
 *
 * - 按需引入图表（Line/Bar/Gauge/Pie）+ 渲染器（Canvas）+ 组件（Grid/Tooltip/Legend/Title/DataZoom）
 * - autoresize 内部基于 ResizeObserver 实现响应式 resize
 * - 卸载时显式 dispose，避免 echarts 实例内存泄漏
 * - 转发 echarts click 事件（供 Graph 等交互图表使用）
 */
import { onBeforeUnmount, shallowRef } from 'vue';
import VChart from 'vue-echarts';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart, BarChart, GaugeChart, PieChart, ScatterChart, GraphChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
} from 'echarts/components';

// 按需注册 ECharts 模块（仅本仪表盘用到的图表与组件，避免全量引入）
use([
  CanvasRenderer,
  LineChart,
  BarChart,
  GaugeChart,
  PieChart,
  ScatterChart,
  GraphChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
]);

withDefaults(
  defineProps<{
    option: Record<string, unknown>;
    height?: string;
  }>(),
  { height: '300px' },
);

// 转发 echarts click 事件（节点点击等交互）
defineEmits<{ (e: 'click', payload: unknown): void }>();

// vue-echarts 实例引用（shallowRef 避免对组件实例做深响应式代理）
const chartRef = shallowRef<InstanceType<typeof VChart> | null>(null);

onBeforeUnmount(() => {
  // 卸载时释放 echarts 实例，避免内存泄漏
  chartRef.value?.dispose();
});
</script>

<template>
  <VChart
    ref="chartRef"
    :option="option"
    autoresize
    :style="{ width: '100%', height }"
    @click="(e: unknown) => $emit('click', e)"
  />
</template>
