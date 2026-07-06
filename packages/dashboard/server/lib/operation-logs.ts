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
  // v1.0.1-6: 合规审计字段 —— user / session_id
  user?: string;
  sessionId?: string;
}

// v1.0.1-7: 敏感参数脱敏 —— 匹配 key 名中包含这些关键字的字段值会被替换为 ***REDACTED***
const SENSITIVE_KEY_PATTERNS = [
  'password', 'passwd', 'pwd',
  'apikey', 'api_key', 'api-key',
  'token', 'secret',
  'credential', 'auth',
  'neo4j_password', 'neo4j-password',
];

/**
 * v1.0.1-7: 递归脱敏敏感参数。
 * 匹配 key 名（不区分大小写）中包含 password/apiKey/token/secret/credential/auth 的字段，
 * 将其值替换为 '***REDACTED***'。支持嵌套对象和数组。
 */
export function redactSensitive(value: unknown, depth: number = 0): unknown {
  if (depth > 10) return value; // 防止循环引用
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((p) => lowerKey.includes(p));
    if (isSensitive && typeof obj[key] === 'string') {
      result[key] = '***REDACTED***';
    } else if (isSensitive && typeof obj[key] === 'object' && obj[key] !== null) {
      result[key] = '***REDACTED***';
    } else {
      result[key] = redactSensitive(obj[key], depth + 1);
    }
  }
  return result;
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
  // v1.0.1-6: 迁移 —— 添加 user / session_id 列（已有 DB 幂等）
  try {
    dbInstance.exec(`ALTER TABLE operation_logs ADD COLUMN user TEXT`);
  } catch { /* 列已存在 */ }
  try {
    dbInstance.exec(`ALTER TABLE operation_logs ADD COLUMN session_id TEXT`);
  } catch { /* 列已存在 */ }
  // v1.0.1-6: 查询索引 —— 按操作者过滤
  try {
    dbInstance.exec(`CREATE INDEX IF NOT EXISTS idx_operation_logs_user ON operation_logs(user)`);
  } catch { /* index 已存在 */ }
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
      INSERT INTO operation_logs (ts, tool, params_json, result_json, status, duration_ms, error, user, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // v1.0.1-7: 写入前脱敏敏感参数
    const safeParams = redactSensitive(entry.params ?? {});
    const safeResult = redactSensitive(entry.result ?? null);
    stmt.run(
      entry.ts,
      entry.tool,
      JSON.stringify(safeParams),
      JSON.stringify(safeResult),
      entry.status,
      entry.durationMs,
      entry.error ?? null,
      entry.user ?? null,
      entry.sessionId ?? null,
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
  // v1.0.1-6: 合规审计字段
  user?: string | null;
  session_id?: string | null;
}

/**
 * 查询操作日志 —— v1.0.1-6 支持按 user / tool / 时间范围过滤。
 */
export function queryOperationLogs(opts: {
  n?: number;
  tool?: string;
  user?: string;
  fromTs?: number;
  toTs?: number;
} = {}): OperationLogRow[] {
  try {
    const db = getDb();
    const limit = Number.isFinite(opts.n) && (opts.n ?? 0) > 0 ? Math.trunc(opts.n!) : 50;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.tool) { conditions.push('tool = ?'); params.push(opts.tool); }
    if (opts.user) { conditions.push('user = ?'); params.push(opts.user); }
    if (opts.fromTs != null) { conditions.push('ts >= ?'); params.push(opts.fromTs); }
    if (opts.toTs != null) { conditions.push('ts <= ?'); params.push(opts.toTs); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db
      .prepare(`SELECT * FROM operation_logs ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as OperationLogRow[];
  } catch {
    return [];
  }
}

/** 按 tool 过滤查询（向后兼容） */
export function queryOperationLogsByTool(tool: string, n: number = 50): OperationLogRow[] {
  return queryOperationLogs({ tool, n });
}

/** 关闭连接（用于测试 / 优雅关闭） */
export function closeOperationLogsDb(): void {
  if (dbInstance) {
    try { dbInstance.close(); } catch { /* idempotent */ }
    dbInstance = null;
  }
}
