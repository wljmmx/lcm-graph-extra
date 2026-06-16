/**
 * lcm-graph-extra — Retrieval Gateway (with Performance Monitoring)
 *
 * Orchestrates parallel search across:
 * - QmdClient (MCP优先, CLI降级) — BM25 + vector + hybrid
 * - GraphAdapter (graph-memory-pro) — Neo4j knowledge graph
 * - ExperienceStorage (Layer 4 distilled experience) — Query-aware, context-filtered
 * - EVENT+SOLVED_BY (historical fix patterns) — Scenario-weighted
 *
 * QmdClient 提供 MCP→CLI 三层降级，优于旧的 QmdAdapter（CLI-only）
 */

import type { RetrievalResult } from './types.js';
import { QmdClient, type QmdSearchResult } from './qmd-client';
import type { GraphAdapter } from './adapters/graph-adapter.js';
import { Merger, type MergerConfig } from './merger.js';
import { ExperienceStorage } from './experience/storage.js';
import { TagRegistry } from './experience/tag-registry.js';
import { inferQueryContext, buildExperienceFilters } from './context-inference.js';

export interface PerformanceStats {
  searches: number;
  totalDurationMs: number;
  maxDurationMs: number;
  failures: number;
  lastQueryTime: number;
}

export class RetrievalGateway {
  private qmdClient: QmdClient;
  private graphAdapter: GraphAdapter;
  private merger: Merger;
  private experienceStorage: ExperienceStorage;
  private tagRegistry: TagRegistry;
  private lastQuery = '';

  // Performance monitoring
  public stats: Record<string, PerformanceStats> = {
    qmd: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
    graph: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
    experience: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
    distilledExp: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
  };
  public slowSearchThresholdMs = 1000;
  public globalTimeoutMs = 15000;

  constructor(
    qmdClient: QmdClient,
    graphAdapter: GraphAdapter,
    mergerConfig: MergerConfig,
  ) {
    this.qmdClient = qmdClient;
    this.graphAdapter = graphAdapter;
    this.merger = new Merger(mergerConfig);
    // Initialize ExperienceStorage for Layer 4 distilled experience recall
    this.experienceStorage = new ExperienceStorage(graphAdapter as any, 5);
    this.tagRegistry = new TagRegistry(graphAdapter as any);
    // Load tag registry (async, non-blocking — uses cached defaults if load fails)
    this.tagRegistry.load().catch(() => {});
    // globalTimeoutMs default is 15000 (class property)
  }

  /**
   * 从 QmdSearchResult[] 转换为 RetrievalResult[]
   */
  private toRetrievalResult(results: QmdSearchResult[]): RetrievalResult[] {
    return results.map((r) => ({
      id: r.docid,
      content: `File: ${r.file}:${r.line}\nTitle: ${r.title}\n${r.snippet}`,
      source: 'qmd' as const,
      type: 'raw' as const,
      score: r.score,
      metadata: { file: r.file, line: r.line, docid: r.docid, title: r.title },
    }));
  }

  /**
   * 将 ExperienceSearchResult[] 转换为 RetrievalResult[]
   */
  private toExpRetrievalResult(
    expResults: Array<{ experience: any; score: number }>,
  ): RetrievalResult[] {
    return expResults.map((er) => ({
      id: er.experience.id,
      content: `[Experience] ${er.experience.title}\n${er.experience.summary}`,
      source: 'graph' as const,
      type: 'definition' as const,
      score: er.score,
      metadata: {
        experience: true,
        distilled: true,
        tags: er.experience.tags,
        context: er.experience.context,
      },
    }));
  }

  /**
   * Standard dual-engine search (qmd + graph).
   */
  async search(query: string): Promise<RetrievalResult[]> {
    if (!query || !query.trim()) return [] as RetrievalResult[];
    this.lastQuery = query;

    const [qmdResults, graphResults] = await Promise.all([
      this.timedSearch('qmd', () =>
        this.qmdClient.query({
          searches: [
            { type: 'vec', query },
            { type: 'lex', query },
          ],
          limit: 5,
          rerank: true,
        }).then((r) => this.toRetrievalResult(r)),
      ),
      this.timedSearch('graph', () => this.graphAdapter.search(query)),
    ]);

    return this.merger.merge(qmdResults, graphResults);
  }

  /**
   * Enhanced search with experience retrieval.
   * 上下文感知：推断场景 → 过滤经验 → 混合召回
   */
  async searchWithExperience(query: string): Promise<{
    general: RetrievalResult[];
    experience: RetrievalResult[];
  }> {
    if (!query || !query.trim()) {
      return { general: [], experience: [] };
    }
    this.lastQuery = query;

    // Step 1: Infer query context (scenario, techStack, urgency)
    const ctx = inferQueryContext(query, this.tagRegistry);
    const filters = buildExperienceFilters(ctx);

    const [qmdResults, graphResults, distilledExpResults, eventExpResults] = await Promise.all([
      this.timedSearch('qmd', () =>
        this.qmdClient.query({
          searches: [
            { type: 'vec', query },
            { type: 'lex', query },
          ],
          limit: 5,
          rerank: true,
        }).then((r) => this.toRetrievalResult(r)),
      ),
      this.timedSearch('graph', () => this.graphAdapter.search(query)),
      // Layer 4: Query-aware distilled experience search with context filtering
      this.timedSearch('distilledExp', async () => {
        const expResults = await this.experienceStorage.searchByQuery({
          query,
          freeTags: filters.freeTags,
          scenarioTags: filters.scenarioTags,
          techStackTags: filters.techStackTags,
          minScore: 0.5,
          limit: 3,
        });
        return this.toExpRetrievalResult(expResults);
      }),
      // EVENT+SOLVED_BY with context weighting
      this.timedSearch('experience', () =>
        this.graphAdapter.searchExperience(query, { context: ctx, limit: 5 }),
      ),
    ]);

    const general = this.merger.merge(qmdResults, graphResults);

    // Merge distilled experience + event experience, dedup by content similarity
    const allExp = this.merger.merge(distilledExpResults, eventExpResults);

    // Increment match count for top recalled experiences
    try {
      for (const r of allExp.slice(0, 2)) {
        if (r.metadata?.experience && r.id) {
          await this.experienceStorage.incrementMatchCount(r.id);
        }
      }
    } catch { /* non-critical, ignore */ }

    const experience = allExp.slice(0, 5); // cap at 5 total experience items

    return { general, experience };
  }

  /** Tracked search with performance monitoring */
  private async timedSearch(
    engine: 'qmd' | 'graph' | 'experience' | 'distilledExp',
    searchFn: () => Promise<RetrievalResult[]>,
  ): Promise<RetrievalResult[]> {
    const start = performance.now();
    try {
      const timer = AbortSignal.timeout(this.globalTimeoutMs);
      const results: RetrievalResult[] = await Promise.race([
        searchFn(),
        new Promise<never>((_, reject) => {
          timer.addEventListener('abort', () => reject(new Error('search timeout')));
        }),
      ]);
      const duration = performance.now() - start;
      const s = this.stats[engine];
      if (!s) return results; // unknown engine, skip stats
      s.searches++;
      s.totalDurationMs += duration;
      if (duration > s.maxDurationMs) s.maxDurationMs = duration;
      s.lastQueryTime = duration;

      if (duration > this.slowSearchThresholdMs) {
        console.warn(`[lcm-graph-extra] Slow ${engine} search: ${duration.toFixed(0)}ms`);
      }
      return results;
    } catch (err) {
      const duration = performance.now() - start;
      const s = this.stats[engine];
      if (s) {
        s.failures++;
        s.lastQueryTime = duration;
      }
      console.error(`[lcm-graph-extra] ${engine} search failed (${duration.toFixed(0)}ms): ${err}`);
      return [] as RetrievalResult[];
    }
  }

  /** Get performance summary */
  getPerfSummary(): string {
    const lines: string[] = ['Performance:'];
    for (const [engine, s] of Object.entries(this.stats)) {
      const avg = s.searches > 0 ? (s.totalDurationMs / s.searches).toFixed(0) : '-';
      const failureRate = s.searches > 0 ? ((s.failures / s.searches) * 100).toFixed(1) : '0';
      lines.push(
        `  ${engine}: ${s.searches} searches, avg ${avg}ms, max ${s.maxDurationMs}ms, failure ${failureRate}%`,
      );
    }
    return lines.join('\n');
  }

  async processFeedback(): Promise<{ processed: number; updatedNodes: number }> {
    return this.graphAdapter.processFeedback();
  }

  getLastQuery(): string {
    return this.lastQuery;
  }

  async health(): Promise<{ qmd: boolean; qmdStatus: string | null; graph: boolean }> {
    const [qmdHealth, qmdStatus, graphHealth] = await Promise.all([
      this.qmdClient.ping().catch(() => false),
      this.qmdClient.status().catch(() => null),
      this.graphAdapter.health().catch(() => false),
    ]);
    return { qmd: qmdHealth, qmdStatus, graph: graphHealth };
  }

  /** Access to ExperienceStorage for external operations (e.g., dreaming/cron) */
  get experience(): ExperienceStorage {
    return this.experienceStorage;
  }

  /** Access to TagRegistry for external operations (e.g., dreaming/cron tag management) */
  get tags(): TagRegistry {
    return this.tagRegistry;
  }
}
