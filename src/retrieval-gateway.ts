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
import { DEFAULTS } from './config/defaults.js';
import type { Logger } from './utils/logger.js';
import { resolveLogger } from './utils/logger.js';

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
  /** P3-B4: 统一 logger（从全局单例解析），替换 console.* */
  private readonly logger: Logger = resolveLogger();

  // Performance monitoring
  public stats: Record<string, PerformanceStats> = {
    qmd: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
    graph: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
    experience: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
    distilledExp: { searches: 0, totalDurationMs: 0, maxDurationMs: 0, failures: 0, lastQueryTime: 0 },
  };
  // P2-3 H-16: 超时/慢查询阈值集中到 DEFAULTS.retrieval
  public slowSearchThresholdMs = DEFAULTS.retrieval.slowSearchThresholdMs;
  public globalTimeoutMs = DEFAULTS.retrieval.globalTimeoutMs;

  constructor(
    qmdClient: QmdClient,
    graphAdapter: GraphAdapter,
    mergerConfig: MergerConfig,
  ) {
    this.qmdClient = qmdClient;
    this.graphAdapter = graphAdapter;
    this.merger = new Merger(mergerConfig);
    // Initialize ExperienceStorage for Layer 4 distilled experience recall
    this.experienceStorage = new ExperienceStorage(graphAdapter);
    this.tagRegistry = new TagRegistry(graphAdapter);
    // BUGFIX(P2-10): tagRegistry.load 失败时带退避重试，而非静默吞错
    // 首次启动若 Neo4j 短暂不可用，后续恢复后会重新加载，避免整个会话周期用空 tag
    this.loadTagRegistryWithRetry();
    // globalTimeoutMs default is 15000 (class property)
  }

  /**
   * BUGFIX(P2-10): tagRegistry.load 带退避重试。
   * 最多重试 3 次，间隔 10s / 30s / 60s。全部失败后用 cached defaults（原行为）。
   */
  private loadTagRegistryWithRetry(attempt: number = 0): void {
    const delays = [10_000, 30_000, 60_000]; // 10s / 30s / 60s
    this.tagRegistry.load()
      .then(() => { /* 加载成功 */ })
      .catch((err) => {
        this.logger.warn(`[lcm-graph-extra] tagRegistry.load failed (attempt ${attempt + 1})`, { err: String(err) });
        if (attempt < delays.length) {
          setTimeout(() => this.loadTagRegistryWithRetry(attempt + 1), delays[attempt]);
        }
        // 超过重试次数则放弃，使用 cached defaults（与原 .catch(()=>{}) 行为一致）
      });
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
      // 保存原始经验对象，供 injection.ts 的 incrementMatchCount 等使用
      experience: er.experience,
      metadata: {
        experience: er.experience,
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
          // BUGFIX(P0-1): 统一使用 DEFAULTS.retrieval.expMinScore，与 assemble 一致
          minScore: DEFAULTS.retrieval.expMinScore,
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
    // P1-6 M-3: 修复前为 for-await 串行，2 次 Neo4j 往返叠加。
    // 改为 Promise.all 并行；每项独立 catch 防止单点失败短路整体。
    try {
      const topExp = allExp.slice(0, 2)
        .filter(r => r.metadata?.experience && r.id)
        .map(r => this.experienceStorage.incrementMatchCount(r.id).catch(() => {}));
      await Promise.all(topExp);
    } catch (e) { /* non-critical, ignore */
      this.logger.debug('experience match count increment failed (non-fatal)', { err: e instanceof Error ? e.message : String(e) });
    }

    const experience = allExp.slice(0, 5); // cap at 5 total experience items

    return { general, experience };
  }

  /** Tracked search with performance monitoring */
  private async timedSearch(
    engine: 'qmd' | 'graph' | 'experience' | 'distilledExp',
    searchFn: () => Promise<RetrievalResult[]>,
  ): Promise<RetrievalResult[]> {
    const start = performance.now();
    // P0-3a H-3: 修复前用 AbortSignal.timeout，即使 searchFn 先完成，底层定时器
    // 仍会持续到 globalTimeoutMs 才释放（node 内部 timer 资源）。高并发下累积。
    // 改用显式 setTimeout + finally clearTimeout，确保任一 Promise 先 settle 即释放。
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('search timeout')), this.globalTimeoutMs);
    });
    // SEC-9: 预吞 timeoutPromise 的 reject，防止 race 中 searchFn 先 resolve 时
    // timeoutPromise 的 reject 成为 unhandledRejection。
    timeoutPromise.catch(() => {});
    try {
      const results: RetrievalResult[] = await Promise.race([
        searchFn(),
        timeoutPromise,
      ]);
      const duration = performance.now() - start;
      const s = this.stats[engine];
      if (!s) return results; // unknown engine, skip stats
      s.searches++;
      s.totalDurationMs += duration;
      if (duration > s.maxDurationMs) s.maxDurationMs = duration;
      s.lastQueryTime = duration;

      if (duration > this.slowSearchThresholdMs) {
        this.logger.warn(`[lcm-graph-extra] Slow ${engine} search: ${duration.toFixed(0)}ms`);
      }
      return results;
    } catch (err) {
      const duration = performance.now() - start;
      const s = this.stats[engine];
      if (s) {
        s.failures++;
        s.lastQueryTime = duration;
      }
      this.logger.error(`[lcm-graph-extra] ${engine} search failed (${duration.toFixed(0)}ms)`, { err: String(err) });
      return [] as RetrievalResult[];
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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

  // P3-9 GMR-4: processFeedback 已移除 —— 委托到 graphAdapter.processFeedback()，
  // 但后者为空实现且无生产调用，整条链路属死代码。

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
