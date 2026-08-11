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
import { computed, onBeforeUnmount, shallowRef, watch, nextTick } from 'vue';
import VChart from 'vue-echarts';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart, BarChart, GaugeChart, PieChart, ScatterChart, GraphChart, HeatmapChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  VisualMapComponent,
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
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  VisualMapComponent,
]);

const props = withDefaults(
  defineProps<{
    option: Record<string, unknown>;
    height?: string;
    /** 跳过主题注入（少数图表如 Graph 自定义颜色时使用） */
    skipTheme?: boolean;
    /** UX-11: 无障碍 aria-label，描述图表内容 */
    ariaLabel?: string;
  }>(),
  { height: '300px', skipTheme: false, ariaLabel: '' },
);

// 转发 echarts click 事件（节点点击等交互）
defineEmits<{ (e: 'click', payload: unknown): void }>();

// 主题感知：暗色模式下切换调色板 + base option
const { isDark } = useTheme();

// 合并主题调色板 + 基础样式（坐标轴/tooltip/legend）
// 业务 option 优先级更高：若 opt.color 已声明则保留，否则用主题调色板
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

/**
 * 强制隐藏 echarts loading 动画。
 * vue-echarts / echarts 在某些边缘情况（空 option → 有数据 option 过渡、
 * autoresize 触发重绘、setOption 引用反复变更等）下可能残留内部 loading 态，
 * 表现为"网格已显示但上方/中心仍转圈"。显式调用 hideLoading() 彻底兜底。
 */
function ensureHideLoading(): void {
  const inst = chartRef.value?.getEchartsInstance?.();
  if (inst && typeof inst.hideLoading === 'function') {
    try { inst.hideLoading(); } catch { /* noop */ }
  }
}

// L12 修复：内置空态检测（series.data 全空时显示 NEmpty，替代空白画布）
// v2.5.1 加强：原始 option 为空对象 / 无 series / series 为空数组 → 一律视为无数据，
// 避免渲染 VChart 空画布导致其内部 loading 动画残留（"转圈但数据已显示"问题）。
const hasData = computed(() => {
  const opt = props.option;
  // 空对象：无任何可视化配置（如热力图 computed 在首次加载前返回 {}）
  if (!opt || typeof opt !== 'object') return false;
  const keys = Object.keys(opt);
  if (keys.length === 0) return false;
  const series = opt.series as Array<Record<string, unknown>> | undefined;
  // 无 series：没有可渲染的图形系列
  if (!series || !Array.isArray(series)) return false;
  if (series.length === 0) return false;
  return series.some((s) => {
    // graph 图：数据在 nodes/links 而非 data
    if (s.type === 'graph') {
      const nodes = s.nodes as unknown[] | undefined;
      if (Array.isArray(nodes) && nodes.length > 0) return true;
      return (s.data as unknown[] | undefined)?.length != null; // graph 也可能把 data 与 nodes 混用
    }
    const data = s.data;
    if (Array.isArray(data)) return data.length > 0;
    // 非数组 data（pie name-value 对象等）视为有数据
    return data != null;
  });
});

// mergedOption 变更后（数据到达）：强制关闭 loading 动画，避免残留
watch(mergedOption, () => {
  nextTick(() => ensureHideLoading());
}, { flush: 'post' });

// VChart 挂载完成后也跑一次，兜底首帧动画
function onChartReady(): void {
  nextTick(() => ensureHideLoading());
}

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
    :loading="false"
    autoresize
    :style="{ width: '100%', height }"
    :aria-label="ariaLabel || undefined"
    role="img"
    @click="(e: unknown) => $emit('click', e)"
    @ready="onChartReady"
  />
</template>
