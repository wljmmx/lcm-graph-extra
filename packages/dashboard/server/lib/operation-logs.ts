/**
 * 操作日志持久化 —— 独立 SQLite 文件存储 MCP 工具调用历史。
 *
 * 设计：
 * - 独立文件 ~/.openclaw/operation_logs.db（不侵入 lcm.db schema）
 * - 表 operation_logs: id / ts / tool / params_json / result_json / status / duration_ms / error
 * - 默认保留 1000 条，LRU 淘汰
 *
 * 用途：
 * - dashboard MaintainView 显示操作历史
 * - 合规审计：追溯谁在何时调用了什么工具
 * - 故障排查：定位操作失败根因
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';

const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

interface DatabaseSyncLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  close(): void;
  exec(sql: string): void;
}

export interface OperationLogEntry {
  id?: number;
  ts: number;
  tool: string;
  params: Record<string, unknown>;
  result?: unknown;
  status: 'success' | 'failure';
  durationMs: number;
  error?: string;
}

const MAX_LOGS = 1000;

let dbInstance: DatabaseSyncLike | null = null;

function resolveDbPath(): string {
  return resolve(homedir(), '.openclaw', 'operation_logs.db');
}

function getDb(): DatabaseSyncLike {
  if (dbInstance) return dbInstance;
  const dbPath = resolveDbPath();
  // 确保 ~/.openclaw 目录存在
  const dir = resolve(homedir(), '.openclaw');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  dbInstance = new DatabaseSync(dbPath);
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      tool TEXT NOT NULL,
      params_json TEXT,
      result_json TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operation_logs_ts ON operation_logs(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_operation_logs_tool ON operation_logs(tool);
  `);
  return dbInstance;
}

/**
 * 写入操作日志。
 * 自动 LRU 淘汰超过 MAX_LOGS 的旧记录。
 */
export function appendOperationLog(entry: OperationLogEntry): void {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO operation_logs (ts, tool, params_json, result_json, status, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.ts,
      entry.tool,
      JSON.stringify(entry.params ?? {}),
      JSON.stringify(entry.result ?? null),
      entry.status,
      entry.durationMs,
      entry.error ?? null,
    );
    // LRU 淘汰
    db.exec(`DELETE FROM operation_logs WHERE id NOT IN (SELECT id FROM operation_logs ORDER BY ts DESC LIMIT ${MAX_LOGS})`);
  } catch {
    // 写入失败不阻塞主流程
  }
}

export interface OperationLogRow {
  id: number;
  ts: number;
  tool: string;
  params_json: string;
  result_json: string;
  status: string;
  duration_ms: number;
  error: string | null;
}

/** 查询最近 n 条操作日志（按 ts DESC） */
export function queryOperationLogs(n: number = 50): OperationLogRow[] {
  try {
    const db = getDb();
    const limit = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 50;
    return db
      .prepare('SELECT * FROM operation_logs ORDER BY ts DESC LIMIT ?')
      .all(limit) as OperationLogRow[];
  } catch {
    return [];
  }
}

/** 按 tool 过滤查询 */
export function queryOperationLogsByTool(tool: string, n: number = 50): OperationLogRow[] {
  try {
    const db = getDb();
    const limit = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 50;
    return db
      .prepare('SELECT * FROM operation_logs WHERE tool = ? ORDER BY ts DESC LIMIT ?')
      .all(tool, limit) as OperationLogRow[];
  } catch {
    return [];
  }
}

/** 关闭连接（用于测试 / 优雅关闭） */
export function closeOperationLogsDb(): void {
  if (dbInstance) {
    try { dbInstance.close(); } catch { /* idempotent */ }
    dbInstance = null;
  }
}
