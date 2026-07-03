import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────

export interface DebtRecord {
  conversationId: number;
  pending: boolean;
  requestedAt: string;
  reason: string;
  running: boolean;
  tokenBudget: number;
  currentTokenCount: number;
  updatedAt: string;
}

export interface DebtSchedulerConfig {
  // How often the scheduler polls for new debts (default: 60s)
  pollIntervalMs?: number;
  // Max concurrent compaction jobs (default: 1)
  maxConcurrent?: number;
  // Debts with urgency >= this threshold are processed immediately (default: 0.7)
  urgentThreshold?: number;
}

export const DEFAULT_SCHEDULER_CONFIG: Required<DebtSchedulerConfig> = {
  pollIntervalMs: 60_000,
  maxConcurrent: 1,
  urgentThreshold: 0.7,
};

// ─── DB Utilities ───────────────────────────────────────

function findDbPath(): string | null {
  const home = process.env.HOME || "";
  const candidates: (string | undefined)[] = [
    process.env.OPENCLAW_DB_PATH,
    path.join(home, ".openclaw", "sessions.db"),
    path.join(home, ".openclaw", "gateway.db"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function openDb(dbPath?: string): any | null {
  try {
    const resolved = dbPath ?? findDbPath();
    if (!resolved || !fs.existsSync(resolved)) return null;
    let Database: any;
    try {
      Database = require("better-sqlite3");
    } catch {
      return null;
    }
    return new Database(resolved);
  } catch {
    return null;
  }
}

// ─── Singleton DB Cache (P1-3 M-5) ─────────────────────
// 单例 DB 连接 + prepared statement 缓存：避免每次 CRUD 都重新打开/关闭连接，
// 并复用 prepared statement 以降低开销。

const _debtDbCache = new Map<string, { db: any; stmts: Map<string, any> }>();

function getDebtDb(dbPath?: string): any | null {
  const resolved = dbPath ?? findDbPath();
  if (!resolved) return null;
  const cached = _debtDbCache.get(resolved);
  if (cached) {
    // 验证连接仍可用（文件可能被外部删除/替换）
    try {
      cached.db.prepare("SELECT 1").get();
      return cached.db;
    } catch {
      try { cached.db.close(); } catch {}
      _debtDbCache.delete(resolved);
    }
  }
  const db = openDb(resolved);
  if (!db) return null;
  _debtDbCache.set(resolved, { db, stmts: new Map() });
  return db;
}

function getDebtStmt(db: any, dbPath: string | undefined, key: string, sql: string): any | null {
  const resolved = dbPath ?? findDbPath();
  if (!resolved) return null;
  const entry = _debtDbCache.get(resolved);
  if (!entry) return null;
  let stmt = entry.stmts.get(key);
  if (!stmt) {
    try {
      stmt = db.prepare(sql);
      entry.stmts.set(key, stmt);
    } catch {
      return null;
    }
  }
  return stmt;
}

export function closeDebtDb(): void {
  for (const [, entry] of _debtDbCache) {
    try { entry.db.close(); } catch {}
    entry.stmts.clear();
  }
  _debtDbCache.clear();
}

// ─── Debt CRUD ──────────────────────────────────────────

/**
 * Get all pending debts ordered by urgency (token ratio descending).
 * Higher currentTokenCount / tokenBudget = more urgent.
 */
export function getPendingDebts(dbPath?: string): DebtRecord[] {
  const db = getDebtDb(dbPath);
  if (!db) return [];

  try {
    const stmt = getDebtStmt(db, dbPath, 'getPendingDebts',
      "SELECT conversation_id as conversationId, pending, requested_at as requestedAt, reason, running, token_budget as tokenBudget, current_token_count as currentTokenCount, updated_at as updatedAt FROM conversation_compaction_maintenance WHERE pending = 1 AND running = 0 ORDER BY (CAST(current_token_count AS REAL) / NULLIF(token_budget, 0)) DESC, requested_at ASC LIMIT 10");
    if (!stmt) return [];
    return stmt.all().map((r: any) => ({
      conversationId: r.conversationId,
      pending: !!r.pending,
      requestedAt: r.requestedAt,
      reason: r.reason || "unknown",
      running: !!r.running,
      tokenBudget: r.tokenBudget || 114688,
      currentTokenCount: r.currentTokenCount || 0,
      updatedAt: r.updatedAt,
    }));
  } catch {
    return [];
  }
}

export function markDebtRunning(conversationId: number, dbPath?: string): boolean {
  const db = getDebtDb(dbPath);
  if (!db) return false;
  try {
    const stmt = getDebtStmt(db, dbPath, 'markDebtRunning',
      "UPDATE conversation_compaction_maintenance SET running = 1, updated_at = datetime('now') WHERE conversation_id = ? AND pending = 1");
    if (!stmt) return false;
    stmt.run(conversationId);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清除债务：将 pending=0, running=0。
 * P3-5: 原先 reason 参数被接收但从未写入数据库（死参数）。
 * 现将 reason 写入 reason 列，保留清账原因便于审计。
 */
export function clearDebt(conversationId: number, reason?: string, dbPath?: string): boolean {
  const db = getDebtDb(dbPath);
  if (!db) return false;
  try {
    const stmt = getDebtStmt(db, dbPath, 'clearDebt',
      "UPDATE conversation_compaction_maintenance SET pending = 0, running = 0, reason = ?, updated_at = datetime('now') WHERE conversation_id = ?");
    if (!stmt) return false;
    stmt.run(reason ?? 'cleared', conversationId);
    return true;
  } catch {
    return false;
  }
}

/**
 * P3-5: 标记债务处理失败 —— 重置 running=0 但保留 pending=1，使其可在下次轮询重试。
 * 原先失败时直接 clearDebt（pending=0），导致失败的工作被静默丢弃、永不重试。
 * 现改为保留 pending 状态以便重试，并将失败原因写入 reason 列留痕。
 */
export function markDebtFailed(conversationId: number, reason: string, dbPath?: string): boolean {
  const db = getDebtDb(dbPath);
  if (!db) return false;
  try {
    const stmt = getDebtStmt(db, dbPath, 'markDebtFailed',
      "UPDATE conversation_compaction_maintenance SET running = 0, reason = ?, updated_at = datetime('now') WHERE conversation_id = ? AND pending = 1");
    if (!stmt) return false;
    stmt.run(reason, conversationId);
    return true;
  } catch {
    return false;
  }
}

// ─── MemoryDir Resolution ───────────────────────────────

/**
 * Resolve memoryDir from sessionFile (SDK authoritative source) or config fallback.
 */
export function resolveMemoryDir(sessionFile: string | undefined, config: any): string | undefined {
  if (sessionFile) {
    const match = sessionFile.match(/^(.*\.openclaw)[\/]/);
    if (match) return path.join(match[1], "workspace", "main", "memory");
  }
  const wsDir = config?.workspace || process.env.OPENCLAW_WORKSPACE;
  if (wsDir) return path.join(wsDir, "memory");
  return undefined;
}

// ─── Urgency Calculator ─────────────────────────────────

/**
 * Calculate urgency score for a debt. Range: 0.0-1.0+
 * Higher = more urgent, should be processed sooner.
 */
export function calculateUrgency(debt: DebtRecord): number {
  if (!debt.tokenBudget) return 0;
  return debt.currentTokenCount / debt.tokenBudget;
}

// ─── Scheduler State ────────────────────────────────────

let schedulerTimer: NodeJS.Timeout | null = null;
let activeJobs: Map<number, Promise<any>> = new Map();
let _onCompactionFn: ((instance: any) => Promise<void>) | null = null;
let _apiContext: { config: any; logger?: any } | null = null;
let _config: Required<DebtSchedulerConfig> = { ...DEFAULT_SCHEDULER_CONFIG };

export interface SchedulerStats {
  running: number;
  pendingCount: number;
  pollIntervalMs: number;
  maxConcurrent: number;
}

export function getSchedulerStats(): SchedulerStats {
  return {
    running: activeJobs.size,
    pendingCount: getPendingDebts().length,
    pollIntervalMs: _config.pollIntervalMs ?? DEFAULT_SCHEDULER_CONFIG.pollIntervalMs,
    maxConcurrent: _config.maxConcurrent ?? DEFAULT_SCHEDULER_CONFIG.maxConcurrent,
  };
}

// ─── Process Single Debt ────────────────────────────────

async function processSingleDebt(debt: DebtRecord): Promise<void> {
  if (!_onCompactionFn || !_apiContext) return;

  // Mark as running to prevent duplicate processing
  if (!markDebtRunning(debt.conversationId)) {
    _apiContext.logger?.debug?.("debt-manager: debt " + debt.conversationId + " already being processed, skipping");
    return;
  }

  try {
    // Resolve session info
    const sessionKey = "conv:" + debt.conversationId;
    let sessionFile: string | undefined;

    try {
      const wsDir = _apiContext.config?.workspace || process.env.OPENCLAW_WORKSPACE;
      if (wsDir) {
        const losslessSessionDir = path.join(wsDir, ".lossless", "sessions");
        if (fs.existsSync(losslessSessionDir)) {
          const files = fs.readdirSync(losslessSessionDir).filter((f: string) => f.endsWith(".json"));
          for (const fname of files) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(losslessSessionDir, fname), "utf8"));
              if (data.sessionId === String(debt.conversationId) || data.sessionKey === sessionKey) {
                sessionFile = path.join(wsDir, ".lossless", "sessions", fname);
                break;
              }
            } catch {}
          }
        }
      }
    } catch {}

    // Build instance for onCompaction
    const memoryDir = resolveMemoryDir(sessionFile, _apiContext.config);
    const urgency = calculateUrgency(debt);

    _apiContext.logger?.info?.(
      "debt-manager: processing debt " + debt.conversationId +
      ", urgency=" + urgency.toFixed(3) +
      ", tokens=" + debt.currentTokenCount + "/" + debt.tokenBudget
    );

    const instance = {
      config: _apiContext.config,
      logger: _apiContext.logger,
      context: { memoryDir, sessionKey, sessionFile, sessionId: String(debt.conversationId) },
      unregister: () => {},
    };

    await _onCompactionFn(instance);
    clearDebt(debt.conversationId, "compacted_by_debt_manager");

    _apiContext.logger?.info?.("debt-manager: debt " + debt.conversationId + " cleared after compaction");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    _apiContext.logger?.error?.("debt-manager: failed to process debt " + debt.conversationId, { err: msg });
    // P3-5: 失败不清账 —— 保留 pending=1 以便下次轮询重试，仅重置 running=0 并记录原因。
    // 原先直接 clearDebt 会静默丢弃失败的工作，永不重试。
    markDebtFailed(debt.conversationId, "failed: " + msg.slice(0, 200));
  }
  // SEC-7 M-13: activeJobs.delete 已移至调用方 pollAndDispatch 的 .finally 包装中，
  // 以确保所有 settle 路径（含上方 !_onCompactionFn / markDebtRunning=false 早返回）都清理。
}

// ─── Poll & Dispatch ────────────────────────────────────

async function pollAndDispatch(): Promise<void> {
  if (!_onCompactionFn || !_apiContext) return;

  const pending = getPendingDebts();
  if (pending.length === 0) return;

  const maxConcurrent = _config.maxConcurrent ?? DEFAULT_SCHEDULER_CONFIG.maxConcurrent;
  const urgentThreshold = _config.urgentThreshold ?? DEFAULT_SCHEDULER_CONFIG.urgentThreshold;
  const slotsAvailable = maxConcurrent - activeJobs.size;

  if (slotsAvailable <= 0) {
    _apiContext.logger?.debug?.("debt-manager: all " + maxConcurrent + " slots busy, waiting for next poll");
    return;
  }

  // Separate urgent vs normal debts
  const urgentDebts = pending.filter((d) => calculateUrgency(d) >= urgentThreshold);
  const normalDebts = pending.filter((d) => calculateUrgency(d) < urgentThreshold);

  _apiContext.logger?.info?.(
    "debt-manager: poll found " + pending.length + " pending, " +
    urgentDebts.length + " urgent, " + activeJobs.size + "/" + maxConcurrent + " slots used"
  );

  // Dispatch urgent debts first
  let dispatched = 0;
  for (const debt of urgentDebts) {
    if (dispatched >= slotsAvailable) break;
    if (activeJobs.has(debt.conversationId)) continue;

    // SEC-7 M-13: 用 .finally 包装确保所有 settle 路径（含早返回）都清理 activeJobs。
    // 修复前早返回路径（!_onCompactionFn / markDebtRunning=false）绕过内层 finally，
    // 且调用方 activeJobs.set 在 processSingleDebt 之后，同步早返回会导致 delete 先于 set 执行 → 条目泄漏。
    // .finally 回调在微任务中执行，保证 set 先于 delete。
    const promise = processSingleDebt(debt).finally(() => activeJobs.delete(debt.conversationId));
    activeJobs.set(debt.conversationId, promise);
    dispatched++;
  }

  // Then dispatch normal debts with any remaining slots
  for (const debt of normalDebts) {
    if (dispatched >= slotsAvailable) break;
    if (activeJobs.has(debt.conversationId)) continue;

    // SEC-7 M-13: 用 .finally 包装确保所有 settle 路径（含早返回）都清理 activeJobs。
    // 修复前早返回路径（!_onCompactionFn / markDebtRunning=false）绕过内层 finally，
    // 且调用方 activeJobs.set 在 processSingleDebt 之后，同步早返回会导致 delete 先于 set 执行 → 条目泄漏。
    // .finally 回调在微任务中执行，保证 set 先于 delete。
    const promise = processSingleDebt(debt).finally(() => activeJobs.delete(debt.conversationId));
    activeJobs.set(debt.conversationId, promise);
    dispatched++;
  }

  _apiContext.logger?.debug?.("debt-manager: dispatched " + dispatched + " job(s) this poll");
}

// ─── Scheduler Lifecycle ────────────────────────────────

/**
 * Start the resident debt scheduler.
 * Polls for pending debts at configured interval and dispatches them.
 */
export async function startScheduler(
  onCompactionFn: (instance: any) => Promise<void>,
  apiContext: { config: any; logger?: any },
  config?: DebtSchedulerConfig,
): Promise<void> {
  if (schedulerTimer !== null) {
    apiContext.logger?.warn?.("debt-manager: scheduler already running, updating config");
  }

  _onCompactionFn = onCompactionFn;
  _apiContext = apiContext;
  _config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };

  // Stop old timer if exists
  stopScheduler();

  const pollMs = _config.pollIntervalMs ?? DEFAULT_SCHEDULER_CONFIG.pollIntervalMs;

  schedulerTimer = setInterval(async () => {
    try {
      await pollAndDispatch();
    } catch (err) {
      apiContext.logger?.error?.("debt-manager: poll failed", { err: String(err) });
    }
  }, pollMs);

  // Run immediately on start
  try {
    await pollAndDispatch();
  } catch (err) {
    apiContext.logger?.warn?.("debt-manager: initial poll failed, will retry at next interval", { err: String(err) });
  }

  apiContext.logger?.info?.(
    "debt-manager: scheduler started, pollInterval=" + pollMs + "ms, maxConcurrent=" + _config.maxConcurrent
  );
}

/**
 * Stop the resident debt scheduler.
 */
/**
 * Stop the resident debt scheduler and wait for active jobs to finish.
 */
export async function stopScheduler(): Promise<void> {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  // Wait for all active jobs to complete
  if (activeJobs.size > 0 && _apiContext) {
    _apiContext.logger?.info?.('debt-manager: waiting for ' + activeJobs.size + ' active job(s) to finish');
    await Promise.all(Array.from(activeJobs.values()));
  }
  activeJobs.clear();
}

/**
 * Check if scheduler is running.
 */
export function isSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}

// ─── Emergency one-shot (for manual trigger only) ──────────────────────────

/**
 * Trigger immediate poll-and-dispatch without waiting for next interval.
 * Uses the already-configured scheduler state (no global mutation).
 */
export async function triggerNow(): Promise<void> {
  if (!_onCompactionFn || !_apiContext) {
    throw new Error('debt-manager: scheduler not initialized, call startScheduler first');
  }
  await pollAndDispatch();
}
