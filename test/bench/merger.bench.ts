import { bench, describe } from 'vitest';
import { Merger } from '../../src/merger.js';
import type { RetrievalResult } from '../../src/types.js';

function makeResult(opts: { id: string; source: 'qmd' | 'graph'; type: 'definition' | 'relation' | 'raw'; score: number; content: string }): RetrievalResult {
  return { ...opts, metadata: {} };
}

describe('Merger Performance', () => {
  const merger = new Merger({ maxResults: 10, fuzzyMatchThreshold: 0.85 });

  // 100 条结果
  const smallQmd = Array.from({ length: 50 }, (_, i) => makeResult({ id: `qmd-${i}`, source: 'qmd', type: 'raw', score: 0.5 + Math.random() * 0.5, content: `Document ${i} content about TypeScript and React` }));
  const smallGraph = Array.from({ length: 50 }, (_, i) => makeResult({ id: `graph-${i}`, source: 'graph', type: 'definition', score: 0.5 + Math.random() * 0.5, content: `[SKILL] Entity ${i} for TypeScript` }));

  bench('merge 100 results', () => {
    merger.merge(smallQmd, smallGraph);
  });

  // 1000 条结果
  const mediumQmd = Array.from({ length: 500 }, (_, i) => makeResult({ id: `qmd-${i}`, source: 'qmd', type: 'raw', score: Math.random(), content: `Document ${i} content about various topics` }));
  const mediumGraph = Array.from({ length: 500 }, (_, i) => makeResult({ id: `graph-${i}`, source: 'graph', type: 'definition', score: Math.random(), content: `[SKILL] Entity ${i}` }));

  bench('merge 1000 results', () => {
    merger.merge(mediumQmd, mediumGraph);
  });

  // 5000 条结果
  const largeQmd = Array.from({ length: 2500 }, (_, i) => makeResult({ id: `qmd-${i}`, source: 'qmd', type: 'raw', score: Math.random(), content: `Document ${i}` }));
  const largeGraph = Array.from({ length: 2500 }, (_, i) => makeResult({ id: `graph-${i}`, source: 'graph', type: 'definition', score: Math.random(), content: `[SKILL] Entity ${i}` }));

  bench('merge 5000 results', () => {
    merger.merge(largeQmd, largeGraph);
  });
});