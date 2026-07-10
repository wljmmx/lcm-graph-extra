/**
 * lcm-graph-extra — Result Merger (Entity-Level Dedup)
 *
 * Merges qmd + graph-memory-pro retrieval results using entity-level
 * dedup and aggregation.
 *
 * Strategy:
 * 1. Extract entity names from all results
 * 2. Group by normalized entity name (with fuzzy matching)
 * 3. For each entity: pick primary (structure) + supplemental (evidence)
 * 4. Sort by: cross-source presence > type priority > score
 * 5. Cap at maxResults
 *
 * This replaces the old content-hash + Bigram approach, providing
 * true cross-engine dedup by entity identity rather than text equality.
 */

import { createHash } from 'node:crypto';
import type { RetrievalResult, RetrievalType } from './types.js';
import { groupByEntity, type EntityGroup } from './entity-extractor.js';

export interface MergerConfig {
  maxResults: number;
  fuzzyMatchThreshold: number;
  /** Half-life for memory decay (days). Applied to graph results with updatedAt. 0=disabled */
  decayHalfLifeDays?: number;
}

/**
 * Type priority: definition (structured knowledge) > relation > raw (text evidence)
 */
const TYPE_PRIORITY: Record<RetrievalType, number> = {
  definition: 0,
  relation: 1,
  raw: 2,
};

export class Merger {
  private config: MergerConfig;

  constructor(config: MergerConfig) {
    this.config = config;
  }

  /**
   * Merge results from both engines using entity-level dedup.
   *
   * Process:
   * 1. Collect all results
   * 2. Group by entity (extract + normalize + fuzzy match)
   * 3. For each entity: produce 1 primary + 0-2 supplemental results
   * 4. Sort: cross-source hits first, then type priority, then score
   * 5. Cap at maxResults
   */
  merge(
    qmdResults: RetrievalResult[],
    graphResults: RetrievalResult[],
  ): RetrievalResult[] {
    const all = [...qmdResults, ...graphResults];
    if (!all.length) return [];

    // Step 1: Exact dedup by result ID (prevent exact duplicates)
    const deduped = this.idDedup(all);

    // Step 2: Group by entity (BUGFIX P1-1: 传递 fuzzyMatchThreshold 配置)
    const groups = groupByEntity(deduped, this.config.fuzzyMatchThreshold);

    // Step 3: Flatten groups into ranked results
    const ranked = this.flattenGroups(groups);

    // Step 4: Sort by entity priority
    const sorted = this.entityPrioritySort(ranked);

    // P6-3: Apply temporal decay to graph results (lightweight, mirrors OpenClaw temporalDecay)
    const decayed = this.applyDecayToResults(sorted);

    return decayed.slice(0, this.config.maxResults);
  }

  /**
   * Basic dedup by result ID (same result from same engine).
   */
  private idDedup(results: RetrievalResult[]): RetrievalResult[] {
    const seen = new Map<string, RetrievalResult>();
    for (const r of results) {
      // Use existing id if present, otherwise generate
      const key = r.id || `${r.source}:${r.content.slice(0, 80)}`;
      const existing = seen.get(key);
      if (!existing || r.score > existing.score) {
        seen.set(key, r);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Flatten entity groups into ranked results.
   * Each entity produces:
   * - 1 primary result (highest priority type)
   * - 1-2 supplemental results (different type from primary)
   */
  private flattenGroups(groups: EntityGroup[]): RankedResult[] {
    const ranked: RankedResult[] = [];

    for (const group of groups) {
      const { primary, supplemental } = this.pickBest(group);

      const crossSource = group.sources.size > 1;
      const basePriority = crossSource ? 0 : 1;

      // Primary result
      ranked.push({
        result: primary,
        entityName: group.displayName,
        crossSource,
        entityScore: group.score,
      });

      // Include best supplemental of different type
      const supType = supplemental.find((s) => s.type !== primary.type);
      if (supType) {
        ranked.push({
          result: supType,
          entityName: group.displayName,
          crossSource,
          entityScore: group.score * 0.85, // Slightly lower for supplemental
        });
      }

      // Include one more if it's from a different source than primary
      const supSource = supplemental.find(
        (s) => s.source !== primary.source && s.type !== primary.type,
      );
      if (supSource && supSource.id !== supType?.id) {
        ranked.push({
          result: supSource,
          entityName: group.displayName,
          crossSource,
          entityScore: group.score * 0.7,
        });
      }
    }

    return ranked;
  }

  /**
   * Pick best primary + supplemental results from an entity group.
   */
  private pickBest(group: EntityGroup) {
    const graphResults = group.results.filter((r) => r.source === 'graph');
    const qmdResults = group.results.filter((r) => r.source === 'qmd');

    const sortByRelevance = (a: RetrievalResult, b: RetrievalResult) => {
      const typeDiff = (TYPE_PRIORITY[a.type] ?? 3) - (TYPE_PRIORITY[b.type] ?? 3);
      if (typeDiff !== 0) return typeDiff;
      return b.score - a.score;
    };

    graphResults.sort(sortByRelevance);
    qmdResults.sort(sortByRelevance);

    // Primary = best graph result (structured definition), else best qmd
    const primary = graphResults[0] ?? qmdResults[0];
    const supplemental = group.results.filter((r) => r.id !== primary.id);

    return { primary, supplemental };
  }

  /**
   * Sort ranked results by entity priority then individual score.
   */
  /**
   * Apply temporal decay to graph results based on updatedAt timestamp.
   * Mirrors OpenClaw's temporalDecay concept at the merger level.
   * Formula: score_final = score * 0.5^(daysSinceUpdate / halfLifeDays)
   */
  private applyDecayToResults(results: RetrievalResult[]): RetrievalResult[] {
    const halfLife = this.config.decayHalfLifeDays ?? 0;
    if (halfLife <= 0) return results;

    const now = Date.now();
    return results.map((r) => {
      if (r.source !== 'graph') return r;
      const updatedAt = r.metadata?.updatedAt as number | undefined;
      if (!updatedAt || updatedAt <= 0) return r;

      const msSinceUpdate = now - updatedAt;
      const daysSinceUpdate = msSinceUpdate / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate <= 0) return r;

      const decayFactor = Math.pow(0.5, daysSinceUpdate / halfLife);
      const decayedScore = r.score * decayFactor;

      return {
        ...r,
        score: decayedScore,
        metadata: { ...r.metadata, decayedFrom: r.score, decayFactor },
      };
    });
  }

  private entityPrioritySort(ranked: RankedResult[]): RetrievalResult[] {
    return ranked
      .sort((a, b) => {
        // Cross-source entities first
        if (a.crossSource !== b.crossSource) {
          return a.crossSource ? -1 : 1;
        }
        // Then by entity score
        if (b.entityScore !== a.entityScore) {
          return b.entityScore - a.entityScore;
        }
        // Then by individual type priority
        const typeDiff =
          (TYPE_PRIORITY[a.result.type] ?? 3) -
          (TYPE_PRIORITY[b.result.type] ?? 3);
        if (typeDiff !== 0) return typeDiff;
        return b.result.score - a.result.score;
      })
      .map((r) => r.result);
  }

  /**
   * Optional LLM re-ranking of top results.
   */
  async llmRerank(
    results: RetrievalResult[],
    query: string,
    llmFn: (prompt: string) => Promise<string>,
  ): Promise<RetrievalResult[]> {
    if (!results.length || results.length < 2) return results;

    const topK = Math.min(results.length, 10);
    const candidates = results.slice(0, topK);

    // Group candidates by entity for context (BUGFIX P1-1: 传递 fuzzyMatchThreshold)
    const groups = groupByEntity(candidates, this.config.fuzzyMatchThreshold);

    const candidateText = groups
      .map((g, i) => {
        const sources = [...g.sources].join('+');
        return `[${i}] "${g.displayName}" [${sources}] (confidence: ${(g.score * 100).toFixed(0)}%): ${g.results[0]?.content.slice(0, 150)}`;
      })
      .join('\n---\n');

    const prompt = `You are a relevance re-ranker for a knowledge system. Given the user query and entity candidates below, return a comma-separated list of the candidate indices sorted by relevance (most relevant first). Only return the indices.

Query: ${query}

Candidates:
${candidateText}

Indices (most relevant first):`;

    try {
      const output = await llmFn(prompt);
      const indices = output
        .replace(/[^\d,\s]/g, '')
        .split(/[,\s]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n) && n >= 0 && n < groups.length);

      // Deduplicate indices
      const seen = new Set<number>();
      const uniqueIndices: number[] = [];
      for (const idx of indices) {
        if (!seen.has(idx)) {
          seen.add(idx);
          uniqueIndices.push(idx);
        }
      }

      // Reorder: groups by LLM → remaining groups → individual results
      const rerankedGroups = uniqueIndices.map((i) => groups[i]);
      const remainingGroups = groups.filter(
        (_, i) => !uniqueIndices.includes(i),
      );

      const rerankedResults = [...rerankedGroups, ...remainingGroups].flatMap(
        (g) => g.results,
      );

      return rerankedResults.slice(0, this.config.maxResults);
    } catch {
      // Fallback to entity priority sort
      return this.entityPrioritySort(
        this.flattenGroups(groups),
      ).slice(0, this.config.maxResults);
    }
  }
}

interface RankedResult {
  result: RetrievalResult;
  entityName: string;
  crossSource: boolean;
  entityScore: number;
}
