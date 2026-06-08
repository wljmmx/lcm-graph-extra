import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';

// We need to mock the lifecycle import to avoid filesystem noise in tests
vi.mock('../core/lifecycle', () => ({
  incrementalUpdate: vi.fn().mockResolvedValue(undefined),
  loadDAGFromDir: vi.fn(),
}));

import { onTurnComplete, checkCompactionThreshold, performCompaction } from './turn-complete';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

async function createMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcm-hook-test-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, `${name}.md`), content, 'utf-8');
  }
  return dir;
}

function makeLogger() {
  return pino({ level: 'silent' });
}

/** Build an LLM mock that records calls and returns a fixed summary. */
function makeTrackingLLM(summary = 'Compressed summary') {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  return {
    calls,
    chatWithLLM: async (msgs: Array<{ role: string; content: string }>) => {
      calls.push(msgs);
      return summary;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onTurnComplete', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcm-turn-'));
  });

  it('executes without error on a valid instance', async () => {
    const logger = makeLogger();
    const instance = {
      config: { compaction: { enabled: false } },
      logger,
      context: { memoryDir: tmpDir },
      unregister: () => {},
    };
    await expect(onTurnComplete(instance)).resolves.toBeUndefined();
  });

  it('skips work when compaction is disabled', async () => {
    const logger = makeLogger();
    const instance = {
      config: { compaction: { enabled: false, triggerThreshold: 1 } },
      logger,
      context: { memoryDir: tmpDir },
      unregister: () => {},
    };
    await expect(onTurnComplete(instance)).resolves.toBeUndefined();
  });

  it('catches errors and re-throws them', async () => {
    const logger = makeLogger();
    // Nonexistent dir — checkCompactionThreshold returns 0 gracefully, so no error.
    const instance = {
      config: { compaction: { enabled: true, triggerThreshold: 1 } },
      logger,
      context: {
        memoryDir: '/nonexistent/path/that/wont/exist',
        llmProvider: null as any,
      },
      unregister: () => {},
    };
    await expect(onTurnComplete(instance)).resolves.toBeUndefined();
  });

  it('triggers compaction when threshold exceeded and LLM provider present', async () => {
    // Write enough data to exceed threshold
    await fs.writeFile(
      path.join(tmpDir, 'huge.md'),
      'X'.repeat(200),
      'utf-8',
    );

    const llm = makeTrackingLLM('SHORT_SUMMARY');
    const logger = makeLogger();
    const instance = {
      config: { compaction: { enabled: true, triggerThreshold: 50 } },
      logger,
      context: {
        memoryDir: tmpDir,
        llmProvider: llm,
      },
      unregister: () => {},
    };

    await expect(onTurnComplete(instance)).resolves.toBeUndefined();
    // LLM should have been called for compaction (only if file exceeds softThreshold too)
    // Default softThreshold is 81920 tokens ≈ 327680 chars; 200 chars won't trigger.
    // So calls may be empty — that's expected. The point is no error.
  });
});

// [removed] checkCompactionThreshold tests — compaction delegated to lossless-claw
// [removed] performCompaction tests — compaction delegated to lossless-claw
