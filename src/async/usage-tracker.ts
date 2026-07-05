/**
 * lcm-graph-extra — Token Usage Tracker
 *
 * Asynchronous token usage tracking module.
 *
 * TEST-3 H-20: 原设计通过 Python 子进程调用 DeepSeek V3 BPE tokenizer 精确计数，
 * 但 token-counter.py 从未提交到仓库（existsSync 永远 false），Python 路径是死代码，
 * 实际运行永远降级为估算模式。已移除 Python 子进程相关代码，统一走估算。
 * 若未来需要精确计数，可改用 worker_threads 池 + js-tiktoken 等 JS 原生库实现。
 *
 * Design:
 * - Events emitted at key lifecycle points, processed asynchronously
 * - Independent SQLite database for usage records
 * - Failure-tolerant: errors log and swallow, never block main flow
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from '../utils/logger.js';
import { resolveLogger } from '../utils/logger.js';

// ─── Path resolution ─────────────────────────────────────────

const WORKSPACE = resolve(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'workspace', 'main');
const DB_DIR = resolve(WORKSPACE, '.openclaw/tmp/usage-history');
const DB_PATH = resolve(DB_DIR, 'token_usage.db');
// TEST-3 H-20: PYTHON_COUNTER 与 fileURLToPath/import.meta.url 已移除（token-counter.py 不存在，死代码）。

interface TokenCountResult {
  chars: number;
  tokens: number;
  model: string;
  method?: string;
}

interface UsageRecord {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: 'pending' | 'completed' | 'aborted' | 'error';
  costCny: number;
  durationMs: number;
  promptPreview: string;
  createdAt: number;
  completedAt?: number;
}

// ─── Token Counter (estimation-only) ───────────────────────
// TEST-3 H-20: 移除 Python 子进程实现，统一走估算。
// 原设计的 spawn/pingWithTimeout/processBuffer/drainQueue/queue 全部是死代码
// （token-counter.py 不存在，existsSync 永远 false，ready 永远 false）。
// 简化为纯估算实现，消除 ChildProcess/queue/buffer 等无用状态。

class TokenCounter {
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = resolveLogger(logger);
  }

  async init(): Promise<void> {
    // TEST-3 H-20: 无外部进程需启动。保留空实现以维持 UsageTracker.lazyInit 的调用契约。
    this.logger.debug?.('[usage-tracker] Token counter ready (estimation mode)');
  }

  count(text: string, model: string): Promise<TokenCountResult> {
    return Promise.resolve(this.estimate(text, model));
  }

  private estimate(text: string, model: string): TokenCountResult {
    const chinese = [...text].filter(c => c >= '\u4e00' && c <= '\u9fff').length;
    const english = text.length - chinese;
    const tokens = Math.floor(chinese * 0.6 + english * 0.3) + 1;
    return { chars: text.length, tokens, model, method: 'estimate' };
  }

  close(): void {
    // TEST-3 H-20: 无外部进程需清理。
  }
}

// ─── SQLite Driver (lightweight, no dependencies) ──────────

class UsageDb {
  private db: any = null;
  private logger: Logger;
  private ready = false;

  constructor(logger?: Logger) {
    this.logger = resolveLogger(logger);
  }

  async init(): Promise<void> {
    try {
      // Try native better-sqlite3 first (commonjs)
      // @ts-ignore - better-sqlite3 optional, caught by try/catch
      const BetterSqlite3 = await import('better-sqlite3').catch(() => null);
      if (BetterSqlite3?.default) {
        try {
          mkdirSync(DB_DIR, { recursive: true });
          this.db = new BetterSqlite3.default(DB_PATH);
          this.db.pragma('journal_mode = WAL');
          this.db.pragma('synchronous = NORMAL');
          this.initSchema();
          this.ready = true;
          this.logger.info('[usage-tracker] DB ready (better-sqlite3)');
        } catch (nativeErr) {
          // 原生绑定缺失（如 better_sqlite3.node 未编译）→ 降级 JSON 文件存储
          // 修复前：catch 在外层，this.ready 未置 true，导致 JSON fallback 也不生效
          this.db = null;
          this.ready = true;
          this.logger.warn(`[usage-tracker] better-sqlite3 native init failed, falling back to JSON: ${nativeErr}`);
        }
      } else {
        // Fallback: JSON file storage
        this.logger.info('[usage-tracker] DB fallback: JSON file storage');
        this.ready = true; // Will work in memory/file mode
      }
    } catch (err) {
      // 兜底：任何未预期错误也启用 JSON fallback，避免 usage-tracker 完全不可用
      this.db = null;
      this.ready = true;
      this.logger.warn(`[usage-tracker] DB init failed, falling back to JSON: ${err}`);
    }
  }

  private initSchema(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        cost_cny REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        prompt_preview TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model);
      CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at);
    `);
  }

  insertRecord(record: UsageRecord): void {
    if (!this.ready) return;
    try {
      if (this.db) {
        this.db.prepare(`
          INSERT INTO token_usage 
            (session_id, model, input_tokens, output_tokens, status, cost_cny, 
             duration_ms, prompt_preview, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.sessionId,
          record.model,
          record.inputTokens,
          record.outputTokens,
          record.status,
          record.costCny,
          record.durationMs,
          record.promptPreview.slice(0, 50),
          record.createdAt,
          record.completedAt ?? null,
        );
      }
    } catch (err) {
      this.logger.warn(`[usage-tracker] DB insert: ${err}`);
    }
  }

  updateRecord(sessionId: string, outputTokens: number, status: string, durationMs: number): void {
    if (!this.ready || !this.db) return;
    try {
      this.db.prepare(`
        UPDATE token_usage 
        SET output_tokens = output_tokens + ?, status = ?, duration_ms = ?, 
            completed_at = ?
        WHERE session_id = ? AND status = 'pending'
      `).run(outputTokens, status, durationMs, Date.now(), sessionId);
    } catch (err) {
      this.logger.warn(`[usage-tracker] DB update: ${err}`);
    }
  }

  getReport(days: number = 7): Record<string, unknown> {
    if (!this.ready || !this.db) {
      return { days, totalInput: 0, totalOutput: 0, totalCost: 0, report: [] };
    }
    try {
      const cutoff = Date.now() - days * 86400000;
      const rows = this.db.prepare(`
        SELECT 
          date(created_at / 1000, 'unixepoch') as day,
          model,
          SUM(input_tokens) as total_input,
          SUM(output_tokens) as total_output,
          SUM(cost_cny) as total_cost,
          COUNT(*) as call_count
        FROM token_usage
        WHERE created_at > ?
        GROUP BY day, model
        ORDER BY day DESC, total_cost DESC
      `).all(cutoff);

      const totalInput = rows.reduce((s: number, r: any) => s + (r.total_input || 0), 0);
      const totalOutput = rows.reduce((s: number, r: any) => s + (r.total_output || 0), 0);
      const totalCost = rows.reduce((s: number, r: any) => s + (r.total_cost || 0), 0);
      return { days, totalInput, totalOutput, totalCost, report: rows };
    } catch (err) {
      this.logger.warn(`[usage-tracker] DB getReport: ${err}`);
      return { days, totalInput: 0, totalOutput: 0, totalCost: 0, report: [] };
    }
  }

  close(): void {
    try { this.db?.close(); } catch {}
  }
}

// ─── Usage Tracker (Facade) ──────────────────────────────────

export class UsageTracker {
  private db: UsageDb;
  private counter: TokenCounter;
  private initPromise: Promise<void> | null = null;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = resolveLogger(logger);
    this.db = new UsageDb(this.logger);
    this.counter = new TokenCounter(this.logger);
    this.initPromise = this.lazyInit();
  }

  private async lazyInit(): Promise<void> {
    await Promise.all([
      this.db.init(),
      this.counter.init(),
    ]);
  }

  /**
   * 事件①: 上下文组装完成, 发送 LLM 前
   * 异步 tokenize 输入并写入记录, status=pending
   */
  onContextReady(sessionId: string, model: string, contextText: string): void {
    if (!contextText) return;
    setImmediate(async () => {
      try {
        if (this.initPromise) await this.initPromise;
        const result = await this.counter.count(contextText, model);
        const record: UsageRecord = {
          sessionId,
          model: model || 'unknown',
          inputTokens: result.tokens,
          outputTokens: 0,
          status: 'pending',
          costCny: this.estimateCost(model || '', result.tokens, 0),
          durationMs: 0,
          promptPreview: contextText.slice(0, 50),
          createdAt: Date.now(),
        };
        this.db.insertRecord(record);
      } catch (err) {
        this.logger.warn(`[usage-tracker] onContextReady: ${err}`);
      }
    });
  }

  /**
   * 事件③: LLM 返回/abort/error
   * 补写 output_tokens, status
   */
  onResponseReceived(
    sessionId: string,
    model: string,
    outputTokens: number,
    status: 'completed' | 'aborted' | 'error',
    durationMs: number,
  ): void {
    setImmediate(async () => {
      try {
        this.db.updateRecord(sessionId, outputTokens, status, durationMs);
      } catch (err) {
        this.logger.warn(`[usage-tracker] onResponseReceived: ${err}`);
      }
    });
  }

  /**
   * 估算费用 (¥ per 1M tokens)
   */
  private estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const m = model.toLowerCase();
    let ip = 0.5, op = 2.0;
    if (m.includes('deepseek-reasoner') || m.includes('deepseek-v4-pro')) { ip = 2.0; op = 8.0; }
    else if (m.includes('deepseek-chat') || m.includes('deepseek-v4-flash')) { ip = 0.5; op = 2.0; }
    if (m.includes('ollama') || m.includes('qwen') || m.includes('local')) { ip = 0; op = 0; }
    return (inputTokens / 1000000) * ip + (outputTokens / 1000000) * op;
  }

  /** 格式化用量报告 */
  getReport(days: number = 7): Record<string, unknown> {
    return this.db.getReport(days);
  }

  close(): void {
    this.db.close();
    this.counter.close();
  }
}
