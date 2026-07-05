/**
 * lcm-graph-extra — Neo4j Graph Search Adapter
 *
 * Bridges lcm-graph-extra with graph-memory-pro's compiled module exports.
 * Dynamically imports from graph-memory-pro/dist/index.js.
 * Uses Recaller.recall(), searchNodes, upsertNode/upsertEdge.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as neo4jDriver from 'neo4j-driver';
import type { RetrievalResult, RetrievalSource, RetrievalType } from '../types.js';
import type { Neo4jConfig } from '../types.js';
import { ConflictLogger } from '../async/conflict-logger.js';
import type { EmbeddingConfig } from '../types.js';
import { acquireDriver, releaseDriver } from './connection-pool';
import { createLocalEmbedFn } from './embed-fn';
import type { Logger } from '../utils/logger.js';
import { resolveLogger } from '../utils/logger.js';
import { cleanBaseURL, withKeepAliveIfOllama } from '../utils/url.js';
// P2-3 H-16: 接入集中化默认常量（maxRetries / reconnectCooldownMs / searchCache*）
import { DEFAULTS } from '../config/defaults.js';


class LRUCache<K, V> {
  private map = new Map<K, { value: V; expiresAt: number }>();
  constructor(private capacity: number, private ttlMs: number) {}
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const e = this.map.get(key)!;
    if (Date.now() > e.expiresAt) { this.map.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e);
    return e.value;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

export interface GraphAdapterConfig {
  enabled: boolean;
  searchLimit: number;
  embedding?: EmbeddingConfig;
}

const _gmpRequire = createRequire(import.meta.url);

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(homedir(), '.openclaw');

/**
 * P3-3: 解析 graph-memory-pro 模块路径（单一来源，去除 graph-adapter / tools 重复逻辑）。
 *
 * 解析优先级：
 *   1. 环境变量 GM_PRO_PATH
 *   2. require.resolve('@openclaw/graph-memory-pro/dist/index.js') —— 取其目录
 *   3. 回退到 ${OPENCLAW_DIR}/extensions/graph-memory-pro
 *
 * 返回 { path, source } 供调用方记录实际使用的路径与来源。
 */
export function resolveGmProPath(): { path: string; source: 'env' | 'require' | 'fallback' } {
  if (process.env.GM_PRO_PATH) {
    return { path: process.env.GM_PRO_PATH, source: 'env' };
  }
  try {
    const resolved = _gmpRequire.resolve('@openclaw/graph-memory-pro/dist/index.js');
    const dir = resolved.endsWith('/dist/index.js') ? resolved.slice(0, -'/dist/index.js'.length) : resolved;
    return { path: dir, source: 'require' };
  } catch {
    return { path: `${OPENCLAW_DIR}/extensions/graph-memory-pro`, source: 'fallback' };
  }
}

const _GM_PRO_RESOLVED = resolveGmProPath();
const GM_PRO_PATH = _GM_PRO_RESOLVED.path;

/**
 * P2-17: 统一 GmConfig 默认值。原代码在 connect/runMaintenance 等 4 处重复硬编码
 * compactTurnCount/recallMaxNodes/dedupThreshold/pagerankDamping 等参数，
 * 易漂移且用户无法调优。集中到 DEFAULT_GM_CONFIG，buildGmConfig 附加 neo4j。
 */
const DEFAULT_GM_CONFIG = {
  compactTurnCount: 10,
  recallMaxNodes: 8,
  recallMaxDepth: 2,
  freshTailCount: 5,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 12,
};

function buildGmConfig(neo4jConfig: Neo4jConfig, overrides?: Partial<typeof DEFAULT_GM_CONFIG>): Record<string, any> {
  return { neo4j: neo4jConfig, ...DEFAULT_GM_CONFIG, ...overrides };
}

// P2-17: 导出供 tools.ts 等其他模块复用，避免 GmConfig 重复硬编码
export { DEFAULT_GM_CONFIG, buildGmConfig };

/** Map node label to result type */
function inferType(label: string): RetrievalType {
  const u = label.toUpperCase();
  if (['SKILL','CONCEPT','CAPABILITY','METHOD','TOOL'].includes(u)) return 'definition';
  if (['RELATION','EDGE'].includes(u)) return 'relation';
  return 'raw';
}

function mapEntityType(raw: string): string {
  const t = (raw || 'CONCEPT').toUpperCase();
  if (['SKILL','CAPABILITY','METHOD','TOOL','BEST_PRACTICE','CONCEPT','KNOWLEDGE'].includes(t)) return 'SKILL';
  if (['EVENT','BUG','ERROR','ISSUE','PROBLEM'].includes(t)) return 'EVENT';
  return 'TASK';
}

function mapEdgeType(raw: string): string {
  const t = raw.toUpperCase();
  if (['USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH','RELATES_TO'].includes(t)) return t;
  if (['RELATED_TO','REFERENCES','USES'].includes(t)) return 'USED_SKILL';
  if (['RELATES','CROSS_REFERENCE','CONNECTS'].includes(t)) return 'RELATES_TO';
  if (['FIXES','RESOLVES','SOLVES'].includes(t)) return 'SOLVED_BY';
  if (['DEPENDS_ON','NEEDS','PREREQUISITE'].includes(t)) return 'REQUIRES';
  if (['REPLACES','SUPERSEDES','UPDATES'].includes(t)) return 'PATCHES';
  if (['CONFLICTS','INCOMPATIBLE'].includes(t)) return 'CONFLICTS_WITH';
  return 'USED_SKILL';
}

function makeNodeId(name: string, typeName: string): string {
  return `${typeName.toLowerCase()}-${createHash('sha256').update(`${typeName}:${name}`).digest('hex').slice(0, 12)}`;
}

type GmModule = Record<string, any>;

/** SEC-L: 简单字符串 hash（djb2 变体），用于 searchCache key 后缀防碰撞。 */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export class GraphAdapter {
  public conflictLogger = new ConflictLogger();
  private mod: GmModule | null = null;
  private driver: any = null;
  private _connectFailed = false;
  private _connectRetryCount = 0;
  // P2-3 H-16: 重试次数与冷却期改为引用 DEFAULTS.graph，避免魔术数字散落
  private readonly maxRetries = DEFAULTS.graph.maxRetries;
  // P1-10 GMR-1: 连接失败冷却期。原代码 _connectFailed=true 后无自动恢复路径，
  // 一旦 graph-memory-pro 短暂不可用，L3/L4 永久降级直到插件重载。
  // 加 _lastFailTime + 冷却期（60s），冷却期满后自动重置允许重试。
  private _lastFailTime = 0;
  private readonly reconnectCooldownMs = DEFAULTS.graph.reconnectCooldownMs;
  private config: GraphAdapterConfig;
  private neo4jConfig: Neo4jConfig;
  private logger: Logger;
  private _recaller: any = null;
  private _gmConfig: Record<string, any> = {};
  private _embedFn: any = null;
  private _llm?: (system: string, user: string) => Promise<string>;

  // P2-3 H-16: searchWithCache 的 LRU 容量与 TTL 改为引用 DEFAULTS.graph
  private searchCache = new LRUCache(DEFAULTS.graph.searchCacheSize, DEFAULTS.graph.searchCacheTtlMs);

  constructor(neo4jConfig: Neo4jConfig, config: GraphAdapterConfig, logger?: Logger) {
    this.neo4jConfig = neo4jConfig;
    this.config = config;
    this.logger = resolveLogger(logger);
  }

  async connect(): Promise<boolean> {
    try {
      // P3-3: 记录实际使用的 graph-memory-pro 路径与解析来源
      this.logger?.info?.('[graph-adapter] loading graph-memory-pro', { path: GM_PRO_PATH, source: _GM_PRO_RESOLVED.source });
      const mod = await import(`${GM_PRO_PATH}/dist/index.js`);
      this.mod = mod;
      this.driver = mod.getDriver?.() ?? null;
      if (!this.driver) {
        // graph-memory-pro 尚未初始化驱动 → 自己建一个
        // Use connection pool instead of creating new driver each time
        this.driver = await acquireDriver(this.neo4jConfig);
        if (this.driver) {
          try {
            await this.driver.verifyConnectivity();
          } catch (connErr) {
            this.logger?.warn?.(`[graph-adapter] connectivity verify failed, pool may recover: ${connErr}`);
          }
        }
      }

      // - Initialize Recaller (gm-pro dual-path recall) -
      try {
        // P2-17: 用 buildGmConfig 统一构建，避免重复硬编码
        const gmCfg: Record<string, any> = buildGmConfig(this.neo4jConfig);
        this._recaller = new mod.Recaller(this.driver, gmCfg);
        this._gmConfig = gmCfg;

        // Set embedding function for community generalized recall
        try {
          const ecfg = this.config.embedding;
          if (ecfg) {
            // 优先使用自带的 createLocalEmbedFn —— 明确在 HTTP body 中传递 keep_alive，
            // 确保 Ollama 保持模型驻留内存（默认 keep_alive=1h）。
            // graph-memory-pro 的 createEmbedFn 无法保证 keep_alive 被转发，仅作为 fallback。
            try {
              this._embedFn = createLocalEmbedFn(ecfg);
              this.logger?.info?.('[graph-adapter] Embedding initialized (local, keep_alive=' + (ecfg.keepAlive || '1h') + ')', { model: ecfg.model });
            } catch (localErr) {
              // 自带创建失败时 fallback 到 graph-memory-pro 的 createEmbedFn
              if (mod.createEmbedFn) {
                this._embedFn = mod.createEmbedFn({ ...ecfg });
                this.logger?.warn?.('[graph-adapter] Local embed fn failed, using graph-memory-pro createEmbedFn (keep_alive not guaranteed)', { err: localErr });
              } else {
                throw localErr;
              }
            }
            if (this._embedFn) {
              this._recaller.setEmbedFn(this._embedFn);
            }
          } else {
            this.logger?.warn?.('[graph-adapter] No embedding config provided, community recall disabled');
          }
        } catch (embedErr) {
          this.logger?.warn?.('[graph-adapter] Failed to init embedding for Recaller', { err: embedErr });
        }

        this.logger?.info?.('[graph-adapter] Recaller initialized (dual-path recall enabled)');
      } catch (initErr) {
        this.logger?.warn?.('[graph-adapter] Recaller init failed, falling back to searchNodes', { err: initErr });
        this._recaller = null;
      }

      // P1-10 GMR-1: 连接成功，重置失败计数与冷却时间
      this._connectRetryCount = 0;
      this._connectFailed = false;
      this._lastFailTime = 0;
      return true;
    } catch (err) {
      this._connectRetryCount++;
      this.logger?.warn?.(`[graph-adapter] connect attempt ${this._connectRetryCount}/${this.maxRetries} failed: ${err}`);
      if (this._connectRetryCount >= this.maxRetries) {
        this._connectFailed = true;
        this._lastFailTime = Date.now();
        this.logger?.error?.(`[graph-adapter] connect failed after ${this.maxRetries} attempts, will retry in ${this.reconnectCooldownMs / 1000}s`);
      }
      return false;
    }
  }

  /** Reset connection failure flag (called on retry / gateway restart) */
  resetConnectFlag(): void {
    this._connectFailed = false;
    this._connectRetryCount = 0;
    this._lastFailTime = 0;
  }

  /**
   * P1-10 GMR-1: 检查连接失败冷却期是否已过。如果冷却期满，自动重置失败标记，允许重试。
   * 返回 true 表示当前处于"失败锁定"状态（调用方应跳过），false 表示可以尝试 connect。
   */
  private _checkCooldownAndMaybeReset(): boolean {
    if (!this._connectFailed) return false;
    const elapsed = Date.now() - this._lastFailTime;
    if (elapsed >= this.reconnectCooldownMs) {
      this.logger?.info?.(`[graph-adapter] reconnect cooldown elapsed (${elapsed}ms), resetting failure flag for retry`);
      this._connectFailed = false;
      this._connectRetryCount = 0;
      this._lastFailTime = 0;
      return false;
    }
    return true; // 仍在冷却期，跳过
  }

  async search(query: string, limit?: number): Promise<RetrievalResult[]> {
    if (!this.config.enabled) return [];
    if (!this.mod) {
      // P1-10 GMR-1: 用冷却期检查代替原永久失败逻辑
      if (this._checkCooldownAndMaybeReset()) {
        this.logger?.warn?.(`[lcm-graph-extra] search: in reconnect cooldown, skipping`);
        return [];
      }
      await this.connect();
    }
    // AUDIT: connect() 可能成功加载 mod 但 this.driver 仍为 null
    // （gm-pro getDriver 返回 null + acquireDriver 失败），此时调用
    // mod.searchNodes(this.driver, ...) 会把 null 传给 gm-pro，
    // gm-pro 内部 driver.session() 抛 "Cannot read properties of null (reading 'session')"
    if (!this.mod || !this.driver) return [];
    const rl = limit ?? this.config.searchLimit;
    try {
      let nodes: any[] = [];

      // Prefer Recaller (dual-path: precise + generalized community recall)
      if (this._recaller) {
        try {
          const recallResult = await this._recaller.recall(query);
          nodes = recallResult.nodes ?? [];
          this.logger?.debug?.('[graph-adapter] Recaller returned', { nodeCount: nodes.length });
        } catch (recallErr) {
          this.logger?.warn?.('[graph-adapter] Recaller.recall failed, falling back', { err: recallErr });
        }
      }

      // Fallback to simple searchNodes if no results
      if (nodes.length === 0) {
        nodes = await this.mod.searchNodes(this.driver, query, rl);
      }
      // G-10: 过滤被主动遗忘（hard mode）标记为 superseded 的节点。
      // searchNodes / Recaller 来自外部 graph-memory-pro 模块，无法注入 WHERE 条件，
      // 因此在返回结果上做后置过滤。节点属性可能挂在 n.properties 上。
      let reranked = (nodes ?? []).filter((n: any) => {
        const st = n?.state ?? n?.properties?.state;
        return st !== 'superseded';
      });
      if (reranked.length >= 2) {
        const nodeIds = reranked.map((n: any) => n.id).filter(Boolean);
        if (nodeIds.length >= 2) {
          const pprScores = await this.rerankByPageRank(nodeIds);
          if (pprScores.size > 0) {
            reranked.sort((a: any, b: any) => {
              const sa = pprScores.get(a.id) ?? 0.5;
              const sb = pprScores.get(b.id) ?? 0.5;
              return sb - sa;
            });
          }
        }
      }
      return (reranked).map((n: any) => {
        const name = n.name ?? n.properties?.name ?? '';
        const label = n.type ?? n.labels?.[0] ?? 'TASK';
        const desc = n.description ?? n.properties?.description ?? '';
        const content = n.content ?? n.properties?.content ?? '';
        const ppr = n.pagerank ?? n.properties?.pagerank ?? 0.5;
        return {
          id: createHash('sha256').update(`g:${n.id ?? name}`).digest('hex').slice(0, 16),
          content: `[${label}] ${name}${desc ? '\n' + desc : ''}${content ? '\n' + String(content).slice(0, 500) : ''}`,
          source: 'graph' as RetrievalSource,
          type: inferType(label),
          score: (n.score ?? Number(ppr)) as number,
          metadata: { nodeId: n.id, nodeType: label, name, updatedAt: n.updatedAt ?? n.properties?.updatedAt ?? 0 },
        };
      });
    } catch (err) { this.logger?.error?.(`[lcm-graph-extra] search error: ${err}`); return []; }
  }

  /* @deprecated - cache-aware search wrapper */
  async searchWithCache(query: string, limit?: number): Promise<RetrievalResult[]> {
    // SEC-L: 修复前 key 仅截断前 200 字符，超长查询（>200）会碰撞。
    // 加 full-hash 后缀区分，前缀保留便于调试。
    const fullHash = hashString(query.toLowerCase().trim());
    const key = `s:${query.slice(0, 50).toLowerCase().trim()}:${fullHash}`;
    const cached = this.searchCache.get(key);
    if (cached) return cached as RetrievalResult[];
    let results = await this.search(query, limit);
    if (!Array.isArray(results)) results = [];
    // PERF-M2 M-2: 移除重复 rerank。search() 内部已在 nodes.length >= 2 时执行过 rerankByPageRank，
    // 此处重复调用纯属浪费。search() 未 rerank 的唯一情况是 nodes.length < 2，
    // 此时原 length >= 2 守卫也会跳过，故可安全移除。
    // Community enrichment — batch findById via raw Cypher (avoids N round-trips)
    const nodeIds = results.map(r => r.metadata?.nodeId).filter(Boolean);
    if (nodeIds.length > 0) {
      // AUDIT: searchWithCache 虽标记 @deprecated，但仍需防 driver 为 null 时
      // this.driver.session() 抛 "Cannot read properties of null (reading 'session')"
      if (!this.driver) return results;
      try {
        const session = this.driver.session();
        const placeholder = nodeIds.map((_, i) => `$nid${i}`).join(',');
        const batchResult = await session.run(
          `MATCH (n:Task|Skill|Event) WHERE n.id IN $ids RETURN n.id AS id, n.communityId AS communityId`,
          { ids: nodeIds },
        );
        const communityMap = new Map<string, string>();
        for (const record of batchResult.records) {
          const idField = record.get('id');
          const cid = record.get('communityId');
          if (idField && cid) communityMap.set((idField as any).toString(), (cid as any).toString());
        }
        // Apply community info to results
        for (const r of results) {
          const nid = String(r.metadata?.nodeId ?? '');
          if (nid && communityMap.has(nid)) {
            if (r.metadata) { r.metadata.communityId = communityMap.get(nid)!; }
          }
        }
        await session.close();
      } catch {}
    }
    this.searchCache.set(key, results);
    return results;
  }

  async searchExperience(
    query: string,
    options?: { context?: any; limit?: number },
  ): Promise<RetrievalResult[]> {
    if (!this.config.enabled) return [];
    if (!this.mod) {
      // P1-10 GMR-1: 用冷却期检查代替原永久失败逻辑
      if (this._checkCooldownAndMaybeReset()) {
        this.logger?.warn(`[lcm-graph-extra] searchExperience: in reconnect cooldown, skipping`);
        return [];
      }
      await this.connect();
    }
    if (!this.mod) return [];
    // AUDIT: 同 search() —— mod 已加载但 driver 为 null 时不能调用 searchNodes
    if (!this.driver) return [];
    // P3-9 GMR-3: 捕获到局部常量，跨 await 保持非空收窄，消除后续 this.mod! 非空断言
    const mod = this.mod;
    const rl = options?.limit ?? this.config.searchLimit;
    const ctx = options?.context;
    try {
      const nodes = await mod.searchNodes(this.driver, query, rl * 3);
      // G-10: 排除被主动遗忘（superseded）的节点
      const events = (nodes ?? []).filter((n: any) => {
        if ((n.type ?? n.labels?.[0]) !== 'EVENT') return false;
        const st = n?.state ?? n?.properties?.state;
        return st !== 'superseded';
      });

      // 场景优先级加权排序
      const ranked = events.map((evt: any) => {
        let scenarioBonus = 0;
        let techBonus = 0;
        const evtTags = evt.properties?.tags ?? {};

        if (ctx?.scenario) {
          for (const s of ctx.scenario) {
            if ((evtTags.scenario ?? []).includes(s)) scenarioBonus += 0.15;
          }
        }
        if (ctx?.techStack) {
          for (const t of ctx.techStack) {
            if ((evtTags.techStack ?? []).includes(t)) techBonus += 0.1;
          }
        }
        const urgencyBoost = (evtTags.severity === 'critical' && ctx?.urgency > 0.5) ? 0.2 : 0;

        return { ...evt, boostedScore: (Number(evt.properties?.pagerank ?? 0.5)) + scenarioBonus + techBonus + urgencyBoost };
      }).sort((a: any, b: any) => b.boostedScore - a.boostedScore);

      // P1-1 M-1: 消除 N+1 —— 原代码 per-event 调用 getEdgesForNodes（共 rl 次往返），
      // 改为一次性批量取所有 top events 的 edges，再在内存中按 source id 分组成 Map<eventId, edges[]>，
      // 遍历 topEvents 时从 Map 取对应 edges。
      const topEvents = ranked.slice(0, rl);
      const topIds = topEvents.map((evt: any) => evt.id).filter(Boolean);
      const rawEdges = topIds.length > 0 ? await mod.getEdgesForNodes(this.driver, topIds) : [];
      const allEdges: any[] = rawEdges ?? [];
      // 按 source id 分组（防御性多字段查找，兼容不同 edge 形态）
      const edgesBySource = new Map<string, any[]>();
      for (const e of allEdges) {
        const srcId = e.fromId ?? e.sourceId ?? e.from ?? e.source;
        if (!srcId) continue;
        const list = edgesBySource.get(srcId) ?? [];
        list.push(e);
        edgesBySource.set(srcId, list);
      }

      const out: RetrievalResult[] = [];
      for (const evt of topEvents) {
        const name = evt.name ?? evt.properties?.name ?? '';
        const desc = evt.description ?? evt.properties?.description ?? '';
        const edges = edgesBySource.get(evt.id) ?? [];
        // 防御性多字段查找 type/label（兼容不同 edge 形态）
        const sols = edges.filter((e: any) => (e.type ?? e.label) === 'SOLVED_BY');
        let expText = `[EVENT] ${name}\n${desc}${sols.length > 0 ? '\nSolutions:' : ''}`;
        for (const s of sols) expText += `\n- ${s.targetName ?? 'Unknown'}`;
        out.push({
          id: createHash('sha256').update(`exp:${evt.id ?? name}`).digest('hex').slice(0, 16),
          content: expText, source: 'graph' as RetrievalSource,
          type: 'definition' as RetrievalType,
          score: Math.min(0.8 + (ranked.indexOf(evt) < rl / 2 ? 0.15 : 0.05), 1),
          metadata: { experience: true, problemName: name, solutionCount: sols.length, updatedAt: evt.updatedAt ?? evt.properties?.updatedAt ?? 0 },
        });
      }
      return out;
    } catch { return []; }
  }


  /**
   * Batch upsert: single Cypher UNWIND + MERGE for nodes and edges.
   * Reduces N round-trips to O(1).
   */
  async batchUpsert(
    entities: Array<{ name: string; type: string; description: string; content: string; updatedAt?: number }>,
    relations: Array<{ from: string; to: string; type: string; instruction?: string; updatedAt?: number }>,
  ): Promise<{ upserted: number; conflicts: number }> {
    if (!this.driver) return { upserted: 0, conflicts: 0 };

    const validEntities = entities.filter((e) => e.name?.trim());
    const validRelations = relations.filter((r) => r.from?.trim() && r.to?.trim());

    if (validEntities.length === 0 && validRelations.length === 0) {
      return { upserted: 0, conflicts: 0 };
    }

    const session = this.driver.session();
    let uc = 0;
    let cc = 0;

    try {
      // N-1: Sync 算法升级 —— updatedAt 对比 + 增量 MERGE
      // 输入实体可选携带 updatedAt（毫秒时间戳）：
      //   - 若存在且大于现有节点：更新属性并刷新 updatedAt
      //   - 若存在但小于等于现有节点：跳过（保留更新，避免旧数据覆盖新数据）
      //   - 若不存在或节点不存在：插入并设置 createdAt + updatedAt
      // 未携带 updatedAt 时默认 Date.now()（等价于原全量覆盖语义）。
      if (validEntities.length > 0) {
        const now = Date.now();
        const nodeData = validEntities.map((e) => {
          const t = mapEntityType(e.type);
          const nid = makeNodeId(e.name, t);
          const ts = typeof e.updatedAt === 'number' && e.updatedAt > 0 ? e.updatedAt : now;
          return {
            id: nid,
            label: t,
            name: e.name.trim(),
            description: (e.description ?? '').slice(0, 500),
            content: (e.content ?? '').slice(0, 2000),
            status: 'active',
            pagerank: 0.5,
            updatedAt: ts,
          };
        });

        // P1-2 M-1: 节点存在性检查改为单条 UNWIND（原 per-node N 次 MATCH 查询）
        const existingResult = await session.run(
          `UNWIND $nodes AS node MATCH (n { id: node.id }) RETURN collect(node.id) AS existingIds`,
          { nodes: nodeData },
        );
        cc += (existingResult.records[0]?.get('existingIds') ?? []).length;

        // N-1: 增量 MERGE —— 按 label 分组 UNWIND MERGE，实现 updatedAt 对比
        // 仅在节点不存在 OR 节点存在但 incoming updatedAt > existing updatedAt 时才更新属性。
        // 这样重放旧数据不会覆盖新数据，支持增量同步。
        //
        // 实现方式：按 label 分组，每组一条 UNWIND MERGE（关系类型不可参数化的同构问题）
        const nodesByLabel = new Map<string, typeof nodeData>();
        for (const n of nodeData) {
          const arr = nodesByLabel.get(n.label) || [];
          arr.push(n);
          nodesByLabel.set(n.label, arr);
        }

        for (const [label, nodes] of nodesByLabel) {
          const cypher = `
            UNWIND $nodes AS node
            MERGE (n:\`${label}\` { id: node.id })
            ON CREATE SET
              n.name = node.name,
              n.description = node.description,
              n.content = node.content,
              n.status = node.status,
              n.pagerank = node.pagerank,
              n.updatedAt = node.updatedAt,
              n.createdAt = node.updatedAt
            ON MATCH SET
              n.name = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.name ELSE n.name END,
              n.description = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.description ELSE n.description END,
              n.content = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.content ELSE n.content END,
              n.status = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.status ELSE n.status END,
              n.pagerank = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.pagerank ELSE n.pagerank END,
              n.updatedAt = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.updatedAt ELSE n.updatedAt END
            RETURN count(*) AS cnt
          `;
          const result = await session.run(cypher, { nodes });
          uc += result.records[0]?.get('cnt') ?? 0;
        }
      }

      // P1-2 M-1: 边 upsert 改为按 type 分组的 UNWIND MERGE
      // （Cypher 关系类型不可参数化，故按 mapEdgeType 结果分组后逐组单条 UNWIND MERGE）
      // N-1: 边也支持增量 updatedAt 对比
      if (validRelations.length > 0) {
        const now = Date.now();
        const edgesByType = new Map<string, any[]>();
        for (const rel of validRelations) {
          const mt = mapEdgeType(rel.type);
          const ts = typeof rel.updatedAt === 'number' && rel.updatedAt > 0 ? rel.updatedAt : now;
          const entry = {
            fromId: makeNodeId(rel.from, 'TASK'),
            toId: makeNodeId(rel.to, 'TASK'),
            instruction: (rel.instruction ?? '').slice(0, 500),
            weight: 1.0,
            updatedAt: ts,
          };
          const list = edgesByType.get(mt) ?? [];
          list.push(entry);
          edgesByType.set(mt, list);
        }
        for (const [mt, group] of edgesByType) {
          await session.run(
            `UNWIND $edges AS edge MATCH (a { id: edge.fromId }), (b { id: edge.toId }) MERGE (a)-[r:${mt}]->(b) ON CREATE SET r.instruction = edge.instruction, r.weight = edge.weight, r.updatedAt = edge.updatedAt, r.createdAt = edge.updatedAt ON MATCH SET r.instruction = CASE WHEN edge.updatedAt > coalesce(r.updatedAt, 0) THEN edge.instruction ELSE r.instruction END, r.weight = CASE WHEN edge.updatedAt > coalesce(r.updatedAt, 0) THEN edge.weight ELSE r.weight END, r.updatedAt = CASE WHEN edge.updatedAt > coalesce(r.updatedAt, 0) THEN edge.updatedAt ELSE r.updatedAt END`,
            { edges: group },
          );
        }
      }

      // P2-AUDIT: 关系计数不再混入 uc（upserted 节点数），
      // 避免调用方收到虚高的节点数。关系仍正常 upsert。
      // uc += validRelations.length;
    } catch (err) {
      this.logger?.error?.(`[lcm-graph-extra] batchUpsert error: ${err}`);
    } finally {
      await session.close();
    }

    return { upserted: uc, conflicts: cc };
  }

  async upsertEntities(
    entities: Array<{ name: string; type: string; description: string; content: string }>,
    relations: Array<{ from: string; to: string; type: string; instruction?: string }>,
  ): Promise<{ upserted: number; conflicts: number }> {
    const m3 = this.mod ?? await this.connect().then(() => this.mod);
    if (!m3) return { upserted: 0, conflicts: 0 };
    let cc = 0, uc = 0;
    const now = Date.now();
    try {
      for (const e of entities) {
        if (!e.name?.trim()) continue;
        const t = mapEntityType(e.type), nid = makeNodeId(e.name, t);
        const existing = await m3.findById(this.driver, nid);
        if (existing) {
          const ec = existing.properties?.content ?? '';
          if (ec.trim() !== (e.content ?? '').trim()) {
            const decision = this.conflictLogger.resolve(e.name.trim(), t,
              { updatedAt: existing.properties?.updatedAt ?? 0, validatedCount: existing.properties?.validatedCount ?? 0, content: ec },
              { updatedAt: now, validatedCount: 1, content: e.content ?? '' });
            cc++;

            // Execute decision-based upsert strategy
            if (decision === 'keep_existing') {
              // Skip upsert - keep existing content intact
              uc++;
              continue;
            } else if (decision === 'replace_with_new') {
              // Full replacement with new content
              await m3.upsertNode(this.driver, {
                id: nid, type: t, name: e.name.trim(),
                description: (e.description ?? '').slice(0, 500),
                content: (e.content ?? '').slice(0, 2000),
                status: 'active', pagerank: 0.5,
                validatedCount: 1,
                createdAt: existing.properties?.createdAt ?? now, updatedAt: now,
              });
              uc++;
              continue;
            } else if (decision === 'merge_both') {
              // Merge existing + new content
              const mergedContent = (ec.trim() || '') + '\n---\n' + ((e.content ?? '').trim() || '');
              await m3.upsertNode(this.driver, {
                id: nid, type: t, name: e.name.trim(),
                description: (e.description ?? '').slice(0, 500),
                content: mergedContent.slice(0, 2000),
                status: 'active', pagerank: 0.5,
                validatedCount: (existing.properties?.validatedCount ?? 0) + 1,
                createdAt: existing.properties?.createdAt ?? now, updatedAt: now,
              });
              uc++;
              continue;
            }
          }
        }
        // No conflict or no decision path matched - standard upsert
        await m3.upsertNode(this.driver, {
          id: nid, type: t, name: e.name.trim(),
          description: (e.description ?? '').slice(0, 500),
          content: (e.content ?? '').slice(0, 2000),
          status: 'active', pagerank: 0.5,
          validatedCount: existing ? (existing.properties?.validatedCount ?? 0) + 1 : 1,
          createdAt: existing ? (existing.properties?.createdAt ?? now) : now, updatedAt: now,
        });
        uc++;
      }
      for (const rel of relations) {
        if (!rel.from?.trim() || !rel.to?.trim()) continue;
        const mt = mapEdgeType(rel.type);
        await m3.upsertEdge(this.driver, {
          id: makeNodeId(rel.from + '-' + rel.to, mt), type: mt,
          fromId: makeNodeId(rel.from, 'TASK'), toId: makeNodeId(rel.to, 'TASK'),
          instruction: (rel.instruction ?? '').slice(0, 500),
          condition: '', weight: 1.0, createdAt: now, updatedAt: now,
        });
      }
    } catch (err) { this.logger?.error?.(`[lcm-graph-extra] upsert error: ${err}`); }
    return { upserted: uc, conflicts: cc };
  }

  // P3-9 GMR-4: processFeedback 已移除 —— 空实现（恒返回 0）且无任何生产代码调用，属死代码。
  
  /**
   * Run raw Cypher query (for experience storage layer).
   */
  async query<T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    if (!this.driver) return [];
    const session = this.driver.session();
    try {
      const safeParams = params ? Object.fromEntries(
        Object.entries(params).map(([k, v]) => {
          if (typeof v !== "number") return [k, v];
          // LIMIT/OFFSET/count params must be Neo4j integers
          if (/^(limit|max_depth|iterations|timeout)$/.test(k)) {
            return [k, neo4jDriver.int(Math.trunc(v))];
          }
          // Score/threshold params keep float precision
          return [k, v];
        })
      ) : {};
      const result = await session.run(cypher, safeParams);
      return result.records.map((r: any) => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }


  /**
   * PageRank re-ranking
   */
  async rerankByPageRank(nodeIds: string[]): Promise<Map<string, number>> {
    if (!this.mod || !this.driver || nodeIds.length < 2) return new Map();
    try {
      // P2-17: 用 buildGmConfig 统一构建（PPR 只用 pagerank* 字段）
      // P0-AUDIT: 不传 undefined 覆盖值，buildGmConfig 内部 spread 会
        // 把 undefined 写进配置对象，导致下游 PPR 算法收到 undefined 而非默认值。
        const cfg = buildGmConfig(this.neo4jConfig);
      const result = await this.mod.personalizedPageRank(this.driver, nodeIds, nodeIds, cfg);
      // gm-pro returns PPRResult with scores Map
      return result.scores ?? new Map();
    } catch (err) {
      this.logger?.error?.('[lcm-graph-extra] PPR rerank failed', { err });
      return new Map();
    }
  }

  /**
   * Extract triplets from a conversation turn and upsert to Neo4j graph.
   */
  async extractAndUpsertFromTurn(
    llmConfig: { apiKey?: string; baseURL?: string; model?: string; keepAlive?: string; complete?: (p: { messages: any[]; model?: string; maxTokens?: number; temperature?: number; systemPrompt?: string; signal?: AbortSignal; purpose?: string }) => Promise<{ text: string; provider?: string; model?: string }> },
    userContent: string,
    assistantContent: string,
  ): Promise<{ nodes: number; edges: number }> {
    if (!this.mod) return { nodes: 0, edges: 0 };
    try {
      const { extractTriplets } = this.mod as any;
      if (!extractTriplets) return { nodes: 0, edges: 0 };
      const llmFn = this.buildLlmFn(llmConfig);
      if (!llmFn) return { nodes: 0, edges: 0 };
      const result = await extractTriplets(llmFn, userContent, assistantContent);
      if (!result || (!result.nodes?.length && !result.edges?.length)) return { nodes: 0, edges: 0 };
      const entities = (result.nodes ?? []).map((n: any) => ({ name: n.name ?? '', type: n.type ?? 'TASK', description: n.description ?? '', content: n.content ?? '' })).filter((e: any) => e.name?.trim());
      const relations = (result.edges ?? []).map((e: any) => ({ from: e.from ?? e.source ?? '', to: e.to ?? e.target ?? '', type: e.type ?? 'RELATED_TO', instruction: e.instruction ?? e.description ?? '' })).filter((r: any) => r.from?.trim() && r.to?.trim());
      if (entities.length > 0 || relations.length > 0) await this.batchUpsert(entities, relations);
      return { nodes: entities.length, edges: relations.length };
    } catch (err) {
      this.logger?.error?.('[lcm-graph-extra] extractAndUpsertFromTurn error', { err });
      return { nodes: 0, edges: 0 };
    }
  }

  private buildLlmFn(config?: { apiKey?: string; baseURL?: string; model?: string; keepAlive?: string; complete?: (p: { messages: any[]; model?: string; maxTokens?: number; temperature?: number; systemPrompt?: string; signal?: AbortSignal; purpose?: string }) => Promise<{ text: string; provider?: string; model?: string }> }): ((system: string, user: string) => Promise<string>) | null {
    // 优先用 SDK 提供的 runtimeContext.llm.complete（已认证、已配置、跟随主会话模型）
    // 包装成 extractTriplets 期望的 (system, user) => Promise<string> 签名
    if (config?.complete && typeof config.complete === 'function') {
      return async (system, user) => {
        const result = await config.complete!({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          maxTokens: 1024,
          temperature: 0.3,
          purpose: 'lcm-graph-extra:triplet-extraction',
        });
        return result?.text ?? '';
      };
    }
    if (!config?.model && !config?.apiKey) return null;
    // 清洗 baseURL：去掉反引号/引号/首尾空格/尾斜杠
    const baseUrl = cleanBaseURL(config.baseURL || 'https://api.openai.com/v1');
    const model = config.model || 'gpt-4o-mini';
    const keepAlive = config.keepAlive;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;
    return async (system, user) => {
      // 仅 Ollama 端点注入 keep_alive，避免冷启动延迟
      const body = withKeepAliveIfOllama(
        baseUrl,
        { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1024, temperature: 0.3 },
        keepAlive,
      );
      const res = await fetch(baseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('LLM ' + res.status);
      const data = await res.json();
      return (data as any)?.choices?.[0]?.message?.content ?? '';
    };
  }

  /**
   * Trigger graph maintenance: deduplication, PageRank, community detection.
   * @param llm - Optional LLM function for community summarization
   */
  async runMaintenance(llm?: (system: string, user: string) => Promise<string>): Promise<any> {
    if (!this.mod || !this.driver) return null;
    try {
      // P2-17: 用 buildGmConfig 统一构建
      const cfg: Record<string, any> = buildGmConfig(this.neo4jConfig);
      this.logger?.info?.('[graph-adapter] triggering maintenance pipeline');
      const result = await this.mod.runMaintenance(this.driver, cfg, llm ?? this._llm ?? undefined, this._embedFn ?? undefined);
      this.logger?.info?.('[graph-adapter] maintenance completed', {
        durationMs: result?.durationMs,
        dedupMerged: result?.dedup?.mergedCount,
        communitiesDetected: result?.community?.communities?.size,
        communitySummaries: result?.communitySummaries,
      });
      return result;
    } catch (err) {
      this.logger?.error?.('[graph-adapter] maintenance failed', { err });
      return null;
    }
  }
async health(): Promise<boolean> {
    try {
      if (this.driver) { await this.driver.verifyConnectivity(); return true; }
      return await this.connect();
    } catch { return false; }
  }

  async close(): Promise<void> {
    // Release driver back to pool instead of closing directly
    try {
      await releaseDriver(this.neo4jConfig);
    } catch (relErr) {
      this.logger?.warn?.(`[graph-adapter] releaseDriver failed: ${relErr}`);
    }
    this.driver = null; this.mod = null;
  }

  async detectCommunities(maxIter = 50): Promise<{ labels: Map<string, string>; communities: Map<string, string[]>; count: number } | null> {
    if (!this.mod || !this.driver) return null;
    try {
      const result = await this.mod.detectCommunities(this.driver, maxIter);
      this.logger?.info?.('[graph-adapter] community detection completed', { count: result.count });
      return result;
    } catch (err) {
      this.logger?.error?.('[graph-adapter] community detection failed', { err });
      return null;
    }
  }

  async mergeNodes(keepId: string, mergeId: string): Promise<boolean> {
    if (!this.mod || !this.driver) return false;
    try {
      await this.mod.mergeNodes(this.driver, keepId, mergeId);
      this.logger?.info?.('[graph-adapter] nodes merged', { keepId, mergeId });
      return true;
    } catch (err) {
      this.logger?.error?.('[graph-adapter] merge nodes failed', { keepId, mergeId, err });
      return false;
    }
  }

  setLlm(llm: (system: string, user: string) => Promise<string>): void {
    this._llm = llm;
  }
}
