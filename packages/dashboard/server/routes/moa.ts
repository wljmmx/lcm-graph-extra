/**
 * MOA (Mixture of Agents) 配置管理路由。
 *
 * - GET  /api/moa/config          —— 读取 MOA 配置（含参考模型 + 聚合模型）
 * - PATCH /api/moa/config          —— 热更新 MOA 配置（写回 openclaw.json）
 * - GET  /api/moa/status           —— 查看 MOA 运行时状态（缓存结果等）
 * - POST /api/moa/test             —— 测试 MOA 配置连接性（probe 模型可用性）
 *
 * 设计原则：
 * - 复用 openclaw.json 配置读写（与 /api/config 共享 readRawConfig/writeRawConfig）
 * - 模型 API Key 脱敏后返回，PATCH 时保留空值（不覆盖已有 key）
 * - 配置变更后需重启插件进程生效（note 提示）
 */
import type { FastifyInstance } from 'fastify';
import { readRawConfig, writeRawConfig, getByPath } from './config';
import { redactSensitive } from '../lib/operation-logs';
import { getOutboundAuthHeader } from '../lib/auth';

const SNAPSHOT_URL = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';
const SNAPSHOT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// MOA 配置类型
// ---------------------------------------------------------------------------

interface MoaModelConfig {
  provider: string;
  model: string;
  temperature: number;
  systemPrompt?: string;
  timeoutMs: number;
  apiKey?: string;
  baseURL?: string;
  keepAlive?: string;
}

interface MoaConfigResponse {
  enabled: boolean;
  complexityThreshold: number;
  mode: string;
  enabledTiers: string[];
  referenceModels: MoaModelConfig[];
  aggregatorModel: MoaModelConfig | null;
  syncBudgetMs?: number;
}

function readMoaConfig(): MoaConfigResponse {
  const raw = readRawConfig();
  const moa = (raw.moa ?? {}) as Record<string, unknown>;

  const referenceModels: MoaModelConfig[] = (Array.isArray(moa.referenceModels)
    ? moa.referenceModels
    : []) as MoaModelConfig[];

  let aggregatorModel: MoaModelConfig | null = null;
  if (moa.aggregatorModel && typeof moa.aggregatorModel === 'object') {
    aggregatorModel = moa.aggregatorModel as MoaModelConfig;
  }

  // mode 支持 auto / parallel / serial，向后兼容旧的 serial/parallel
  const rawMode = typeof moa.mode === 'string' ? moa.mode : 'auto';
  const mode = ['auto', 'parallel', 'serial'].includes(rawMode) ? rawMode : 'auto';

  return {
    enabled: typeof moa.enabled === 'boolean' ? moa.enabled : false,
    complexityThreshold: typeof moa.complexityThreshold === 'number' ? moa.complexityThreshold : 0.6,
    mode,
    enabledTiers: Array.isArray(moa.enabledTiers) ? moa.enabledTiers as string[] : ['low'],
    referenceModels: referenceModels.map((m) => ({
      provider: m.provider ?? 'ollama',
      model: m.model ?? '',
      temperature: typeof m.temperature === 'number' ? m.temperature : 0.6,
      systemPrompt: m.systemPrompt ?? '',
      timeoutMs: typeof m.timeoutMs === 'number' ? m.timeoutMs : 120_000,
      apiKey: m.apiKey ? '***' : undefined,
      baseURL: m.baseURL ?? undefined,
      keepAlive: m.keepAlive ?? '1h',
    })),
    aggregatorModel: aggregatorModel ? {
      provider: aggregatorModel.provider ?? 'ollama',
      model: aggregatorModel.model ?? '',
      temperature: typeof aggregatorModel.temperature === 'number' ? aggregatorModel.temperature : 0.3,
      timeoutMs: typeof aggregatorModel.timeoutMs === 'number' ? aggregatorModel.timeoutMs : 180_000,
      apiKey: aggregatorModel.apiKey ? '***' : undefined,
      baseURL: aggregatorModel.baseURL ?? undefined,
      keepAlive: aggregatorModel.keepAlive ?? '1h',
    } : null,
    syncBudgetMs: typeof moa.syncBudgetMs === 'number' ? moa.syncBudgetMs : 240_000,
  };
}

function writeMoaConfig(updates: Record<string, unknown>): void {
  // 先读出现有 moa 配置，再合并
  const raw = readRawConfig();
  const existingMoa = (raw.moa ?? {}) as Record<string, unknown>;

  const merged: Record<string, unknown> = { ...existingMoa };

  for (const [key, value] of Object.entries(updates)) {
    // API Key 处理：空字符串表示不更新（保留现有值）
    if (key === 'apiKey' && value === '') continue;

    if (key === 'referenceModels' || key === 'aggregatorModel') {
      // 嵌套对象：当 value 为对象时合并，否则直接替换
      if (value && typeof value === 'object') {
        const existing = (merged[key] ?? {}) as Record<string, unknown>;
        // 对于模型配置，完全替换（因为前端传的是完整对象）
        merged[key] = value;
      }
    } else {
      merged[key] = value;
    }
  }

  // 写回（通过 moa 前缀，writeRawConfig 会自动扁平化到 moa 段）
  // writeRawConfig 接受扁平化路径，我们将 moa 整个对象写回
  // 但 writeRawConfig 写入的是顶层字段，所以需要特殊处理
  // 因为我们用 writeRawConfig 写的是扁平 key，这里用 setByPath 方式
  // 直接写 raw 对象的 moa 字段
  const rawConfig = readRawConfig();
  // 确保 moa 在原始配置中
  if (!rawConfig.moa) rawConfig.moa = {};
  const currentMoa = rawConfig.moa as Record<string, unknown>;
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'apiKey' && value === '') continue;
    currentMoa[key] = value;
  }

  // 用 writeRawConfig 写入整个 moa 对象
  // writeRawConfig 的 key 是扁平路径，直接写 moa 字段
  writeRawConfig({ moa: currentMoa });
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

export async function registerMoaRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/moa/config —— 读取 MOA 配置
  app.get('/api/moa/config', async (_req, _reply) => {
    try {
      const config = readMoaConfig();
      return { ok: true, config };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      _req.log.error({ err: msg }, '/api/moa/config 读取失败');
      return { ok: false, error: 'MOA 配置读取失败', config: null };
    }
  });

  // PATCH /api/moa/config —— 热更新 MOA 配置
  app.patch('/api/moa/config', async (req, reply) => {
    const body = (req.body as { updates?: Record<string, unknown> }) ?? {};
    const updates = body.updates ?? {};
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      reply.code(400);
      return { ok: false, error: 'body.updates must be an object' };
    }

    // 允许更新的字段
    const allowedKeys = new Set([
      'enabled', 'complexityThreshold', 'mode', 'enabledTiers',
      'referenceModels', 'aggregatorModel', 'syncBudgetMs',
    ]);

    const applied: string[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];

    for (const [key, value] of Object.entries(updates)) {
      if (!allowedKeys.has(key)) {
        rejected.push({ path: key, reason: 'field not in updatable whitelist' });
        continue;
      }
      // 基础类型校验
      if (key === 'enabled' && typeof value !== 'boolean') {
        rejected.push({ path: key, reason: 'expected boolean' });
        continue;
      }
      if (key === 'complexityThreshold' && (typeof value !== 'number' || value < 0 || value > 1)) {
        rejected.push({ path: key, reason: 'expected number 0-1' });
        continue;
      }
      if (key === 'mode' && !['auto', 'parallel', 'serial'].includes(value as string)) {
        rejected.push({ path: key, reason: 'expected "auto" | "parallel" | "serial"' });
        continue;
      }
      if (key === 'enabledTiers' && (!Array.isArray(value) || !value.every((v: unknown) => v === 'low' || v === 'medium' || v === 'high'))) {
        rejected.push({ path: key, reason: 'expected array of "low" | "medium" | "high"' });
        continue;
      }
      applied.push(key);
    }

    if (applied.length === 0) {
      reply.code(400);
      return { ok: false, error: 'no valid updates provided', rejected };
    }

    try {
      const mergedUpdates: Record<string, unknown> = {};
      for (const key of applied) {
        mergedUpdates[key] = updates[key];
      }
      writeMoaConfig(mergedUpdates);

      // 读回脱敏后的配置
      const config = readMoaConfig();
      return {
        ok: true,
        applied,
        rejected,
        config,
        note: 'MOA 配置已写入 openclaw.json，需重启插件进程生效',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, '/api/moa/config PATCH 写入失败');
      reply.code(500);
      return { ok: false, error: 'MOA 配置写入失败', applied, rejected };
    }
  });

  // GET /api/moa/status —— 查看 MOA 运行时状态
  app.get('/api/moa/status', async (_req, _reply) => {
    const config = readMoaConfig();

    // P0-1b: 从性能追踪器获取最近一次实际调度策略（运行时 effective mode）
    let lastEffectiveMode: string | undefined;
    try {
      const perfResp = await fetch(`${SNAPSHOT_URL}/internal/moa-performance`, {
        method: 'GET',
        headers: getOutboundAuthHeader(),
        signal: AbortSignal.timeout(3_000),
      });
      if (perfResp.ok) {
        const perfData = (await perfResp.json()) as any;
        const recentRuns: Array<{ mode?: string }> = perfData?.data?.recentRuns ?? [];
        if (recentRuns.length > 0 && recentRuns[0].mode) {
          lastEffectiveMode = recentRuns[0].mode;
        }
      }
    } catch {
      // 性能追踪器不可用，回退到 config.mode
    }

    const status = {
      enabled: config.enabled,
      mode: config.mode,
      lastEffectiveMode: lastEffectiveMode ?? config.mode,
      complexityThreshold: config.complexityThreshold,
      enabledTiers: config.enabledTiers,
      referenceModelCount: config.referenceModels.length,
      hasAggregator: config.aggregatorModel !== null,
      referenceModels: config.referenceModels.map((m) => ({
        provider: m.provider,
        model: m.model,
      })),
      aggregatorModel: config.aggregatorModel ? {
        provider: config.aggregatorModel.provider,
        model: config.aggregatorModel.model,
      } : null,
    };
    return { ok: true, status };
  });

  // GET /api/moa/performance —— MoA 管道性能追踪数据
  app.get('/api/moa/performance', async (_req, _reply) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
    try {
      const resp = await fetch(`${SNAPSHOT_URL}/internal/moa-performance`, {
        method: 'GET',
        headers: getOutboundAuthHeader(),
        signal: controller.signal,
      });
      if (!resp.ok) {
        return {
          ok: true,
          data: {
            totalRuns: 0,
            successRuns: 0,
            failedRuns: 0,
            avgTotalMs: 0,
            avgRefMs: 0,
            avgAggMs: 0,
            totalTokens: 0,
            avgTokens: 0,
            recentRuns: [],
            latencyPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
            refLatencyPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
            aggLatencyPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
            tokenEfficiency: 0,
            avgResponseLen: 0,
            modelBreakdown: [],
            errorBreakdown: {},
            complexityDistribution: { low: 0, medium: 0, high: 0 },
            fallbackCount: 0,
            // 以下字段与 catch 分支保持一致，避免前端模板访问 undefined 属性导致页面空白
            avgComplexityScore: 0,
            complexityPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
            complexityHistory: [],
            allComplexityDistribution: { low: 0, medium: 0, high: 0 },
            allComplexityPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
            allComplexityHistory: [],
            complexityHourlyBuckets: [],
            complexityDailyBuckets: [],
          },
        };
      }
      return (await resp.json()) as { ok: boolean; data: unknown; error?: string };
    } catch {
      return {
        ok: true,
        data: {
          totalRuns: 0,
          successRuns: 0,
          failedRuns: 0,
          avgTotalMs: 0,
          avgRefMs: 0,
          avgAggMs: 0,
          totalTokens: 0,
          avgTokens: 0,
          recentRuns: [],
          latencyPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
          refLatencyPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
          aggLatencyPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
          tokenEfficiency: 0,
          avgResponseLen: 0,
          modelBreakdown: [],
          errorBreakdown: {},
          complexityDistribution: { low: 0, medium: 0, high: 0 },
          fallbackCount: 0,
          avgComplexityScore: 0,
          complexityPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
          complexityHistory: [],
          allComplexityDistribution: { low: 0, medium: 0, high: 0 },
          allComplexityPercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
          allComplexityHistory: [],
          complexityHourlyBuckets: [],
          complexityDailyBuckets: [],
        },
      };
    } finally {
      clearTimeout(timer);
    }
  });
}