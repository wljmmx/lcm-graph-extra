<script setup lang="ts">
/**
 * Recall 检索质量测试面板（P1 能力闭环）。
 *
 * 解决能力断链：RecallConfigCard 只展示 recall 段配置，但用户无法验证
 * 这些配置（multiStage / chunking / outputFormat 等）实际生效后检索质量
 * 如何，必须手动 curl /api/recall。
 *
 * 设计目标：配置 → 观测 → 验证 的完整闭环：
 *   1. 用户输入 query
 *   2. 触发 POST /api/recall
 *   3. 结构化展示召回的候选节点列表（与 RecallConfigCard 的 6 项能力呼应）
 *   4. 可直接跳转 GraphExplorer 继续钻取候选节点
 *
 * UI/UX 原则：
 *   - 与 RecallConfigCard 视觉呼应（同样的"点 N"标签命名体系）
 *   - 结果区展示可追溯：每个候选标出来源（FTS种子/图邻域/向量排序-点5多阶段）
 *   - 操作不阻塞：可连续查询，响应不自动清空以便对比
 */
import { computed, onMounted, ref } from 'vue';
import {
  NCard, NInput, NButton, NTag, NDescriptions, NDescriptionsItem,
  NEmpty, NSpin, useMessage, NDivider, NDrawer, NDrawerContent, NH3,
} from 'naive-ui';
import CardState from './CardState.vue';
import {
  postGmProRecall,
  fetchGmProNode,
  fetchGmProRuntimeConfig,
  type GmProRecallConfig,
  type GmProRuntimeConfigResult,
  type GmProNode,
} from '../../api/gm-pro';

const message = useMessage();

const query = ref('');
const recalling = ref(false);
const recallError = ref<string | null>(null);
const recallResult = ref<unknown>(null);

/** recall 段配置：自取数据模式（与 RecallConfigCard 一致，不依赖 useMonitorData） */
const cfgFetching = ref(false);
const cfgIsError = ref(false);
const runtimeConfig = ref<GmProRuntimeConfigResult | null>(null);

async function loadRuntimeConfig(): Promise<void> {
  cfgFetching.value = true;
  cfgIsError.value = false;
  try {
    const res = await fetchGmProRuntimeConfig();
    if (res.ok) {
      runtimeConfig.value = res.data ?? null;
    } else {
      cfgIsError.value = true;
      runtimeConfig.value = null;
    }
  } catch {
    cfgIsError.value = true;
    runtimeConfig.value = null;
  } finally {
    cfgFetching.value = false;
  }
}
onMounted(loadRuntimeConfig);

const recall = computed<GmProRecallConfig | null>(() => runtimeConfig.value?.config?.recall ?? null);
const version = computed<string>(() => runtimeConfig.value?.version ?? '—');

/** 从 recall 原始响应中提取候选列表（兼容不同版本返回格式） */
interface RecallCandidate {
  id: string;
  name?: string;
  type?: string;
  score?: number;
  source?: string;
  snippet?: string;
}
const candidates = computed<RecallCandidate[]>(() => {
  const r = recallResult.value;
  if (!r || typeof r !== 'object') return [];
  const obj = r as Record<string, unknown>;

  // 兼容多种字段命名
  const tryList = (key: string): unknown[] | null => {
    const v = obj[key];
    return Array.isArray(v) ? v : null;
  };
  const list =
    tryList('results') ||
    tryList('candidates') ||
    tryList('nodes') ||
    (Array.isArray(r) ? r : null);
  if (!list) return [];

  return list.map((raw: any, idx: number): RecallCandidate => ({
    id: raw?.id ?? `cand-${idx}`,
    name: raw?.name ?? raw?.title ?? undefined,
    type: raw?.type ?? undefined,
    score: typeof raw?.score === 'number' ? raw.score : typeof raw?.rank === 'number' ? raw.rank : undefined,
    source: raw?.source ?? raw?.stage ?? undefined,
    snippet: raw?.snippet ?? raw?.description ?? raw?.content?.slice?.(0, 200) ?? undefined,
  }));
});

/** 响应中附带的元信息（耗时、总命中等） */
const recallMeta = computed<Array<{ label: string; value: string }>>(() => {
  const r = recallResult.value;
  if (!r || typeof r !== 'object') return [];
  const obj = r as Record<string, unknown>;
  const out: Array<{ label: string; value: string }> = [];
  const keys = ['took', 'tookMs', 'latency', 'elapsed', 'total', 'count', 'totalHits', 'stages'];
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const label = k === 'took' || k === 'tookMs' ? '耗时' : k === 'latency' ? '延迟' : k === 'elapsed' ? '用时' : k === 'total' || k === 'count' ? '候选数' : k === 'totalHits' ? '命中数' : '阶段';
    out.push({ label, value: val });
  }
  return out;
});

async function runRecall(): Promise<void> {
  const q = query.value.trim();
  if (!q) { message.warning('请输入检索 query'); return; }
  recalling.value = true;
  recallError.value = null;
  try {
    const res = await postGmProRecall({ query: q });
    if (res.ok) {
      recallResult.value = res.data ?? null;
      if (!candidates.value.length) {
        message.info('召回完成，未返回候选节点（请检查 gm-pro 版本是否支持 /api/recall 输出格式）');
      }
    } else {
      recallError.value = res.error || '召回失败';
      recallResult.value = null;
      message.error(`召回失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    recallError.value = err?.message || String(err);
    recallResult.value = null;
    message.error(`召回失败: ${err?.message || String(err)}`);
  } finally {
    recalling.value = false;
  }
}

function sourceTag(s?: string): { label: string; type: 'success' | 'info' | 'warning' | 'default' } {
  if (!s) return { label: '候选', type: 'default' };
  const low = s.toLowerCase();
  if (low.includes('fts') || low.includes('keyword')) return { label: 'FTS 种子', type: 'info' };
  if (low.includes('graph') || low.includes('walk') || low.includes('邻域') || low.includes('neighbor')) return { label: '图邻域', type: 'warning' };
  if (low.includes('vector') || low.includes('embedding') || low.includes('向量')) return { label: '向量排序', type: 'success' };
  if (low.includes('rerank') || low.includes('re-rank')) return { label: '重排', type: 'success' };
  return { label: s.length > 10 ? s.slice(0, 10) + '…' : s, type: 'default' };
}

// ─── 候选节点详情抽屉（轻量版，只展示内容不做邻域探索） ───────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailNode = ref<GmProNode | null>(null);

async function openCandidate(cand: RecallCandidate): Promise<void> {
  detailLoading.value = true;
  detailNode.value = null;
  detailOpen.value = true;
  try {
    const res = await fetchGmProNode(cand.id);
    if (res.ok) detailNode.value = res.data ?? null;
    else {
      // 加载失败时，用候选中的字段兜底展示
      detailNode.value = { id: cand.id, name: cand.name, type: cand.type, description: cand.snippet } as any;
    }
  } catch {
    detailNode.value = { id: cand.id, name: cand.name, type: cand.type, description: cand.snippet } as any;
  } finally {
    detailLoading.value = false;
  }
}

function fmtTs(ts?: number): string {
  if (ts == null) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}
</script>

<template>
  <NCard size="small">
    <template #header>
      <span>Recall 检索测试</span>
      <NTag size="tiny" :bordered="false" type="info" style="margin-left:8px">POST /recall · v{{ version }}</NTag>
    </template>
    <template #header-extra>
      <span class="muted" style="font-size:var(--fs-caption)">
        验证检索质量，与「检索质量配置」联动
      </span>
    </template>

    <!-- 当前生效的 recall 能力摘要（呼应 RecallConfigCard） -->
    <div class="cap-row">
      <NTag
        size="tiny"
        :type="recall?.multiStage ? 'success' : 'default'"
        :bordered="false"
      >点5 {{ recall?.multiStage ? '多阶段检索' : '单阶段' }}</NTag>
      <NTag
        size="tiny"
        :type="recall?.chunking?.enabled ? 'success' : 'default'"
        :bordered="false"
      >点6 {{ recall?.chunking?.enabled ? '分段嵌入' : '不分段' }}</NTag>
      <NTag
        size="tiny"
        :type="recall?.outputFormat?.enabled !== false ? 'success' : 'default'"
        :bordered="false"
      >点3 {{ recall?.outputFormat?.enabled !== false ? '格式化输出' : '原始输出' }}</NTag>
      <span class="mono muted" style="font-size:var(--fs-caption);margin-left:auto">
        点2切片 {{ recall?.memorySliceChars ?? 800 }} · 点4时序 {{ (recall?.temporalWeight ?? 0.3).toFixed(2) }}
      </span>
    </div>

    <!-- 查询输入栏 -->
    <div class="query-row">
      <NInput
        v-model:value="query"
        type="textarea"
        placeholder="输入要检索的 query，模拟 recall 流程"
        :autosize="{ minRows: 2, maxRows: 4 }"
        @keydown.enter.ctrl.exact="runRecall"
      />
      <NButton
        type="primary"
        :loading="recalling"
        @click="runRecall"
        style="margin-left:8px;align-self:flex-start"
      >
        执行 Recall
      </NButton>
    </div>
    <div class="muted" style="font-size:var(--fs-caption);margin-top:2px">
      Ctrl+Enter 快捷执行。将走完整 recall 流水线（I-1向量缓存/点2切片/点4时序/点5多阶段）。
    </div>

    <!-- 结果区 -->
    <CardState
      :loading="recalling"
      :is-error="!!recallError"
      :has-data="!!recallResult"
      empty-text="输入 query 后点「执行 Recall」开始检索质量验证"
      :error-text="recallError ?? undefined"
      empty-hint="建议先在「检索质量配置」中开启 multiStage 或 chunking，再用典型 query 对比效果。"
      style="margin-top: 8px"
    >
      <!-- 元信息描述 -->
      <template v-if="recallMeta.length">
        <NDescriptions :column="Math.min(4, recallMeta.length)" size="small" label-placement="left" bordered>
          <NDescriptionsItem v-for="m in recallMeta" :key="m.label" :label="m.label">
            <span class="mono">{{ m.value }}</span>
          </NDescriptionsItem>
        </NDescriptions>
        <NDivider style="margin: 8px 0">候选节点（{{ candidates.length }} 个）</NDivider>
      </template>
    </CardState>

    <!-- 候选列表 -->
    <div v-if="candidates.length" class="cand-list">
      <div
        v-for="(c, i) in candidates"
        :key="c.id + i"
        class="cand-row"
        @click="openCandidate(c)"
      >
        <div class="cand-rank">{{ i + 1 }}</div>
        <div class="cand-body">
          <div class="cand-head">
            <NTag v-if="c.type" size="tiny" :bordered="false">{{ c.type }}</NTag>
            <span class="cand-name">{{ c.name || '(未命名)' }}</span>
            <NTag
              v-if="c.source"
              size="tiny"
              :type="sourceTag(c.source).type"
              :bordered="false"
              style="margin-left:4px"
            >{{ sourceTag(c.source).label }}</NTag>
            <span v-if="c.score != null" class="mono cand-score">{{ c.score.toFixed(4) }}</span>
          </div>
          <div v-if="c.snippet" class="cand-snippet">{{ c.snippet }}</div>
        </div>
      </div>
    </div>
    <NEmpty v-else-if="recallResult && !candidates.length" description="响应中未解析出候选列表" style="padding:8px 0" />

    <!-- 候选节点详情抽屉 -->
    <NDrawer v-model:show="detailOpen" :width="480" placement="right">
      <NDrawerContent title="候选节点详情" :native-scrollbar="false">
        <div v-if="detailLoading" style="display:flex;justify-content:center;padding:32px 0"><NSpin /></div>
        <template v-else-if="detailNode">
          <NH3 style="margin:0 0 4px">{{ detailNode.name || '(未命名)' }}</NH3>
          <div class="muted mono" style="font-size:var(--fs-caption)">ID: {{ detailNode.id }}</div>
          <NDivider style="margin:8px 0">基本信息</NDivider>
          <NDescriptions :column="1" size="small" label-placement="left" bordered>
            <NDescriptionsItem label="类型">{{ detailNode.type || 'UNTYPED' }}</NDescriptionsItem>
            <NDescriptionsItem label="PageRank"><span class="mono">{{ detailNode.pagerank?.toFixed(4) ?? '—' }}</span></NDescriptionsItem>
            <NDescriptionsItem label="社区">
              <span v-if="detailNode.communityId" class="mono">{{ detailNode.communityId }}</span>
              <span v-else class="muted">—</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="创建时间">{{ fmtTs(detailNode.createdAt) }}</NDescriptionsItem>
            <NDescriptionsItem label="更新时间">{{ fmtTs(detailNode.updatedAt) }}</NDescriptionsItem>
          </NDescriptions>
          <div v-if="detailNode.description" style="margin-top:8px">
            <div class="muted" style="font-size:var(--fs-caption);margin-bottom:2px">描述</div>
            <div class="node-content">{{ detailNode.description }}</div>
          </div>
          <div v-if="detailNode.content" style="margin-top:8px">
            <div class="muted" style="font-size:var(--fs-caption);margin-bottom:2px">内容</div>
            <div class="node-content">{{ detailNode.content }}</div>
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>
  </NCard>
</template>

<style scoped>
.cap-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.query-row {
  display: flex;
  align-items: flex-start;
}
.cand-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  margin-top: 4px;
}
.cand-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.cand-row:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-hover, rgba(32,128,240,0.06));
}
.cand-rank {
  width: 22px;
  height: 22px;
  border-radius: 11px;
  background: var(--color-border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  font-weight: 600;
  flex-shrink: 0;
}
.cand-body { flex: 1; min-width: 0; }
.cand-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.cand-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cand-score {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
.cand-snippet {
  margin-top: 4px;
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.node-content {
  background: var(--color-border-subtle);
  border-radius: 4px;
  padding: 8px 10px;
  font-size: var(--fs-caption);
  line-height: 1.5;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
