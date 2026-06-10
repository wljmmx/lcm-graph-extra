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
  // 旧版兼容字段
  triggerThreshold: z.number().int().positive().default(10000),
  softThresholdTokens: z.number().int().positive().default(81920),
  keepRecentTokens: z.number().int().positive().default(65536),
}).passthrough();

export const PluginConfigSchema = z.object({
  // Summary strategy
  summaryStrategy: z.enum(['strategy', 'hybrid', 'full']).default('strategy'),
  maxGraphDepth: z.number().int().positive().default(10),
  maxNodeCount: z.number().int().positive().default(5000),
  enableCrossFileLinkage: z.boolean().default(true),
  crossReferenceRetentionDays: z.number().int().positive().default(90),
  maxTokens: z.number().int().positive().default(32768),
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
}).passthrough();

export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type ExperienceTrigger = z.infer<typeof ExperienceTriggerSchema>;

// --- Default Config ---

/** Window Monitor configuration schema (v2.1.4b) */
export const WindowMonitorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  contextWindow: z.number().default(131072),
  messageTriggerCount: z.number().default(24),
  highPressureThreshold: z.number().default(0.85),
  mediumPressureThreshold: z.number().default(0.70),
  proactiveThreshold: z.number().default(0.65),
  compactTokenBudget: z.number().default(57344),
  retrievalLimits: z.object({
    low: z.object({ qmd: z.number().default(5), graph: z.number().default(5), exp: z.number().default(3) }),
    medium: z.object({ qmd: z.number().default(3), graph: z.number().default(3), exp: z.number().default(1) }),
    high: z.object({ qmd: z.number().default(1), graph: z.number().default(1), exp: z.number().default(0) }),
  }).optional(),
  maxContextChars: z.object({
    low: z.number().default(6000),
    medium: z.number().default(3000),
    high: z.number().default(800),
  }).optional(),
});
export const DEFAULT_CONFIG: PluginConfig = {
  summaryStrategy: 'strategy',
  maxGraphDepth: 10,
  maxNodeCount: 5000,
  enableCrossFileLinkage: true,
  crossReferenceRetentionDays: 90,
  maxTokens: 32768,
  budgetRatio: 0.3,
  experience: { enabled: true, triggers: ["correction", "failure", "fix_success", "explicit_save"], summaryMode: "async", relevanceThreshold: 0.6 },
  cliTimeout: 30_000,
  cliFallbackSearchType: 'search',
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
