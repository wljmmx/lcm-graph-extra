import { describe, it, expect } from 'vitest';
import { Merger, type MergerConfig } from '../src/merger.js';
import type { RetrievalResult } from '../src/types.js';

const defaultConfig: MergerConfig = {
  maxResults: 10,
  fuzzyMatchThreshold: 0.85,
  decayHalfLifeDays: 0, // Disable decay for merge tests
};

function makeResult(opts: {
  id?: string;
  source: 'qmd' | 'graph';
  type: 'definition' | 'relation' | 'raw';
  score: number;
  content: string;
  metadata?: Record<string, unknown>;
}): RetrievalResult {
  return {
    id: opts.id ?? `test-${opts.source}-${Date.now()}-${Math.random()}`,
    content: opts.content,
    source: opts.source,
    type: opts.type,
    score: opts.score,
    metadata: opts.metadata ?? {},
  };
}

describe('Merger', () => {
  const merger = new Merger(defaultConfig);

  it('should return empty for no results', () => {
    expect(merger.merge([], [])).toEqual([]);
  });

  it('should merge qmd and graph results', () => {
    const qmd = [
      makeResult({ source: 'qmd', type: 'raw', score: 0.8, content: 'TypeScript types' }),
    ];
    const graph = [
      makeResult({ source: 'graph', type: 'definition', score: 0.9, content: '[SKILL] TypeScript' }),
    ];
    const merged = merger.merge(qmd, graph);
    expect(merged.length).toBeGreaterThanOrEqual(1);
    expect(merged.length).toBeLessThanOrEqual(3); // 1 primary + up to 2 supplemental
  });

  it('should prioritize definition over raw', () => {
    const qmd = makeResult({ source: 'qmd', type: 'raw', score: 0.9, content: 'Python' });
    const graph = makeResult({ source: 'graph', type: 'definition', score: 0.8, content: '[SKILL] Python' });
    const merged = merger.merge([qmd], [graph]);
    expect(merged[0].type).toBe('definition');
  });

  it('should cap at maxResults', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({
        source: i % 2 === 0 ? 'qmd' : 'graph',
        type: 'raw',
        score: 0.5 + Math.random() * 0.5,
        content: `Result ${i}`,
      }),
    );
    const qmd = results.filter((r) => r.source === 'qmd');
    const graph = results.filter((r) => r.source === 'graph');
    const merged = merger.merge(qmd, graph);
    expect(merged.length).toBeLessThanOrEqual(10);
  });

  it('should handle empty results from one engine', () => {
    const qmd = [
      makeResult({ source: 'qmd', type: 'raw', score: 0.9, content: 'TypeScript' }),
    ];
    const merged = merger.merge(qmd, []);
    expect(merged.length).toBeGreaterThanOrEqual(1);
  });

  it('should produce cross-source results for same entity', () => {
    const qmd = [
      makeResult({
        id: 'qmd-ts',
        source: 'qmd',
        type: 'raw',
        score: 0.8,
        content: 'File: note.md\nTitle: TypeScript discussion\nDiscussed type system',
        metadata: {},
      }),
    ];
    const graph = [
      makeResult({
        id: 'graph-ts',
        source: 'graph',
        type: 'definition',
        score: 0.9,
        content: '[SKILL] TypeScript\nType system knowledge',
        metadata: { name: 'TypeScript' },
      }),
    ];
    const merged = merger.merge(qmd, graph);
    // Both sources should be represented
    const sources = new Set(merged.map((r) => r.source));
    // At least one result should have the graph source (which is the primary)
    expect(sources.has('graph')).toBe(true);
  });
});

describe('Merger with decay', () => {
  const decayConfig: MergerConfig = {
    ...defaultConfig,
    decayHalfLifeDays: 30,
  };
  const decayMerger = new Merger(decayConfig);

  it('should not decay non-graph results', () => {
    const result = makeResult({
      source: 'qmd',
      type: 'raw',
      score: 0.9,
      content: 'test',
    });
    const merged = decayMerger.merge([result], []);
    expect(merged[0].score).toBe(0.9);
  });

  it('should decay graph results with old updatedAt', () => {
    const oldTimestamp = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 days ago
    const result = makeResult({
      source: 'graph',
      type: 'definition',
      score: 1.0,
      content: '[SKILL] Old knowledge',
      metadata: { updatedAt: oldTimestamp },
    });
    const merged = decayMerger.merge([], [result]);
    expect(merged.length).toBeGreaterThan(0);
    // 90 days at 30-day half-life = 0.5^3 = 0.125
    expect(merged[0].score).toBeLessThan(0.2);
  });
});

describe('Merger.llmRerank', () => {
  const merger = new Merger(defaultConfig);

  it('should pass through with < 2 results', async () => {
    const results: RetrievalResult[] = [
      makeResult({ source: 'qmd', type: 'raw', score: 0.9, content: 'test' }),
    ];
    const reranked = await merger.llmRerank(results, 'query', async (p) => '0');
    expect(reranked.length).toBe(1);
  });
});
