<script setup lang="ts">
/**
 * 状态指示灯：熔断器 / 连接状态可视化。
 *
 * - mode="circuit-breaker"（默认）：熔断器语义 — 正常/降级/熔断
 * - mode="connection"：连接状态语义 — 已连接/未连接
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
  mode?: 'circuit-breaker' | 'connection';
}>();

const mode = computed(() => props.mode ?? 'circuit-breaker');

const stateKind = computed<'ok' | 'warning' | 'fail'>(() => {
  if (!props.available) return 'fail';
  if (props.failures > 0) return 'warning';
  return 'ok';
});

const ariaLabel = computed(() => {
  if (mode.value === 'connection') {
    return props.available
      ? `${props.label}：已连接${props.failures > 0 ? `，历史失败 ${props.failures} 次` : ''}`
      : `${props.label}：未连接${props.failures > 0 ? `，失败 ${props.failures} 次` : ''}`;
  }
  switch (stateKind.value) {
    case 'ok':       return `${props.label}：正常`;
    case 'warning':  return `${props.label}：可用，但失败 ${props.failures} 次`;
    case 'fail':     return `${props.label}：已熔断，失败 ${props.failures} 次`;
  }
});

const shapeClass = computed(() =>
  stateKind.value === 'fail' ? 'shape-square' : 'shape-circle',
);

const symbol = computed(() => {
  switch (stateKind.value) {
    case 'ok':       return '✓';
    case 'warning':  return '!';
    case 'fail':     return '✗';
  }
});

const tagType = computed(() => {
  if (stateKind.value === 'ok') return 'success';
  if (stateKind.value === 'warning') return 'warning';
  return 'error';
});

const tagText = computed(() => {
  if (mode.value === 'connection') {
    if (props.available) return '已连接';
    return '未连接';
  }
  if (stateKind.value === 'ok') return '正常';
  if (stateKind.value === 'warning') return `失败 ${props.failures}`;
  return `熔断 (失败 ${props.failures})`;
});

const showFailureCount = computed(() => {
  if (mode.value === 'connection' && props.available && props.failures > 0) return true;
  return mode.value === 'circuit-breaker';
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
    <NTag size="small" :type="tagType">{{ tagText }}</NTag>
    <NTag
      v-if="showFailureCount && mode === 'connection' && failures > 0"
      size="small"
      type="default"
      class="failures-tag"
    >历史失败 {{ failures }}</NTag>
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
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: var(--fs-caption);
  font-weight: 700;
  line-height: 1;
  color: var(--color-surface);
}
.dot.dot-warning {
  color: var(--color-text-primary);
}
.shape-circle {
  border-radius: var(--radius-full);
}
.shape-square {
  border-radius: var(--radius-sm);
}
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
.failures-tag {
  opacity: 0.7;
}
</style>
