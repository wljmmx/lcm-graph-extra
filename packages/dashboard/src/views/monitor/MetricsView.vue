<script setup lang="ts">
import { computed } from 'vue';
import { NGrid, NGi, NCard, NDivider, NEmpty } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import { formatTimeWithSeconds } from '../../utils/format';
import TokenUsageCard from '../../components/monitor/TokenUsageCard.vue';
import CascadeCard from '../../components/monitor/CascadeCard.vue';
import DebtSchedulerCard from '../../components/monitor/DebtSchedulerCard.vue';
import UserProfileCard from '../../components/monitor/UserProfileCard.vue';

const {
  gmProUsage,
  memory,
} = useMonitorData();

const lastUpdated = computed(() => formatTimeWithSeconds(Date.now()));
</script>

<template>
  <div class="view">
    <h2 class="view-title">运行指标</h2>
    <div class="view-meta">
      <span class="muted">上次更新：{{ lastUpdated }}</span>
    </div>

    <NGrid :cols="'1 s:1 m:2 l:2'" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <TokenUsageCard :usage="gmProUsage" />
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