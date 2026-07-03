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
export const DEFAULTS = {
  /** 跨轮去重缓存（sessionDedupCache + _sessionOverheadCache 共用） */
  dedup: {
    maxCapacity: 500,        // 最大 session 数
    ttlMs: 60 * 60 * 1000,   // 1h 未访问即淘汰
    maxRounds: 24,           // 每会话保留的最近轮次哈希窗口
  },

  /** 心跳调度（index.ts runHeartbeat） */
  heartbeat: {
    intervalMs: 5 * 60 * 1000, // 5min
  },

  /** 检索网关超时与慢查询阈值（retrieval-gateway.ts） */
  retrieval: {
    slowSearchThresholdMs: 1000, // 单路检索超过此阈值记为慢查询
    globalTimeoutMs: 15_000,     // 单路检索全局超时
  },

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
} as const;

/** 便利子对象类型（用于函数参数默认值等场景） */
export type Defaults = typeof DEFAULTS;
