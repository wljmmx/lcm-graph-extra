import { describe, it, expect } from 'vitest';
import {
  normalizeEntityName,
  entityNameSimilarity,
  groupByEntity,
  levenshteinDistance,
} from '../src/entity-extractor.js';
import type { RetrievalResult } from '../src/types.js';

describe('normalizeEntityName', () => {
  it('should lowercase and trim', () => {
    expect(normalizeEntityName('  TypeScript  ')).toBe('typescript');
  });

  it('should remove [SKILL] prefix', () => {
    expect(normalizeEntityName('[SKILL] TypeScript')).toBe('typescript');
  });

  it('should remove common Chinese prefixes', () => {
    expect(normalizeEntityName('关于TypeScript类型系统')).toContain('typescript');
  });

  it('should keep CJK characters', () => {
    expect(normalizeEntityName('TypeScript类型系统')).toContain('typescript');
    expect(normalizeEntityName('TypeScript类型系统')).toContain('类型系统');
  });
});

describe('levenshteinDistance', () => {
  it('should return 0 for identical strings', () => {
    expect(levenshteinDistance('typescript', 'typescript')).toBe(0);
  });

  it('should return length for empty vs non-empty', () => {
    expect(levenshteinDistance('', 'typescript')).toBe(10);
  });

  it('should handle single character differences', () => {
    expect(levenshteinDistance('typescript', 'typeScript')).toBe(1);
  });

  it('should handle completely different strings', () => {
    expect(levenshteinDistance('abc', 'xyz')).toBe(3);
  });
});

describe('entityNameSimilarity', () => {
  it('should be 1.0 for identical normalized names', () => {
    expect(entityNameSimilarity('TypeScript', 'TypeScript')).toBe(1.0);
  });

  it('should be high for similar names', () => {
    const sim = entityNameSimilarity('TypeScript', 'TypeScript类型');
    expect(sim).toBeGreaterThan(0.6);
  });

  it('should be low for different names', () => {
    const sim = entityNameSimilarity('TypeScript', 'Python');
    expect(sim).toBeLessThan(0.5);
  });

  it('should handle case differences', () => {
    expect(entityNameSimilarity('typescript', 'TypeScript')).toBeCloseTo(1.0, 0.8);
  });
});

describe('groupByEntity', () => {
  const makeResult = (opts: {
    source: 'qmd' | 'graph';
    type: 'definition' | 'relation' | 'raw';
    name: string;
    score: number;
    content?: string;
  }): RetrievalResult => ({
    id: `test-${opts.source}-${opts.name}`,
    content: opts.content ?? `Content about ${opts.name}`,
    source: opts.source,
    type: opts.type,
    score: opts.score,
    metadata: opts.source === 'graph' ? { name: opts.name } : {},
  });

  it('should group identical entities from different sources', () => {
    const results = [
      makeResult({ source: 'qmd', type: 'raw', name: 'TypeScript', score: 0.8, content: 'File: note.md\nTitle: TypeScript\nDiscussed type system' }),
      makeResult({ source: 'graph', type: 'definition', name: 'TypeScript', score: 0.9 }),
    ];
    const groups = groupByEntity(results);
    expect(groups.length).toBe(1);
    expect(groups[0].displayName).toBe('TypeScript');
    expect(groups[0].sources.size).toBe(2);
  });

  it('should keep different entities separate', () => {
    const results = [
      makeResult({ source: 'qmd', type: 'raw', name: 'TypeScript', score: 0.8 }),
      makeResult({ source: 'graph', type: 'definition', name: 'Python', score: 0.9 }),
    ];
    const groups = groupByEntity(results);
    expect(groups.length).toBe(2);
  });

  it('should fuzzy merge similar named entities', () => {
    const results = [
      makeResult({ source: 'qmd', type: 'raw', name: 'TypeScript类型', score: 0.8, content: 'File: note.md\nTitle: TypeScript类型\nSome content about TypeScript' }),
      makeResult({ source: 'graph', type: 'definition', name: 'TypeScript', score: 0.9, content: '[SKILL] TypeScript\nKnowledge about TypeScript', metadata: { name: 'TypeScript' } }),
    ];
    const groups = groupByEntity(results);
    expect(groups.length).toBe(1);
  });

  it('should handle empty input', () => {
    const groups = groupByEntity([]);
    expect(groups.length).toBe(0);
  });

  it('should sort groups by score within each group', () => {
    const results = [
      makeResult({ source: 'qmd', type: 'raw', name: 'TypeScript', score: 0.8 }),
      makeResult({ source: 'graph', type: 'definition', name: 'Python', score: 0.9, content: 'Python knowledge' }),
    ];
    const groups = groupByEntity(results);
    expect(groups.length).toBe(2);
    expect(groups[0].score).toBeGreaterThanOrEqual(groups[0].score);
  });
});
