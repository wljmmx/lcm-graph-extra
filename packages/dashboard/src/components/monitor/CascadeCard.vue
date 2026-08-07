<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NTag, NDescriptions, NDescriptionsItem, NEmpty } from 'naive-ui';
import EChart from '../EChart.vue';
import { useTheme } from '../../composables/useTheme';
import type { DashboardSnapshot } from '../../api/health';

const props = defineProps<{
  memory: DashboardSnapshot | null;
}>();

const { isDark } = useTheme();

const cascadeTopArms = computed(() => props.memory?.cascade?.topArms?.slice(0, 10) ?? []);

const tier1Confidence = computed<number | null>(() => {
  const v = props.memory?.health?.latest?.cascadeTier1Confidence;
  return typeof v === 'number' ? Math.round(v * 1000) / 1000 : null;
});

const judgeSource = computed(() => props.memory?.health?.latest?.cascadeJudgeSource ?? null);

const betaOption = computed(() => {
  const arms = cascadeTopArms.value;
  return {
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    legend: { data: ['alpha', 'beta'] },
    grid: { left: 48, right: 16, top: 30, bottom: 48 },
    xAxis: {
      type: 'category' as const,
      data: arms.map((a) => a.armKey.length > 12 ? a.armKey.slice(0, 10) + '…' : a.armKey),
      axisLabel: { rotate: 30, fontSize: 10 },
    },
    yAxis: { type: 'value' as const },
    series: [
      { name: 'alpha', type: 'bar', data: arms.map((a) => a.alpha), itemStyle: { color: isDark.value ? '#4098fc' : '#2080f0' } },
      { name: 'beta', type: 'bar', data: arms.map((a) => a.beta), itemStyle: { color: isDark.value ? '#9270ed' : '#7c3aed' } },
    ],
  };
});
</script>

<template>
  <NCard title="Cascade" size="small">
    <template v-if="memory">
      <NDescriptions :column="1" size="small" label-placement="left" bordered>
        <NDescriptionsItem label="arms 数量">{{ memory.cascade?.armsCount ?? 0 }}</NDescriptionsItem>
        <NDescriptionsItem label="置信阈值">{{ memory.cascade?.confidenceThreshold ?? '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="Tier1 置信度">
          <span v-if="tier1Confidence !== null" class="mono">{{ tier1Confidence }}</span>
          <span v-else class="muted">—</span>
          <NTag v-if="judgeSource" size="small" :type="judgeSource === 'gm-pro' ? 'success' : 'default'" style="margin-left:6px">{{ judgeSource }}</NTag>
        </NDescriptionsItem>
      </NDescriptions>
      <EChart v-if="cascadeTopArms.length" :option="betaOption" height="220px" aria-label="Cascade Top 10 臂分布" />
      <NEmpty v-else size="small" description="无 arm 数据" style="margin: 12px 0" />
    </template>
    <NEmpty v-else description="插件未响应" style="padding: 12px 0" />
  </NCard>
</template>