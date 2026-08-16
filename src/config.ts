import { Type, Static, type TSchemaOptions, type TLiteral, type TUnion } from 'typebox';
import { Value } from 'typebox/value';
import { resolve } from 'path';
import { getGlobalLogger } from './utils/logger.js';

/**
 * 所有支持的 LLM provider 类型（统一枚举常量）。
 *
 * 此常量是 config.ts 中所有 provider 字段（llmProvider / distillationLlm /
 * moa.referenceModels / moa.aggregatorModel）以及 moa/types.ts 中
 * ReferenceModelConfig / AggregatorModelConfig 的唯一来源。
 *
 * 注意：必须包含 'openclaw_hooks'，因为它是 llmProvider 与 distillationLlm
 * 的默认值，移除会破坏现有配置的 schema 校验（向后兼容）。
 */
export const LLM_PROVIDERS = [
  'openai',
  'ollama',
  'deepseek',
  'unsloth',
  'custom',
  'openclaw_hooks',
] as const;
export type LlmProvider = typeof LLM_PROVIDERS[number];

/**
 * 构建 LLM provider 的 Type.Union schema。
 *
 * 从 LLM_PROVIDERS 常量派生，单一数据源——新增 provider 只需修改 LLM_PROVIDERS。
 * 返回类型声明为 TUnion<TLiteral[]>, 确保 Static 推断出正确的字符串字面量联合类型
 * 而非 never（运行时枚举值一致性由 schema-consistency.test.ts 覆盖）。
 */
function LlmProviderUnion(options?: TSchemaOptions): TUnion<[TLiteral<string>, ...TLiteral<string>[]]> {
  return Type.Union(
    LLM_PROVIDERS.map((p) => Type.Literal(p)) as any,
    options,
  ) as any;
}

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
      Type.Literal('circuit_breaker_trip'),
      Type.Literal('debt_overflow'),
      Type.Literal('gm_pro_unavailable'),
    ]), { default: [] }),
  })),


  llmProvider: Type.Optional(Type.Object({
    provider: LlmProviderUnion({ default: 'openclaw_hooks', description: 'LLM provider 类型，见 LLM_PROVIDERS 常量' }),
    model: Type.String({ default: 'default' }),
    maxTokens: Type.Number({ default: 32_768, minimum: 1, description: '最大输出 token 数。推荐：8k(8192) / 16k(16384) / 24k(24576) / 32k(32768)，根据模型上下文窗口自动匹配' }),
  })),

  cliTimeout: Type.Number({ default: 30_000 }),
  cliFallbackSearchType: Type.Union([Type.Literal('search'), Type.Literal('hybrid')], { default: 'hybrid' }),
  enableCliFallback: Type.Boolean({ default: true, description: "是否启用QMD CLI降级能力。设为false时，MCP和REST均失败后直接抛错，不执行CLI命令（避免CLI卡死）" }),

  // QMD MCP 超时配置（index.ts 中读取并传入 QmdClient 构造函数）
  qmdMcpTimeout: Type.Number({ default: 3_000, minimum: 500 }),
  qmdMcpQueryTimeout: Type.Number({ default: 15_000, minimum: 1_000, description: 'QMD MCP/REST 查询超时（ms）。原默认 8s 在本地模型冷启动/排队场景下不足，提升至 15s 以覆盖更多场景' }),

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
    provider: LlmProviderUnion({ default: 'openclaw_hooks', description: '蒸馏 LLM 的 provider 类型，见 LLM_PROVIDERS 常量' }),
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

  // 大工具负载外部分片 + 存根替换（兼容 lossless-claw 的 stubLargeToolPayloads）
  stubLargeToolPayloads: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: false }),
    thresholdBytes: Type.Number({ default: 8_000, minimum: 1_000 }),
    filesDir: Type.String({ default: '' }),
    freshTailCount: Type.Number({ default: 8, minimum: 0 }),
  })),
  // 简写方式：stubLargeToolPayloads: true 等同于 enabled: true
  largeFileThreshold: Type.Optional(Type.Number({ default: 8_000, minimum: 1_000 })),
  largeFilesDir: Type.Optional(Type.String({ default: '' })),

  // MoA (Mixture of Agents) 多模型分层协作配置
  moa: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: false }),
    complexityThreshold: Type.Number({ default: 0.6, minimum: 0, maximum: 1 }),
    benefitThreshold: Type.Optional(Type.Number({ default: 0.10, minimum: 0, maximum: 1, description: 'MoA 最低期望净收益门槛，低于该值不触发（默认 0.10 = 期望提升 ≥10%）；会被主模型成本动态放大' })),
    thresholdCostSensitivity: Type.Optional(Type.Number({ default: 0.8, minimum: 0, maximum: 2, description: '净收益门槛放大系数：主模型成本越高，门槛越高（默认 0.8；0 表示不放大，固定用 benefitThreshold）' })),
    tokenCosts: Type.Optional(Type.Record(Type.String(), Type.Union([
      Type.Number(),
      Type.Object({
        pricePerMToken: Type.Optional(Type.Number({ description: '每百万 token 相对价格（相对最贵模型归一为 1）' })),
        avgInputTokens: Type.Optional(Type.Number({ description: '平均输入 token 数（缺省用默认或实测均值）' })),
        avgOutputTokens: Type.Optional(Type.Number({ description: '平均输出 token 数（缺省用默认或实测均值）' })),
      }),
    ]), { default: {}, description: '远程模型成本配置：模型名 → 相对单价(number)，或 { pricePerMToken, avgInputTokens, avgOutputTokens }。不配置时使用内置默认表；本地模型不计此表' })),
    mode: Type.Union([Type.Literal('auto'), Type.Literal('parallel'), Type.Literal('serial')], { default: 'auto' }),
    referenceModels: Type.Array(Type.Object({
      provider: LlmProviderUnion({ default: 'ollama', description: '参考模型 LLM provider 类型，见 LLM_PROVIDERS 常量' }),
      model: Type.String({ default: 'qwen3.6:27b' }),
      temperature: Type.Number({ default: 0.6, minimum: 0, maximum: 2 }),
      systemPrompt: Type.String({ default: '' }),
      timeoutMs: Type.Number({ default: 900_000, minimum: 1_000 }),
      apiKey: Type.Optional(Type.String()),
      baseURL: Type.Optional(Type.String()),
      keepAlive: Type.Optional(Type.String({ default: '1h' })),
    }), { default: [] }),
    aggregatorModel: Type.Optional(Type.Object({
      provider: LlmProviderUnion({ default: 'ollama', description: '聚合模型 LLM provider 类型，见 LLM_PROVIDERS 常量' }),
      model: Type.String({ default: 'qwen3.6:27b' }),
      temperature: Type.Number({ default: 0.3, minimum: 0, maximum: 2 }),
      systemPrompt: Type.Optional(Type.String({ default: '' })),
      timeoutMs: Type.Number({ default: 1_200_000, minimum: 1_000 }),
      apiKey: Type.Optional(Type.String()),
      baseURL: Type.Optional(Type.String()),
      keepAlive: Type.Optional(Type.String({ default: '1h' })),
    })),
    enabledTiers: Type.Array(
      Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
      { default: ['low'] },
    ),
    syncBudgetMs: Type.Optional(Type.Number({ default: 240_000, minimum: 30_000 })),
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
      // BUG-6: 图谱检索缓存大小可配置（原硬编码 DEFAULTS.graph.searchCacheSize = 50）
      searchCacheSize: Type.Optional(Type.Number({ default: 50, minimum: 10 })),
      // v2.3.6 在线学习：JudgeManager（I-2 裁判）注入 Recaller，形成反馈闭环
      judge: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: true })),
        // 1=启发式(零 LLM) / 2=LLM 裁判 / 3=自定义
        tier: Type.Optional(Type.Union([
          Type.Literal(1),
          Type.Literal(2),
          Type.Literal(3),
        ], { default: 1 })),
        // 冷启动阈值（默认 20，见 gm-pro DEFAULT_JUDGE_CONFIG）
        judgeWarmupFeedbacks: Type.Optional(Type.Number({ default: 20, minimum: 1 })),
        // 启发式匹配维度：id / name / both
        heuristicMatch: Type.Optional(Type.Union([
          Type.Literal('id'),
          Type.Literal('name'),
          Type.Literal('both'),
        ], { default: 'both' })),
        llmJudgeMaxNodes: Type.Optional(Type.Number({ default: 8, minimum: 1 })),
        llmJudgeTimeoutMs: Type.Optional(Type.Number({ default: 30_000, minimum: 1_000 })),
      })),
      // v2.3.6 在线学习：关联矩阵 M（L-1），默认关闭，需显式启用
      associationMatrix: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: false })),
        learningRate: Type.Optional(Type.Number({ default: 0.1, minimum: 0, maximum: 1 })),
        warmupFeedbacks: Type.Optional(Type.Number({ default: 20, minimum: 1 })),
        persistPath: Type.Optional(Type.String()),
      })),
      // v2.3.5 方案 A：agent_end 自动反馈采集（冷启动死循环破除）
      autoFeedback: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: true })),
      })),
    })),
    // BUG-6: L2/L4 查询缓存大小可配置（原硬编码 QUERY_CACHE_MAX = 50）
    cacheSize: Type.Optional(Type.Number({ default: 50, minimum: 10 })),
    // BUG-7: QMD vec/hyde 查询文本分片阈值（字符数），超过则拆分为多个分片独立查询。
    // 分片策略：保留完整语义（不截断丢弃），每个分片作为独立 vec/hyde 子查询发送，
    // 检索后端通过 RRF 合并结果。分片更短 → 与索引文档拼接后更易落在 embedding 模型
    // context window 内 → 解决 "documents exceed the context size" 错误。
    // Qwen3.5-Embedding-0.6B num_ctx=8192 tokens，默认 2000 chars 给文档侧留 7000+ tokens 空间。
    // 若仍有 context size 错误可继续降低（如 1000）。
    qmdQueryMaxChars: Type.Optional(Type.Number({ default: 2000, minimum: 500 })),
  })),

  lcmMonitor: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: true }),
    contextWindow: Type.Number({ default: 262_144, minimum: 1 }),
    /**
     * v2.5.0: summary 模型（lossless-claw compact 使用的模型）的上下文窗口大小。
     * 当此值与主模型 contextWindow 不同时，compactTokenBudget 基于此值计算，
     * 避免 summary 模型窗口小于主模型窗口时 token budget 超限导致 compaction 失败。
     * 默认 0（未设置），回退到 contextWindow。
     */
    summaryModelContextWindow: Type.Optional(Type.Number({ default: 0, minimum: 0 })),
    dedupRounds: Type.Number({ default: 24, minimum: 1 }),
    highPressureThreshold: Type.Number({ default: 0.85, minimum: 0, maximum: 1 }),
    mediumPressureThreshold: Type.Number({ default: 0.70, minimum: 0, maximum: 1 }),
    proactiveThreshold: Type.Number({ default: 0.55, minimum: 0, maximum: 1 }),
    systemPromptOverheadTokens: Type.Number({ default: 17_000, minimum: 0 }),
    compactTokenBudget: Type.Number({ default: 154_624, minimum: 0 }),
    compactTimeout: Type.Number({ default: 60_000, minimum: 0 }),
    maxSummaryTokenRatio: Type.Number({ default: 0.45, minimum: 0, maximum: 1 }),
    // 预压缩冷却时间（ms）：同一会话在冷却期内不重复提交预压缩任务，
    // 避免活跃对话中每轮 assemble 都触发 compact，打满本地 LLM pending 队列。
    preCompactCooldownMs: Type.Number({ default: 60_000, minimum: 0 }),
    // 插件 compact() 入口同会话冷却（ms）：SDK 后台维护（turnMaintenanceMode:'background'）
    // 每轮 turn 结束都会调用本插件的 compact()。若每次都真的执行 DAG 压缩，会在活跃对话中
    // 反复打满本地 LLM pending 队列。仅在"无显式 force / 无真实溢出压力"时应用冷却，
    // 显式的强制压缩不受影响。
    compactCooldownMs: Type.Number({ default: 120_000, minimum: 0 }),
    // v2.5.1: 消除 retrieval 配置冗余。
    // 此处不再设置 low/medium/high 的字段默认值，仅保留 schema 结构校验。
    // 单一数据源：pluginConfig.retrieval.limits（低压默认值）→ 运行时 resolveContextProfile
    //   按优先级 wm.retrievalLimits.xxx > retrieval.limits > adaptiveLimits 计算，
    //   中/高压未显式配置时，基于低压默认按比例折扣回退（见 resolveContextProfile + assemble/index.ts）。
    retrievalLimits: Type.Optional(Type.Object({
      low: Type.Object({
        qmd: Type.Number({ minimum: 1 }),
        graph: Type.Number({ minimum: 1 }),
        exp: Type.Number({ minimum: 0 }),
      }),
      medium: Type.Object({
        qmd: Type.Number({ minimum: 1 }),
        graph: Type.Number({ minimum: 1 }),
        exp: Type.Number({ minimum: 0 }),
      }),
      high: Type.Object({
        qmd: Type.Number({ minimum: 1 }),
        graph: Type.Number({ minimum: 1 }),
        exp: Type.Number({ minimum: 0 }),
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

/**
 * 压缩 token budget 占上下文窗口的比例。
 *
 * 此值作为 lossless-claw compact() 的 tokenBudget 参数传入。
 * lossless-claw 内部会再乘以 contextThreshold（默认 0.75）得到实际压缩目标：
 *   effectiveTarget = COMPACT_RATIO × contextWindow × 0.75
 *
 * 因此 COMPACT_RATIO 需要反推：
 *   若期望 effectiveTarget ≈ 44% × contextWindow（原设计意图），
 *   则 COMPACT_RATIO = 0.44 / 0.75 ≈ 0.587 → 取整为 0.59。
 *
 * 对于 256K 窗口: 0.59 × 262144 × 0.75 ≈ 116,000 tokens 有效目标。
 */
export const COMPACT_RATIO = 0.59;

/**
 * SDK untracked overhead 预估值（tokens）。
 *
 * SDK 注入但不算在 assemble 估算中的开销，包括：
 *   - system prompt 核心文本（~7.5K tok）
 *   - compact prompt surface / tool catalog（~50-58K tok）
 *   - workspace 文件注入（~3K tok）
 *   - skills 列表（~2K tok）
 *
 * 实测值：20 条消息时 untracked ≈ 58K tok，
 * 占 131K 窗口的 ~44%。随工具数/技能数浮动，取保守下限。
 */
export const SDK_OVERHEAD_TOKENS = 55_000;

export function resolveContextProfile(
  providerModelCtx?: number,
  wm?: WindowMonitorConfig,
  retrievalBaseLimits?: RetrievalLimits,
  profileTierLimits?: {
    low: RetrievalLimits;
    medium: RetrievalLimits;
    high: RetrievalLimits;
  },
): Pick<ResolvedWindowConfig, 'contextWindow' | 'compactTokenBudget' | 'retrievalLimits' | 'maxContextChars'> {
  const ctxWindow = providerModelCtx ?? wm?.contextWindow ?? 262_144;
  const base = 262_144;
  const scale = ctxWindow / base;

  const adaptiveLimits = defaultRetrievalLimits(scale);
  const adaptiveChars = defaultMaxContextChars(scale);

  // v2.5.0: summary 模型窗口分离 —— 当 summary 模型窗口 < 主模型窗口时，
  // compactTokenBudget 基于 summary 模型窗口计算，避免传给 lossless-claw 的
  // tokenBudget 超过 summary 模型实际能力导致 compaction 失败。
  const summaryCtxWindow = (wm as any)?.summaryModelContextWindow > 0
    ? (wm as any).summaryModelContextWindow
    : ctxWindow;
  const compactTokenBudget = wm?.compactTokenBudget
    ?? Math.round(summaryCtxWindow * COMPACT_RATIO);

  // v2.5.1: 消除 retrieval 配置冗余。
  // retrieval.limits（顶层检索条数默认值）与 lcmMonitor.retrievalLimits.low
  // 两套配置默认值完全相同。新增 retrievalBaseLimits 参数（取自 retrieval.limits），
  // 作为低压的"上游默认"，用户只配 retrieval.limits 即可自动生效：
  // v2.5.2: 接入 capability profile 的 retrievalLimits（热更新档次切换）。
  // 最终 ?? 链优先级：
  //   1. wm.retrievalLimits.low.xxx（用户显式配 lcmMonitor.retrievalLimits.low）
  //   2. retrievalBaseLimits.xxx（用户配顶层 retrieval.limits）
  //   3. profileTierLimits?.low?.xxx（当前能力档次预设 minimal/balanced/performance/full）
  //   4. adaptiveLimits.xxx（按 contextWindow 比例自适应）
  // 中压、高压：同样接入 profileTierLimits.medium/high 作为"显式配置"之外的第一个
  // 回退，再无则基于 resolveContextProfile 给出的低压默认按比例打折扣。
  const lowDefaults = {
    qmd: wm?.retrievalLimits?.low?.qmd ?? retrievalBaseLimits?.qmd ?? profileTierLimits?.low.qmd ?? adaptiveLimits.qmd,
    graph: wm?.retrievalLimits?.low?.graph ?? retrievalBaseLimits?.graph ?? profileTierLimits?.low.graph ?? adaptiveLimits.graph,
    exp: wm?.retrievalLimits?.low?.exp ?? retrievalBaseLimits?.exp ?? profileTierLimits?.low.exp ?? adaptiveLimits.exp,
  };
  const mediumDefaultsFromProfile = profileTierLimits?.medium;
  const highDefaultsFromProfile = profileTierLimits?.high;

  // P0-2 BUG-1: 修复 ?? 链失效死代码。
  // 修复策略：用户显式配置优先 → capability profile 档次预设 → 基于低压上游默认的中/高压折扣 → 自适应默认 → 兜底常量。
  const mediumDefaultsFromLow = {
    qmd: wm?.retrievalLimits?.medium?.qmd ?? mediumDefaultsFromProfile?.qmd ?? Math.max(1, Math.round(lowDefaults.qmd * 0.6)),
    graph: wm?.retrievalLimits?.medium?.graph ?? mediumDefaultsFromProfile?.graph ?? Math.max(1, Math.round(lowDefaults.graph * 0.6)),
    exp: wm?.retrievalLimits?.medium?.exp ?? (mediumDefaultsFromProfile?.exp != null ? mediumDefaultsFromProfile.exp : Math.max(0, Math.round(lowDefaults.exp * 0.3))),
  };
  const highDefaultsFromLow = {
    qmd: wm?.retrievalLimits?.high?.qmd ?? highDefaultsFromProfile?.qmd ?? Math.max(1, Math.round(lowDefaults.qmd * 0.2)),
    graph: wm?.retrievalLimits?.high?.graph ?? highDefaultsFromProfile?.graph ?? Math.max(1, Math.round(lowDefaults.graph * 0.2)),
    exp: wm?.retrievalLimits?.high?.exp ?? (highDefaultsFromProfile?.exp != null ? highDefaultsFromProfile.exp : 0),
  };

  return {
    contextWindow: ctxWindow,
    compactTokenBudget,
    retrievalLimits: {
      qmd: lowDefaults.qmd,
      graph: lowDefaults.graph,
      exp: lowDefaults.exp,
    },
    maxContextChars: {
      low: wm?.maxContextChars?.low ?? adaptiveChars.low,
      medium: wm?.maxContextChars?.medium ?? adaptiveChars.medium,
      high: wm?.maxContextChars?.high ?? adaptiveChars.high,
    },
    // 未在此返回中压高压：assemble/index.ts 内走 getRetrievalLimitsForTier
    //   tierLimits → 基于 wm.retrievalLimits.{low,medium,high}。
    //   我们会在 assemble 调用点把 medium/high 的回退默认补齐为基于 retrievalBaseLimits。
    _tierLowDefaults: lowDefaults,
    _tierMediumDefaultsFromLow: mediumDefaultsFromLow,
    _tierHighDefaultsFromLow: highDefaultsFromLow,
  } as any;
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
  cliFallbackSearchType: 'hybrid',
  enableCliFallback: true,
  qmdMcpTimeout: 3_000,
  qmdMcpQueryTimeout: 15_000,
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
  if (!config.llmProvider) config.llmProvider = { provider: 'openclaw_hooks', model: 'default', maxTokens: 32_768 };
  if (!config.embedding) config.embedding = {};
  if (!config.experience) config.experience = { enabled: true, triggers: ['correction', 'failure', 'fix_success', 'explicit_save'], summaryMode: 'async', relevanceThreshold: 0.6 };
  if (!config.logging) config.logging = { level: 'info' };
  if (!config.retrieval) config.retrieval = {};
  if (!config.retrieval?.limits) config.retrieval.limits = { qmd: 5, graph: 5, exp: 3 };
  if (!config.retrieval?.graph) config.retrieval.graph = { enabled: true, searchLimit: 5 };
  // v2.3.6: 默认启用 judge + autoFeedback，关闭 associationMatrix（需显式开启）
  if (!config.retrieval?.graph?.judge) config.retrieval.graph.judge = { enabled: true, tier: 1, judgeWarmupFeedbacks: 20, heuristicMatch: 'both', llmJudgeMaxNodes: 8, llmJudgeTimeoutMs: 30_000 };
  if (!config.retrieval?.graph?.associationMatrix) config.retrieval.graph.associationMatrix = { enabled: false, learningRate: 0.1, warmupFeedbacks: 20 };
  if (!config.retrieval?.graph?.autoFeedback) config.retrieval.graph.autoFeedback = { enabled: true };
  if (!config.lcmMonitor) config.lcmMonitor = {
    enabled: true, contextWindow: 262_144, dedupRounds: 24,
    highPressureThreshold: 0.85, mediumPressureThreshold: 0.70,
    proactiveThreshold: 0.65, systemPromptOverheadTokens: 17_000,
    // 0.59 × 262144 ≈ 154665，取整
    compactTokenBudget: 154_624, compactTimeout: 60_000, maxSummaryTokenRatio: 0.45,
    preCompactCooldownMs: 60_000, compactCooldownMs: 120_000
  };
  // distillationLlm 未配置时保持 undefined，由 resolveDistillationLlm 的 fallback 处理
  // （优先复用主模型 → LLM_MODEL 环境变量 → gpt-4o-mini）
  if (!config.neo4j) config.neo4j = { uri: 'bolt://localhost:7687', user: 'neo4j', password: '' };
  if (!config.moa) config.moa = { enabled: false, complexityThreshold: 0.6, benefitThreshold: 0.10, thresholdCostSensitivity: 0.8, mode: 'auto', referenceModels: [], aggregatorModel: undefined, enabledTiers: ['low'] };

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
 * 根据模型上下文窗口自动匹配推荐的最大输出 token 数。
 *
 * 映射规则（按 128k 模型建议 32k 输出）：
 *   contextWindow >= 128k → 32,768 (32k)
 *   contextWindow >= 64k  → 24,576 (24k)
 *   contextWindow >= 32k  → 16,384 (16k)
 *   contextWindow < 32k   →  8,192  (8k)
 *
 * @param contextWindow 模型的上下文窗口大小（token 数）
 * @returns 推荐的 maxTokens 值
 */
export function autoMatchMaxTokens(contextWindow: number): number {
  if (contextWindow >= 128_000) return 32_768;
  if (contextWindow >= 64_000) return 24_576;
  if (contextWindow >= 32_000) return 16_384;
  return 8_192;
}

/** maxTokens 可选档位，供 dashboard 下拉选择 */
export const MAX_TOKENS_TIERS = [8_192, 16_384, 24_576, 32_768] as const;

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