<script setup lang="ts">
/**
 * MoA 运行状态徽章：紧凑展示最近 MoA 运行的成功/失败状态。
 *
 * - 从 fetchMoaPerformance() 拉取数据（TanStack Query，30s 轮询，与 MonitorView 一致）
 * - 展示内容：
 *   - 最近一次运行状态：成功（绿色 NTag）/ 失败（红色 NTag）/ 无记录（灰色）
 *   - 总运行次数 / 成功率
 *   - 最近 fallback 次数（fallbackCount 字段）
 * - 使用 NSpace + NTag + NText 渲染，保持紧凑
 */
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { NSpace, NTag, NText, NSpin } from 'naive-ui';
import {
  fetchMoaPerformance,
  type MoaPerformanceData,
  type MoaRunRecord,
} from '../api/moa';

// 数据获取：30s 轮询（与 MonitorView 的 moa-performance queryKey 共享缓存）
const { data, isLoading } = useQuery({
  queryKey: ['moa-performance'],
  queryFn: fetchMoaPerformance,
  refetchInterval: 30_000,
});

const perf = computed<MoaPerformanceData | null>(
  () => data.value?.data ?? null,
);

// 最近一次运行记录（recentRuns 默认 DESC 排序，最新在前）
const latestRun = computed<MoaRunRecord | null>(() => {
  const runs = perf.value?.recentRuns;
  if (!runs || runs.length === 0) return null;
  return runs[0];
});

// 最近一次运行状态：成功 / 失败 / 无记录
const latestStatus = computed<'success' | 'error' | 'idle'>(() => {
  if (!latestRun.value) return 'idle';
  return latestRun.value.success ? 'success' : 'error';
});

const latestTagType = computed<'success' | 'error' | 'default'>(() => {
  if (latestStatus.value === 'idle') return 'default';
  return latestStatus.value;
});

const latestTagText = computed(() => {
  switch (latestStatus.value) {
    case 'success': return '最近：成功';
    case 'error':   return '最近：失败';
    case 'idle':    return '无运行记录';
  }
});

// 成功率（百分比，保留 1 位小数）
const successRate = computed(() => {
  if (!perf.value || perf.value.totalRuns === 0) return 0;
  return (perf.value.successRuns / perf.value.totalRuns) * 100;
});

// 成功率 tag 颜色：≥90% success / ≥70% warning / 否则 error；无运行记录 default
const successRateType = computed<'success' | 'warning' | 'error' | 'default'>(() => {
  if (!perf.value || perf.value.totalRuns === 0) return 'default';
  const r = successRate.value;
  if (r >= 90) return 'success';
  if (r >= 70) return 'warning';
  return 'error';
});

// fallback 次数 tag 颜色：>0 warning，否则 default
const fallbackType = computed<'warning' | 'default'>(() =>
  perf.value && perf.value.fallbackCount > 0 ? 'warning' : 'default',
);
</script>

<template>
  <div class="moa-status-badge" role="status" aria-label="MoA 运行状态">
    <!-- 加载态 -->
    <NSpin v-if="isLoading && !perf" size="small" />

    <NSpace v-else-if="perf" :size="6" align="center" :wrap="false">
      <!-- 最近一次运行状态 -->
      <NTag :type="latestTagType" size="small" round>
        {{ latestTagText }}
      </NTag>

      <!-- 总运行次数 -->
      <NText depth="2" class="badge-text">
        运行 <span class="mono num">{{ perf.totalRuns }}</span>
      </NText>

      <!-- 成功率 -->
      <NTag :type="successRateType" size="small" :bordered="false">
        成功率 <span class="mono num">{{ successRate.toFixed(1) }}%</span>
      </NTag>

      <!-- fallback 次数 -->
      <NTag :type="fallbackType" size="small">
        回退 <span class="mono num">{{ perf.fallbackCount }}</span>
      </NTag>
    </NSpace>

    <!-- 无数据 -->
    <NText v-else depth="3" class="badge-text">无 MoA 数据</NText>
  </div>
</template>

<style scoped>
.moa-status-badge {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
}
.badge-text {
  font-size: var(--fs-caption);
  white-space: nowrap;
}
.num {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
</style>
