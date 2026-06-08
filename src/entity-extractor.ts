/**
 * lcm-graph-extra — Entity Extractor
 *
 * Extracts entity names from retrieval results for entity-level
 * cross-engine dedup and aggregation.
 *
 * Strategy:
 * - qmd results: Parse file path, title, and snippet for entity references
 * - graph results: Use node `name` field directly
 * - Normalize: lowercase, trim, remove common prefixes
 */

import type { RetrievalResult } from './types.js';

export interface EntityGroup {
  /** Normalized entity name */
  name: string;
  /** Original display name (most common form) */
  displayName: string;
  /** All results belonging to this entity */
  results: RetrievalResult[];
  /** Combined score (max of all results) */
  score: number;
  /** Sources this entity appears in */
  sources: Set<'qmd' | 'graph'>;
}

/**
 * Extract entity groups from merged results.
 * Groups results by normalized entity name, then merges
 * qmd + graph sources for the same entity.
 */
export function groupByEntity(results: RetrievalResult[]): EntityGroup[] {
  if (!results.length) return [];

  const groups = new Map<string, EntityGroup>();

  for (const r of results) {
    const name = extractEntityName(r);
    const normalized = normalizeEntityName(name);

    let group = groups.get(normalized);
    if (!group) {
      group = {
        name: normalized,
        displayName: name,
        results: [],
        score: 0,
        sources: new Set(),
      };
      groups.set(normalized, group);
    }

    group.results.push(r);
    group.sources.add(r.source);
    group.score = Math.max(group.score, r.score);

    // Update displayName to most common form
    group.displayName = pickBestDisplayName(group.results);
  }

  // Fuzzy merge similar entity names
  return fuzzyMergeGroups(Array.from(groups.values()));
}

/**
 * Extract entity name from a retrieval result.
 */
function extractEntityName(r: RetrievalResult): string {
  // For graph results, use the name from metadata
  if (r.source === 'graph') {
    const metaName = r.metadata?.name;
    if (typeof metaName === 'string' && metaName.trim()) {
      return metaName.trim();
    }
  }

  // For qmd results, try to extract from content
  if (r.source === 'qmd') {
    // Try "Title: xxx" format
    const titleMatch = r.content.match(/Title:\s*(.+)/);
    if (titleMatch) {
      const title = titleMatch[1].trim();
      // Remove "Session: " prefix and date
      const cleanTitle = title.replace(/^Session:\s*/, '').trim();
      if (cleanTitle.length > 0) return cleanTitle;
    }
  }

  // Fallback: use first meaningful content line (up to 60 chars)
  const firstLine = r.content
    .split('\n')
    .find((l) => l.trim().length > 0 && !l.startsWith('File:') && !l.startsWith('Score:') && !l.startsWith('@@'));

  if (firstLine) {
    const trimmed = firstLine.trim().slice(0, 60);
    if (trimmed.length > 3) return trimmed;
  }

  // Last resort: use result id
  return `entity_${r.id.slice(0, 8)}`;
}

/**
 * Normalize entity name for comparison.
 */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/^\[([^\]]+)\]\s*/, '') // Remove [SKILL] prefix
    .replace(/^(关于|对|在|使用|通过|基于)\s*/, '') // Remove common Chinese prefixes
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, ' ') // Keep alnum, CJK, spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein distance for fuzzy entity name matching.
 */
export function levenshteinDistance(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;

  const matrix: number[] = new Array(bn + 1);
  for (let i = 0; i <= bn; i++) matrix[i] = i;

  for (let i = 1; i <= an; i++) {
    let prev = i;
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(
        prev + 1,
        matrix[j] + 1,
        matrix[j - 1] + cost,
      );
      matrix[j - 1] = prev;
      prev = val;
    }
    matrix[bn] = prev;
  }
  return matrix[bn];
}

/**
 * Calculate entity name similarity (0-1), 1 = identical.
 */
export function entityNameSimilarity(a: string, b: string): number {
  const normalizedA = normalizeEntityName(a);
  const normalizedB = normalizeEntityName(b);

  if (normalizedA === normalizedB) return 1.0;

  const dist = levenshteinDistance(normalizedA, normalizedB);
  const maxLen = Math.max(normalizedA.length, normalizedB.length);
  if (maxLen === 0) return 1.0;

  return 1 - dist / maxLen;
}

/**
 * Fuzzy merge groups with similar entity names.
 * Threshold > 0.75 triggers merge.
 */
function fuzzyMergeGroups(groups: EntityGroup[]): EntityGroup[] {
  if (groups.length <= 1) return groups;

  const merged: EntityGroup[] = [];
  const used = new Set<number>();

  for (let i = 0; i < groups.length; i++) {
    if (used.has(i)) continue;
    used.add(i);

    let current = groups[i];

    for (let j = i + 1; j < groups.length; j++) {
      if (used.has(j)) continue;

      const sim = entityNameSimilarity(current.name, groups[j].name);
      if (sim >= 0.75) {
        // Merge: keep higher displayName and combine results
        current = mergeTwoGroups(current, groups[j]);
        used.add(j);
      }
    }

    merged.push(current);
  }

  return merged;
}

/**
 * Merge two entity groups into one.
 */
function mergeTwoGroups(a: EntityGroup, b: EntityGroup): EntityGroup {
  const allResults = [...a.results, ...b.results];
  const allSources = new Set([...a.sources, ...b.sources]);
  const bestScore = Math.max(a.score, b.score);
  const bestName = pickBestDisplayName(allResults);

  return {
    name: a.name.length <= b.name.length ? a.name : b.name,
    displayName: bestName,
    results: allResults,
    score: bestScore,
    sources: allSources,
  };
}

/**
 * Pick the best display name from a set of results.
 * Prefers graph results (structured names), then shortest meaningful name.
 */
function pickBestDisplayName(results: RetrievalResult[]): string {
  // Prefer graph result names (structured entities)
  for (const r of results) {
    if (r.source === 'graph') {
      const metaName = r.metadata?.name;
      if (typeof metaName === 'string' && metaName.trim()) {
        return metaName.trim();
      }
    }
  }

  // Fallback: shortest non-id name
  let best = results[0]?.content.slice(0, 60) ?? 'unknown';
  for (const r of results) {
    const name = extractEntityName(r);
    if (name.length < best.length && name.length > 2) {
      best = name;
    }
  }
  return best.slice(0, 60);
}

/**
 * For each entity group, pick the best representative result.
 * Priority: definition > relation > raw (within same source)
 * Cross-source: prefer graph for structure, qmd for evidence
 */
export function pickRepresentative(group: EntityGroup): {
  primary: RetrievalResult;
  supplemental: RetrievalResult[];
} {
  const graphResults = group.results.filter((r) => r.source === 'graph');
  const qmdResults = group.results.filter((r) => r.source === 'qmd');

  // Sort within each source by type priority
  const typeOrder = { definition: 0, relation: 1, raw: 2 };

  const sortByType = (a: RetrievalResult, b: RetrievalResult) =>
    (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3) || b.score - a.score;

  graphResults.sort(sortByType);
  qmdResults.sort(sortByType);

  // Primary = best graph result (structure) if exists, else best qmd result
  const primary = graphResults[0] ?? qmdResults[0];

  // Supplemental = other results of different types
  const supplemental = group.results.filter(
    (r) => r.id !== primary.id,
  );

  return { primary, supplemental };
}
