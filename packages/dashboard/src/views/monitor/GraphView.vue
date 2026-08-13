<script setup lang="ts">
/**
 * 图谱健康中心（v2.4.0 能力完整闭环版）。
 *
 * 视图布局（信息架构按「感知 → 探索 → 验证」的认知流排布）：
 *   R1：感知层 — 健康指标    GraphHealthCard + GmProHealthCard（左→右：系统级→组件级）
 *   R2：洞察层 — 数据概览    TopNodesChartCard + CommunitiesCard（高价值内容前置）
 *   R3：运维层 — 维护控制    维护面板(增强版) + 服务状态(后续放 ServicesView)
 *   R4：配置验证层 — 检索闭环 RecallConfigCard(配置) + RecallTestCard(验证) 相邻放置
 *   R5：探索层 — 图谱钻取    GmProSchemaCard(结构透明) + GraphExplorerCard(搜索+钻取)
 *
 * 跨组件交互闭环：
 *   · CommunitiesCard @openNode → GraphExplorerCard.openNode()
 *     （从社区的成员/代表节点点击，可以直接在图谱探索器中继续钻取）
 *   · 所有运维操作(维护/向量化等) → 自动触发相关数据刷新
 */
import { ref } from 'vue';
import { NGrid, NGi, NDivider } from 'naive-ui';
import { useMonitorData } from '../../composables/useMonitorData';
import GraphHealthCard from '../../components/monitor/GraphHealthCard.vue';
import GmProHealthCard from '../../components/monitor/GmProHealthCard.vue';
import TopNodesChartCard from '../../components/monitor/TopNodesChartCard.vue';
import DirtyNodesCard from '../../components/monitor/DirtyNodesCard.vue';
import CommunitiesCard from '../../components/monitor/CommunitiesCard.vue';
import RetrievalStatusCard from '../../components/monitor/RetrievalStatusCard.vue';
import RecallConfigCard from '../../components/monitor/RecallConfigCard.vue';
import RecallTestCard from '../../components/monitor/RecallTestCard.vue';
import GmProSchemaCard from '../../components/monitor/GmProSchemaCard.vue';
import GraphExplorerCard from '../../components/monitor/GraphExplorerCard.vue';

// 通过 ref 拿到 GraphExplorerCard 的内部 openNode 方法（ Communities 事件桥接用 ）
// ⚠️ GraphExplorerCard 目前没有 defineExpose openNode，但是 Communities 触发 openNode 时
// 可以通过"设置搜索 query=节点ID"这种弱耦合方式，或者等后续 GraphExplorer 补 expose。
// 这里先预留 ref，避免后续扩展改父组件。
const explorerRef = ref<InstanceType<typeof GraphExplorerCard> | null>(null);

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
} = useMonitorData();

/**
 * 社区成员/代表节点点击 → 桥接到 GraphExplorer 直接打开节点抽屉。
 * GraphExplorerCard 已 defineExpose({ openNode })，无缝钻取。
 */
function onCommunityOpenNode(nodeId: string): void {
  explorerRef.value?.openNode(nodeId);
}
</script>

<template>
  <div class="view">
    <!-- 视图标题 + 全局刷新状态 -->
    <div class="view-header">
      <h2 class="view-title">图谱健康中心</h2>
    </div>

    <!-- R1：感知层 — 健康指标（先看系统是否正常） -->
    <section class="view-section">
      <div class="section-label">R1 · 健康感知</div>
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen">
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
      </NGrid>
    </section>

    <!-- R2：洞察层 — 数据概览（Top节点 / 社区 / 结构自省） -->
    <section class="view-section">
      <div class="section-label">R2 · 洞察概览</div>
      <NGrid :cols="'1 s:1 m:2 l:3'" :x-gap="12" :y-gap="12" responsive="screen">
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
            @open-node="onCommunityOpenNode"
          />
        </NGi>
        <NGi>
          <GmProSchemaCard />
        </NGi>
      </NGrid>
    </section>

    <!-- R3：运维层 — 维护控制 -->
    <section class="view-section">
      <div class="section-label">R3 · 运维控制</div>
      <NGrid :cols="'1 s:1 m:2 l:3'" :x-gap="12" :y-gap="12" responsive="screen">
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
      </NGrid>
    </section>

    <!-- R4：配置验证层 — 检索闭环（配置 ↔ 测试 相邻） -->
    <section class="view-section">
      <div class="section-label">R4 · 检索质量闭环</div>
      <NGrid :cols="'1 s:1 m:2'" :x-gap="12" :y-gap="12" responsive="screen">
        <NGi>
          <RecallConfigCard />
        </NGi>
        <NGi>
          <RecallTestCard />
        </NGi>
      </NGrid>
    </section>

    <!-- R5：探索层 — 图谱钻取（最宽格，跨屏空间大） -->
    <section class="view-section">
      <div class="section-label">R5 · 图谱探索</div>
      <NGrid :cols="1" :x-gap="12" :y-gap="12" responsive="screen">
        <NGi>
          <GraphExplorerCard ref="explorerRef" />
        </NGi>
      </NGrid>
    </section>

    <NDivider style="margin: 16px 0 0" />
    <details class="diag-details muted">
      <summary>能力覆盖（诊断信息）</summary>
      <div class="diag-body">
        /api/status · /api/health · /api/top · /api/communities · /api/schema ·
        /api/maintain/* · /api/staleness/refresh · /api/reembed · /api/recall ·
        /api/search · /api/nodes/:id · /api/graph/walk · /api/config
      </div>
    </details>
  </div>
</template>

<style scoped>
.view { padding: 16px; }
.view-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.view-title { margin: 0; font-size: 18px; font-weight: 600; }
.view-section { margin-bottom: 16px; }
.section-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  letter-spacing: 0.4px;
  margin-bottom: 8px;
  padding-left: 2px;
  border-left: 3px solid var(--color-primary);
  line-height: 1;
  padding-top: 1px;
}
.diag-details {
  font-size: var(--fs-caption);
  padding: 0 4px;
  line-height: 1.6;
  cursor: pointer;
}
.diag-details summary {
  cursor: pointer;
  user-select: none;
}
.diag-body {
  word-break: break-word;
  padding-top: 4px;
}
</style>
