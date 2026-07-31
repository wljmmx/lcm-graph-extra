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
import { ref, computed, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { NTabs, NTabPane, NEmpty, NSpin, NAlert, NButton, NSpace, NTag } from 'naive-ui';
import MemorySearchBar, { type MemorySearchParams } from '../components/MemorySearchBar.vue';
import MemoryResultList from '../components/MemoryResultList.vue';
import MemoryGraphView from '../components/MemoryGraphView.vue';
import NodeDetailDrawer from '../components/NodeDetailDrawer.vue';
import { fetchMemorySearch, fetchMemoryGraph } from '../api/memory';

// ===== P2-7: 搜索历史（localStorage 持久化，最近 10 条） =====
const SEARCH_HISTORY_KEY = 'lcm-dashboard.memory-search-history';
const MAX_HISTORY = 10;

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveSearchHistory(queries: string[]): void {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(queries.slice(0, MAX_HISTORY)));
  } catch {
    // 静默忽略（存储满或禁用）
  }
}

const searchHistory = ref<string[]>(loadSearchHistory());

/** 将新查询加入历史（去重，最新在前） */
function addToHistory(q: string): void {
  const trimmed = q.trim();
  if (!trimmed) return;
  const filtered = searchHistory.value.filter((h) => h !== trimmed);
  searchHistory.value = [trimmed, ...filtered].slice(0, MAX_HISTORY);
  saveSearchHistory(searchHistory.value);
}

/** 清除全部搜索历史 */
function clearSearchHistory(): void {
  searchHistory.value = [];
  saveSearchHistory([]);
}

/** 点击历史记录，填入搜索栏并执行搜索 */
function applyHistoryQuery(q: string): void {
  searchParams.value = { ...searchParams.value, q };
  handleSearch();
}

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
  // P2-7: 将有效查询加入搜索历史
  if (committedSearch.value.q.trim()) {
    addToHistory(committedSearch.value.q.trim());
  }
}

function handleNodeClick(id: string): void {
  selectedNodeId.value = id;
  drawerShow.value = true;
}

// ===== 跨引擎搜索查询（仅 q 非空时启用） =====
// M7 修复：placeholderData 保留旧结果（搜索中不闪烁清空列表）
const { data: searchData, isLoading: searchLoading, isError: searchIsError } = useQuery({
  queryKey: computed(() => ['memory-search', committedSearch.value]),
  queryFn: () =>
    fetchMemorySearch(
      committedSearch.value.q,
      committedSearch.value.engines,
      committedSearch.value.limit,
    ),
  enabled: () => !!committedSearch.value.q,
  placeholderData: (prev: unknown) => prev,
});

// ===== 图谱查询（q 变化时刷新；空 q 仍展示 top 节点） =====
const { data: graphData, isLoading: graphLoading, isError: graphIsError } = useQuery({
  queryKey: computed(() => [
    'memory-graph',
    committedSearch.value.q,
    committedSearch.value.limit,
  ]),
  queryFn: () => fetchMemoryGraph(committedSearch.value.q, committedSearch.value.limit),
  placeholderData: (prev: unknown) => prev,
});

const queryClient = useQueryClient();

// 重试搜索查询
function retrySearch(): void {
  void queryClient.invalidateQueries({ queryKey: ['memory-search'] });
}

// 重试图谱查询
function retryGraph(): void {
  void queryClient.invalidateQueries({ queryKey: ['memory-graph'] });
}

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

    <!-- P2-7: 搜索历史（可点击标签 + 清除按钮） -->
    <div v-if="searchHistory.length" class="search-history">
      <span class="search-history-label">最近搜索：</span>
      <NSpace :size="4" wrap>
        <NTag
          v-for="h in searchHistory"
          :key="h"
          size="small"
          :bordered="true"
          checkable
          style="cursor: pointer"
          @click="applyHistoryQuery(h)"
        >
          {{ h }}
        </NTag>
      </NSpace>
      <NButton
        size="tiny"
        quaternary
        style="margin-left: 8px; flex-shrink: 0"
        @click="clearSearchHistory"
      >
        清除
      </NButton>
    </div>

    <!-- 双 Tab：列表 / 图谱 -->
    <NTabs v-model:value="activeTab" type="line" style="margin-top: 12px">
      <!-- Tab 1: 列表 -->
      <NTabPane name="list" tab="列表">
        <NAlert
          v-if="searchIsError"
          type="error"
          title="搜索请求失败"
          style="margin-bottom: 12px"
        >
          <NSpace vertical :size="8">
            <span>无法获取搜索结果，请检查后端服务是否正常，然后重试。</span>
            <NButton size="small" type="error" @click="retrySearch">重试</NButton>
          </NSpace>
        </NAlert>
        <NSpin v-else-if="searchLoading" size="small">
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
        <NAlert
          v-if="graphIsError"
          type="error"
          title="图谱加载失败"
          style="margin-bottom: 12px"
        >
          <NSpace vertical :size="8">
            <span>无法获取图谱数据，请检查后端服务是否正常，然后重试。</span>
            <NButton size="small" type="error" @click="retryGraph">重试</NButton>
          </NSpace>
        </NAlert>
        <NSpin v-else-if="graphLoading" size="small">
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
.search-history {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  flex-wrap: wrap;
}
.search-history-label {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}
</style>
