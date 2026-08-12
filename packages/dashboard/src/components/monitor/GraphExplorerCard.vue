<script setup lang="ts">
/**
 * 图谱探索器（P0 核心能力）。
 *
 * 解决能力断链：graph-memory-pro 已有 search / nodes/:id / nodes-by-type / graph/walk
 * 等系列探索 API，但 dashboard 无对应交互入口，用户只能被动看 Top10。
 *
 * 信息架构（渐进式披露，4 级钻取）：
 *   L1 搜索栏       → query + 类型过滤 → 调用 /api/search
 *   L2 结果列表     → 节点卡片（名称/类型/社区/PR）
 *   L3 节点抽屉     → 点击节点 → 右侧抽屉展示 /api/nodes/:id + edges + feedback-stats
 *   L4 邻域探索     → 抽屉内「探索邻域」按钮 → /api/graph/walk → 可继续点邻域节点
 *
 * UI/UX 原则：
 *   - 永不阻塞主流程：搜索失败不影响现有 Top10 浏览
 *   - 上下文操作：搜索结果和邻域结果都可直接继续钻取，不强制回到搜索
 *   - 抽屉保持上下文：邻域探索在同一抽屉内翻页，避免多模态堆叠
 *   - 视觉降噪：节点描述默认两行截断，需要时展开
 */
import { computed, ref, watch } from 'vue';
import {
  NCard, NButton, NInput, NSelect, NTag, NDrawer, NDrawerContent,
  NH3, NDescriptions, NDescriptionsItem, NDivider, NEmpty, NSpin,
  NPopover, useMessage, type SelectOption,
} from 'naive-ui';
import CardState from './CardState.vue';
import {
  fetchGmProSearch,
  fetchGmProNode,
  fetchGmProNodeEdges,
  fetchGmProNodeFeedbackStats,
  fetchGmProGraphWalk,
  fetchGmProNodesByType,
  type GmProSearchResult,
  type GmProNode,
  type GmProNodeEdgesResult,
  type GmProNodeFeedbackStats,
  type GmProGraphWalkResult,
  type GmProNodeType,
} from '../../api/gm-pro';

const message = useMessage();

// ─── L1: 搜索栏状态 ────────────────────────────────────────────
const query = ref('');
const typeFilter = ref<GmProNodeType | 'all'>('all');
const searching = ref(false);
const searchError = ref<string | null>(null);
const searchResult = ref<GmProSearchResult | null>(null);

const typeOptions: SelectOption[] = [
  { label: '全部类型', value: 'all' },
  { label: '任务 (TASK)', value: 'TASK' },
  { label: '技能 (SKILL)', value: 'SKILL' },
  { label: '事件 (EVENT)', value: 'EVENT' },
];

/** 执行搜索。空 query 时回落到按类型浏览，避免空界面。 */
async function runSearch(): Promise<void> {
  searching.value = true;
  searchError.value = null;
  try {
    const q = query.value.trim();
    if (!q && typeFilter.value !== 'all') {
      // 无关键词但选了类型 → 按类型浏览
      const res = await fetchGmProNodesByType(typeFilter.value, 50);
      if (res.ok) {
        searchResult.value = { nodes: res.data?.nodes, total: res.data?.nodes?.length };
      } else {
        searchError.value = res.error || '请求失败';
        searchResult.value = null;
      }
    } else if (q) {
      const res = await fetchGmProSearch({ query: q, limit: 50 });
      if (res.ok) {
        searchResult.value = res.data ?? null;
      } else {
        searchError.value = res.error || '请求失败';
        searchResult.value = null;
      }
    } else {
      searchResult.value = null;
    }
  } catch (err: any) {
    searchError.value = err?.message || String(err);
    searchResult.value = null;
  } finally {
    searching.value = false;
  }
}

const searchNodes = computed<GmProNode[]>(() => {
  const raw = searchResult.value?.nodes ?? [];
  if (typeFilter.value === 'all') return raw;
  return raw.filter((n) => n.type === typeFilter.value);
});

const searchHasResult = computed(() => searchResult.value != null && !searching.value);

function nodeTypeTagType(t?: string): 'success' | 'warning' | 'info' | 'default' {
  switch (t) {
    case 'TASK': return 'warning';
    case 'SKILL': return 'info';
    case 'EVENT': return 'success';
    default: return 'default';
  }
}

// ─── L3: 节点抽屉状态 ──────────────────────────────────────────
const drawerOpen = ref(false);
const drawerLoading = ref(false);
const currentNode = ref<GmProNode | null>(null);
const currentEdges = ref<GmProNodeEdgesResult | null>(null);
const currentFeedback = ref<GmProNodeFeedbackStats | null>(null);

/** 抽屉浏览历史：支持邻域探索后「返回」 */
type BreadcrumbItem = { id: string; name?: string };
const breadcrumb = ref<BreadcrumbItem[]>([]);

async function openNode(nodeId: string, fromBreadcrumb = false): Promise<void> {
  // 保存当前节点到面包屑（点击邻域跳转时）
  if (!fromBreadcrumb && currentNode.value) {
    breadcrumb.value.push({ id: currentNode.value.id, name: currentNode.value.name });
  }

  drawerOpen.value = true;
  drawerLoading.value = true;
  currentNode.value = null;
  currentEdges.value = null;
  currentFeedback.value = null;
  walkResult.value = null;
  walking.value = false;

  try {
    const [nodeRes, edgesRes, fbRes] = await Promise.all([
      fetchGmProNode(nodeId),
      fetchGmProNodeEdges(nodeId),
      fetchGmProNodeFeedbackStats(nodeId).catch(() => ({ ok: true })), // feedback 可选，失败不阻塞
    ]);
    if (nodeRes.ok) currentNode.value = nodeRes.data ?? null;
    if (edgesRes.ok) currentEdges.value = edgesRes.data ?? null;
    if (fbRes.ok) currentFeedback.value = (fbRes.data as GmProNodeFeedbackStats) ?? null;

    if (!nodeRes.ok) message.error(`节点加载失败: ${nodeRes.error || '未知错误'}`);
  } catch (err: any) {
    message.error(`节点加载失败: ${err?.message || String(err)}`);
  } finally {
    drawerLoading.value = false;
  }
}

/** 从面包屑后退 */
function navigateBack(idx: number): void {
  const item = breadcrumb.value[idx];
  if (!item) return;
  breadcrumb.value = breadcrumb.value.slice(0, idx);
  openNode(item.id, true);
}

/** 关闭抽屉：清空所有状态 */
function closeDrawer(): void {
  drawerOpen.value = false;
  currentNode.value = null;
  currentEdges.value = null;
  currentFeedback.value = null;
  walkResult.value = null;
  breadcrumb.value = [];
}

// ─── L4: 邻域探索（GraphWalk） ─────────────────────────────────
const walking = ref(false);
const walkResult = ref<GmProGraphWalkResult | null>(null);
const walkDepth = ref(2);
const walkMaxNodes = ref(30);

async function runWalk(): Promise<void> {
  if (!currentNode.value) return;
  walking.value = true;
  try {
    const res = await fetchGmProGraphWalk({
      seedIds: [currentNode.value.id],
      depth: walkDepth.value,
      maxNodes: walkMaxNodes.value,
    });
    if (res.ok) {
      walkResult.value = res.data ?? null;
    } else {
      message.error(`邻域探索失败: ${res.error || '未知错误'}`);
      walkResult.value = null;
    }
  } catch (err: any) {
    message.error(`邻域探索失败: ${err?.message || String(err)}`);
    walkResult.value = null;
  } finally {
    walking.value = false;
  }
}

/** 排除 seed 自身，展示实际邻域节点 */
const walkNeighbors = computed<GmProNode[]>(() => {
  const seed = currentNode.value?.id;
  return (walkResult.value?.nodes ?? []).filter((n) => n.id !== seed);
});

/** 邻域边按类型分组，供快速判断关系构成 */
const walkEdgeTypes = computed<Array<{ type: string; count: number }>>(() => {
  const edges = walkResult.value?.edges ?? [];
  const map = new Map<string, number>();
  for (const e of edges) {
    const t = e.type || 'UNKNOWN';
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
});

// ─── 辅助格式化 ────────────────────────────────────────────────
function fmtTs(ts?: number): string {
  if (ts == null) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

// ─── 对外暴露：父视图可桥接社区成员点击等外部钻取请求 ─────────
defineExpose({
  /** 从任意来源打开节点详情（支持 CommunitiesCard @openNode 桥接） */
  openNode,
  /** 设置搜索框关键词并自动执行搜索（支持父组件外部触发） */
  async searchFor(q: string): Promise<void> {
    query.value = q;
    await runSearch();
  },
});
</script>

<template>
  <NCard size="small">
    <template #header>
      <span>图谱探索</span>
      <NTag size="tiny" :bordered="false" type="success" style="margin-left:8px">search · walk</NTag>
    </template>
    <template #header-extra>
      <span class="muted" style="font-size:var(--fs-caption)">
        搜索 / 按类型浏览 → 钻取节点 → 探索邻域
      </span>
    </template>

    <!-- L1: 搜索栏 -->
    <div class="search-bar">
      <NInput
        v-model:value="query"
        placeholder="输入关键词搜索节点（留空则按类型浏览）"
        clearable
        size="small"
        @keyup.enter="runSearch"
      />
      <NSelect
        v-model:value="typeFilter"
        :options="typeOptions"
        size="small"
        style="width: 160px; flex-shrink: 0"
      />
      <NButton size="small" type="primary" :loading="searching" @click="runSearch">
        搜索
      </NButton>
    </div>

    <!-- 搜索结果区（用 CardState 统一处理 loading/error/empty） -->
    <div style="margin-top: 8px">
      <CardState
        :loading="searching"
        :is-error="!!searchError"
        :has-data="searchHasResult && searchNodes.length > 0"
        empty-text="输入关键词或选择类型开始探索图谱"
        :error-text="searchError ?? undefined"
        empty-hint="支持 TASK / SKILL / EVENT 三种类型；空关键词按类型浏览最多 50 个。"
      >
        <template v-if="searchHasResult">
          <div class="result-header-row">
            <NTag size="small" :bordered="false">命中 {{ searchNodes.length }} 个节点</NTag>
            <span
              v-if="searchResult?.total && searchResult.total !== searchNodes.length"
              class="muted"
              style="font-size:var(--fs-caption)"
            >
              （类型过滤前共 {{ searchResult.total }} 条）
            </span>
          </div>
        </template>
      </CardState>
    </div>

    <!-- L2: 搜索结果列表 -->
    <div v-if="searchNodes.length" class="node-list">
      <div
        v-for="n in searchNodes"
        :key="n.id"
        class="node-card"
        @click="openNode(n.id)"
        :title="'查看节点详情：' + (n.name || n.id)"
      >
        <div class="node-card-head">
          <NTag size="tiny" :type="nodeTypeTagType(n.type)" :bordered="false">{{ n.type || '?' }}</NTag>
          <span class="node-name">{{ n.name || '(未命名)' }}</span>
          <span class="node-pr" v-if="n.pagerank != null">PR {{ n.pagerank.toFixed(4) }}</span>
        </div>
        <div v-if="n.description" class="node-desc">{{ n.description }}</div>
        <div class="node-card-foot">
          <span v-if="n.communityId" class="muted mono" style="font-size:var(--fs-caption)">
            社区 {{ n.communityId.slice(0, 8) }}
          </span>
          <span class="muted" style="font-size:var(--fs-caption);margin-left:auto">点击查看详情 →</span>
        </div>
      </div>
    </div>

    <!-- L3/L4: 节点详情抽屉 -->
    <NDrawer
      v-model:show="drawerOpen"
      :width="560"
      placement="right"
      :mask-closable="true"
      @after-leave="closeDrawer"
    >
      <NDrawerContent title="节点详情" :native-scrollbar="false">
        <!-- 面包屑：邻域探索返回链 -->
        <div v-if="breadcrumb.length" class="breadcrumb-row">
          <span
            v-for="(bc, idx) in breadcrumb"
            :key="idx"
            class="crumb"
            @click="navigateBack(idx)"
          >
            {{ bc.name || bc.id.slice(0, 8) }}
          </span>
          <span class="crumb-sep">›</span>
          <span class="crumb current">{{ currentNode?.name || currentNode?.id?.slice(0, 8) }}</span>
        </div>

        <div v-if="drawerLoading" class="drawer-loading"><NSpin size="medium" /></div>

        <template v-else-if="currentNode">
          <NH3 style="margin:0 0 4px">{{ currentNode.name || '(未命名节点)' }}</NH3>
          <div class="node-sub-row">
            <NTag size="small" :type="nodeTypeTagType(currentNode.type)" :bordered="false">
              {{ currentNode.type || 'UNTYPED' }}
            </NTag>
            <span class="mono muted" style="font-size:var(--fs-caption)">ID: {{ currentNode.id }}</span>
          </div>

          <NDivider>基本信息</NDivider>
          <NDescriptions :column="1" size="small" label-placement="left" bordered>
            <NDescriptionsItem label="PageRank">
              <span class="mono">{{ currentNode.pagerank?.toFixed(4) ?? '—' }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="社区">
              <span v-if="currentNode.communityId" class="mono">{{ currentNode.communityId }}</span>
              <span v-else class="muted">—</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="创建时间">{{ fmtTs(currentNode.createdAt) }}</NDescriptionsItem>
            <NDescriptionsItem label="更新时间">{{ fmtTs(currentNode.updatedAt) }}</NDescriptionsItem>
          </NDescriptions>

          <div v-if="currentNode.description" style="margin-top: 8px">
            <div class="muted" style="font-size:var(--fs-caption);margin-bottom:2px">描述</div>
            <div class="node-content">{{ currentNode.description }}</div>
          </div>
          <div v-if="currentNode.content" style="margin-top: 8px">
            <div class="muted" style="font-size:var(--fs-caption);margin-bottom:2px">内容 / 记忆片段</div>
            <div class="node-content">{{ currentNode.content }}</div>
          </div>

          <!-- 反馈统计 -->
          <NDivider v-if="currentFeedback && currentFeedback.feedbackCount">用户反馈</NDivider>
          <NDescriptions v-if="currentFeedback && currentFeedback.feedbackCount" :column="2" size="small" label-placement="left" bordered>
            <NDescriptionsItem label="反馈次数">
              <span class="mono">{{ currentFeedback.feedbackCount }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="平均评分">
              <span class="mono">{{ currentFeedback.avgScore?.toFixed(2) ?? '—' }}</span>
            </NDescriptionsItem>
          </NDescriptions>

          <!-- 连接边列表 -->
          <NDivider>连接关系（{{ currentEdges?.edges?.length ?? 0 }} 条边）</NDivider>
          <div v-if="!currentEdges?.edges?.length" class="muted" style="font-size:var(--fs-caption)">
            此节点暂无连接边。
          </div>
          <div v-else class="edge-list">
            <div
              v-for="(e, i) in currentEdges.edges"
              :key="i"
              class="edge-row"
            >
              <NTag size="tiny" :bordered="false" type="info">{{ e.type || '?' }}</NTag>
              <span
                class="mono edge-id"
                :title="e.source === currentNode.id ? e.target : e.source"
                @click.stop="openNode(e.source === currentNode.id ? e.target : e.source)"
              >
                {{ (e.source === currentNode.id ? e.target : e.source).slice(0, 16) }}…
              </span>
              <span class="muted" style="font-size:var(--fs-caption);margin-left:auto">
                {{ e.source === currentNode.id ? '→ 指向' : '← 被指' }}
              </span>
            </div>
          </div>

          <!-- L4: 邻域探索控制面板 -->
          <NDivider>邻域探索（GraphWalk）</NDivider>
          <div class="walk-controls">
            <NSelect
              v-model:value="walkDepth"
              :options="[
                { label: '深度 1（直接邻居）', value: 1 },
                { label: '深度 2', value: 2 },
                { label: '深度 3', value: 3 },
              ]"
              size="small"
              style="width: 160px"
            />
            <NSelect
              v-model:value="walkMaxNodes"
              :options="[
                { label: '最多 20 个', value: 20 },
                { label: '最多 30 个', value: 30 },
                { label: '最多 50 个', value: 50 },
              ]"
              size="small"
              style="width: 130px"
            />
            <NButton size="small" type="primary" secondary :loading="walking" @click="runWalk">
              探索邻域
            </NButton>
          </div>

          <div v-if="walking" style="margin-top:6px"><NSpin size="small" /></div>

          <template v-else-if="walkResult">
            <div class="result-header-row" style="margin-top:4px">
              <NTag size="small" :bordered="false">邻域节点 {{ walkNeighbors.length }} 个 · 边 {{ walkResult.edges?.length ?? 0 }} 条</NTag>
              <div style="display:flex;gap:4px;flex-wrap:wrap">
                <NTag v-for="et in walkEdgeTypes" :key="et.type" size="tiny" :bordered="false">
                  {{ et.type }}: {{ et.count }}
                </NTag>
              </div>
            </div>
            <div v-if="!walkNeighbors.length" class="muted" style="font-size:var(--fs-caption);margin-top:4px">
              此节点邻域无其他节点（孤立节点）。
            </div>
            <div v-else class="neighbor-grid">
              <div
                v-for="n in walkNeighbors"
                :key="n.id"
                class="neighbor-chip"
                @click="openNode(n.id)"
                :title="'继续钻取：' + (n.name || n.id)"
              >
                <NTag size="tiny" :type="nodeTypeTagType(n.type)" :bordered="false">{{ n.type || '?' }}</NTag>
                <span class="neighbor-name">{{ n.name || n.id.slice(0, 10) }}</span>
              </div>
            </div>
          </template>
        </template>

        <NEmpty v-else-if="!drawerLoading" description="节点不存在或不可访问" style="padding:24px 0" />
      </NDrawerContent>
    </NDrawer>
  </NCard>
</template>

<style scoped>
.search-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.result-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.node-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 360px;
  overflow-y: auto;
  margin-top: 4px;
}
.node-card {
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.node-card:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-hover, rgba(32,128,240,0.06));
}
.node-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.node-name {
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-pr {
  font-size: var(--fs-caption);
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--color-text-secondary);
}
.node-desc {
  margin-top: 4px;
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.node-card-foot {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 抽屉内部 */
.drawer-loading {
  display: flex;
  justify-content: center;
  padding: 48px 0;
}
.breadcrumb-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  font-size: var(--fs-caption);
}
.crumb {
  color: var(--color-primary);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.crumb:hover { background: var(--color-primary-hover, rgba(32,128,240,0.1)); }
.crumb.current {
  color: var(--color-text);
  cursor: default;
  background: transparent;
}
.crumb-sep { color: var(--color-text-tertiary); }
.node-sub-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.node-content {
  background: var(--color-border-subtle);
  border-radius: 4px;
  padding: 8px 10px;
  font-size: var(--fs-caption);
  line-height: 1.5;
  max-height: 180px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.edge-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}
.edge-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
}
.edge-row:hover { background: var(--color-border-subtle); }
.edge-id {
  font-size: var(--fs-caption);
  cursor: pointer;
  color: var(--color-primary);
  flex: 1;
}
.walk-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.neighbor-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.neighbor-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 16px;
  cursor: pointer;
  font-size: var(--fs-caption);
  transition: border-color 0.15s;
}
.neighbor-chip:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-hover, rgba(32,128,240,0.06));
}
.neighbor-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
