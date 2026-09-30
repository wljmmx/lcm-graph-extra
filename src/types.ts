export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

export interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
  options?: Record<string, number | boolean | string>;
  keepAlive?: string;
  /** 单次批量嵌入请求携带的最大文本数（默认 32）；用于 batchUpsert 等批量场景 */
  batchSize?: number;
  /** 同一端点的 embedding 并发上限（默认 2）。上限 32。对齐 graph-memory-pro v2.8.x */
  maxConcurrency?: number;
  /** 相邻两次 embedding 发送的最小间隔 ms（默认 0 = 关闭）。用于抑制"无间隔连续请求流" */
  requestIntervalMs?: number;
  /** 单个子批次的总字符预算（默认 0 = 关闭，仅按 batchSize 切分）。长度感知装箱用 */
  maxBatchChars?: number;
  /** embedding 结果 LRU 缓存容量（默认 256；≤0 = 关闭缓存）。对齐 graph-memory-pro v2.8.x */
  cacheSize?: number;
  /** embedding 结果缓存 TTL（ms，默认 10min；≤0 = 关闭缓存） */
  cacheTtlMs?: number;
}

export type RetrievalSource = 'qmd' | 'graph';

export type RetrievalType = 'raw' | 'definition' | 'relation';

export interface RetrievalResult {
  id: string;
  content: string;
  source: RetrievalSource;
  type: RetrievalType;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * R-2: 图数据库查询执行器接口。
 * ExperienceStorage 和 TagRegistry 依赖此接口而非具体 GraphAdapter 类，
 * 消除 `as any` 类型擦除，使依赖关系显式化。
 */
export interface GraphQueryExecutor {
  query<T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}
