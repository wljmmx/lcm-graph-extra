<script setup lang="ts">
import { computed } from 'vue';
import { NGrid, NGi, NCard, NDivider, NEmpty } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import { formatTimeWithSeconds } from '../../utils/format';
import GraphHealthCard from '../../components/monitor/GraphHealthCard.vue';
import CommunitiesCard from '../../components/monitor/CommunitiesCard.vue';
import TopNodesChartCard from '../../components/monitor/TopNodesChartCard.vue';
import RetrievalStatusCard from '../../components/monitor/RetrievalStatusCard.vue';
import DirtyNodesCard from '../../components/monitor/DirtyNodesCard.vue';

const {
  graphHealth,
  graphHealthLoading,
  gmProHealth,
  gmProTop10,
  gmProDirty,
  gmProCommunities,
  memory,
} = useMonitorData();

const lastUpdated = computed(() => formatTimeWithSeconds(Date.now()));
</script>

<template>
  <div class="view">
    <h2 class="view-title">图谱健康中心</h2>
    <div class="view-meta">
      <span class="muted">上次更新：{{ lastUpdated }}</span>
    </div>

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
        <TopNodesChartCard :nodes="gmProTop10" />
      </NGi>
      <NGi>
        <RetrievalStatusCard :memory="memory" />
      </NGi>
    </NGrid>

    <NDivider style="margin: 12px 0" />

    <DirtyNodesCard :dirty="gmProDirty" />
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