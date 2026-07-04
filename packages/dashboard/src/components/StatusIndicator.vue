<script setup lang="ts">
/**
 * 状态指示灯：熔断器 / 连接状态可视化。
 *
 * - available=true 绿灯，false 红灯
 * - 显示 failures 失败计数（NTag 颜色随状态变化）
 */
import { NTag } from 'naive-ui';

defineProps<{
  label: string;
  available: boolean;
  failures: number;
}>();
</script>

<template>
  <div class="status-indicator">
    <span class="dot" :class="available ? 'dot-ok' : 'dot-fail'" />
    <span class="status-label">{{ label }}</span>
    <NTag v-if="available && failures === 0" size="small" type="success">正常</NTag>
    <NTag v-else-if="available" size="small" type="warning">失败 {{ failures }}</NTag>
    <NTag v-else size="small" type="error">熔断 (失败 {{ failures }})</NTag>
  </div>
</template>

<style scoped>
.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.dot-ok {
  background: #18a058;
  box-shadow: 0 0 4px rgba(24, 160, 88, 0.6);
}
.dot-fail {
  background: #d03050;
  box-shadow: 0 0 4px rgba(208, 48, 80, 0.6);
}
.status-label {
  font-size: 14px;
  flex: 1;
}
</style>
