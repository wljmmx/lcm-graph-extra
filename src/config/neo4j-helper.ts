/**
 * lcm-graph-extra — Neo4j credential resolver
 *
 * Resolves credentials with fallback priority:
 *   1. Plugin config (config.neo4j)
 *   2. openclaw.json plugins.entries.lcm-graph-extra.config.neo4j
 *   3. Environment variables (NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD)
 *   4. Sensible defaults
 *
 * Eliminates hardcoded credentials in source code.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

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
 * Try to load neo4j config from openclaw.json entries section.
 */
function loadFromOpenclawJson(): { uri?: string; user?: string; password?: string } | null {
  try {
    const path = `${homedir()}/.openclaw/openclaw.json`;
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const entries = data?.plugins?.entries || data?.entries || {};
    const neo4j = entries['lcm-graph-extra']?.config?.neo4j;
    if (neo4j && typeof neo4j === 'object') {
      return { uri: neo4j.uri, user: neo4j.user, password: neo4j.password };
    }
  } catch {
    // ignore
  }
  return null;
}

// Cache the entries-loaded config
let _entriesCache: { uri?: string; user?: string; password?: string } | null = null;

function getEntriesConfig(): { uri?: string; user?: string; password?: string } | null {
  if (_entriesCache === null) {
    _entriesCache = loadFromOpenclawJson();
  }
  return _entriesCache;
}

/**
 * Resolve Neo4j connection credentials from config/env/defaults.
 */
export function resolveNeo4jConfig(
  pluginConfig: Record<string, unknown> | undefined,
): Neo4jConnectionConfig {
  const neo4jSection = (pluginConfig?.neo4j ?? {}) as Record<string, unknown>;

  // Only trust plugin config if it has a non-empty URI
  const pluginUri = (neo4jSection.uri as string) || '';
  
  // Try entries config if plugin config doesn't have valid URI
  const entriesConfig = getEntriesConfig();
  
  const uri =
    (pluginUri && !pluginUri.includes('localhost') ? pluginUri : undefined) ||
    entriesConfig?.uri ||
    process.env.NEO4J_URI ||
    "bolt://localhost:7687";

  const user =
    (neo4jSection.user as string) ||
    entriesConfig?.user ||
    process.env.NEO4J_USER ||
    "neo4j";

  const password =
    (neo4jSection.password as string) ||
    entriesConfig?.password ||
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
  keepAlive?: string;
}

export function resolveEmbeddingConfig(
  pluginConfig: Record<string, unknown> | undefined,
): EmbeddingPluginConfig | null {
  const embeddingSection = (pluginConfig?.embedding ?? {}) as Record<string, unknown>;
  if (!embeddingSection) return null;

  const model = (embeddingSection.model as string) || process.env.GM_EMBED_MODEL || "Qwen3.5-Embedding-0.6B-GGUF";
  const baseURL = (embeddingSection.baseURL as string) || process.env.GM_EMBED_BASE_URL || "http://127.0.0.1:11434/v1";
  const dimensions = (embeddingSection.dimensions as number) ?? 1024;
  const keepAlive = (embeddingSection.keepAlive as string) || "1h";

  return { model, baseURL, dimensions, keepAlive };
}
