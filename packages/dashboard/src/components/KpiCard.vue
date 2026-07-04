<script setup lang="ts">
/**
 * KPI 卡片：NCard + NStatistic 组合。
 *
 * - value 超过 threshold 时以 error 色彩高亮
 * - 可选 trend 趋势值（正向上箭头红/负向下箭头绿/持平灰）
 */
import { computed } from 'vue';
import { NCard, NStatistic } from 'naive-ui';

const props = withDefaults(
  defineProps<{
    label: string;
    value: number | string;
    unit?: string;
    threshold?: number;
    trend?: number;
  }>(),
  {},
);

// 仅当 value 为数字且超过阈值时判定为超限（变红）
const overThreshold = computed(
  () =>
    props.threshold !== undefined &&
    typeof props.value === 'number' &&
    props.value > props.threshold,
);

const valueColor = computed(() => (overThreshold.value ? '#d03050' : undefined));

// 趋势箭头颜色：上升红 / 下降绿 / 持平灰
const trendColor = computed(() => {
  if (props.trend === undefined) return '#909399';
  if (props.trend > 0) return '#d03050';
  if (props.trend < 0) return '#18a058';
  return '#909399';
});
const trendArrow = computed(() => {
  if (props.trend === undefined) return '';
  if (props.trend > 0) return '↑';
  if (props.trend < 0) return '↓';
  return '→';
});
</script>

<template>
  <NCard size="small" :bordered="true">
    <NStatistic :label="label" :tabular-nums="true">
      <template #default>
        <span :style="{ color: valueColor, fontSize: '26px', fontWeight: 600 }">
          {{ value
          }}<span v-if="unit" style="font-size: 14px; margin-left: 4px; font-weight: 400">{{ unit }}</span>
        </span>
      </template>
      <template v-if="trend !== undefined" #suffix>
        <span :style="{ fontSize: '12px', color: trendColor }">
          {{ trendArrow }}{{ Math.abs(trend) }}
        </span>
      </template>
    </NStatistic>
  </NCard>
</template>
