<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NTag, NAlert, NDescriptions, NDescriptionsItem, NEmpty, NSpin } from 'naive-ui';
import type { AgentStatus } from '../../api/health';

const props = defineProps<{
  agent: AgentStatus | null;
  loading: boolean;
}>();

const extraFields = computed(() => {
  const a = props.agent;
  if (!a) return [];
  return Object.entries(a)
    .filter(([k]) => k !== 'online' && k !== 'error')
    .map(([k, v]) => ({
      key: k,
      value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
    }));
});
</script>

<template>
  <NCard title="Agent 状态" size="small">
    <div v-if="loading && !agent" class="card-loading">
      <NSpin size="small" />
    </div>
    <template v-else-if="agent">
      <div class="profile-section">
        <NTag :type="agent.online ? 'success' : 'error'" size="small">
          {{ agent.online ? '在线' : '离线' }}
        </NTag>
      </div>
      <NAlert
        v-if="agent.error"
        type="warning"
        :show-icon="true"
        style="margin: 8px 0"
      >
        {{ agent.error }}
      </NAlert>
      <details v-if="extraFields.length" class="agent-diag">
        <summary>详细字段（{{ extraFields.length }} · 诊断）</summary>
        <NDescriptions
          :column="1"
          size="small"
          label-placement="left"
          bordered
          style="margin-top:6px"
        >
          <NDescriptionsItem
            v-for="f in extraFields"
            :key="f.key"
            :label="f.key"
          >
            <span class="mono">{{ f.value }}</span>
          </NDescriptionsItem>
        </NDescriptions>
      </details>
    </template>
    <NEmpty v-else description="无 Agent 数据" style="padding: 12px 0" />
  </NCard>
</template>

<style scoped>
.card-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}
.profile-section {
  margin-bottom: var(--space-sm);
}
.agent-diag {
  font-size: var(--fs-caption);
  line-height: 1.6;
}
.agent-diag summary {
  cursor: pointer;
  user-select: none;
  color: var(--color-text-secondary);
}
</style>