<script setup lang="ts">
/**
 * gm-pro 健康概览：图谱健康评分（v2.6.0 GraphHealthMetric 快照）+ 活跃/孤立/高过时节点、
 * 社区数、平均 PR、异常、熔断器。从 GraphHealthCard 拆分而来。
 */
import { computed } from 'vue';
import { NCard, NTag, NSpace, NGrid, NGi, NDivider } from 'naive-ui';
import CardState from './CardState.vue';
import type { GmProHealth } from '../../api/gm-pro';
import type { GraphHealthScore } from '../../api/health';

const props = defineProps<{
  gmProHealth: GmProHealth | null;
  loading?: boolean;
  isError?: boolean;
  /** v2.6.0: 图谱健康评分（GraphHealthMetric 快照） */
  healthScore?: GraphHealthScore | null;
  healthScoreLoading?: boolean;
  healthScoreIsError?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

/** 健康分颜色分级：>=80 优（绿）/ >=60 中（橙）/ <60 差（红） */
const scoreType = computed<'success' | 'warning' | 'error'>(() => {
  const s = props.healthScore?.score;
  if (s == null) return 'warning';
  if (s >= 80) return 'success';
  if (s >= 60) return 'warning';
  return 'error';
});

/** 五维标签映射 */
const DIM_LABELS: Array<{ key: 'connectivity' | 'density' | 'influence' | 'freshness' | 'conflictFree'; label: string }> = [
  { key: 'connectivity', label: '连通性' },
  { key: 'density', label: '密度' },
  { key: 'influence', label: '影响力' },
  { key: 'freshness', label: '时效性' },
  { key: 'conflictFree', label: '冲突' },
];
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
      <!-- v2.6.0: 图谱健康评分（GraphHealthMetric 快照） -->
      <template v-if="healthScore">
        <div class="score-row">
          <span class="score-label">图谱健康评分</span>
          <NTag :type="scoreType" size="small" class="score-tag">{{ healthScore.score }} / 100</NTag>
          <NTag v-if="healthScore.sparse" size="small" type="error" class="score-tag">稀疏</NTag>
        </div>
        <div class="dims-row" v-if="healthScore.dims">
          <span v-for="d in DIM_LABELS" :key="d.key" class="dim-item">
            <span class="dim-label">{{ d.label }}</span>
            <span class="dim-value" :style="{ color: `var(--color-${(healthScore.dims?.[d.key] ?? 0) >= 0.7 ? 'success' : (healthScore.dims?.[d.key] ?? 0) >= 0.4 ? 'warning' : 'danger'})` }">
              {{ Math.round((healthScore.dims?.[d.key] ?? 0) * 100) }}%
            </span>
          </span>
        </div>
        <div v-if="healthScore.anomalies?.length" class="score-anomalies">
          <NTag v-for="a in healthScore.anomalies" :key="a" size="tiny" type="warning">{{ a }}</NTag>
        </div>
        <NDivider style="margin:8px 0" />
      </template>

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
.score-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.score-label { font-size: var(--fs-caption); color: var(--color-text-tertiary); }
.score-tag { margin-left: 0; }
.dims-row { display: flex; flex-wrap: wrap; gap: 12px; padding: 2px 0 6px; }
.dim-item { display: flex; flex-direction: column; gap: 2px; }
.dim-label { font-size: 11px; color: var(--color-text-tertiary); }
.dim-value { font-size: 13px; font-weight: 600; }
.score-anomalies { display: flex; flex-wrap: wrap; gap: 4px; }
</style>
