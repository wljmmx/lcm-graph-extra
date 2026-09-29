/**
 * P2-3 H-16: 操作常量集中化。
 *
 * 修复前这些值散落在 index.ts / retrieval-gateway.ts / graph-adapter.ts /
 * circuit-breaker.ts / connection-pool.ts / conflict-logger.ts / ttl.ts 等多处，
 * 仅 MAX_DEDUP_ROUNDS 通过 PluginConfigSchema 暴露可配置，其余硬编码。
 * 此处作为单一来源，便于审阅与未来接入配置覆盖。
 *
 * 注：当前仅作为常量声明集中点；运行时配置覆盖仍走 PluginConfigSchema。
 * 各消费方 import 此处的常量，避免魔术数字散落。
 */

/**
 * LLM 调用超时默认值（v2.2.3 重新调优）。
 *
 * 背景：原默认值（3s/8s/10s）针对远程 API 设计，本地大模型（qwen3.6 q_4 on 4090+64G）
 * 单次推理 3-60s + Ollama 串行排队，频繁误超时导致 rerank/triplet/validation 持续失败。
 *
 * 注意：keepAlive（如 '1h'）是 Ollama 模型内存驻留时间，不是请求超时，两者无关。
 */
const LLM_TIMEOUT_DEFAULTS = {
  rerankTimeoutMs: 30_000,       // merger LLM rerank（原 3s → 30s，兼容 72B 排队）
  judgeTimeoutMs: 60_000,        // R-2 Tier 2 LLM judgment（原 10s → 60s）
  validateTimeoutMs: 45_000,     // G-8 afterTurn 相关性验证（原 8s → 45s）
  summarizeTimeoutMs: 90_000,    // 经验回顾摘要（原 20s → 90s，输入较长）
  embedTimeoutMs: 60_000,        // embedding 调用（原 30s → 60s，embed 通常较快但留余量）
  graphLlmTimeoutMs: 90_000,     // graph-adapter LLM / 三元组提取 fetch fallback（原 30s → 90s）
  /** cascade Tier2 LLM 判断超时（原 cascade-manager.ts 硬编码 10s） */
  cascadeTier2Ms: 60_000,
  /** cascade Tier3 工具验证超时（原 cascade-manager.ts 硬编码 15s） */
  cascadeTier3Ms: 90_000,
  /** 单条经验蒸馏超时（原 distillation.ts 硬编码 15s） */
  distillMs: 120_000,
} as const;

export type LlmTimeoutField = keyof typeof LLM_TIMEOUT_DEFAULTS;

// 运行时覆盖（由 index.ts 从 pluginConfig.llmTimeouts 应用，允许用户通过 openclaw.json 调整）
let llmTimeoutOverrides: Partial<typeof LLM_TIMEOUT_DEFAULTS> = {};

/**
 * 从 config 应用 LLM 超时覆盖（插件初始化时调用一次）。
 * 仅覆盖显式提供的字段，其余保持默认值。
 */
export function configureLlmTimeouts(overrides?: Partial<typeof LLM_TIMEOUT_DEFAULTS>): void {
  if (overrides) llmTimeoutOverrides = { ...overrides };
}

/**
 * 读取 LLM 超时值：优先运行时覆盖（来自 config.llmTimeouts），否则默认值。
 * 消费方应使用此函数而非直接读 DEFAULTS.llm.*，以支持运行时配置覆盖。
 */
export function llmTimeout(field: LlmTimeoutField): number {
  return llmTimeoutOverrides[field] ?? LLM_TIMEOUT_DEFAULTS[field];
}

export const DEFAULTS = {
  /** 跨轮去重缓存（sessionDedupCache + _sessionOverheadCache 共用） */
  dedup: {
    maxCapacity: 500,        // 最大 session 数
    ttlMs: 4 * 60 * 60 * 1000, // P-CP-1: 4h 未访问即淘汰（原 1h 偏短，长会话中经验重复注入）
    maxRounds: 24,           // 每会话保留的最近轮次哈希窗口
  },

  /** 心跳调度（index.ts runHeartbeat） */
  heartbeat: {
    intervalMs: 5 * 60 * 1000, // 5min
    /** P2-9: 压力检测阈值（原 index.ts 中散落的魔术数字集中化） */
    pressure: {
      pendingMessagesThreshold: 15,   // 待压缩消息数 ≥ 此值触发债务
      summaryFragmentsThreshold: 8,   // 摘要碎片数 ≥ 此值触发债务
      maxTokenRatio: 0.65,            // 当前 token / 上下文窗口 > 此值触发债务
      contextWindowChars: 262_144,    // 默认上下文窗口（字符数）
      tokenBudget: 114_688,           // 默认 token 预算 ≈ 112K（128K 窗口的 ~90%）
    },
  },

  /** 检索网关超时与慢查询阈值（retrieval-gateway.ts） */
  retrieval: {
    slowSearchThresholdMs: 1000, // 单路检索超过此阈值记为慢查询
    globalTimeoutMs: 15_000,     // 单路检索全局超时
    // BUGFIX(P0-1): 统一 L4 经验召回的 minScore。
    // 此前 RetrievalGateway.searchWithExperience 用 0.5，assemble 用 0.6，
    // 导致两条检索路径对相同 query 召回的经验集合不同。
    // 0.5 更宽松、召回率更高，与 RetrievalGateway 设计意图一致，作为单一来源。
    expMinScore: 0.5,
    expHalfLifeDays: 30,          // C-1: matchCount 时间衰减半衰期（天）
  },

  // BUGFIX(P2-9): LLM 调用超时集中化（原散落 6 处硬编码 1.5s~30s，跨 20 倍不一致）。
  // v2.2.3: 针对 4090+64G+qwen3.6 q_4 本地模型重新调优（原 3s/8s/10s 在本地大模型下频繁误超时）。
  //   - 单次推理：32B q_4 ≈ 3-10s，72B q_4(CPU offload) ≈ 15-60s
  //   - 并发排队：rerank+triplet+validation+Tier2 同轮触发，Ollama 串行排队 → 需更宽容超时
  llm: LLM_TIMEOUT_DEFAULTS,

  /** 图谱适配器（graph-adapter.ts） */
  graph: {
    maxRetries: 3,                 // 连接重试次数
    reconnectCooldownMs: 60_000,   // 连接失败冷却期
    searchCacheSize: 50,           // searchWithCache LRU 容量
    searchCacheTtlMs: 300 * 1000,  // searchWithCache TTL（5min）
  },

  /** 熔断器（circuit-breaker.ts） */
  circuitBreaker: {
    threshold: 3,           // N 次失败后熔断
    cooldownMs: 30_000,     // 30s 后尝试半开
    halfOpenTimeoutMs: 5_000, // 半开超时
  },

  /** 连接池（connection-pool.ts） */
  connectionPool: {
    acquireTimeoutMs: 5_000, // 获取连接超时
  },

  /** 冲突日志（conflict-logger.ts） */
  conflict: {
    maxInMemory: 1000, // 内存中保留的最大冲突条目数
  },

  /** TTL 衰减（ttl.ts / merger.ts） */
  ttl: {
    halfLifeDays: 45, // 权重半衰期
  },

  /**
   * compact（DAG 压缩 / LLM 摘要）默认值 —— 单一来源，供 compact() 入口
   * （index.ts）与 lossless-claw adapter 共用，避免两处各自硬编码后漂移。
   */
  compact: {
    /**
     * 单次压缩尝试超时（ms）。
     * 取值依据：本地 27B 模型对长上下文做摘要最坏 ~2-3min（对齐 llm.distillMs=120s
     * 同类场景并留余量）。此前 index.ts / adapter 各自硬编码 300_000，
     * 此处收编为默认值，用户经 lcmMonitor.compactTimeout 覆盖。
     */
    attemptTimeoutMs: 300_000,
    /**
     * 输入超限阈值（contextWindow 占比）：当前 token 超过该比例即视为「输入超限」，
     * 触发渐进式降级压缩（逐级缩小 tokenBudget）。
     * 取值依据：与 assemble 侧输入超限保护同一语义（原为硬编码 0.80）。
     * 注意：不得用 `contextWindow * 0.9 - compactTokenBudget` 之类公式推导 ——
     * compactTokenBudget 是压缩「目标」而非「开销」，相减会在 budget 接近窗口时
     * 得到负阈值，导致每次压缩都被误判为超限。
     */
    inputOverflowRatio: 0.80,
  },
} as const;

/** 便利子对象类型（用于函数参数默认值等场景） */
export type Defaults = typeof DEFAULTS;

/** lcmMonitor 中与 compact 相关的配置子集（原始 pluginConfig 可能未填默认值） */
export interface CompactConfigInput {
  compactTimeout?: number;
  inputOverflowThreshold?: number;
}

export interface CompactOptions {
  /** 单次压缩尝试超时（ms） */
  attemptTimeoutMs: number;
  /** 输入超限阈值（contextWindow 占比，0~1） */
  inputOverflowRatio: number;
}

/**
 * 从 pluginConfig.lcmMonitor 解析 compact 选项：显式配置优先，非法/缺失回退 DEFAULTS.compact。
 *
 * 为什么需要它：index.ts / assemble 读的是宿主注入的**原始** pluginConfig，
 * 不一定经过 validateConfig 填默认值；两处各自 `?? 300_000`/`?? 0.80` 又会漂移。
 * 集中解析 + 校验，保证默认值只有一处来源。
 */
export function resolveCompactOptions(lcmMonitor?: CompactConfigInput | null): CompactOptions {
  const rawTimeout = Number((lcmMonitor as CompactConfigInput | undefined)?.compactTimeout);
  const attemptTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.floor(rawTimeout)
    : DEFAULTS.compact.attemptTimeoutMs;

  const rawRatio = Number((lcmMonitor as CompactConfigInput | undefined)?.inputOverflowThreshold);
  const inputOverflowRatio = Number.isFinite(rawRatio) && rawRatio > 0 && rawRatio <= 1
    ? rawRatio
    : DEFAULTS.compact.inputOverflowRatio;

  return { attemptTimeoutMs, inputOverflowRatio };
}
