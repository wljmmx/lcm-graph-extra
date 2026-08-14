<script setup lang="ts">
/**
 * 社区概览 + 详情钻取（P1 能力闭环）。
 *
 * 解决能力断链：原 CommunitiesCard 仅展示社区列表（/api/communities），
 * 但 graph-memory-pro 还提供了：
 *   - /api/communities/:id/summary      → 单社区摘要（可能有摘要刷新/embedding）
 *   - /api/communities/:id/nodes        → 成员节点
 *   - /api/communities/:id/representatives → 社区代表节点
 * 这些 API 原本没有 UI 入口。
 *
 * 交互设计（主列表 + 右侧抽屉模式）：
 *   - 主列表：社区 ID、成员数、截断摘要、分页（保留原逻辑）
 *   - 点击社区行 → 右侧抽屉：
 *       · 完整社区摘要
 *       · 代表节点（社区"形象代言人"，可直接点进 GraphExplorer）
 *       · 成员节点列表（分页、可继续钻取）
 *
 *  UX 细节：
 *   - 抽屉内部三个 tab 用分段展示（不做 UI Tab 组件以避免依赖）
 *   - 代表节点优先展示，帮助用户快速建立"这个社区在讲什么"的直觉
 *   - 节点可点击跳转，保持上下文
 */
import { computed, ref, watch } from 'vue';
import {
  NCard, NTag, NPagination, NDrawer, NDrawerContent, NH3, NDescriptions,
  NDescriptionsItem, NDivider, NSpin, NEmpty, useMessage,
} from 'naive-ui';
import CardState from './CardState.vue';
import {
  fetchGmProCommunityNodes,
  fetchGmProCommunityRepresentatives,
  fetchGmProCommunitySummary,
  type GmProCommunitySummary,
  type GmProNode,
} from '../../api/gm-pro';

const props = defineProps<{
  communities: GmProCommunitySummary[];
  loading?: boolean;
  isError?: boolean;
}>();

const emit = defineEmits<{ retry: []; openNode: [nodeId: string] }>();
const message = useMessage();

const PAGE_SIZE = 10;
const page = ref(1);

const paginatedCommunities = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return props.communities.slice(start, start + PAGE_SIZE);
});

watch(() => props.communities.length, () => { page.value = 1; });

// ─── 社区详情抽屉 ──────────────────────────────────────────────
const drawerOpen = ref(false);
const currentId = ref<string | null>(null);
const loadingSummary = ref(false);
const loadingReps = ref(false);
const loadingNodes = ref(false);

const detailSummary = ref<GmProCommunitySummary | null>(null);
const detailReps = ref<GmProNode[]>([]);
const detailNodes = ref<GmProNode[]>([]);
const detailNodesTotal = ref(0);
const detailNodesPage = ref(1);
const NODES_PAGE_SIZE = 20;

async function openCommunity(id: string): Promise<void> {
  currentId.value = id;
  drawerOpen.value = true;
  detailNodesPage.value = 1;
  await Promise.all([loadSummary(id), loadReps(id), loadNodes(id, 1)]);
}

async function loadSummary(id: string): Promise<void> {
  loadingSummary.value = true;
  detailSummary.value = null;
  try {
    const res = await fetchGmProCommunitySummary(id);
    if (res.ok) detailSummary.value = res.data ?? null;
  } catch (err: any) {
    message.error(`社区摘要加载失败: ${err?.message || String(err)}`);
  } finally {
    loadingSummary.value = false;
  }
}

async function loadReps(id: string): Promise<void> {
  loadingReps.value = true;
  detailReps.value = [];
  try {
    const res = await fetchGmProCommunityRepresentatives(id);
    if (res.ok) detailReps.value = res.data?.representatives ?? [];
  } catch { /* 代表节点失败不阻塞主流程 */ }
  finally { loadingReps.value = false; }
}

async function loadNodes(id: string, p: number): Promise<void> {
  loadingNodes.value = true;
  detailNodes.value = [];
  try {
    const res = await fetchGmProCommunityNodes(id, NODES_PAGE_SIZE * 5); // 多拿一些做本地分页上限
    if (res.ok) {
      detailNodes.value = res.data?.nodes ?? [];
      detailNodesTotal.value = res.data?.count ?? detailNodes.value.length;
    }
  } catch (err: any) {
    message.error(`社区成员加载失败: ${err?.message || String(err)}`);
  } finally {
    loadingNodes.value = false;
  }
}

watch(detailNodesPage, (p) => {
  if (currentId.value) loadNodes(currentId.value, p);
});

const paginatedDetailNodes = computed<GmProNode[]>(() => {
  const s = (detailNodesPage.value - 1) * NODES_PAGE_SIZE;
  return detailNodes.value.slice(s, s + NODES_PAGE_SIZE);
});

function nodeTypeTagType(t?: string): 'success' | 'warning' | 'info' | 'default' {
  switch ((t ?? '').toUpperCase()) {
    case 'TASK': return 'warning';
    case 'SKILL': return 'info';
    case 'EVENT': return 'success';
    default: return 'default';
  }
}

/** 成员按类型分布，供快速感知社区结构 */
const memberTypeStats = computed<Array<{ type: string; count: number }>>(() => {
  const map = new Map<string, number>();
  for (const n of detailNodes.value) {
    const t = n.type || 'UNTYPED';
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
});

function onNodeClick(nodeId: string): void {
  // 优先：父组件处理了 @openNode 事件（如父组件有 GraphExplorer 抽屉可直接复用）
  // 否则：emit 暴露事件供父处理（父不处理也不会报错）
  emit('openNode', nodeId);
}
</script>

<template>
  <NCard title="社区概览" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="communities.length > 0"
      empty-text="暂无社区数据"
      error-text="社区数据请求失败"
      empty-hint="请确认 graph-memory-pro 服务已启动。"
      @retry="emit('retry')"
    >
      <div class="community-list">
        <div
          v-for="c in paginatedCommunities"
          :key="c.communityId"
          class="community-row"
          @click="openCommunity(c.communityId)"
          :title="'查看社区详情：' + c.communityId"
        >
          <span
            class="mono community-id"
            :title="c.communityId"
          >{{ c.communityId.length > 12 ? c.communityId.slice(0, 12) + '…' : c.communityId }}</span>
          <NTag size="tiny" :bordered="false">{{ c.memberCount }} 成员</NTag>
          <span class="community-summary">{{ c.summary?.slice(0, 80) }}{{ c.summary?.length > 80 ? '…' : '' }}</span>
          <span class="muted arrow" style="font-size:var(--fs-caption);margin-left:auto">详情 →</span>
        </div>
      </div>
      <div v-if="communities.length > PAGE_SIZE" class="pagination-row">
        <NPagination
          v-model:page="page"
          :item-count="communities.length"
          :page-size="PAGE_SIZE"
          size="small"
        />
      </div>
    </CardState>

    <!-- 社区详情抽屉 -->
    <NDrawer
      v-model:show="drawerOpen"
      :width="560"
      placement="right"
      :native-scrollbar="false"
    >
      <NDrawerContent title="社区详情" :native-scrollbar="false">
        <template v-if="currentId">
          <NH3 style="margin:0 0 4px">
            社区
            <span class="mono" style="font-size:var(--fs-body);color:var(--color-text-secondary)">{{ currentId }}</span>
          </NH3>
          <div class="muted" style="font-size:var(--fs-caption);margin-bottom:8px">
            成员总数 {{ detailSummary?.memberCount ?? detailNodesTotal }}
            <span v-if="memberTypeStats.length" class="type-stat">
              · 类型分布：
              <span v-for="(t, i) in memberTypeStats" :key="t.type">
                {{ t.type }} {{ t.count }}{{ i < memberTypeStats.length - 1 ? '、' : '' }}
              </span>
            </span>
          </div>

          <!-- 摘要 -->
          <NDivider>社区摘要</NDivider>
          <div v-if="loadingSummary" style="padding:8px 0"><NSpin size="small" /></div>
          <NEmpty v-else-if="!detailSummary?.summary" description="该社区暂未生成摘要" style="padding:8px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
          <div v-else class="summary-block">
            {{ detailSummary.summary }}
          </div>

          <!-- 代表节点 -->
          <NDivider>代表节点（{{ detailReps.length }} 个）</NDivider>
          <div v-if="loadingReps" style="padding:8px 0"><NSpin size="small" /></div>
          <NEmpty v-else-if="!detailReps.length" description="该社区未识别出代表节点" style="padding:8px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
          <div v-else class="rep-list">
            <div
              v-for="n in detailReps"
              :key="n.id"
              class="rep-chip"
              @click.stop="onNodeClick(n.id)"
              :title="'查看节点：' + (n.name || n.id)"
            >
              <NTag size="tiny" :type="nodeTypeTagType(n.type)" :bordered="false">{{ n.type || '?' }}</NTag>
              <span class="rep-name">{{ n.name || n.id.slice(0, 10) }}</span>
              <span v-if="n.pagerank != null" class="mono rep-pr">{{ n.pagerank.toFixed(3) }}</span>
            </div>
          </div>

          <!-- 成员节点 -->
          <NDivider>成员节点（{{ Math.min(detailNodesTotal, detailNodes.length) }} / {{ detailNodesTotal }} 可见）</NDivider>
          <div v-if="loadingNodes" style="padding:8px 0"><NSpin size="small" /></div>
          <div v-else class="member-list">
            <div
              v-for="n in paginatedDetailNodes"
              :key="n.id"
              class="member-row"
              @click.stop="onNodeClick(n.id)"
            >
              <NTag size="tiny" :type="nodeTypeTagType(n.type)" :bordered="false">{{ n.type || '?' }}</NTag>
              <span class="member-name">{{ n.name || '(未命名)' }}</span>
              <span v-if="n.pagerank != null" class="mono muted member-pr">PR {{ n.pagerank.toFixed(3) }}</span>
            </div>
            <NEmpty v-if="!detailNodes.length" description="成员列表为空" style="padding:8px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
          </div>
          <div v-if="detailNodes.length > NODES_PAGE_SIZE" class="pagination-row">
            <NPagination
              v-model:page="detailNodesPage"
              :item-count="detailNodes.length"
              :page-size="NODES_PAGE_SIZE"
              size="small"
            />
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>
  </NCard>
</template>

<style scoped>
.community-list {
  max-height: 260px;
  overflow-y: auto;
}
.community-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
}
.community-row:hover {
  background: var(--color-primary-hover, rgba(32,128,240,0.06));
}
.community-id {
  font-size: 11px;
  min-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.community-summary {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.pagination-row {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
}
.summary-block {
  background: var(--color-border-subtle);
  border-radius: 4px;
  padding: 10px 12px;
  font-size: var(--fs-body);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.type-stat { color: var(--color-text-secondary); }
.rep-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}
.rep-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.rep-chip:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-hover, rgba(32,128,240,0.06));
}
.rep-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rep-pr {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
.member-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 260px;
  overflow-y: auto;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.member-row:hover { background: var(--color-border-subtle); }
.member-name {
  flex: 1;
  font-size: var(--fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.member-pr { font-size: 10px; }
.arrow { opacity: 0; transition: opacity 0.15s; }
.community-row:hover .arrow { opacity: 1; }
</style>
