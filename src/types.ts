/**
 * lcm-graph-extra — Core type definitions
 *
 * Types for the dual-engine retrieval gateway that coordinates
 * qmd full-text search and Neo4j knowledge graph search.
 */

// ─── Retrieval result types ──────────────────────────────────

export type RetrievalSource = 'qmd' | 'graph';

export type RetrievalType = 'definition' | 'relation' | 'raw';

export interface RetrievalResult {
  /** Unique result identifier (content hash) */
  id: string;
  /** The retrieved content text */
  content: string;
  /** Source engine */
  source: RetrievalSource;
  /** Type classification */
  type: RetrievalType;
  /** Relevance score normalized to 0-1 */
  score: number;
  /** Optional metadata from source engine */
  metadata: Record<string, unknown>;
}

// ─── Extraction types ────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: string; // e.g. 'SKILL', 'TASK', 'EVENT', 'CONCEPT'
  description: string;
  content: string;
}

export interface ExtractedRelation {
  from: string;
  to: string;
  type: string; // e.g. 'USED_SKILL', 'SOLVED_BY', 'RELATED_TO'
  instruction?: string;
}

// ─── Plugin config types ─────────────────────────────────────

export interface Neo4jConfig {
  /** Path to graph-memory-pro module (for dynamic import) */
  modulePath?: string;
  uri: string;
  user?: string;// 可从配置或环境变量 NEO4J_USER 获取
  password?: string;// 可从配置或环境变量 NEO4J_PASSWORD 获取
}

export interface LlmConfig {
  /** API key for external LLM (optional, default uses no auth) */
  apiKey?: string;
  /** Base URL for OpenAI-compatible API */
  baseURL?: string;
  /** Model name for extraction */
  model?: string;
}

export interface QmdRetrievalConfig {
  enabled: boolean;
  searchLimit: number;
}

export interface GraphRetrievalConfig {
  enabled: boolean;
  searchLimit: number;
}

export interface MergerConfig {
  maxResults: number;
  fuzzyMatchThreshold: number;
  /** Memory decay half-life in days. 0 = disabled. Applied to graph results only. */
  decayHalfLifeDays?: number;
}

export interface RetrievalConfig {
  qmd: QmdRetrievalConfig;
  graph: GraphRetrievalConfig;
  merger: MergerConfig;
}

export interface AsyncExtractionConfig {
  enabled: boolean;
  concurrency: number;
  /** Batch size for extraction (pairs per run) */
  batchSize?: number;
  /** LLM config for entity extraction */
  llm?: LlmConfig;
}

export interface AsyncConfig {
  extraction: AsyncExtractionConfig;
}

// ─── Context engine types ────────────────────────────────────

export interface AssembledContext {
  messages: unknown[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}
