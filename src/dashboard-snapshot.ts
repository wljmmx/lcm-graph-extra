/**
 * LCM Dashboard 快照端点 —— 轻量 HTTP 服务，仅供本机 dashboard 读取内存态。
 *
 * 设计要点：
 * - 用 node:http，零新依赖
 * - 仅监听 127.0.0.1（默认），不暴露外网
 * - 数据通过注入的 providers 延迟求值，每次请求读取最新状态
 * - 不暴露给 agent，仅本机 dashboard 访问
 *
 * 端口冲突处理（解决 EADDRINUSE 导致整个插件崩溃）：
 * - 启动前探测端口是否被占
 *   - 若被占且响应 /internal/health 为 ok → 视为上一个实例残留
 *     （常见场景：插件进程被 kill -9 未走 dispose），
 *     尝试发送 /internal/shutdown 让旧实例退出，然后重试 listen
 *   - 若被占且非自身实例 → 放弃启动，记录 warn
 * - listen 失败（含 EADDRINUSE）通过 error 事件 + Promise reject 捕获，
 *   不再作为 unhandled error 抛出
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { getGlobalLogger } from './utils/logger.js';
// v1.2.0-1/3: 直方图与业务指标（用于 Prometheus /metrics 暴露）
import { latencyHistograms, businessMetrics } from './health-metrics.js';
// MCP 工具调用：从 tools.ts 注册表中查询 handler
import { getRegisteredToolHandler } from './tools.js';
// MoA 性能追踪
import { getMoaPerformance } from './moa/perf-tracker.js';

// v1.0.1-1/4: Basic Auth + IP 白名单配置（与 dashboard 共用 DASHBOARD_AUTH）
interface SnapshotAuthConfig {
  enabled: boolean;
  username: string;
  password: string;
}
let _authConfig: SnapshotAuthConfig | null = null;
function getSnapshotAuthConfig(): SnapshotAuthConfig {
  if (_authConfig) return _authConfig;
  const raw = process.env.DASHBOARD_AUTH;
  if (!raw || !raw.includes(':')) {
    _authConfig = { enabled: false, username: '', password: '' };
    return _authConfig;
  }
  const [username, ...rest] = raw.split(':');
  const password = rest.join(':');
  _authConfig = {
    enabled: Boolean(username && password),
    username: username ?? '',
    password: password ?? '',
  };
  return _authConfig;
}
export function _resetSnapshotAuthConfig(): void { _authConfig = null; }

// v1.0.1-4: IP 白名单 —— 逗号分隔的 IP/CIDR，默认仅允许 127.0.0.1 / ::1
function getAllowedIps(): string[] {
  const raw = process.env.SNAPSHOT_ALLOWED_IPS;
  if (!raw) return ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
function isIpAllowed(remoteAddr: string | undefined): boolean {
  if (!remoteAddr) return false;
  const allowed = getAllowedIps();
  // 直接匹配（含 IPv4-mapped IPv6 形式 ::ffff:127.0.0.1）
  if (allowed.includes(remoteAddr)) return true;
  // 去掉 ::ffff: 前缀后再匹配
  const normalized = remoteAddr.replace(/^::ffff:/, '');
  return allowed.includes(normalized);
}

// v1.0.1-1: Basic Auth 校验
function parseBasicAuth(authHeader: string | undefined): { username: string; password: string } | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}
function verifyBasicAuth(req: IncomingMessage): boolean {
  const cfg = getSnapshotAuthConfig();
  if (!cfg.enabled) return true; // 未启用 Auth 时放行
  const creds = parseBasicAuth(req.headers.authorization);
  if (!creds) return false;
  return creds.username === cfg.username && creds.password === cfg.password;
}
function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Basic realm="LCM Snapshot"',
  });
  res.end(JSON.stringify({ ok: false, error: 'Authentication required' }));
}
function sendForbidden(res: ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'IP not allowed' }));
}

// v1.2.0-4: 轻量级内存速率限制器（滑动窗口）
// snapshot server 使用 node:http，不依赖 fastify 插件，自实现 token bucket。
// 配置：SNAPSHOT_RATE_LIMIT_MAX（每窗口最大请求数，默认 60）
//       SNAPSHOT_RATE_LIMIT_WINDOW（窗口秒数，默认 60）
interface RateLimitEntry {
  count: number;
  windowStart: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = Number(process.env.SNAPSHOT_RATE_LIMIT_MAX) || 60;
const RATE_LIMIT_WINDOW_MS = (Number(process.env.SNAPSHOT_RATE_LIMIT_WINDOW) || 60) * 1000;
// 定期清理过期条目（每 5 分钟），防止内存泄漏
let lastCleanupTs = 0;
function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  // 惰性清理：每 5 分钟清理一次过期条目
  if (now - lastCleanupTs > 5 * 60 * 1000) {
    for (const [key, entry] of rateLimitMap) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
        rateLimitMap.delete(key);
      }
    }
    lastCleanupTs = now;
  }
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // 新窗口
    entry = { count: 0, windowStart: now };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
  const resetIn = Math.max(0, RATE_LIMIT_WINDOW_MS - (now - entry.windowStart));
  return { allowed: entry.count <= RATE_LIMIT_MAX, remaining, resetIn };
}
function sendTooManyRequests(res: ServerResponse, remaining: number, resetIn: number): void {
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(Math.ceil(resetIn / 1000)),
    'Retry-After': String(Math.ceil(resetIn / 1000)),
  });
  res.end(JSON.stringify({
    ok: false,
    error: 'Too Many Requests',
    message: `请求频率超限：每 ${RATE_LIMIT_WINDOW_MS / 1000}s 内最多 ${RATE_LIMIT_MAX} 次。请稍后重试。`,
    retryAfter: Math.ceil(resetIn / 1000),
  }));
}

/**
 * MCP 工具调用白名单。
 *
 * 与 packages/dashboard/server/routes/experience.ts 的 ALLOWED_MCP_TOOLS 保持一致，
 * 在 snapshot server 侧再做一次白名单校验（纵深防御，避免 dashboard 被绕过时直接调用危险工具）。
 */
const ALLOWED_MCP_TOOLS = new Set<string>([
  'lcmg_maintain',
  'lcmg_diagnose',
  'lcmg_distill',
  'lcmg_backfill',
  'lcmg_compact',
  'lcmg_reset_breaker',
  'lcmg_backup',
  'lcmg_restore',
  'lcmg_sync',
  'lcmg_import',
  'lcmg_forget',
  'lcmg_pin',
  'lcmg_distill_retry',
]);

/**
 * 从 tools.ts 注册表中查询 handler 并执行 MCP 工具调用。
 *
 * @param rawBody 原始请求体字符串（JSON）
 * @returns { ok: boolean, result?: unknown, error?: string }
 */
async function invokeMcpToolFromRegistry(rawBody: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  let parsed: { tool?: string; params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: 'invalid JSON body' };
  }
  const tool = parsed.tool;
  const params = parsed.params ?? {};
  if (!tool || typeof tool !== 'string') {
    return { ok: false, error: 'missing tool' };
  }
  if (!ALLOWED_MCP_TOOLS.has(tool)) {
    return { ok: false, error: `tool "${tool}" not allowed` };
  }
  const handler = getRegisteredToolHandler(tool);
  if (!handler || typeof handler !== 'function') {
    return { ok: false, error: `tool "${tool}" not registered` };
  }
  // 合成 toolCallId（dashboard 转发的调用没有真实 toolCallId）
  const toolCallId = `dashboard-invoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const result = await handler(toolCallId, params);
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/** Dashboard 快照聚合数据结构 */
export interface DashboardSnapshot {
  cascade: {
    armsCount: number;
    topArms: Array<{ armKey: string; alpha: number; beta: number; sample: number }>;
    confidenceThreshold: number;
  };
  userProfile: {
    techStack: Array<{ name: string; weight: number }>;
    scenario: Array<{ name: string; weight: number }>;
    language: 'zh' | 'en' | 'mixed';
  };
  graphAdapter: {
    connected: boolean;
    connectFailed: boolean;
    lastError?: string;
    /** P-CB-6: Neo4j 熔断器实时状态，每次请求从 getHealthSnapshot() 读取 */
    circuitBreaker?: { available: boolean; failures: number; open: boolean };
    /** 诊断信息：health() 被调用的总次数，用于判断 heartbeat 是否运行 */
    healthCheckCount?: number;
    /** 诊断信息：是否成功加载了 graph-memory-pro 模块 */
    gmProHasModule?: boolean;
    /** 诊断信息：gm-pro 模块中 getDriver 方法的类型（function/undefined） */
    gmProGetDriverType?: string;
    /** 诊断信息：gm-pro 的 getDriver() 是否返回了非 null 的 driver */
    gmProDriverAvailable?: boolean;
    /** 诊断信息：graphAdapter 自身是否持有 driver */
    hasOwnDriver?: boolean;
    /** 诊断信息：连接重试次数 */
    connectRetryCount?: number;
    /** 诊断信息：graph-memory-pro 模块路径与来源 */
    gmProPath?: string;
    gmProSource?: string;
  };
  debt: {
    running: number;
    pendingCount: number;
    pollIntervalMs: number;
    maxConcurrent: number;
  };
  retrieval: {
    lastQuery: string;
    perfSummary: string;
    /** P-CB-6: QMD 熔断器实时状态，每次请求从 getHealthSnapshot() 读取 */
    qmdCircuitBreaker?: { available: boolean; failures: number; open: boolean };
  };
  health: {
    latest: HealthSnapshotLite | null; // healthMetrics.getLatest()
  };
  capabilityProfile?: {
    current: { id: string; label: string; description: string; estimatedOverhead: number };
    available: Array<{ id: string; label: string; description: string; estimatedOverhead: number; apiCount: number }>;
  };
  timestamp: number;
}

/** N-4: 轻量健康指标子集，用于 Prometheus 端点暴露 */
export interface HealthSnapshotLite {
  pendingMessages: number;
  summaryFragments: number;
  maxTokenRatio: number;
  cbLcmAvailable: boolean;
  cbQmdAvailable: boolean;
  cbNeo4jAvailable: boolean;
  cbLcmFailures: number;
  cbQmdFailures: number;
  cbNeo4jFailures: number;
  lastAssembleMs: number;
  lastL2Ms: number;
  lastL3Ms: number;
  lastL4Ms: number;
  pendingExperienceCount: number;
  distilledExperienceCount: number;
  tierLow: number;
  tierMedium: number;
  tierHigh: number;
  // R-2: cascade Tier 1 置信度（仅内存态）
  cascadeTier1Confidence?: number;
  cascadeJudgeSource?: 'gm-pro' | 'local';
  // N-5: Embedding API 健康状态（heartbeat 中定时探测）
  embedAvailable?: boolean;
  // v1.1-6: UX 指标 —— 降级频率 / Token 节省率 / 经验命中率
  degradedCount?: number;
  totalAssembleCount?: number;
  tokenSavedRatio?: number;
  experienceHitCount?: number;
  experienceQueryCount?: number;
  // v1.1-7: 最近一次 assemble 的降级原因（用于 Dashboard 链路状态展示）
  lastDegradedReasons?: string[];
  // v2.4.0: 熔断器全局累计计数器（跨窗口持久化）
  cbLcmTotalChecks?: number;
  cbLcmSuccessCount?: number;
  cbLcmTransitions?: number;
  cbQmdTotalChecks?: number;
  cbQmdSuccessCount?: number;
  cbQmdTransitions?: number;
  cbNeo4jTotalChecks?: number;
  cbNeo4jSuccessCount?: number;
  cbNeo4jTransitions?: number;
  // v2.4.0: UX 指标全局累计（跨窗口持久化）
  globalDegradedCount?: number;
  globalTotalAssembleCount?: number;
  globalExperienceHitCount?: number;
  globalExperienceQueryCount?: number;
}

/**
 * 数据采集 providers —— 由 index.ts 注入，每次请求时调用以读取最新内存态。
 * 设计为函数形式便于：(1) 延迟求值（register 时单例可能未初始化）；(2) 测试注入 mock。
 */
export interface SnapshotProviders {
  getCascadeSnapshot: () => DashboardSnapshot['cascade'];
  getUserProfile: () => DashboardSnapshot['userProfile'];
  getGraphAdapterState: () => DashboardSnapshot['graphAdapter'];
  getDebtStats: () => DashboardSnapshot['debt'];
  getRetrievalState: () => DashboardSnapshot['retrieval'];
  getHealthLatest: () => DashboardSnapshot['health']['latest'];
}

/**
 * 聚合所有 providers 数据为完整快照。
 * 单独导出便于测试（不依赖 HTTP 层）。
 */
export function buildSnapshot(providers: SnapshotProviders): DashboardSnapshot {
  let capabilityProfile: any = undefined;
  try {
    const { getCurrentProfile, listProfiles } = require('./capability-profiles.js');
    capabilityProfile = { current: getCurrentProfile(), available: listProfiles() };
  } catch { /* capability-profiles not available */ }

  // 逐 provider 隔离异常：任一 provider 抛错不影响其他字段，也不导致整个 snapshot 500。
  // 修复前：若 graphAdapter 在 dispose 竞态中被置 null 后访问 ._connectFailed，
  // 或 cascadeManager 内部状态异常，整个 /internal/snapshot 端点 500，
  // dashboard 页面完全不可用。

  let cascade: DashboardSnapshot['cascade'];
  try {
    cascade = providers.getCascadeSnapshot();
  } catch (e) {
    cascade = { armsCount: 0, topArms: [], confidenceThreshold: 0.7 };
    getGlobalLogger()?.debug?.('[dashboard-snapshot] cascade snapshot failed, using fallback', { err: e instanceof Error ? e.message : String(e) });
  }

  let userProfile: DashboardSnapshot['userProfile'];
  try {
    userProfile = providers.getUserProfile();
  } catch (e) {
    userProfile = { techStack: [], scenario: [], language: 'mixed' };
    getGlobalLogger()?.debug?.('[dashboard-snapshot] userProfile snapshot failed, using fallback', { err: e instanceof Error ? e.message : String(e) });
  }

  let graphAdapter: DashboardSnapshot['graphAdapter'];
  try {
    graphAdapter = providers.getGraphAdapterState();
  } catch (e) {
    graphAdapter = { connected: false, connectFailed: true, lastError: String(e) };
    getGlobalLogger()?.debug?.('[dashboard-snapshot] graphAdapter snapshot failed, using fallback', { err: e instanceof Error ? e.message : String(e) });
  }

  let debt: DashboardSnapshot['debt'];
  try {
    debt = providers.getDebtStats();
  } catch (e) {
    debt = { running: 0, pendingCount: 0, pollIntervalMs: 60000, maxConcurrent: 2 };
    getGlobalLogger()?.debug?.('[dashboard-snapshot] debt snapshot failed, using fallback', { err: e instanceof Error ? e.message : String(e) });
  }

  let retrieval: DashboardSnapshot['retrieval'];
  try {
    retrieval = providers.getRetrievalState();
  } catch (e) {
    retrieval = { lastQuery: '', perfSummary: 'snapshot error' };
    getGlobalLogger()?.debug?.('[dashboard-snapshot] retrieval snapshot failed, using fallback', { err: e instanceof Error ? e.message : String(e) });
  }

  let health: DashboardSnapshot['health'];
  try {
    health = { latest: providers.getHealthLatest() };
  } catch (e) {
    health = { latest: null };
    getGlobalLogger()?.debug?.('[dashboard-snapshot] health snapshot failed, using fallback', { err: e instanceof Error ? e.message : String(e) });
  }

  return {
    cascade,
    userProfile,
    graphAdapter,
    debt,
    retrieval,
    health,
    capabilityProfile,
    timestamp: Date.now(),
  };
}

/**
 * N-4: 构建 Prometheus text exposition 格式指标。
 * 输出格式遵循 Prometheus exposition format v0.0.4。
 *
 * 指标分组：
 * - lcm_pressure_*：压力信号（pendingMessages / summaryFragments / tokenRatio）
 * - lcm_circuit_breaker_*：三引擎熔断状态（lcm/qmd/neo4j）
 * - lcm_retrieval_*：检索性能（last assemble ms + L2/L3/L4 分引擎）
 * - lcm_experience_*：经验层统计（pending / distilled）
 * - lcm_tier_*：压力 tier 分布（low/medium/high）
 */
export function buildPrometheusMetrics(providers: SnapshotProviders): string {
  const lines: string[] = [];
  const health = providers.getHealthLatest();
  const graph = providers.getGraphAdapterState();
  const ts = Date.now();

  // health 可能为 null（healthMetrics 尚未产生快照），此时输出零值指标
  const h: HealthSnapshotLite = {
    pendingMessages: 0,
    summaryFragments: 0,
    maxTokenRatio: 0,
    cbLcmAvailable: false,
    cbQmdAvailable: false,
    cbNeo4jAvailable: false,
    cbLcmFailures: 0,
    cbQmdFailures: 0,
    cbNeo4jFailures: 0,
    lastAssembleMs: 0,
    lastL2Ms: 0,
    lastL3Ms: 0,
    lastL4Ms: 0,
    pendingExperienceCount: 0,
    distilledExperienceCount: 0,
    tierLow: 0,
    tierMedium: 0,
    tierHigh: 0,
    ...(health ?? {}),
  };

  // 压力信号
  lines.push('# HELP lcm_pressure_pending_messages Pending messages in lossless-claw');
  lines.push('# TYPE lcm_pressure_pending_messages gauge');
  lines.push(`lcm_pressure_pending_messages ${h.pendingMessages ?? 0} ${ts}`);
  lines.push('# HELP lcm_pressure_summary_fragments Summary fragments count');
  lines.push('# TYPE lcm_pressure_summary_fragments gauge');
  lines.push(`lcm_pressure_summary_fragments ${h.summaryFragments ?? 0} ${ts}`);
  lines.push('# HELP lcm_pressure_max_token_ratio Max token ratio (0-1)');
  lines.push('# TYPE lcm_pressure_max_token_ratio gauge');
  lines.push(`lcm_pressure_max_token_ratio ${h.maxTokenRatio ?? 0} ${ts}`);

  // 熔断器状态（1=可用，0=熔断）
  lines.push('# HELP lcm_circuit_breaker_available Circuit breaker available (1=yes, 0=no)');
  lines.push('# TYPE lcm_circuit_breaker_available gauge');
  lines.push(`lcm_circuit_breaker_available{engine="lcm"} ${h.cbLcmAvailable ? 1 : 0} ${ts}`);
  lines.push(`lcm_circuit_breaker_available{engine="qmd"} ${h.cbQmdAvailable ? 1 : 0} ${ts}`);
  lines.push(`lcm_circuit_breaker_available{engine="neo4j"} ${h.cbNeo4jAvailable ? 1 : 0} ${ts}`);

  lines.push('# HELP lcm_circuit_breaker_failures Circuit breaker failure count');
  lines.push('# TYPE lcm_circuit_breaker_failures gauge');
  lines.push(`lcm_circuit_breaker_failures{engine="lcm"} ${h.cbLcmFailures ?? 0} ${ts}`);
  lines.push(`lcm_circuit_breaker_failures{engine="qmd"} ${h.cbQmdFailures ?? 0} ${ts}`);
  lines.push(`lcm_circuit_breaker_failures{engine="neo4j"} ${h.cbNeo4jFailures ?? 0} ${ts}`);

  // 检索性能
  lines.push('# HELP lcm_retrieval_last_assemble_ms Last assemble duration in ms');
  lines.push('# TYPE lcm_retrieval_last_assemble_ms gauge');
  lines.push(`lcm_retrieval_last_assemble_ms ${h.lastAssembleMs ?? 0} ${ts}`);
  lines.push('# HELP lcm_retrieval_engine_ms Per-engine retrieval duration in ms');
  lines.push('# TYPE lcm_retrieval_engine_ms gauge');
  lines.push(`lcm_retrieval_engine_ms{engine="l2_qmd"} ${h.lastL2Ms ?? 0} ${ts}`);
  lines.push(`lcm_retrieval_engine_ms{engine="l3_graph"} ${h.lastL3Ms ?? 0} ${ts}`);
  lines.push(`lcm_retrieval_engine_ms{engine="l4_experience"} ${h.lastL4Ms ?? 0} ${ts}`);

  // 经验层
  lines.push('# HELP lcm_experience_pending Pending experience count');
  lines.push('# TYPE lcm_experience_pending gauge');
  lines.push(`lcm_experience_pending ${h.pendingExperienceCount ?? 0} ${ts}`);
  lines.push('# HELP lcm_experience_distilled Distilled experience count');
  lines.push('# TYPE lcm_experience_distilled gauge');
  lines.push(`lcm_experience_distilled ${h.distilledExperienceCount ?? 0} ${ts}`);

  // Tier 分布
  lines.push('# HELP lcm_tier_count Pressure tier count');
  lines.push('# TYPE lcm_tier_count gauge');
  lines.push(`lcm_tier_count{tier="low"} ${h.tierLow ?? 0} ${ts}`);
  lines.push(`lcm_tier_count{tier="medium"} ${h.tierMedium ?? 0} ${ts}`);
  lines.push(`lcm_tier_count{tier="high"} ${h.tierHigh ?? 0} ${ts}`);

  // R-2: cascade Tier 1 置信度
  lines.push('# HELP lcm_cascade_tier1_confidence Cascade Tier 1 confidence (0-1)');
  lines.push('# TYPE lcm_cascade_tier1_confidence gauge');
  lines.push(`lcm_cascade_tier1_confidence{source="${h.cascadeJudgeSource ?? 'local'}"} ${h.cascadeTier1Confidence ?? 0} ${ts}`);

  // Graph adapter 状态
  lines.push('# HELP lcm_graph_adapter_connected Graph adapter connected (1=yes, 0=no)');
  lines.push('# TYPE lcm_graph_adapter_connected gauge');
  lines.push(`lcm_graph_adapter_connected ${graph?.connected ? 1 : 0} ${ts}`);

  // v1.1-6: UX 指标 —— 降级频率 / Token 节省率 / 经验命中率
  lines.push('# HELP lcm_ux_degradation_rate Assemble degradation rate (0-1)');
  lines.push('# TYPE lcm_ux_degradation_rate gauge');
  const uxTotal = h.totalAssembleCount ?? 0;
  const uxDegraded = h.degradedCount ?? 0;
  lines.push(`lcm_ux_degradation_rate ${uxTotal > 0 ? (uxDegraded / uxTotal).toFixed(4) : '0'} ${ts}`);
  lines.push('# HELP lcm_ux_token_saved_ratio Token saved ratio (sliding avg, 0-1)');
  lines.push('# TYPE lcm_ux_token_saved_ratio gauge');
  lines.push(`lcm_ux_token_saved_ratio ${(h.tokenSavedRatio ?? 0).toFixed(4)} ${ts}`);
  lines.push('# HELP lcm_ux_experience_hit_rate Experience hit rate (0-1)');
  lines.push('# TYPE lcm_ux_experience_hit_rate gauge');
  const expQuery = h.experienceQueryCount ?? 0;
  const expHit = h.experienceHitCount ?? 0;
  lines.push(`lcm_ux_experience_hit_rate ${expQuery > 0 ? (expHit / expQuery).toFixed(4) : '0'} ${ts}`);
  lines.push('# HELP lcm_ux_assemble_total Total assemble count');
  lines.push('# TYPE lcm_ux_assemble_total counter');
  lines.push(`lcm_ux_assemble_total ${uxTotal} ${ts}`);

  // v1.2.0-1: 延迟直方图（summary 类型，暴露 P50/P90/P95/P99 + avg + count）
  // Prometheus summary 适合百分位场景；histogram 类型需要 bucket 边界，我们用滑动窗口采样，
  // 不预定义 bucket，因此用 summary 暴露 quantile 标签。
  const histGroups: Array<{ name: string; help: string; hist: typeof latencyHistograms.assemble }> = [
    { name: 'lcm_retrieval_assemble_ms', help: 'Assemble total duration latency (ms)', hist: latencyHistograms.assemble },
    { name: 'lcm_retrieval_engine_l2_qmd_ms', help: 'L2 QMD engine retrieval latency (ms)', hist: latencyHistograms.l2_qmd },
    { name: 'lcm_retrieval_engine_l3_graph_ms', help: 'L3 Graph engine retrieval latency (ms)', hist: latencyHistograms.l3_graph },
    { name: 'lcm_retrieval_engine_l4_experience_ms', help: 'L4 Experience engine retrieval latency (ms)', hist: latencyHistograms.l4_experience },
  ];
  for (const g of histGroups) {
    const stats = g.hist.getStats();
    lines.push(`# HELP ${g.name} ${g.help}`);
    lines.push(`# TYPE ${g.name} summary`);
    if (stats.count > 0) {
      lines.push(`${g.name}{quantile="0.5"} ${stats.p50} ${ts}`);
      lines.push(`${g.name}{quantile="0.9"} ${stats.p90} ${ts}`);
      lines.push(`${g.name}{quantile="0.95"} ${stats.p95} ${ts}`);
      lines.push(`${g.name}{quantile="0.99"} ${stats.p99} ${ts}`);
      lines.push(`${g.name}_sum ${Math.round(stats.avg * stats.count)} ${ts}`);
      lines.push(`${g.name}_count ${stats.count} ${ts}`);
      // 额外暴露 min/max 作为 gauge（非标准 summary 字段，便于 Dashboard 直读）
      lines.push(`# HELP ${g.name}_min Min latency (ms)`);
      lines.push(`# TYPE ${g.name}_min gauge`);
      lines.push(`${g.name}_min ${stats.min} ${ts}`);
      lines.push(`# HELP ${g.name}_max Max latency (ms)`);
      lines.push(`# TYPE ${g.name}_max gauge`);
      lines.push(`${g.name}_max ${stats.max} ${ts}`);
    } else {
      // 无采样时输出零值，保持指标 schema 稳定
      lines.push(`${g.name}{quantile="0.5"} 0 ${ts}`);
      lines.push(`${g.name}{quantile="0.9"} 0 ${ts}`);
      lines.push(`${g.name}{quantile="0.95"} 0 ${ts}`);
      lines.push(`${g.name}{quantile="0.99"} 0 ${ts}`);
      lines.push(`${g.name}_sum 0 ${ts}`);
      lines.push(`${g.name}_count 0 ${ts}`);
    }
  }

  // v1.2.0-3: 业务指标 —— 经验质量分布 / TTL 命中率 / 蒸馏成功率
  const biz = businessMetrics.getSummary();
  lines.push('# HELP lcm_exp_quality_count Experience quality distribution by bucket (low/medium/high)');
  lines.push('# TYPE lcm_exp_quality_count gauge');
  lines.push(`lcm_exp_quality_count{bucket="low"} ${biz.expQuality.low} ${ts}`);
  lines.push(`lcm_exp_quality_count{bucket="medium"} ${biz.expQuality.medium} ${ts}`);
  lines.push(`lcm_exp_quality_count{bucket="high"} ${biz.expQuality.high} ${ts}`);

  lines.push('# HELP lcm_ttl_hit_rate TTL cache hit rate (0-1)');
  lines.push('# TYPE lcm_ttl_hit_rate gauge');
  lines.push(`lcm_ttl_hit_rate ${biz.ttlHitRate.toFixed(4)} ${ts}`);
  lines.push('# HELP lcm_ttl_accesses_total TTL cache total accesses (hits + misses)');
  lines.push('# TYPE lcm_ttl_accesses_total counter');
  lines.push(`lcm_ttl_accesses_total{result="hit"} ${biz.ttlHits} ${ts}`);
  lines.push(`lcm_ttl_accesses_total{result="miss"} ${biz.ttlMisses} ${ts}`);

  lines.push('# HELP lcm_distill_success_rate Distill success rate (0-1)');
  lines.push('# TYPE lcm_distill_success_rate gauge');
  lines.push(`lcm_distill_success_rate ${biz.distillSuccessRate.toFixed(4)} ${ts}`);
  lines.push('# HELP lcm_distill_total Total distill operations');
  lines.push('# TYPE lcm_distill_total counter');
  lines.push(`lcm_distill_total{result="success"} ${biz.distillSuccess} ${ts}`);
  lines.push(`lcm_distill_total{result="failure"} ${biz.distillFailure} ${ts}`);

  // 能力档次指标
  try {
    const { getCurrentProfile } = require('./capability-profiles.js');
    const profile = getCurrentProfile();
    lines.push('# HELP lcm_capability_profile_overhead Estimated overhead (1-10) of current capability profile');
    lines.push('# TYPE lcm_capability_profile_overhead gauge');
    lines.push(`lcm_capability_profile_overhead ${profile.estimatedOverhead} ${ts}`);
    lines.push('# HELP lcm_capability_profile_enabled_apis Number of enabled gm-pro APIs in current profile');
    lines.push('# TYPE lcm_capability_profile_enabled_apis gauge');
    lines.push(`lcm_capability_profile_enabled_apis ${profile.enabledApis.length} ${ts}`);
  } catch { /* capability-profiles not available */ }

  return lines.join('\n') + '\n';
}

/**
 * N-4: 解析图谱健康（优先 gm-pro G-5 getGraphHealth，降级到本地 GraphAdapter 状态）。
 */
export async function resolveGraphHealth(providers: SnapshotProviders): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  source: 'gm-pro' | 'local';
  nodeCount?: number;
  relationshipCount?: number;
  graphAdapterConnected?: boolean;
  circuitBreakerOpen?: boolean;
  circuitBreakerFailures?: number;
  details?: Record<string, unknown>;
}> {
  const local = providers.getGraphAdapterState();
  // P-CB-6: 同时考虑熔断器状态。熔断器 OPEN 时，即使 driver 连接正常，
  // 实际调用也会被拦截，应报告为 unhealthy。
  const cbOpen = local?.circuitBreaker?.open ?? false;
  const cbFailures = local?.circuitBreaker?.failures ?? 0;
  // gm-pro 不可用时，仅基于 GraphAdapter 连接状态 + 熔断器状态推断
  const localStatus: 'healthy' | 'degraded' | 'unhealthy' =
    cbOpen ? 'unhealthy'
    : local?.connected ? 'healthy'
    : (local?.connectFailed ? 'unhealthy' : 'degraded');

  try {
    const { withGmProFallback } = await import('./adapters/gm-pro-fallback.js');
    const gmHealth = await withGmProFallback<any>(
      'getGraphHealth',
      async (mod) => await mod.getGraphHealth(),
      async () => null,
      { label: 'N-4 getGraphHealth' },
    );
    if (gmHealth && typeof gmHealth.status === 'string') {
      // 修复：如果 gm-pro 返回 unknown 或无效的 status 值，降级到 local status
      // 避免 dashboard 显示 unknown（gm-pro 可能在初始化阶段返回 unknown）
      const validStatuses = ['healthy', 'degraded', 'unhealthy'] as const;
      const status = validStatuses.includes(gmHealth.status as typeof validStatuses[number])
        ? gmHealth.status as 'healthy' | 'degraded' | 'unhealthy'
        : localStatus;
      return {
        status,
        source: 'gm-pro',
        nodeCount: gmHealth.nodeCount,
        relationshipCount: gmHealth.relationshipCount,
        graphAdapterConnected: local?.connected,
        circuitBreakerOpen: cbOpen,
        circuitBreakerFailures: cbFailures,
        details: gmHealth.details,
      };
    }
  } catch (e) {
    // 降级到 local
    getGlobalLogger().debug('[dashboard-snapshot] graph-memory-pro health probe failed, falling back to local', { err: e instanceof Error ? e.message : String(e) });
  }

  return {
    status: localStatus,
    source: 'local',
    graphAdapterConnected: local?.connected,
    circuitBreakerOpen: cbOpen,
    circuitBreakerFailures: cbFailures,
  };
}

/** 启动选项 */
export interface StartSnapshotServerOpts {
  port: number;
  host: string;
  providers: SnapshotProviders;
  /**
   * 启动前端口探测超时（ms）。默认 500ms。
   * 探测期间如果端口被占，会尝试 fetch /internal/health 判断是否上一个实例残留。
   */
  probeTimeoutMs?: number;
  /**
   * P-CB-8: 服务器异常关闭时的回调。心跳可借此立即感知 server 崩溃，
   * 在下次心跳周期之前触发恢复，避免 5 分钟真空期。
   */
  onClose?: () => void;
}

/** 启动结果 */
export interface SnapshotServerHandle {
  /** 是否成功启动。false 表示端口被占或监听失败，调用方应降级处理。 */
  started: boolean;
  /** 停止函数（幂等，可多次调用）。即使 started=false 也可安全调用。 */
  stop: () => Promise<void>;
  /** 失败原因（started=false 时有值） */
  failureReason?: string;
}

/**
 * 探测端口是否被占。
 * - 若被占且响应 /internal/health 为 ok → 返回 'self-stale'（上一个自身实例残留）
 * - 若被占但不响应 health → 返回 'occupied-foreign'
 * - 若端口空闲（连接被拒绝）→ 返回 'free'
 */
async function probePort(host: string, port: number, timeoutMs: number): Promise<'free' | 'self-stale' | 'occupied-foreign'> {
  const url = `http://${host}:${port}/internal/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (resp.ok) {
      const body = await resp.json().catch(() => null);
      if (body && (body as any).ok === true) return 'self-stale';
    }
    return 'occupied-foreign';
  } catch {
    // 连接被拒绝 → 端口空闲
    return 'free';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 请求旧实例关闭（self-stale 场景）。
 * 发送 POST /internal/shutdown，等待旧实例退出后端口释放。
 */
async function shutdownStaleInstance(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const url = `http://${host}:${port}/internal/shutdown`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // v1.0.1-3: 发送 POST + shutdown token（与安全端点对齐）
    const headers: Record<string, string> = {};
    const token = process.env.SNAPSHOT_SHUTDOWN_TOKEN;
    if (token) headers['x-shutdown-token'] = token;
    const auth = process.env.DASHBOARD_AUTH;
    if (auth) headers['authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
    await fetch(url, { method: 'POST', headers, signal: controller.signal });
  } catch (e) {
    // 旧实例关闭后连接断开是正常的
    getGlobalLogger().debug('[dashboard-snapshot] shutdown stale instance request failed (expected)', { err: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
  // 等待端口释放（旧实例 close 需要一点时间）
  await new Promise((r) => setTimeout(r, 200));
  // 验证端口是否已释放
  const reprobe = await probePort(host, port, timeoutMs);
  return reprobe === 'free';
}

/**
 * 启动 dashboard 快照 HTTP 服务。
 *
 * 路由：
 * - GET /internal/snapshot → 聚合 JSON
 * - GET /internal/health   → { ok: true, ts }
 * - 其他 → 404
 *
 * 端口冲突处理：
 * - 启动前探测端口，若被占（自身残留或他进程）则放弃启动，返回 started:false
 * - listen 期间的 error 事件被捕获（EADDRINUSE / EACCES 等），不再作为 unhandled error 抛出
 *
 * @returns handle，含 started 标志与 stop 函数（幂等，可多次调用）
 */
export function startDashboardSnapshotServer(opts: StartSnapshotServerOpts): SnapshotServerHandle {
  const { port, host, providers, probeTimeoutMs = 500, onClose } = opts;

  // 标记是否真正启动（用于 stop 幂等）
  let server: Server | null = null;
  let closed = false;
  // P-CB-8: 区分主动关闭 vs 意外关闭。stop() 主动关闭时不触发 onClose，
  // 避免心跳误判为崩溃并触发不必要的重启。
  let closedIntentionally = false;

  // 用 Promise 包装 listen，但整体函数保持同步返回（调用方不需 await）
  // 启动失败通过 handle.started = false 体现
  const handle: SnapshotServerHandle = {
    started: false,
    stop: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        closedIntentionally = true;
        if (!server) {
          resolve();
          return;
        }
        // M-12: 未 listen 的 server 调 close 回调可能不触发，
        // 检查 server.listening 避免依赖兜底 setTimeout（节省 1s 延迟）
        if (!server.listening) {
          resolve();
          return;
        }
        // P-CB-8: 强制关闭所有连接（包括卡住的请求），确保端口立即释放。
        // 修复前：server.close() 是优雅关闭，等待所有连接结束。
        // requestTimeout=0 时卡住的请求永不超时，close() 回调永不触发，
        // 只靠 1s 兜底 timer 强行 resolve，server 实际仍占用端口。
        if (typeof (server as any).closeAllConnections === 'function') {
          try { (server as any).closeAllConnections(); } catch {}
        }
        let fallbackTimer: NodeJS.Timeout | undefined;
        server.close(() => {
          if (fallbackTimer) clearTimeout(fallbackTimer);
          resolve();
        });
        // 兜底：即使 close 回调未触发也 resolve
        fallbackTimer = setTimeout(() => resolve(), 1000);
      }),
  };

  // 异步执行：探测端口 → 启动 listen
  // 注意：这里不返回 Promise，调用方通过 handle.started 读取最终状态。
  // 探测+listen 在毫秒级完成，dashboard 第一次 fetch 通常晚于这个时间窗口。
  // 如果探测+listen 未完成时 dashboard 就 fetch，会被 catch 降级（fetchPluginSnapshot 已有 5s 超时 + null 降级）。
  (async () => {
    try {
      let probeResult = await probePort(host, port, probeTimeoutMs);
      if (probeResult === 'self-stale') {
        // 尝试让旧实例关闭，然后重试
        try {
          getGlobalLogger().info('[dashboard-snapshot] detected stale instance, sending shutdown request');
          const recovered = await shutdownStaleInstance(host, port, 1000);
          if (recovered) {
            probeResult = 'free';
          }
        } catch (e) {
          // shutdown 失败，继续走放弃启动逻辑
          getGlobalLogger().debug('[dashboard-snapshot] stale instance shutdown failed, giving up start', { err: e instanceof Error ? e.message : String(e) });
        }
      }
      if (probeResult !== 'free') {
        handle.failureReason = probeResult === 'self-stale'
          ? `port ${host}:${port} occupied by a stale previous instance of this plugin (likely killed without dispose). Snapshot server disabled.`
          : `port ${host}:${port} occupied by unknown process. Snapshot server disabled.`;
        // 不启动 server，started 保持 false
        return;
      }

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // 兜底：整个路由处理包一层 try/catch，任何同步抛错都不会让进程崩溃，
        // 而是返回 500（避免"跑一会就崩溃"）。
        try {
        const url = req.url ?? '';

        // v1.0.1-4: IP 白名单检查（最先执行）
        const remoteAddr = req.socket.remoteAddress;
        if (!isIpAllowed(remoteAddr)) {
          getGlobalLogger().warn('[dashboard-snapshot] IP rejected by whitelist', { ip: remoteAddr });
          sendForbidden(res);
          return;
        }

        // v1.2.0-4: 速率限制（在 IP 白名单之后、Auth 之前，按客户端 IP 限流）
        // /internal/health 豁免（用于存活探测和 stale instance 检测）
        if (url !== '/internal/health') {
          const clientIp = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() || remoteAddr || 'unknown';
          const rl = checkRateLimit(clientIp);
          if (!rl.allowed) {
            getGlobalLogger().warn('[dashboard-snapshot] rate limit exceeded', { ip: clientIp });
            sendTooManyRequests(res, rl.remaining, rl.resetIn);
            return;
          }
        }

        // v1.0.1-3: /internal/shutdown 改为 POST + token 验证（必须在 Auth 和方法检查之前）
        if (url === '/internal/shutdown') {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
            res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed: use POST' }));
            return;
          }
          // v1.0.1-3: token 验证 —— 防止未授权关闭
          const expectedToken = process.env.SNAPSHOT_SHUTDOWN_TOKEN;
          if (expectedToken) {
            const provided = req.headers['x-shutdown-token'] as string | undefined;
            if (provided !== expectedToken) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Invalid or missing shutdown token' }));
              return;
            }
          }
          // Basic Auth 仍然要求（若启用）
          if (!verifyBasicAuth(req)) {
            sendUnauthorized(res);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, shuttingDown: true }));
          // P-CB-8: 标记为主动关闭，防止 close 事件触发 onClose 回调，
          // 避免新实例启动后 probe 发现旧实例 → shutdown → onClose → 死循环。
          closedIntentionally = true;
          // 延迟关闭，确保响应已发送
          setTimeout(() => {
            try {
              server?.close();
              getGlobalLogger().info('[dashboard-snapshot] shutdown requested by new instance');
            } catch { /* ignore */ }
          }, 50);
          return;
        }

        // v1.0.1-1: Basic Auth（/internal/health 豁免，用于 stale instance 探测）
        if (url !== '/internal/health' && !verifyBasicAuth(req)) {
          sendUnauthorized(res);
          return;
        }

        // 能力档次控制端点（支持 GET 查看 + POST 设置）
        if (url === '/internal/capability-profile' || url.startsWith('/internal/capability-profile?')) {
          if (req.method === 'GET') {
            try {
              const { getCurrentProfile, listProfiles } = require('./capability-profiles.js');
              const current = getCurrentProfile();
              const profiles = listProfiles();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ current, profiles }));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: String(err) }));
            }
            return;
          }
          if (req.method === 'POST') {
            // 读取请求体
            let body = '';
            req.on('data', (chunk) => { body += chunk; if (body.length > 1024) req.destroy(); });
            req.on('end', () => {
              try {
                const { id } = JSON.parse(body);
                const { setCurrentProfile } = require('./capability-profiles.js');
                const profile = setCurrentProfile(id);
                getGlobalLogger().info(`[dashboard-snapshot] capability profile set to ${id}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, current: profile }));
              } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: String(err) }));
              }
            });
            return;
          }
        }

        // v1.2.0-5: 能力档次自动推荐（基于硬件资源）
        if (url === '/internal/capability-profile/recommend' || url.startsWith('/internal/capability-profile/recommend?')) {
          if (req.method === 'GET') {
            try {
              const { recommendProfileByHardware } = require('./capability-profiles.js');
              const recommendation = recommendProfileByHardware();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(recommendation));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: String(err) }));
            }
            return;
          }
        }

        // ===== MCP 工具调用端点（dashboard 转发写操作到此） =====
        // Dashboard server (packages/dashboard/server/lib/mcp.ts) 把前端 POST /api/mcp/invoke
        // 转发到此处。本端点直接调用 tools.ts 中已注册的工具 handler，无需经过 OpenClaw host。
        if (url === '/internal/mcp-invoke') {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
            res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed: use POST' }));
            return;
          }
          // 读取请求体
          let body = '';
          req.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
          req.on('end', () => {
            invokeMcpToolFromRegistry(body)
              .then((result) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
              })
              .catch((err) => {
                getGlobalLogger().warn('[dashboard-snapshot] /internal/mcp-invoke failed', { err: err instanceof Error ? err.message : String(err) });
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'invoke failed: ' + (err instanceof Error ? err.message : String(err)) }));
              });
          });
          return;
        }

        // 非 GET 请求（能力档次端点除外）拒绝
        if (req.method !== 'GET') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        if (url === '/internal/snapshot') {
          try {
            const snapshot = buildSnapshot(providers);
            const body = JSON.stringify(snapshot);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'snapshot build failed', message: String(err) }));
          }
          return;
        }

        if (url === '/internal/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ts: Date.now() }));
          return;
        }

        // v1.0.1-3: /internal/shutdown 已移至顶部（POST + token 验证）

        // N-4: Prometheus text exposition format endpoint
        // 暴露 healthMetrics + circuit breaker + retrieval 性能指标
        if (url === '/metrics') {
          try {
            const metrics = buildPrometheusMetrics(providers);
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
            res.end(metrics);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('# metrics build failed: ' + String(err));
          }
          return;
        }

        // N-4: G-5 图谱健康（优先 gm-pro getGraphHealth，降级到本地 GraphAdapter 状态）
        // 异步路由：使用 .then/.catch 链处理，不阻塞其他 GET 请求
        if (url === '/internal/graph-health') {
          resolveGraphHealth(providers)
            .then((graphHealth) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(graphHealth));
            })
            .catch((err) => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'unknown', error: String(err) }));
            });
          return;
        }

        // MoA 性能追踪端点
        if (url === '/internal/moa-performance') {
          try {
            const perf = getMoaPerformance();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, data: perf }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        // 兜底 catch：任何同步抛错都返回 500，绝不向上抛出导致进程崩溃
        } catch (err) {
          try {
            getGlobalLogger().warn?.('[dashboard-snapshot] request handler error', {
              url: req.url,
              err: err instanceof Error ? err.message : String(err),
            });
          } catch { /* ignore */ }
          if (!res.headersSent) {
            try { res.writeHead(500, { 'Content-Type': 'application/json' }); } catch { /* ignore */ }
          }
          try { res.end(JSON.stringify({ ok: false, error: 'internal handler error' })); } catch { /* ignore */ }
        }
      });

      // 关键：注册 error 事件，避免 EADDRINUSE 等作为 unhandled error 抛出
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (!handle.started) {
          // listen 阶段失败
          handle.failureReason = `listen error: ${err.code || err.name} ${err.message}`;
          handle.started = false;
          server = null;
        } else {
          // C-4: 运行时出错（如 ECONNRESET、socket 异常），上报 logger 不再静默
          // 不停止服务，下次请求可能仍能正常响应
          try {
            getGlobalLogger().warn('[dashboard-snapshot] server runtime error', {
              code: err.code,
              message: err.message,
            });
          } catch {
            // logger 自身不可用时降级 console.warn，避免静默
            // eslint-disable-next-line no-console
            console.warn('[dashboard-snapshot] runtime error:', err.code, err.message);
          }
        }
      });

      // P-CB-8: 监听 close 事件，区分主动关闭 vs 意外崩溃。
      // 修复前：onClose 参数被接受但从未调用，server 崩溃后心跳无法感知，
      // 只能等 5 分钟后的下一轮健康检查才能发现。
      server.on('close', () => {
        if (!closedIntentionally && onClose) {
          try {
            getGlobalLogger().warn('[dashboard-snapshot] server closed unexpectedly (crash or external kill)');
          } catch { /* ignore */ }
          // 标记 handle 为未启动，让心跳能检测到并触发恢复
          handle.started = false;
          handle.failureReason = 'server closed unexpectedly';
          // 异步调用 onClose，避免在 close 事件回调中阻塞
          setImmediate(() => {
            try { onClose(); } catch { /* callback 自身的异常不传播 */ }
          });
        }
      });

      // P-CB-8: 限制最大并发连接数，防止连接泄漏导致端口耗尽。
      // 长时间运行后，如果 dashboard 端未正确关闭连接（如 keep-alive 连接泄漏），
      // 累积的连接可能耗尽文件描述符，导致 server 无法接受新连接。
      // 👉 修复：原值 100 过低。本服务仅本机 IP 白名单 + 速率限制放行，
      // 且 /internal/mcp-invoke 可能执行耗时 30-60 分钟的蒸馏任务，长连接会长时间占用名额。
      // 100 个并发极易被长任务 + keep-alive 连接堆满，导致"运行一段时间后无法连接"。
      // 提高上限到 4096，并给每个 socket 加空闲超时，主动回收真正卡死的连接。
      server.maxConnections = 4096;

      // P-CB-8: 每个连接的 socket 级错误兜底。
      // 没有 socket.on('error') 监听时，底层 socket 抛错（如 ECONNRESET）会作为
      // uncaught exception 直接导致整个进程崩溃 —— 这正是"跑一会就崩溃无法连接"的高风险点。
      server.on('connection', (socket) => {
        socket.on('error', () => {
          // 连接级错误（对端异常断开等）属于正常现象，吞掉即可，避免进程崩溃
          try { socket.destroy(); } catch { /* ignore */ }
        });
      });

      // P-CB-8: 处理客户端错误（如格式错误的 HTTP 请求），防止这些异常
      // 导致 server 因 unhandled 'clientError' 事件而崩溃。
      // 👉 Node.js 关键行为：如果 'clientError' 没有 listener，进程直接退出！
      server.on('clientError', (err: Error, socket: any) => {
        try {
          getGlobalLogger().debug?.('[dashboard-snapshot] server client error', {
            message: err.message,
          });
        } catch { /* ignore */ }
        // 关闭有问题的 socket，释放资源
        try {
          if (socket && typeof socket.destroy === 'function') {
            socket.destroy();
          }
        } catch { /* ignore */ }
      });

      // 用 Promise 包装 listen，等监听成功后才标记 started = true
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server?.removeListener('error', onError);
          reject(err);
        };
        server!.once('error', onError);
        server!.listen(port, host, () => {
          server!.removeListener('error', onError);
          resolve();
        });
      });

      // BUGFIX: Node.js 18+ 的 http.Server 默认 requestTimeout=300000ms (5min)，
      // 但蒸馏 50 条经验（qwen3.6:27b 开思考模式）可能耗时 30-60 分钟，
      // 5min 超时会导致连接被服务器强制关闭。
      // 设置 requestTimeout=0（禁用）、headersTimeout 保持默认，
      // 让 MCP 调用超时由 dashboard server 端的 getTimeoutForTool() 统一控制。
      server!.requestTimeout = 0;
      server!.keepAliveTimeout = 120_000;  // 2min，长连接复用

      // listen 成功
      handle.started = true;
    } catch (err: any) {
      handle.started = false;
      handle.failureReason = handle.failureReason || `startup failed: ${err?.message || String(err)}`;
      // 清理 server 引用
      if (server) {
        try { server.close(); } catch {}
        server = null;
      }
    }
  })();

  return handle;
}
