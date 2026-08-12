<script setup lang="ts">
/**
 * graph-memory-pro 运行时性能指标（/api/metrics → Prometheus 文本）。
 *
 * 展示 P2-9 补齐的 4 类核心指标：
 *  1. 召回延迟 P50/P95/P99 —— graph_memory_recall_latency_ms{phase,quantile}
 *  2. Embedding LRU 命中率 —— graph_memory_embed_cache_hit_rate{target} + hits/misses_total
 *  3. LLM/Embedding 调用成功率 —— graph_memory_circuit_breaker_success_rate{target} + success/failure_total
 *  4. 其余全部指标 —— 折叠区完整罗列（防能力断链，任何新增指标都可见）
 *
 * 数据契约：后端代理对 text/plain 透传原始文本，故 props.metrics 可能是字符串或 { text }。
 */
import { computed } from 'vue';
import { NCard, NTag, NCollapse, NCollapseItem, NDescriptions, NDescriptionsItem, NProgress, NEmpty, NSpin } from 'naive-ui';
import CardState from './CardState.vue';
import { parsePrometheusText, type PromMetricFamily } from '../../utils/prometheus';

const props = withDefaults(defineProps<{
  /** 后端 /api/gm-pro/proxy/metrics 返回的 data（字符串或 { text }） */
  metrics: unknown;
  loading?: boolean;
  isError?: boolean;
}>(), {
  loading: false,
  isError: false,
});

const emit = defineEmits<{ retry: [] }>();

/** 抽取原始 Prometheus 文本 */
const rawText = computed<string>(() => {
  if (props.metrics == null) return '';
  if (typeof props.metrics === 'string') return props.metrics;
  if (typeof props.metrics === 'object') {
    const maybe = (props.metrics as { text?: string }).text;
    if (typeof maybe === 'string') return maybe;
  }
  return '';
});

const families = computed<PromMetricFamily[]>(() =>
  rawText.value ? parsePrometheusText(rawText.value) : [],
);

const hasData = computed(() => families.value.length > 0);

// ── 1) 召回延迟 P50/P95/P99（按 phase 分组）──────────────
interface LatencyRow { phase: string; p50?: number; p95?: number; p99?: number; count?: number }
const latencyRows = computed<LatencyRow[]>(() => {
  const fam = families.value.find((f) => f.name === 'graph_memory_recall_latency_ms');
  if (!fam) return [];
  const byPhase = new Map<string, LatencyRow>();
  for (const s of fam.samples) {
    const phase = s.labels.phase ?? '未知';
    const quantile = s.labels.quantile;
    if (!quantile) continue; // 跳过 _sum / _count
    let row = byPhase.get(phase);
    if (!row) { row = { phase }; byPhase.set(phase, row); }
    const q = Number(quantile);
    if (q <= 0.5) row.p50 = s.value;
    else if (q <= 0.95) row.p95 = s.value;
    else row.p99 = s.value;
  }
  return [...byPhase.values()];
});

// 同时收集各 phase 的 _count（调用次数）
const latencyCounts = computed<Map<string, number>>(() => {
  const m = new Map<string, number>();
  const fam = families.value.find((f) => f.name === 'graph_memory_recall_latency_ms_count' || f.name === 'graph_memory_recall_latency_ms');
  if (!fam) return m;
  for (const s of fam.samples) {
    // 只取 count 样本（无 quantile 标签）
    if (!s.labels.quantile) {
      const phase = s.labels.phase ?? '未知';
      m.set(phase, (m.get(phase) ?? 0) + s.value);
    }
  }
  return m;
});

// ── 2) Embedding LRU 命中率（按 target）──────────────────
interface HitRateRow { target: string; rate?: number; hits: number; misses: number }
const hitRateRows = computed<HitRateRow[]>(() => {
  const hitFam = families.value.find((f) => f.name === 'graph_memory_embed_cache_hit_rate');
  const hitsFam = families.value.find((f) => f.name === 'graph_memory_embed_cache_hits_total');
  const missesFam = families.value.find((f) => f.name === 'graph_memory_embed_cache_misses_total');
  const byTarget = new Map<string, HitRateRow>();
  const ensure = (t: string): HitRateRow => {
    let r = byTarget.get(t);
    if (!r) { r = { target: t, hits: 0, misses: 0 }; byTarget.set(t, r); }
    return r;
  };
  hitFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').rate = s.value; });
  hitsFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').hits += s.value; });
  missesFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').misses += s.value; });
  return [...byTarget.values()];
});

// ── 3) LLM/Embedding 成功率（按 target）──────────────────
interface SuccessRow { target: string; rate?: number; ok: number; fail: number }
const successRows = computed<SuccessRow[]>(() => {
  const rateFam = families.value.find((f) => f.name === 'graph_memory_circuit_breaker_success_rate');
  const okFam = families.value.find((f) => f.name === 'graph_memory_circuit_breaker_success_total');
  const failFam = families.value.find((f) => f.name === 'graph_memory_circuit_breaker_failure_total');
  const byTarget = new Map<string, SuccessRow>();
  const ensure = (t: string): SuccessRow => {
    let r = byTarget.get(t);
    if (!r) { r = { target: t, ok: 0, fail: 0 }; byTarget.set(t, r); }
    return r;
  };
  rateFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').rate = s.value; });
  okFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').ok += s.value; });
  failFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').fail += s.value; });
  return [...byTarget.values()];
});

// ── 4) 其余指标（折叠区）─────────────────────────────────
const otherFamilies = computed<PromMetricFamily[]>(() => families.value.filter((f) => {
  const known = ['graph_memory_recall_latency_ms', 'graph_memory_embed_cache_hit_rate',
    'graph_memory_embed_cache_hits_total', 'graph_memory_embed_cache_misses_total',
    'graph_memory_circuit_breaker_success_rate', 'graph_memory_circuit_breaker_success_total',
    'graph_memory_circuit_breaker_failure_total'];
  return !known.includes(f.name);
}));

const fmtMs = (v?: number): string => (v == null ? '—' : `${v.toFixed(1)} ms`);
const fmtRate = (v?: number): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const pctOf = (ok: number, fail: number): number =>
  ok + fail > 0 ? Math.round((ok / (ok + fail)) * 100) : 0;
</script>

<template>
  <NCard title="graph-memory-pro 运行时性能" size="small">
    <CardState
      :loading="loading"
      :is-error="isError"
      :has-data="hasData"
      empty-text="暂无性能指标"
      error-text="性能指标请求失败"
      empty-hint="请确认 graph-memory-pro 已启用 /api/metrics（Prometheus 文本）。"
      :skeleton-rows="4"
      @retry="emit('retry')"
    >
      <NSpin :show="loading">
        <div class="gm-metrics">
          <!-- 1) 召回延迟 P50/P95/P99 -->
          <section class="metric-block">
            <div class="metric-title">
              <span>召回延迟分位数</span>
              <NTag size="small" :bordered="false" type="info">P50 / P95 / P99</NTag>
            </div>
            <div v-if="latencyRows.length" class="nominal-grid">
              <div v-for="row in latencyRows" :key="row.phase" class="nominal-cell">
                <div class="cell-head">
                  <span class="cell-label">{{ row.phase }}</span>
                  <NTag v-if="latencyCounts.get(row.phase)" size="tiny" :bordered="false" type="default">
                    {{ latencyCounts.get(row.phase) }} 次
                  </NTag>
                </div>
                <div class="quantile-row">
                  <div class="q"><span class="q-name">P50</span><span class="mono q-val">{{ fmtMs(row.p50) }}</span></div>
                  <div class="q"><span class="q-name">P95</span><span class="mono q-val">{{ fmtMs(row.p95) }}</span></div>
                  <div class="q"><span class="q-name">P99</span><span class="mono q-val q-hot">{{ fmtMs(row.p99) }}</span></div>
                </div>
              </div>
            </div>
            <NEmpty v-else description="暂无召回延迟样本" :style="{ padding: '8px 0' }" />
          </section>

          <!-- 2) Embedding LRU 命中率 -->
          <section class="metric-block">
            <div class="metric-title">
              <span>Embedding LRU 命中率</span>
              <NTag size="small" :bordered="false" type="info">hits / misses</NTag>
            </div>
            <div v-if="hitRateRows.length" class="rate-list">
              <div v-for="row in hitRateRows" :key="row.target" class="rate-row">
                <div class="rate-head">
                  <span class="mono cell-label">{{ row.target }}</span>
                  <span class="mono rate-num">{{ fmtRate(row.rate) }}</span>
                </div>
                <NProgress
                  :percentage="Math.round((row.rate ?? 0) * 100)"
                  :height="8"
                  :show-indicator="false"
                  color="#2080f0"
                  track-color="rgba(128,128,128,0.15)"
                />
                <div class="rate-sub mono">
                  {{ row.hits }} hits · {{ row.misses }} misses · 综合 {{ pctOf(row.hits, row.misses) }}%
                </div>
              </div>
            </div>
            <NEmpty v-else description="暂无 Embedding 缓存样本" :style="{ padding: '8px 0' }" />
          </section>

          <!-- 3) LLM / Embedding 调用成功率 -->
          <section class="metric-block">
            <div class="metric-title">
              <span>LLM / Embedding 成功率</span>
              <NTag size="small" :bordered="false" type="info">熔断器推导</NTag>
            </div>
            <div v-if="successRows.length" class="rate-list">
              <div v-for="row in successRows" :key="row.target" class="rate-row">
                <div class="rate-head">
                  <span class="mono cell-label">{{ row.target }}</span>
                  <span class="mono rate-num" :class="{ 'rate-warn': (row.rate ?? 1) < 0.9 }">{{ fmtRate(row.rate) }}</span>
                </div>
                <NProgress
                  :percentage="Math.round((row.rate ?? 1) * 100)"
                  :height="8"
                  :show-indicator="false"
                  :color="(row.rate ?? 1) >= 0.9 ? '#18a058' : '#f0a020'"
                  track-color="rgba(128,128,128,0.15)"
                />
                <div class="rate-sub mono">
                  {{ row.ok }} 成功 · {{ row.fail }} 失败 · {{ pctOf(row.ok, row.fail) }}%
                </div>
              </div>
            </div>
            <NEmpty v-else description="暂无调用成功率样本" :style="{ padding: '8px 0' }" />
          </section>

          <!-- 4) 其余指标（防断链折叠区） -->
          <section v-if="otherFamilies.length" class="metric-block">
            <div class="metric-title">
              <span>其余指标</span>
              <NTag size="small" :bordered="false" type="default">{{ otherFamilies.length }} 个指标族</NTag>
            </div>
            <NCollapse size="small">
              <NCollapseItem
                v-for="fam in otherFamilies"
                :key="fam.name"
                :title="`${fam.name}${fam.help ? ' — ' + fam.help : ''}`"
                :name="fam.name"
              >
                <NDescriptions :column="1" size="small" label-placement="left" bordered>
                  <NDescriptionsItem v-for="(s, i) in fam.samples" :key="i" :label="Object.keys(s.labels).length ? Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(', ') : 'value'">
                    <span class="mono">{{ s.value }}</span>
                  </NDescriptionsItem>
                </NDescriptions>
              </NCollapseItem>
            </NCollapse>
          </section>
        </div>
      </NSpin>
    </CardState>
  </NCard>
</template>

<style scoped>
.gm-metrics { display: flex; flex-direction: column; gap: 14px; }
.metric-block { display: flex; flex-direction: column; gap: 8px; }
.metric-title { display: flex; align-items: center; gap: 8px; font-size: var(--fs-caption); font-weight: 600; color: var(--text-2, #57606a); }
.nominal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.nominal-cell { border: 1px solid rgba(128,128,128,0.18); border-radius: 6px; padding: 8px; }
.cell-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
.cell-label { font-size: var(--fs-caption); font-weight: 600; }
.quantile-row { display: flex; flex-direction: column; gap: 2px; }
.q { display: flex; justify-content: space-between; font-size: var(--fs-caption); }
.q-name { color: var(--text-3, #8a919c); }
.q-val { font-weight: 600; }
.q-hot { color: #d03050; }
.rate-list { display: flex; flex-direction: column; gap: 10px; }
.rate-row { display: flex; flex-direction: column; gap: 4px; }
.rate-head { display: flex; justify-content: space-between; align-items: center; }
.rate-num { font-weight: 700; }
.rate-warn { color: #d03050; }
.rate-sub { font-size: 12px; color: var(--text-3, #8a919c); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>