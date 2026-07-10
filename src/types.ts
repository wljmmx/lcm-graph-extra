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
