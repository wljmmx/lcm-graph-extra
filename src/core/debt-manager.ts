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

// ─── Debt CRUD ──────────────────────────────────────────

/**
 * Get all pending debts ordered by urgency (token ratio descending).
 * Higher currentTokenCount / tokenBudget = more urgent.
 */
export function getPendingDebts(dbPath?: string): DebtRecord[] {
  const db = openDb(dbPath);
  if (!db) return [];

  try {
    return db.prepare(
      "SELECT conversation_id as conversationId, pending, requested_at as requestedAt, reason, running, token_budget as tokenBudget, current_token_count as currentTokenCount, updated_at as updatedAt FROM conversation_compaction_maintenance WHERE pending = 1 AND running = 0 ORDER BY (CAST(current_token_count AS REAL) / NULLIF(token_budget, 0)) DESC, requested_at ASC LIMIT 10"
    ).all().map((r: any) => ({
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
  } finally {
    db.close();
  }
}

export function markDebtRunning(conversationId: number, dbPath?: string): boolean {
  const db = openDb(dbPath);
  if (!db) return false;
  try {
    db.prepare(
      "UPDATE conversation_compaction_maintenance SET running = 1, updated_at = datetime('now') WHERE conversation_id = ? AND pending = 1"
    ).run(conversationId);
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function clearDebt(conversationId: number, reason?: string, dbPath?: string): boolean {
  const db = openDb(dbPath);
  if (!db) return false;
  try {
    db.prepare(
      "UPDATE conversation_compaction_maintenance SET pending = 0, running = 0, updated_at = datetime('now') WHERE conversation_id = ?"
    ).run(conversationId);
    return true;
  } catch {
    return false;
  } finally {
    db.close();
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
    // Clear even on failure to prevent infinite retry loops
    clearDebt(debt.conversationId, "failed: " + msg.slice(0, 200));
  } finally {
    activeJobs.delete(debt.conversationId);
  }
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

    const promise = processSingleDebt(debt);
    activeJobs.set(debt.conversationId, promise);
    dispatched++;
  }

  // Then dispatch normal debts with any remaining slots
  for (const debt of normalDebts) {
    if (dispatched >= slotsAvailable) break;
    if (activeJobs.has(debt.conversationId)) continue;

    const promise = processSingleDebt(debt);
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
