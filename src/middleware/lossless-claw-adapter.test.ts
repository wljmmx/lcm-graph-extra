import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LosslessClawAdapter } from './lossless-claw-adapter';

describe('LosslessClawAdapter', () => {
  let adapter: LosslessClawAdapter;
  let mockEngine: any;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockEngine = {
      ingest: vi.fn().mockResolvedValue({ ingested: true }),
      ingestBatch: vi.fn().mockResolvedValue({ ingestedCount: 5 }),
      compact: vi.fn().mockResolvedValue({ ok: true, compacted: true, reason: 'test', exhausted: false }),
      afterTurn: vi.fn().mockResolvedValue(undefined),
      assemble: vi.fn().mockResolvedValue({ messages: [], estimatedTokens: 0 }),
      maintain: vi.fn().mockResolvedValue({ changed: true, bytesFreed: 1024, rewrittenEntries: 2 }),
      getConversationStore: vi.fn().mockReturnValue({ getRecentSummaries: vi.fn().mockReturnValue([]) }),
      getSummaryStore: vi.fn().mockReturnValue({}),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    adapter = new LosslessClawAdapter(mockLogger);
    (adapter as any).engine = mockEngine;
    (adapter as any)._connected = true;
  });

  it('ingest returns result from engine', async () => {
    const result = await adapter.ingest({ sessionId: 'test', message: { role: 'user', content: 'hello' } });
    expect(mockEngine.ingest).toHaveBeenCalled();
    expect(result).toEqual({ ingested: true });
  });

  it('ingest returns default when engine not connected', async () => {
    (adapter as any)._connected = false;
    const result = await adapter.ingest({ sessionId: 'test', message: { role: 'user', content: 'hello' } });
    expect(result).toEqual({ ingested: false });
  });

  it('ingestBatch returns result from engine', async () => {
    const result = await adapter.ingestBatch({ sessionId: 'test', messages: [] });
    expect(mockEngine.ingestBatch).toHaveBeenCalled();
    expect(result).toEqual({ ingestedCount: 5 });
  });

  it('compact returns mapped result from engine', async () => {
    mockEngine.compact.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: 'compaction completed',
      summaryId: 'summary-1',
      summary: 'test summary',
      result: { tokensBefore: 1000, tokensAfter: 500 },
      exhausted: false,
    });

    const result = await adapter.compact({ sessionId: 'test', sessionFile: '/test/session' });
    expect(mockEngine.compact).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.summaryId).toBe('summary-1');
    expect(result.exhausted).toBe(false);
  });

  it('compact handles engine error', async () => {
    mockEngine.compact.mockRejectedValue(new Error('test error'));

    const result = await adapter.compact({ sessionId: 'test', sessionFile: '/test/session' });
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.error).toBe('test error');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('afterTurn calls engine with prePromptMessageCount', async () => {
    await adapter.afterTurn({
      sessionId: 'test',
      sessionFile: '/test/session',
      messages: [],
      prePromptMessageCount: 5,
    });
    expect(mockEngine.afterTurn).toHaveBeenCalledWith(expect.objectContaining({
      prePromptMessageCount: 5,
    }));
  });

  it('afterTurn uses default prePromptMessageCount when not provided', async () => {
    await adapter.afterTurn({
      sessionId: 'test',
      sessionFile: '/test/session',
      messages: [],
    });
    expect(mockEngine.afterTurn).toHaveBeenCalledWith(expect.objectContaining({
      prePromptMessageCount: 0,
    }));
  });

  it('afterTurn logs error and continues', async () => {
    mockEngine.afterTurn.mockRejectedValue(new Error('test error'));
    await expect(adapter.afterTurn({
      sessionId: 'test',
      sessionFile: '/test/session',
      messages: [],
    })).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('maintain returns result from engine', async () => {
    const result = await adapter.maintain({ sessionId: 'test', sessionFile: '/test/session' });
    expect(mockEngine.maintain).toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.bytesFreed).toBe(1024);
    expect(result.rewrittenEntries).toBe(2);
  });

  it('maintain returns default when engine not connected', async () => {
    (adapter as any)._connected = false;
    const result = await adapter.maintain({ sessionId: 'test', sessionFile: '/test/session' });
    expect(result).toEqual({ changed: false, bytesFreed: 0, rewrittenEntries: 0 });
  });

  it('assemble returns result from engine', async () => {
    mockEngine.assemble.mockResolvedValue({
      messages: [{ role: 'user', content: 'hello' }],
      estimatedTokens: 10,
      systemPromptAddition: 'test addition',
    });

    const result = await adapter.assemble({ sessionId: 'test', messages: [] });
    expect(mockEngine.assemble).toHaveBeenCalled();
    expect(result.messages).toHaveLength(1);
    expect(result.estimatedTokens).toBe(10);
    expect(result.systemPromptAddition).toBe('test addition');
  });

  it('assemble returns default when engine method not available', async () => {
    delete mockEngine.assemble;
    const result = await adapter.assemble({ sessionId: 'test', messages: [] });
    expect(result).toEqual({ messages: [], estimatedTokens: 0 });
  });

  it('getConversationStore returns store from engine', () => {
    const store = adapter.getConversationStore();
    expect(mockEngine.getConversationStore).toHaveBeenCalled();
    expect(store).toBeDefined();
  });

  it('getConversationStore returns null when not connected', () => {
    (adapter as any)._connected = false;
    const store = adapter.getConversationStore();
    expect(store).toBe(null);
  });

  it('getSummaryStore returns store from engine', () => {
    const store = adapter.getSummaryStore();
    expect(mockEngine.getSummaryStore).toHaveBeenCalled();
    expect(store).toBeDefined();
  });

  it('getSummaryStore returns null when not connected', () => {
    (adapter as any)._connected = false;
    const store = adapter.getSummaryStore();
    expect(store).toBe(null);
  });

  it('dispose calls engine dispose', async () => {
    await adapter.dispose();
    expect(mockEngine.dispose).toHaveBeenCalled();
  });

  it('dispose handles engine error', async () => {
    mockEngine.dispose.mockRejectedValue(new Error('dispose error'));
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});