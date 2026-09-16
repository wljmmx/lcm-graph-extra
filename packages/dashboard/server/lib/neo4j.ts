/**
 * Neo4j 只读连接工具。
 *
 * 复用主包的 neo4j-driver，配置从环境变量读取。
 * 单例 driver，每次查询开新 session 用完关闭（driver 自身复用连接池）。
 *
 * 仅提供只读查询能力（runReadQuery），写操作走 MCP（lcmg_forget / lcmg_pin 等）。
 */

import neo4j, { type Driver, type Session, type QueryResult } from 'neo4j-driver';

// 单例 driver
let driverInstance: Driver | null = null;

/**
 * 是否显式配置了 NEO4J_PASSWORD（非空）。
 * security: 显式配置连接却缺失口令时，禁止静默回退到众所周知的默认口令
 * （默认凭据 + 网络可达 = 可被猜解的读/写入口，违反"永不内置默认凭据"安全实践）。
 */
export function isExplicitNeo4jPassword(): boolean {
  return process.env.NEO4J_PASSWORD !== undefined && process.env.NEO4J_PASSWORD !== '';
}

/**
 * 从环境变量获取 Neo4j 配置。
 * - 完全未配置：本地开发默认 bolt://localhost:7687 / neo4j / neo4j（与 Neo4j 官方默认一致，不视为生产）。
 * - 显式配置了 NEO4J_URI / NEO4J_USER 但未提供 NEO4J_PASSWORD：直接失败并给出清晰指引，
 *   而不是继续使用默认口令 —— 这是最常见"弱默认口令"落地的路径。
 */
function getNeo4jConfig(): { uri: string; user: string; password: string } {
  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER ?? 'neo4j';
  if (isExplicitNeo4jPassword()) {
    return { uri, user, password: process.env.NEO4J_PASSWORD as string };
  }
  const explicitConnection =
    process.env.NEO4J_URI !== undefined || process.env.NEO4J_USER !== undefined;
  if (explicitConnection) {
    throw new Error(
      '[security] NEO4J_PASSWORD is required when NEO4J_URI or NEO4J_USER is explicitly set. ' +
        'Refusing to fall back to the well-known default password "neo4j". ' +
        'Set a strong NEO4J_PASSWORD before starting the dashboard.',
    );
  }
  return { uri, user, password: 'neo4j' };
}

/** 获取 Neo4j driver 单例（懒加载） */
export function getNeo4jDriver(): Driver {
  if (driverInstance) return driverInstance;
  const { uri, user, password } = getNeo4jConfig();
  driverInstance = neo4j.driver(uri, neo4j.auth.basic(user, password));
  return driverInstance;
}

/** 获取一个 session（调用方负责关闭） */
export function getNeo4jSession(): Session {
  return getNeo4jDriver().session();
}

/**
 * 执行只读 Cypher 查询（自动开/关 session）。
 *
 * @param cypher Cypher 语句
 * @param params 参数
 * @returns QueryResult（包含 records）
 */
export async function runReadQuery(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<QueryResult> {
  const session = getNeo4jSession();
  try {
    // default 隐式事务即可，只读查询无需显式 transaction
    return await session.run(cypher, params);
  } finally {
    // 用完即关，避免连接泄漏
    await session.close().catch(() => {
      // 忽略关闭错误
    });
  }
}

/**
 * P3-4: 执行写入 Cypher 查询（自动开/关 session，显式事务）。
 * 用于标签合并等管理操作，区别于 read-only 查询。
 *
 * security: 直连 Neo4j 写是"写操作一律走 MCP 白名单转发"规则的例外（当前仅
 * experience tags merge 使用）。为避免破坏本地全默认部署，未显式配置
 * NEO4J_PASSWORD 时仅打印告警不阻断；生产部署必须配置强口令，并建议在日志
 * 采集侧对 [security] 前缀告警做哨兵监控（后续演进：收敛 tags merge 到 MCP 工具）。
 */
export async function runWriteQuery(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<QueryResult> {
  if (!isExplicitNeo4jPassword()) {
    process.stderr.write(
      '[security] runWriteQuery: NEO4J_PASSWORD is not explicitly set — direct Neo4j write uses a well-known default credential. For production, always set a strong NEO4J_PASSWORD.\n',
    );
  }
  const session = getNeo4jSession();
  const tx = session.beginTransaction();
  try {
    const result = await tx.run(cypher, params);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * 把 Neo4j Integer / 普通值安全转成 JS number。
 * neo4j-driver 对大整数返回自定义 Integer 类型，需显式转。
 */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  // neo4j Integer 形态
  const i = v as { toNumber?: () => number; low?: number; high?: number };
  if (typeof i.toNumber === 'function') return i.toNumber();
  if (typeof i.low === 'number') return i.low;
  return null;
}

/** 把可能为字符串/数组的 tag 字段拆分为数组 */
export function splitTag(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.length > 0) as string[];
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/** 关闭 driver（优雅关闭用，对外别名 closeNeo4j） */
export async function closeNeo4jDriver(): Promise<void> {
  if (driverInstance) {
    try {
      await driverInstance.close();
    } catch {
      // 忽略关闭错误
    }
    driverInstance = null;
  }
}

/** 优雅关闭别名（设计文档约定导出名） */
export const closeNeo4j = closeNeo4jDriver;
