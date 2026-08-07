<script setup lang="ts">
/**
 * 核心服务监控：gm-pro 服务状态 + Agent + 熔断器 + 降级链路。
 */
import { NGrid, NGi, NTag } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import GmProServicesCard from '../../components/monitor/GmProServicesCard.vue';
import AgentStatusCard from '../../components/monitor/AgentStatusCard.vue';
import CircuitBreakerCard from '../../components/monitor/CircuitBreakerCard.vue';
import DegradedLayersCard from '../../components/monitor/DegradedLayersCard.vue';

const {
  gmProServices,
  gmProServicesLoading,
  gmProServicesIsError,
  agent,
  agentLoading,
  db,
  memory,
  refreshStatus,
} = useMonitorData();
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2 class="view-title">核心服务监控</h2>
      <NTag :type="refreshStatus.type" size="small" :bordered="false">{{ refreshStatus.label }}</NTag>
    </div>

    <div style="margin-bottom: 12px">
      <GmProServicesCard
        :services="gmProServices"
        :loading="gmProServicesLoading"
        :is-error="gmProServicesIsError"
      />
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
.view { padding: 16px; }
.view-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.view-title { margin: 0; font-size: 18px; font-weight: 600; }
</style>
