<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NTag, NDescriptions, NDescriptionsItem, NEmpty, NSpace } from 'naive-ui';
import type { DashboardSnapshot } from '../../api/health';

const props = defineProps<{
  memory: DashboardSnapshot | null;
}>();

const uxSnapshot = computed(() => props.memory?.health?.latest ?? null);

const lastDegradedReasons = computed<string[]>(() => {
  const r = uxSnapshot.value?.lastDegradedReasons;
  return Array.isArray(r) ? r : [];
});

const uxSummary = computed(() => {
  const s = uxSnapshot.value;
  if (!s) {
    return { degradationRate: 0, tokenSavedRatio: 0, experienceHitRate: 0, totalAssembles: 0, degradedCount: 0 };
  }
  const hasGlobalUx = typeof s.globalTotalAssembleCount === 'number' && s.globalTotalAssembleCount > 0;
  const total = hasGlobalUx ? (s.globalTotalAssembleCount ?? 0) : (s.totalAssembleCount ?? 0);
  const degraded = hasGlobalUx ? (s.globalDegradedCount ?? 0) : (s.degradedCount ?? 0);
  const expQuery = hasGlobalUx ? (s.globalExperienceQueryCount ?? 0) : (s.experienceQueryCount ?? 0);
  const expHit = hasGlobalUx ? (s.globalExperienceHitCount ?? 0) : (s.experienceHitCount ?? 0);
  return {
    degradationRate: total > 0 ? degraded / total : 0,
    tokenSavedRatio: s.tokenSavedRatio ?? 0,
    experienceHitRate: expQuery > 0 ? expHit / expQuery : 0,
    totalAssembles: total,
    degradedCount: degraded,
  };
});

const layerStatus = computed(() => {
  const r = lastDegradedReasons.value;
  const has = (kw: string[]) => kw.some((k) => r.some((x) => x.toLowerCase().includes(k)));
  return {
    L1: has(['l1_', 'qmd']),
    L2: has(['l2_', 'circuit']),
    L3: has(['l3_', 'graph']),
    L4: has(['l4_', 'experience']),
    gmPro: has(['gm_pro', 'gmpro', 'cascade']),
  };
});

const degradationTagType = computed<'success' | 'warning' | 'error' | 'default'>(() => {
  const r = uxSummary.value.degradationRate;
  if (r > 0.5) return 'error';
  if (r > 0.1) return 'warning';
  if (uxSummary.value.totalAssembles > 0) return 'success';
  return 'default';
});
</script>

<template>
  <NCard title="降级链路" size="small">
    <template v-if="memory">
      <ul class="layer-grid" role="list">
        <li class="layer-cell">
          <span class="dot" :class="layerStatus.L1 ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.L1 ? '✗' : '✓' }}</span>
          <span class="layer-label">L1 QMD</span>
        </li>
        <li class="layer-cell">
          <span class="dot" :class="layerStatus.L2 ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.L2 ? '✗' : '✓' }}</span>
          <span class="layer-label">L2 熔断</span>
        </li>
        <li class="layer-cell">
          <span class="dot" :class="layerStatus.L3 ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.L3 ? '✗' : '✓' }}</span>
          <span class="layer-label">L3 图谱</span>
        </li>
        <li class="layer-cell">
          <span class="dot" :class="layerStatus.L4 ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.L4 ? '✗' : '✓' }}</span>
          <span class="layer-label">L4 经验</span>
        </li>
        <li class="layer-cell">
          <span class="dot" :class="layerStatus.gmPro ? 'dot-fail' : 'dot-ok'" aria-hidden="true">{{ layerStatus.gmPro ? '✗' : '✓' }}</span>
          <span class="layer-label">gm-pro</span>
        </li>
      </ul>
      <NDescriptions :column="1" size="small" label-placement="left" bordered style="margin-top: 8px">
        <NDescriptionsItem label="降级率">
          <NTag :type="degradationTagType" size="small">{{ (uxSummary.degradationRate * 100).toFixed(1) }}%</NTag>
          <span class="muted mono" style="margin-left:6px">{{ uxSummary.degradedCount }}/{{ uxSummary.totalAssembles }}</span>
        </NDescriptionsItem>
        <NDescriptionsItem label="Token 节省率">
          <span class="mono">{{ (uxSummary.tokenSavedRatio * 100).toFixed(1) }}%</span>
        </NDescriptionsItem>
        <NDescriptionsItem label="经验命中率">
          <span class="mono">{{ (uxSummary.experienceHitRate * 100).toFixed(1) }}%</span>
        </NDescriptionsItem>
      </NDescriptions>
      <div v-if="lastDegradedReasons.length" class="profile-section" style="margin-top:8px">
        <div class="profile-label">最近降级原因</div>
        <NSpace :size="4">
          <NTag v-for="r in lastDegradedReasons" :key="r" size="small" type="warning">{{ r }}</NTag>
        </NSpace>
      </div>
    </template>
    <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
  </NCard>
</template>

<style scoped>
.profile-section {
  margin-bottom: var(--space-sm);
}
.profile-label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-xs);
}
.layer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  gap: var(--space-sm);
  list-style: none;
  margin: 0;
  padding: 0;
}
.layer-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm) 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.layer-cell .dot {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  font-weight: 700;
  line-height: 1;
  color: var(--color-surface);
}
.layer-cell .dot-ok {
  background: var(--color-success);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-success) 60%, transparent);
}
.layer-cell .dot-fail {
  background: var(--color-danger);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-danger) 60%, transparent);
}
.layer-label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
</style>