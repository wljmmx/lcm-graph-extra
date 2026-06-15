/**
 * lcm-graph-extra — Retrieval Gateway (with Performance Monitoring)
 *
 * Orchestrates parallel search across:
 * - QmdClient (MCP优先, CLI降级) — BM25 + vector + hybrid
 * - GraphAdapter (graph-memory-pro) — Neo4j knowledge graph
 * - experience search (historical EVENT + SOLVED_BY chain)
 *
 * QmdClient 提供 MCP→CLI 三层降级，优于旧的 QmdAdapter（CLI-only）
 */

import type { RetrievalResult } from './types.js';
import { QmdClient, type QmdSearchResult } from './qmd-client';
import type { GraphAdapter } from './adapters/graph-adapter.js';
import { Merger, type MergerConfig } from './merger.js';

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
  private lastQuery = '';

  // Performance monitoring
  public stats: Record<string, PerformanceStats> = {
    qmd: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
    graph: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
    experience: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
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
   */
  async searchWithExperience(query: string): Promise<{
    general: RetrievalResult[];
    experience: RetrievalResult[];
  }> {
    if (!query || !query.trim()) {
      return { general: [], experience: [] };
    }
    this.lastQuery = query;

    const [qmdResults, graphResults, expResults] = await Promise.all([
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
      this.timedSearch('experience', () => this.graphAdapter.searchExperience(query)),
    ]);

    const general = this.merger.merge(qmdResults, graphResults);
    const experience = this.merger.merge(
      qmdResults.filter((r) => r.type === 'definition'),
      expResults,
    ).slice(0, 3);

    return { general, experience };
  }

  /** Tracked search with performance monitoring */
  private async timedSearch(
    engine: 'qmd' | 'graph' | 'experience',
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
      this.stats[engine].failures++;
      this.stats[engine].lastQueryTime = duration;
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
}
