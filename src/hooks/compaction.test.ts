import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import pino from 'pino';

import type { PluginInstance, OpenClawContext } from '../register';
import { onCompaction, __test__ } from './compaction';

const { backupFile, listBackupsForFile, enforceRetention, resolveBackupDir } = __test__;

async function createTestMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcm-compaction-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

function buildPluginInstance(memoryDir: string): PluginInstance {
  const context: OpenClawContext = {
    config: {},
    memoryDir,
    logger: pino({ level: 'silent' }),
  };
  return {
    config: {
      summaryStrategy: 'strategy',
      maxGraphDepth: 10,
      maxNodeCount: 5000,
      budgetRatio: 0.3,
      maxTokens: 32768,
      backupConfig: {},
    },
    context,
    logger: pino({ level: 'silent' }),
  };
}

describe('compaction hook', () => {
  afterEach(async () => { /* cleanup handled by temp dir */ });

  it('backups all .md files before compaction', async () => {
    const dir = await createTestMemoryDir({
      'memory-2026-05-20.md': '# Test\nSome content here.',
      'memory-2026-05-21.md': '# Another\nMore content.',
      'readme.txt': 'not markdown',
    });
    const instance = buildPluginInstance(dir);

    await onCompaction(instance);

    // Check backup directory was created and contains backups
    const backupDir = resolveBackupDir(instance);
    const entries = await fs.readdir(backupDir);
    const bakEntries = entries.filter(e => e.includes('.bak-'));
    expect(bakEntries.length).toBe(2); // 2 .md files backed up
  });

  it('skips when compaction disabled', async () => {
    const dir = await createTestMemoryDir({ 'test.md': '# Test' });
    const instance = buildPluginInstance(dir);
    (instance.config as any).compaction = { enabled: false };

    await onCompaction(instance);

    // Should not create backup directory
    const backupDir = resolveBackupDir(instance);
    try {
      await fs.access(backupDir);
      // If it exists, it shouldn't have backups (skipped early)
    } catch {
      // Directory doesn't exist — correct for disabled
    }
  });

  it('skips when no memoryDir', async () => {
    const instance = buildPluginInstance(null as any);
    await onCompaction(instance);
    // Should not throw, just warn and return
  });

  it('enforces max backup retention', async () => {
    const dir = await createTestMemoryDir({ 'test.md': '# Test' });
    const backupDir = path.join(dir, 'backups');
    await fs.mkdir(backupDir, { recursive: true });

    // Create 15 old backups
    for (let i = 0; i < 15; i++) {
      await fs.writeFile(path.join(backupDir, `test.md.bak-2026-01-01T00:0${i}:00-00:00`), 'old backup');
    }

    await enforceRetention(path.join(dir, 'test.md'), backupDir, 5);

    const remaining = await fs.readdir(backupDir);
    expect(remaining.length).toBeLessThanOrEqual(5);
  });

  it('resolves custom backupDir from config', () => {
    const instance = buildPluginInstance('/tmp/memory');
    (instance.config as any).backupConfig = { backupDir: '/custom/backup' };
    expect(resolveBackupDir(instance)).toBe('/custom/backup');
  });

  it('falls back to memoryDir/backups when no custom path', () => {
    const instance = buildPluginInstance('/tmp/memory');
    expect(resolveBackupDir(instance)).toBe(path.join('/tmp/memory', 'backups'));
  });

  it('creates compaction marker file', async () => {
    const dir = await createTestMemoryDir({ 'memory.md': '# Memory\nSome notes.' });
    const instance = buildPluginInstance(dir);

    await onCompaction(instance);

    // Check marker was written
    const markerPath = path.join(dir, '.compaction-marker.json');
    const markerContent = JSON.parse(await fs.readFile(markerPath, 'utf-8'));
    expect(markerContent).toHaveProperty('timestamp');
    expect(markerContent).toHaveProperty('filesBackedUp');
    expect(markerContent.filesBackedUp).toBe(1);
  });

  it('handles non-.md files gracefully', async () => {
    const dir = await createTestMemoryDir({
      'data.json': '{"key": "value"}',
      'script.py': 'print("hello")',
      'readme.md': '# README',
    });
    const instance = buildPluginInstance(dir);

    await onCompaction(instance);

    // Should only back up the .md file
    const backupDir = resolveBackupDir(instance);
    const entries = await fs.readdir(backupDir);
    const bakEntries = entries.filter(e => e.includes('.bak-'));
    expect(bakEntries.length).toBe(1);
  });

  it('handles empty memory directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcm-empty-'));
    const instance = buildPluginInstance(dir);

    await onCompaction(instance);

    // Should not throw, just log and create marker with 0 files
  });

  it('handles missing backup directory gracefully', async () => {
    const dir = await createTestMemoryDir({ 'test.md': '# Test' });
    const instance = buildPluginInstance(dir);
    // Don't pre-create backup dir — hook should handle it
    (instance.config as any).backupConfig = { backupDir: path.join(dir, 'nonexistent', 'backups') };

    await onCompaction(instance);

    // Should have created the directory structure
    const backupDir = resolveBackupDir(instance);
    const entries = await fs.readdir(backupDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  // ------------------------------------------------------------------
  // SDK 2026.10.4 对齐：compact 契约已移除 sessionFile，改用 sessionTarget。
  // 回归防线：若仍把 sessionFile 当作必须存在的前置条件，新宿主下本 hook 会整体跳过，
  // 直接丢失压缩闭环（备份 + DAG compact + 摘要质量验证）。
  // ------------------------------------------------------------------
  it('SDK 2026.10.4: 仅有 sessionTarget（无 sessionFile）时不再跳过，且透传身份', async () => {
    const dir = await createTestMemoryDir({ 'test.md': '# Test' });
    const instance = buildPluginInstance(dir);
    const calls: any[] = [];
    (instance as any)._losslessClawAdapter = {
      connected: true,
      compact: async (p: any) => {
        calls.push(p);
        return { ok: true, compacted: false, reason: 'noop' };
      },
    };
    const target = { agentId: 'a1', sessionId: 'sid-1', sessionKey: 'sk-1', storePath: '/store' };
    (instance.context as any).sessionId = 'sid-1';
    (instance.context as any).sessionTarget = target;
    // 刻意不设置 sessionFile —— 10.4 的 compact 不再提供该定位符

    await onCompaction(instance);

    expect(calls.length).toBe(1);
    expect(calls[0].sessionTarget).toEqual(target);
    expect(calls[0].sessionFile).toBeUndefined();
  });

  it('SDK 2026.10.4: sessionFile 与 sessionTarget 均缺失时才跳过压缩', async () => {
    const dir = await createTestMemoryDir({ 'test.md': '# Test' });
    const instance = buildPluginInstance(dir);
    const calls: any[] = [];
    (instance as any)._losslessClawAdapter = {
      connected: true,
      compact: async (p: any) => {
        calls.push(p);
        return { ok: true, compacted: false };
      },
    };
    (instance.context as any).sessionId = 'sid-1';
    // 两个定位来源都不提供 → 无法定位会话，必须跳过

    const res = await onCompaction(instance);

    expect(calls.length).toBe(0);
    expect(res.compacted).toBe(false);
  });
});
