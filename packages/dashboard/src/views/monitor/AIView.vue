<script setup lang="ts">
import { computed } from 'vue';
import { NGrid, NGi, NCard, NDivider, NEmpty } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import { formatTimeWithSeconds } from '../../utils/format';
import AutoTunerCard from '../../components/monitor/AutoTunerCard.vue';
import DoctorCard from '../../components/monitor/DoctorCard.vue';
import AssociationMatrixCard from '../../components/monitor/AssociationMatrixCard.vue';

const {
  gmProTuner,
  gmProDoctor,
  gmProAm,
} = useMonitorData();

const lastUpdated = computed(() => formatTimeWithSeconds(Date.now()));
</script>

<template>
  <div class="view">
    <h2 class="view-title">智能引擎</h2>
    <div class="view-meta">
      <span class="muted">上次更新：{{ lastUpdated }}</span>
    </div>

    <NGrid :cols="'1 s:1 m:2 l:3'" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <AutoTunerCard :tuner="gmProTuner" />
      </NGi>
      <NGi>
        <DoctorCard :doctor="gmProDoctor" />
      </NGi>
      <NGi>
        <AssociationMatrixCard :am="gmProAm" />
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