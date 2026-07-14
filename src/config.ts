import { Type, Static } from 'typebox';
import { Value } from 'typebox/value';
import { resolve } from 'path';
import { getGlobalLogger } from './utils/logger.js';

export const BackupConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  retentionDays: Type.Number({ default: 30 }),
  maxBackups: Type.Number({ default: 10 }),
  intervalHours: Type.Number({ default: 24 }),
  backupDir: Type.Optional(Type.String()),
});

export const ExperienceTriggerSchema = Type.Union([
  Type.Literal('correction'),
  Type.Literal('failure'),
  Type.Literal('fix_success'),
  Type.Literal('explicit_save'),
]);

export const ExperienceConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  triggers: Type.Array(ExperienceTriggerSchema, { default: ['correction', 'failure', 'fix_success', 'explicit_save'] }),
  summaryMode: Type.Union([Type.Literal('async'), Type.Literal('sync')], { default: 'async' }),
  schedule: Type.Optional(Type.Object({
    dreaming: Type.String({ default: '0 3 * * *' }),
    incremental: Type.String({ default: '0 */12 * * *' }),
  })),
  relevanceThreshold: Type.Number({ default: 0.6 }),
});

export const CompactionConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  mode: Type.Optional(Type.String()),
  triggerThreshold: Type.Number({ default: 20_000 }),
  softThresholdTokens: Type.Number({ default: 163_840 }),
  keepRecentTokens: Type.Number({ default: 131_072 }),
});

export const PluginConfigSchema = Type.Object({
  summaryStrategy: Type.Union([Type.Literal('strategy'), Type.Literal('hybrid'), Type.Literal('full')], { default: 'strategy' }),
  maxGraphDepth: Type.Number({ default: 10, minimum: 1 }),
  maxNodeCount: Type.Number({ default: 5000, minimum: 1 }),
  enableCrossFileLinkage: Type.Boolean({ default: true }),
  crossReferenceRetentionDays: Type.Number({ default: 90, minimum: 1, multipleOf: 1 }),
  maxTokens: Type.Number({ default: 65_536, minimum: 1 }),
  budgetRatio: Type.Number({ default: 0.3, minimum: 0, maximum: 1 }),

  compaction: Type.Optional(CompactionConfigSchema),

  experience: Type.Optional(ExperienceConfigSchema),

  backupConfig: Type.Optional(BackupConfigSchema),

  ttl: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: true }),
    retentionDays: Type.Number({ default: 90, minimum: 1 }),
    cleanupIntervalHours: Type.Number({ default: 24, minimum: 1 }),
  })),

  logging: Type.Optional(Type.Object({
    level: Type.Union([
      Type.Literal('silent'),
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
    ], { default: 'info' }),
    file: Type.Optional(Type.String()),
  })),

  webhook: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: false }),
    url: Type.Optional(Type.String()),
    events: Type.Array(Type.Union([
      Type.Literal('dag_update'),
      Type.Literal('compaction'),
      Type.Literal('backup'),
      Type.Literal('error'),
    ]), { default: [] }),
  })),


  llmProvider: Type.Optional(Type.Object({
    provider: Type.Union([
      Type.Literal('openclaw_hooks'),
      Type.Literal('openai'),
      Type.Literal('ollama'),
      Type.Literal('custom'),
    ], { default: 'openclaw_hooks' }),
    model: Type.String({ default: 'default' }),
    maxTokens: Type.Number({ default: 4096, minimum: 1 }),
  })),

  cliTimeout: Type.Number({ default: 30_000 }),
  cliFallbackSearchType: Type.Union([Type.Literal('search'), Type.Literal('query')], { default: 'search' }),

  distillationIntervalMs: Type.Number({ default: 2 * 60 * 60 * 1000 }),

  tripletTimeoutMs: Type.Number({ default: 60_000 }),

  // v2.2.3: LLM 调用超时集中可配置（针对本地大模型调优，原散落 DEFAULTS 不可覆盖）
  // 注意：keepAlive 是 Ollama 模型内存驻留时间，不是请求超时，两者无关。
  llmTimeouts: Type.Optional(Type.Object({
    rerankTimeoutMs: Type.Optional(Type.Number({ default: 30_000, minimum: 1_000 })),
    judgeTimeoutMs: Type.Optional(Type.Number({ default: 60_000, minimum: 1_000 })),
    validateTimeoutMs: Type.Optional(Type.Number({ default: 45_000, minimum: 1_000 })),
    summarizeTimeoutMs: Type.Optional(Type.Number({ default: 90_000, minimum: 1_000 })),
    embedTimeoutMs: Type.Optional(Type.Number({ default: 60_000, minimum: 1_000 })),
    graphLlmTimeoutMs: Type.Optional(Type.Number({ default: 90_000, minimum: 1_000 })),
    cascadeTier2Ms: Type.Optional(Type.Number({ default: 60_000, minimum: 1_000 })),
    cascadeTier3Ms: Type.Optional(Type.Number({ default: 90_000, minimum: 1_000 })),
    distillMs: Type.Optional(Type.Number({ default: 120_000, minimum: 1_000 })),
  })),

  // M-10: experienceTtlIntervalMs 需在 schema 中声明，否则用户无法通过 openclaw.json 配置
  // （heartbeat 中用 api.pluginConfig?.experienceTtlIntervalMs 读取，缺失则 fallback 24h）
  experienceTtlIntervalMs: Type.Number({ default: 24 * 60 * 60 * 1000, minimum: 60_000 }),

  distillationLlm: Type.Optional(Type.Object({
    provider: Type.Union([
      Type.Literal('openclaw_hooks'),
      Type.Literal('openai'),
      Type.Literal('ollama'),
      Type.Literal('custom'),
    ], { default: 'openclaw_hooks' }),
    model: Type.String({ default: 'ollama/qwen3.6:27b' }),
    apiKey: Type.Optional(Type.String()),
    baseURL: Type.Optional(Type.String()),
    keepAlive: Type.Optional(Type.String({ default: '1h' })),
  })),

  // Dashboard 快照服务配置（仅本机 dashboard 读取内存态用）
  // 端口规划：dashboard 后端 :7421 / 前端 dev :7422 / 插件 snapshot :7423
  dashboardSnapshot: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: true }),
    host: Type.String({ default: '127.0.0.1' }),
    port: Type.Number({ default: 7423, minimum: 1, maximum: 65535 }),
  })),

  // MoA (Mixture of Agents) 多模型分层协作配置
  moa: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: false }),
    complexityThreshold: Type.Number({ default: 0.6, minimum: 0, maximum: 1 }),
    mode: Type.Union([Type.Literal('parallel'), Type.Literal('serial')], { default: 'serial' }),
    referenceModels: Type.Array(Type.Object({
      provider: Type.Union([
        Type.Literal('openai'),
        Type.Literal('ollama'),
        Type.Literal('deepseek'),
        Type.Literal('custom'),
        Type.Literal('openclaw_hooks'),
      ], { default: 'ollama' }),
      model: Type.String({ default: 'qwen3.6:27b' }),
      temperature: Type.Number({ default: 0.6, minimum: 0, maximum: 2 }),
      systemPrompt: Type.String({ default: '' }),
      timeoutMs: Type.Number({ default: 120_000, minimum: 1_000 }),
      apiKey: Type.Optional(Type.String()),
      baseURL: Type.Optional(Type.String()),
      keepAlive: Type.Optional(Type.String({ default: '1h' })),
    }), { default: [] }),
    aggregatorModel: Type.Optional(Type.Object({
      provider: Type.Union([
        Type.Literal('openai'),
        Type.Literal('ollama'),
        Type.Literal('deepseek'),
        Type.Literal('custom'),
        Type.Literal('openclaw_hooks'),
      ], { default: 'ollama' }),
      model: Type.String({ default: 'qwen3.6:27b' }),
      temperature: Type.Number({ default: 0.3, minimum: 0, maximum: 2 }),
      systemPrompt: Type.Optional(Type.String({ default: '' })),
      timeoutMs: Type.Number({ default: 180_000, minimum: 1_000 }),
      apiKey: Type.Optional(Type.String()),
      baseURL: Type.Optional(Type.String()),
      keepAlive: Type.Optional(Type.String({ default: '1h' })),
    })),
    enabledTiers: Type.Array(
      Type.Union([Type.Literal('low'), Type.Literal('medium')]),
      { default: ['low'] },
    ),
  })),

  embedding: Type.Optional(Type.Object({
    apiKey: Type.Optional(Type.String()),
    baseURL: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    dimensions: Type.Optional(Type.Number()),
    keepAlive: Type.Optional(Type.String()),
  })),

  neo4j: Type.Optional(Type.Object({
    uri: Type.String({ default: 'bolt://localhost:7687' }),
    user: Type.String({ default: 'neo4j' }),
    password: Type.String({ default: '' }),
  })),

  retrieval: Type.Optional(Type.Object({
    qmd: Type.Optional(Type.Object({
      mcpEndpoint: Type.Optional(Type.String()),
    })),
    limits: Type.Optional(Type.Object({
      qmd: Type.Number({ default: 5, minimum: 1 }),
      graph: Type.Number({ default: 5, minimum: 1 }),
      exp: Type.Number({ default: 3, minimum: 0 }),
    })),
    graph: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: true }),
      searchLimit: Type.Number({ default: 5, minimum: 1 }),
    })),
  })),

  lcmMonitor: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: true }),
    contextWindow: Type.Number({ default: 262_144, minimum: 1 }),
    dedupRounds: Type.Number({ default: 24, minimum: 1 }),
    highPressureThreshold: Type.Number({ default: 0.85, minimum: 0, maximum: 1 }),
    mediumPressureThreshold: Type.Number({ default: 0.70, minimum: 0, maximum: 1 }),
    proactiveThreshold: Type.Number({ default: 0.65, minimum: 0, maximum: 1 }),
    systemPromptOverheadTokens: Type.Number({ default: 17_000, minimum: 0 }),
    compactTokenBudget: Type.Number({ default: 114_688, minimum: 0 }),
    compactTimeout: Type.Number({ default: 60_000, minimum: 0 }),
    maxSummaryTokenRatio: Type.Number({ default: 0.45, minimum: 0, maximum: 1 }),
    retrievalLimits: Type.Optional(Type.Object({
      low: Type.Object({
        qmd: Type.Number({ default: 5, minimum: 1 }),
        graph: Type.Number({ default: 5, minimum: 1 }),
        exp: Type.Number({ default: 3, minimum: 0 }),
      }),
      medium: Type.Object({
        qmd: Type.Number({ default: 3, minimum: 1 }),
        graph: Type.Number({ default: 3, minimum: 1 }),
        exp: Type.Number({ default: 1, minimum: 0 }),
      }),
      high: Type.Object({
        qmd: Type.Number({ default: 1, minimum: 1 }),
        graph: Type.Number({ default: 1, minimum: 1 }),
        exp: Type.Number({ default: 0, minimum: 0 }),
      }),
    })),
    maxContextChars: Type.Optional(Type.Object({
      low: Type.Number({ default: 12_000, minimum: 0 }),
      medium: Type.Number({ default: 6_000, minimum: 0 }),
      high: Type.Number({ default: 1_600, minimum: 0 }),
    })),
  })),
});

export type PluginConfig = Static<typeof PluginConfigSchema>;
export type ExperienceTrigger = Static<typeof ExperienceTriggerSchema>;
export type WindowMonitorConfig = Static<typeof WindowMonitorConfigSchema>;

export const WindowMonitorConfigSchema = PluginConfigSchema.properties.lcmMonitor;

export interface RetrievalLimits {
  qmd: number; graph: number; exp: number;
}

export interface ContextCharLimits {
  low: number; medium: number; high: number;
}

export interface ResolvedWindowConfig {
  contextWindow: number;
  compactTokenBudget: number;
  retrievalLimits: RetrievalLimits;
  maxContextChars: ContextCharLimits;
  tokenRatio: number;
  tier: string;
  shouldCompact: boolean;
}

export function defaultRetrievalLimits(scale: number): RetrievalLimits {
  const s = Math.max(0.2, Math.min(8, scale));
  return {
    qmd: Math.max(1, Math.round(5 * s)),
    graph: Math.max(1, Math.round(5 * s)),
    exp: Math.max(0, Math.round(3 * s)),
  };
}

export function defaultMaxContextChars(scale: number): ContextCharLimits {
  const s = Math.max(0.2, Math.min(8, scale));
  return {
    low: Math.round(12000 * s),
    medium: Math.round(6000 * s),
    high: Math.round(1600 * s),
  };
}

export const COMPACT_RATIO = 0.44;

export function resolveContextProfile(
  providerModelCtx?: number,
  wm?: WindowMonitorConfig,
): Pick<ResolvedWindowConfig, 'contextWindow' | 'compactTokenBudget' | 'retrievalLimits' | 'maxContextChars'> {
  const ctxWindow = providerModelCtx ?? wm?.contextWindow ?? 262_144;
  const base = 262_144;
  const scale = ctxWindow / base;

  const adaptiveLimits = defaultRetrievalLimits(scale);
  const adaptiveChars = defaultMaxContextChars(scale);

  // P0-2 BUG-1: 修复 ?? 链失效死代码。
  // 原代码 `Math.round(...) ?? wm?.x` 中 Math.round 永远返回 number，导致用户在
  // lcmMonitor 中显式配置的 compactTokenBudget / retrievalLimits / maxContextChars 全部被忽略。
  // 修复策略：用户显式配置优先 → 自适应默认 → 兜底常量。
  return {
    contextWindow: ctxWindow,
    compactTokenBudget: wm?.compactTokenBudget ?? Math.round(ctxWindow * COMPACT_RATIO),
    retrievalLimits: {
      qmd: wm?.retrievalLimits?.low?.qmd ?? adaptiveLimits.qmd,
      graph: wm?.retrievalLimits?.low?.graph ?? adaptiveLimits.graph,
      exp: wm?.retrievalLimits?.low?.exp ?? adaptiveLimits.exp,
    },
    maxContextChars: {
      low: wm?.maxContextChars?.low ?? adaptiveChars.low,
      medium: wm?.maxContextChars?.medium ?? adaptiveChars.medium,
      high: wm?.maxContextChars?.high ?? adaptiveChars.high,
    },
  };
}

export function getDefaultConfigPath(): string {
  return resolve(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'openclaw.json');
}

export const DEFAULT_CONFIG: PluginConfig = {
  summaryStrategy: 'strategy',
  maxGraphDepth: 10,
  maxNodeCount: 5000,
  enableCrossFileLinkage: true,
  crossReferenceRetentionDays: 90,
  maxTokens: 65_536,
  budgetRatio: 0.3,
  experience: { enabled: true, triggers: ['correction', 'failure', 'fix_success', 'explicit_save'], summaryMode: 'async', relevanceThreshold: 0.6 },
  cliTimeout: 30_000,
  cliFallbackSearchType: 'search',
  distillationIntervalMs: 2 * 60 * 60 * 1000,
  tripletTimeoutMs: 60_000,
  experienceTtlIntervalMs: 24 * 60 * 60 * 1000,
};

export function validateConfig(input: unknown): PluginConfig {
  const withDefaults = Value.Default(PluginConfigSchema, input);
  const config = withDefaults as PluginConfig;

  if (!config.compaction) config.compaction = { enabled: true, triggerThreshold: 20_000, softThresholdTokens: 163_840, keepRecentTokens: 131_072 };
  if (!config.backupConfig) config.backupConfig = { enabled: true, retentionDays: 30, maxBackups: 10, intervalHours: 24 };
  if (!config.ttl) config.ttl = { enabled: true, retentionDays: 90, cleanupIntervalHours: 24 };
  if (!config.webhook) config.webhook = { enabled: false, events: [] };
  if (!config.dashboardSnapshot) config.dashboardSnapshot = { enabled: true, port: 7423, host: '127.0.0.1' };
  if (!config.llmProvider) config.llmProvider = { provider: 'openclaw_hooks', model: 'default', maxTokens: 4096 };
  if (!config.embedding) config.embedding = {};
  if (!config.experience) config.experience = { enabled: true, triggers: ['correction', 'failure', 'fix_success', 'explicit_save'], summaryMode: 'async', relevanceThreshold: 0.6 };
  if (!config.logging) config.logging = { level: 'info' };
  if (!config.retrieval) config.retrieval = {};
  if (!config.retrieval?.limits) config.retrieval.limits = { qmd: 5, graph: 5, exp: 3 };
  if (!config.retrieval?.graph) config.retrieval.graph = { enabled: true, searchLimit: 5 };
  if (!config.lcmMonitor) config.lcmMonitor = {
    enabled: true, contextWindow: 262_144, dedupRounds: 24,
    highPressureThreshold: 0.85, mediumPressureThreshold: 0.70,
    proactiveThreshold: 0.65, systemPromptOverheadTokens: 17_000,
    compactTokenBudget: 114_688, compactTimeout: 60_000, maxSummaryTokenRatio: 0.45
  };
  if (!config.distillationLlm) config.distillationLlm = { provider: 'openclaw_hooks', model: 'ollama/qwen3.6:27b' };
  if (!config.neo4j) config.neo4j = { uri: 'bolt://localhost:7687', user: 'neo4j', password: '' };
  if (!config.moa) config.moa = { enabled: false, complexityThreshold: 0.6, mode: 'serial', referenceModels: [], aggregatorModel: undefined, enabledTiers: ['low'] };

  const result = Value.Errors(PluginConfigSchema, config);

  if (config.webhook?.url && !isValidUrl(config.webhook.url)) {
    result.push({ instancePath: '/webhook/url', message: 'must be a valid URL', keyword: 'format', params: {}, schemaPath: '#/properties/webhook/properties/url' } as any);
  }

  if (result.length > 0) {
    const errorMessages = result.map((e: { instancePath: string; message: string }) => `${e.instancePath}: ${e.message}`).join('; ');
    throw new Error(`Invalid plugin config: ${errorMessages}`);
  }
  return config;
}

// SEC-3: webhook URL 仅允许 http/https scheme，防止 SSRF（file://、data:、gopher: 等）
const ALLOWED_WEBHOOK_PROTOCOLS = new Set(['http:', 'https:']);

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_WEBHOOK_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * 深拷贝 DEFAULT_CONFIG。P3-4: 原先使用 `{ ...DEFAULT_CONFIG }` 浅拷贝，
 * 导致嵌套对象（如 experience）与 DEFAULT_CONFIG 共享引用，
 * 调用方修改返回值会污染全局默认配置。改用 structuredClone 彻底隔离。
 */
function cloneDefaultConfig(): PluginConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export async function loadConfig(filePath?: string): Promise<PluginConfig> {
  if (!filePath) return cloneDefaultConfig();
  const fs = await import('fs/promises');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return validateConfig(parsed);
  } catch (err) {
    // P3-4: 原先静默吞错，现记录告警便于排查配置加载失败
    getGlobalLogger().warn('[lcm-graph-extra] loadConfig failed, falling back to DEFAULT_CONFIG', {
      filePath,
      err: String(err),
    });
    return cloneDefaultConfig();
  }
}

export function isConfigValid(config: unknown): boolean {
  try {
    validateConfig(config);
    return true;
  } catch {
    return false;
  }
}