/**
 * lcm-graph-extra — Neo4j 凭证解析助手
 *
 * 从以下优先级读取凭证（高优先级覆盖低）：
 *   1. 配置文件 config.neo4j
 *   2. 环境变量 NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD
 *   3. 默认值
 *
 * 彻底消除源码硬编码凭证的安全风险。
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
 * 从插件配置和环境变量解析 Neo4j 连接凭证。
 *
 * @param pluginConfig 插件的 config 对象，从中读取 neo4j.uri / neo4j.user / neo4j.password
 * @returns 解析后的连接配置
 */
export function resolveNeo4jConfig(
  pluginConfig: Record<string, unknown> | undefined,
): Neo4jConnectionConfig {
  const neo4jSection = (pluginConfig?.neo4j ?? {}) as Record<string, unknown>;

  const uri =
    (neo4jSection.uri as string) ||
    process.env.NEO4J_URI ||
    'bolt://localhost:7687';

  const user =
    (neo4jSection.user as string) ||
    process.env.NEO4J_USER ||
    'neo4j';

  const password =
    (neo4jSection.password as string) ||
    process.env.NEO4J_PASSWORD ||
    '';

  return { uri, user, password };
}

/**
 * 从插件配置解析 Neo4j 搜索参数。
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
