<script setup lang="ts">
/**
 * gm-pro 健康概览：活跃/孤立/高过时节点、社区数、平均 PR、异常、熔断器。
 * 从 GraphHealthCard 拆分而来。
 */
import { NCard, NTag, NSpace, NGrid, NGi, NDivider } from 'naive-ui';
import CardState from './CardState.vue';
import type { GmProHealth } from '../../api/gm-pro';

const props = defineProps<{
  gmProHealth: GmProHealth | null;
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <NCard title="gm-pro 健康概览" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!gmProHealth"
      empty-text="暂无 gm-pro 健康数据"
      error-text="gm-pro 健康请求失败"
      empty-hint="请确认 graph-memory-pro 服务（端口 7850）已启动。"
      @retry="emit('retry')"
    >
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

      <template v-if="gmProHealth.circuitBreakers">
        <NDivider style="margin:8px 0">熔断器</NDivider>
        <div v-for="(cb, name) in gmProHealth.circuitBreakers" :key="name" style="display:flex;align-items:center;gap:8px;padding:2px 0">
          <span class="mono" style="font-size:var(--fs-caption);min-width:56px">{{ name }}</span>
          <NTag :type="(cb as any).open ? 'error' : 'success'" size="tiny">{{ (cb as any).open ? 'OPEN' : 'CLOSED' }}</NTag>
          <span class="muted" style="font-size:var(--fs-caption)">failures: {{ (cb as any).failures ?? 0 }}</span>
        </div>
      </template>
    </CardState>
  </NCard>
</template>

<style scoped>
.health-stat { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
.health-stat-label { font-size: var(--fs-caption); color: var(--color-text-tertiary); }
.health-stat-value { font-size: var(--fs-body); font-weight: 600; }
.text-warning { color: var(--color-warning); }
.text-danger { color: var(--color-danger); }
</style>
