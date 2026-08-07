<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NTag, NEmpty, NDescriptions, NDescriptionsItem, NSpin, NSpace, NDivider, NGrid, NGi } from 'naive-ui';
import EChart from '../EChart.vue';
import StatusIndicator from '../StatusIndicator.vue';
import { useTheme } from '../../composables/useTheme';
import type { GraphHealthResponse } from '../../api/health';
import type { GmProHealth } from '../../api/gm-pro';

const props = defineProps<{
  graphHealth: GraphHealthResponse | null;
  loading: boolean;
  gmProHealth: GmProHealth | null;
  gmProTop10: any[];
  gmProDirty: any | null;
}>();

const { isDark } = useTheme();

const graphHealthTagType = computed<'success' | 'warning' | 'error' | 'default'>(() => {
  const s = props.graphHealth?.status;
  if (s === 'healthy') return 'success';
  if (s === 'degraded') return 'warning';
  if (s === 'unhealthy') return 'error';
  return 'default';
});

const graphHealthSourceTagType = computed<'success' | 'warning' | 'default'>(() => {
  const s = props.graphHealth?.source;
  if (s === 'gm-pro') return 'success';
  if (s === 'local') return 'warning';
  return 'default';
});

const top10ChartOption = computed(() => {
  const nodes = props.gmProTop10;
  if (!nodes.length) return null;
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    grid: { left: 12, right: 24, top: 8, bottom: 4, containLabel: true },
    xAxis: {
      type: 'value' as const,
      axisLabel: { fontSize: 10, color: isDark.value ? '#aaa' : '#666' },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category' as const,
      data: nodes.map((n: any) => n.name?.slice(0, 20) ?? n.id?.slice(0, 12) ?? '—').reverse(),
      axisLabel: { fontSize: 10, color: isDark.value ? '#ccc' : '#333' },
      inverse: true,
    },
    series: [{
      type: 'bar',
      data: nodes.map((n: any) => n.pagerank ?? 0).reverse(),
      barWidth: 14,
      itemStyle: {
        borderRadius: [0, 3, 3, 0],
        color: isDark.value ? '#66b1ff' : '#409eff',
      },
    }],
  };
});
</script>

<template>
  <NCard title="图谱健康" size="small">
    <div v-if="loading && !graphHealth" class="card-loading">
      <NSpin size="small" />
    </div>
    <NEmpty v-else-if="!graphHealth" description="无图谱健康数据" style="padding:12px 0" />

    <template v-else>
      <div class="profile-section" style="margin-bottom:8px">
        <NTag :type="graphHealthTagType" size="small">{{ graphHealth.status }}</NTag>
        <NTag :type="graphHealthSourceTagType" size="small" style="margin-left:6px">source: {{ graphHealth.source }}</NTag>
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
    </template>

    <!-- gm-pro 健康概览 -->
    <NDivider v-if="gmProHealth" style="margin:8px 0" />
    <template v-if="gmProHealth">
      <div class="profile-section" style="margin-bottom:4px">
        <NTag type="success" size="small">gm-pro 概览</NTag>
      </div>
      <NGrid :cols="'2 s:2 m:3'" :x-gap="8" :y-gap="4" responsive="screen">
        <NGi><div class="health-stat"><span class="health-stat-label">活跃节点</span><span class="health-stat-value">{{ gmProHealth.nodes?.active ?? '—' }} / {{ gmProHealth.nodes?.total ?? '—' }}</span></div></NGi>
        <NGi><div class="health-stat"><span class="health-stat-label">孤立节点</span><span class="health-stat-value" :class="{ 'text-warning': (gmProHealth.isolatedNodes ?? 0) > 0 }">{{ gmProHealth.isolatedNodes ?? '—' }}</span></div></NGi>
        <NGi><div class="health-stat"><span class="health-stat-label">高过时</span><span class="health-stat-value" :class="{ 'text-danger': (gmProHealth.highStaleNodes ?? 0) > 0 }">{{ gmProHealth.highStaleNodes ?? '—' }}</span></div></NGi>
        <NGi><div class="health-stat"><span class="health-stat-label">社区数</span><span class="health-stat-value">{{ gmProHealth.communities ?? '—' }}</span></div></NGi>
        <NGi><div class="health-stat"><span class="health-stat-label">平均 PR</span><span class="health-stat-value mono">{{ gmProHealth.avgPageRank?.toFixed(4) ?? '—' }}</span></div></NGi>
        <NGi v-if="gmProHealth.anomalies?.length"><div class="health-stat"><span class="health-stat-label">异常</span><span class="health-stat-value text-warning">{{ gmProHealth.anomalies.length }} 项</span></div></NGi>
      </NGrid>
      <div v-if="gmProHealth.anomalies?.length" style="margin-top:6px">
        <NSpace :size="4"><NTag v-for="a in gmProHealth.anomalies" :key="a" size="small" type="warning">{{ a }}</NTag></NSpace>
      </div>
    </template>

    <!-- gm-pro 熔断器 -->
    <template v-if="gmProHealth?.circuitBreakers">
      <NDivider style="margin:8px 0">熔断器</NDivider>
      <div v-for="(cb, name) in gmProHealth.circuitBreakers" :key="name" style="display:flex;align-items:center;gap:8px;padding:2px 0">
        <span class="mono" style="font-size:var(--fs-caption);min-width:56px">{{ name }}</span>
        <NTag :type="(cb as any).open ? 'error' : 'success'" size="tiny">{{ (cb as any).open ? 'OPEN' : 'CLOSED' }}</NTag>
        <span class="muted" style="font-size:var(--fs-caption)">failures: {{ (cb as any).failures ?? 0 }}</span>
      </div>
    </template>

    <!-- Top 10 PageRank -->
    <template v-if="gmProTop10.length">
      <NDivider style="margin:8px 0">Top 10 PageRank</NDivider>
      <EChart v-if="top10ChartOption" :option="top10ChartOption" :height="200" />
      <NEmpty v-else description="无图表数据" style="padding:8px 0" />
    </template>

    <!-- 脏节点 -->
    <template v-if="gmProDirty">
      <NDivider style="margin:8px 0">增量维护</NDivider>
      <div style="display:flex;align-items:center;gap:8px">
        <NTag :type="(gmProDirty.count ?? 0) > 0 ? 'warning' : 'success'" size="small">脏节点: {{ gmProDirty.count ?? 0 }} 个</NTag>
        <span v-if="(gmProDirty.nodeIds as string[])?.length" class="muted" style="font-size:var(--fs-caption)">{{ (gmProDirty.nodeIds as string[]).slice(0, 3).join(', ') }}{{ (gmProDirty.nodeIds as string[]).length > 3 ? '…' : '' }}</span>
      </div>
    </template>
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
.health-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
}
.health-stat-label {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
}
.health-stat-value {
  font-size: var(--fs-body);
  font-weight: 600;
}
.text-warning {
  color: var(--color-warning);
}
.text-danger {
  color: var(--color-danger);
}
</style>