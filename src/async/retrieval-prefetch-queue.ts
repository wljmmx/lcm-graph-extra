/**
 * 跨多轮检索预取队列（RetrievalPrefetchQueue）
 *
 * 背景：O7 预取原本是"单轮、fire-and-forget"——每次 afterTurn 都盲跑整套
 * L2/L3/L4 检索，且不同轮之间不合并。当地 Ollama 并发限到 2 后，多会话/多轮
 * 的完整检索互相排队；同一查询反复出现时还会白白重跑，吞掉槽位、拖慢时序。
 *
 * 本模块把预取提升为"跨多轮、有状态、按查询合并"的队列：
 * - enqueue(sessionKey, query, run)：按 sessionKey + 查询相似度 coalesce。
 *   若同会话已在队/在跑且查询相似度 >= 0.3，则仅刷新查询意图，不重复入队（merged）。
 *   否则入队执行（queued）。
 * - 有界并发（默认上限 min(2, OLLAMA_MAX_CONCURRENCY)），run 内部对 Ollama 的
 *   请求仍走全局 ollama-slot，双保险避免打爆本地模型。
 * - 结果由 run 内部写回 prefetchCache（覆盖式合并 + 时间衰减 TOP-K），跨轮复用。
 *
 * 与 backgroundTasks / debt-manager 的分工：
 * - 本队列只负责"检索预取"，不阻塞主对话轮（enqueue 立即返回，工作线程执行）。
 * - 服务自身不持有插件生命周期引用，dispose() 供网关关闭时等待在途任务。
 */

import { prefetchQuerySimilarity } from '../assemble/retrieval-prefetch.js';

interface PrefetchJob {
  sessionKey: string;
  query: string;
  run: () => Promise<void>;
  queuedAt: number;
}

function slotLimit(): number {
  const raw = process.env.LCMG_PREFETCH_CONCURRENCY;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= 8) return Math.floor(n);
  }
  const ollama = process.env.OLLAMA_MAX_CONCURRENCY ? Number(process.env.OLLAMA_MAX_CONCURRENCY) : 2;
  // 预取是后台乐观加速，最多给 2 个并发即可；无论如何不突破 Ollama 并发，避免争抢
  return Math.max(1, Math.min(2, Number.isFinite(ollama) ? ollama : 2));
}

/** coalesce 查询相似度阈值（与 assemble 消费侧缓存可用判定一致） */
const MERGE_SIMILARITY = 0.3;

class RetrievalPrefetchQueue {
  private pending: PrefetchJob[] = [];
  private runningJobs: PrefetchJob[] = [];
  private working = 0;
  private readonly limit = slotLimit();
  private closed = false;

  get pendingCount(): number {
    return this.pending.length + this.runningJobs.length;
  }

  get pendingNames(): string[] {
    return [...this.pending, ...this.runningJobs].map((j) => j.sessionKey.slice(0, 16));
  }

  /**
   * 入队。返回状态：
   *   'queued'   真正入队，稍后由工作线程执行
   *   'merged'   同会话相似查询已在队/在跑，未重复入队，仅刷新意图
   * 若队列已关闭（dispose 后），退化为直接执行 run（不丢失本次预取）。
   */
  enqueue(job: { sessionKey: string; query: string; run: () => Promise<void> }): 'queued' | 'merged' | 'direct' {
    if (this.closed || this.limit <= 0) {
      job.run().catch(() => {});
      return 'direct';
    }
    // 与在队/在跑任务做查询级 coalesce
    for (const j of [...this.pending, ...this.runningJobs]) {
      if (j.sessionKey === job.sessionKey && prefetchQuerySimilarity(j.query, job.query) >= MERGE_SIMILARITY) {
        j.query = job.query; // 以最新意图为准，不重复检索
        return 'merged';
      }
    }
    this.pending.push({ ...job, queuedAt: Date.now() });
    this.drain();
    return 'queued';
  }

  private drain(): void {
    while (!this.closed && this.working < this.limit && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.working++;
      this.runningJobs.push(job);
      job
        .run()
        .catch(() => {})
        .finally(() => {
          const i = this.runningJobs.indexOf(job);
          if (i >= 0) this.runningJobs.splice(i, 1);
          this.working--;
          this.drain();
        });
    }
  }

  /** 网关关闭时调用：等待在途任务（带超时，不卡死） */
  async dispose(timeoutMs: number = 5000): Promise<void> {
    this.closed = true;
    const snapshot = [...this.pending, ...this.runningJobs];
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          const poll = () => {
            if (this.pending.length === 0 && this.runningJobs.length === 0) resolve();
            else setTimeout(poll, 20);
          };
          setTimeout(poll, 20);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {
      /* non-fatal */
    }
    return void snapshot;
  }

  /** 测试用：重置 */
  reset(): void {
    this.pending = [];
    this.runningJobs = [];
    this.working = 0;
    this.closed = false;
  }
}

/** 全局单例（进程内共享） */
export const retrievalPrefetchQueue = new RetrievalPrefetchQueue();
export { RetrievalPrefetchQueue };