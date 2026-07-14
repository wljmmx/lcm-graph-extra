<template>
  <div class="moa-perf-view">
    <div class="page-header">
      <h2 class="page-title">MoA 性能监控</h2>
      <span class="page-subtitle">Mixture of Agents 管道执行追踪</span>
    </div>

    <NSpin :show="loading">
      <template v-if="error">
        <NAlert type="error" :title="error" style="margin-bottom: 16px" />
      </template>

      <template v-if="data">
        <!-- 概览卡片 -->
        <NGrid :cols="'1 s:2 m:4'" :x-gap="12" :y-gap="12" responsive="screen" style="margin-bottom: 16px">
          <NGi>
            <NCard size="small">
              <div class="stat-card">
                <span class="stat-label">总运行次数</span>
                <span class="stat-value">{{ data.totalRuns }}</span>
                <span class="stat-detail">
                  <NTag size="tiny" type="success">{{ data.successRuns }} 成功</NTag>
                  <NTag v-if="data.failedRuns > 0" size="tiny" type="error">{{ data.failedRuns }} 失败</NTag>
                </span>
              </div>
            </NCard>
          </NGi>
          <NGi>
            <NCard size="small">
              <div class="stat-card">
                <span class="stat-label">成功率</span>
                <span class="stat-value">
                  {{ data.totalRuns > 0 ? ((data.successRuns / data.totalRuns) * 100).toFixed(0) : '-' }}%
                </span>
                <span class="stat-detail">
                  <NTag size="tiny" :type="successRateType">{{ successRateLabel }}</NTag>
                </span>
              </div>
            </NCard>
          </NGi>
          <NGi>
            <NCard size="small">
              <div class="stat-card">
                <span class="stat-label">平均总耗时</span>
                <span class="stat-value">{{ formatMs(data.avgTotalMs) }}</span>
                <span class="stat-detail">
                  <span class="muted">参考: {{ formatMs(data.avgRefMs) }} / 聚合: {{ formatMs(data.avgAggMs) }}</span>
                </span>
              </div>
            </NCard>
          </NGi>
          <NGi>
            <NCard size="small">
              <div class="stat-card">
                <span class="stat-label">Token 消耗</span>
                <span class="stat-value">{{ formatTokens(data.totalTokens) }}</span>
                <span class="stat-detail">
                  <span class="muted">平均 {{ formatTokens(data.avgTokens) }}/次</span>
                </span>
              </div>
            </NCard>
          </NGi>
        </NGrid>

        <!-- 阶段耗时对比 -->
        <NCard v-if="data.totalRuns > 0" title="阶段耗时分布" size="small" style="margin-bottom: 16px">
          <div class="phase-bars">
            <div class="phase-bar-item">
              <span class="phase-bar-label">参考模型</span>
              <div class="phase-bar-track">
                <div
                  class="phase-bar-fill phase-bar-ref"
                  :style="{ width: refPhasePercent + '%' }"
                />
              </div>
              <span class="phase-bar-value">{{ formatMs(data.avgRefMs) }}</span>
            </div>
            <div class="phase-bar-item">
              <span class="phase-bar-label">聚合模型</span>
              <div class="phase-bar-track">
                <div
                  class="phase-bar-fill phase-bar-agg"
                  :style="{ width: aggPhasePercent + '%' }"
                />
              </div>
              <span class="phase-bar-value">{{ formatMs(data.avgAggMs) }}</span>
            </div>
          </div>
        </NCard>

        <!-- 最近运行记录 -->
        <NCard title="最近运行记录" size="small">
          <NEmpty v-if="data.recentRuns.length === 0" description="暂无 MoA 运行记录" style="padding: 24px 0" />

          <div v-else class="run-table">
            <div class="run-table-header">
              <span class="col-time">时间</span>
              <span class="col-query">查询</span>
              <span class="col-mode">模式</span>
              <span class="col-status">状态</span>
              <span class="col-total">总耗时</span>
              <span class="col-ref">参考</span>
              <span class="col-agg">聚合</span>
              <span class="col-tokens">Tokens</span>
            </div>
            <div
              v-for="run in data.recentRuns"
              :key="run.id"
              class="run-row"
              :class="{ 'run-failed': !run.success }"
            >
              <span class="col-time">{{ formatTime(run.timestamp) }}</span>
              <span class="col-query" :title="run.queryPreview">{{ run.queryPreview.slice(0, 40) }}</span>
              <span class="col-mode">
                <NTag size="tiny" :bordered="false" :type="run.mode === 'parallel' ? 'info' : 'default'">
                  {{ run.mode }}
                </NTag>
              </span>
              <span class="col-status">
                <NTag size="tiny" :type="run.success ? 'success' : 'error'">
                  {{ run.success ? '成功' : '失败' }}
                </NTag>
              </span>
              <span class="col-total num">{{ formatMs(run.totalMs) }}</span>
              <span class="col-ref num">
                {{ run.validRefCount }}/{{ run.refCount }}
                <span class="muted">({{ formatMs(run.refMs) }})</span>
              </span>
              <span class="col-agg num">
                <span class="muted">{{ run.aggModel }}</span>
                {{ formatMs(run.aggMs) }}
              </span>
              <span class="col-tokens num">{{ formatTokens(run.totalTokens) }}</span>
            </div>
          </div>
        </NCard>
      </template>
    </NSpin>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  NGrid, NGi, NCard, NTag, NSpin, NAlert, NEmpty,
} from 'naive-ui';
import { fetchMoaPerformance, type MoaPerformanceData } from '../api/moa';

const loading = ref(true);
const error = ref<string | null>(null);
const data = ref<MoaPerformanceData | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    const res = await fetchMoaPerformance();
    if (res.ok && res.data) {
      data.value = res.data;
      error.value = null;
    } else {
      error.value = res.error ?? 'Failed to load MoA performance data';
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load MoA performance data';
  } finally {
    loading.value = false;
  }
}

const successRateType = computed(() => {
  if (!data.value || data.value.totalRuns === 0) return 'default';
  const rate = data.value.successRuns / data.value.totalRuns;
  return rate >= 0.9 ? 'success' : rate >= 0.7 ? 'warning' : 'error';
});

const successRateLabel = computed(() => {
  if (!data.value || data.value.totalRuns === 0) return '无数据';
  const rate = data.value.successRuns / data.value.totalRuns;
  return rate >= 0.9 ? '健康' : rate >= 0.7 ? '注意' : '告警';
});

const refPhasePercent = computed(() => {
  if (!data.value || data.value.avgTotalMs === 0) return 0;
  return Math.round((data.value.avgRefMs / data.value.avgTotalMs) * 100);
});

const aggPhasePercent = computed(() => {
  if (!data.value || data.value.avgTotalMs === 0) return 0;
  return Math.round((data.value.avgAggMs / data.value.avgTotalMs) * 100);
});

function formatMs(ms: number): string {
  if (ms <= 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

onMounted(() => {
  load();
  timer = setInterval(load, 10_000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.moa-perf-view {
  max-width: 1100px;
  padding: 0 4px;
}

.page-header {
  margin-bottom: 16px;
}

.page-title {
  font-size: var(--fs-h2);
  font-weight: 600;
  margin: 0 0 4px 0;
}

.page-subtitle {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
}

/* 概览卡片 */
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-label {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
}

.stat-value {
  font-size: var(--fs-h2);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stat-detail {
  display: flex;
  gap: 6px;
  align-items: center;
}

/* 阶段耗时条 */
.phase-bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.phase-bar-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.phase-bar-label {
  width: 80px;
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  text-align: right;
  flex-shrink: 0;
}

.phase-bar-track {
  flex: 1;
  height: 10px;
  background: var(--color-border);
  border-radius: 5px;
  overflow: hidden;
}

.phase-bar-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.5s ease;
}

.phase-bar-ref {
  background: var(--color-primary);
}

.phase-bar-agg {
  background: var(--color-success);
}

.phase-bar-value {
  width: 60px;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

/* 运行记录表格 */
.run-table {
  overflow-x: auto;
}

.run-table-header {
  display: flex;
  font-size: var(--fs-caption);
  font-weight: 500;
  color: var(--color-text-tertiary);
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border);
  gap: 8px;
}

.run-row {
  display: flex;
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--fs-body);
  gap: 8px;
  align-items: center;
}

.run-row:last-child {
  border-bottom: none;
}

.run-failed {
  background: rgba(208, 48, 80, 0.04);
}

.col-time { width: 70px; flex-shrink: 0; }
.col-query { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-mode { width: 55px; flex-shrink: 0; text-align: center; }
.col-status { width: 45px; flex-shrink: 0; text-align: center; }
.col-total { width: 65px; flex-shrink: 0; text-align: right; }
.col-ref { width: 100px; flex-shrink: 0; text-align: right; }
.col-agg { width: 95px; flex-shrink: 0; text-align: right; }
.col-tokens { width: 55px; flex-shrink: 0; text-align: right; }

.num {
  font-variant-numeric: tabular-nums;
}

.muted {
  color: var(--color-text-tertiary);
  font-size: var(--fs-caption);
}
</style>