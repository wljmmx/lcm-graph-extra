/**
 * lcm-graph-extra — Token Usage Tracker
 *
 * Asynchronous token usage tracking module.
 * Uses DeepSeek V3 BPE tokenizer via Python subprocess for accurate counting.
 * Falls back to estimation for non-DeepSeek models.
 *
 * Design:
 * - Python child process started once, reused for all requests (line protocol)
 * - Events emitted at key lifecycle points, processed asynchronously
 * - Independent SQLite database for usage records
 * - Failure-tolerant: errors log and swallow, never block main flow
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../utils/logger.js';
import { resolveLogger } from '../utils/logger.js';

// ─── Path resolution ─────────────────────────────────────────

const __dirname = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const WORKSPACE = resolve(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'workspace', 'main');
const DB_DIR = resolve(WORKSPACE, '.openclaw/tmp/usage-history');
const DB_PATH = resolve(DB_DIR, 'token_usage.db');
const PYTHON_COUNTER = resolve(__dirname, 'src', 'async', 'token-counter.py');

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

// ─── Token Counter (Python subprocess) ──────────────────────

class TokenCounter {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private pendingResolver: ((result: TokenCountResult) => void) | null = null;
  private queue: Array<{ text: string; model: string; resolve: (r: TokenCountResult) => void }> = [];
  private ready = false;
  private initDone = false;
  private logger: Logger;
  private exitCount = 0;

  constructor(logger?: Logger) {
    this.logger = resolveLogger(logger);
  }

  async init(): Promise<void> {
    if (this.initDone) return;
    this.initDone = true;

    if (!existsSync(PYTHON_COUNTER)) {
      this.logger.warn('[usage-tracker] Token counter script not found, using estimation');
      return;
    }

    try {
      // P0-3 BUG-2: 移除 timeout: 10000。Node spawn 实际不识别该选项，但为防止
      // 任何情况下长驻 Python tokenizer 被超时杀死（10s 后被 kill → 重连 → 再被 kill
      // → exitCount>3 永久降级为估算），显式不传 timeout。
      this.proc = spawn('python3', [PYTHON_COUNTER], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) this.logger.warn(`[usage-tracker] stderr: ${msg}`);
      });

      this.proc.on('exit', (code) => {
        this.exitCount = (this.exitCount || 0) + 1;
        if (this.exitCount > 3) {
          this.logger.warn(`[usage-tracker] Process exited ${this.exitCount} times, switching to estimation mode`);
          this.proc = null;
          this.ready = false;
          this.initDone = true;
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, this.exitCount), 30000);
        this.logger.warn(`[usage-tracker] Process exited (code ${code}), attempt ${this.exitCount}/3, reconnecting in ${delay/1000}s`);
        this.proc = null;
        this.ready = false;
        this.initDone = false;
        setTimeout(() => { this.initDone = false; this.init(); }, delay);
      });

      // Wait for ready via ping
      await this.pingWithTimeout();
      this.ready = true;
      this.logger.info('[usage-tracker] Token counter ready');
    } catch (err) {
      this.logger.warn(`[usage-tracker] Token counter init failed: ${err}`);
    }
  }

  private pingWithTimeout(): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn('[usage-tracker] Ping timeout, using estimation');
        resolve();
      }, 3000);
      
      this.send({ action: 'ping' });
      // Listen for response in next processBuffer call
      const origProcess = this.processBuffer.bind(this);
      let responded = false;
      this.processBuffer = () => {
        origProcess();
        if (!responded && this.buffer.includes('"ok"')) {
          responded = true;
          clearTimeout(timeout);
          this.processBuffer = origProcess;
          resolve();
        }
      };
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        if (response.error) {
          this.logger.warn(`[usage-tracker] Count error: ${response.error}`);
          if (this.pendingResolver) {
            const p = this.pendingResolver;
            this.pendingResolver = null;
            p({ chars: 0, tokens: 0, model: '' });
          }
          // P0-3 BUG-2: 错误响应后也需排空队列
          this.drainQueue();
          continue;
        }
        if (this.pendingResolver) {
          const p = this.pendingResolver;
          this.pendingResolver = null;
          p({
            chars: response.chars || 0,
            tokens: response.tokens || 0,
            model: response.model || '',
            method: response.method,
          });
          // P0-3 BUG-2: 响应解析后消费队列中下一个请求，否则排队 Promise 永不 resolve
          this.drainQueue();
        }
      } catch (e) {
        // Incomplete JSON line
      }
    }
  }

  /**
   * P0-3 BUG-2: 当 pendingResolver 被消费后，从队列中取下一个请求发送给 tokenizer。
   * 原代码 processBuffer 解析响应后从不消费 queue，并发 count() 时排队 Promise 永不 resolve，
   * 导致内存泄漏 + 调用方挂起。
   */
  private drainQueue(): void {
    if (this.queue.length === 0) return;
    if (this.pendingResolver) return; // 已有在途请求
    const next = this.queue.shift();
    if (!next) return;
    if (!this.ready || !this.proc) {
      // 进程已退出，回退估算
      next.resolve(this.estimate(next.text, next.model));
      // 递归排空剩余
      this.drainQueue();
      return;
    }
    this.pendingResolver = next.resolve;
    this.send({ action: 'count', text: next.text, model: next.model });
  }

  count(text: string, model: string): Promise<TokenCountResult> {
    if (!this.ready || !this.proc) {
      return Promise.resolve(this.estimate(text, model));
    }

    return new Promise((resolve) => {
      if (this.pendingResolver) {
        this.queue.push({ text, model, resolve });
        return;
      }
      this.pendingResolver = resolve;
      this.send({ action: 'count', text, model });
    });
  }

  private estimate(text: string, model: string): TokenCountResult {
    const chinese = [...text].filter(c => c >= '\u4e00' && c <= '\u9fff').length;
    const english = text.length - chinese;
    const tokens = Math.floor(chinese * 0.6 + english * 0.3) + 1;
    return { chars: text.length, tokens, model, method: 'estimate' };
  }

  private send(data: unknown): void {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify(data) + '\n');
    }
  }

  close(): void {
    this.proc?.kill();
    this.proc = null;
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
        mkdirSync(DB_DIR, { recursive: true });
        this.db = new BetterSqlite3.default(DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.initSchema();
        this.ready = true;
        this.logger.info('[usage-tracker] DB ready (better-sqlite3)');
      } else {
        // Fallback: JSON file storage
        this.logger.info('[usage-tracker] DB fallback: JSON file storage');
        this.ready = true; // Will work in memory/file mode
      }
    } catch (err) {
      this.logger.warn(`[usage-tracker] DB init failed: ${err}`);
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
