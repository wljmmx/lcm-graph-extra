import { z } from 'zod';

// --- Backup 配置 ---
export const BackupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  retentionDays: z.number().int().positive().default(30),
  maxBackups: z.number().int().positive().default(10),
  intervalHours: z.number().positive().default(24),
  backupDir: z.string().optional(),
});

/** 经验提取触发场景 */
export const ExperienceTriggerSchema = z.enum([
  'correction', 'failure', 'fix_success', 'explicit_save',
]);

/** 经验提取/总结配置 */
export const ExperienceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  triggers: z.array(ExperienceTriggerSchema).default([
    'correction', 'failure', 'fix_success', 'explicit_save',
  ]),
  summaryMode: z.enum(['async', 'sync']).default('async'),
  schedule: z.object({
    dreaming: z.string().default('0 3 * * *'),
    incremental: z.string().default('0 */12 * * *'),
  }).optional(),
  relevanceThreshold: z.number().min(0).max(1).default(0.6),
});

/** CE compaction 配置 — 兼容旧版字段 + 新增 mode */
export const CompactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.string().optional(),  // delegated-to-lossless-claw | self-managed
  // 256K上下文适配（翻倍）
  triggerThreshold: z.number().int().positive().default(20_000),
  softThresholdTokens: z.number().int().positive().default(163_840),
  keepRecentTokens: z.number().int().positive().default(131_072),
}).passthrough();

export const PluginConfigSchema = z.object({
  // Summary strategy
  summaryStrategy: z.enum(['strategy', 'hybrid', 'full']).default('strategy'),
  maxGraphDepth: z.number().int().positive().default(10),
  maxNodeCount: z.number().int().positive().default(5000),
  enableCrossFileLinkage: z.boolean().default(true),
  crossReferenceRetentionDays: z.number().int().positive().default(90),
  // 256K上下文适配（翻倍）
  maxTokens: z.number().int().positive().default(65_536),
  budgetRatio: z.number().min(0).max(1).default(0.3),

  // Compaction — 可选，兼容旧版字段
  compaction: CompactionConfigSchema.optional(),

  // 经验提取/总结（Layer 4）— 始终有默认值
  experience: ExperienceConfigSchema.default({ enabled: true }),

  // Backup — 可选
  backupConfig: BackupConfigSchema.optional(),

  // TTL — 可选
  ttl: z.object({
    enabled: z.boolean().default(true),
    retentionDays: z.number().int().positive().default(90),
    cleanupIntervalHours: z.number().positive().default(24),
  }).optional(),

  // Logging — 可选
  logging: z.object({
    level: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    file: z.string().optional(),
  }).optional(),

  // Webhook — 可选
  webhook: z.object({
    enabled: z.boolean().default(false),
    url: z.string().url().optional(),
    events: z.array(z.enum(['dag_update', 'compaction', 'backup', 'error'])).default([]),
  }).optional(),

  // LLM Provider — 可选
  llmProvider: z.object({
    provider: z.enum(['openclaw_hooks', 'openai', 'ollama', 'custom']).default('openclaw_hooks'),
    model: z.string().default('default'),
    maxTokens: z.number().int().positive().default(4096),
  }).optional(),

  // CLI fallback (QmdClient) — 可选
  cliTimeout: z.number().int().positive().default(30_000),
  cliFallbackSearchType: z.enum(['search', 'query']).default('search'),

  // Distillation schedule — controls how often PENDING experiences are distilled (seconds)
  distillationIntervalMs: z.number().int().positive().default(2 * 60 * 60 * 1000),

  // Triplet extraction timeout (milliseconds, default 8s)
  tripletTimeoutMs: z.number().int().positive().default(8000),


  // Distillation LLM — use OpenClaw hooks proxy by default
  distillationLlm: z.object({
    provider: z.enum(['openclaw_hooks', 'openai', 'ollama', 'custom']).default('openclaw_hooks'),
    model: z.string().default('ollama/qwen3.6:27b'),
  }).optional(),

  // Embedding config for GraphAdapter
  embedding: z.object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    model: z.string().optional(),
    dimensions: z.number().optional(),
    keepAlive: z.string().optional(),
  }).optional(),}).passthrough();

export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type ExperienceTrigger = z.infer<typeof ExperienceTriggerSchema>;

// --- Default Config ---

/** Window Monitor configuration schema (v2.1.5 - 256K context) */
export const WindowMonitorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // 256K上下文适配
  contextWindow: z.number().default(262_144),
  dedupRounds: z.number().default(24),
  highPressureThreshold: z.number().default(0.85),
  mediumPressureThreshold: z.number().default(0.70),
  proactiveThreshold: z.number().default(0.65),
  // System prompt overhead: SOUL.md, USER.md, AGENTS.md, MEMORY.md, system instructions
  systemPromptOverheadTokens: z.number().int().default(17_000),
  // 256K上下文适配（翻倍）
  compactTokenBudget: z.number().default(114_688),
  // High-pressure emergency compaction settings
  compactTimeout: z.number().default(60_000),
  maxSummaryTokenRatio: z.number().default(0.45),
  retrievalLimits: z.object({
    low: z.object({ qmd: z.number().int().default(5), graph: z.number().int().default(5), exp: z.number().int().default(3) }),
    medium: z.object({ qmd: z.number().int().default(3), graph: z.number().int().default(3), exp: z.number().int().default(1) }),
    high: z.object({ qmd: z.number().int().default(1), graph: z.number().int().default(1), exp: z.number().int().default(0) }),
  }).optional(),
  // 256K上下文适配（翻倍）
  maxContextChars: z.object({
    low: z.number().int().default(12_000),
    medium: z.number().int().default(6_000),
    high: z.number().int().default(1_600),
  }).optional(),
});

/**
 * Resolve context window configuration from provider model definition, user config, or defaults.
 *
 * Priority:
 *   1. providerModelContext — openclaw.json provider model definition
 *   2. wm (user-configured WindowMonitorConfig)
 *   3. default (262_144 = 256K)
 */
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

export const COMPACT_RATIO = 0.44; // compaction retains ~44% of context window

/**
 * Resolve effective window/retrieval config for the current model.
 *
 * @param providerModelCtx - contextWindow from openclaw.json provider model definition
 * @param wm - optional user-configured WindowMonitorConfig from plugin config
 * @returns resolved window config with all parameters scaled proportionally
 */
export function resolveContextProfile(
  providerModelCtx?: number,
  wm?: z.infer<typeof WindowMonitorConfigSchema>,
): Pick<ResolvedWindowConfig, 'contextWindow' | 'compactTokenBudget' | 'retrievalLimits' | 'maxContextChars'> {
  // Priority: provider model config > user wm config > fallback 256K
  const ctxWindow = providerModelCtx ?? wm?.contextWindow ?? 262_144;
  const base = 262_144;
  const scale = ctxWindow / base;
  
  // Level 1: Adaptive values computed from model's context window (primary)
  const adaptiveLimits = defaultRetrievalLimits(scale);
  const adaptiveChars = defaultMaxContextChars(scale);

  // Level 2: User config as fallback if provided
  // Level 3: Hardcoded 256K defaults as last resort (兜底)
  return {
    contextWindow: ctxWindow,
    compactTokenBudget: Math.round(ctxWindow * COMPACT_RATIO)
      ?? wm?.compactTokenBudget
        ?? 114_688,
    retrievalLimits: {
      qmd: adaptiveLimits.qmd
        ?? wm?.retrievalLimits?.low?.qmd
          ?? 5,
      graph: adaptiveLimits.graph
        ?? wm?.retrievalLimits?.low?.graph
          ?? 5,
      exp: adaptiveLimits.exp
        ?? wm?.retrievalLimits?.low?.exp
          ?? 3,
    },
    maxContextChars: {
      low: adaptiveChars.low
        ?? wm?.maxContextChars?.low
          ?? 12_000,
      medium: adaptiveChars.medium
        ?? wm?.maxContextChars?.medium
          ?? 6_000,
      high: adaptiveChars.high
        ?? wm?.maxContextChars?.high
          ?? 1_600,
    },
  };
}

/**
 * Get the default config file path to openclaw.json.
 * Uses os.homedir() instead of requiring os module at ESM import scope.
 */
export function getDefaultConfigPath(): string {
  return process.env.HOME || process.env.USERPROFILE || "/home/wljmmx" + "/.openclaw/openclaw.json";
}
export const DEFAULT_CONFIG: PluginConfig = {
  summaryStrategy: 'strategy',
  maxGraphDepth: 10,
  maxNodeCount: 5000,
  enableCrossFileLinkage: true,
  crossReferenceRetentionDays: 90,
  maxTokens: 65_536,
  budgetRatio: 0.3,
  experience: { enabled: true, triggers: ["correction", "failure", "fix_success", "explicit_save"], summaryMode: "async", relevanceThreshold: 0.6 },
  cliTimeout: 30_000,
  cliFallbackSearchType: 'search',
  distillationIntervalMs: 2 * 60 * 60 * 1000,
  tripletTimeoutMs: 8000,
};

// --- Validate ---
export function validateConfig(input: unknown): PluginConfig {
  try {
    return PluginConfigSchema.parse(input);
  } catch (err) {
    throw new Error(`Invalid plugin config: ${(err as Error).message}`);
  }
}

// --- Load Config ---
export async function loadConfig(filePath?: string): Promise<PluginConfig> {
  if (!filePath) return { ...DEFAULT_CONFIG };
  const fs = await import('fs/promises');
  const path = await import('path');
  const resolved = path.resolve(filePath);
  try {
    const raw = await fs.readFile(resolved, 'utf-8');
    return validateConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// --- Validator ---
export function isConfigValid(input: unknown): boolean {
  try {
    PluginConfigSchema.parse(input);
    return true;
  } catch {
    return false;
  }
}
