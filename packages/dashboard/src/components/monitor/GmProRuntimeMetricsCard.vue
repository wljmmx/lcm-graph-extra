<script setup lang="ts">
/**
 * graph-memory-pro 运行时性能指标（/api/metrics → Prometheus 文本）。
 *
 * 展示策略（v2.11 重设计）：
 *   1. 健康总览条 —— 对全部指标做阈值判定，给出"正常/告警/严重"计数，一眼掌握整体健康
 *   2. 3 个精选可视化分组 —— 召回延迟分位数 / Embed LRU 命中率 / LLM·Embed 成功率
 *   3. 全量指标明细 —— 按业务域自动归类（检索质量/缓存/外部依赖/在线学习/债务调度/图谱规模/其他），
 *      支持关键词搜索 + 域过滤 + 阈值语义色，替代原来平铺的原始折叠区（防能力断链且不混乱）
 */
import { computed, ref } from 'vue';
import { NCard, NTag, NInput, NButton, NProgress, NEmpty, NSpin, NSpace } from 'naive-ui';
import CardState from './CardState.vue';
import { parsePrometheusText, type PromMetricFamily } from '../../utils/prometheus';

const props = withDefaults(defineProps<{
  metrics: unknown;
  loading?: boolean;
  isError?: boolean;
}>(), {
  loading: false,
  isError: false,
});

const emit = defineEmits<{ retry: [] }>();

// ── 原始 Prometheus 文本抽取 ──────────────────────────────────
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

// ── 业务域归类（按指标名关键词，兜底归入"其他"） ───────────────
type Status = 'good' | 'warn' | 'critical' | 'info';
type DomainKey = 'latency' | 'cache' | 'dependency' | 'learning' | 'debt' | 'graph' | 'other';

const DOMAINS: { key: DomainKey; label: string; keywords: string[] }[] = [
  { key: 'latency', label: '检索质量', keywords: ['latency', 'recall', 'search', 'response', 'duration', '_ms'] },
  { key: 'cache', label: '缓存效率', keywords: ['cache', 'hit', 'miss', 'lru', 'evict'] },
  { key: 'dependency', label: '外部依赖', keywords: ['breaker', 'success', 'failure', 'llm', 'embedding', 'timeout', 'error', 'retry', 'circuit'] },
  { key: 'learning', label: '在线学习', keywords: ['association', 'matrix', 'feedback', 'judge', 'learning', 'warmup'] },
  { key: 'debt', label: '债务与调度', keywords: ['debt', 'scheduler', 'compact', 'backlog', 'pending', 'queue'] },
  { key: 'graph', label: '图谱规模', keywords: ['node', 'edge', 'community', 'pagerank', 'graph', 'count', 'total'] },
];

function domainOf(name: string): DomainKey {
  for (const d of DOMAINS) {
    if (d.keywords.some((k) => name.includes(k))) return d.key;
  }
  return 'other';
}

// ── 值格式化与阈值判定 ────────────────────────────────────────
function familyStatus(name: string, value: number): Status {
  if (name === 'graph_memory_circuit_breaker_success_rate' || name === 'graph_memory_embed_cache_hit_rate') {
    if (value >= 0.9) return 'good';
    if (value >= 0.7) return 'warn';
    return 'critical';
  }
  return 'info';
}

function formatValue(name: string, value: number): string {
  const v = Number.isFinite(value) ? value : 0;
  if (name.includes('latency') || name.includes('_ms') || name.endsWith('_ms')) return `${v.toFixed(1)} ms`;
  if (name.includes('rate') || name.includes('ratio')) return `${(v * 100).toFixed(1)}%`;
  return v.toLocaleString();
}

const STATUS_LABEL: Record<Status, string> = { good: '正常', warn: '告警', critical: '严重', info: '—' };
const STATUS_TYPE: Record<Status, 'success' | 'warning' | 'error' | 'default'> = {
  good: 'success', warn: 'warning', critical: 'error', info: 'default',
};

/** 全量指标表：把每个 family 的每个样本映射为一行（含域、状态、格式化值） */
interface MetricRow { name: string; help: string; domain: DomainKey; labels: string; value: number; status: Status; formatted: string }
const allRows = computed<MetricRow[]>(() =>
  families.value.flatMap((f) =>
    f.samples.map((s) => {
      const labelStr = Object.keys(s.labels).length
        ? Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(', ')
        : '—';
      return {
        name: f.name, help: f.help ?? '', domain: domainOf(f.name),
        labels: labelStr, value: s.value, status: familyStatus(f.name, s.value),
        formatted: formatValue(f.name, s.value),
      };
    }),
  ),
);

// 健康总览：统计所有样本状态
const health = computed(() => {
  const c = { good: 0, warn: 0, critical: 0, info: 0 };
  for (const r of allRows.value) c[r.status]++;
  return c;
});

// ── 明细表筛选 ────────────────────────────────────────────────
const search = ref('');
const activeDomain = ref<DomainKey | 'all'>('all');
const visibleRows = computed<MetricRow[]>(() => {
  const kw = search.value.trim().toLowerCase();
  return allRows.value.filter((r) => {
    if (activeDomain.value !== 'all' && r.domain !== activeDomain.value) return false;
    if (kw && !(r.name.toLowerCase().includes(kw) || r.help.toLowerCase().includes(kw))) return false;
    return true;
  });
});
const domainCounts = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {};
  for (const r of allRows.value) m[r.domain] = (m[r.domain] ?? 0) + 1;
  return m;
});

// ── 精选可视化分组（沿用原有解析） ─────────────────────────────
interface LatencyRow { phase: string; p50?: number; p95?: number; p99?: number; count?: number }
const latencyRows = computed<LatencyRow[]>(() => {
  const fam = families.value.find((f) => f.name === 'graph_memory_recall_latency_ms');
  if (!fam) return [];
  const byPhase = new Map<string, LatencyRow>();
  for (const s of fam.samples) {
    const phase = s.labels.phase ?? '未知';
    const quantile = s.labels.quantile;
    if (!quantile) continue;
    let row = byPhase.get(phase);
    if (!row) { row = { phase }; byPhase.set(phase, row); }
    const q = Number(quantile);
    if (q <= 0.5) row.p50 = s.value;
    else if (q <= 0.95) row.p95 = s.value;
    else row.p99 = s.value;
  }
  return [...byPhase.values()];
});
const latencyCounts = computed<Map<string, number>>(() => {
  const m = new Map<string, number>();
  const fam = families.value.find((f) => f.name === 'graph_memory_recall_latency_ms_count' || f.name === 'graph_memory_recall_latency_ms');
  if (!fam) return m;
  for (const s of fam.samples) {
    if (!s.labels.quantile) m.set(s.labels.phase ?? '未知', (m.get(s.labels.phase ?? '未知') ?? 0) + s.value);
  }
  return m;
});

interface RateRow { target: string; rate?: number; ok: number; fail: number }
const hitRateRows = computed<RateRow[]>(() => {
  const hitFam = families.value.find((f) => f.name === 'graph_memory_embed_cache_hit_rate');
  const hitsFam = families.value.find((f) => f.name === 'graph_memory_embed_cache_hits_total');
  const missesFam = families.value.find((f) => f.name === 'graph_memory_embed_cache_misses_total');
  const byTarget = new Map<string, RateRow>();
  const ensure = (t: string): RateRow => {
    let r = byTarget.get(t);
    if (!r) { r = { target: t, ok: 0, fail: 0 }; byTarget.set(t, r); }
    return r;
  };
  hitFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').rate = s.value; });
  hitsFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').ok += s.value; });
  missesFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').fail += s.value; });
  return [...byTarget.values()];
});
const successRows = computed<RateRow[]>(() => {
  const rateFam = families.value.find((f) => f.name === 'graph_memory_circuit_breaker_success_rate');
  const okFam = families.value.find((f) => f.name === 'graph_memory_circuit_breaker_success_total');
  const failFam = families.value.find((f) => f.name === 'graph_memory_circuit_breaker_failure_total');
  const byTarget = new Map<string, RateRow>();
  const ensure = (t: string): RateRow => {
    let r = byTarget.get(t);
    if (!r) { r = { target: t, ok: 0, fail: 0 }; byTarget.set(t, r); }
    return r;
  };
  rateFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').rate = s.value; });
  okFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').ok += s.value; });
  failFam?.samples.forEach((s) => { ensure(s.labels.target ?? '未知').fail += s.value; });
  return [...byTarget.values()];
});

const fmtMs = (v?: number): string => (v == null ? '—' : `${v.toFixed(1)} ms`);
const fmtRate = (v?: number): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const pctOf = (ok: number, fail: number): number =>
  ok + fail > 0 ? Math.round((ok / (ok + fail)) * 100) : 0;

const barColor = (rate?: number): string => (rate ?? 1) >= 0.9 ? '#18a058' : (rate ?? 1) >= 0.7 ? '#f0a020' : '#d03050';
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
          <!-- 0) 健康总览条 -->
          <section v-if="hasData" class="health-strip">
            <span class="health-item"><i class="dot" style="background:#18a058"></i>正常 {{ health.good }}</span>
            <span class="health-item"><i class="dot" style="background:#f0a020"></i>告警 {{ health.warn }}</span>
            <span class="health-item"><i class="dot" style="background:#d03050"></i>严重 {{ health.critical }}</span>
            <span class="health-item muted"><i class="dot" style="background:var(--color-text-3)"></i>中性 {{ health.info }}</span>
            <NTag size="tiny" :bordered="false" type="default">{{ allRows.length }} 个指标序列</NTag>
          </section>

          <!-- 1) 检索质量：召回延迟分位数 -->
          <section class="metric-block">
            <div class="metric-title">
              <span>检索质量 · 召回延迟</span>
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

          <!-- 2) 缓存效率：Embedding LRU 命中率 -->
          <section class="metric-block">
            <div class="metric-title">
              <span>缓存效率 · Embedding LRU</span>
              <NTag size="small" :bordered="false" type="info">hits / misses</NTag>
            </div>
            <div v-if="hitRateRows.length" class="rate-list">
              <div v-for="row in hitRateRows" :key="row.target" class="rate-row">
                <div class="rate-head">
                  <span class="mono cell-label">{{ row.target }}</span>
                  <span class="mono rate-num">{{ fmtRate(row.rate) }}</span>
                </div>
                <NProgress :percentage="Math.round((row.rate ?? 0) * 100)" :height="8" :show-indicator="false"
                  :color="barColor(row.rate)" track-color="rgba(128,128,128,0.15)" />
                <div class="rate-sub mono">{{ row.ok }} hits · {{ row.fail }} misses · 综合 {{ pctOf(row.ok, row.fail) }}%</div>
              </div>
            </div>
            <NEmpty v-else description="暂无 Embedding 缓存样本" :style="{ padding: '8px 0' }" />
          </section>

          <!-- 3) 外部依赖健康：LLM / Embedding 成功率 -->
          <section class="metric-block">
            <div class="metric-title">
              <span>外部依赖 · LLM / Embedding 成功率</span>
              <NTag size="small" :bordered="false" type="info">熔断器推导</NTag>
            </div>
            <div v-if="successRows.length" class="rate-list">
              <div v-for="row in successRows" :key="row.target" class="rate-row">
                <div class="rate-head">
                  <span class="mono cell-label">{{ row.target }}</span>
                  <span class="mono rate-num" :class="{ 'rate-warn': (row.rate ?? 1) < 0.9 }">{{ fmtRate(row.rate) }}</span>
                </div>
                <NProgress :percentage="Math.round((row.rate ?? 1) * 100)" :height="8" :show-indicator="false"
                  :color="barColor(row.rate)" track-color="rgba(128,128,128,0.15)" />
                <div class="rate-sub mono">{{ row.ok }} 成功 · {{ row.fail }} 失败 · {{ pctOf(row.ok, row.fail) }}%</div>
              </div>
            </div>
            <NEmpty v-else description="暂无调用成功率样本" :style="{ padding: '8px 0' }" />
          </section>

          <!-- 4) 全量指标明细：分组 + 搜索 + 语义色 -->
          <section v-if="allRows.length" class="metric-block">
            <div class="metric-title">
              <span>全量指标明细</span>
              <NTag size="small" :bordered="false" type="default">{{ allRows.length }} 序列</NTag>
            </div>

            <!-- 筛选控制 -->
            <NSpace align="center" :size="6" wrap>
              <NInput v-model:value="search" size="small" placeholder="搜索指标名 / 说明…" clearable
                style="max-width:220px" />
              <NButton size="tiny" :type="activeDomain === 'all' ? 'primary' : 'default'" @click="activeDomain = 'all'">全部</NButton>
              <NButton v-for="d in DOMAINS" :key="d.key" size="tiny"
                :type="activeDomain === d.key ? 'primary' : 'default'"
                @click="activeDomain = activeDomain === d.key ? 'all' : d.key">
                {{ d.label }} ({{ domainCounts[d.key] ?? 0 }})
              </NButton>
              <NButton v-if="domainCounts.other" size="tiny"
                :type="activeDomain === 'other' ? 'primary' : 'default'"
                @click="activeDomain = activeDomain === 'other' ? 'all' : 'other'">
                其他 ({{ domainCounts.other }})
              </NButton>
            </NSpace>

            <div class="detail-list">
              <div v-for="r in visibleRows" :key="r.name + r.labels" class="detail-row">
                <NTag size="tiny" :bordered="false" :type="STATUS_TYPE[r.status]" style="flex:none">
                  {{ STATUS_LABEL[r.status] }}
                </NTag>
                <div class="detail-main">
                  <div class="detail-name mono">{{ r.name }}</div>
                  <div v-if="r.help" class="detail-help">{{ r.help }}</div>
                  <div class="detail-labels mono">{{ r.labels }}</div>
                </div>
                <span class="detail-value mono">{{ r.formatted }}</span>
              </div>
              <NEmpty v-if="!visibleRows.length" description="无匹配指标" :style="{ padding: '8px 0' }" />
            </div>
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

/* 健康总览条 */
.health-strip {
  display: flex; align-items: center; flex-wrap: wrap; gap: 12px;
  padding: 8px 10px; border-radius: 6px;
  background: var(--color-border-subtle);
  font-size: var(--fs-caption);
}
.health-item { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.health-item.muted { color: var(--text-3, #8a919c); font-weight: 400; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

/* 延迟 */
.nominal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.nominal-cell { border: 1px solid rgba(128,128,128,0.18); border-radius: 6px; padding: 8px; }
.cell-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
.cell-label { font-size: var(--fs-caption); font-weight: 600; }
.quantile-row { display: flex; flex-direction: column; gap: 2px; }
.q { display: flex; justify-content: space-between; font-size: var(--fs-caption); }
.q-name { color: var(--text-3, #8a919c); }
.q-val { font-weight: 600; }
.q-hot { color: #d03050; }

/* 成功率 */
.rate-list { display: flex; flex-direction: column; gap: 10px; }
.rate-row { display: flex; flex-direction: column; gap: 4px; }
.rate-head { display: flex; justify-content: space-between; align-items: center; }
.rate-num { font-weight: 700; }
.rate-warn { color: #d03050; }
.rate-sub { font-size: 12px; color: var(--text-3, #8a919c); }

/* 明细表 */
.detail-list { display: flex; flex-direction: column; gap: 4px; max-height: 360px; overflow-y: auto; }
.detail-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 5px 6px; border-radius: 5px;
  border-bottom: 1px solid rgba(128,128,128,0.10);
}
.detail-row:hover { background: var(--color-border-subtle); }
.detail-main { flex: 1; min-width: 0; }
.detail-name { font-size: var(--fs-caption); font-weight: 600; }
.detail-help { font-size: 12px; color: var(--text-3, #8a919c); }
.detail-labels { font-size: 11px; color: var(--text-3, #8a919c); }
.detail-value { font-size: var(--fs-caption); font-weight: 700; flex: none; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
