<script setup lang="ts">
import { computed } from 'vue';
import { NGrid, NGi, NCard, NDivider, NEmpty } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import { formatTimeWithSeconds } from '../../utils/format';
import GmProServicesCard from '../../components/monitor/GmProServicesCard.vue';
import AgentStatusCard from '../../components/monitor/AgentStatusCard.vue';
import CircuitBreakerCard from '../../components/monitor/CircuitBreakerCard.vue';
import DegradedLayersCard from '../../components/monitor/DegradedLayersCard.vue';

const {
  gmProServices,
  agent,
  agentLoading,
  db,
  memory,
} = useMonitorData();

const lastUpdated = computed(() => formatTimeWithSeconds(Date.now()));
</script>

<template>
  <div class="view">
    <h2 class="view-title">核心服务监控</h2>
    <div class="view-meta">
      <span class="muted">上次更新：{{ lastUpdated }}</span>
    </div>

    <NCard :bordered="false" size="small" style="margin-bottom: 16px">
      <GmProServicesCard :services="gmProServices" />
    </NCard>

    <NGrid :cols="'1 s:1 m:2 l:3'" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <AgentStatusCard :agent="agent" :loading="agentLoading" />
      </NGi>
      <NGi>
        <CircuitBreakerCard :db="db" />
      </NGi>
      <NGi>
        <DegradedLayersCard :memory="memory" />
      </NGi>
    </NGrid>
  </div>
</template>

<style scoped>
.view {
  padding: 16px;
}
.view-title {
  margin: 0 0 4px 0;
  font-size: 18px;
  font-weight: 600;
}
.view-meta {
  margin-bottom: 12px;
  font-size: var(--fs-caption);
}
</style>