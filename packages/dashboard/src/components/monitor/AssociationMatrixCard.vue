<script setup lang="ts">
/**
 * 关联矩阵 M：冷启动进度 + 学习状态 + applied/rejected 比率。
 *
 * 数据契约对齐 graph-memory-pro /api/association-matrix/state：
 *   { enabled, available, reason, config,
 *     stats: { enabled, dim, t, updatesApplied, updatesRejected, historySize },
 *     coldStart, feedbackCount, warmupFeedbacks,
 *     persist: { path, persisted: {exists, bytes, modifiedAt} }, hint }
 *
 * 注：M 是单个 N×N 矩阵，无"时间轴"维度，因此不再绘制"维度×时间步"热力图。
 * 学习集中度可视化（降采样 |M-I| / rowEnergy）由 P1 的 /api/association-matrix/visual 提供。
 */
import { computed } from 'vue';
import { NCard, NDescriptions, NDescriptionsItem, NProgress, NTag, NButton, NSpin } from 'naive-ui';
import CardState from './CardState.vue';
import { useTheme } from '../../composables/useTheme';
import type { GmProAssociationMatrixState } from '../../api/gm-pro';

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
</script>

<template>
  <NCard title="关联矩阵 M" size="small">
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