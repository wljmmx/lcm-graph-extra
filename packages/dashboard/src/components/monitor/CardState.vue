<script setup lang="ts">
/**
 * 卡片三态统一组件：loading → skeleton，error → alert+retry，empty → empty+hint。
 *
 * 统一空状态文案规范：
 *   - 无数据：「暂无 XXX 数据」
 *   - 请求失败：「XXX 请求失败」
 *   - 服务不可达：「XXX 不可达，请确认…」
 */
import { NSkeleton, NAlert, NButton, NEmpty } from 'naive-ui';

const props = withDefaults(defineProps<{
  /** 是否加载中（首次加载，无缓存） */
  loading?: boolean;
  /** 请求是否出错 */
  isError?: boolean;
  /** 是否有数据（false = 空数据） */
  hasData: boolean;
  /** 空数据时显示的文案 */
  emptyText?: string;
  /** 错误时显示的文案 */
  errorText?: string;
  /** 错误详情（透出代理/后端返回的真实错误，便于定位根因） */
  errorDetail?: string;
  /** 空数据时的额外提示 */
  emptyHint?: string;
  /** 骨架屏行数 */
  skeletonRows?: number;
}>(), {
  loading: false,
  isError: false,
  emptyText: '暂无数据',
  errorText: '请求失败',
  skeletonRows: 3,
});

const emit = defineEmits<{
  retry: [];
}>();
</script>

<template>
  <!-- 加载中（仅首次加载无数据时显示骨架屏） -->
  <div v-if="loading && !hasData" class="card-skeleton">
    <NSkeleton v-for="i in skeletonRows" :key="i" text :repeat="2" style="margin-bottom: 8px" />
  </div>

  <!-- 请求失败 -->
  <NAlert
    v-else-if="isError && !hasData"
    type="error"
    :title="errorText"
    :show-icon="true"
    style="margin: 8px 0"
  >
    <template #action>
      <NButton size="tiny" @click="emit('retry')">重试</NButton>
    </template>
    <span style="font-size: var(--fs-caption)">请检查 gm-pro 服务是否可达（端口 7850）。</span>
    <div v-if="errorDetail" class="error-detail mono">{{ errorDetail }}</div>
  </NAlert>

  <!-- 空数据 -->
  <NEmpty v-else-if="!hasData" :description="emptyText" style="padding: 12px 0">
    <template v-if="emptyHint" #extra>
      <span class="muted" style="font-size: var(--fs-caption)">{{ emptyHint }}</span>
    </template>
  </NEmpty>

  <!-- 有数据 → 渲染默认插槽 -->
  <slot v-else />
</template>

<style scoped>
.card-skeleton {
  padding: 8px 0;
}
.error-detail {
  margin-top: 6px;
  font-size: var(--fs-caption);
  color: var(--color-error);
  word-break: break-all;
}
</style>
