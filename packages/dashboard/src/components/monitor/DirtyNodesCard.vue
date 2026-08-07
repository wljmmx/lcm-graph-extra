<script setup lang="ts">
import { NCard, NTag } from 'naive-ui';
import CardState from './CardState.vue';

defineProps<{
  dirty: any | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <NCard title="增量维护（脏节点）" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!dirty"
      empty-text="暂无脏节点数据"
      error-text="脏节点请求失败"
      empty-hint="请确认 graph-memory-pro 服务已启动。"
      @retry="emit('retry')"
    >
      <div style="display:flex;align-items:center;gap:8px">
        <NTag :type="(dirty.count ?? 0) > 0 ? 'warning' : 'success'" size="small">
          脏节点: {{ dirty.count ?? 0 }} 个
        </NTag>
        <span
          v-if="(dirty.nodeIds as string[])?.length"
          class="muted"
          style="font-size:var(--fs-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        >
          {{ (dirty.nodeIds as string[]).slice(0, 3).join(', ') }}{{ (dirty.nodeIds as string[]).length > 3 ? '…' : '' }}
        </span>
      </div>
    </CardState>
  </NCard>
</template>
