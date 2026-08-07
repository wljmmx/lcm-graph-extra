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
import { getGlobalLogger } from '../utils/logger.js';

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
  } catch (e) {
    // ignore
    getGlobalLogger()?.debug?.("openclaw.json neo4j config load failed", { err: e instanceof Error ? e.message : String(e) });
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
 *
 * Priority: plugin config > entries config > env vars > defaults.
 *
 * v2.7.0 P1-FIX: 移除 `!pluginUri.includes('localhost')` 过滤器。
 * 修复前：包含 localhost 的 URI 被丢弃，导致本地开发环境配置被忽略，
 * 回退到 entriesConfig 或环境变量，若后者未配置则落到默认值 bolt://localhost:7687。
 * 若实际 Neo4j 运行在 localhost 的不同端口，将导致连接失败。
 * 修复后：信任用户显式配置的 URI，无论是否包含 localhost。
 */
export function resolveNeo4jConfig(
  pluginConfig: Record<string, unknown> | undefined,
): Neo4jConnectionConfig {
  const neo4jSection = (pluginConfig?.neo4j ?? {}) as Record<string, unknown>;

  const pluginUri = (neo4jSection.uri as string) || '';
  
  // Try entries config if plugin config doesn't have valid URI
  const entriesConfig = getEntriesConfig();
  
  const uri =
    pluginUri ||
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
 * Uses EmbeddingConfig type from graph-memory-pro for unified configuration.
 */
import type { EmbeddingConfig } from '../types.js';
import { cleanBaseURL } from '../utils/url.js';

export function resolveEmbeddingConfig(
  pluginConfig: Record<string, unknown> | undefined,
): EmbeddingConfig | null {
  const embeddingSection = (pluginConfig?.embedding ?? {}) as Record<string, unknown>;
  // P1-6 BUG-3: 原代码 `if (!embeddingSection) return null` 为死分支
  // （`?? {}` 后永不 falsy）。改为：当 embedding section 完全为空且无环境变量时返回 null，
  // 让调用方走默认 embedding 路径，避免返回无效配置误导。
  const hasEmbeddingConfig =
    Object.keys(embeddingSection).length > 0 ||
    process.env.GM_EMBED_MODEL ||
    process.env.GM_EMBED_BASE_URL ||
    process.env.GM_EMBED_API_KEY;
  if (!hasEmbeddingConfig) return null;

  const model = (embeddingSection.model as string) || process.env.GM_EMBED_MODEL || "Qwen3.5-Embedding-0.6B-GGUF";
  // 清洗 baseURL：用户从 markdown 复制时可能混入反引号/引号/首尾空格
  // BUGFIX(P0-5): 默认改为 Ollama 原生端点（不带 /v1），走 /api/embed 而非 /v1/embeddings。
  // 原因：Ollama 的 OpenAI 兼容层 (/v1/*) 不识别 keep_alive 参数，导致模型反复卸载加载。
  const rawBaseURL = (embeddingSection.baseURL as string) || process.env.GM_EMBED_BASE_URL || "http://127.0.0.1:11434";
  const baseURL = cleanBaseURL(rawBaseURL);
  const dimensions = (embeddingSection.dimensions as number) ?? 1024;
  const keepAlive = (embeddingSection.keepAlive as string) || "-1";
  // P1-6 BUG-3: 原返回对象丢失 apiKey 与 options，导致需要鉴权的远程 embedding 端点不可用。
  const apiKey = (embeddingSection.apiKey as string) || process.env.GM_EMBED_API_KEY || undefined;
  const options = (embeddingSection.options as Record<string, number | boolean | string>) || undefined;

  const result: EmbeddingConfig = { model, baseURL, dimensions, keepAlive };
  if (apiKey) result.apiKey = apiKey;
  if (options) result.options = options;
  return result;
}
