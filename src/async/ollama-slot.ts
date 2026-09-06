/**
 * 全局 Ollama 并发信号量 —— 限制本地 Ollama 的 LLM / embedding 并发请求数。
 *
 * 背景：插件内部的 LLM 调用（rerank / judge / validate / distill / compact 摘要）
 * 与 embedding 调用（assembler vec、graph 实体向量、afterTurn 预取）都打到
 * 同一台本地 Ollama。Ollama 按模型串行/受限并行推理，自建批量并发（蒸馏 3、
 * graph 实体 embed 8、多次 force compact 叠加）会瞬时打爆服务端，返回 503。
 *
 * 设计：
 * - 默认并发上限 2（LLM 与 embedding 共用同一队列，2 足够在不卡死的前提下
 *   提高吞吐）；可用环境变量 OLLAMA_MAX_CONCURRENCY 覆盖。
 * - 仅对本机 Ollama 端点（127.0.0.1 / localhost / 内网 10.x / 192.168.x / .local）
 *   生效；远程 API 不排队（网络并发由服务端自控）。
 * - FIFO 队列：请求按到达顺序获得 slot，公平。
 */

const DEFAULT_MAX_CONCURRENCY = 2;

function resolveMaxConcurrency(): number {
  const raw = process.env.OLLAMA_MAX_CONCURRENCY;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= 32) return Math.floor(n);
  }
  return DEFAULT_MAX_CONCURRENCY;
}

class OllamaSlotPool {
  private capacity = resolveMaxConcurrency();
  private active = 0;
  private queue: Array<(value: void | PromiseLike<void>) => void> = [];

  /** 是否为受控的本机 Ollama 端点（LLM/embed 都走此判定） */
  isOllamaEndpoint(baseURL: string | undefined | null): boolean {
    if (!baseURL) return false;
    const clean = baseURL.replace(/\/+$/, '').toLowerCase();
    if (
      clean.includes('127.0.0.1') ||
      clean.includes('localhost') ||
      clean.includes('0.0.0.0') ||
      clean.includes('.local')
    ) return true;
    const m = clean.match(/https?:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
    }
    return false;
  }

  private release(): void {
    this.active--;
    if (this.queue.length > 0 && this.active < this.capacity) {
      const next = this.queue.shift();
      next?.();
    }
  }

  /**
   * 在 slot 内执行 fn。仅对 Ollama 端点限流；非 Ollama 端点原样直连。
   * 排队等待时不限时（调用方自己的 AbortSignal 超时依然作用于 fn 内部请求）。
   */
  async withSlot<T>(baseURL: string | undefined | null, fn: () => Promise<T>): Promise<T> {
    if (!this.isOllamaEndpoint(baseURL)) return fn();
    if (this.active < this.capacity) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
      this.active++;
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** 全局单例（进程内共享，LLM 与 embedding 共用） */
export const ollamaSlot = new OllamaSlotPool();

/** 便捷出口：在 Ollama slot 内执行 fn（非 Ollama 端点直接执行） */
export async function withOllamaSlot<T>(
  baseURL: string | undefined | null,
  fn: () => Promise<T>,
): Promise<T> {
  return ollamaSlot.withSlot(baseURL, fn);
}