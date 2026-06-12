/**
 * on_before_turn hook — 四层上下文注入。
 *
 * Layer 1. lossless-claw (OpenClaw 内置) — 会话消息 DAG + 摘要（自动完成）
 * Layer 2. qmd MCP — 记忆文件 BM25+向量混合搜索
 * Layer 3. graph-memory-pro Neo4j 知识图谱
 * Layer 4. 经验总结（EXPERIENCE 节点）— 异步精炼，仅在 relevanceScore > threshold 时注入
 *
 * 所有结果经 Merger 去重合并为 top-10 注入。
 */

import { QmdClient } from '../qmd-client';
import { RetrievalGateway } from '../retrieval-gateway';
import { GraphAdapter } from '../adapters/graph-adapter';
import { ExperienceStorage } from '../experience';
import { resolveNeo4jConfig, type Neo4jSearchConfig } from '../config/neo4j-helper';
import type { PluginInstance } from '../register';

// ---------------------------------------------------------------------------
// Lazy singletons (initialized on first call with config from instance)
// ---------------------------------------------------------------------------

let _qmdClient: QmdClient | null = null;
let _retrievalGateway: RetrievalGateway | null = null;
let _experienceStorage: ExperienceStorage | null = null;
let _initializedWithConfig: boolean = false;
let _lastInitTime: number = 0;
const MAX_SINGLETON_AGE_MS = 5 * 60 * 1000; // 5 minutes

function getQmdClient(): QmdClient {
  if (!_qmdClient) _qmdClient = new QmdClient();
  return _qmdClient;
}

function initRetrievalGateway(pluginConfig?: Record<string, unknown>): void {
  if (_retrievalGateway) return;

  const qmd = getQmdClient();
  const graph = new GraphAdapter(
    resolveNeo4jConfig(pluginConfig),
    { enabled: true, searchLimit: 5 },
  );
  _retrievalGateway = new RetrievalGateway(qmd, graph, {
    maxResults: 10,
    fuzzyMatchThreshold: 0.85,
    decayHalfLifeDays: 30,
  });
  _experienceStorage = new ExperienceStorage(graph);
  _initializedWithConfig = true;
  _lastInitTime = Date.now();
}

function getRetrievalGateway(): RetrievalGateway | null {
  const now = Date.now();
  if (_lastInitTime > 0 && (now - _lastInitTime) > MAX_SINGLETON_AGE_MS) {
    disposeAfterTurn();
  }
  if (!_retrievalGateway) {
    // Fallback: init without plugin config (uses env vars + defaults)
    initRetrievalGateway();
  }
  return _retrievalGateway;
}

function getExperienceStorage(): ExperienceStorage | null {
  if (!_experienceStorage) {
    initRetrievalGateway();
  }
  return _experienceStorage;
}

/**
 * Cleanup singletons to avoid resource leaks.
 * Call during plugin dispose or between major lifecycle events.
 */
export function disposeAfterTurn(): void {
  _qmdClient = null;
  _retrievalGateway = null;
  _experienceStorage = null;
  _initializedWithConfig = false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Rough token estimate (1 token ≈ 4 chars). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Build the budget for injected context tokens based on config. */
function computeBudget(instance: PluginInstance): number {
  const ratio = instance.config.budgetRatio ?? 0.3;
  return Math.floor((instance.config.maxTokens ?? 32768) * ratio);
}

/**
 * Format RetrievalResult[] into an injectable context string.
 */
function formatRetrievalResults(
  results: Array<{
    id: string;
    content: string;
    source: string;
    type: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>,
  budgetTokens: number,
): string {
  const parts: string[] = [];
  let usedTokens = 0;

  for (const r of results) {
    const sourceLabel = sourceToLabel(r.source);
    const block = `### [${sourceLabel}] ${r.metadata?.title ?? r.metadata?.name ?? r.id}\n`
      + `Score: ${Math.round(r.score * 100)}% | ` 
      + `Type: ${r.metadata?.nodeType ?? r.type}\n\n`
      + (r.content || '(no content)');
    const tokenCost = estimateTokens(block);
    if (usedTokens + tokenCost > budgetTokens) break;
    parts.push(block);
    usedTokens += tokenCost;
  }

  if (parts.length === 0) return '';
  return '\n## Injected Context\n' + parts.join('\n\n') + '\n---';
}

function sourceToLabel(source: string): string {
  switch (source) {
    case 'graph':     return '🔗 知识图谱';
    case 'qmd':       return '📄 记忆文件';
    case 'experience':return '💡 经验总结';
    default:          return '📌 上下文';
  }
}

// ---------------------------------------------------------------------------
// Performance timing helper (structured output for test parser)
// ---------------------------------------------------------------------------

interface BeforeTurnTimings {
  total: number;
  init_gateway: number;
  retrieval_gateway_total: number;
  qmd_search: number | null;
  graph_search: number | null;
  merger: number | null;
  experience_search: number;
  dedup: number;
  format: number;
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * Called right before a turn begins.
 *
 * 四层注入 (lossless-claw Layer 1 由 OpenClaw 内置自动完成):
 *   Layer 2: qmd MCP → 记忆文件全文搜索
 *   Layer 3: GraphAdapter → Neo4j 知识图谱
 *   Layer 4: ExperienceStorage → 精炼经验召回
 */
export async function onBeforeTurn(instance: PluginInstance, params?: { messages?: Array<{ role?: string; content?: string }> }): Promise<string> {
  const t0 = performance.now();
  const logger = instance.logger;
  const budgetTokens = computeBudget(instance);

  // --- Timing: init gateway -----------------------------------------
  const t_init_start = performance.now();
  initRetrievalGateway(instance.config);
  const t_init_end = performance.now();

  // --- Phase 1: RetrievalGateway (qmd + graph) --------------------------
  let results: Array<{
    id: string; content: string; source: string; type: string;
    score: number; metadata?: Record<string, unknown>;
  }> = [];

  const t_rgw_start = performance.now();
  let qmdMs: number | null = null;
  let graphMs: number | null = null;
  let mergerMs: number | null = null;

  try {
    const gateway = getRetrievalGateway();
    if (!gateway) {
      logger?.warn?.('before_turn: retrieval gateway not initialized');
      return '';
    }
    // Build search query from actual prompt context
    const userMessages = (params?.messages ?? []).filter(m => m.role === 'user' && m.content);
    const promptSnippet = userMessages.length > 0
      ? (userMessages[userMessages.length - 1].content ?? '').slice(0, 200)
      : 'relevant memory context for current conversation';
    results = await gateway.search(promptSnippet);
    
    // Extract per-engine timing from stats
    const gwStats = (gateway as any).stats || {};
    qmdMs = gwStats.qmd?.lastQueryTime ?? null;
    graphMs = gwStats.graph?.lastQueryTime ?? null;
    mergerMs = null; // merger is fast, embedded in gateway.search timing
    
    logger?.debug?.(
      `before_turn: retrieval gateway returned ${results.length} results`,
    );
  } catch (err) {
    logger?.warn?.({ err: (err as Error).message }, 'before_turn: retrieval failed');
  }
  const t_rgw_end = performance.now();

  // --- Phase 2: Experience injection (Layer 4) --------------------------
  const t_exp_start = performance.now();
  try {
    const expThreshold = instance.config.experience?.relevanceThreshold ?? 0.6;
    const expLimit = 3;
    const expStore = getExperienceStorage();
    if (expStore) {
      const expResults = await expStore.searchRelevant(expThreshold, expLimit);
      for (const er of expResults) {
        results.push({
          id: er.experience.id,
          content: er.experience.summary,
          source: 'experience',
          type: er.experience.type,
          score: er.score,
          metadata: {
            title: er.experience.title,
            nodeType: 'EXPERIENCE',
          },
        });
        // 记录命中次数
        expStore.incrementMatchCount(er.experience.id).catch(() => {});
      }
      logger?.debug?.(`before_turn: injected ${expResults.length} experience nodes`);
    }
  } catch (err) {
    logger?.warn?.({ err: (err as Error).message }, 'before_turn: experience injection failed');
  }
  const t_exp_end = performance.now();

  // --- Phase 2.5: Final dedup across all sources (qmd + graph + experience) ---
  const t_dedup_start = performance.now();
  {
    const seenIds = new Set<string>();
    const seenContent = new Map<string, number>();
    const deduped: typeof results = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (seenIds.has(r.id)) continue;
      const contentKey = (r.content || "").slice(0, 120).toLowerCase().trim();
      if (contentKey && seenContent.has(contentKey)) continue;
      seenIds.add(r.id);
      if (contentKey) seenContent.set(contentKey, i);
      deduped.push(r);
    }
    if (deduped.length < results.length) {
      logger?.debug?.(`before_turn: deduped ${results.length} → ${deduped.length} results`);
    }
    results.length = 0;
    for (const r of deduped) results.push(r);
  }
  const t_dedup_end = performance.now();

  // --- Phase 3: Format & return -----------------------------------------
  const t_fmt_start = performance.now();
  let output = '';
  if (results.length > 0) {
    output = formatRetrievalResults(results, budgetTokens);
  }
  const t_fmt_end = performance.now();

  const t_total = performance.now() - t0;

  // --- Log structured timing for test parser ----------------------------
  logger?.info?.(
    `[TIMING] before_turn total=${t_total.toFixed(1)}ms init=${(t_init_end - t_init_start).toFixed(1)}ms rgw=${(t_rgw_end - t_rgw_start).toFixed(1)}ms qmd=${qmdMs?.toFixed(1) ?? '-'}ms graph=${graphMs?.toFixed(1) ?? '-'}ms exp=${(t_exp_end - t_exp_start).toFixed(1)}ms dedup=${(t_dedup_end - t_dedup_start).toFixed(1)}ms fmt=${(t_fmt_end - t_fmt_start).toFixed(1)}ms results=${results.length}`,
  );

  return output;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test__ = {
  estimateTokens,
  computeBudget,
  formatRetrievalResults,
  getQmdClient,
  getRetrievalGateway,
  getExperienceStorage,
  initRetrievalGateway,
};
