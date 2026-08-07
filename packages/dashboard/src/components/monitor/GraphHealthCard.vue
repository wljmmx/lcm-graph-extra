<script setup lang="ts">
/**
 * 图谱健康（仅 lcm graph-health，不含 gm-pro 概览）。
 * gm-pro 概览已拆分到 GmProHealthCard.vue。
 */
import { computed } from 'vue';
import { NCard, NTag, NDescriptions, NDescriptionsItem } from 'naive-ui';
import StatusIndicator from '../StatusIndicator.vue';
import CardState from './CardState.vue';
import type { GraphHealthResponse } from '../../api/health';

const props = defineProps<{
  graphHealth: GraphHealthResponse | null;
  loading: boolean;
  isError?: boolean;
}>();

const tagType = computed<'success' | 'warning' | 'error' | 'default'>(() => {
  const s = props.graphHealth?.status;
  if (s === 'healthy') return 'success';
  if (s === 'degraded') return 'warning';
  if (s === 'unhealthy') return 'error';
  return 'default';
});

const sourceTagType = computed<'success' | 'warning' | 'default'>(() => {
  const s = props.graphHealth?.source;
  if (s === 'gm-pro') return 'success';
  if (s === 'local') return 'warning';
  return 'default';
});

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <NCard title="图谱健康" size="small">
    <CardState
      :loading="loading"
      :is-error="isError"
      :has-data="!!graphHealth"
      empty-text="暂无图谱健康数据"
      error-text="图谱健康请求失败"
      empty-hint="请确认 graph-memory-pro 服务已启动。"
      @retry="emit('retry')"
    >
      <div class="profile-section">
        <NTag :type="tagType" size="small">{{ graphHealth.status }}</NTag>
        <NTag :type="sourceTagType" size="small" style="margin-left:6px">source: {{ graphHealth.source }}</NTag>
      </div>
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="nodeCount">{{ graphHealth.nodeCount ?? '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="relationshipCount">{{ graphHealth.relationshipCount ?? '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="graphAdapter">
          <StatusIndicator label="connected" mode="connection" :available="!!graphHealth.graphAdapterConnected" :failures="graphHealth.circuitBreakerFailures ?? 0" />
        </NDescriptionsItem>
        <NDescriptionsItem v-if="graphHealth.circuitBreakerOpen !== undefined" label="熔断器">
          <NTag :type="graphHealth.circuitBreakerOpen ? 'error' : 'success'" size="small">{{ graphHealth.circuitBreakerOpen ? 'OPEN' : 'CLOSED' }}</NTag>
          <span class="mono" style="margin-left:6px">failures: {{ graphHealth.circuitBreakerFailures ?? 0 }}</span>
        </NDescriptionsItem>
      </NDescriptions>
      <div v-if="graphHealth.error" class="muted mono" style="margin-top:6px">{{ graphHealth.error }}</div>
    </CardState>
  </NCard>
</template>

<style scoped>
.profile-section { margin-bottom: var(--space-sm); }
</style>
