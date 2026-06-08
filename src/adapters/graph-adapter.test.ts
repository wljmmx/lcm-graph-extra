import { describe, it, expect } from 'vitest';
import { GraphAdapter, type GraphAdapterConfig } from './graph-adapter';
import type { Neo4jConfig } from '../types';

const nc: Neo4jConfig = { uri: 'bolt://x:7687', user: 'neo4j', password: 'p' };
const ac: GraphAdapterConfig = { enabled: true, searchLimit: 5 };

describe('GraphAdapter', () => {
  it('returns empty when disabled', async () => {
    const a = new GraphAdapter(nc, { ...ac, enabled: false });
    expect(await a.search('t')).toEqual([]);
    expect(await a.searchExperience('t')).toEqual([]);
  });
  it('search returns empty when no server', async () => {
    const a = new GraphAdapter(nc, ac);
    expect(await a.search('t')).toEqual([]);
  });
  it('processFeedback returns zeros', async () => {
    const a = new GraphAdapter(nc, ac);
    expect(await a.processFeedback()).toEqual({ processed: 0, updatedNodes: 0 });
  });
  it('health false when not connected', async () => {
    const a = new GraphAdapter(nc, ac);
    expect(await a.health()).toBe(false);
  });
});
