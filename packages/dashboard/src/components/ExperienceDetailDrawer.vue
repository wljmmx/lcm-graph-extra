<script setup lang="ts">
/**
 * ExperienceDetailDrawer —— 经验详情抽屉。
 *
 * - 完整字段展示（NDescriptions）
 * - G-8 验证历史时间线（NTimeline，单点用 lastValidatedAt）
 * - RELATED_TO 关联图谱（EChart Graph force layout）
 * - 质量分趋势（QualityChart mini 折线）
 * - 操作按钮：遗忘 soft / 遗忘 hard（二次确认）/ 固定-解固
 *
 * 写操作通过 invokeMcpTool 调用 lcmg_forget / lcmg_pin，由父组件传入回调，
 * 由父组件 useMutation 处理（成功后 invalidate experience-list）。
 */
import { computed } from 'vue';
import {
  NDrawer,
  NDrawerContent,
  NDescriptions,
  NDescriptionsItem,
  NTag,
  NTimeline,
  NTimelineItem,
  NEmpty,
  NSpace,
  NButton,
  NPopconfirm,
  NAlert,
  NSpin,
  NCard,
} from 'naive-ui';
import EChart from './EChart.vue';
import QualityChart from './QualityChart.vue';
import { formatDateTime } from '../utils/format';
import type {
  ExperienceDetail,
  ExperienceGraph,
  QualityHistoryPoint,
  McpInvokeResponse,
} from '../api/experience';

const props = defineProps<{
  show: boolean;
  detail: ExperienceDetail | null;
  detailLoading?: boolean;
  graph: ExperienceGraph | null;
  graphLoading?: boolean;
  historyPoints: QualityHistoryPoint[];
  historyLoading?: boolean;
  /** 写操作结果提示（成功/失败信息） */
  opResult?: { ok: boolean; message: string } | null;
}>();

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'invoke', tool: string, params: Record<string, unknown>): Promise<McpInvokeResponse> | void;
}>();

function typeColor(t: string): 'info' | 'error' | 'warning' | 'success' | 'default' {
  switch (t) {
    case 'failure':       return 'error';
    case 'correction':    return 'warning';
    case 'fix':           return 'success';
    case 'best_practice': return 'info';
    default:              return 'default';
  }
}

// ECharts Graph force layout 选项
const graphOption = computed(() => {
  const nodes = (props.graph?.nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name || n.id,
    symbolSize: 20 + Math.min(40, Math.sqrt(n.pagerank ?? 0) * 30),
    category: n.type,
    value: n.pagerank ?? 0,
  }));
  const edges = (props.graph?.edges ?? []).map((e) => ({
    source: e.source,
    target: e.target,
    value: e.type,
  }));
  const categories = Array.from(
    new Set((props.graph?.nodes ?? []).map((n) => n.type || 'UNKNOWN')),
  ).map((c) => ({ name: c }));

  return {
    tooltip: {
      formatter: (p: { dataType: string; data?: { name?: string; value?: number; source?: string; target?: string } }) => {
        if (p.dataType === 'node') return `${p.data?.name ?? ''} (pagerank=${p.data?.value ?? 0})`;
        if (p.dataType === 'edge') return `${p.data?.source} → ${p.data?.target}`;
        return '';
      },
    },
    legend: [{ data: categories.map((c) => c.name) }],
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        label: { show: true, position: 'right' },
        force: { repulsion: 120, edgeLength: 80, gravity: 0.1 },
        categories,
        data: nodes,
        links: edges,
        lineStyle: { color: 'source', curveness: 0.1 },
        emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
      },
    ],
  };
});

function handleForgetSoft(): void {
  if (!props.detail?.id) return;
  void emit('invoke', 'lcmg_forget', { id: props.detail.id, mode: 'soft' });
}

function handleForgetHard(): void {
  if (!props.detail?.id) return;
  void emit('invoke', 'lcmg_forget', { id: props.detail.id, mode: 'hard', confirm: true });
}

function handlePin(): void {
  if (!props.detail?.id) return;
  void emit('invoke', 'lcmg_pin', { id: props.detail.id });
}

function handleUnpin(): void {
  if (!props.detail?.id) return;
  void emit('invoke', 'lcmg_pin', { id: props.detail.id, unpin: true });
}

function close(): void {
  emit('update:show', false);
}
</script>

<template>
  <NDrawer
    :show="props.show"
    :width="640"
    placement="right"
    :trap-focus="true"
    :auto-focus="true"
    :close-on-esc="true"
    role="dialog"
    aria-modal="true"
    aria-label="经验详情"
    @update:show="emit('update:show', $event)"
  >
    <NDrawerContent title="经验详情" closable>
      <NSpin v-if="props.detailLoading && !props.detail" size="small">
        <template #default>加载中…</template>
      </NSpin>

      <template v-else-if="props.detail">
        <NSpace vertical :size="12">
          <!-- 写操作结果提示 -->
          <NAlert
            v-if="props.opResult"
            :type="props.opResult.ok ? 'success' : 'error'"
            :show-icon="true"
          >
            {{ props.opResult.message }}
          </NAlert>

          <!-- 基础字段 -->
          <NDescriptions :column="1" bordered size="small" label-placement="left">
            <NDescriptionsItem label="ID">
              <span class="mono">{{ props.detail.id }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="标题">{{ props.detail.title }}</NDescriptionsItem>
            <NDescriptionsItem label="类型">
              <NTag size="small" :type="typeColor(props.detail.type)">
                {{ props.detail.type }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="状态">
              <NTag size="small">{{ props.detail.status }}</NTag>
              <NTag
                v-if="props.detail.state"
                size="small"
                type="warning"
                style="margin-left: 4px"
              >
                {{ props.detail.state }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="项目">
              {{ props.detail.projectName || '—' }}
            </NDescriptionsItem>
            <NDescriptionsItem label="摘要">
              <div class="cell-wrap">{{ props.detail.summary }}</div>
            </NDescriptionsItem>
            <NDescriptionsItem label="相关性">
              {{ (props.detail.relevanceScore ?? 0).toFixed(2) }}
            </NDescriptionsItem>
            <NDescriptionsItem label="质量分">
              {{ props.detail.qualityScore !== null ? props.detail.qualityScore.toFixed(2) : '—' }}
            </NDescriptionsItem>
            <NDescriptionsItem label="命中数">{{ props.detail.matchCount }}</NDescriptionsItem>
            <NDescriptionsItem label="创建时间">{{ formatDateTime(props.detail.createdAt) }}</NDescriptionsItem>
            <NDescriptionsItem label="最近验证">{{ formatDateTime(props.detail.lastValidatedAt) }}</NDescriptionsItem>
            <NDescriptionsItem label="标签">
              <NSpace :size="4">
                <NTag v-for="s in props.detail.tags.scenario" :key="'s-' + s" size="small" type="info">{{ s }}</NTag>
                <NTag v-for="t in props.detail.tags.techStack" :key="'t-' + t" size="small" type="success">{{ t }}</NTag>
                <NTag v-if="props.detail.tags.severity" size="small" type="warning">{{ props.detail.tags.severity }}</NTag>
                <NTag v-for="f in props.detail.tags.free" :key="'f-' + f" size="small">{{ f }}</NTag>
                <span v-if="!props.detail.tags.scenario.length && !props.detail.tags.techStack.length && !props.detail.tags.severity && !props.detail.tags.free.length" class="muted">—</span>
              </NSpace>
            </NDescriptionsItem>
            <NDescriptionsItem label="来源">
              <span class="mono">{{ props.detail.source || '—' }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem label="会话">
              <span class="mono">{{ props.detail.sessionId || '—' }}</span>
            </NDescriptionsItem>
          </NDescriptions>

          <!-- 原始上下文 / 详情 -->
          <NCard title="上下文" size="small">
            <div class="cell-wrap mono">{{ props.detail.context || '—' }}</div>
          </NCard>
          <NCard title="详情" size="small">
            <div class="cell-wrap">{{ props.detail.detail || '—' }}</div>
          </NCard>

          <!-- G-8 验证历史时间线（MVP 单点） -->
          <NCard title="G-8 验证历史" size="small">
            <NSpin v-if="props.historyLoading" size="small" />
            <NTimeline v-else-if="props.historyPoints.length">
              <NTimelineItem
                v-for="(p, i) in props.historyPoints"
                :key="i"
                :type="p.qualityScore === null ? 'default' : (p.qualityScore > 0.6 ? 'success' : 'warning')"
                :time="formatDateTime(p.timestamp)"
              >
                qualityScore: {{ p.qualityScore !== null ? p.qualityScore.toFixed(2) : '—' }}
              </NTimelineItem>
            </NTimeline>
            <NEmpty v-else size="small" description="无验证记录" />
          </NCard>

          <!-- 质量分趋势 mini 折线 -->
          <NCard title="质量分趋势" size="small">
            <NSpin v-if="props.historyLoading" size="small" />
            <QualityChart
              v-else
              :points="props.historyPoints"
              height="180px"
            />
          </NCard>

          <!-- RELATED_TO 关联图谱 -->
          <NCard title="关联图谱（RELATED_TO）" size="small">
            <NSpin v-if="props.graphLoading" size="small" />
            <EChart
              v-else-if="props.graph && props.graph.nodes.length"
              :option="graphOption"
              height="320px"
            />
            <NEmpty v-else size="small" description="无关联节点" />
          </NCard>

          <!-- 操作按钮 -->
          <NCard title="操作" size="small">
            <NSpace :size="8">
              <NButton size="small" type="warning" @click="handleForgetSoft">
                遗忘（soft）
              </NButton>
              <NPopconfirm
                placement="top"
                @positive-click="handleForgetHard"
              >
                <template #trigger>
                  <NButton size="small" type="error">
                    遗忘（hard）
                  </NButton>
                </template>
                确认永久删除？此操作不可逆。
              </NPopconfirm>
              <NButton size="small" type="info" @click="handlePin">
                固定
              </NButton>
              <NButton size="small" @click="handleUnpin">
                解固
              </NButton>
            </NSpace>
          </NCard>
        </NSpace>
      </template>

      <NEmpty v-else description="无数据" />

      <template #footer>
        <NButton size="small" @click="close">关闭</NButton>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}
.cell-wrap {
  white-space: pre-wrap;
  word-break: break-word;
}
.muted {
  color: var(--color-text-secondary);
}
</style>
