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
