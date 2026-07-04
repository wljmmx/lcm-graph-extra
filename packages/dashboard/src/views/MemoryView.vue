<script setup lang="ts">
/**
 * 记忆查询页（模块 3）。
 *
 * 布局（设计文档 4.3 节）：
 *   顶部搜索栏 + 下方双 Tab（列表 / 图谱）+ 右侧节点详情抽屉
 *
 * 数据获取（TanStack Query）：
 *   - memory-search   跨引擎联合搜索（enabled: !!q）
 *   - memory-graph    图谱节点子集（q 变化时刷新；空 q 仍展示 top 节点）
 *
 * 搜索栏 q 为空时，列表 Tab 显示 NEmpty "请输入搜索词"，
 * 图谱 Tab 仍展示 top 节点（后端空 q 走 pagerank DESC top 路径）。
 */
import { ref, computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { NTabs, NTabPane, NEmpty, NSpin } from 'naive-ui';
import MemorySearchBar, { type MemorySearchParams } from '../components/MemorySearchBar.vue';
import MemoryResultList from '../components/MemoryResultList.vue';
import MemoryGraphView from '../components/MemoryGraphView.vue';
import NodeDetailDrawer from '../components/NodeDetailDrawer.vue';
import { fetchMemorySearch, fetchMemoryGraph } from '../api/memory';

// ===== 搜索参数（v-model 双向，搜索栏实时更新） =====
const searchParams = ref<MemorySearchParams>({
  q: '',
  engines: 'all',
  limit: 10,
});

// 已提交的搜索参数（点击搜索/回车后更新，用于触发查询）
const committedSearch = ref<MemorySearchParams>({
  q: '',
  engines: 'all',
  limit: 10,
});

// ===== Tab 切换 =====
const activeTab = ref<'list' | 'graph'>('list');

// ===== 节点详情抽屉 =====
const selectedNodeId = ref<string | null>(null);
const drawerShow = ref(false);

function handleSearch(): void {
  // 提交当前搜索参数（触发 useQuery 重新拉取）
  committedSearch.value = { ...searchParams.value };
}

function handleNodeClick(id: string): void {
  selectedNodeId.value = id;
  drawerShow.value = true;
}

// ===== 跨引擎搜索查询（仅 q 非空时启用） =====
const { data: searchData, isLoading: searchLoading } = useQuery({
  queryKey: computed(() => ['memory-search', committedSearch.value]),
  queryFn: () =>
    fetchMemorySearch(
      committedSearch.value.q,
      committedSearch.value.engines,
      committedSearch.value.limit,
    ),
  enabled: () => !!committedSearch.value.q,
});

// ===== 图谱查询（q 变化时刷新；空 q 仍展示 top 节点） =====
const { data: graphData, isLoading: graphLoading } = useQuery({
  queryKey: computed(() => [
    'memory-graph',
    committedSearch.value.q,
    committedSearch.value.limit,
  ]),
  queryFn: () => fetchMemoryGraph(committedSearch.value.q, committedSearch.value.limit),
});

// 当前选中节点对象（从 graphData 中查找）
const selectedNode = computed(() => {
  if (!selectedNodeId.value || !graphData.value) return null;
  return graphData.value.nodes.find((n) => n.id === selectedNodeId.value) ?? null;
});

// 列表 Tab 是否应显示"请输入搜索词"提示
const showEmptyPrompt = computed(
  () => !searchData.value && !committedSearch.value.q,
);
</script>

<template>
  <div class="memory-view">
    <div class="memory-header">
      <h2 style="margin: 0">记忆查询</h2>
    </div>

    <!-- 顶部搜索栏 -->
    <div class="search-bar">
      <MemorySearchBar
        v-model="searchParams"
        @search="handleSearch"
      />
    </div>

    <!-- 双 Tab：列表 / 图谱 -->
    <NTabs v-model:value="activeTab" type="line" style="margin-top: 12px">
      <!-- Tab 1: 列表 -->
      <NTabPane name="list" tab="列表">
        <NSpin v-if="searchLoading" size="small">
          <template #default>搜索中…</template>
        </NSpin>
        <NEmpty
          v-else-if="showEmptyPrompt"
          description="请输入搜索词"
        />
        <MemoryResultList
          v-else
          :results="searchData ?? null"
          :loading="searchLoading"
          :query="committedSearch.q"
        />
      </NTabPane>

      <!-- Tab 2: 图谱 -->
      <NTabPane name="graph" tab="图谱">
        <NSpin v-if="graphLoading" size="small">
          <template #default>加载图谱中…</template>
        </NSpin>
        <MemoryGraphView
          v-else
          :graph="graphData ?? null"
          :loading="graphLoading"
          :selected-id="selectedNodeId"
          @node-click="handleNodeClick"
        />
      </NTabPane>
    </NTabs>

    <!-- 节点详情抽屉 -->
    <NodeDetailDrawer
      v-model:show="drawerShow"
      :node="selectedNode"
    />
  </div>
</template>

<style scoped>
.memory-view {
  width: 100%;
}
.memory-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.search-bar {
  padding: 8px 0;
}
</style>
