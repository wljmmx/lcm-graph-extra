<script setup lang="ts">
/**
 * 图谱健康中心：图谱健康主卡 + 社区概览 + 检索状态。
 *
 * GraphHealthCard 已内置 Top10 PR 图表和脏节点监控，
 * 无需重复渲染独立的 TopNodesChartCard 和 DirtyNodesCard。
 */
import { NGrid, NGi, NCard, NEmpty } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import GraphHealthCard from '../../components/monitor/GraphHealthCard.vue';
import CommunitiesCard from '../../components/monitor/CommunitiesCard.vue';
import RetrievalStatusCard from '../../components/monitor/RetrievalStatusCard.vue';

const {
  graphHealth,
  graphHealthLoading,
  gmProHealth,
  gmProTop10,
  gmProDirty,
  gmProCommunities,
  memory,
} = useMonitorData();
</script>

<template>
  <div class="view">
    <h2 class="view-title">图谱健康中心</h2>

    <NGrid :cols="'1 s:1 m:2 l:2'" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <GraphHealthCard
          :graph-health="graphHealth"
          :loading="graphHealthLoading"
          :gm-pro-health="gmProHealth"
          :gm-pro-top10="gmProTop10"
          :gm-pro-dirty="gmProDirty"
        />
      </NGi>
      <NGi>
        <CommunitiesCard :communities="gmProCommunities" />
      </NGi>
      <NGi>
        <RetrievalStatusCard :memory="memory" />
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
