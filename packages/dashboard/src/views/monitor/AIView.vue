<script setup lang="ts">
/**
 * 智能引擎：AutoTuner + Doctor + 关联矩阵。
 */
import { ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { NGrid, NGi, useMessage } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import { postGmProAssociationMatrixSave, postGmProAssociationMatrixLoad } from '../../api/gm-pro';
import AutoTunerCard from '../../components/monitor/AutoTunerCard.vue';
import DoctorCard from '../../components/monitor/DoctorCard.vue';
import AssociationMatrixStateCard from '../../components/monitor/AssociationMatrixStateCard.vue';
import AssociationMatrixHeatmapCard from '../../components/monitor/AssociationMatrixHeatmapCard.vue';

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
} = useMonitorData();

// 关联矩阵 M 持久化操作（save / load）
const message = useMessage();
const queryClient = useQueryClient();
const amActing = ref(false);
async function handleAmSave(): Promise<void> {
  if (amActing.value) return;
  amActing.value = true;
  try {
    const res = await postGmProAssociationMatrixSave();
    if (res.ok) {
      message.success(`关联矩阵 M 已保存${res.data?.path ? ` → ${res.data.path}` : ''}`);
    } else {
      message.error(`保存失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`保存失败: ${err?.message || String(err)}`);
  } finally {
    amActing.value = false;
    queryClient.invalidateQueries({ queryKey: ['gm-pro-association-matrix'] });
  }
}
async function handleAmLoad(): Promise<void> {
  if (amActing.value) return;
  amActing.value = true;
  try {
    const res = await postGmProAssociationMatrixLoad();
    if (res.ok) {
      message.success('关联矩阵 M 已从磁盘加载');
    } else {
      message.error(`加载失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`加载失败: ${err?.message || String(err)}`);
  } finally {
    amActing.value = false;
    queryClient.invalidateQueries({ queryKey: ['gm-pro-association-matrix'] });
  }
}
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2 class="view-title">智能引擎</h2>
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
        <AssociationMatrixStateCard
          :am="gmProAm"
          :loading="gmProAmLoading"
          :is-error="gmProAmIsError"
          :acting="amActing"
          @save="handleAmSave"
          @load="handleAmLoad"
          @retry="queryClient.invalidateQueries({ queryKey: ['gm-pro-association-matrix'] })"
        />
      </NGi>
    </NGrid>

    <NGrid :cols="1" :x-gap="12" :y-gap="12" responsive="screen" style="margin-top: 12px">
      <NGi>
        <AssociationMatrixHeatmapCard
          :am="gmProAm"
          :loading="gmProAmLoading"
          :is-error="gmProAmIsError"
          @retry="queryClient.invalidateQueries({ queryKey: ['gm-pro-association-matrix'] })"
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
