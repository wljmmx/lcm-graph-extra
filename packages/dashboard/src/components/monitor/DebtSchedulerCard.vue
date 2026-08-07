<script setup lang="ts">
import { NCard, NDescriptions, NDescriptionsItem, NEmpty } from 'naive-ui';
import type { DashboardSnapshot } from '../../api/health';

defineProps<{
  memory: DashboardSnapshot | null;
}>();
</script>

<template>
  <NCard title="债务调度" size="small">
    <template v-if="memory">
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="running">{{ memory.debt?.running ?? 0 }}</NDescriptionsItem>
        <NDescriptionsItem label="pendingCount">{{ memory.debt?.pendingCount ?? 0 }}</NDescriptionsItem>
        <NDescriptionsItem label="pollIntervalMs">{{ memory.debt?.pollIntervalMs ?? 0 }}</NDescriptionsItem>
        <NDescriptionsItem label="maxConcurrent">{{ memory.debt?.maxConcurrent ?? 0 }}</NDescriptionsItem>
      </NDescriptions>
    </template>
    <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
  </NCard>
</template>