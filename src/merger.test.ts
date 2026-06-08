import { describe, it, expect } from 'vitest';
import { Merger, type MergerConfig } from './merger';
import type { RetrievalResult } from './types';

const cfg: MergerConfig = { maxResults: 10, fuzzyMatchThreshold: 0.85, decayHalfLifeDays: 30 };
function mk(id: string, src: 'qmd'|'graph', sc: number, ct: string): RetrievalResult {
  return { id, content: ct, source: src, type: src === 'graph' ? 'definition' as const : 'raw' as const, score: sc, metadata: {} };
}

describe('Merger', () => {
  it('merges qmd+graph', () => {
    const m = new Merger(cfg);
    const r = m.merge([mk('a','qmd',0.9,'memory')], [mk('b','graph',0.85,'[SKILL] X')]);
    expect(r.length).toBeGreaterThanOrEqual(1);
  });
  it('handles empty', () => { expect(new Merger(cfg).merge([],[])).toHaveLength(0); });
  it('dedups by id', () => {
    const m = new Merger(cfg);
    const d = mk('x','qmd',0.8,'same');
    expect(m.merge([d],[d])).toHaveLength(1);
  });
});
