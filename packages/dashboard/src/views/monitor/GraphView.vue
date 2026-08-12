<script setup lang="ts">
/**
 * 图谱健康中心：图谱健康 + gm-pro 概览 + Top10 + 脏节点 + 社区 + 检索状态。
 * GraphHealthCard 已拆分为纯 lcm 卡 + GmProHealthCard + TopNodesChartCard + DirtyNodesCard。
 */
import { NGrid, NGi, NTag } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import GraphHealthCard from '../../components/monitor/GraphHealthCard.vue';
import GmProHealthCard from '../../components/monitor/GmProHealthCard.vue';
import TopNodesChartCard from '../../components/monitor/TopNodesChartCard.vue';
import DirtyNodesCard from '../../components/monitor/DirtyNodesCard.vue';
import CommunitiesCard from '../../components/monitor/CommunitiesCard.vue';
import RetrievalStatusCard from '../../components/monitor/RetrievalStatusCard.vue';
import RecallConfigCard from '../../components/monitor/RecallConfigCard.vue';

const {
  graphHealth,
  graphHealthLoading,
  graphHealthIsError,
  gmProHealth,
  gmProHealthLoading,
  gmProHealthIsError,
  gmProTop10,
  gmProTop10Loading,
  gmProTop10IsError,
  gmProDirty,
  gmProDirtyLoading,
  gmProDirtyIsError,
  gmProCommunities,
  gmProCommunitiesLoading,
  gmProCommunitiesIsError,
  memory,
  refreshStatus,
} = useMonitorData();
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2 class="view-title">图谱健康中心</h2>
      <NTag :type="refreshStatus.type" size="small" :bordered="false">{{ refreshStatus.label }}</NTag>
    </div>

    <NGrid :cols="'1 s:1 m:2 l:2'" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <GraphHealthCard
          :graph-health="graphHealth"
          :loading="graphHealthLoading"
          :is-error="graphHealthIsError"
        />
      </NGi>
      <NGi>
        <GmProHealthCard
          :gm-pro-health="gmProHealth"
          :loading="gmProHealthLoading"
          :is-error="gmProHealthIsError"
        />
      </NGi>
      <NGi>
        <TopNodesChartCard
          :nodes="gmProTop10"
          :loading="gmProTop10Loading"
          :is-error="gmProTop10IsError"
        />
      </NGi>
      <NGi>
        <CommunitiesCard
          :communities="gmProCommunities"
          :loading="gmProCommunitiesLoading"
          :is-error="gmProCommunitiesIsError"
        />
      </NGi>
      <NGi>
        <DirtyNodesCard
          :dirty="gmProDirty"
          :loading="gmProDirtyLoading"
          :is-error="gmProDirtyIsError"
        />
      </NGi>
      <NGi>
        <RetrievalStatusCard :memory="memory" />
      </NGi>
      <NGi>
        <RecallConfigCard />
      </NGi>
    </NGrid>
  </div>
</template>

<style scoped>
.view { padding: 16px; }
.view-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.view-title { margin: 0; font-size: 18px; font-weight: 600; }
</style>
