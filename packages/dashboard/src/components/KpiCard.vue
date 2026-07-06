<script setup lang="ts">
/**
 * KPI 卡片：NCard + NStatistic 组合。
 *
 * - loading=true 时显示 NSkeleton 骨架占位
 * - value 超过 threshold 时以 danger 色高亮（CSS 变量驱动）
 * - 可选 trend 趋势值（正→↑红/负→↓绿/持平→→灰）
 * - 数字 value 触发 count-up 动画（requestAnimationFrame，600ms）
 */
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { NCard, NStatistic, NSkeleton } from 'naive-ui';

const props = withDefaults(
  defineProps<{
    label: string;
    value: number | string;
    unit?: string;
    threshold?: number;
    trend?: number;
    /** 骨架屏：loading=true 时显示占位 */
    loading?: boolean;
  }>(),
  { loading: false },
);

// 仅当 value 为数字且超过阈值时判定为超限（变红）
const overThreshold = computed(
  () =>
    props.threshold !== undefined &&
    typeof props.value === 'number' &&
    props.value > props.threshold,
);

// 颜色由 CSS 变量驱动（与 tokens.css 对齐）
const valueColor = computed(() =>
  overThreshold.value ? 'var(--color-danger)' : undefined,
);

// 趋势箭头颜色：上升红 / 下降绿 / 持平灰
const trendColor = computed(() => {
  if (props.trend === undefined) return 'var(--color-text-secondary)';
  if (props.trend > 0) return 'var(--color-danger)';
  if (props.trend < 0) return 'var(--color-success)';
  return 'var(--color-text-secondary)';
});
const trendArrow = computed(() => {
  if (props.trend === undefined) return '';
  if (props.trend > 0) return '↑';
  if (props.trend < 0) return '↓';
  return '→';
});

// ===== count-up 数字动画 =====
// 仅对数字 value 启动：从 displayed 平滑过渡到 target，~600ms。
const displayedValue = ref<number>(0);
let rafId: number | null = null;
const ANIM_MS = 600;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function animateTo(target: number): void {
  if (typeof window === 'undefined' || !('requestAnimationFrame' in window)) {
    displayedValue.value = target;
    return;
  }
  const from = displayedValue.value;
  const delta = target - from;
  if (Math.abs(delta) < 0.01) {
    displayedValue.value = target;
    return;
  }
  const start = performance.now();
  if (rafId !== null) cancelAnimationFrame(rafId);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ANIM_MS);
    displayedValue.value = from + delta * easeOutCubic(t);
    if (t < 1) {
      rafId = requestAnimationFrame(step);
    } else {
      displayedValue.value = target;
      rafId = null;
    }
  };
  rafId = requestAnimationFrame(step);
}

// 监听 value 变化：数字则启动动画，字符串则跳过
watch(
  () => props.value,
  (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) animateTo(v);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
});

// 展示值：数字用动画后的值（按需保留小数），字符串原样返回
const displayValue = computed(() => {
  if (typeof props.value !== 'number') return props.value;
  // 整数场景：取整避免动画过程中出现小数闪烁
  return Number.isInteger(props.value)
    ? Math.round(displayedValue.value).toString()
    : displayedValue.value.toFixed(2);
});
</script>

<template>
  <NCard size="small" :bordered="true">
    <!-- 骨架屏占位 -->
    <template v-if="loading">
      <NSkeleton text :repeat="2" />
    </template>

    <NStatistic v-else :label="label" :tabular-nums="true">
      <template #default>
        <span
          :style="{
            color: valueColor,
            fontSize: 'var(--fs-display)',
            fontWeight: 600,
          }"
        >{{ displayValue
        }}<span
          v-if="unit"
          style="font-size: var(--fs-body); margin-left: var(--space-xs); font-weight: 400"
        >{{ unit }}</span></span>
      </template>
      <template v-if="trend !== undefined" #suffix>
        <span :style="{ fontSize: 'var(--fs-caption)', color: trendColor }">
          {{ trendArrow }}{{ Math.abs(trend) }}
        </span>
      </template>
    </NStatistic>
  </NCard>
</template>
