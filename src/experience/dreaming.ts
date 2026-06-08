/**
 * lcm-graph-extra — Dreaming Engine
 *
 * 定期将 PENDING 经验批量总结为 DISTILLED 经验。
 *
 * 流程：
 *   1. fetchPending() → 获取待处理的原始经验
 *   2. 按 source + context 相似度聚类
 *   3. 对每类调用 LLM 生成精炼摘要（复用 OpenClaw 运行时的 LLM 能力）
 *   4. saveDistilled() 写回 Neo4j
 *   5. 删除已处理的 PENDING 节点
 *
 * 在 maintain() 中定期触发。
 *
 * LLM 总结能力通过 SummarizeFn 注入：
 *   - 运行时：可调用 lossless-claw 的 summarizer 或 api.runtime.llm
 *   - 回退：deterministic 文本合并（无外部依赖）
 */

import type { ExperienceStorage, PendingRow } from './storage';
import type { DistilledExperience } from './types';

export interface DreamingConfig {
  /** 批量处理上限 */
  maxBatchSize: number;
  /** 聚类相似度阈值 (0-1) */
  clusterThreshold: number;
  /** 每个聚类的最大 PENDING 条目数 */
  maxPerCluster: number;
  /** 最小聚类大小（小于此值的 PENDING 保留延迟处理） */
  minClusterSize: number;
}

export interface DreamingResult {
  /** 本次处理的 PENDING 总数 */
  processed: number;
  /** 生成的 DISTILLED 经验 */
  distilled: number;
  /** 失败数 */
  failed: number;
  /** 保留的下次处理数 */
  retained: number;
}

/**
 * LLM 总结函数签名。
 *
 * 复用 OpenClaw 运行时的 LLM 能力。
 * 注入方式：从 plugin-runtime 获取 summarizer / llm.complete，
 * 或直接调用 lossless-claw 的 summarizer。
 *
 * @param cluster 待总结的经验聚类
 * @param prompt 系统提示词（含经验条目）
 * @returns 生成的总结文本
 */
export type SummarizeFn = (cluster: PendingRow[], prompt: string) => Promise<string>;

const DEFAULT_CONFIG: DreamingConfig = {
  maxBatchSize: 200,
  clusterThreshold: 0.3,
  maxPerCluster: 20,
  minClusterSize: 1,
};

export class DreamingEngine {
  private storage: ExperienceStorage;
  private config: DreamingConfig;
  private logger: any;
  private summarizeFn: SummarizeFn | null;

  constructor(
    storage: ExperienceStorage,
    config?: Partial<DreamingConfig>,
    logger?: any,
    summarizeFn?: SummarizeFn | null,
  ) {
    this.storage = storage;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger || console;
    this.summarizeFn = summarizeFn ?? null;
  }

  /**
   * 执行一次 dreaming 周期。
   * 建议在 maintain() hook 中定期调用。
   */
  async dream(): Promise<DreamingResult> {
    const result: DreamingResult = { processed: 0, distilled: 0, failed: 0, retained: 0 };

    try {
      const pendings = await this.storage.fetchPending(this.config.maxBatchSize);
      if (pendings.length === 0) {
        this.logger.debug('[dreaming] no pending experiences to process');
        return result;
      }

      this.logger.info(`[dreaming] processing ${pendings.length} pending experiences`);

      // 1. 聚类
      const clusters = this.clusterBySimilarity(pendings);

      // 2. 对每类生成精炼总结
      for (const cluster of clusters) {
        try {
          const distilled = await this.synthesizeCluster(cluster);
          if (distilled) {
            await this.storage.saveDistilled(distilled);
            result.distilled++;
          }
        } catch (err) {
          this.logger.warn({ err: (err as Error).message }, '[dreaming] cluster synthesis failed');
          result.failed++;
        }
      }

      // 3. 清除已处理的 PENDING
      // （storage.saveDistilled 会标记源 raw 为 DISTILLED）
      result.processed = pendings.length;

      this.logger.info(
        `[dreaming] completed: ${result.processed} processed, ${result.distilled} distilled, ` +
        `${result.failed} failed`,
      );
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, '[dreaming] cycle failed');
    }

    return result;
  }

  /**
   * 按 source + context 相似度聚类 PENDING 经验。
   */
  private clusterBySimilarity(rows: PendingRow[]): PendingRow[][] {
    const clusters: PendingRow[][] = [];
    const assigned = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      if (assigned.has(rows[i].id)) continue;

      const cluster: PendingRow[] = [rows[i]];
      assigned.add(rows[i].id);

      for (let j = i + 1; j < rows.length; j++) {
        if (assigned.has(rows[j].id)) continue;
        if (cluster.length >= this.config.maxPerCluster) break;

        const similarity = this.computeSimilarity(rows[i], rows[j]);
        if (similarity >= this.config.clusterThreshold) {
          cluster.push(rows[j]);
          assigned.add(rows[j].id);
        }
      }

      if (cluster.length >= this.config.minClusterSize) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * 计算两条 PENDING 经验之间的相似度。
   */
  private computeSimilarity(a: PendingRow, b: PendingRow): number {
    let score = 0;

    // source 相同 → +0.4
    if (a.source === b.source) score += 0.4;

    // context 文本重叠
    const ctxA = (a.context || '').toLowerCase();
    const ctxB = (b.context || '').toLowerCase();
    if (ctxA && ctxB) {
      const aWords = new Set(ctxA.split(/\s+/).filter(Boolean));
      const bWords = ctxB.split(/\s+/).filter(Boolean);
      let overlap = 0;
      for (const w of bWords) {
        if (aWords.has(w)) overlap++;
      }
      const total = Math.min(aWords.size, bWords.length);
      if (total > 0) {
        score += 0.6 * (overlap / total);
      }
    }

    return score;
  }

  /**
   * 对单个聚类生成精炼经验（DISTILLED）。
   *
   * 优先使用 this.summarizeFn（从 OpenClaw 运行时注入）。
   * 回退 deterministic 合并（无外部依赖）。
   */
  private async synthesizeCluster(cluster: PendingRow[]): Promise<DistilledExperience | null> {
    if (cluster.length === 0) return null;

    const contexts = cluster
      .map(r => (r.context || '').trim())
      .filter(Boolean);

    const id = `distilled_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const type = cluster[0].source === 'correction' ? 'correction'
      : cluster[0].source === 'failure' ? 'failure'
      : cluster[0].source === 'fix_success' ? 'fix'
      : 'lesson';

    // --- 优先使用 OpenClaw 运行时的 LLM 总结能力 ---
    if (this.summarizeFn) {
      try {
        const prompt = [
          'You are an experience summarizer. Given multiple related raw experience entries,',
          'produce a consolidated distilled summary. Follow the output format strictly.\n',
          'Title: <10-20 word title>',
          'Summary: <200-500 word consolidated summary>',
          'Detail: <optional details or patterns observed>',
          'Context: <when/how this experience should be recalled>\n',
          '--- Raw Experiences ---',
          ...cluster.map((r, i) => `[${i + 1}] ${r.context || '(no context)'}\n    Source: ${r.source}\n    Detail: ${r.detail || '(no detail)'}`),
        ].join('\n');

        const result = await this.summarizeFn(cluster, prompt);

        // Parse structured output
        const titleMatch = result.match(/Title:\s*(.+)/);
        const summaryMatch = result.match(/Summary:\s*([\s\S]*?)(?=\nDetail:|\nContext:|$)/);
        const detailMatch = result.match(/Detail:\s*([\s\S]*?)(?=\nContext:|$)/);
        const contextMatch = result.match(/Context:\s*(.+)/);

        return {
          id,
          type,
          rawIds: cluster.map(r => r.id || r.source),
          title: titleMatch?.[1]?.trim()?.slice(0, 120) || `${type} experience (${cluster.length} items)`,
          summary: summaryMatch?.[1]?.trim()?.slice(0, 1000) || result.slice(0, 1000),
          detail: detailMatch?.[1]?.trim()?.slice(0, 2000) || contexts.join('\n---\n').slice(0, 2000),
          context: contextMatch?.[1]?.trim()?.slice(0, 2000) || contexts.join('\n---\n').slice(0, 500),
          projectName: undefined,
          relevanceScore: 0.7 + Math.min(cluster.length * 0.05, 0.25),
          createdAt: new Date(),
          expiresAt: undefined,
          matchCount: 0,
        };
      } catch (llmErr) {
        this.logger.warn?.(
          { err: (llmErr as Error).message },
          '[dreaming] LLM summary failed, falling back to deterministic merge',
        );
        // fall through to deterministic merge
      }
    }

    // --- 回退：deterministic 合并（无外部依赖，用于测试和离线环境） ---
    const summary = this.mergeSummaries(cluster);
    return {
      id,
      type,
      rawIds: cluster.map(r => r.id || r.source),
      title: summary.title,
      summary: summary.text,
      detail: summary.detail,
      context: contexts.join('\n---\n').slice(0, 2000),
      projectName: undefined,
      relevanceScore: 0.7 + Math.min(cluster.length * 0.05, 0.25),
      createdAt: new Date(),
      expiresAt: undefined,
      matchCount: 0,
    };
  }

  /**
   * 合并多个 PENDING 经验的摘要信息（deterministic 回退）。
   */
  private mergeSummaries(cluster: PendingRow[]): {
    title: string; text: string; detail: string;
  } {
    const parts = cluster.map(r => {
      const ctx = (r.context || '').trim();
      const summary = (r as any).description || '';
      return { ctx, summary };
    });

    // 取最长最有意义的 context 作为 title
    const bestContext = parts
      .filter(p => p.ctx)
      .sort((a, b) => b.ctx.length - a.ctx.length)[0];

    const title = bestContext
      ? (bestContext.ctx.length > 80
        ? bestContext.ctx.slice(0, 80) + '…'
        : bestContext.ctx)
      : `Experience cluster (${cluster.length} items)`;

    // 合并 text
    const text = parts
      .map(p => p.summary || p.ctx)
      .filter(Boolean)
      .join('\n')
      .slice(0, 1000);

    // detail
    const detail = cluster
      .map((r, i) => `[${i + 1}] ${r.context || '(no context)'}`)
      .join('\n\n')
      .slice(0, 2000);

    return { title, text, detail };
  }
}
