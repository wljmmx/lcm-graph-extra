import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// P2-AUDIT: 默认 tokenBudget ≈ 112K（128K 上下文窗口的 ~90%），
// 集中定义避免魔术数字散落。
const DEFAULT_TOKEN_BUDGET = 114688;

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
  // v2.5.0: 从 60s 降到 30s，加快 compaction 债务处理速度
  pollIntervalMs: 30_000,
  // v2.5.0: 从 1 提升到 2，允许并行处理多个会话的 compaction
  maxConcurrent: 2,
  urgentThreshold: 0.7,
};

// ─── DB Utilities ───────────────────────────────────────

function findDbPath(): string | null {
  // P2-8: 用 homedir() 替换 process.env.HOME，与 tools.ts / lcm-bridge.ts 保持一致。
  // homedir() 在 Linux 优先读 /etc/passwd，更稳健；且 Windows 下回退 USERPROFILE。
  const home = homedir() || process.env.HOME || "";
  const candidates: (string | undefined)[] = [
    process.env.OPENCLAW_DB_PATH,
    // P0-3: lcm.db 必须作为首选文件候选 —— writeCompactionDebt (lcm-bridge.ts) 实际
    // 将 conversation_compaction_maintenance 写入 lcm.db。修复前 findDbPath 只查
    // sessions.db / gateway.db，导致债务调度器读取了错误的数据库，永远找不到债务。
    path.join(home, ".openclaw", "lcm.db"),
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

/**
 * P1-5: 重置 stale running=1 债务。
 *
 * 问题背景：进程异常退出时，正在执行的债务其 running=1 标记不会被清除。
 * 重启后这些债务会永久卡在 running=1 状态，既不会被 pollAndDispatch 重新拾取
 * （getPendingDebts 查询条件是 running=0），也无法被清理，形成"僵尸债务"。
 *
 * 本函数在 scheduler 启动时调用，将所有 running=1 的债务重置为 running=0，
 * 使其重新进入待处理队列。
 */
export function resetStaleRunning(dbPath?: string): number {
  const db = getDebtDb(dbPath);
  if (!db) return 0;
  try {
    const stmt = getDebtStmt(db, dbPath, 'resetStaleRunning',
      "UPDATE conversation_compaction_maintenance SET running = 0, updated_at = datetime('now') WHERE running = 1");
    if (!stmt) return 0;
    const result = stmt.run();
    return (result?.changes ?? 0) as number;
  } catch {
    return 0;
  }
}

/**
 * P0-3: 对账清理债务表，防止无限增长与孤儿堆积。
 *
 * 问题背景：
 * 1. 孤儿债务 —— 会话被删除后，conversation_compaction_maintenance 中对应行仍
 *    保留 pending=1。原先靠 onCompaction 隐式 no-op 才被 clearDebt 静默清账，
 *    是脆弱不变式（任何让 onCompaction 抛错的改动都会变成无限重试）。
 * 2. 墓碑堆积 —— clearDebt 只设 pending=0/running=0，从不 DELETE，表无限增长，
 *    getPendingDebts 的 LIMIT 10 排序查询会扫越来越多行。
 *
 * 本函数：
 * - 删除孤儿债务（conversation_id 在 conversations 表中已不存在）
 * - 删除 7 天前的墓碑债务（pending=0, running=0, updated_at < now - 7 days）
 *
 * 非关键维护操作：任何异常都静默返回已完成的计数，不影响调度器主循环。
 */
export interface ReconcileResult {
  orphaned: number;
  tombstones: number;
}

export function reconcileDebtTable(dbPath?: string): ReconcileResult {
  const db = getDebtDb(dbPath);
  if (!db) return { orphaned: 0, tombstones: 0 };
  const result: ReconcileResult = { orphaned: 0, tombstones: 0 };
  try {
    // 检查 conversations 表是否存在（避免在全新/空库上抛错）
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'"
    ).get() as { name: string } | undefined;
    if (tableCheck) {
      // 删除孤儿债务：conversation_id 在 conversations 表中已不存在
      const orphanStmt = getDebtStmt(db, dbPath, 'reconcileDelOrphans',
        "DELETE FROM conversation_compaction_maintenance " +
        "WHERE conversation_id NOT IN (SELECT conversation_id FROM conversations)");
      if (orphanStmt) {
        const r = orphanStmt.run();
        result.orphaned = (r?.changes ?? 0) as number;
      }
    }
    // 删除 7 天前的墓碑债务（已清账但仍占用行）
    const tombStmt = getDebtStmt(db, dbPath, 'reconcileDelTombstones',
      "DELETE FROM conversation_compaction_maintenance " +
      "WHERE pending = 0 AND running = 0 " +
      "AND datetime(updated_at) < datetime('now', '-7 days')");
    if (tombStmt) {
      const r = tombStmt.run();
      result.tombstones = (r?.changes ?? 0) as number;
    }
  } catch (e) {
    // 静默失败 —— 对账是非关键维护操作
    _apiContext?.logger?.debug?.("debt table reconcile failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
  }
  return result;
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
      tokenBudget: r.tokenBudget || DEFAULT_TOKEN_BUDGET,
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

// ─── Session File Index (v2.7.3) ────────────────────────
// processSingleDebt 原先每次扫描全部 .lossless/sessions/*.json 并逐个 JSON.parse
// —— 每笔债务 O(所有会话) 的重复解析。此处缓存 文件名 → {mtimeMs, sessionId,
// sessionKey}，仅 mtime 变化的文件才重新读取。容量上限与去重缓存对齐。
const _sessionFileIndex = new Map<string, { mtimeMs: number; sessionId?: string; sessionKey?: string }>();
const _SESSION_FILE_INDEX_MAX = 500;

// ─── Process Single Debt ────────────────────────────────

async function processSingleDebt(debt: DebtRecord): Promise<void> {
  if (!_onCompactionFn || !_apiContext) return;

  // Mark as running to prevent duplicate processing
  if (!markDebtRunning(debt.conversationId)) {
    _apiContext.logger?.debug?.("debt-manager: debt " + debt.conversationId + " already being processed, skipping");
    return;
  }

  try {
    // BUG-AUDIT: 用 conversationId 反查真实的 session_id / session_key，
    // 不能用 `String(conversationId)` 当 sessionId（lossless-claw 用它查
    // conversations.session_id 列，number 主键永远查不到）。
    const { getSessionInfoByConversationId } = await import('../lcm-bridge.js');
    const sessionInfo = getSessionInfoByConversationId(debt.conversationId);
    const sessionKey = sessionInfo.sessionKey ?? "conv:" + debt.conversationId;
    const realSessionId = sessionInfo.sessionId ?? String(debt.conversationId);
    let sessionFile: string | undefined;

    try {
      const wsDir = _apiContext.config?.workspace || process.env.OPENCLAW_WORKSPACE;
      if (wsDir) {
        const losslessSessionDir = path.join(wsDir, ".lossless", "sessions");
        // BUGFIX(P2-7): 将同步 fs 调用改为异步，避免在 debt 处理热路径阻塞事件循环。
        // existsSync 保留作为守卫检查（开销小），readdir/readFile 改用 fs.promises 异步版本。
        if (fs.existsSync(losslessSessionDir)) {
          const files = (await fs.promises.readdir(losslessSessionDir)).filter((f: string) => f.endsWith(".json"));
          for (const fname of files) {
            try {
              const full = path.join(losslessSessionDir, fname);
              // v2.7.3: mtime 缓存 —— 未变更的 session 文件跳过 JSON.parse
              const st = await fs.promises.stat(full);
              const cached = _sessionFileIndex.get(fname);
              if (cached && cached.mtimeMs === st.mtimeMs) {
                if (cached.sessionId === realSessionId || cached.sessionKey === sessionKey) {
                  sessionFile = full;
                  break;
                }
                continue;
              }
              const data = JSON.parse(await fs.promises.readFile(full, "utf8"));
              if (_sessionFileIndex.size >= _SESSION_FILE_INDEX_MAX) {
                const oldest = _sessionFileIndex.keys().next().value;
                if (oldest !== undefined) _sessionFileIndex.delete(oldest);
              }
              _sessionFileIndex.set(fname, { mtimeMs: st.mtimeMs, sessionId: data.sessionId, sessionKey: data.sessionKey });
              // BUG-AUDIT: 用反查到的真实 sessionId/sessionKey 匹配，而非 String(conversationId)
              if (data.sessionId === realSessionId || data.sessionKey === sessionKey) {
                sessionFile = full;
                break;
              }
            } catch (e) {
              _apiContext?.logger?.debug?.("session file parse failed, skipping", { file: fname, err: e instanceof Error ? e.message : String(e) });
            }
          }
        }
      }
    } catch (e) {
      _apiContext?.logger?.debug?.("lossless session file scan failed", { err: e instanceof Error ? e.message : String(e) });
    }

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
      // BUG-AUDIT: sessionId 用反查到的真实 OpenClaw 会话 ID，不是 String(conversationId)
      context: { memoryDir, sessionKey, sessionFile, sessionId: realSessionId },
      unregister: () => {},
    };

    // FIX-CR11: 压缩前复查主轮门控。
    // dispatch（pollAndDispatch）时已检查，但 session 文件扫描可能耗时，
    // 期间用户可能发新消息触发主轮生成。压缩是 Ollama LLM 调用，与主生成
    // 串行排队会导致 host "stopped making progress" 中断。复查到主轮活跃时
    // 抛错 → 走现有 catch → markDebtFailed 保留债务供下次 poll 重试（P3-5 失败不清账）。
    let _gateActive = false;
    try {
      const { isMainTurnActive } = await import('../async/main-turn-gate.js');
      _gateActive = isMainTurnActive();
    } catch { /* gate 不可用时按不活跃处理，继续压缩 */ }
    if (_gateActive) {
      throw new Error('main turn active, deferring compaction to next poll');
    }

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

  // 主轮门控：主对话轮进行中（assemble → host 生成 → afterTurn）时让路，
  // 下一轮 poll（60s 后）自然重试。债务本质是"可推迟的工作"，
  // 抢在主模型生成期间跑压缩 LLM 只会加剧 Ollama 排队。
  try {
    const { isMainTurnActive } = await import('../async/main-turn-gate.js');
    if (isMainTurnActive()) {
      _apiContext.logger?.debug?.("debt-manager: main turn active, deferring debt dispatch");
      return;
    }
  } catch { /* gate 不可用时维持原行为 */ }

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
  // M-3: 重复启动保护 —— 已在运行时直接 return，避免重启打断在途 activeJobs
  // （原代码仅 warn 后继续 stopScheduler + 重启，可能导致正在执行的 compact 被打断）
  if (schedulerTimer !== null) {
    apiContext.logger?.warn?.("debt-manager: scheduler already running, ignoring duplicate startScheduler call");
    return;
  }

  _onCompactionFn = onCompactionFn;
  _apiContext = apiContext;
  _config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };

  // Stop old timer if exists（防御性：正常路径不会到这里，M-3 已早返回）
  stopScheduler();

  // P1-5: 启动时重置 stale running=1 债务，防止进程重启后僵尸债务永久卡住。
  const staleReset = resetStaleRunning();
  if (staleReset > 0) {
    apiContext.logger?.info?.(`debt-manager: reset ${staleReset} stale running debt(s) on startup`);
  }

  // P0-3: 启动时对账清理债务表 —— 删除孤儿债务与过期墓碑，防止表无限增长。
  const reconciled = reconcileDebtTable();
  if (reconciled.orphaned > 0 || reconciled.tombstones > 0) {
    apiContext.logger?.info?.(
      `debt-manager: reconciled debt table on startup (orphans=${reconciled.orphaned}, tombstones=${reconciled.tombstones})`
    );
  }

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
