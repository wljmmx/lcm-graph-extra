<script setup lang="ts">
/**
 * 关联矩阵 M · 状态与学习概览：学习状态 chip + 冷启动进度 + 学习统计 + 应用率 + 学习曲线。
 *
 * 数据来源于 AssociationMatrixCard 拆分而来，仅保留"状态 + 学习曲线"，
 * 热力网格见 AssociationMatrixHeatmapCard。
 */
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { NCard, NDescriptions, NDescriptionsItem, NProgress, NTag, NButton, NEmpty } from 'naive-ui';
import CardState from './CardState.vue';
import EChart from '../EChart.vue';
import { useTheme } from '../../composables/useTheme';
import {
  fetchGmProAssociationMatrixHistory,
  type GmProAssociationMatrixState,
  type GmProLearningSample,
} from '../../api/gm-pro';

const props = defineProps<{
  am: GmProAssociationMatrixState | null;
  loading?: boolean;
  isError?: boolean;
  /** save/load 操作进行中 */
  acting?: boolean;
}>();

const emit = defineEmits<{ retry: []; save: []; load: [] }>();
const { isDark } = useTheme();

/** 学习状态 chip：冷启动 / 有更新 / 无更新 */
const phase = computed<'cold' | 'learning' | 'idle'>(() => {
  if (!props.am?.available) return 'idle';
  if (props.am.coldStart) return 'cold';
  const applied = props.am.stats?.updatesApplied ?? 0;
  return applied > 0 ? 'learning' : 'idle';
});

const phaseLabel = computed(() => {
  if (!props.am?.available) return '未启用';
  switch (phase.value) {
    case 'cold': return '冷启动 (M=I)';
    case 'learning': return '在线学习中';
    default: return '已就绪 · 待反馈';
  }
});

const phaseType = computed<'success' | 'warning' | 'error' | 'info' | 'default'>(() => {
  if (!props.am?.available) return 'default';
  switch (phase.value) {
    case 'cold': return 'warning';
    case 'learning': return 'success';
    default: return 'info';
  }
});

/** 冷启动进度：feedbackCount / warmupFeedbacks */
const warmupPercent = computed(() => {
  const cur = props.am?.feedbackCount ?? 0;
  const total = props.am?.warmupFeedbacks ?? 0;
  if (total <= 0) return null;
  return Math.min(100, Math.round((cur / total) * 100));
});

/** applied vs rejected 比率 */
const appliedPercentage = computed(() => {
  const a = props.am?.stats?.updatesApplied ?? 0;
  const r = props.am?.stats?.updatesRejected ?? 0;
  const total = a + r;
  return total > 0 ? Math.round((a / total) * 100) : null;
});

/** 持久化状态文本 */
const persistText = computed(() => {
  const p = props.am?.persist?.persisted;
  if (!p?.exists) return '未持久化';
  const bytes = p.bytes != null ? `${(p.bytes / 1024).toFixed(1)}KB` : '';
  const time = p.modifiedAt ? new Date(p.modifiedAt).toLocaleString() : '';
  return [bytes, time].filter(Boolean).join(' · ') || '已保存';
});

// ── 学习曲线（独立端点，跨重启历史） ─────────────────────────────
const {
  data: historyRes,
  isFetching: historyFetching,
  isError: historyIsError,
  refetch: refetchHistory,
} = useQuery({
  queryKey: ['gm-pro-association-matrix-history'],
  queryFn: () => fetchGmProAssociationMatrixHistory(120),
  refetchInterval: (query) => (query.state.data?.ok ? 120_000 : false),
  staleTime: 60_000,
  retry: 1,
});
const historySamples = computed<GmProLearningSample[]>(() =>
  historyRes.value?.ok ? (historyRes.value.data?.samples ?? []) : [],
);
const historyLoading = computed(() => historyFetching.value && !historySamples.value.length && !historyIsError.value);

const historyOption = computed<Record<string, unknown>>(() => {
  const samples = historySamples.value;
  const x = samples.map(s => new Date(s.timestamp).toLocaleTimeString());
  return {
    tooltip: { trigger: 'axis' },
    legend: {},
    grid: { left: 40, right: 16, top: 28, bottom: 28 },
    xAxis: { type: 'category', data: x, boundaryGap: false },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      { name: '已应用', type: 'line', smooth: true, showSymbol: false, data: samples.map(s => s.updatesApplied) },
      { name: '被拒', type: 'line', smooth: true, showSymbol: false, data: samples.map(s => s.updatesRejected) },
      { name: '反馈数', type: 'line', smooth: true, showSymbol: false, data: samples.map(s => s.feedbackCount) },
    ],
  };
});
</script>

<template>
  <NCard title="关联矩阵 M · 状态概览" size="small">
    <CardState
      :loading="loading ?? false"
      :is-error="isError"
      :has-data="!!am"
      empty-text="暂无关联矩阵数据"
      error-text="关联矩阵请求失败"
      empty-hint="请确认 openclaw.json 中 associationMatrix 已启用。"
      @retry="emit('retry')"
    >
      <template v-if="am?.available !== false">
        <!-- 学习状态 chip + 持久化 -->
        <div class="head-row">
          <NTag :type="phaseType" size="small" :bordered="false">{{ phaseLabel }}</NTag>
          <span class="muted persist" style="font-size:var(--fs-caption)">{{ persistText }}</span>
        </div>

        <!-- 冷启动进度 -->
        <div v-if="warmupPercent !== null" style="margin-top:8px">
          <div class="ratio-label">
            <span class="muted" style="font-size:var(--fs-caption)">冷启动进度</span>
            <span class="mono" style="font-size:var(--fs-caption)">
              {{ am.feedbackCount ?? 0 }} / {{ am.warmupFeedbacks ?? 0 }} ({{ warmupPercent }}%)
            </span>
          </div>
          <NProgress
            type="line"
            :percentage="warmupPercent"
            :height="6"
            :border-radius="3"
            :color="warmupPercent >= 100 ? '#18a058' : '#f0a020'"
            :rail-color="isDark ? '#333' : '#e8e8e8'"
            :show-indicator="false"
          />
        </div>

        <!-- 学习统计 -->
        <NDescriptions :column="2" size="small" label-placement="left" bordered style="margin-top:8px">
          <NDescriptionsItem label="维度"><span class="mono">{{ am.stats?.dim ?? '—' }}</span></NDescriptionsItem>
          <NDescriptionsItem label="Adam 步 (t)"><span class="mono">{{ am.stats?.t ?? '—' }}</span></NDescriptionsItem>
          <NDescriptionsItem label="已应用"><span class="mono" style="color: var(--color-success)">{{ am.stats?.updatesApplied ?? '—' }}</span></NDescriptionsItem>
          <NDescriptionsItem label="被拒"><span class="mono" style="color: var(--color-danger)">{{ am.stats?.updatesRejected ?? '—' }}</span></NDescriptionsItem>
          <NDescriptionsItem label="样本池"><span class="mono">{{ am.stats?.historySize ?? '—' }}</span></NDescriptionsItem>
          <NDescriptionsItem label="反馈数"><span class="mono">{{ am.feedbackCount ?? '—' }}</span></NDescriptionsItem>
        </NDescriptions>

        <!-- applied 比率条 -->
        <div v-if="appliedPercentage !== null" style="margin-top:8px">
          <div class="ratio-label">
            <span class="muted" style="font-size:var(--fs-caption)">应用率</span>
            <span class="mono" style="font-size:var(--fs-caption)">{{ appliedPercentage }}%</span>
          </div>
          <NProgress
            type="line"
            :percentage="appliedPercentage"
            :height="6"
            :border-radius="3"
            :color="appliedPercentage > 70 ? '#18a058' : appliedPercentage > 40 ? '#f0a020' : '#d03050'"
            :rail-color="isDark ? '#333' : '#e8e8e8'"
            :show-indicator="false"
          />
        </div>

        <!-- 状态提示 -->
        <div v-if="am.hint" class="muted" style="font-size:var(--fs-caption);margin-top:6px">{{ am.hint }}</div>

        <!-- 持久化操作 -->
        <div style="display:flex;gap:8px;margin-top:10px">
          <NButton size="tiny" secondary type="primary" :loading="acting" @click="emit('save')">保存 M</NButton>
          <NButton size="tiny" secondary :loading="acting" @click="emit('load')">加载 M</NButton>
        </div>

        <!-- 学习曲线（跨重启历史） -->
        <div style="margin-top:12px">
          <div class="ratio-label">
            <span class="muted" style="font-size:var(--fs-caption)">学习曲线（跨重启）</span>
            <span class="mono" style="font-size:var(--fs-caption)">
              {{ historySamples.length }} 点
              <span v-if="historyLoading && !historySamples.length && !historyIsError" class="muted"> · 加载中…</span>
            </span>
          </div>
          <div v-if="historyIsError">
            <NEmpty description="学习曲线加载失败" style="padding:8px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
            <NButton size="tiny" secondary @click="refetchHistory">重试</NButton>
          </div>
          <NEmpty v-else-if="!historySamples.length" description="暂无采样" style="padding:8px 0" :style="{ fontSize: 'var(--fs-caption)' }" />
          <EChart v-else :option="historyOption" height="180px" aria-label="关联矩阵M学习曲线：已应用/被拒/反馈数随时间变化" />
        </div>
      </template>

      <template v-else>
        <div class="muted" style="font-size:var(--fs-caption)">
          {{ am.reason ?? '关联矩阵未启用' }}。请设置 associationMatrix.enabled=true 并重启。
        </div>
      </template>
    </CardState>
  </NCard>
</template>

<style scoped>
.head-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.persist { max-width: 60%; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ratio-label { display: flex; justify-content: space-between; margin-bottom: 2px; }
</style>