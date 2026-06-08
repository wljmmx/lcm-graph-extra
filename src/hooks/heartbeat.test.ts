import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { Writable } from 'stream';
import type { PluginInstance } from '../register';
import type { PluginConfig } from '../config';
import { GraphMemoryManager } from '../core/graph';
import * as heartbeatMod from './heartbeat';

// ---------- helpers -------------------------------------------------------

interface LogEntry { level: string; msg: string; [key: string]: unknown }

function makeCapturingLogger(): { logger: pino.Logger; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      const line = chunk.toString().trim();
      if (line) try { logs.push(JSON.parse(line)); } catch {}
      cb();
    },
  });
  return { logger: pino(dest), logs };
}

function makeConfig(o: Partial<PluginConfig> = {}): PluginConfig {
  return {
    summaryStrategy: 'strategy',
    maxGraphDepth: 10,
    maxNodeCount: 5000,
    enableCrossFileLinkage: true,
    crossReferenceRetentionDays: 90,
    maxTokens: 32768,
    budgetRatio: 0.3,
    ttl: { enabled: true, retentionDays: 90, cleanupIntervalHours: 24 },
    backupConfig: { enabled: true, retentionDays: 30, maxBackups: 10, intervalHours: 24 },
    ...o,
  };
}

function makeInst(o?: Partial<PluginConfig>): PluginInstance & { __logs: LogEntry[] } {
  const { logger, logs } = makeCapturingLogger();
  return {
    config: makeConfig(o),
    logger,
    context: {
      config: {},
      graphManager: new GraphMemoryManager(),
      persistentState: {} as Record<string, unknown>,
      logger,
    } as any,
    unregister: vi.fn(),
    __logs: logs,
  };
}

// ---------- Test 1: onHeartbeat normal ------------------------------------

describe('onHeartbeat', () => {
  it('completes without throwing (normal execution)', async () => {
    const i = makeInst();
    await expect(heartbeatMod.onHeartbeat(i)).resolves.toBeUndefined();
  });
});

// ---------- Test 2: TTL disabled skips cleanup -----------------------------

describe('TTL skipping', () => {
  it('skips TTL cleanup when ttl.enabled is false', async () => {
    const i = makeInst({ ttl: { enabled: false, retentionDays: 90, cleanupIntervalHours: 24 } });
    const spy = vi.spyOn(heartbeatMod, 'runTTLCleanup').mockResolvedValue(undefined);
    await heartbeatMod.onHeartbeat(i);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------- Test 3: Health check orphan detection --------------------------

describe('Health check', () => {
  it('detects and warns about orphan nodes', async () => {
    const i = makeInst();
    const m = (i.context as any).graphManager as GraphMemoryManager;
    m.addNode({
      id: 'orphan-1',
      type: 'memory' as const,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      weight: 0.5,
    });
    await heartbeatMod.runHealthCheck(i);
    const w = i.__logs.find(l => l.msg === 'DAG health: orphan nodes detected');
    expect(w).toBeDefined();
    expect(w?.orphanCount).toBe(1);
  });
});

// ---------- Test 4: Backup not yet due -------------------------------------

describe('Backup timing', () => {
  it('does NOT trigger backup when interval has not elapsed', async () => {
    const i = makeInst();
    (i.context as any).persistentState['lcm-graph-extra:lastBackupTimestamp'] = Date.now() - 60_000;
    await heartbeatMod.checkBackupNeeded(i);
    expect(i.__logs.some(l => String(l.msg).includes('backup interval reached'))).toBe(false);
  });
});

// ---------- Test 5: Backup interval reached --------------------------------

describe('Backup trigger', () => {
  it('triggers backup when no previous backup exists', async () => {
    const i = makeInst();
    await heartbeatMod.checkBackupNeeded(i);
    expect(i.__logs.some(l => String(l.msg).includes('backup interval reached'))).toBe(true);
  });

  it('triggers backup when the interval has fully elapsed', async () => {
    const i = makeInst({ backupConfig: { enabled: true, retentionDays: 30, maxBackups: 10, intervalHours: 1 } });
    (i.context as any).persistentState['lcm-graph-extra:lastBackupTimestamp'] = Date.now() - 2 * 60 * 60 * 1000;
    await heartbeatMod.checkBackupNeeded(i);
    expect(i.__logs.some(l => String(l.msg).includes('backup interval reached'))).toBe(true);
  });
});

// ---------- Test 6: Error caught by onHeartbeat ----------------------------

describe('Error handling', () => {
  it('catches errors and logs them instead of throwing', async () => {
    const i = makeInst();
    // Break _allNodeEntries so runHealthCheck throws during iteration.
    const m = (i.context as any).graphManager as GraphMemoryManager;
    vi.spyOn(m, '_allNodeEntries').mockImplementation(() => {
      throw new Error('manager crash');
    });

    // onHeartbeat should swallow the error and NOT re-throw.
    await expect(heartbeatMod.onHeartbeat(i)).resolves.toBeUndefined();

    // Allow pino's Writable transport to flush.
    await new Promise(r => setTimeout(r, 50));

    // Look for level 50 (pino error) or the specific error message.
    const hasError = i.__logs.some(
      l => l.level === 50 || String(l.msg).includes('heartbeat hook failed'),
    );
    expect(hasError).toBe(true);
  });
});
