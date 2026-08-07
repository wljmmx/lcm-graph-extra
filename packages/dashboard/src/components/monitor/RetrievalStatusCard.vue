<script setup lang="ts">
import { NCard, NDescriptions, NDescriptionsItem, NEmpty } from 'naive-ui';
import StatusIndicator from '../StatusIndicator.vue';
import type { DashboardSnapshot } from '../../api/health';

defineProps<{
  memory: DashboardSnapshot | null;
}>();
</script>

<template>
  <NCard title="检索状态" size="small">
    <template v-if="memory">
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="最近查询">
          <span class="mono">{{ memory.retrieval?.lastQuery || '—' }}</span>
        </NDescriptionsItem>
        <NDescriptionsItem label="性能摘要">
          <span class="mono">{{ memory.retrieval?.perfSummary || '—' }}</span>
        </NDescriptionsItem>
      </NDescriptions>
      <div class="section">
        <div class="label">图谱适配器</div>
        <StatusIndicator
          label="Neo4j"
          mode="connection"
          :available="!!memory.graphAdapter?.connected"
          :failures="memory.graphAdapter?.circuitBreaker?.failures ?? (memory.graphAdapter?.connectFailed ? 1 : 0)"
        />
      </div>
      <div class="section">
        <div class="label">QMD 熔断器</div>
        <StatusIndicator
          label="QMD"
          :available="memory.retrieval?.qmdCircuitBreaker?.available ?? true"
          :failures="memory.retrieval?.qmdCircuitBreaker?.failures ?? 0"
        />
      </div>
    </template>
    <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
  </NCard>
</template>

<style scoped>
.section { margin-top: 8px; }
.label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}
</style>