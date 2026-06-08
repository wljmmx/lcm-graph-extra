import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import type { PluginInstance, OpenClawContext } from '../register';
import { onSessionCreated, __test__ } from './session-created';

function buildPluginInstance(memoryDir?: string): PluginInstance {
  const ctx: OpenClawContext = { config: {}, logger: pino({ level: 'silent' }), memoryDir };
  return {
    config: {
      summaryStrategy: 'strategy', maxGraphDepth: 10, maxNodeCount: 5000,
      enableCrossFileLinkage: true, crossReferenceRetentionDays: 90,
      maxTokens: 32768, budgetRatio: 0.3,
    },
    logger: ctx.logger, context: ctx, unregister: () => {},
  };
}

describe('onSessionCreated', () => {
  beforeEach(() => __test__.sessionStore.clear());

  it('creates session state with given ID', async () => {
    const state = await onSessionCreated(buildPluginInstance(), 'sess-001');
    expect(state.sessionId).toBe('sess-001');
    expect(state.contextInjections).toBe(0);
    expect(__test__.sessionStore.has('sess-001')).toBe(true);
  });

  it('generates random ID when none provided', async () => {
    const state = await onSessionCreated(buildPluginInstance());
    expect(typeof state.sessionId).toBe('string');
    expect(state.sessionId.length).toBeGreaterThan(0);
  });

  it('initializes compaction + TTL defaults when absent', async () => {
    const inst = buildPluginInstance();
    delete (inst.config as any).compaction;
    delete (inst.config as any).ttl;
    await onSessionCreated(inst, 'cfg-test');
    expect(inst.config.compaction?.enabled).toBe(true);
    expect(inst.config.ttl?.enabled).toBe(true);
  });

  it('stores session DAG with root reference node', async () => {
    await onSessionCreated(buildPluginInstance(), 'dag-test');
    const state = __test__.sessionStore.get('dag-test')!;
    expect(state.dag.getNodeCount()).toBe(1);
    expect(state.dag.getNode('session-ref:dag-test')?.pinned).toBe(true);
  });

  it('loads memory context from fixture dir', async () => {
    await onSessionCreated(buildPluginInstance('src/core/test-fixtures/build-test'), 'fixture-sess');
    const state = __test__.sessionStore.get('fixture-sess')!;
    expect(state.dag.getNodeCount()).toBeGreaterThanOrEqual(1);
  });

  it('handles missing memoryDir gracefully', async () => {
    await onSessionCreated(buildPluginInstance(), 'no-memdir');
    expect(__test__.sessionStore.get('no-memdir')?.dag.getNodeCount()).toBe(1);
  });

  it('supports multiple concurrent sessions', async () => {
    await onSessionCreated(buildPluginInstance(), 's1');
    await onSessionCreated(buildPluginInstance(), 's2');
    expect(__test__.sessionStore.size).toBe(2);
  });
});

describe('__test__.createDagReferenceNode', () => {
  it('creates valid session root node', () => {
    const r = __test__.createDagReferenceNode('abc123');
    expect(r.id).toBe('session-ref:abc123');
    expect(r.manager.getNodeCount()).toBe(1);
    expect(r.manager.getNode('session-ref:abc123')?.pinned).toBe(true);
  });
});

describe('__test__.initSessionConfig', () => {
  it('sets defaults when absent', () => {
    const inst = buildPluginInstance();
    delete (inst.config as any).compaction;
    delete (inst.config as any).ttl;
    __test__.initSessionConfig(inst);
    expect(inst.config.compaction?.triggerThreshold).toBe(10000);
  });

  it('preserves existing config', () => {
    const inst = buildPluginInstance();
    (inst.config as any).compaction = { enabled: false, triggerThreshold: 5000 };
    __test__.initSessionConfig(inst);
    expect(inst.config.compaction?.enabled).toBe(false);
  });
});
