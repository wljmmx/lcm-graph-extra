<script setup lang="ts">
/**
 * ECharts 通用封装组件。
 *
 * - 按需引入图表（Line/Bar/Gauge/Pie）+ 渲染器（Canvas）+ 组件（Grid/Tooltip/Legend/Title/DataZoom）
 * - autoresize 内部基于 ResizeObserver 实现响应式 resize
 * - 卸载时显式 dispose，避免 echarts 实例内存泄漏
 * - 转发 echarts click 事件（供 Graph 等交互图表使用）
 *
 * 主题（S4-1）：
 *   自动注入 echartsThemeColors 调色板 + echartsBaseOption（坐标轴/tooltip/legend 样式），
 *   各业务图表无需手动配置 color 即可获得与 naive-ui 对齐的视觉。
 *   通过 :option 传入的 series/legend 等会与默认调色板深合并（option.color 优先级更高）。
 */
import { computed, onBeforeUnmount, shallowRef } from 'vue';
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
import { NEmpty } from 'naive-ui';
import {
  echartsThemeColors,
  echartsDarkThemeColors,
  echartsBaseOption,
  echartsDarkBaseOption,
} from '../styles/theme';
import { useTheme } from '../composables/useTheme';

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

const props = withDefaults(
  defineProps<{
    option: Record<string, unknown>;
    height?: string;
    /** 跳过主题注入（少数图表如 Graph 自定义颜色时使用） */
    skipTheme?: boolean;
  }>(),
  { height: '300px', skipTheme: false },
);

// 转发 echarts click 事件（节点点击等交互）
defineEmits<{ (e: 'click', payload: unknown): void }>();

// 主题感知：暗色模式下切换调色板 + base option
const { isDark } = useTheme();

// 合并主题调色板 + 基础样式（坐标轴/tooltip/legend）
// 业务 option 优先级更高：若 option 已声明 color，则保留业务调色板
const mergedOption = computed<Record<string, unknown>>(() => {
  if (props.skipTheme) return props.option;
  const opt = props.option;
  const colors = isDark.value ? echartsDarkThemeColors : echartsThemeColors;
  const baseOption = isDark.value ? echartsDarkBaseOption : echartsBaseOption;
  return {
    ...baseOption,
    ...opt,
    // color 放最后：若 opt.color 已定义则保留，否则用主题调色板
    color: Array.isArray(opt.color) ? opt.color : colors,
  } as Record<string, unknown>;
});

// vue-echarts 实例引用（shallowRef 避免对组件实例做深响应式代理）
const chartRef = shallowRef<InstanceType<typeof VChart> | null>(null);

// L12 修复：内置空态检测（series.data 全空时显示 NEmpty，替代空白画布）
const hasData = computed(() => {
  const opt = props.option;
  const series = opt.series as Array<Record<string, unknown>> | undefined;
  if (!series || !Array.isArray(series)) return true;
  return series.some((s) => {
    const data = s.data;
    if (Array.isArray(data)) return data.length > 0;
    return true; // 非数组 data（如 graph 节点）默认有数据
  });
});

onBeforeUnmount(() => {
  // 卸载时释放 echarts 实例，避免内存泄漏
  chartRef.value?.dispose();
});
</script>

<template>
  <!-- L12 修复：无数据时显示空态，替代空白画布 -->
  <NEmpty
    v-if="!hasData"
    description="无数据"
    :style="{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }"
  />
  <VChart
    v-else
    ref="chartRef"
    :option="mergedOption"
    autoresize
    :style="{ width: '100%', height }"
    @click="(e: unknown) => $emit('click', e)"
  />
</template>
