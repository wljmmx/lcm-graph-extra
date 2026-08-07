<script setup lang="ts">
import { ref, computed } from 'vue';
import { NCard, NTag, NPagination } from 'naive-ui';
import CardState from './CardState.vue';
import type { GmProCommunitySummary } from '../../api/gm-pro';

const props = defineProps<{
  communities: GmProCommunitySummary[];
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

const PAGE_SIZE = 10;
const page = ref(1);

const paginatedCommunities = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return props.communities.slice(start, start + PAGE_SIZE);
});
</script>

<template>
  <NCard title="社区概览" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="communities.length > 0"
      empty-text="暂无社区数据"
      error-text="社区数据请求失败"
      empty-hint="请确认 graph-memory-pro 服务已启动。"
      @retry="emit('retry')"
    >
      <div class="community-list">
        <div
          v-for="c in paginatedCommunities"
          :key="c.communityId"
          class="community-row"
        >
          <span
            class="mono community-id"
            :title="c.communityId"
          >{{ c.communityId.length > 12 ? c.communityId.slice(0, 12) + '…' : c.communityId }}</span>
          <NTag size="tiny" :bordered="false">{{ c.memberCount }} 成员</NTag>
          <span class="community-summary">{{ c.summary?.slice(0, 80) }}{{ c.summary?.length > 80 ? '…' : '' }}</span>
        </div>
      </div>
      <div v-if="communities.length > PAGE_SIZE" class="pagination-row">
        <NPagination
          v-model:page="page"
          :item-count="communities.length"
          :page-size="PAGE_SIZE"
          size="small"
        />
      </div>
    </CardState>
  </NCard>
</template>

<style scoped>
.community-list {
  max-height: 260px;
  overflow-y: auto;
}
.community-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--color-border-subtle);
}
.community-id {
  font-size: 11px;
  min-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.community-summary {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.pagination-row {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
}
</style>
