<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NProgress, NEmpty, NTag, NDescriptions, NDescriptionsItem } from 'naive-ui';
import type { DashboardSnapshot } from '../../api/health';

const props = defineProps<{
  memory: DashboardSnapshot | null;
}>();

/** 并发占用率：running / maxConcurrent */
const utilization = computed<number | null>(() => {
  const running = props.memory?.debt?.running ?? 0;
  const max = props.memory?.debt?.maxConcurrent ?? 0;
  if (max <= 0) return running > 0 ? 100 : 0;
  return Math.min(100, Math.round((running / max) * 100));
});

const utilizationStatus = computed(() => {
  const p = utilization.value ?? 0;
  return p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success';
});
</script>

<template>
  <NCard title="债务调度器" size="small">
    <template v-if="memory">
      <div class="util-block">
        <div class="ratio-label">
          <span class="muted" style="font-size:var(--fs-caption)">并发占用</span>
          <span class="mono" style="font-size:var(--fs-caption)">
            {{ memory.debt?.running ?? 0 }} / {{ memory.debt?.maxConcurrent ?? 0 }}
            <NTag size="tiny" :type="utilizationStatus" :bordered="false" style="margin-left:6px">{{ utilization ?? 0 }}%</NTag>
          </span>
        </div>
        <NProgress
          type="line"
          :percentage="utilization ?? 0"
          :height="6"
          :border-radius="3"
          :show-indicator="false"
          :color="utilizationStatus === 'error' ? '#d03050' : utilizationStatus === 'warning' ? '#f0a020' : '#18a058'"
        />
      </div>

      <NDescriptions :column="2" size="small" label-placement="left" bordered style="margin-top:10px">
        <NDescriptionsItem label="待处理任务"><span class="mono">{{ memory.debt?.pendingCount ?? 0 }}</span></NDescriptionsItem>
        <NDescriptionsItem label="轮询周期"><span class="mono">{{ memory.debt?.pollIntervalMs ?? 0 }} ms</span></NDescriptionsItem>
      </NDescriptions>
    </template>
    <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
  </NCard>
</template>

<style scoped>
.util-block { margin-top: 2px; }
.ratio-label { display: flex; justify-content: space-between; margin-bottom: 4px; }
</style>