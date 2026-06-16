/**
 * lcm-graph-extra — Neo4j credential resolver
 *
 * Resolves credentials with fallback priority:
 *   1. Plugin config (config.neo4j)
 *   2. Environment variables (NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD)
 *   3. Sensible defaults
 *
 * Eliminates hardcoded credentials in source code.
 */

export interface Neo4jConnectionConfig {
  uri: string;
  user: string;
  password: string;
}

export interface Neo4jSearchConfig {
  enabled: boolean;
  searchLimit: number;
}

/**
 * Resolve Neo4j connection credentials from config/env/defaults.
 */
export function resolveNeo4jConfig(
  pluginConfig: Record<string, unknown> | undefined,
): Neo4jConnectionConfig {
  const neo4jSection = (pluginConfig?.neo4j ?? {}) as Record<string, unknown>;

  const uri =
    (neo4jSection.uri as string) ||
    process.env.NEO4J_URI ||
    "bolt://localhost:7687";

  const user =
    (neo4jSection.user as string) ||
    process.env.NEO4J_USER ||
    "neo4j";

  const password =
    (neo4jSection.password as string) ||
    process.env.NEO4J_PASSWORD ||
    "";

  return { uri, user, password };
}

/**
 * Resolve Neo4j search parameters from plugin config.
 */
export function resolveNeo4jSearchConfig(
  pluginConfig: Record<string, unknown> | undefined,
): Neo4jSearchConfig {
  const retrievalSection = (pluginConfig?.retrieval ?? {}) as Record<string, unknown>;
  const graphSection = (retrievalSection.graph ?? {}) as Record<string, unknown>;

  return {
    enabled: (graphSection.enabled as boolean) ?? true,
    searchLimit: (graphSection.searchLimit as number) ?? 5,
  };
}

/**
 * Resolve embedding config from plugin config or defaults.
 */
export interface EmbeddingPluginConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
}

export function resolveEmbeddingConfig(
  pluginConfig: Record<string, unknown> | undefined,
): EmbeddingPluginConfig | null {
  const embeddingSection = (pluginConfig?.embedding ?? {}) as Record<string, unknown>;
  if (!embeddingSection) return null;

  const model = (embeddingSection.model as string) || process.env.GM_EMBED_MODEL || "Qwen3.5-Embedding-0.6B-GGUF";
  const baseURL = (embeddingSection.baseURL as string) || process.env.GM_EMBED_BASE_URL || "http://127.0.0.1:11434/v1";
  const dimensions = (embeddingSection.dimensions as number) ?? 1024;

  return { model, baseURL, dimensions };
}
