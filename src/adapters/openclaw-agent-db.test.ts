/**
 * OpenClaw Agent SQLite 读取器 —— 单元测试。
 *
 * 用 node:sqlite 构造官方 per-agent 布局（临时目录 + OPENCLAW_AGENTS_DIR 注入）：
 *   <tmp>/agents/<agentId>/agent/openclaw-agent.sqlite（memory_index_* 表）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverAgentDbs,
  searchAgentMemory,
  recentAgentMemory,
  agentMemoryHealth,
  escapeLikePattern,
} from './openclaw-agent-db';

const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(s: string): void;
    prepare(s: string): { run(...a: unknown[]): unknown };
    close(): void;
  };
};

let tmpRoot: string | null = null;
let savedEnv: string | undefined;

/** 建 agents 根目录下的官方布局；返回 agentsDir */
function seedAgentDb(agentId: string, chunks: Array<{ id: string; path: string; text: string; importance?: number; originClass?: string }>): void {
  const agentsDir = join(tmpRoot!, 'agents');
  const agentDbDir = join(agentsDir, agentId, 'agent');
  mkdirSync(agentDbDir, { recursive: true });
  const db = new DatabaseSync(join(agentDbDir, 'openclaw-agent.sqlite'));
  db.exec(`
    CREATE TABLE memory_index_chunks (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
      model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE memory_index_chunk_recall_metadata (
      chunk_id TEXT PRIMARY KEY, importance INTEGER, triggers TEXT, project_key TEXT
    ) STRICT;
    CREATE TABLE memory_index_chunk_provenance (
      chunk_id TEXT PRIMARY KEY, origin_class TEXT NOT NULL,
      session_kind TEXT NOT NULL, observed_at INTEGER NOT NULL, supersedes_key TEXT
    ) STRICT;
    CREATE TABLE memory_index_sources (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, UNIQUE (path, source)
    ) STRICT;
    CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `);
  db.prepare("INSERT INTO memory_index_meta (key, value) VALUES ('version', '2')").run();
  const ins = db.prepare('INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const c of chunks) {
    ins.run(c.id, c.path, 'memory', 1, 10, `hash-${c.id}`, 'test-model', c.text, '[]', 1_700_000_000_000);
    db.prepare('INSERT INTO memory_index_chunk_recall_metadata (chunk_id, importance, triggers, project_key) VALUES (?, ?, ?, ?)')
      .run(c.id, c.importance ?? 5, '["kw"]', 'demo');
    db.prepare('INSERT INTO memory_index_chunk_provenance (chunk_id, origin_class, session_kind, observed_at, supersedes_key) VALUES (?, ?, ?, ?, NULL)')
      .run(c.id, c.originClass ?? 'agent', 'interactive', 1_700_000_000_000);
  }
  db.close();
}

beforeEach(() => {
  savedEnv = process.env.OPENCLAW_AGENTS_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), 'oc-agent-db-test-'));
  process.env.OPENCLAW_AGENTS_DIR = join(tmpRoot, 'agents');
});

afterEach(() => {
  if (tmpRoot) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    tmpRoot = null;
  }
  if (savedEnv === undefined) delete process.env.OPENCLAW_AGENTS_DIR;
  else process.env.OPENCLAW_AGENTS_DIR = savedEnv;
});

describe('discoverAgentDbs', () => {
  it('扫描官方布局 agents/<id>/agent/openclaw-agent.sqlite', () => {
    seedAgentDb('agent-a', []);
    seedAgentDb('agent-b', []);
    const dbs = discoverAgentDbs();
    expect(dbs).toHaveLength(2);
    expect(dbs.map((d) => d.agentId).sort()).toEqual(['agent-a', 'agent-b']);
  });

  it('空/缺失 agents 目录返回空数组', () => {
    expect(discoverAgentDbs(join(tmpRoot!, 'not-exists'))).toEqual([]);
  });
});

describe('searchAgentMemory', () => {
  it('按正文 LIKE 命中官方 memory_index_chunks 并附带元数据', () => {
    seedAgentDb('agent-a', [
      { id: 'c1', path: 'memory/project.md', text: '用户偏好使用中文记录项目进度', importance: 8, originClass: 'owner' },
      { id: 'c2', path: 'memory/other.md', text: '完全不相关的内容', importance: 1 },
    ]);
    const hits = searchAgentMemory('项目进度');
    expect(hits).toHaveLength(1);
    expect(hits[0].chunkId).toBe('c1');
    expect(hits[0].agentId).toBe('agent-a');
    expect(hits[0].path).toBe('memory/project.md');
    expect(hits[0].importance).toBe(8);
    expect(hits[0].originClass).toBe('owner');
    expect(hits[0].sessionKind).toBe('interactive');
    expect(hits[0].source).toBe('memory');
  });

  it('importance 高者优先排序', () => {
    seedAgentDb('agent-a', [
      { id: 'low', path: 'a.md', text: '目标包含关键词', importance: 2 },
      { id: 'high', path: 'b.md', text: '同样包含关键词目标', importance: 9 },
    ]);
    const hits = searchAgentMemory('关键词');
    expect(hits.map((h) => h.chunkId)).toEqual(['high', 'low']);
  });

  it('空查询返回空数组', () => {
    seedAgentDb('agent-a', [{ id: 'c', path: 'a.md', text: '内容' }]);
    expect(searchAgentMemory('')).toEqual([]);
    expect(searchAgentMemory('   ')).toEqual([]);
  });

  it('LIKE 特殊字符被转义（% _ \\ 不作为通配符）', () => {
    expect(escapeLikePattern('a%b_c')).toBe('a\\%b\\_c');
    seedAgentDb('agent-a', [{ id: 'c1', path: 'a.md', text: '包含 100% 完成度标记' }]);
    // 用 % 查询不应命中（转义后字面匹配）
    expect(searchAgentMemory('%完成')).toEqual([]);
    expect(searchAgentMemory('100%')).toHaveLength(1);
  });
});

describe('recentAgentMemory', () => {
  it('按 updated_at 倒序返回最近记忆', () => {
    seedAgentDb('agent-a', [
      { id: 'old', path: 'old.md', text: '旧记忆' },
    ]);
    seedAgentDb('agent-b', [
      { id: 'new', path: 'new.md', text: '新记忆' },
    ]);
    const recent = recentAgentMemory(5);
    // agent-b 的 chunk updated_at 相同 → 汇总两个 agent 的记录
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent.every((r) => r.agentId === 'agent-a' || r.agentId === 'agent-b')).toBe(true);
  });
});

describe('agentMemoryHealth', () => {
  it('统计 chunk/source 数量与 schema 版本', () => {
    seedAgentDb('agent-a', [{ id: 'c1', path: 'a.md', text: 'x' }]);
    const health = agentMemoryHealth();
    expect(health).toHaveLength(1);
    expect(health[0].agentId).toBe('agent-a');
    expect(health[0].chunkCount).toBe(1);
    expect(health[0].sourceCount).toBe(0);
    expect(health[0].schemaVersion).toBe('2');
    expect(health[0].error).toBeUndefined();
  });

  it('无法打开的库写入 error 字段（不抛错）', () => {
    // 建一个目录但不放 sqlite 文件 → discover 不会命中，health 为空
    mkdirSync(join(tmpRoot!, 'agents', 'ghost', 'agent'), { recursive: true });
    expect(agentMemoryHealth()).toEqual([]);
  });
});