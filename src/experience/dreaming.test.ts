/**
 * DreamingEngine 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreamingEngine } from './dreaming';
import type { ExperienceStorage, PendingRow } from './storage';

function createMockStorage(overrides?: Partial<ExperienceStorage>): ExperienceStorage {
  return {
    fetchPending: vi.fn().mockResolvedValue([]),
    saveDistilled: vi.fn().mockResolvedValue(undefined),
    searchRelevant: vi.fn().mockResolvedValue([]),
    incrementMatchCount: vi.fn().mockResolvedValue(undefined),
    saveRaw: vi.fn().mockResolvedValue(undefined),
    searchByContext: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ExperienceStorage;
}

describe('DreamingEngine', () => {
  it('should return zero results when no pending experiences', async () => {
    const storage = createMockStorage();
    const engine = new DreamingEngine(storage, undefined, { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const result = await engine.dream();
    expect(result.processed).toBe(0);
    expect(result.distilled).toBe(0);
    expect(storage.fetchPending).toHaveBeenCalledWith(200);
  });

  it('should cluster and synthesize pending experiences', async () => {
    const pendings: PendingRow[] = [
      {
        id: 'p1', source: 'correction', context: 'use neo4j helper for credentials',
        detail: 'credential hardcoding issue', projectName: null, taskId: null,
        createdAt: new Date(),
      },
      {
        id: 'p2', source: 'correction', context: 'use neo4j helper for credentials',
        detail: 'avoid hardcoded passwords', projectName: null, taskId: null,
        createdAt: new Date(),
      },
    ];

    const saveDistilled = vi.fn().mockResolvedValue(undefined);
    const storage = createMockStorage({
      fetchPending: vi.fn().mockResolvedValue(pendings),
      saveDistilled,
    });

    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const engine = new DreamingEngine(storage, { clusterThreshold: 0.1 }, logger);
    const result = await engine.dream();

    expect(result.processed).toBe(2);
    expect(result.distilled).toBe(1); // clustered into 1 group
    expect(saveDistilled).toHaveBeenCalledTimes(1);

    const distilled = saveDistilled.mock.calls[0][0];
    expect(distilled.type).toBe('correction');
    expect(distilled.rawIds).toEqual(['p1', 'p2']);
  });

  it('should handle clustering with varying similarity', async () => {
    const pendings: PendingRow[] = [
      { id: 'p1', source: 'correction', context: 'fix neo4j connection',
        detail: 'connection timeout', projectName: null, taskId: null, createdAt: new Date() },
      { id: 'p2', source: 'failure', context: 'disk space low',
        detail: 'monitor disk usage', projectName: null, taskId: null, createdAt: new Date() },
      { id: 'p3', source: 'correction', context: 'fix neo4j driver',
        detail: 'wrong driver version', projectName: null, taskId: null, createdAt: new Date() },
    ];

    const saveDistilled = vi.fn().mockResolvedValue(undefined);
    const storage = createMockStorage({
      fetchPending: vi.fn().mockResolvedValue(pendings),
      saveDistilled,
    });

    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const engine = new DreamingEngine(storage, { clusterThreshold: 0.2 }, logger);
    const result = await engine.dream();

    expect(result.processed).toBe(3);
    // p1 and p3 should be in the same cluster (both correction + context overlap)
    // p2 should be separate (different source)
    expect(result.distilled).toBeGreaterThanOrEqual(1);
  });
});
