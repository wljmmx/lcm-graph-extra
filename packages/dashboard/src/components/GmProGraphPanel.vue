<script setup lang="ts">
/**
 * GmProGraphPanel —— 图谱管理面板（graph-memory-pro API 直连）。
 *
 * 布局：
 *   概览卡片（状态 + 统计）→ 类型筛选 → Top 节点 → 搜索 → 节点详情抽屉
 *
 * 数据获取（TanStack Query）：
 *   - gm-pro-status    30s 轮询（Neo4j 连接 + 版本）
 *   - gm-pro-stats     30s 轮询（节点/关系计数）
 *   - gm-pro-top       60s 轮询（Top PageRank 节点）
 *   - gm-pro-search    手动触发（关键词搜索）
 *   - gm-pro-node      按需加载（节点详情）
 *   - gm-pro-by-type   按需加载（类型筛选）
 */
import { ref, computed, h } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  NGrid,
  NGi,
  NCard,
  NEmpty,
  NTag,
  NDescriptions,
  NDescriptionsItem,
  NAlert,
  NSpace,
  NSpin,
  NButton,
  NInput,
  NInputNumber,
  NDivider,
  NTable,
  NDrawer,
  NDrawerContent,
  NFormItem,
  useMessage,
} from 'naive-ui';
import KpiCard from './KpiCard.vue';
import {
  fetchGmProStatus,
  fetchGmProStats,
  fetchGmProHealth,
  fetchGmProTop,
  fetchGmProSearch,
  fetchGmProNode,
  fetchGmProNodesByType,
  fetchGmProDirtyNodes,
  fetchGmProNodeEdges,
  fetchGmProNodeFeedbackStats,
  type GmProStatus,
  type GmProStats,
  type GmProHealth,
  type GmProNode,
  type GmProNodeType,
  type GmProProxyResponse,
  type GmProNodeEdgesResult,
  type GmProNodeFeedbackStats,
} from '../api/gm-pro';
import { useBreakpoints } from '../composables/useBreakpoints';

const message = useMessage();
const queryClient = useQueryClient();
const breakpoints = useBreakpoints({ xs: 0, s: 640, m: 768, l: 1024, xl: 1280 });
const isNarrowScreen = breakpoints.smaller('m');

// ===== 数据获取（轮询，关闭自动重试避免大量错误日志） =====
const { data: statusRes, isLoading: statusLoading, isError: statusError } = useQuery({
  queryKey: ['gm-pro-status'],
  queryFn: fetchGmProStatus,
  refetchInterval: 30_000,
  staleTime: 15_000,
  retry: 1,
  retryDelay: 2000,
});
const { data: statsRes, isLoading: statsLoading } = useQuery({
  queryKey: ['gm-pro-stats'],
  queryFn: fetchGmProStats,
  refetchInterval: 30_000,
  staleTime: 15_000,
  retry: 1,
  retryDelay: 2000,
});
const { data: healthRes, isLoading: healthLoading } = useQuery({
  queryKey: ['gm-pro-health'],
  queryFn: fetchGmProHealth,
  refetchInterval: 60_000,
  staleTime: 30_000,
  retry: 1,
  retryDelay: 2000,
});
const { data: topRes, isLoading: topLoading } = useQuery({
  queryKey: ['gm-pro-top'],
  queryFn: () => fetchGmProTop(20),
  refetchInterval: 60_000,
  staleTime: 30_000,
  retry: 1,
  retryDelay: 2000,
});
const { data: dirtyRes } = useQuery({
  queryKey: ['gm-pro-dirty-nodes'],
  queryFn: fetchGmProDirtyNodes,
  refetchInterval: 120_000,
  staleTime: 60_000,
  retry: 1,
  retryDelay: 2000,
});

// ===== 派生数据 =====
const status = computed<GmProStatus | null>(() => statusRes.value?.ok ? (statusRes.value.data ?? null) : null);
const stats = computed<GmProStats | null>(() => statsRes.value?.ok ? (statsRes.value.data ?? null) : null);
const health = computed<GmProHealth | null>(() => healthRes.value?.ok ? (healthRes.value.data ?? null) : null);
/** 从 gm-pro 响应中提取节点数组（兼容 { nodes: [...] } 和 [...] 两种格式） */
function extractNodes(data: unknown): any[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object' && Array.isArray((data as any).nodes)) return (data as any).nodes;
  return [];
}

const topNodes = computed(() => topRes.value?.ok ? extractNodes(topRes.value.data) : []);
const dirtyCount = computed(() => dirtyRes.value?.ok ? (dirtyRes.value.data?.count ?? 0) : 0);
const dirtyNodeIds = computed(() => dirtyRes.value?.ok ? (dirtyRes.value.data?.nodeIds ?? []) : []);

// 全局错误状态：代理返回 { ok: false, error } 或 HTTP 请求失败
const globalError = computed(() => {
  // 代理返回了结构化错误（HTTP 200 但 ok: false）
  if (statusRes.value && !statusRes.value.ok) {
    return statusRes.value.error ?? 'graph-memory-pro 返回异常';
  }
  // TanStack Query 捕获的 HTTP 错误（fetch 失败等）
  if (statusError.value) {
    return 'graph-memory-pro 状态查询失败';
  }
  return null;
});
const hasAnyError = computed(() => {
  if (statusError.value) return true;
  if (statusRes.value && !statusRes.value.ok) return true;
  return false;
});

const neo4jConnected = computed(() => status.value?.status === 'connected');
const neo4jStatusTagType = computed(() => neo4jConnected.value ? 'success' : 'error');
const kpiCols = computed(() => isNarrowScreen.value ? '1 s:2' : '2 s:2 m:4');

// 重试所有查询
function handleRetryAll(): void {
  queryClient.invalidateQueries({ queryKey: ['gm-pro-status'] });
  queryClient.invalidateQueries({ queryKey: ['gm-pro-stats'] });
  queryClient.invalidateQueries({ queryKey: ['gm-pro-health'] });
  queryClient.invalidateQueries({ queryKey: ['gm-pro-top'] });
  queryClient.invalidateQueries({ queryKey: ['gm-pro-dirty-nodes'] });
}

// ===== 类型筛选 =====
const activeTypeFilter = ref<GmProNodeType | null>(null);
const typeFilterData = ref<GmProProxyResponse | null>(null);
const typeFilterLoading = ref(false);

const typeOptions: { label: string; value: GmProNodeType; count?: number }[] = [
  { label: 'TASK', value: 'TASK' },
  { label: 'SKILL', value: 'SKILL' },
  { label: 'EVENT', value: 'EVENT' },
];

async function handleTypeFilter(type: GmProNodeType): void {
  if (activeTypeFilter.value === type) {
    activeTypeFilter.value = null;
    typeFilterData.value = null;
    return;
  }
  activeTypeFilter.value = type;
  typeFilterLoading.value = true;
  try {
    typeFilterData.value = await fetchGmProNodesByType(type, 50);
  } catch (err: any) {
    message.error(`类型筛选失败: ${err?.message ?? String(err)}`);
  } finally {
    typeFilterLoading.value = false;
  }
}

const typeFilterNodes = computed(() => {
  if (!typeFilterData.value?.ok) return [];
  return extractNodes(typeFilterData.value.data);
});

// ===== 搜索 =====
const searchQuery = ref('');
const searchLimit = ref(10);
const searchLoading = ref(false);
const searchResult = ref<GmProProxyResponse | null>(null);
const searchExecuted = ref(false);

async function handleSearch(): void {
  const q = searchQuery.value.trim();
  if (!q) {
    message.warning('请输入搜索关键词');
    return;
  }
  searchLoading.value = true;
  searchExecuted.value = true;
  try {
    searchResult.value = await fetchGmProSearch({ query: q, limit: searchLimit.value });
  } catch (err: any) {
    message.error(`搜索失败: ${err?.message ?? String(err)}`);
  } finally {
    searchLoading.value = false;
  }
}

const searchNodes = computed(() => {
  if (!searchResult.value?.ok) return [];
  return extractNodes(searchResult.value.data);
});
const searchEdges = computed(() => {
  if (!searchResult.value?.ok) return [];
  return (searchResult.value.data as any)?.edges ?? [];
});

// ===== 节点详情 =====
const selectedNodeId = ref<string | null>(null);
const nodeDetailLoading = ref(false);
const nodeDetail = ref<GmProNode | null>(null);
const nodeDetailError = ref(false);
const nodeEdges = ref<GmProNodeEdgesResult | null>(null);
const nodeFeedbackStats = ref<GmProNodeFeedbackStats | null>(null);
const drawerShow = ref(false);

async function handleNodeClick(id: string): void {
  selectedNodeId.value = id;
  drawerShow.value = true;
  nodeDetailLoading.value = true;
  nodeDetailError.value = false;
  nodeDetail.value = null;
  nodeEdges.value = null;
  nodeFeedbackStats.value = null;
  try {
    // 并行获取节点详情、关联边和反馈统计
    const [nodeRes, edgesRes, feedbackRes] = await Promise.all([
      fetchGmProNode(id),
      fetchGmProNodeEdges(id),
      fetchGmProNodeFeedbackStats(id),
    ]);
    if (nodeRes.ok) {
      nodeDetail.value = nodeRes.data as GmProNode;
    } else {
      nodeDetailError.value = true;
    }
    if (edgesRes.ok) {
      nodeEdges.value = edgesRes.data as GmProNodeEdgesResult;
    }
    if (feedbackRes.ok) {
      nodeFeedbackStats.value = feedbackRes.data as GmProNodeFeedbackStats;
    }
  } catch {
    nodeDetailError.value = true;
  } finally {
    nodeDetailLoading.value = false;
  }
}

function closeDrawer(): void {
  drawerShow.value = false;
}

// 搜索表格列
const searchColumns = computed(() => [
  { title: 'ID', key: 'id', width: 120, ellipsis: { tooltip: true }, render: (row: any) => h('span', { class: 'mono', style: 'font-size:12px' }, row.id?.slice(0, 12) + '…') },
  { title: '名称', key: 'name', ellipsis: { tooltip: true } },
  { title: '类型', key: 'type', width: 80, render: (row: any) => h(NTag, { size: 'tiny' }, { default: () => row.type ?? '—' }) },
  { title: '操作', key: 'actions', width: 60, render: (row: any) => h(NButton, { size: 'tiny', quaternary: true, onClick: () => handleNodeClick(row.id) }, { default: () => '详情' }) },
]);

// 类型筛选表格列
const typeFilterColumns = computed(() => [
  { title: 'ID', key: 'id', width: 120, ellipsis: { tooltip: true }, render: (row: any) => h('span', { class: 'mono', style: 'font-size:12px' }, row.id?.slice(0, 12) + '…') },
  { title: '名称', key: 'name', ellipsis: { tooltip: true } },
  { title: '操作', key: 'actions', width: 60, render: (row: any) => h(NButton, { size: 'tiny', quaternary: true, onClick: () => handleNodeClick(row.id) }, { default: () => '详情' }) },
]);

// ===== 辅助函数 =====
import { formatDateTime } from '../utils/format';

function formatPagerank(v: number | undefined): string {
  return v !== undefined ? v.toFixed(4) : '—';
}
</script>

<template>
  <div class="gm-pro-panel">
    <!-- ===== 全局错误提示 ===== -->
    <NAlert
      v-if="hasAnyError"
      type="warning"
      :show-icon="true"
      title="graph-memory-pro 未连接"
      style="margin-bottom: 12px"
    >
      <template #default>
        <div>{{ globalError || 'graph-memory-pro 服务不可达，请检查服务是否已启动' }}</div>
        <div style="margin-top: 6px; font-size: var(--fs-caption); color: var(--color-text-tertiary)">
          提示：graph-memory-pro 使用独立 HTTP API 服务器（默认 http://127.0.0.1:7850）。
          请确认 graph-memory-pro 插件已启动且 apiServer 已启用。
        </div>
      </template>
      <template #footer>
        <NButton size="small" type="warning" @click="handleRetryAll">重试连接</NButton>
      </template>
    </NAlert>

    <!-- ===== 概览 KPI 行 ===== -->
    <NGrid :cols="kpiCols" :x-gap="12" :y-gap="12" responsive="screen">
      <NGi>
        <KpiCard
          label="Neo4j"
          :value="neo4jConnected ? '已连接' : '未连接'"
          :loading="statusLoading"
        >
          <template #detail>
            <NSpace :size="4">
              <NTag :type="neo4jStatusTagType" size="tiny">
                {{ status?.status ?? '—' }}
              </NTag>
              <span v-if="status?.version" class="muted" style="font-size:var(--fs-caption)">
                v{{ status.version }}
              </span>
            </NSpace>
          </template>
        </KpiCard>
      </NGi>
      <NGi>
        <KpiCard
          label="节点总数"
          :value="stats?.nodeCount ?? '—'"
          :loading="statsLoading"
        />
      </NGi>
      <NGi>
        <KpiCard
          label="关系总数"
          :value="stats?.edgeCount ?? '—'"
          :loading="statsLoading"
        />
      </NGi>
      <NGi>
        <KpiCard
          label="脏节点"
          :value="dirtyCount"
          :loading="false"
          :threshold="0"
          reverse-indicator
        >
          <template #detail>
            <span v-if="dirtyNodeIds.length" class="muted" style="font-size:var(--fs-caption)">
              {{ dirtyNodeIds.slice(0, 3).join(', ') }}{{ dirtyNodeIds.length > 3 ? '…' : '' }}
            </span>
            <span v-else class="muted" style="font-size:var(--fs-caption)">无待维护节点</span>
          </template>
        </KpiCard>
      </NGi>
    </NGrid>

    <!-- ===== 健康概览 ===== -->
    <NCard v-if="health" title="图谱健康" size="small" style="margin-top: 12px">
      <template #header-extra>
        <NTag :type="health.anomalies?.length ? 'warning' : 'success'" size="small">
          {{ health.anomalies?.length ? `${health.anomalies.length} 项异常` : '无异常' }}
        </NTag>
      </template>
      <NGrid :cols="isNarrowScreen ? '1 s:2' : '2 s:3 m:5'" :x-gap="12" :y-gap="8" responsive="screen">
        <NGi>
          <div class="health-stat">
            <span class="health-stat-label">活跃节点</span>
            <span class="health-stat-value">{{ health.nodes?.active ?? '—' }} / {{ health.nodes?.total ?? '—' }}</span>
          </div>
        </NGi>
        <NGi>
          <div class="health-stat">
            <span class="health-stat-label">孤立节点</span>
            <span class="health-stat-value" :class="{ 'text-warning': (health.isolatedNodes ?? 0) > 0 }">{{ health.isolatedNodes ?? '—' }}</span>
          </div>
        </NGi>
        <NGi>
          <div class="health-stat">
            <span class="health-stat-label">高过时节点</span>
            <span class="health-stat-value" :class="{ 'text-danger': (health.highStaleNodes ?? 0) > 0 }">{{ health.highStaleNodes ?? '—' }}</span>
          </div>
        </NGi>
        <NGi>
          <div class="health-stat">
            <span class="health-stat-label">社区数</span>
            <span class="health-stat-value">{{ health.communities ?? '—' }}</span>
          </div>
        </NGi>
        <NGi>
          <div class="health-stat">
            <span class="health-stat-label">平均 PageRank</span>
            <span class="health-stat-value mono">{{ health.avgPageRank?.toFixed(4) ?? '—' }}</span>
          </div>
        </NGi>
      </NGrid>
      <!-- 异常详情 -->
      <div v-if="health.anomalies?.length" style="margin-top: 8px">
        <NSpace :size="4">
          <NTag v-for="a in health.anomalies" :key="a" size="small" type="warning">{{ a }}</NTag>
        </NSpace>
      </div>
      <!-- 熔断器状态 -->
      <div v-if="health.circuitBreakers" style="margin-top: 8px">
        <NDivider style="margin: 8px 0">熔断器</NDivider>
        <div v-for="(cb, name) in health.circuitBreakers" :key="name" style="display:flex;align-items:center;gap:8px;padding:2px 0">
          <span class="mono" style="font-size:var(--fs-caption);min-width:60px">{{ name }}</span>
          <NTag :type="(cb as any).open ? 'error' : 'success'" size="tiny">
            {{ (cb as any).open ? 'OPEN' : 'CLOSED' }}
          </NTag>
          <span class="muted" style="font-size:var(--fs-caption)">failures: {{ (cb as any).failures ?? 0 }}</span>
        </div>
      </div>
    </NCard>
    <NSpin v-else-if="healthLoading" size="small" style="display:block;padding:24px 0;text-align:center">
      加载健康数据中…
    </NSpin>

    <!-- ===== 类型筛选 ===== -->
    <NCard title="按类型筛选" size="small" style="margin-top: 12px">
      <NSpace :size="8">
        <NTag
          v-for="opt in typeOptions"
          :key="opt.value"
          :type="activeTypeFilter === opt.value ? 'info' : 'default'"
          checkable
          :checked="activeTypeFilter === opt.value"
          style="cursor: pointer"
          @click="handleTypeFilter(opt.value)"
        >
          {{ opt.label }}
        </NTag>
      </NSpace>
      <!-- 筛选结果 -->
      <div v-if="activeTypeFilter" style="margin-top: 8px">
        <NSpin v-if="typeFilterLoading" size="small" />
        <template v-else-if="typeFilterNodes.length">
          <NTable
            :data="typeFilterNodes"
            :columns="typeFilterColumns"
            :bordered="false"
            :single-line="false"
            size="small"
            :max-height="300"
            striped
          />
        </template>
        <NEmpty v-else description="该类型无节点" style="padding:12px 0" />
      </div>
    </NCard>

    <!-- ===== Top 节点 ===== -->
    <NCard title="Top 节点 (PageRank)" size="small" style="margin-top: 12px">
      <NSpin v-if="topLoading" size="small" />
      <template v-else-if="topNodes.length">
        <NTable
          :data="topNodes"
          :columns="[
            { title: '#', key: 'rank', width: 40, render: (_r: any, idx: number) => h('span', { class: 'mono muted' }, String(idx + 1)) },
            { title: '名称', key: 'name', ellipsis: { tooltip: true } },
            { title: '类型', key: 'type', width: 80, render: (row: any) => h(NTag, { size: 'tiny' }, { default: () => row.type ?? '—' }) },
            { title: 'PageRank', key: 'pagerank', width: 100, render: (row: any) => h('span', { class: 'mono' }, formatPagerank(row.pagerank)) },
            { title: '操作', key: 'actions', width: 60, render: (row: any) => h(NButton, { size: 'tiny', quaternary: true, onClick: () => handleNodeClick(row.id) }, { default: () => '详情' }) },
          ]"
          :bordered="false"
          :single-line="false"
          size="small"
          :max-height="400"
          striped
        />
      </template>
      <NEmpty v-else description="无 Top 节点数据" style="padding:12px 0" />
    </NCard>

    <!-- ===== 图谱搜索 ===== -->
    <NCard title="图谱搜索" size="small" style="margin-top: 12px">
      <NSpace align="end" :wrap="true">
        <NFormItem label="关键词" size="small" :show-feedback="false">
          <NInput
            v-model:value="searchQuery"
            size="small"
            placeholder="输入节点名称或描述关键词"
            style="width: 240px"
            clearable
            @keyup.enter="handleSearch"
          />
        </NFormItem>
        <NFormItem label="返回条数" size="small" :show-feedback="false">
          <NInputNumber
            v-model:value="searchLimit"
            :min="1"
            :max="50"
            size="small"
            style="width: 80px"
          />
        </NFormItem>
        <NButton
          type="primary"
          size="small"
          :loading="searchLoading"
          @click="handleSearch"
        >
          搜索
        </NButton>
      </NSpace>

      <NAlert
        v-if="searchResult && !searchResult.ok"
        type="error"
        style="margin-top: 8px"
      >
        {{ searchResult.error ?? '搜索失败' }}
      </NAlert>

      <div v-if="searchExecuted" style="margin-top: 8px">
        <NSpin v-if="searchLoading" size="small" />
        <template v-else-if="searchNodes.length">
          <div style="margin-bottom: 4px;font-size:var(--fs-caption);color:var(--color-text-tertiary)">
            找到 {{ searchNodes.length }} 个节点，{{ searchEdges.length }} 条关系
          </div>
          <NTable
            :data="searchNodes"
            :columns="searchColumns"
            :bordered="false"
            :single-line="false"
            size="small"
            :max-height="400"
            striped
          />
        </template>
        <NEmpty
          v-else-if="searchResult?.ok"
          description="未找到匹配节点"
          style="padding:12px 0"
        />
      </div>
    </NCard>

    <!-- ===== 节点详情抽屉 ===== -->
    <NDrawer
      :show="drawerShow"
      :width="isNarrowScreen ? '100%' : 480"
      placement="right"
      :trap-focus="true"
      :auto-focus="true"
      :close-on-esc="true"
      role="dialog"
      aria-modal="true"
      aria-label="节点详情"
      @update:show="(v: boolean) => drawerShow = v"
    >
      <NDrawerContent title="节点详情" closable>
        <NAlert
          v-if="nodeDetailError"
          type="error"
          :show-icon="true"
          title="节点详情加载失败"
        >
          查询失败，请稍后重试。
        </NAlert>
        <NSpin v-else-if="nodeDetailLoading" size="small">
          <template #default>加载中…</template>
        </NSpin>
        <template v-else-if="nodeDetail">
          <NDescriptions
            :column="1"
            bordered
            size="small"
            label-placement="left"
            aria-label="节点详情"
          >
            <NDescriptionsItem label="ID">
              <span class="mono">{{ nodeDetail.id }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="名称">{{ nodeDetail.name ?? '—' }}</NDescriptionsItem>
            <NDescriptionsItem label="类型">
              <NTag size="small">{{ nodeDetail.type ?? '—' }}</NTag>
            </NDescriptionsItem>
            <NDescriptionsItem v-if="nodeDetail.description" label="描述">
              {{ nodeDetail.description }}
            </NDescriptionsItem>
            <NDescriptionsItem v-if="nodeDetail.content" label="内容">
              <div style="max-height:200px;overflow-y:auto;white-space:pre-wrap;font-size:var(--fs-caption)">
                {{ nodeDetail.content }}
              </div>
            </NDescriptionsItem>
            <NDescriptionsItem label="PageRank">
              <span class="mono">{{ formatPagerank(nodeDetail.pagerank) }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem v-if="nodeDetail.communityId" label="社区">
              <span class="mono">{{ nodeDetail.communityId }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem v-if="nodeDetail.createdAt" label="创建时间">
              <span class="mono">{{ formatDateTime(nodeDetail.createdAt) }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem v-if="nodeDetail.updatedAt" label="更新时间">
              <span class="mono">{{ formatDateTime(nodeDetail.updatedAt) }}</span>
            </NDescriptionsItem>
          </NDescriptions>

          <!-- 反馈统计 -->
          <NDivider v-if="nodeFeedbackStats" style="margin: 12px 0 8px">反馈统计</NDivider>
          <NDescriptions
            v-if="nodeFeedbackStats"
            :column="2"
            bordered
            size="small"
            label-placement="left"
          >
            <NDescriptionsItem label="反馈次数">
              <span class="mono">{{ nodeFeedbackStats.feedbackCount ?? '—' }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="平均评分">
              <NTag size="small" :type="(nodeFeedbackStats.avgScore ?? 0) >= 0.7 ? 'success' : (nodeFeedbackStats.avgScore ?? 0) >= 0.4 ? 'warning' : 'error'">
                {{ nodeFeedbackStats.avgScore?.toFixed(3) ?? '—' }}
              </NTag>
            </NDescriptionsItem>
          </NDescriptions>

          <!-- 关联边 -->
          <NDivider v-if="nodeEdges" style="margin: 12px 0 8px">
            关联关系 ({{ nodeEdges.edges?.length ?? 0 }} 条)
          </NDivider>
          <div v-if="nodeEdges?.edges?.length" style="max-height:200px;overflow-y:auto">
            <div
              v-for="(edge, idx) in nodeEdges.edges"
              :key="idx"
              style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:var(--fs-caption);border-bottom:1px solid var(--color-border-subtle)"
            >
              <NTag size="tiny" :bordered="false">{{ edge.type ?? 'RELATED' }}</NTag>
              <span class="mono" style="font-size:11px;color:var(--color-text-tertiary)">
                {{ edge.source === nodeDetail?.id ? '→' : '←' }}
                {{ edge.source === nodeDetail?.id ? (edge.target?.slice(0, 16) + (edge.target?.length > 16 ? '…' : '')) : (edge.source?.slice(0, 16) + (edge.source?.length > 16 ? '…' : '')) }}
              </span>
            </div>
          </div>
          <NEmpty v-else-if="nodeEdges" description="无关联关系" style="padding:8px 0" size="small" />
        </template>
        <NEmpty v-else description="未选中节点" />

        <template #footer>
          <NButton size="small" aria-label="关闭节点详情抽屉" @click="closeDrawer">关闭</NButton>
        </template>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.gm-pro-panel {
  width: 100%;
}

.health-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
}
.health-stat-label {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
}
.health-stat-value {
  font-size: var(--fs-body);
  font-weight: 600;
}
.text-warning {
  color: var(--color-warning);
}
.text-danger {
  color: var(--color-danger);
}
</style>