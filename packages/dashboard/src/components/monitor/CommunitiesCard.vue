<script setup lang="ts">
import { NCard, NTag, NEmpty } from 'naive-ui';
import type { GmProCommunitySummary } from '../../api/gm-pro';

defineProps<{
  communities: GmProCommunitySummary[];
}>();
</script>

<template>
  <NCard title="社区概览" size="small">
    <template v-if="communities.length">
      <div class="community-list">
        <div
          v-for="c in communities.slice(0, 10)"
          :key="c.communityId"
          class="community-row"
        >
          <span
            class="mono community-id"
            :title="c.communityId"
          >{{ c.communityId.slice(0, 12) + '…' }}</span>
          <NTag size="tiny" :bordered="false">{{ c.memberCount }} 成员</NTag>
          <span class="community-summary">{{ c.summary?.slice(0, 80) }}{{ c.summary?.length > 80 ? '…' : '' }}</span>
        </div>
      </div>
      <div v-if="communities.length > 10" class="muted" style="font-size:var(--fs-caption);margin-top:4px">
        共 {{ communities.length }} 个社区，仅显示前 10 个
      </div>
    </template>
    <NEmpty v-else description="暂无社区数据" style="padding:12px 0" />
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
</style>