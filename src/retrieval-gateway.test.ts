import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetrievalGateway } from './retrieval-gateway';
import { QmdClient } from './qmd-client';
import { GraphAdapter } from './adapters/graph-adapter';
import type { MergerConfig } from './merger';

vi.mock('./qmd-client', () => ({
  QmdClient: vi.fn(() => ({ query: vi.fn().mockResolvedValue([]), ping: vi.fn().mockResolvedValue(true), get: vi.fn(), multiGet: vi.fn() })),
}));
vi.mock('./adapters/graph-adapter', () => ({
  GraphAdapter: vi.fn(() => ({ search: vi.fn().mockResolvedValue([]), searchExperience: vi.fn().mockResolvedValue([]), health: vi.fn().mockResolvedValue(false), processFeedback: vi.fn().mockResolvedValue({ processed:0, updatedNodes:0 }) })),
}));

const mc: MergerConfig = { maxResults: 10, fuzzyMatchThreshold: 0.85, decayHalfLifeDays: 30 };
let gateway: RetrievalGateway;

beforeEach(() => {
  vi.clearAllMocks();
  gateway = new RetrievalGateway(new QmdClient(), new GraphAdapter(), mc);
});

describe('RetrievalGateway', () => {
  it('creates instance', () => {
    expect(gateway).toBeInstanceOf(RetrievalGateway);
  });
  it('has expected methods', () => {
    expect(typeof gateway.search).toBe('function');
    expect(typeof gateway.health).toBe('function');
    expect(typeof gateway.getPerfSummary).toBe('function');
  });
  it('returns empty for empty query', async () => {
    expect(await gateway.search('')).toEqual([]);
  });
  it('tracks perf stats', async () => {
    await gateway.search('test');
    expect(gateway.getPerfSummary()).toContain('qmd');
  });
});
