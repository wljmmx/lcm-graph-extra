<script setup lang="ts">
/**
 * Benchmark 性能压测页面（v2.2.0）。
 *
 * 功能：
 * - 配置区：QMD 地址（系统配置/手动）+ limit + 超时 + rerank + 模式 + 并发数
 * - 测试集预览：内置 20 条 fixtures，按分类统计 + 列表展示
 * - 执行：调用 POST /api/benchmark/run，等待返回完整 BenchmarkResult
 * - 结果可视化（4 个 Tab）：
 *   1. 概览：KPI 卡片（成功率/平均延迟/P95/总耗时/tokens/压缩率/召回率）
 *   2. 性能分布：延迟分布柱状图（P50/P90/P95/P99/max）+ 按分类延迟箱线图
 *   3. Tokens & 召回率：tokens 消耗饼图 + 召回率柱状图 + 压缩率展示
 *   4. 逐条详情 + 失败用例：完整列表，可下载 Markdown 报告
 * - 历史记录：侧边列表，可点击查看历史报告
 */
import { computed, onMounted, ref } from 'vue';
import {
  NCard,
  NSpace,
  NInput,
  NInputNumber,
  NSelect,
  NButton,
  NTag,
  NTable,
  NAlert,
  NStatistic,
  NGrid,
  NGi,
  NSwitch,
  NTabs,
  NTabPane,
  NEmpty,
  NCollapse,
  NCollapseItem,
  NList,
  NListItem,
  NThing,
  NDivider,
  NSpin,
  useMessage,
} from 'naive-ui';
import EChart from '../components/EChart.vue';
import {
  fetchBenchmarkFixtures,
  fetchBenchmarkDefaultUrl,
  fetchBenchmarkHistory,
  runBenchmark,
  downloadBenchmarkMarkdown,
  type BenchmarkFixture,
  type BenchmarkResult,
  type BenchmarkMode,
  type BenchmarkHistoryItem,
} from '../api/benchmark';

const message = useMessage();

// ===== 配置区状态 =====
const baseUrl = ref<string>('');
const useCustomUrl = ref<boolean>(false);
const limit = ref<number>(5);
const timeoutMs = ref<number>(10000);
const rerank = ref<boolean>(true);
const mode = ref<BenchmarkMode>('rest');
const concurrency = ref<number>(1);

const modeOptions = [
  { label: 'REST /query（推荐，稳定快速）', value: 'rest' as BenchmarkMode },
  { label: 'MCP /mcp（完整握手 + tools/call，易超时）', value: 'mcp' as BenchmarkMode },
];

const concurrencyOptions = [
  { label: '1（串行，准确反映单次延迟）', value: 1 },
  { label: '2', value: 2 },
  { label: '4', value: 4 },
  { label: '8（高并发，注意 QMD 排队）', value: 8 },
];

// ===== 测试集状态 =====
const fixtures = ref<BenchmarkFixture[]>([]);
const categoryStats = ref<Record<string, number>>({});
const fixturesLoading = ref<boolean>(false);

// ===== 执行状态 =====
const loading = ref<boolean>(false);
const result = ref<BenchmarkResult | null>(null);
const errorMsg = ref<string>('');
const activeTab = ref<string>('overview');

// ===== 历史记录 =====
const history = ref<BenchmarkHistoryItem[]>([]);

// ===== 初始化 =====
onMounted(async () => {
  fixturesLoading.value = true;
  try {
    const [fixturesResp, urlResp, historyResp] = await Promise.all([
      fetchBenchmarkFixtures(),
      fetchBenchmarkDefaultUrl(),
      fetchBenchmarkHistory(),
    ]);
    if (fixturesResp.ok) {
      fixtures.value = fixturesResp.fixtures;
      categoryStats.value = fixturesResp.categoryStats;
    }
    if (urlResp.ok && urlResp.defaultUrl) {
      baseUrl.value = urlResp.defaultUrl;
    } else {
      baseUrl.value = 'http://127.0.0.1:8081';
    }
    if (historyResp.ok) {
      history.value = historyResp.history;
    }
  } catch (e) {
    baseUrl.value = 'http://127.0.0.1:8081';
    message.warning(`初始化失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    fixturesLoading.value = false;
  }
});

// ===== 执行压测 =====
async function executeBenchmark(): Promise<void> {
  if (!baseUrl.value.trim()) {
    message.error('QMD MCP 地址不能为空');
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  result.value = null;

  try {
    const finalBaseUrl = useCustomUrl.value ? baseUrl.value.trim() : '';
    const resp = await runBenchmark({
      baseUrl: finalBaseUrl,
      limit: limit.value,
      timeoutMs: timeoutMs.value,
      rerank: rerank.value,
      mode: mode.value,
      concurrency: concurrency.value,
    });
    if (!resp.ok || !resp.result) {
      errorMsg.value = resp.error ?? '压测失败';
      message.error(errorMsg.value);
    } else {
      result.value = resp.result;
      message.success(
        `压测完成：${resp.result.summary.successCount}/${resp.result.summary.totalFixtures} 成功，` +
        `平均 ${resp.result.summary.latency.avg.toFixed(0)}ms，P95 ${resp.result.summary.latency.p95}ms`,
      );
      activeTab.value = 'overview';
      // 刷新历史列表
      try {
        const histResp = await fetchBenchmarkHistory();
        if (histResp.ok) {
          history.value = histResp.history;
        }
      } catch {
        // 忽略历史刷新失败
      }
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
    message.error(`压测请求失败: ${errorMsg.value}`);
  } finally {
    loading.value = false;
  }
}

// ===== 加载历史报告 =====
async function loadHistoryReport(item: BenchmarkHistoryItem): Promise<void> {
  try {
    const resp = await fetch(`/api/benchmark/report/${encodeURIComponent(item.runId)}`);
    if (!resp.ok) {
      message.error(`加载失败: HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json();
    if (data.ok && data.result) {
      result.value = data.result;
      activeTab.value = 'overview';
      message.success(`已加载历史报告: ${item.runId.slice(0, 19)}`);
    } else {
      message.error(data.error ?? '加载失败');
    }
  } catch (e) {
    message.error(`加载失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ===== 下载报告 =====
function downloadMd(): void {
  if (!result.value) return;
  downloadBenchmarkMarkdown(result.value.runId);
}

function downloadJson(): void {
  if (!result.value) return;
  const blob = new Blob([JSON.stringify(result.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `benchmark-${result.value.runId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== 辅助函数 =====
function latencyLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function latencyTagType(ms: number): 'success' | 'warning' | 'error' {
  if (ms < 1000) return 'success';
  if (ms < 3000) return 'warning';
  return 'error';
}

function successRateTagType(rate: number): 'success' | 'warning' | 'error' {
  if (rate >= 0.95) return 'success';
  if (rate >= 0.8) return 'warning';
  return 'error';
}

function recallTagType(recall: number): 'success' | 'warning' | 'error' {
  if (recall >= 0.8) return 'success';
  if (recall >= 0.5) return 'warning';
  return 'error';
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    knowledge: '知识',
    experience: '经验',
    error: '错误',
    config: '配置',
    multilingual: '多语言',
    mixed: '复合',
  };
  return map[cat] ?? cat;
}

// ===== 派生数据：结果摘要 =====
const summary = computed(() => result.value?.summary ?? null);

// ===== ECharts: 延迟分布柱状图（P50/P90/P95/P99/max） =====
const latencyDistributionOption = computed(() => {
  if (!summary.value) return {};
  const s = summary.value;
  const labels = ['min', 'P50', 'P90', 'P95', 'P99', 'max', 'avg'];
  const values = [s.latency.min, s.latency.p50, s.latency.p90, s.latency.p95, s.latency.p99, s.latency.max, Math.round(s.latency.avg)];
  return {
    title: { text: '延迟分布（百分位）', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const p = params[0];
        return `${p.name}: ${latencyLabel(p.value)}`;
      },
    },
    grid: { left: 60, right: 20, top: 50, bottom: 30 },
    xAxis: { type: 'category', data: labels },
    yAxis: {
      type: 'value',
      name: 'ms',
      axisLabel: { formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}`) },
    },
    series: [{
      type: 'bar',
      data: values.map((v, i) => ({
        value: v,
        itemStyle: {
          color: i >= 3 && i <= 4 ? '#faad14' : (i >= 5 ? '#ff4d4f' : '#52c41a'),
        },
      })),
      label: {
        show: true,
        position: 'top',
        formatter: (p: any) => latencyLabel(p.value),
        fontSize: 10,
      },
    }],
  };
});

// ===== ECharts: 按分类的平均延迟 =====
const categoryLatencyOption = computed(() => {
  if (!summary.value) return {};
  const cats = summary.value.byCategory;
  return {
    title: { text: '按分类平均延迟', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const p = params[0];
        const cat = cats[p.dataIndex];
        return `${categoryLabel(cat.category)}<br/>` +
          `平均延迟: ${latencyLabel(p.value)}<br/>` +
          `成功率: ${(cat.successRate * 100).toFixed(0)}%<br/>` +
          `平均结果数: ${cat.avgResultCount.toFixed(1)}`;
      },
    },
    grid: { left: 60, right: 20, top: 50, bottom: 50 },
    xAxis: {
      type: 'category',
      data: cats.map((c) => categoryLabel(c.category)),
      axisLabel: { interval: 0, rotate: 0 },
    },
    yAxis: {
      type: 'value',
      name: 'ms',
      axisLabel: { formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}`) },
    },
    series: [{
      type: 'bar',
      data: cats.map((c) => Math.round(c.avgLatencyMs)),
      itemStyle: { color: '#2080f0' },
      label: {
        show: true,
        position: 'top',
        formatter: (p: any) => latencyLabel(p.value),
        fontSize: 10,
      },
    }],
  };
});

// ===== ECharts: tokens 消耗饼图 =====
const tokensOption = computed(() => {
  if (!summary.value) return {};
  const t = summary.value.estimatedTokens;
  return {
    title: { text: 'Tokens 消耗', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
    },
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['50%', '50%'],
      label: { formatter: '{b}\n{c}', fontSize: 11 },
      data: [
        { name: '输入 tokens', value: t.input },
        { name: '输出 tokens', value: t.output },
      ],
    }],
  };
});

// ===== ECharts: 召回率（按分类） =====
const recallOption = computed(() => {
  if (!summary.value) return {};
  const cats = summary.value.byCategory.filter((c) => c.avgRecall !== null);
  if (cats.length === 0) return {};
  return {
    title: { text: '召回率（按分类）', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const p = params[0];
        const cat = cats[p.dataIndex];
        return `${categoryLabel(cat.category)}<br/>` +
          `召回率: ${(cat.avgRecall! * 100).toFixed(1)}%<br/>` +
          `评估用例数: ${cat.recallEvaluated}`;
      },
    },
    grid: { left: 60, right: 20, top: 50, bottom: 50 },
    xAxis: { type: 'category', data: cats.map((c) => categoryLabel(c.category)) },
    yAxis: {
      type: 'value',
      name: '召回率',
      min: 0,
      max: 1,
      axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
    },
    series: [{
      type: 'bar',
      data: cats.map((c) => c.avgRecall),
      itemStyle: { color: '#52c41a' },
      label: {
        show: true,
        position: 'top',
        formatter: (p: any) => `${(p.value * 100).toFixed(0)}%`,
        fontSize: 10,
      },
    }],
  };
});

// ===== ECharts: 单条用例延迟分布散点图 =====
const itemsLatencyOption = computed(() => {
  if (!result.value) return {};
  return {
    title: { text: '逐条用例延迟散点', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => {
        const item = result.value!.items[p.dataIndex];
        return `${item.fixtureId}<br/>` +
          `${item.query.slice(0, 60)}${item.query.length > 60 ? '...' : ''}<br/>` +
          `分类: ${categoryLabel(item.category)}<br/>` +
          `延迟: ${latencyLabel(item.latencyMs)}<br/>` +
          `结果数: ${item.resultCount}<br/>` +
          `状态: ${item.success ? '成功' : '失败'}`;
      },
    },
    grid: { left: 60, right: 20, top: 50, bottom: 50 },
    xAxis: { type: 'category', data: result.value.items.map((i) => i.fixtureId), axisLabel: { rotate: 45, fontSize: 10 } },
    yAxis: {
      type: 'value',
      name: 'ms',
      axisLabel: { formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}`) },
    },
    series: [{
      type: 'scatter',
      data: result.value.items.map((i, idx) => ({
        value: [idx, i.latencyMs],
        itemStyle: { color: i.success ? '#52c41a' : '#ff4d4f' },
      })),
      symbolSize: 10,
    }],
  };
});

// ===== 失败用例列表 =====
const failedItems = computed(() => result.value?.items.filter((i) => !i.success) ?? []);

// ===== 有召回率评估的用例数 =====
const recallEvaluatedCount = computed(() =>
  result.value?.items.filter((i) => i.recall !== null).length ?? 0,
);
</script>

<template>
  <NSpace vertical :size="16">
    <!-- ===== 配置区 ===== -->
    <NCard size="small" :bordered="true">
      <div class="section-header">
        <h3 style="margin: 0; font-size: var(--fs-subtitle)">Benchmark 性能压测配置</h3>
        <span class="muted">标准测试集 + 多轮会话召回率/tokens/压缩率/性能分布评估</span>
      </div>

      <NSpace vertical :size="12" style="margin-top: 12px">
        <!-- 测试模式 + 并发 -->
        <NGrid :cols="'1 m:2'" :x-gap="12" :y-gap="8" responsive="screen">
          <NGi>
            <div class="form-row">
              <span class="form-label">测试模式</span>
              <NSelect v-model:value="mode" :options="modeOptions" size="small" style="flex: 1" />
            </div>
          </NGi>
          <NGi>
            <div class="form-row">
              <span class="form-label">并发数</span>
              <NSelect v-model:value="concurrency" :options="concurrencyOptions" size="small" style="flex: 1" />
            </div>
          </NGi>
        </NGrid>

        <!-- 地址 + 超时 -->
        <NGrid :cols="'1 m:3'" :x-gap="12" :y-gap="8" responsive="screen">
          <NGi>
            <div class="form-row">
              <span class="form-label">地址来源</span>
              <NSwitch v-model:value="useCustomUrl" size="small">
                <template #checked>手动输入</template>
                <template #unchecked>系统配置</template>
              </NSwitch>
            </div>
          </NGi>
          <NGi>
            <div class="form-row">
              <span class="form-label">QMD 地址</span>
              <NInput
                v-model:value="baseUrl"
                size="small"
                placeholder="http://127.0.0.1:8081"
                :disabled="!useCustomUrl"
                style="flex: 1"
              />
            </div>
          </NGi>
          <NGi>
            <div class="form-row">
              <span class="form-label">单次超时</span>
              <NInputNumber v-model:value="timeoutMs" :min="1000" :max="60000" :step="1000" size="small" style="width: 100%" />
              <span class="form-label-suffix">ms</span>
            </div>
          </NGi>
        </NGrid>

        <!-- limit + rerank -->
        <NGrid :cols="'1 m:3'" :x-gap="12" :y-gap="8" responsive="screen">
          <NGi>
            <div class="form-row">
              <span class="form-label">返回条数 limit</span>
              <NInputNumber v-model:value="limit" :min="1" :max="50" size="small" style="width: 100%" />
            </div>
          </NGi>
          <NGi>
            <div class="form-row">
              <span class="form-label">启用 rerank</span>
              <NSwitch v-model:value="rerank" size="small">
                <template #checked>是</template>
                <template #unchecked>否</template>
              </NSwitch>
              <span class="muted" style="margin-left: 4px">关闭可加速但精度下降</span>
            </div>
          </NGi>
          <NGi>
            <div class="form-row" style="height: 100%; align-items: flex-end;">
              <NSpace :size="8">
                <NButton type="primary" size="small" :loading="loading" :disabled="loading" @click="executeBenchmark">
                  开始压测
                </NButton>
                <NButton v-if="result" size="small" :disabled="loading" @click="downloadMd">
                  下载 Markdown
                </NButton>
                <NButton v-if="result" size="small" :disabled="loading" @click="downloadJson">
                  下载 JSON
                </NButton>
              </NSpace>
            </div>
          </NGi>
        </NGrid>

        <NAlert v-if="errorMsg" type="error" :show-icon="true" title="压测失败">
          {{ errorMsg }}
        </NAlert>
      </NSpace>
    </NCard>

    <!-- ===== 测试集预览 + 历史记录 ===== -->
    <NCard size="small" :bordered="true">
      <div class="section-header">
        <h3 style="margin: 0; font-size: var(--fs-subtitle)">标准测试集</h3>
        <NSpin v-if="fixturesLoading" size="small" />
        <span v-else class="muted">共 {{ fixtures.length }} 条，覆盖 {{ Object.keys(categoryStats).length }} 个分类</span>
      </div>

      <NGrid :cols="'1 m:3'" :x-gap="12" :y-gap="8" responsive="screen" style="margin-top: 12px">
        <!-- 分类统计 -->
        <NGi>
          <div class="detail-title">分类统计</div>
          <NSpace :size="4" style="margin-top: 4px">
            <NTag v-for="(count, cat) in categoryStats" :key="cat" size="small" type="info">
              {{ categoryLabel(cat) }}: {{ count }}
            </NTag>
          </NSpace>
        </NGi>
        <!-- 历史记录 -->
        <NGi :span="2">
          <div class="detail-title">历史记录（{{ history.length }}）</div>
          <div v-if="history.length === 0" class="muted" style="margin-top: 4px">暂无历史记录</div>
          <NList v-else size="small" style="margin-top: 4px; max-height: 120px; overflow-y: auto">
            <NListItem v-for="h in history.slice(0, 10)" :key="h.runId">
              <NThing>
                <template #header>
                  <NSpace :size="6" align="center">
                    <NTag :type="successRateTagType(h.summary.successRate)" size="tiny">
                      {{ (h.summary.successRate * 100).toFixed(0) }}%
                    </NTag>
                    <span style="font-size: 12px">{{ formatDateTime(h.startedAt) }}</span>
                    <span class="muted" style="font-size: 11px">
                      {{ h.summary.successCount }}/{{ h.summary.totalFixtures }} · {{ latencyLabel(h.summary.latency.avg) }} · P95 {{ latencyLabel(h.summary.latency.p95) }}
                    </span>
                  </NSpace>
                </template>
                <template #action>
                  <NButton size="tiny" quaternary @click="loadHistoryReport(h)">查看</NButton>
                </template>
              </NThing>
            </NListItem>
          </NList>
        </NGi>
      </NGrid>
    </NCard>

    <!-- ===== 结果展示区 ===== -->
    <NCard v-if="result && summary" size="small" :bordered="true">
      <div class="section-header" style="margin-bottom: 12px">
        <h3 style="margin: 0; font-size: var(--fs-subtitle)">压测结果</h3>
        <span class="muted">
          运行 ID: {{ result.runId.slice(0, 19) }} ·
          {{ formatDateTime(result.startedAt) }} → {{ formatDateTime(result.endedAt) }} ·
          模式 {{ result.options.mode }} · limit={{ result.options.limit }} ·
          rerank={{ result.options.rerank }} · 并发={{ result.options.concurrency }}
        </span>
      </div>

      <NTabs v-model:value="activeTab" type="line" animated>
        <!-- ===== Tab 1: 概览 ===== -->
        <NTabPane name="overview" tab="概览">
          <NSpace vertical :size="12">
            <!-- KPI 卡片 -->
            <NGrid :cols="'2 s:3 m:4 l:7'" :x-gap="8" :y-gap="8" responsive="screen">
              <NGi>
                <NStatistic label="成功率">
                  <template #default>
                    <span>{{ (summary.successRate * 100).toFixed(1) }}%</span>
                  </template>
                  <template #suffix>
                    <NTag :type="successRateTagType(summary.successRate)" size="small" style="margin-left: 4px">
                      {{ summary.successCount }}/{{ summary.totalFixtures }}
                    </NTag>
                  </template>
                </NStatistic>
              </NGi>
              <NGi>
                <NStatistic label="平均延迟" :value="latencyLabel(Math.round(summary.latency.avg))">
                  <template #suffix>
                    <NTag :type="latencyTagType(summary.latency.avg)" size="small" style="margin-left: 4px">
                      σ={{ summary.latency.std.toFixed(0) }}
                    </NTag>
                  </template>
                </NStatistic>
              </NGi>
              <NGi>
                <NStatistic label="P95 延迟" :value="latencyLabel(summary.latency.p95)">
                  <template #suffix>
                    <NTag :type="latencyTagType(summary.latency.p95)" size="small" style="margin-left: 4px">
                      P99 {{ latencyLabel(summary.latency.p99) }}
                    </NTag>
                  </template>
                </NStatistic>
              </NGi>
              <NGi>
                <NStatistic label="总耗时" :value="latencyLabel(summary.totalDurationMs)" />
              </NGi>
              <NGi>
                <NStatistic label="总 tokens" :value="summary.estimatedTokens.total">
                  <template #suffix>
                    <span class="muted" style="font-size: 11px; margin-left: 4px">
                      in={{ summary.estimatedTokens.input }} out={{ summary.estimatedTokens.output }}
                    </span>
                  </template>
                </NStatistic>
              </NGi>
              <NGi>
                <NStatistic label="压缩率" :value="`${(summary.compressionRatio * 100).toFixed(1)}%`">
                  <template #suffix>
                    <span class="muted" style="font-size: 11px; margin-left: 4px">越低越省</span>
                  </template>
                </NStatistic>
              </NGi>
              <NGi>
                <NStatistic label="召回率" :value="summary.recall ? `${(summary.recall.avgRecall * 100).toFixed(1)}%` : 'N/A'">
                  <template #suffix>
                    <NTag v-if="summary.recall" :type="recallTagType(summary.recall.avgRecall)" size="small" style="margin-left: 4px">
                      {{ summary.recall.evaluated }} 条评估
                    </NTag>
                    <span v-else class="muted" style="font-size: 11px; margin-left: 4px">无 expectedDocIds</span>
                  </template>
                </NStatistic>
              </NGi>
            </NGrid>

            <!-- 平均结果数 + 召回率/精确率/F1 详情 -->
            <NGrid :cols="'1 m:2'" :x-gap="12" :y-gap="8" responsive="screen">
              <NGi>
                <NCard size="small" :bordered="true">
                  <div class="detail-title">结果质量</div>
                  <NSpace vertical :size="4" style="margin-top: 8px">
                    <div>平均结果数: <strong>{{ summary.avgResultCount.toFixed(2) }}</strong></div>
                    <div v-if="summary.recall">
                      平均召回率: <strong>{{ (summary.recall.avgRecall * 100).toFixed(1) }}%</strong>
                      <NTag :type="recallTagType(summary.recall.avgRecall)" size="small" style="margin-left: 4px">
                        {{ recallEvaluatedCount }} 条评估
                      </NTag>
                    </div>
                    <div v-if="summary.recall">
                      平均精确率: <strong>{{ (summary.recall.avgPrecision * 100).toFixed(1) }}%</strong>
                    </div>
                    <div v-if="summary.recall">
                      平均 F1: <strong>{{ (summary.recall.avgF1 * 100).toFixed(1) }}%</strong>
                    </div>
                    <div v-else class="muted">无 expectedDocIds 标注，跳过召回率评估</div>
                  </NSpace>
                </NCard>
              </NGi>
              <NGi>
                <NCard size="small" :bordered="true">
                  <div class="detail-title">配置摘要</div>
                  <NSpace vertical :size="4" style="margin-top: 8px">
                    <div>测试集来源: <strong>{{ result.options.fixturesSource }}</strong>（{{ result.options.fixturesCount }} 条）</div>
                    <div>查询模式: <strong>{{ result.options.mode }}</strong></div>
                    <div>limit: <strong>{{ result.options.limit }}</strong> · rerank: <strong>{{ result.options.rerank }}</strong></div>
                    <div>并发数: <strong>{{ result.options.concurrency }}</strong></div>
                  </NSpace>
                </NCard>
              </NGi>
            </NGrid>
          </NSpace>
        </NTabPane>

        <!-- ===== Tab 2: 性能分布 ===== -->
        <NTabPane name="latency" tab="性能分布">
          <NSpace vertical :size="16">
            <NCard size="small" :bordered="true">
              <EChart :option="latencyDistributionOption" height="280px" />
            </NCard>
            <NCard size="small" :bordered="true">
              <EChart :option="categoryLatencyOption" height="280px" />
            </NCard>
            <NCard size="small" :bordered="true">
              <EChart :option="itemsLatencyOption" height="320px" />
            </NCard>
          </NSpace>
        </NTabPane>

        <!-- ===== Tab 3: Tokens & 召回率 ===== -->
        <NTabPane name="tokens" tab="Tokens & 召回率">
          <NSpace vertical :size="16">
            <NGrid :cols="'1 m:2'" :x-gap="12" :y-gap="8" responsive="screen">
              <NGi>
                <NCard size="small" :bordered="true">
                  <EChart :option="tokensOption" height="280px" />
                </NCard>
              </NGi>
              <NGi>
                <NCard size="small" :bordered="true">
                  <div v-if="recallOption && Object.keys(recallOption).length > 0">
                    <EChart :option="recallOption" height="280px" />
                  </div>
                  <NEmpty v-else description="无 expectedDocIds 标注的用例" style="padding: 80px 0" />
                </NCard>
              </NGi>
            </NGrid>

            <!-- 压缩率说明 -->
            <NCard size="small" :bordered="true">
              <div class="detail-title">压缩率说明</div>
              <NSpace vertical :size="4" style="margin-top: 8px">
                <div>
                  压缩率: <strong>{{ (summary.compressionRatio * 100).toFixed(1) }}%</strong>
                  <span class="muted" style="margin-left: 8px">
                    返回 snippets 总字符数 / 假设全文档总字符数（基准 4000 字符/文档）
                  </span>
                </div>
                <div class="muted">
                  压缩率越低，表示裁剪越多，节省的 tokens 越多；过高可能丢失关键信息。
                  合理范围通常在 5%-30% 之间。
                </div>
              </NSpace>
            </NCard>
          </NSpace>
        </NTabPane>

        <!-- ===== Tab 4: 逐条详情 ===== -->
        <NTabPane name="details" tab="逐条详情">
          <NSpace vertical :size="12">
            <div class="detail-section">
              <div class="detail-title">逐条用例结果（{{ result.items.length }} 条）</div>
              <NTable size="small" :bordered="true" :single-line="false" style="margin-top: 6px">
                <thead>
                  <tr>
                    <th style="width: 80px">ID</th>
                    <th style="width: 70px">分类</th>
                    <th>查询</th>
                    <th style="width: 60px">状态</th>
                    <th style="width: 80px">延迟</th>
                    <th style="width: 60px">结果数</th>
                    <th style="width: 70px">召回率</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(item, idx) in result.items" :key="idx" :class="{ 'row-error': !item.success }">
                    <td><code style="font-size: 11px">{{ item.fixtureId }}</code></td>
                    <td><NTag size="tiny" type="info">{{ categoryLabel(item.category) }}</NTag></td>
                    <td class="snippet-cell">{{ item.query.length > 80 ? item.query.slice(0, 80) + '...' : item.query }}</td>
                    <td>
                      <NTag :type="item.success ? 'success' : 'error'" size="small">
                        {{ item.success ? '✓' : '✗' }}
                      </NTag>
                    </td>
                    <td>
                      <NTag :type="latencyTagType(item.latencyMs)" size="small">
                        {{ latencyLabel(item.latencyMs) }}
                      </NTag>
                    </td>
                    <td>{{ item.resultCount }}</td>
                    <td>
                      <NTag v-if="item.recall !== null" :type="recallTagType(item.recall)" size="small">
                        {{ (item.recall * 100).toFixed(0) }}%
                      </NTag>
                      <span v-else class="muted">N/A</span>
                    </td>
                    <td class="error-cell">{{ item.error ?? '' }}</td>
                  </tr>
                </tbody>
              </NTable>
            </div>

            <!-- 失败用例详情 -->
            <div v-if="failedItems.length > 0" class="detail-section">
              <div class="detail-title">失败用例详情（{{ failedItems.length }} 条）</div>
              <NCollapse style="margin-top: 6px">
                <NCollapseItem v-for="f in failedItems" :key="f.fixtureId" :name="f.fixtureId" :title="`${f.fixtureId} (${categoryLabel(f.category)})`">
                  <NSpace vertical :size="4">
                    <div><strong>查询:</strong> {{ f.query }}</div>
                    <div><strong>错误:</strong> <span class="error-cell">{{ f.error }}</span></div>
                  </NSpace>
                </NCollapseItem>
              </NCollapse>
            </div>
          </NSpace>
        </NTabPane>
      </NTabs>
    </NCard>

    <!-- 空状态 -->
    <NCard v-else size="small" :bordered="true">
      <NEmpty description="配置参数后点击「开始压测」" style="padding: 48px 0">
        <template #extra>
          <span class="muted">
            将使用内置 {{ fixtures.length }} 条标准测试集对 QMD 检索进行多轮会话压测，
            评估召回率、tokens 消耗、压缩率、性能分布，并输出完整报告。
          </span>
        </template>
      </NEmpty>
    </NCard>
  </NSpace>
</template>

<style scoped>
.section-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.form-label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  white-space: nowrap;
  min-width: 70px;
}
.form-label-suffix {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
.detail-section {
  margin-top: 4px;
}
.detail-title {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin-bottom: 6px;
  font-weight: 600;
}
.row-error {
  background-color: rgba(255, 77, 79, 0.06);
}
.error-cell {
  color: var(--color-danger, #ff4d4f);
  font-size: var(--fs-caption);
  word-break: break-all;
}
.muted {
  color: var(--color-text-secondary);
  font-size: var(--fs-caption);
}
.snippet-cell {
  font-size: 11px;
  word-break: break-all;
  max-width: 400px;
}
</style>
