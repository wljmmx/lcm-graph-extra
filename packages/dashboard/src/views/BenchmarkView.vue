<script setup lang="ts">
/**
 * Benchmark CE 引擎能力压测页面（v2.3.0）。
 *
 * 功能：
 * - 测试集选择：project-scenarios / ce-multi-turn / beir-nfcorpus / beir-scifact
 * - 引擎选择：qmd（直查 QMD /query）/ ce（dashboard /api/memory/search 三引擎并行）
 * - BEIR 预下载：BEIR 测试集需在线下载，提供下载状态 + 触发按钮
 * - 配置区：地址（系统配置/手动）+ limit + 超时 + rerank + 模式 + 并发数
 * - 结果可视化（5 个 Tab）：
 *   1. 概览：KPI 卡片（成功率/平均延迟/P95/总耗时/tokens/压缩率/召回率/连贯性）
 *   2. 性能分布：延迟分布柱状图 + 按分类延迟 + 逐条散点图
 *   3. Tokens & 召回率：tokens 饼图 + 召回率柱状图 + 压缩率展示
 *   4. CE 多轮会话分析：会话汇总表 + Recall by turn 趋势图 + Latency by turn 柱状图（仅 ce-multi-turn）
 *   5. 逐条详情 + 失败用例：完整列表，可下载 Markdown 报告
 * - 历史记录：侧边列表，可点击查看历史报告
 */
import { computed, onMounted, ref, watch } from 'vue';
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
  NSpin,
  useMessage,
} from 'naive-ui';
import EChart from '../components/EChart.vue';
import { echartsThemeColors } from '../styles/theme';
import {
  fetchBenchmarkFixtureSets,
  fetchBenchmarkFixtures,
  fetchBenchmarkDefaultUrl,
  fetchBenchmarkHistory,
  downloadBeirStream,
  runBenchmarkStream,
  downloadBenchmarkMarkdown,
  type BenchmarkFixture,
  type BenchmarkResult,
  type BenchmarkMode,
  type BenchmarkEngine,
  type FixtureSetId,
  type FixtureSetMeta,
  type BenchmarkHistoryItem,
  type MultiTurnSessionStats,
  type CeEngineDiagnostics,
  type BeirDownloadStreamEvent,
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
const engine = ref<BenchmarkEngine>('qmd');
const dashboardBaseUrl = ref<string>('');

// 测试集选择
const fixtureSetId = ref<FixtureSetId>('project-scenarios');
const fixtureSets = ref<FixtureSetMeta[]>([]);
const beirSubsetSize = ref<number>(200);

const modeOptions = [
  { label: 'REST /query（推荐，稳定快速）', value: 'rest' as BenchmarkMode },
  { label: 'MCP /mcp（完整握手 + tools/call，易超时）', value: 'mcp' as BenchmarkMode },
];

const engineOptions = [
  { label: 'QMD 直查 /query（L2 hybrid 检索）', value: 'qmd' as BenchmarkEngine },
  { label: 'CE 多引擎并行（L1 lcm + L2 qmd + L3 neo4j）', value: 'ce' as BenchmarkEngine },
];

const concurrencyOptions = [
  { label: '1（串行，准确反映单次延迟）', value: 1 },
  { label: '2', value: 2 },
  { label: '4', value: 4 },
  { label: '8（高并发，注意 QMD 排队）', value: 8 },
];

const fixtureSetOptions = computed(() =>
  fixtureSets.value.map((s) => ({
    label: `${s.name}${s.count ? `（${s.count} 条）` : ''}${s.type === 'beir' ? (s.cached ? '（已缓存）' : '（需下载）') : ''}`,
    value: s.id,
  })),
);

// 当前选中的测试集元数据
const currentFixtureSet = computed(() =>
  fixtureSets.value.find((s) => s.id === fixtureSetId.value) ?? null,
);

// 地址输入 computed（根据引擎路由到 baseUrl / dashboardBaseUrl）
const currentAddress = computed<string>({
  get: () => engine.value === 'qmd' ? baseUrl.value : dashboardBaseUrl.value,
  set: (val: string) => {
    if (engine.value === 'qmd') baseUrl.value = val;
    else dashboardBaseUrl.value = val;
  },
});

// 是否为 BEIR 测试集
const isBeirSet = computed(() =>
  fixtureSetId.value === 'beir-nfcorpus' || fixtureSetId.value === 'beir-scifact',
);

// ===== 测试集状态 =====
const fixtures = ref<BenchmarkFixture[]>([]);
const categoryStats = ref<Record<string, number>>({});
const fixturesLoading = ref<boolean>(false);
const beirMessage = ref<string>('');

// ===== BEIR 下载状态 =====
const beirDownloading = ref<boolean>(false);
const beirManualInstructions = ref<string>('');
const beirErrorMsg = ref<string>('');
const beirDownloadPhase = ref<string>('');
const beirDownloadPercent = ref<number>(0);
let beirDownloadController: AbortController | null = null;

// ===== 执行状态 =====
const loading = ref<boolean>(false);
const result = ref<BenchmarkResult | null>(null);
const errorMsg = ref<string>('');
const activeTab = ref<string>('overview');

// ===== 实时日志（SSE 流式）=====
interface LiveLogEntry {
  index: number;          // 序号（1-based）
  fixtureId: string;
  query: string;
  category: string;
  success: boolean;
  latencyMs: number;
  resultCount: number;
  returnedDocIds: string[];
  error?: string;
  ceConclusion?: CeEngineDiagnostics['conclusion'];
  ts: number;             // 接收时间戳
}
const liveLogs = ref<LiveLogEntry[]>([]);
const liveCompleted = ref<number>(0);
const liveTotal = ref<number>(0);
const liveRunning = ref<boolean>(false);
let streamController: AbortController | null = null;

// ===== 历史记录 =====
const history = ref<BenchmarkHistoryItem[]>([]);

// ===== 初始化 =====
onMounted(async () => {
  fixturesLoading.value = true;
  try {
    const [setsResp, urlResp, historyResp] = await Promise.all([
      fetchBenchmarkFixtureSets(),
      fetchBenchmarkDefaultUrl(),
      fetchBenchmarkHistory(),
    ]);
    if (setsResp.ok) {
      fixtureSets.value = setsResp.fixtureSets;
    }
    if (urlResp.ok) {
      baseUrl.value = urlResp.defaultQmdUrl;
      dashboardBaseUrl.value = urlResp.defaultDashboardUrl;
    } else {
      baseUrl.value = 'http://127.0.0.1:8081';
      dashboardBaseUrl.value = 'http://127.0.0.1:7421';
    }
    if (historyResp.ok) {
      history.value = historyResp.history;
    }
    // 加载默认测试集 fixtures
    await loadFixtureSetDetails(fixtureSetId.value);
  } catch (e) {
    baseUrl.value = 'http://127.0.0.1:8081';
    dashboardBaseUrl.value = 'http://127.0.0.1:7421';
    message.warning(`初始化失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    fixturesLoading.value = false;
  }
});

// ===== 测试集切换时加载详情 =====
async function loadFixtureSetDetails(setId: FixtureSetId): Promise<void> {
  fixtures.value = [];
  categoryStats.value = {};
  beirMessage.value = '';
  try {
    const resp = await fetchBenchmarkFixtures(setId);
    if (!resp.ok) return;
    // 区分内置测试集和 BEIR 测试集响应
    if ('type' in resp && resp.type === 'beir') {
      beirMessage.value = resp.message;
      // BEIR 测试集不预加载 fixtures（数量大），只在压测时加载
    } else {
      fixtures.value = resp.fixtures;
      categoryStats.value = resp.categoryStats;
    }
  } catch (e) {
    message.warning(`加载测试集失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

watch(fixtureSetId, (newId) => {
  if (newId) loadFixtureSetDetails(newId);
});

// ===== BEIR 预下载（SSE 流式，实时推送下载/解压进度）=====
async function downloadBeir(): Promise<void> {
  if (!isBeirSet.value) return;
  const datasetName = fixtureSetId.value.replace('beir-', '') as 'nfcorpus' | 'scifact';
  beirDownloading.value = true;
  beirManualInstructions.value = '';
  beirErrorMsg.value = '';
  beirDownloadPhase.value = '准备下载...';
  beirDownloadPercent.value = 0;

  beirDownloadController = downloadBeirStream(datasetName, {
    onEvent: (event: BeirDownloadStreamEvent) => {
      if (event.type === 'start') {
        beirDownloadPhase.value = '开始下载...';
        return;
      }
      if (event.type === 'progress') {
        beirDownloadPhase.value = event.phase;
        beirDownloadPercent.value = event.percent;
        return;
      }
      if (event.type === 'done') {
        beirDownloading.value = false;
        beirDownloadPhase.value = '';
        beirDownloadPercent.value = 100;
        beirDownloadController = null;
        message.success(`${datasetName} 下载完成`);
        // 刷新测试集列表（更新缓存状态）+ 重新加载详情
        void (async () => {
          const setsResp = await fetchBenchmarkFixtureSets();
          if (setsResp.ok) fixtureSets.value = setsResp.fixtureSets;
          await loadFixtureSetDetails(fixtureSetId.value);
        })();
        return;
      }
      if (event.type === 'error') {
        beirDownloading.value = false;
        beirDownloadPhase.value = '';
        beirDownloadPercent.value = 0;
        beirDownloadController = null;
        // 错误常驻展示（NAlert，不自动消失）
        beirErrorMsg.value = event.error;
        if (event.manualInstructions) {
          beirManualInstructions.value = event.manualInstructions;
        }
        // message 提示（长 duration，确保用户能看到）
        message.error(`下载失败: ${event.error}`, { duration: 10000 });
        return;
      }
    },
    onError: (err) => {
      beirDownloading.value = false;
      beirDownloadPhase.value = '';
      beirDownloadPercent.value = 0;
      beirDownloadController = null;
      beirErrorMsg.value = err.message;
      message.error(`下载请求失败: ${err.message}`, { duration: 10000 });
    },
  });
}

// ===== 中断 BEIR 下载 =====
function abortBeirDownload(): void {
  if (beirDownloadController) {
    beirDownloadController.abort();
    beirDownloadController = null;
    beirDownloading.value = false;
    beirDownloadPhase.value = '';
    beirDownloadPercent.value = 0;
    message.warning('已中断下载');
  }
}

// ===== 执行压测（SSE 流式，逐条推送进度 + 完成后推送完整结果）=====
async function executeBenchmark(): Promise<void> {
  if (engine.value === 'qmd' && !baseUrl.value.trim()) {
    message.error('QMD MCP 地址不能为空');
    return;
  }
  // 重置状态
  loading.value = true;
  liveRunning.value = true;
  errorMsg.value = '';
  result.value = null;
  liveLogs.value = [];
  liveCompleted.value = 0;
  liveTotal.value = 0;

  const finalBaseUrl = useCustomUrl.value
    ? (engine.value === 'qmd' ? baseUrl.value.trim() : dashboardBaseUrl.value.trim())
    : '';

  // 用流式端点，每条 fixture 完成时即时更新日志面板
  streamController = runBenchmarkStream(
    {
      baseUrl: engine.value === 'qmd' ? finalBaseUrl : undefined,
      dashboardBaseUrl: engine.value === 'ce' ? finalBaseUrl : undefined,
      fixtureSetId: fixtureSetId.value,
      beirSubsetSize: isBeirSet.value ? beirSubsetSize.value : undefined,
      limit: limit.value,
      timeoutMs: timeoutMs.value,
      rerank: rerank.value,
      mode: mode.value,
      engine: engine.value,
      concurrency: concurrency.value,
    },
    {
      onEvent: (event) => {
        if (event.type === 'start') {
          // 后端确认开始（total 尚未知）
          return;
        }
        if (event.type === 'download-progress') {
          // BEIR 数据集下载/解压进度（与压测 progress 分离，仅 toast 提示，不污染日志面板）
          message.info(`正在准备数据集: ${event.phase} ${event.percent}%`, { duration: 2000 });
          return;
        }
        if (event.type === 'progress') {
          liveTotal.value = event.total;
          liveCompleted.value = event.completed;
          const item = event.item;
          // 防御性守卫：item 为 undefined 时跳过（避免 TypeError 导致 reader 循环退出）
          if (!item || !item.fixtureId) return;
          const entry: LiveLogEntry = {
            index: liveLogs.value.length + 1,
            fixtureId: item.fixtureId,
            query: item.query,
            category: item.category,
            success: item.success,
            latencyMs: item.latencyMs,
            resultCount: item.resultCount,
            returnedDocIds: item.returnedDocIds,
            error: item.error,
            ceConclusion: item.ceDiagnostics?.conclusion,
            ts: Date.now(),
          };
          liveLogs.value = [...liveLogs.value, entry];
          // 实时刷新 message（每条进度）
          const pct = event.total > 0 ? Math.round((event.completed / event.total) * 100) : 0;
          message.info(`[${event.completed}/${event.total}] ${pct}% - ${item.fixtureId} ${item.success ? '✓' : '✗'} ${item.latencyMs}ms`, { duration: 1500 });
          return;
        }
        if (event.type === 'done') {
          result.value = event.result;
          const coherence = event.result.summary.multiTurnSessions?.length ?? 0;
          message.success(
            `压测完成：${event.result.summary.successCount}/${event.result.summary.totalFixtures} 成功，` +
            `平均 ${event.result.summary.latency.avg.toFixed(0)}ms，P95 ${event.result.summary.latency.p95}ms` +
            (coherence > 0 ? `，${coherence} 条多轮会话` : ''),
          );
          activeTab.value = coherence > 0 ? 'multi-turn' : 'overview';
          loading.value = false;
          liveRunning.value = false;
          streamController = null;
          // 刷新历史列表
          void (async () => {
            try {
              const histResp = await fetchBenchmarkHistory();
              if (histResp.ok) history.value = histResp.history;
            } catch {
              // 忽略历史刷新失败
            }
          })();
          return;
        }
        if (event.type === 'error') {
          errorMsg.value = event.error;
          message.error(`压测失败: ${event.error}`);
          loading.value = false;
          liveRunning.value = false;
          streamController = null;
          return;
        }
      },
      onError: (err) => {
        errorMsg.value = err.message;
        message.error(`压测请求失败: ${err.message}`);
        loading.value = false;
        liveRunning.value = false;
        streamController = null;
      },
    },
  );
}

// ===== 中断测试 =====
function abortBenchmark(): void {
  if (streamController) {
    streamController.abort();
    streamController = null;
    liveRunning.value = false;
    loading.value = false;
    message.warning('已中断压测（已完成的结果仍展示在日志面板）');
  }
}

// ===== 清空实时日志 =====
function clearLiveLogs(): void {
  liveLogs.value = [];
  liveCompleted.value = 0;
  liveTotal.value = 0;
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

function coherenceTagType(score: number): 'success' | 'warning' | 'error' {
  if (score >= 0.7) return 'success';
  if (score >= 0.4) return 'warning';
  return 'error';
}

function ceDiagTagType(conclusion: CeEngineDiagnostics['conclusion']): 'success' | 'warning' | 'error' {
  if (conclusion === 'ok') return 'success';
  if (conclusion === 'partial-failure') return 'warning';
  return 'error';
}

function ceDiagLabel(conclusion: CeEngineDiagnostics['conclusion']): string {
  const map: Record<CeEngineDiagnostics['conclusion'], string> = {
    'ok': '正常',
    'all-empty': '三引擎全空',
    'all-failed': '三引擎全部失败',
    'partial-failure': '部分失败',
  };
  return map[conclusion] ?? conclusion;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ===== 派生数据：结果摘要 =====
const summary = computed(() => result.value?.summary ?? null);

// 多轮会话列表
const multiTurnSessions = computed<MultiTurnSessionStats[]>(() =>
  summary.value?.multiTurnSessions ?? [],
);

// 平均连贯性评分
const avgCoherence = computed<number | null>(() => {
  const scores = multiTurnSessions.value
    .map((s) => s.coherenceScore)
    .filter((v): v is number => v !== null);
  if (scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
});

// 是否显示多轮会话 Tab
const showMultiTurnTab = computed(() => multiTurnSessions.value.length > 0);

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
          color: i >= 3 && i <= 4 ? echartsThemeColors[2] : (i >= 5 ? echartsThemeColors[3] : echartsThemeColors[1]),
        },
      })),
      label: {
        show: true,
        position: 'top',
        formatter: (p: any) => latencyLabel(p.value),
        fontSize: 12,
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
        fontSize: 12,
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
    legend: { bottom: 0, textStyle: { fontSize: 12 } },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['50%', '50%'],
      label: { formatter: '{b}\n{c}', fontSize: 12 },
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
      itemStyle: { color: echartsThemeColors[1] },
      label: {
        show: true,
        position: 'top',
        formatter: (p: any) => `${(p.value * 100).toFixed(0)}%`,
        fontSize: 12,
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
    xAxis: { type: 'category', data: result.value.items.map((i) => i.fixtureId), axisLabel: { rotate: 45, fontSize: 12 } },
    yAxis: {
      type: 'value',
      name: 'ms',
      axisLabel: { formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}`) },
    },
    series: [{
      type: 'scatter',
      data: result.value.items.map((i, idx) => ({
        value: [idx, i.latencyMs],
        itemStyle: { color: i.success ? echartsThemeColors[1] : echartsThemeColors[3] },
      })),
      symbolSize: 10,
    }],
  };
});

// ===== ECharts: 多轮会话 Recall by turn 趋势图（折线，每条会话一条） =====
const multiTurnRecallOption = computed(() => {
  const sessions = multiTurnSessions.value.filter((s) => s.recallByTurn.some((r) => r !== null));
  if (sessions.length === 0) return {};
  const maxTurns = Math.max(...sessions.map((s) => s.recallByTurn.length));
  const xLabels = Array.from({ length: maxTurns }, (_, i) => `T${i + 1}`);
  return {
    title: { text: 'Recall 随轮次变化趋势', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        let html = `轮次: ${params[0].name}<br/>`;
        for (const p of params) {
          const v = p.value;
          html += `${p.seriesName}: ${v === null || v === undefined ? 'N/A' : (v * 100).toFixed(0) + '%'}<br/>`;
        }
        return html;
      },
    },
    legend: { bottom: 0, textStyle: { fontSize: 12 } },
    grid: { left: 60, right: 20, top: 50, bottom: 60 },
    xAxis: { type: 'category', data: xLabels, name: '轮次' },
    yAxis: {
      type: 'value',
      name: '召回率',
      min: 0,
      max: 1,
      axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
    },
    series: sessions.map((s) => ({
      name: s.sessionId,
      type: 'line',
      data: s.recallByTurn.map((r) => r),
      connectNulls: false,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
    })),
  };
});

// ===== ECharts: 多轮会话 Latency by turn 柱状图 =====
const multiTurnLatencyOption = computed(() => {
  const sessions = multiTurnSessions.value;
  if (sessions.length === 0) return {};
  const maxTurns = Math.max(...sessions.map((s) => s.latencyByTurn.length));
  const xLabels = Array.from({ length: maxTurns }, (_, i) => `T${i + 1}`);
  return {
    title: { text: '延迟随轮次变化', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        let html = `轮次: ${params[0].name}<br/>`;
        for (const p of params) {
          html += `${p.seriesName}: ${latencyLabel(p.value)}<br/>`;
        }
        return html;
      },
    },
    legend: { bottom: 0, textStyle: { fontSize: 12 } },
    grid: { left: 60, right: 20, top: 50, bottom: 60 },
    xAxis: { type: 'category', data: xLabels, name: '轮次' },
    yAxis: {
      type: 'value',
      name: 'ms',
      axisLabel: { formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}`) },
    },
    series: sessions.map((s) => ({
      name: s.sessionId,
      type: 'bar',
      data: s.latencyByTurn,
    })),
  };
});

// ===== ECharts: 多轮会话结果数 by turn（检测召回衰减） =====
const multiTurnResultCountOption = computed(() => {
  const sessions = multiTurnSessions.value;
  if (sessions.length === 0) return {};
  const maxTurns = Math.max(...sessions.map((s) => s.resultCountByTurn.length));
  const xLabels = Array.from({ length: maxTurns }, (_, i) => `T${i + 1}`);
  return {
    title: { text: '结果数随轮次变化（召回衰减检测）', left: 'center', textStyle: { fontSize: 13 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        let html = `轮次: ${params[0].name}<br/>`;
        for (const p of params) {
          html += `${p.seriesName}: ${p.value} 条<br/>`;
        }
        return html;
      },
    },
    legend: { bottom: 0, textStyle: { fontSize: 12 } },
    grid: { left: 60, right: 20, top: 50, bottom: 60 },
    xAxis: { type: 'category', data: xLabels, name: '轮次' },
    yAxis: { type: 'value', name: '结果数' },
    series: sessions.map((s) => ({
      name: s.sessionId,
      type: 'line',
      data: s.resultCountByTurn,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
    })),
  };
});

// ===== 失败用例列表 =====
const failedItems = computed(() => result.value?.items.filter((i) => !i.success) ?? []);

// ===== 有召回率评估的用例数 =====
const recallEvaluatedCount = computed(() =>
  result.value?.items.filter((i) => i.recall !== null).length ?? 0,
);

// ===== 详情表是否显示多轮会话列 =====
const hasMultiTurnMeta = computed(() =>
  result.value?.items.some((i) => i.sessionId) ?? false,
);
</script>

<template>
  <NSpace vertical :size="16">
    <!-- ===== 配置区 ===== -->
    <NCard size="small" :bordered="true">
      <div class="section-header">
        <h3 style="margin: 0; font-size: var(--fs-subtitle)">Benchmark CE 引擎能力压测</h3>
        <span class="muted">标准测试集 + 多轮会话召回/连贯性/tokens/压缩率评估</span>
      </div>

      <NSpace vertical :size="12" style="margin-top: 12px">
        <!-- 测试集选择 + 引擎选择 -->
        <NGrid :cols="'1 m:3'" :x-gap="12" :y-gap="8" responsive="screen">
          <NGi :span="2">
            <div class="form-row">
              <span class="form-label">测试集</span>
              <NSelect
                v-model:value="fixtureSetId"
                :options="fixtureSetOptions"
                size="small"
                style="flex: 1"
                placeholder="选择测试集"
              />
            </div>
          </NGi>
          <NGi>
            <div class="form-row">
              <span class="form-label">查询引擎</span>
              <NSelect v-model:value="engine" :options="engineOptions" size="small" style="flex: 1" />
            </div>
          </NGi>
        </NGrid>

        <!-- 当前测试集说明 -->
        <div v-if="currentFixtureSet" class="fixture-set-desc">
          <NTag size="small" :type="currentFixtureSet.type === 'beir' ? 'success' : 'info'">
            {{ currentFixtureSet.name }}
          </NTag>
          <span class="muted" style="margin-left: 8px">{{ currentFixtureSet.description }}</span>
        </div>

        <!-- BEIR 下载错误（常驻展示，不自动消失） -->
        <NAlert
          v-if="isBeirSet && beirErrorMsg"
          type="error"
          :show-icon="true"
          title="BEIR 数据集下载失败"
          closable
          @close="beirErrorMsg = ''"
        >
          <pre class="manual-instructions">{{ beirErrorMsg }}</pre>
        </NAlert>

        <!-- BEIR 下载提示 -->
        <NAlert
          v-if="isBeirSet && currentFixtureSet && !currentFixtureSet.cached && !beirDownloading"
          type="warning"
          :show-icon="true"
          title="BEIR 数据集未缓存"
        >
          <NSpace align="center" :size="8">
            <span>首次使用需从 HuggingFace 下载（约 30s）：</span>
            <NButton size="tiny" type="primary" @click="downloadBeir">
              立即下载
            </NButton>
          </NSpace>
        </NAlert>

        <!-- BEIR 下载进度（SSE 流式，实时推送下载/解压进度） -->
        <NAlert
          v-if="isBeirSet && beirDownloading"
          type="info"
          :show-icon="true"
          title="正在下载 BEIR 数据集..."
        >
          <div style="margin-bottom: 8px">
            <span class="muted" style="font-size: 12px">{{ beirDownloadPhase }}</span>
            <span style="margin-left: 8px; font-weight: 600">{{ beirDownloadPercent }}%</span>
          </div>
          <div class="live-progress" style="margin-bottom: 8px">
            <div
              class="live-progress-bar is-running"
              :style="{ width: `${beirDownloadPercent}%` }"
            />
          </div>
          <NButton size="tiny" quaternary type="error" @click="abortBeirDownload">
            中断下载
          </NButton>
        </NAlert>

        <NAlert
          v-else-if="isBeirSet && currentFixtureSet?.cached"
          type="success"
          :show-icon="true"
          title="BEIR 数据集已缓存"
        >
          <span v-if="currentFixtureSet.cacheInfo">
            路径: <code style="font-size: var(--fs-caption)">{{ currentFixtureSet.cacheInfo.path }}</code> ·
            大小: {{ formatBytes(currentFixtureSet.cacheInfo.sizeBytes) }} ·
            文件数: {{ currentFixtureSet.cacheInfo.fileCount }}
          </span>
        </NAlert>

        <!-- BEIR 手工下载指引（自动下载失败时展示） -->
        <NCollapse v-if="isBeirSet && beirManualInstructions" :default-expanded-names="['manual']">
          <NCollapseItem name="manual" title="手工下载指引（自动下载失败时使用）">
            <pre class="manual-instructions">{{ beirManualInstructions }}</pre>
          </NCollapseItem>
        </NCollapse>

        <!-- BEIR 子集大小 -->
        <NGrid v-if="isBeirSet" :cols="'1 m:3'" :x-gap="12" :y-gap="8" responsive="screen">
          <NGi>
            <div class="form-row">
              <span class="form-label">BEIR 子集大小</span>
              <NInputNumber
                v-model:value="beirSubsetSize"
                :min="10"
                :max="1000"
                :step="50"
                size="small"
                style="width: 100%"
              />
              <span class="form-label-suffix">条查询</span>
            </div>
          </NGi>
        </NGrid>

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
              <span class="form-label">{{ engine === 'qmd' ? 'QMD 地址' : 'Dashboard 地址' }}</span>
              <NInput
                v-model:value="currentAddress"
                size="small"
                :placeholder="engine === 'qmd' ? 'http://127.0.0.1:8081' : 'http://127.0.0.1:7421'"
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
                <NButton v-if="liveRunning" type="error" size="small" ghost @click="abortBenchmark">
                  中断
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
        <h3 style="margin: 0; font-size: var(--fs-subtitle)">测试集预览</h3>
        <NSpin v-if="fixturesLoading" size="small" />
        <span v-else-if="!isBeirSet" class="muted">共 {{ fixtures.length }} 条，覆盖 {{ Object.keys(categoryStats).length }} 个分类</span>
        <span v-else-if="beirMessage" class="muted">{{ beirMessage }}</span>
      </div>

      <NGrid :cols="'1 m:3'" :x-gap="12" :y-gap="8" responsive="screen" style="margin-top: 12px">
        <!-- 分类统计 / BEIR 说明 -->
        <NGi>
          <div class="detail-title">{{ isBeirSet ? 'BEIR 说明' : '分类统计' }}</div>
          <NSpace v-if="!isBeirSet" :size="4" style="margin-top: 4px">
            <NTag v-for="(count, cat) in categoryStats" :key="cat" size="small" type="info">
              {{ categoryLabel(cat) }}: {{ count }}
            </NTag>
          </NSpace>
          <NSpace v-else vertical :size="4" style="margin-top: 4px">
            <span class="muted" style="font-size: var(--fs-caption)">业界公认信息检索基准（NeurIPS 2021）</span>
            <span class="muted" style="font-size: var(--fs-caption)">子集大小: {{ beirSubsetSize }} 条查询</span>
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
                    <NTag size="tiny" :type="h.options.engine === 'ce' ? 'success' : 'default'">
                      {{ h.options.engine }}
                    </NTag>
                    <NTag size="tiny" type="info">{{ h.options.fixtureSetId }}</NTag>
                    <span style="font-size: 12px">{{ formatDateTime(h.startedAt) }}</span>
                    <span class="muted" style="font-size: var(--fs-caption)">
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

    <!-- ===== 实时日志（SSE 流式，测试期间逐条展示）===== -->
    <NCard v-if="liveRunning || liveLogs.length > 0" size="small" :bordered="true">
      <div class="section-header" style="margin-bottom: 12px">
        <h3 style="margin: 0; font-size: var(--fs-subtitle)">
          实时日志
          <NTag v-if="liveRunning" type="info" size="small" style="margin-left: 8px">运行中</NTag>
          <NTag v-else type="success" size="small" style="margin-left: 8px">已完成</NTag>
        </h3>
        <NSpace :size="12" align="center">
          <span class="muted" style="font-size: 12px">
            进度 {{ liveCompleted }}/{{ liveTotal || '...' }}
            <template v-if="liveTotal > 0">
              （{{ Math.round((liveCompleted / liveTotal) * 100) }}%）
            </template>
          </span>
          <NButton v-if="!liveRunning && liveLogs.length > 0" size="tiny" quaternary @click="clearLiveLogs">
            清空日志
          </NButton>
        </NSpace>
      </div>

      <!-- 进度条 -->
      <div class="live-progress" v-if="liveTotal > 0">
        <div
          class="live-progress-bar"
          :style="{ width: `${(liveCompleted / liveTotal) * 100}%` }"
          :class="{ 'is-running': liveRunning }"
        />
      </div>

      <!-- 逐条日志 -->
      <div class="live-log-list">
        <div v-for="entry in liveLogs" :key="entry.index" class="live-log-entry" :class="{ 'is-fail': !entry.success }">
          <span class="live-log-index">#{{ entry.index }}</span>
          <NTag :type="entry.success ? 'success' : 'error'" size="tiny" style="min-width: 28px; justify-content: center">
            {{ entry.success ? '✓' : '✗' }}
          </NTag>
          <span class="live-log-fixture">{{ entry.fixtureId }}</span>
          <span class="live-log-query" :title="entry.query">{{ entry.query }}</span>
          <span class="live-log-cat">{{ categoryLabel(entry.category) }}</span>
          <NTag v-if="entry.ceConclusion" :type="ceDiagTagType(entry.ceConclusion)" size="tiny">
            {{ ceDiagLabel(entry.ceConclusion) }}
          </NTag>
          <span class="live-log-count">{{ entry.resultCount }} 条</span>
          <span class="live-log-latency" :class="latencyTagType(entry.latencyMs)">
            {{ latencyLabel(entry.latencyMs) }}
          </span>
          <span v-if="entry.error" class="live-log-error" :title="entry.error">{{ entry.error }}</span>
        </div>
        <div v-if="liveLogs.length === 0 && liveRunning" class="live-log-empty">
          等待第一条结果...
        </div>
      </div>
    </NCard>

    <!-- ===== 结果展示区 ===== -->
    <NCard v-if="result && summary" size="small" :bordered="true">
      <div class="section-header" style="margin-bottom: 12px">
        <h3 style="margin: 0; font-size: var(--fs-subtitle)">压测结果</h3>
        <span class="muted">
          运行 ID: {{ result.runId.slice(0, 19) }} ·
          {{ formatDateTime(result.startedAt) }} → {{ formatDateTime(result.endedAt) }} ·
          引擎 {{ result.options.engine }} · 测试集 {{ result.options.fixtureSetId }} ·
          模式 {{ result.options.mode }} · limit={{ result.options.limit }}
        </span>
      </div>

      <NTabs v-model:value="activeTab" type="line" animated>
        <!-- ===== Tab 1: 概览 ===== -->
        <NTabPane name="overview" tab="概览">
          <NSpace vertical :size="12">
            <!-- KPI 卡片 -->
            <NGrid :cols="'2 s:3 m:4 l:8'" :x-gap="8" :y-gap="8" responsive="screen">
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
                    <span class="muted" style="font-size: var(--fs-caption); margin-left: 4px">
                      in={{ summary.estimatedTokens.input }} out={{ summary.estimatedTokens.output }}
                    </span>
                  </template>
                </NStatistic>
              </NGi>
              <NGi>
                <NStatistic label="压缩率" :value="`${(summary.compressionRatio * 100).toFixed(1)}%`">
                  <template #suffix>
                    <span class="muted" style="font-size: var(--fs-caption); margin-left: 4px">越低越省</span>
                  </template>
                </NStatistic>
              </NGi>
              <NGi>
                <NStatistic label="召回率" :value="summary.recall ? `${(summary.recall.avgRecall * 100).toFixed(1)}%` : 'N/A'">
                  <template #suffix>
                    <NTag v-if="summary.recall" :type="recallTagType(summary.recall.avgRecall)" size="small" style="margin-left: 4px">
                      {{ summary.recall.evaluated }} 条
                    </NTag>
                    <span v-else class="muted" style="font-size: var(--fs-caption); margin-left: 4px">无标注</span>
                  </template>
                </NStatistic>
              </NGi>
              <NGi v-if="avgCoherence !== null">
                <NStatistic label="连贯性" :value="`${(avgCoherence * 100).toFixed(1)}%`">
                  <template #suffix>
                    <NTag :type="coherenceTagType(avgCoherence)" size="small" style="margin-left: 4px">
                      {{ multiTurnSessions.length }} 会话
                    </NTag>
                  </template>
                </NStatistic>
              </NGi>
            </NGrid>

            <!-- 结果质量 + 配置摘要 -->
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
                    <div v-if="avgCoherence !== null">
                      平均上下文连贯性: <strong>{{ (avgCoherence * 100).toFixed(1) }}%</strong>
                      <span class="muted" style="margin-left: 4px">followup 轮召回 opening 轮文档比例</span>
                    </div>
                    <div v-if="!summary.recall && avgCoherence === null" class="muted">无召回率/连贯性评估数据</div>
                  </NSpace>
                </NCard>
              </NGi>
              <NGi>
                <NCard size="small" :bordered="true">
                  <div class="detail-title">配置摘要</div>
                  <NSpace vertical :size="4" style="margin-top: 8px">
                    <div>查询引擎: <strong>{{ result.options.engine }}</strong></div>
                    <div>测试集来源: <strong>{{ result.options.fixtureSetId }}</strong>（{{ result.options.fixturesCount }} 条）</div>
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

        <!-- ===== Tab 4: CE 多轮会话分析 ===== -->
        <NTabPane v-if="showMultiTurnTab" name="multi-turn" tab="CE 多轮会话">
          <NSpace vertical :size="16">
            <!-- 连贯性评分概览 -->
            <NCard size="small" :bordered="true">
              <div class="detail-title">上下文连贯性评分</div>
              <NSpace :size="12" align="center" style="margin-top: 8px">
                <NStatistic v-if="avgCoherence !== null" label="平均连贯性" :value="`${(avgCoherence * 100).toFixed(1)}%`">
                  <template #suffix>
                    <NTag :type="coherenceTagType(avgCoherence)" size="small" style="margin-left: 4px">
                      {{ multiTurnSessions.length }} 个会话
                    </NTag>
                  </template>
                </NStatistic>
                <span v-else class="muted">无连贯性评估数据（需 opening + followup 轮召回文档）</span>
              </NSpace>
              <div class="muted" style="margin-top: 8px; font-size: var(--fs-caption)">
                连贯性评分 = followup/recall 轮召回 opening 轮文档的比例，衡量 CE 引擎在多轮会话中保持上下文可访问的能力（参考 lossless-claw assemble 能力维度）。
              </div>
            </NCard>

            <!-- 会话汇总表 -->
            <NCard size="small" :bordered="true">
              <div class="detail-title">会话汇总</div>
              <NTable size="small" :bordered="true" :single-line="false" style="margin-top: 6px">
                <thead>
                  <tr>
                    <th>会话 ID</th>
                    <th>分类</th>
                    <th>轮次</th>
                    <th>成功</th>
                    <th>成功率</th>
                    <th>平均延迟</th>
                    <th>连贯性</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="s in multiTurnSessions" :key="s.sessionId">
                    <td><code style="font-size: var(--fs-caption)">{{ s.sessionId }}</code></td>
                    <td><NTag size="tiny" type="info">{{ categoryLabel(s.category) }}</NTag></td>
                    <td>{{ s.turnCount }}</td>
                    <td>{{ s.successCount }}</td>
                    <td>
                      <NTag :type="successRateTagType(s.turnCount > 0 ? s.successCount / s.turnCount : 0)" size="tiny">
                        {{ s.turnCount > 0 ? ((s.successCount / s.turnCount) * 100).toFixed(0) : 0 }}%
                      </NTag>
                    </td>
                    <td>
                      <NTag :type="latencyTagType(s.avgLatencyMs)" size="small">
                        {{ latencyLabel(Math.round(s.avgLatencyMs)) }}
                      </NTag>
                    </td>
                    <td>
                      <NTag v-if="s.coherenceScore !== null" :type="coherenceTagType(s.coherenceScore)" size="small">
                        {{ (s.coherenceScore * 100).toFixed(1) }}%
                      </NTag>
                      <span v-else class="muted">N/A</span>
                    </td>
                  </tr>
                </tbody>
              </NTable>
            </NCard>

            <!-- Recall by turn 趋势图 -->
            <NCard size="small" :bordered="true">
              <div v-if="multiTurnRecallOption && Object.keys(multiTurnRecallOption).length > 0">
                <EChart :option="multiTurnRecallOption" height="320px" />
              </div>
              <NEmpty v-else description="无召回率评估的轮次" style="padding: 80px 0" />
            </NCard>

            <!-- Latency by turn 柱状图 -->
            <NCard size="small" :bordered="true">
              <EChart :option="multiTurnLatencyOption" height="320px" />
            </NCard>

            <!-- 结果数 by turn（召回衰减检测） -->
            <NCard size="small" :bordered="true">
              <div class="detail-title">召回衰减检测</div>
              <EChart :option="multiTurnResultCountOption" height="300px" />
              <div class="muted" style="margin-top: 8px; font-size: var(--fs-caption)">
                结果数随轮次下降可能表示召回衰减（lossless-claw compact 压缩后旧轮次相关性降低）。
              </div>
            </NCard>
          </NSpace>
        </NTabPane>

        <!-- ===== Tab 5: 逐条详情 ===== -->
        <NTabPane name="details" tab="逐条详情">
          <NSpace vertical :size="12">
            <div class="detail-section">
              <div class="detail-title">逐条用例结果（{{ result.items.length }} 条）</div>
              <NTable size="small" :bordered="true" :single-line="false" style="margin-top: 6px">
                <thead>
                  <tr>
                    <th style="width: 80px">ID</th>
                    <th v-if="hasMultiTurnMeta" style="width: 90px">会话</th>
                    <th v-if="hasMultiTurnMeta" style="width: 70px">轮次</th>
                    <th v-if="hasMultiTurnMeta" style="width: 70px">角色</th>
                    <th style="width: 70px">分类</th>
                    <th>查询</th>
                    <th style="width: 60px">状态</th>
                    <th style="width: 80px">延迟</th>
                    <th style="width: 60px">结果数</th>
                    <th style="width: 70px">召回率</th>
                    <th v-if="result.options.engine === 'ce'" style="width: 70px">来源</th>
                    <th v-if="result.options.engine === 'ce'" style="width: 100px">CE 诊断</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(item, idx) in result.items" :key="idx" :class="{ 'row-error': !item.success }">
                    <td><code style="font-size: var(--fs-caption)">{{ item.fixtureId }}</code></td>
                    <td v-if="hasMultiTurnMeta"><code style="font-size: var(--fs-caption)">{{ item.sessionId ?? '-' }}</code></td>
                    <td v-if="hasMultiTurnMeta">{{ item.turnIndex !== undefined ? `${item.turnIndex + 1}/${item.turnTotal ?? '?'}` : '-' }}</td>
                    <td v-if="hasMultiTurnMeta">
                      <NTag v-if="item.turnRole" size="tiny" :type="item.turnRole === 'opening' ? 'success' : 'default'">
                        {{ item.turnRole }}
                      </NTag>
                      <span v-else class="muted">-</span>
                    </td>
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
                    <td v-if="result.options.engine === 'ce'">
                      <NTag
                        v-for="src in [...new Set((item.topResults ?? []).map((r) => r.source).filter(Boolean))]"
                        :key="src"
                        size="tiny"
                        :type="src === 'qmd' ? 'success' : (src === 'neo4j' ? 'warning' : 'info')"
                        style="margin-right: 2px"
                      >
                        {{ src }}
                      </NTag>
                    </td>
                    <td v-if="result.options.engine === 'ce'">
                      <NTag
                        v-if="item.ceDiagnostics"
                        size="tiny"
                        :type="ceDiagTagType(item.ceDiagnostics.conclusion)"
                      >
                        {{ ceDiagLabel(item.ceDiagnostics.conclusion) }}
                      </NTag>
                      <span v-else class="muted">-</span>
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
                    <!-- CE 引擎诊断 -->
                    <div v-if="f.ceDiagnostics">
                      <strong>CE 诊断:</strong>
                      <NTag size="tiny" :type="ceDiagTagType(f.ceDiagnostics.conclusion)" style="margin-left: 4px">
                        {{ ceDiagLabel(f.ceDiagnostics.conclusion) }}
                      </NTag>
                      <div style="margin-top: 4px; font-size: 12px">
                        L1 lcm: {{ f.ceDiagnostics.lcmCount }} 条{{ f.ceDiagnostics.lcmError ? ` ⚠${f.ceDiagnostics.lcmError}` : '' }} ·
                        L2 qmd: {{ f.ceDiagnostics.qmdCount }} 条{{ f.ceDiagnostics.qmdError ? ` ⚠${f.ceDiagnostics.qmdError}` : '' }} ·
                        L3 neo4j: {{ f.ceDiagnostics.neo4jCount }} 条{{ f.ceDiagnostics.neo4jError ? ` ⚠${f.ceDiagnostics.neo4jError}` : '' }}
                      </div>
                      <div v-if="f.ceDiagnostics.hint" style="margin-top: 4px; font-size: var(--fs-caption); color: var(--color-warning)">
                        建议: {{ f.ceDiagnostics.hint }}
                      </div>
                    </div>
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
      <NEmpty description="选择测试集后点击「开始压测」" style="padding: 48px 0">
        <template #extra>
          <span class="muted">
            支持业界公认 BEIR 测试集 + 基于 lossless-claw 能力维度设计的多轮会话集，
            评估 CE 引擎的检索召回率、上下文连贯性、tokens 消耗、压缩率、性能分布。
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
  min-width: 90px;
}
.form-label-suffix {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
.fixture-set-desc {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 8px;
  background: var(--color-fill-light);
  border-radius: 4px;
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
  background-color: var(--color-danger-suppl, rgba(208, 48, 80, 0.06));
}
.error-cell {
  color: var(--color-danger);
  font-size: var(--fs-caption);
  word-break: break-all;
}
.muted {
  color: var(--color-text-secondary);
  font-size: var(--fs-caption);
}
.snippet-cell {
  font-size: var(--fs-caption);
  word-break: break-all;
  max-width: 400px;
}
.manual-instructions {
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 12px;
  font-family: var(--font-family-mono);
  font-size: var(--fs-caption);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
}

/* ===== 实时日志面板 ===== */
.live-progress {
  height: 6px;
  background: var(--color-border);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 12px;
}
.live-progress-bar {
  height: 100%;
  background: var(--color-primary);
  transition: width 0.3s ease;
  border-radius: 3px;
}
.live-progress-bar.is-running {
  animation: live-progress-pulse 1.5s ease-in-out infinite;
}
@keyframes live-progress-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
.live-log-list {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 4px 8px;
  background: var(--color-card-bg);
  font-family: var(--font-family-mono);
  font-size: 12px;
}
.live-log-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--color-divider);
}
.live-log-entry:last-child {
  border-bottom: none;
}
.live-log-entry.is-fail {
  background: rgba(208, 48, 80, 0.05);
  border-radius: 2px;
  padding-left: 4px;
  padding-right: 4px;
}
.live-log-index {
  color: var(--color-text-tertiary);
  min-width: 36px;
  font-size: var(--fs-caption);
}
.live-log-fixture {
  color: var(--color-text-secondary);
  min-width: 70px;
  font-size: var(--fs-caption);
}
.live-log-query {
  flex: 1;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.live-log-cat {
  color: var(--color-text-tertiary);
  font-size: var(--fs-caption);
  min-width: 40px;
}
.live-log-count {
  color: var(--color-text-secondary);
  min-width: 50px;
  text-align: right;
  font-size: var(--fs-caption);
}
.live-log-latency {
  min-width: 60px;
  text-align: right;
  font-weight: 500;
}
.live-log-latency.success { color: var(--color-success); }
.live-log-latency.warning { color: var(--color-warning); }
.live-log-latency.error { color: var(--color-danger); }
.live-log-error {
  color: var(--color-danger);
  font-size: var(--fs-caption);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
.live-log-empty {
  color: var(--color-text-tertiary);
  text-align: center;
  padding: 24px 0;
  font-size: var(--fs-caption);
}
</style>
