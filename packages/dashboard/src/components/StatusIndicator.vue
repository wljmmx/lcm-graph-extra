<script setup lang="ts">
/**
 * 状态指示灯：熔断器 / 连接状态可视化。
 *
 * - available=true 绿灯（圆形 + ✓），false 红灯（方块 + ✗）
 * - 形状 + 符号双重区分，色盲用户也能识别（不依赖颜色单一信号）
 * - 显示 failures 失败计数（NTag 颜色随状态变化）
 * - 颜色由 CSS 变量驱动，支持暗色模式自动适配
 * - role="status" + aria-label 暴露语义给屏幕阅读器
 */
import { computed } from 'vue';
import { NTag } from 'naive-ui';

const props = defineProps<{
  label: string;
  available: boolean;
  failures: number;
}>();

// 状态语义：正常 / 故障中（仍有失败计数）/ 已熔断
const stateKind = computed<'ok' | 'warning' | 'fail'>(() => {
  if (!props.available) return 'fail';
  if (props.failures > 0) return 'warning';
  return 'ok';
});

// 屏幕阅读器文案
const ariaLabel = computed(() => {
  switch (stateKind.value) {
    case 'ok':       return `${props.label}：正常`;
    case 'warning':  return `${props.label}：可用，但失败 ${props.failures} 次`;
    case 'fail':     return `${props.label}：已熔断，失败 ${props.failures} 次`;
  }
});

// 形状 class：ok/warning 用圆形，fail 用方块
const shapeClass = computed(() =>
  stateKind.value === 'fail' ? 'shape-square' : 'shape-circle',
);

// 符号：ok=✓ / warning=! / fail=✗
const symbol = computed(() => {
  switch (stateKind.value) {
    case 'ok':       return '✓';
    case 'warning':  return '!';
    case 'fail':     return '✗';
  }
});
</script>

<template>
  <div
    class="status-indicator"
    role="status"
    :aria-label="ariaLabel"
  >
    <span
      class="dot"
      :class="[`dot-${stateKind}`, shapeClass]"
      aria-hidden="true"
    >{{ symbol }}</span>
    <span class="status-label">{{ label }}</span>
    <NTag v-if="stateKind === 'ok'" size="small" type="success">正常</NTag>
    <NTag v-else-if="stateKind === 'warning'" size="small" type="warning">失败 {{ failures }}</NTag>
    <NTag v-else size="small" type="error">熔断 (失败 {{ failures }})</NTag>
  </div>
</template>

<style scoped>
.status-indicator {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) 0;
}
.dot {
  /* 尺寸固定，符号居中 */
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: var(--fs-caption);
  font-weight: 700;
  line-height: 1;
  color: #fff;
}
.shape-circle {
  border-radius: var(--radius-full);
}
.shape-square {
  border-radius: var(--radius-sm);
}
/* 颜色由 token 驱动，自动适配暗色模式 */
.dot-ok {
  background: var(--color-success);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-success) 60%, transparent);
}
.dot-warning {
  background: var(--color-warning);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-warning) 60%, transparent);
}
.dot-fail {
  background: var(--color-danger);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-danger) 60%, transparent);
}
.status-label {
  font-size: var(--fs-body);
  flex: 1;
}
</style>
