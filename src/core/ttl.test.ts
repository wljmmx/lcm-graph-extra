import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphMemoryManager } from './graph';
import {
  findExpiredNodes,
  cleanupExpiredNodes,
  applyWeightDecay,
  startCleanupScheduler,
  DEFAULT_TTL_CONFIG,
} from './ttl';
import type { TTLConfig } from './ttl';

// ---------- helpers -------------------------------------------------------

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

const now = () => new Date().toISOString();

let g: GraphMemoryManager;
let cfg: TTLConfig;

beforeEach(() => {
  g = new GraphMemoryManager();
  cfg = { ...DEFAULT_TTL_CONFIG };
});

// ---------- Test 1: findExpiredNodes identifies old + low-weight nodes ----

describe('TTL — findExpiredNodes', () => {
  it('correctly identifies expired nodes', () => {
    // Old node with low weight → should expire
    g.addNode({
      id: 'old-low', type: 'summary', metadata: {},
      createdAt: isoDaysAgo(100), updatedAt: isoDaysAgo(50),
      weight: 0.05,
    });
    // Recent node → should NOT expire
    g.addNode({
      id: 'new-normal', type: 'summary', metadata: {},
      createdAt: now(), updatedAt: now(),
      weight: 0.8,
    });

    const expired = findExpiredNodes(g, cfg);
    expect(expired).toContain('old-low');
    expect(expired).not.toContain('new-normal');
  });
});

// ---------- Test 2: findExpiredNodes respects pinned exemption -----------

describe('TTL — pinned exemption', () => {
  it('does not return pinned nodes even when they are old + low-weight', () => {
    g.addNode({
      id: 'pinned-old', type: 'summary', metadata: {},
      createdAt: isoDaysAgo(120), updatedAt: isoDaysAgo(60),
      weight: 0.01, pinned: true,
    });

    cfg.pinnedExempt = true;
    const expired = findExpiredNodes(g, cfg);
    expect(expired).not.toContain('pinned-old');
    expect(expired.length).toBe(0);
  });

  it('returns pinned nodes when pinnedExempt is false', () => {
    g.addNode({
      id: 'pinned-old', type: 'summary', metadata: {},
      createdAt: isoDaysAgo(120), updatedAt: isoDaysAgo(60),
      weight: 0.01, pinned: true,
    });

    cfg.pinnedExempt = false;
    const expired = findExpiredNodes(g, cfg);
    expect(expired).toContain('pinned-old');
  });
});

// ---------- Test 3: cleanupExpiredNodes deletes nodes and edges -----------

describe('TTL — cleanupExpiredNodes', () => {
  it('deletes expired nodes AND removes their edges', async () => {
    // Create two nodes with an edge; one is expired
    g.addNode({
      id: 'survivor', type: 'summary', metadata: {},
      createdAt: now(), updatedAt: now(),
      weight: 0.9,
    });
    g.addNode({
      id: 'victim', type: 'memory', metadata: {},
      createdAt: isoDaysAgo(100), updatedAt: isoDaysAgo(50),
      weight: 0.02,
    });
    g.addEdge({ source: 'survivor', target: 'victim', relationType: 'references', createdAt: now() });

    expect(g.getNodeCount()).toBe(2);
    expect(g.getEdgeCount()).toBe(1);

    const result = await cleanupExpiredNodes(g, cfg);
    expect(result.deleted).toContain('victim');
    expect(g.getNodeCount()).toBe(1);
    expect(g.getEdgeCount()).toBe(0); // edge removed with victim
  });
});

// ---------- Test 4: applyWeightDecay computes correctly -------------------

describe('TTL — applyWeightDecay', () => {
  it('correctly applies exponential decay', () => {
    // Node updated exactly halfLifeDays ago → weight should halve
    const halfLife = 45;
    const oldWeight = 0.8;
    g.addNode({
      id: 'decaying', type: 'summary', metadata: {},
      createdAt: isoDaysAgo(60), updatedAt: isoDaysAgo(halfLife),
      weight: oldWeight,
    });

    applyWeightDecay(g, halfLife);
    const updated = g.getNode('decaying')!;
    expect(updated.weight).toBeCloseTo(oldWeight / 2, 4);
  });

  it('does not decay below minWeight', () => {
    const oldWeight = 0.15;
    // Very old node — should decay a lot, but clamp at minWeight
    g.addNode({
      id: 'old-node', type: 'summary', metadata: {},
      createdAt: isoDaysAgo(365), updatedAt: isoDaysAgo(200),
      weight: oldWeight,
    });

    applyWeightDecay(g, 45, 0.01);
    const updated = g.getNode('old-node')!;
    expect(updated.weight).toBeGreaterThanOrEqual(0.01);
  });
});

// ---------- Test 6: startCleanupScheduler runs periodically ---------------

describe('TTL — CleanupScheduler', () => {
  it('executes at the configured interval (shortened for tests)', async () => {
    // Use a very short interval for testing: 0.1 s
    const testCfg = { ...cfg, cleanupIntervalHours: 0.0000278 }; // ~0.1s

    g.addNode({
      id: 'stale', type: 'summary', metadata: {},
      createdAt: isoDaysAgo(100), updatedAt: isoDaysAgo(50),
      weight: 0.02,
    });

    let callbackFired = false;
    const scheduler = startCleanupScheduler(g, testCfg, () => { callbackFired = true; });

    // Wait for the interval to fire (up to 800 ms)
    await new Promise(r => setTimeout(r, 500));
    scheduler.stop();

    expect(callbackFired).toBe(true);
    expect(scheduler.runCount).toBeGreaterThanOrEqual(1);
    expect(scheduler.lastRun).toBeTruthy();
  });

  it('can be stopped', () => {
    const testCfg = { ...cfg, cleanupIntervalHours: 0.0000278 };
    let count = 0;
    const scheduler = startCleanupScheduler(g, testCfg, () => { count++; });

    // stop immediately
    scheduler.stop();

    // Wait a bit — count should stay 0 since we stopped before first fire
    return new Promise(r => setTimeout(r, 200)).then(() => {
      expect(scheduler.runCount).toBe(0);
    });
  });
});

// ---------- Test 8: DEFAULT_TTL_CONFIG values ----------------------------

describe('TTL — defaults', () => {
  it('DEFAULT_TTL_CONFIG has expected values', () => {
    expect(DEFAULT_TTL_CONFIG.enabled).toBe(true);
    expect(DEFAULT_TTL_CONFIG.retentionDays).toBe(90);
    expect(DEFAULT_TTL_CONFIG.cleanupIntervalHours).toBe(24);
    expect(DEFAULT_TTL_CONFIG.minWeight).toBe(0.1);
    expect(DEFAULT_TTL_CONFIG.pinnedExempt).toBe(true);
  });
});

// ---------- Extra edge: nodes without explicit weight --------------------

describe('TTL — missing weight treated as safe', () => {
  it('does not expire a node that lacks a weight property', () => {
    // No weight set → defaults to 1.0 internally → above minWeight
    g.addNode({
      id: 'no-weight', type: 'summary', metadata: {},
      createdAt: isoDaysAgo(100), updatedAt: isoDaysAgo(50),
    });

    const expired = findExpiredNodes(g, cfg);
    expect(expired).not.toContain('no-weight');
  });
});
