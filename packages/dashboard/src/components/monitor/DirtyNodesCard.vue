<script setup lang="ts">
import { NCard, NTag, NEmpty } from 'naive-ui';

defineProps<{
  dirty: any | null;
}>();
</script>

<template>
  <NCard title="增量维护（脏节点）" size="small">
    <template v-if="dirty">
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
    </template>
    <NEmpty v-else description="暂无脏节点数据" style="padding:12px 0" />
  </NCard>
</template>