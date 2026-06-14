export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
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
