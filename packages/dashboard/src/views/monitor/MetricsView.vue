<script setup lang="ts">
/**
 * 运行指标：graph-memory-pro 运行时性能 + Token 用量 + Cascade + 债务调度 + 用户画像。
 */
import { NGrid, NGi, NTag } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import GmProRuntimeMetricsCard from '../../components/monitor/GmProRuntimeMetricsCard.vue';
import TokenUsageCard from '../../components/monitor/TokenUsageCard.vue';
import CascadeCard from '../../components/monitor/CascadeCard.vue';
import DebtSchedulerCard from '../../components/monitor/DebtSchedulerCard.vue';
import UserProfileCard from '../../components/monitor/UserProfileCard.vue';

const {
  gmProMetrics,
  gmProMetricsLoading,
  gmProMetricsIsError,
  gmProUsage,
  gmProUsageLoading,
  gmProUsageIsError,
  memory,
  refreshStatus,
} = useMonitorData();
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2 class="view-title">运行指标</h2>
      <NTag :type="refreshStatus.type" size="small" :bordered="false">{{ refreshStatus.label }}</NTag>
    </div>

    <NGrid :cols="'1 s:1 m:2 l:2'" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <GmProRuntimeMetricsCard
          :metrics="gmProMetrics"
          :loading="gmProMetricsLoading"
          :is-error="gmProMetricsIsError"
        />
      </NGi>
      <NGi>
        <TokenUsageCard
          :usage="gmProUsage"
          :loading="gmProUsageLoading"
          :is-error="gmProUsageIsError"
        />
      </NGi>
      <NGi>
        <CascadeCard :memory="memory" />
      </NGi>
      <NGi>
        <DebtSchedulerCard :memory="memory" />
      </NGi>
      <NGi>
        <UserProfileCard :memory="memory" />
      </NGi>
    </NGrid>
  </div>
</template>

<style scoped>
.view { padding: 16px; }
.view-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.view-title { margin: 0; font-size: 18px; font-weight: 600; }
</style>
