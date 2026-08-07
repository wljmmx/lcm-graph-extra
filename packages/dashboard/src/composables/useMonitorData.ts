/**
 * 共享监控数据层：统一封装所有轮询查询，各子页面按需引入。
 *
 * TanStack Query cache-key 相同 => 不会重复请求，跨组件共享数据。
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  fetchHealthLatest,
  fetchHealthHistory,
  fetchAgentStatus,
  fetchGraphHealth,
  type HealthSnapshot,
  type DashboardSnapshot,
  type AgentStatus,
  type GraphHealthResponse,
} from '../api/health';
import { fetchMoaPerformance, type MoaPerformanceData } from '../api/moa';
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
  type GmProCommunitySummary,
  type GmProServiceStatus,
} from '../api/gm-pro';
import { useTheme } from './useTheme';

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
  const { data: latestData, isLoading: latestLoading, isError: latestIsError } = useQuery({
    queryKey: ['health-latest'],
    queryFn: fetchHealthLatest,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  // ── 2. health-history (60s) ──
  const historyN = ref(24);
  const { data: historyData, isLoading: historyLoading, isError: historyIsError } = useQuery({
    queryKey: ['health-history', historyN],
    queryFn: () => fetchHealthHistory(historyN.value),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // ── 3. agent-status (30s) ──
  const { data: agentData, isLoading: agentLoading, isError: agentIsError } = useQuery({
    queryKey: ['agent-status'],
    queryFn: fetchAgentStatus,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // ── 4. graph-health (30s) ──
  const { data: graphHealthData, isLoading: graphHealthLoading, isError: graphHealthIsError } = useQuery({
    queryKey: ['graph-health'],
    queryFn: fetchGraphHealth,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // ── 5. gm-pro-health (30s) ──
  const { data: gmProHealthRes } = useQuery({
    queryKey: ['gm-pro-health'],
    queryFn: fetchGmProHealth,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const gmProHealth = computed(() => gmProHealthRes.value?.ok ? (gmProHealthRes.value.data ?? null) : null);

  // ── 6. gm-pro-top10 (60s) ──
  const { data: gmProTop10Res } = useQuery({
    queryKey: ['gm-pro-top10'],
    queryFn: () => fetchGmProTop(10),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const gmProTop10 = computed(() => gmProTop10Res.value?.ok ? (gmProTop10Res.value.data?.nodes ?? []) : []);

  // ── 7. gm-pro-dirty (60s) ──
  const { data: gmProDirtyRes } = useQuery({
    queryKey: ['gm-pro-dirty-nodes'],
    queryFn: fetchGmProDirtyNodes,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const gmProDirty = computed(() => gmProDirtyRes.value?.ok ? (gmProDirtyRes.value.data ?? null) : null);

  // ── 8. gm-pro-communities (120s) ──
  const { data: gmProCommunitiesRes } = useQuery({
    queryKey: ['gm-pro-communities'],
    queryFn: fetchGmProCommunities,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const gmProCommunities = computed<GmProCommunitySummary[]>(() =>
    gmProCommunitiesRes.value?.ok ? (gmProCommunitiesRes.value.data?.summaries ?? []) : [],
  );

  // ── 9. gm-pro-usage (60s) ──
  const { data: gmProUsageRes } = useQuery({
    queryKey: ['gm-pro-usage'],
    queryFn: fetchGmProUsage,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const gmProUsage = computed(() => gmProUsageRes.value?.ok ? (gmProUsageRes.value.data ?? null) : null);

  // ── 10. gm-pro-auto-tuner (120s) ──
  const { data: gmProTunerRes } = useQuery({
    queryKey: ['gm-pro-auto-tuner'],
    queryFn: fetchGmProAutoTunerState,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const gmProTuner = computed(() => gmProTunerRes.value?.ok ? (gmProTunerRes.value.data ?? null) : null);

  // ── 11. gm-pro-services (60s) ──
  const { data: gmProServicesRes } = useQuery({
    queryKey: ['gm-pro-services'],
    queryFn: fetchGmProServices,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const gmProServices = computed<GmProServiceStatus | null>(() =>
    gmProServicesRes.value?.ok ? (gmProServicesRes.value.data ?? null) : null,
  );

  // ── 12. gm-pro-doctor (120s) ──
  const { data: gmProDoctorRes } = useQuery({
    queryKey: ['gm-pro-doctor'],
    queryFn: fetchGmProDoctor,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const gmProDoctor = computed(() => gmProDoctorRes.value?.ok ? (gmProDoctorRes.value.data ?? null) : null);

  // ── 13. gm-pro-association-matrix (120s) ──
  const { data: gmProAmRes } = useQuery({
    queryKey: ['gm-pro-association-matrix'],
    queryFn: fetchGmProAssociationMatrixState,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const gmProAm = computed(() => gmProAmRes.value?.ok ? (gmProAmRes.value.data ?? null) : null);

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
    latestData, latestLoading, latestIsError,
    historyData, historyLoading, historyIsError, historyN,
    agentData, agentLoading, agentIsError,
    graphHealthData, graphHealthLoading, graphHealthIsError,
    moaPerfData, moaPerfLoading,
    // derived
    db, memory, agent, graphHealth, moaPerf,
    // gm-pro
    gmProHealth, gmProTop10, gmProDirty, gmProCommunities,
    gmProUsage, gmProTuner, gmProServices, gmProDoctor, gmProAm,
    // status
    isAnyLoading, isAnyError, refreshStatus,
    CHART,
  };
}