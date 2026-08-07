<script setup lang="ts">
/**
 * 核心服务监控：gm-pro 服务状态 + Agent + 熔断器 + 降级链路。
 */
import { NGrid, NGi } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
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
  refreshStatus,
} = useMonitorData();
</script>

<template>
  <div class="view">
    <h2 class="view-title">核心服务监控</h2>

    <!-- gm-pro 服务表格（GmProServicesCard 自带 NCard 外壳，无需再包裹） -->
    <div style="margin-bottom: 12px">
      <GmProServicesCard :services="gmProServices" />
    </div>

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
  margin: 0 0 12px 0;
  font-size: 18px;
  font-weight: 600;
}
</style>
