import * as fs from "node:fs";
import * as path from "node:path";

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

export function getPendingDebts(dbPath?: string): DebtRecord[] {
  try {
    const resolved = dbPath ?? findDbPath();
    if (!resolved || !fs.existsSync(resolved)) return [];
    let Database: any;
    try { Database = require("better-sqlite3"); } catch { return []; }
    const db = new Database(resolved);
    try {
      return db.prepare(
        "SELECT conversation_id as conversationId, pending, requested_at as requestedAt, reason, running, token_budget as tokenBudget, current_token_count as currentTokenCount, updated_at as updatedAt FROM conversation_compaction_maintenance WHERE pending = 1 AND running = 0 ORDER BY requested_at ASC LIMIT 10"
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
    } finally { db.close(); }
  } catch { return []; }
}

export function markDebtRunning(conversationId: number, dbPath?: string): boolean {
  try {
    const resolved = dbPath ?? findDbPath();
    if (!resolved || !fs.existsSync(resolved)) return false;
    let Database: any;
    try { Database = require("better-sqlite3"); } catch { return false; }
    const db = new Database(resolved);
    try {
      db.prepare(
        "UPDATE conversation_compaction_maintenance SET running = 1, updated_at = datetime('now') WHERE conversation_id = ? AND pending = 1"
      ).run(conversationId);
      return true;
    } finally { db.close(); }
  } catch { return false; }
}

export function clearDebt(conversationId: number, reason?: string, dbPath?: string): boolean {
  try {
    const resolved = dbPath ?? findDbPath();
    if (!resolved || !fs.existsSync(resolved)) return false;
    let Database: any;
    try { Database = require("better-sqlite3"); } catch { return false; }
    const db = new Database(resolved);
    try {
      db.prepare(
        "UPDATE conversation_compaction_maintenance SET pending = 0, running = 0, updated_at = datetime('now') WHERE conversation_id = ?"
      ).run(conversationId);
      return true;
    } finally { db.close(); }
  } catch { return false; }
}

export function resolveMemoryDir(sessionFile: string | undefined, config: any): string | undefined {
  if (sessionFile) {
    const match = sessionFile.match(/^(.*\.openclaw)[\/]/);
    if (match) return path.join(match[1], "workspace", "main", "memory");
  }
  const wsDir = config?.workspace || process.env.OPENCLAW_WORKSPACE;
  if (wsDir) return path.join(wsDir, "memory");
  return undefined;
}


export async function processPendingDebts(
  onCompactionFn: (instance: any) => Promise<void>,
  apiContext: { config: any; logger?: any },
  maxConcurrent = 1,
): Promise<{ processed: number; skipped: number; failed: string[] }> {
  const pending = getPendingDebts();
  if (pending.length === 0) {
    return { processed: 0, skipped: 0, failed: [] };
  }

  apiContext.logger?.debug?.('debt-manager: found ' + pending.length + ' pending debt(s), maxConcurrent=' + maxConcurrent);

  const result = { processed: 0, skipped: 0, failed: [] as string[] };

  for (let i = 0; i < pending.length; i += maxConcurrent) {
    const batch = pending.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (debt) => {
      try {
        if (!markDebtRunning(debt.conversationId)) {
          apiContext.logger?.warn?.('debt-manager: failed to mark debt ' + debt.conversationId + ' as running');
          result.skipped++;
          return;
        }

        const sessionKey = 'conv:' + debt.conversationId;
        let sessionFile: string | undefined;

        try {
          const wsDir = apiContext.config?.workspace || process.env.OPENCLAW_WORKSPACE;
          if (wsDir) {
            const losslessSessionDir = path.join(wsDir, '.lossless', 'sessions');
            if (fs.existsSync(losslessSessionDir)) {
              const files = fs.readdirSync(losslessSessionDir).filter((f: string) => f.endsWith('.json'));
              for (const fname of files) {
                try {
                  const data = JSON.parse(fs.readFileSync(path.join(losslessSessionDir, fname), 'utf8'));
                  if (data.sessionId === String(debt.conversationId) || data.sessionKey === sessionKey) {
                    sessionFile = path.join(wsDir, '.lossless', 'sessions', fname);
                    break;
                  }
                } catch {}
              }
            }
          }
        } catch {}

        const memoryDir = resolveMemoryDir(sessionFile, apiContext.config);

        const instance = {
          config: apiContext.config,
          logger: apiContext.logger,
          context: { memoryDir, sessionKey, sessionFile, sessionId: String(debt.conversationId) },
          unregister: () => {},
        };

        await onCompactionFn(instance);
        result.processed++;
        clearDebt(debt.conversationId, 'compacted_by_debt_manager');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        apiContext.logger?.error?.('debt-manager: failed to process debt ' + debt.conversationId, { err: msg });
        result.failed.push(debt.conversationId + ': ' + msg);
        clearDebt(debt.conversationId, 'failed: ' + msg);
      }
    }));
  }

  apiContext.logger?.info?.('debt-manager: processed=' + result.processed + ', failed=' + result.failed.length);
  return result;
}
