/**
 * 官方转录读取器（readAgentTranscriptMessages）单测。
 *
 * 夹具库严格按官方 DDL 建表（openclaw/openclaw `src/state/openclaw-agent-schema.sql`）：
 *   transcript_events(session_id, seq, event_json|event_zstd, created_at, PRIMARY KEY(session_id, seq))
 *   session_windows(session_id PK, session_key, created_at, ...)
 *   transcript_event_identities(session_id, event_id, seq, ...)
 * 消息 entry 形状 = canonical transcript entry：{ id, type:'message', message:{ role, content } }
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgentTranscriptMessages, clearAgentDbDiscoveryCache } from './openclaw-agent-db';

const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(s: string): void;
    prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
    close(): void;
  };
};

let tmpRoot: string | null = null;
let savedEnv: string | undefined;

interface SeedWindow {
  sessionId: string;
  sessionKey: string;
  /** 窗口创建时间（ms），决定跨 /new 轮换的先后 */
  windowCreatedAt: number;
  /** 该窗口内的事件：seq 从 1 起 */
  events: Array<{ seq: number; entry: unknown; createdAt?: number; compressed?: boolean; label?: string; corruptPayload?: boolean }>;
}

/** 用 node:zstd 压缩 payload（模拟官方冷转录行） */
function compressZstd(text: string): { bytes: Uint8Array; utf8Bytes: number } {
  const zstd = (req('node:zlib') as { zstdCompressSync?: (b: Uint8Array) => Uint8Array }).zstdCompressSync;
  if (typeof zstd !== 'function') throw new Error('runtime lacks zstd');
  const utf8 = Buffer.from(text, 'utf-8');
  return { bytes: zstd(utf8), utf8Bytes: utf8.byteLength };
}

/** 按官方 DDL 建立 per-agent 库并写入窗口/事件 */
function seedTranscriptDb(agentId: string, windows: SeedWindow[]): void {
  const agentsDir = join(tmpRoot!, 'agents');
  const agentDbDir = join(agentsDir, agentId, 'agent');
  mkdirSync(agentDbDir, { recursive: true });
  const db = new DatabaseSync(join(agentDbDir, 'openclaw-agent.sqlite'));
  db.exec(`
    CREATE TABLE session_windows (
      session_id TEXT NOT NULL PRIMARY KEY,
      session_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE transcript_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT,
      created_at INTEGER NOT NULL,
      event_zstd BLOB,
      event_utf8_bytes INTEGER,
      navigation_json TEXT,
      PRIMARY KEY (session_id, seq)
    ) STRICT;
    CREATE TABLE transcript_event_identities (
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT,
      parent_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, event_id)
    ) STRICT;
  `);
  for (const w of windows) {
    db.prepare('INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(w.sessionId, w.sessionKey, w.windowCreatedAt, w.windowCreatedAt);
    for (const e of w.events) {
      const createdAt = e.createdAt ?? w.windowCreatedAt;
      if (e.compressed) {
        // 官方压缩行：event_json 为 NULL，载荷在 event_zstd + event_utf8_bytes。
        // corruptPayload = 塞入非 zstd 字节，模拟损坏载荷。
        const payload = e.corruptPayload
          ? { bytes: new Uint8Array([1, 2, 3, 4, 5]), utf8Bytes: 10 }
          : compressZstd(JSON.stringify(e.entry));
        db.prepare(
          'INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        ).run(w.sessionId, e.seq, createdAt, payload.bytes, payload.utf8Bytes, '{"version":1}');
      } else {
        db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)')
          .run(w.sessionId, e.seq, JSON.stringify(e.entry), createdAt);
      }
      if (e.label) {
        db.prepare('INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(w.sessionId, e.label, e.seq, 'message', createdAt);
      }
    }
  }
  db.close();
}

/** canonical 消息 entry */
function msgEntry(id: string, role: string, content: unknown) {
  return { id, type: 'message', message: { role, content } };
}

beforeEach(() => {
  savedEnv = process.env.OPENCLAW_AGENTS_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), 'oc-transcript-test-'));
  process.env.OPENCLAW_AGENTS_DIR = join(tmpRoot, 'agents');
  clearAgentDbDiscoveryCache();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.OPENCLAW_AGENTS_DIR;
  else process.env.OPENCLAW_AGENTS_DIR = savedEnv;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  clearAgentDbDiscoveryCache();
  tmpRoot = null;
});

describe('readAgentTranscriptMessages', () => {
  it('读取 message entry：sessionKey/sessionId/seq/role/content/createdAt/eventId', () => {
    seedTranscriptDb('main', [{
      sessionId: 'sess-1', sessionKey: 'agent:main:main', windowCreatedAt: 1_700_000_000_000,
      events: [
        { seq: 1, entry: msgEntry('e1', 'user', '你好'), createdAt: 1_700_000_001_000, label: 'evt-1' },
      ],
    }]);
    const r = readAgentTranscriptMessages();
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      agentId: 'main',
      sessionKey: 'agent:main:main',
      sessionId: 'sess-1',
      seq: 1,
      eventId: 'evt-1',
      role: 'user',
      content: '你好',
      createdAt: 1_700_000_001_000,
    });
    expect(r.skippedNonMessage).toBe(0);
  });

  it('跳过非 message entry（session 头 / compaction）并计数', () => {
    seedTranscriptDb('main', [{
      sessionId: 'sess-1', sessionKey: 'sk', windowCreatedAt: 1,
      events: [
        { seq: 1, entry: { type: 'session', version: 1, id: 'sess-1' } },
        { seq: 2, entry: { type: 'compaction', summary: 'x', firstKeptEntryId: 'a', tokensBefore: 1 } },
        { seq: 3, entry: msgEntry('e3', 'assistant', 'ok') },
      ],
    }]);
    const r = readAgentTranscriptMessages();
    expect(r.messages).toHaveLength(1);
    expect(r.skippedNonMessage).toBe(2);
  });

  it('zstd 压缩行按官方 openclaw_transcript_payload_decode 语义解压并读取', () => {
    seedTranscriptDb('main', [{
      sessionId: 'sess-1', sessionKey: 'sk', windowCreatedAt: 1_700_000_000_000,
      events: [
        { seq: 1, entry: msgEntry('e1', 'user', '压缩前的原始消息'), compressed: true, label: 'evt-1' },
        { seq: 2, entry: msgEntry('e2', 'assistant', 'plain') },
      ],
    }]);
    const r = readAgentTranscriptMessages();
    expect(r.decodedCompressed).toBe(1);
    expect(r.skippedCompressed).toBe(0);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]).toMatchObject({
      seq: 1, role: 'user', content: '压缩前的原始消息', eventId: 'evt-1',
    });
  });

  it('压缩载荷损坏（非 zstd 字节）→ 仅跳过该行并计数，不中断整次读取', () => {
    seedTranscriptDb('main', [{
      sessionId: 'sess-1', sessionKey: 'sk', windowCreatedAt: 1,
      events: [
        { seq: 1, entry: msgEntry('bad', 'user', 'x'), compressed: true, corruptPayload: true },
        { seq: 2, entry: msgEntry('good', 'user', 'kept') },
      ],
    }]);
    const r = readAgentTranscriptMessages();
    expect(r.skippedCompressed).toBe(1);
    expect(r.messages.map((m) => m.content)).toEqual(['kept']);
  });

  it('content 保持原始形态：块数组不被扁平化（扁平化由契约层负责）', () => {
    const blocks = [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't' }];
    seedTranscriptDb('main', [{
      sessionId: 's', sessionKey: 'sk', windowCreatedAt: 1,
      events: [{ seq: 1, entry: msgEntry('e1', 'assistant', blocks) }],
    }]);
    const r = readAgentTranscriptMessages();
    expect(r.messages[0].content).toEqual(blocks);
  });

  it('跨 /new 轮换的多窗口：按窗口时间再按 seq 排序（不交错）', () => {
    // 同一 sessionKey 的第二个窗口（/new 后），seq 重新从 1 起
    seedTranscriptDb('main', [
      {
        sessionId: 'old', sessionKey: 'agent:main:main', windowCreatedAt: 1_000,
        events: [
          { seq: 1, entry: msgEntry('o1', 'user', 'old-1') },
          { seq: 2, entry: msgEntry('o2', 'assistant', 'old-2') },
        ],
      },
      {
        sessionId: 'new', sessionKey: 'agent:main:main', windowCreatedAt: 2_000,
        events: [
          { seq: 1, entry: msgEntry('n1', 'user', 'new-1') },
          { seq: 2, entry: msgEntry('n2', 'assistant', 'new-2') },
        ],
      },
    ]);
    const r = readAgentTranscriptMessages();
    expect(r.messages.map((m) => m.content)).toEqual(['old-1', 'old-2', 'new-1', 'new-2']);
  });

  it('损坏的 event_json 计入 parseErrors 且不影响其它行', () => {
    seedTranscriptDb('main', [{
      sessionId: 's', sessionKey: 'sk', windowCreatedAt: 1,
      events: [{ seq: 1, entry: msgEntry('e1', 'user', 'ok'), createdAt: 2 }],
    }]);
    // 直接塞一行坏 JSON
    const dbPath = join(tmpRoot!, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)')
      .run('s', 9, '{not-json', 3);
    db.close();
    const r = readAgentTranscriptMessages();
    expect(r.parseErrors).toBe(1);
    expect(r.messages).toHaveLength(1);
  });

  it('核心表缺失（未迁移环境）→ 空结果且不抛错', () => {
    const agentDbDir = join(tmpRoot!, 'agents', 'legacy', 'agent');
    mkdirSync(agentDbDir, { recursive: true });
    const db = new DatabaseSync(join(agentDbDir, 'openclaw-agent.sqlite'));
    db.exec('CREATE TABLE something_else (id TEXT PRIMARY KEY) STRICT;');
    db.close();
    const r = readAgentTranscriptMessages();
    expect(r.messages).toEqual([]);
    expect(r.skippedCompressed).toBe(0);
  });

  it('agents 目录不存在 → 空结果', () => {
    process.env.OPENCLAW_AGENTS_DIR = join(tmpRoot!, 'nonexistent');
    clearAgentDbDiscoveryCache();
    const r = readAgentTranscriptMessages();
    expect(r.messages).toEqual([]);
    expect(r.agentsScanned).toBe(0);
  });
});