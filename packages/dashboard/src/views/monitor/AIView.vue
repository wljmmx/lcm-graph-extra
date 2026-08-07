<script setup lang="ts">
/**
 * 智能引擎：AutoTuner + Doctor + 关联矩阵。
 */
import { NGrid, NGi, NTag } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import AutoTunerCard from '../../components/monitor/AutoTunerCard.vue';
import DoctorCard from '../../components/monitor/DoctorCard.vue';
import AssociationMatrixCard from '../../components/monitor/AssociationMatrixCard.vue';

const {
  gmProTuner,
  gmProTunerLoading,
  gmProTunerIsError,
  gmProDoctor,
  gmProDoctorLoading,
  gmProDoctorIsError,
  gmProAm,
  gmProAmLoading,
  gmProAmIsError,
  refreshStatus,
} = useMonitorData();
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2 class="view-title">智能引擎</h2>
      <NTag :type="refreshStatus.type" size="small" :bordered="false">{{ refreshStatus.label }}</NTag>
    </div>

    <NGrid :cols="'1 s:1 m:2 l:3'" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <AutoTunerCard
          :tuner="gmProTuner"
          :loading="gmProTunerLoading"
          :is-error="gmProTunerIsError"
        />
      </NGi>
      <NGi>
        <DoctorCard
          :doctor="gmProDoctor"
          :loading="gmProDoctorLoading"
          :is-error="gmProDoctorIsError"
        />
      </NGi>
      <NGi>
        <AssociationMatrixCard
          :am="gmProAm"
          :loading="gmProAmLoading"
          :is-error="gmProAmIsError"
        />
      </NGi>
    </NGrid>
  </div>
</template>

<style scoped>
.view { padding: 16px; }
.view-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.view-title { margin: 0; font-size: 18px; font-weight: 600; }
</style>
