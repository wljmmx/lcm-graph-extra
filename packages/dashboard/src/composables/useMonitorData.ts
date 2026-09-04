/**
 * 共享监控数据层：统一封装所有轮询查询，各子页面按需引入。
 *
 * TanStack Query cache-key 相同 => 不会重复请求，跨组件共享数据。
 *
 * ── 冷启动 race 双保险 ──
 * 前端 apiGet 层已有网络层 transient 自重试（200ms → 400ms → 800ms），
 * 本层再通过 TanStack Query 的 retry 做兜底：
 *   - 网络层 transient (TypeError/AbortError)：重试 2 次指数退避
 *   - 业务层错误 (ApiError HTTP 4xx/5xx)：快速失败，不重试
 * 两层组合后，冷启动 race 下 transient 错误会被 apiGet 层吞掉，
 * 不会冒泡到 TanStack 的 isError 状态。
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  fetchHealthLatest,
  fetchHealthHistory,
  fetchAgentStatus,
  fetchGraphHealth,
  fetchGraphHealthScore,
  type HealthSnapshot,
  type DashboardSnapshot,
  type AgentStatus,
  type GraphHealthResponse,
  type GraphHealthScore,
} from '../api/health';
import { fetchMoaPerformance, type MoaPerformanceData } from '../api/moa';
import { ApiError } from '../api/client';
import {
  fetchGmProHealth,
  fetchGmProTop,
  fetchGmProDirtyNodes,
  fetchGmProCommunities,
  fetchGmProUsage,
  fetchGmProAutoTunerState,
  fetchGmProServices,
  fetchGmProDoctor,
  fetchGmProAssociationMatrixState,
  fetchGmProMetrics,
  type GmProCommunitySummary,
  type GmProServiceStatus,
} from '../api/gm-pro';
import { useTheme } from './useTheme';

/**
 * TanStack Query retry 策略：
 * 网络层 transient (TypeError/AbortError) 重试 2 次；
 * ApiError HTTP 业务错误快速失败不重试。
 *
 * 注意：退避延迟（200ms→400ms→800ms）已在 apiGet 层完成，
 * 本层只负责"要不要重试"的判定，返回 boolean 即可。
 */
function monitorRetry(
  failureCount: number,
  error: unknown,
): boolean {
  const err = error as Error | undefined;
  // ApiError：业务层确定性错误（HTTP 非 2xx），不重试
  if (err instanceof ApiError) return false;
  // TypeError / AbortError：网络层 transient（冷启动 race / 连接被拒），最多重试 2 次
  if ((err instanceof TypeError || err?.name === 'AbortError') && failureCount < 2) {
    return true;
  }
  return false;
}

export function useMonitorData() {
  const { isDark } = useTheme();

  // ── 图表色常量 ──
  const CHART = computed(() => ({
    primary: isDark.value ? '#4098fc' : '#2080f0',
    success: isDark.value ? '#36ad6a' : '#18a058',
    warning: isDark.value ? '#fcb040' : '#f0a020',
    danger:  isDark.value ? '#de5169' : '#d03050',
    info:    isDark.value ? '#9270ed' : '#7c3aed',
    neutral: isDark.value ? '#a8abb2' : '#909399',
  }));

  // ── 1. health-latest (10s) ──
  const { data: latestData, isLoading: latestLoading, isError: latestIsError, error: latestError } = useQuery({
    queryKey: ['health-latest'],
    queryFn: fetchHealthLatest,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: monitorRetry,
  });

  // ── 2. health-history (60s) ──
  const historyN = ref(24);
  const { data: historyData, isLoading: historyLoading, isError: historyIsError, error: historyError } = useQuery({
    queryKey: ['health-history', historyN],
    queryFn: () => fetchHealthHistory(historyN.value),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: monitorRetry,
  });

  // ── 3. agent-status (30s) ──
  const { data: agentData, isLoading: agentLoading, isError: agentIsError, error: agentError } = useQuery({
    queryKey: ['agent-status'],
    queryFn: fetchAgentStatus,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: monitorRetry,
  });

  // ── 4. graph-health (30s) ──
  const { data: graphHealthData, isLoading: graphHealthLoading, isError: graphHealthIsError, error: graphHealthError } = useQuery({
    queryKey: ['graph-health'],
    queryFn: fetchGraphHealth,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: monitorRetry,
  });

  // ── 4.5 graph-health-score (60s) —— v2.6.0 图谱健康评分（GraphHealthMetric 快照）──
  const { data: graphHealthScoreData, isLoading: graphHealthScoreLoading, isError: graphHealthScoreIsError } = useQuery({
    queryKey: ['graph-health-score'],
    queryFn: fetchGraphHealthScore,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: monitorRetry,
  });
  const graphHealthScore = computed<GraphHealthScore | null>(() =>
    graphHealthScoreData.value?.available ? (graphHealthScoreData.value ?? null) : null,
  );

  // ── 5. gm-pro-health (30s) ──
  const { data: gmProHealthRes, isLoading: gmProHealthLoading, isError: gmProHealthIsError } = useQuery({
    queryKey: ['gm-pro-health'],
    queryFn: fetchGmProHealth,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const gmProHealth = computed(() => gmProHealthRes.value?.ok ? (gmProHealthRes.value.data ?? null) : null);

  // ── 6. gm-pro-top10 (60s) ──
  const { data: gmProTop10Res, isLoading: gmProTop10Loading, isError: gmProTop10IsError } = useQuery({
    queryKey: ['gm-pro-top10'],
    queryFn: () => fetchGmProTop(10),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const gmProTop10 = computed(() => gmProTop10Res.value?.ok ? (gmProTop10Res.value.data?.nodes ?? []) : []);

  // ── 7. gm-pro-dirty (60s) ──
  const { data: gmProDirtyRes, isLoading: gmProDirtyLoading, isError: gmProDirtyIsError } = useQuery({
    queryKey: ['gm-pro-dirty-nodes'],
    queryFn: fetchGmProDirtyNodes,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const gmProDirty = computed(() => gmProDirtyRes.value?.ok ? (gmProDirtyRes.value.data ?? null) : null);

  // ── 8. gm-pro-communities (120s) ──
  const { data: gmProCommunitiesRes, isLoading: gmProCommunitiesLoading, isError: gmProCommunitiesIsError } = useQuery({
    queryKey: ['gm-pro-communities'],
    queryFn: fetchGmProCommunities,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const gmProCommunities = computed<GmProCommunitySummary[]>(() =>
    gmProCommunitiesRes.value?.ok ? (gmProCommunitiesRes.value.data?.summaries ?? []) : [],
  );

  // ── 9. gm-pro-usage (60s) ──
  const { data: gmProUsageRes, isLoading: gmProUsageLoading, isError: gmProUsageIsError } = useQuery({
    queryKey: ['gm-pro-usage'],
    queryFn: fetchGmProUsage,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const gmProUsage = computed(() => gmProUsageRes.value?.ok ? (gmProUsageRes.value.data ?? null) : null);

  // ── 10. gm-pro-auto-tuner (120s) ──
  const { data: gmProTunerRes, isLoading: gmProTunerLoading, isError: gmProTunerIsError } = useQuery({
    queryKey: ['gm-pro-auto-tuner'],
    queryFn: fetchGmProAutoTunerState,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const gmProTuner = computed(() => gmProTunerRes.value?.ok ? (gmProTunerRes.value.data ?? null) : null);

  // ── 11. gm-pro-services (60s) ──
  const { data: gmProServicesRes, isLoading: gmProServicesLoading, isError: gmProServicesIsError } = useQuery({
    queryKey: ['gm-pro-services'],
    queryFn: fetchGmProServices,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const gmProServices = computed<GmProServiceStatus | null>(() =>
    gmProServicesRes.value?.ok ? (gmProServicesRes.value.data ?? null) : null,
  );

  // ── 12. gm-pro-doctor (120s) ──
  const { data: gmProDoctorRes, isLoading: gmProDoctorLoading, isError: gmProDoctorIsError } = useQuery({
    queryKey: ['gm-pro-doctor'],
    queryFn: fetchGmProDoctor,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const gmProDoctor = computed(() => gmProDoctorRes.value?.ok ? (gmProDoctorRes.value.data ?? null) : null);
  /** doctor 请求失败时的错误信息（供 DoctorCard 显示真实原因，避免一律误报鉴权） */
  const gmProDoctorError = computed(() => {
    const res = gmProDoctorRes.value;
    return res && !res.ok ? String(res.error ?? '') : '';
  });

  // ── 13. gm-pro-association-matrix (120s) ──
  const { data: gmProAmRes, isLoading: gmProAmLoading, isError: gmProAmIsError } = useQuery({
    queryKey: ['gm-pro-association-matrix'],
    queryFn: fetchGmProAssociationMatrixState,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const gmProAm = computed(() => gmProAmRes.value?.ok ? (gmProAmRes.value.data ?? null) : null);

  // ── 13.5 gm-pro-metrics (30s) — Prometheus 文本性能指标 ──
  const { data: gmProMetricsRes, isLoading: gmProMetricsLoading, isError: gmProMetricsIsError } = useQuery({
    queryKey: ['gm-pro-metrics'],
    queryFn: fetchGmProMetrics,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const gmProMetrics = computed(() => (gmProMetricsRes.value?.ok ? (gmProMetricsRes.value.data ?? null) : null));

  // ── 14. moa-performance (30s) ──
  const { data: moaPerfData, isLoading: moaPerfLoading } = useQuery({
    queryKey: ['moa-performance'],
    queryFn: fetchMoaPerformance,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const moaPerf = computed<MoaPerformanceData | null>(() => moaPerfData.value?.data ?? null);

  // ── 派生数据 ──
  const db = computed<HealthSnapshot | null>(() => latestData.value?.db ?? null);
  const memory = computed<DashboardSnapshot | null>(() => latestData.value?.memory ?? null);
  const agent = computed<AgentStatus | null>(() => agentData.value ?? null);
  const graphHealth = computed<GraphHealthResponse | null>(() => graphHealthData.value ?? null);

  // 全局刷新状态
  const isAnyLoading = computed(() =>
    latestLoading.value || historyLoading.value || agentLoading.value ||
    graphHealthLoading.value || moaPerfLoading.value,
  );
  const isAnyError = computed(() =>
    latestIsError.value || historyIsError.value || agentIsError.value || graphHealthIsError.value,
  );
  const refreshStatus = computed(() => {
    if (isAnyError.value) return { label: '部分服务异常', type: 'error' as const };
    if (isAnyLoading.value && !latestData.value) return { label: '正在加载…', type: 'info' as const };
    if (isAnyLoading.value) return { label: '刷新中…', type: 'default' as const };
    return { label: '就绪', type: 'success' as const };
  });

  return {
    // 原始数据
    latestData, latestLoading, latestIsError, latestError,
    historyData, historyLoading, historyIsError, historyError, historyN,
    agentData, agentLoading, agentIsError, agentError,
    graphHealthData, graphHealthLoading, graphHealthIsError, graphHealthError,
    graphHealthScoreData, graphHealthScoreLoading, graphHealthScoreIsError,
    moaPerfData, moaPerfLoading,
    // derived
    db, memory, agent, graphHealth, graphHealthScore, moaPerf,
    // gm-pro
    gmProHealth, gmProHealthLoading, gmProHealthIsError,
    gmProTop10, gmProTop10Loading, gmProTop10IsError,
    gmProDirty, gmProDirtyLoading, gmProDirtyIsError,
    gmProCommunities, gmProCommunitiesLoading, gmProCommunitiesIsError,
    gmProUsage, gmProUsageLoading, gmProUsageIsError,
    gmProTuner, gmProTunerLoading, gmProTunerIsError,
    gmProServices, gmProServicesLoading, gmProServicesIsError,
    gmProDoctor, gmProDoctorLoading, gmProDoctorIsError, gmProDoctorError,
    gmProAm, gmProAmLoading, gmProAmIsError,
    gmProMetrics, gmProMetricsLoading, gmProMetricsIsError,
    // status
    isAnyLoading, isAnyError, refreshStatus,
    CHART,
  };
}