import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { PluginInstance, OpenClawContext } from '../register';
import { GraphMemoryManager } from '../core/graph';
import { onBeforeTurn, __test__ } from './before-turn';

// ---------------------------------------------------------------------------
// Mock QmdClient — simulate MCP failure so tests exercise DAG fallback
// ---------------------------------------------------------------------------

vi.mock('../qmd-client', () => ({
  QmdClient: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockRejectedValue(new Error('MCP not available in tests')),
    ping: vi.fn().mockResolvedValue(false),
    get: vi.fn().mockResolvedValue(null),
    multiGet: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock GraphAdapter to avoid neo4j import in tests
vi.mock('../adapters/graph-adapter', () => ({
  GraphAdapter: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockRejectedValue(new Error('graph not available in tests')),
    searchExperience: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue(false),
    processFeedback: vi.fn().mockResolvedValue({ processed: 0, updatedNodes: 0 }),
    close: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildPluginInstance(memoryDir?: string): PluginInstance {
  const ctx: OpenClawContext = { config: {}, logger: pino({ level: 'silent' }), memoryDir };
  return {
    config: {
      summaryStrategy: 'strategy' as const,
      maxGraphDepth: 10,
      maxNodeCount: 5000,
      enableCrossFileLinkage: true,
      crossReferenceRetentionDays: 90,
      maxTokens: 32768,
      budgetRatio: 0.3,
    },
    logger: ctx.logger!,
    context: ctx,
    unregister: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onBeforeTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string when memoryDir is not set', async () => {
    const result = await onBeforeTurn(buildPluginInstance());
    expect(result).toBe('');
  });

  it('returns empty string when both retrieval gateways fail (no DAG fallback)', async () => {
    // QmdClient and GraphAdapter are mocked to reject, so retrieval returns empty.
    const injected = await onBeforeTurn(buildPluginInstance('src/core/test-fixtures/build-test'));
    expect(injected).toBe('');
  });

  it('handles missing memoryDir without throwing', async () => {
    await expect(onBeforeTurn(buildPluginInstance('/nonexistent/path'))).resolves.toBeDefined();
  });
});

describe('__test__.estimateTokens', () => {
  it('estimates ceil(len/4)', () => {
    expect(__test__.estimateTokens('hello')).toBe(2);
    expect(__test__.estimateTokens('abcd')).toBe(1);
    expect(__test__.estimateTokens('')).toBe(0);
  });
});

describe('__test__.computeBudget', () => {
  it('uses budgetRatio * maxTokens', () => {
    const inst = buildPluginInstance();
    expect(__test__.computeBudget(inst)).toBe(9830);
    inst.config.maxTokens = 16384;
    inst.config.budgetRatio = 0.5;
    expect(__test__.computeBudget(inst)).toBe(8192);
  });
});
// [removed] queryRelevantNodes tests — DAG fallback replaced by RetrievalGateway


describe('__test__.formatRetrievalResults', () => {
  it('formats qmd results with title and score', () => {
    const results = [
      { id: '#abc', content: 'File: test.md:5\nTitle: Test Doc\ncontent', source: 'qmd' as const, type: 'raw' as const, score: 0.95, metadata: { title: 'Test Doc', file: 'test.md' } },
    ];
    const ctx = __test__.formatRetrievalResults(results, 1000);
    expect(ctx).toContain('Injected Context');
    expect(ctx).toContain('Test Doc');
    expect(ctx).toContain('95%');
  });

  it('returns empty string for empty results', () => {
    expect(__test__.formatRetrievalResults([], 1000)).toBe('');
  });

  it('formats graph results with knowledge graph label', () => {
    const results = [
      { id: 'g1', content: '[SKILL] TypeScript\nSome description', source: 'graph' as const, type: 'definition' as const, score: 0.8, metadata: { name: 'TypeScript', nodeType: 'SKILL' } },
    ];
    const ctx = __test__.formatRetrievalResults(results, 1000);
    expect(ctx).toContain('知识图谱');
    expect(ctx).toContain('TypeScript');
    expect(ctx).toContain('80%');
  });
});
