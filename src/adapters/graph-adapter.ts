/**
 * lcm-graph-extra — Neo4j Graph Search Adapter
 *
 * Bridges lcm-graph-extra with graph-memory-pro's compiled module exports.
 * Dynamically imports from graph-memory-pro/dist/index.js.
 * Uses Recaller.recall(), searchNodes, upsertNode/upsertEdge.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as neo4jDriver from 'neo4j-driver';
import type { RetrievalResult, RetrievalSource, RetrievalType } from '../types.js';
import type { Neo4jConfig } from '../types.js';
import { ConflictLogger } from '../async/conflict-logger.js';
import type { EmbeddingConfig } from '../types.js';
import { acquireDriver, releaseDriver } from './connection-pool';


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
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || (process.env.HOME ? `${process.env.HOME}/.openclaw` : './.openclaw');
const GM_PRO_PATH = process.env.GM_PRO_PATH
  || (() => {
      try {
        const resolved = _gmpRequire.resolve('@openclaw/graph-memory-pro/dist/index.js');
        return resolved.endsWith('/dist/index.js') ? resolved.slice(0, -14) : resolved;
      } catch {
        return undefined;
      }
    })()
  || `${OPENCLAW_DIR}/extensions/graph-memory-pro`;

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

export class GraphAdapter {
  public conflictLogger = new ConflictLogger();
  private mod: GmModule | null = null;
  private driver: any = null;
  private _connectFailed = false;
  private _connectRetryCount = 0;
  private readonly maxRetries = 3;
  private config: GraphAdapterConfig;
  private neo4jConfig: Neo4jConfig;
  private logger: any;
  private _recaller: any = null;
  private _gmConfig: Record<string, any> = {};
  private _embedFn: any = null;
  private _llm?: (system: string, user: string) => Promise<string>;

  private searchCache = new LRUCache(50, 300 * 1000);

  constructor(neo4jConfig: Neo4jConfig, config: GraphAdapterConfig, logger?: any) {
    this.neo4jConfig = neo4jConfig;
    this.config = config;
    this.logger = logger;
  }

  async connect(): Promise<boolean> {
    try {
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
        // Full GmConfig — all required fields for type safety
        const gmCfg: Record<string, any> = {
          neo4j: this.neo4jConfig,
          compactTurnCount: 10,
          recallMaxNodes: 8,
          recallMaxDepth: 2,
          freshTailCount: 5,
          dedupThreshold: 0.90,
          pagerankDamping: 0.85,
          pagerankIterations: 12,
        };
        this._recaller = new mod.Recaller(this.driver, gmCfg);
        this._gmConfig = gmCfg;

        // Set embedding function for community generalized recall
        try {
          const ecfg = this.config.embedding;
          if (ecfg && mod.createEmbedFn) {
            this._embedFn = mod.createEmbedFn({ ...ecfg });
            this._recaller.setEmbedFn(this._embedFn);
            this.logger?.info?.('[graph-adapter] Embedding initialized for Recaller', { model: ecfg.model });
          } else if (!ecfg) {
            this.logger?.warn?.('[graph-adapter] No embedding config provided, community recall disabled');
          } else {
            this.logger?.warn?.('[graph-adapter] createEmbedFn not available, community recall disabled');
          }
        } catch (embedErr) {
          this.logger?.warn?.('[graph-adapter] Failed to init embedding for Recaller:', embedErr);
        }

        this.logger?.info?.('[graph-adapter] Recaller initialized (dual-path recall enabled)');
      } catch (initErr) {
        this.logger?.warn?.('[graph-adapter] Recaller init failed, falling back to searchNodes:', initErr);
        this._recaller = null;
      }

      return true;
    } catch (err) {
      this._connectRetryCount++;
      this.logger?.warn?.(`[graph-adapter] connect attempt ${this._connectRetryCount}/${this.maxRetries} failed: ${err}`);
      if (this._connectRetryCount >= this.maxRetries) {
        this._connectFailed = true;
        this.logger?.error?.(`[graph-adapter] connect failed after ${this.maxRetries} attempts`);
      }
      return false;
    }
  }

  /** Reset connection failure flag (called on retry / gateway restart) */
  resetConnectFlag(): void {
    this._connectFailed = false;
    this._connectRetryCount = 0;
  }

  async search(query: string, limit?: number): Promise<RetrievalResult[]> {
    if (!this.config.enabled) return [];
    if (!this.mod) {
      if (this._connectFailed && this._connectRetryCount >= this.maxRetries) {
        this.logger?.warn?.(`[lcm-graph-extra] search: max retries (${this.maxRetries}) reached, skipping`);
        return [];
      }
      await this.connect();
    }
    if (!this.mod) return [];
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
          this.logger?.warn?.('[graph-adapter] Recaller.recall failed, falling back:', recallErr);
        }
      }

      // Fallback to simple searchNodes if no results
      if (nodes.length === 0) {
        nodes = await this.mod.searchNodes(this.driver, query, rl);
      }
      // Rerank by PageRank if enough nodes
      let reranked = (nodes ?? []);
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
    const key = `s:${query.slice(0,200).toLowerCase().trim()}`;
    const cached = this.searchCache.get(key);
    if (cached) return cached as RetrievalResult[];
    let results = await this.search(query, limit);
    if (!Array.isArray(results)) results = [];
    // PPR rerank (in case search() didn't have enough data)
    const cacheNodeIds = results.map(r => r.metadata?.nodeId).filter(Boolean);
    if (cacheNodeIds.length >= 2) {
      const pprScores = await this.rerankByPageRank(cacheNodeIds as string[]);
      if (pprScores.size > 0) {
        results.sort((a, b) => {
          const sa = pprScores.get(a.metadata?.nodeId as string) ?? 0.5;
          const sb = pprScores.get(b.metadata?.nodeId as string) ?? 0.5;
          return sb - sa;
        });
      }
    }
    // Community enrichment — batch findById via raw Cypher (avoids N round-trips)
    const nodeIds = results.map(r => r.metadata?.nodeId).filter(Boolean);
    if (nodeIds.length > 0) {
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
      if (this._connectFailed && this._connectRetryCount >= this.maxRetries) {
        this.logger?.warn(`[lcm-graph-extra] searchExperience: max retries (${this.maxRetries}) reached, skipping`);
        return [];
      }
      await this.connect();
    }
    if (!this.mod) return [];
    const rl = options?.limit ?? this.config.searchLimit;
    const ctx = options?.context;
    try {
      const nodes = await this.mod.searchNodes(this.driver, query, rl * 3);
      const events = (nodes ?? []).filter((n: any) => (n.type ?? n.labels?.[0]) === 'EVENT');

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

      const out: RetrievalResult[] = [];
      for (const evt of ranked.slice(0, rl)) {
        const name = evt.name ?? evt.properties?.name ?? '';
        const desc = evt.description ?? evt.properties?.description ?? '';
        const edges = await this.mod!.getEdgesForNodes(this.driver, [evt.id]);
        const sols = (edges ?? []).filter((e: any) => e.type === 'SOLVED_BY');
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
    entities: Array<{ name: string; type: string; description: string; content: string }>,
    relations: Array<{ from: string; to: string; type: string; instruction?: string }>,
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
      // Batch upsert nodes via UNWIND + MERGE
      if (validEntities.length > 0) {
        const nodeData = validEntities.map((e) => {
          const t = mapEntityType(e.type);
          const nid = makeNodeId(e.name, t);
          return {
            id: nid,
            label: t,
            name: e.name.trim(),
            description: (e.description ?? '').slice(0, 500),
            content: (e.content ?? '').slice(0, 2000),
            status: 'active',
            pagerank: 0.5,
            updatedAt: Date.now(),
          };
        });

        // First batch check which nodes already exist (to count conflicts)
        const existingIds: string[] = [];
        for (const n of nodeData) {
          const record = await session.run(
            'MATCH (n:' + n.label + ' { id: $id }) RETURN n',
            { id: n.id },
          );
          if (record.records.length > 0) {
            existingIds.push(n.id);
            cc++;
          }
        }

        // Batch MERGE all nodes
        const mergeLabels = new Set(nodeData.map((n) => n.label));
        const labelUnion = Array.from(mergeLabels).join('|');
        const cypher = `
          UNWIND $nodes AS node
          CALL apoc.create.node([node.label], {
            id: node.id,
            name: node.name,
            description: node.description,
            content: node.content,
            status: node.status,
            pagerank: node.pagerank,
            updatedAt: node.updatedAt,
          }) YIELD node AS created
          RETURN count(created) AS cnt
        `;

        // Fallback: if apoc not available, use per-node MERGE in one transaction
        try {
          const result = await session.run(cypher, { nodes: nodeData });
          uc += result.records[0]?.get('cnt') ?? 0;
        } catch {
          // Fallback: MERGE each node in a single transaction (still better than N round-trips)
          for (const n of nodeData) {
            await session.run(
              `MERGE (n:${n.label} { id: $id })
               SET n.name = $name,
                   n.description = $description,
                   n.content = $content,
                   n.status = $status,
                   n.pagerank = $pagerank,
                   n.updatedAt = $updatedAt
               ON CREATE SET n.createdAt = $updatedAt`,
              {
                id: n.id,
                name: n.name,
                description: n.description,
                content: n.content,
                status: n.status,
                pagerank: n.pagerank,
                updatedAt: n.updatedAt,
              },
            );
          }
          uc += nodeData.length;
        }
      }

      // Batch upsert edges in a single session
      if (validRelations.length > 0) {
        for (const rel of validRelations) {
          const mt = mapEdgeType(rel.type);
          const fromId = makeNodeId(rel.from, 'TASK');
          const toId = makeNodeId(rel.to, 'TASK');

          await session.run(
            `MATCH (a { id: $fromId }), (b { id: $toId })
             MERGE (a)-[r:${mt}]->(b)
             SET r.instruction = $instruction,
                 r.weight = $weight,
                 r.updatedAt = $updatedAt
             ON CREATE SET r.createdAt = $updatedAt`,
            {
              fromId,
              toId,
              instruction: (rel.instruction ?? '').slice(0, 500),
              weight: 1.0,
              updatedAt: Date.now(),
            },
          );
        }
      }

      uc += validRelations.length;
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
        const existing = await this.mod!.findById(this.driver, nid);
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
              await this.mod!.upsertNode(this.driver, {
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
              await this.mod!.upsertNode(this.driver, {
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
        await this.mod!.upsertNode(this.driver, {
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
        await this.mod!.upsertEdge(this.driver, {
          id: makeNodeId(rel.from + '-' + rel.to, mt), type: mt,
          fromId: makeNodeId(rel.from, 'TASK'), toId: makeNodeId(rel.to, 'TASK'),
          instruction: (rel.instruction ?? '').slice(0, 500),
          condition: '', weight: 1.0, createdAt: now, updatedAt: now,
        });
      }
    } catch (err) { this.logger?.error?.(`[lcm-graph-extra] upsert error: ${err}`); }
    return { upserted: uc, conflicts: cc };
  }

  async processFeedback(): Promise<{ processed: number; updatedNodes: number }> {
    return { processed: 0, updatedNodes: 0 };
  }

  
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
    if (!this.mod || nodeIds.length < 2) return new Map();
    try {
      // gm-pro personalizedPageRank(driver, seedIds[], candidateIds[], GmConfig): PPRResult { scores: Map }
      const cfg = {
        pagerankDamping: 0.85,
        pagerankIterations: 12,
      };
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
    llmConfig: { apiKey?: string; baseURL?: string; model?: string },
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

  private buildLlmFn(config?: { apiKey?: string; baseURL?: string; model?: string }): ((system: string, user: string) => Promise<string>) | null {
    if (!config?.model && !config?.apiKey) return null;
    const baseUrl = (config.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = config.model || 'gpt-4o-mini';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;
    return async (system, user) => {
      const res = await fetch(baseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1024, temperature: 0.3 }), signal: AbortSignal.timeout(30000) });
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
      // Full GmConfig for runMaintenance
      const cfg: Record<string, any> = {
        neo4j: this.neo4jConfig,
        compactTurnCount: 10,
        recallMaxNodes: 8,
        recallMaxDepth: 2,
        freshTailCount: 5,
        dedupThreshold: 0.90,
        pagerankDamping: 0.85,
        pagerankIterations: 12,
      };
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
