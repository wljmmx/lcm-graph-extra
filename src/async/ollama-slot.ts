/**
 * 全局 Ollama 并发调度器 —— 限制本地 Ollama 的 LLM / embedding 并发。
 *
 * 背景：插件内部的 LLM 调用（rerank / judge / validate / distill / compact 摘要）
 * 与 embedding 调用（assembler vec、graph 实体向量、afterTurn 预取）都打到
 * 同一台本地 Ollama。Ollama 按模型串行/受限并行推理，自建批量并发（蒸馏 3、
 * graph 实体 embed 8、多次 force compact 叠加）会瞬时打爆服务端，返回 503。
 *
 * 本次改造（模型粒度互斥）：
 * 在单卡（或显存受限）机器上，主对话模型（如 qwen3.6:27b）与蒸馏 / rerank /
 * embedding 往往不是同一个模型。Ollama 同时只能驻留一个模型，若不同模型的请求
 * 并发执行，会被反复换出/换入（互相踢掉），导致"正在处理的数据中断"、模型重新
 * 加载、首次延迟飙升。
 *
 * 设计：
 * - 同一时刻只允许【一个模型】在执行（currentModel），不同模型严格串行 → 绝对
 *   避免互踢（中断/重载）。
 * - 同一模型的请求可并行，但不超过并发上限（OLLAMA_MAX_CONCURRENCY，默认 2，可调）。
 * - 仅对本机/内网 Ollama 端点生效；远程 API 不排队（网络并发由服务端自控）。
 * - FIFO 队列：请求按到达顺序调度，队头优先，公平。
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

function normBaseURL(baseURL: string | undefined | null): string {
  if (!baseURL) return '';
  return baseURL.replace(/\/+$/, '').toLowerCase();
}

export class OllamaSlotPool {
  /** 同一模型的最大并发数（不同模型被强制串行，不受此值影响） */
  private capacity = resolveMaxConcurrency();
  /** 当前正在执行请求的模型（null = 空闲）。同一时刻仅一个模型可执行。 */
  private currentModel: string | null = null;
  /** currentModel 当前在跑的并发请求数（同模型可并行，上限 capacity） */
  private active = 0;
  /** 等待者队列（FIFO，队头优先） */
  private waiters: Array<{ key: string; resolve: () => void }> = [];

  /** 是否为受控的本机/内网 Ollama 端点（LLM/embed 都走此判定） */
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

  /** 归一化槽键：优先模型名（区分互踢目标）；无模型信息时退化为 baseURL（如 embed） */
  private keyOf(baseURL: string | undefined | null, model?: string | null): string {
    const m = model && String(model).trim();
    return m && m.length > 0 ? m.toLowerCase() : normBaseURL(baseURL);
  }

  /**
   * 唤醒一个可立即执行的请求：
   *  - 空闲 → 取队头作为当前模型（串行/模型切换）
   *  - 当前模型有容量 → 唤醒一个同模型等待者（保持同模型并发）
   */
  private dispatch(): void {
    if (this.currentModel === null) {
      if (this.waiters.length > 0) {
        const w = this.waiters.shift()!;
        this.currentModel = w.key;
        this.active = 1;
        w.resolve();
      }
      return;
    }
    if (this.active < this.capacity) {
      const idx = this.waiters.findIndex((w) => w.key === this.currentModel);
      if (idx >= 0) {
        const w = this.waiters.splice(idx, 1)[0];
        this.active++;
        w.resolve();
      }
    }
  }

  /**
   * 在 slot 内执行 fn。仅对 Ollama 端点限流/调度；非 Ollama 端点原样直连。
   * 排队等待时不限时（调用方自己的 AbortSignal 超时依然作用于 fn 内部请求）。
   *
   * @param baseURL Ollama 端点地址
   * @param model   模型名（用于按模型互斥；embed 等无模型名时传 null 退化用 baseURL）
   * @param fn      需串行/限流包裹的实际请求
   */
  async withSlot<T>(baseURL: string | undefined | null, model: string | null | undefined, fn: () => Promise<T>): Promise<T> {
    if (!this.isOllamaEndpoint(baseURL)) return fn();
    const key = this.keyOf(baseURL, model);

    // 同步快路径：空闲，或同模型且未满
    if (this.currentModel === null) {
      this.currentModel = key;
      this.active = 1;
    } else if (this.currentModel === key && this.active < this.capacity) {
      this.active++;
    } else {
      // 不同模型（须串行避免互踢）或同模型并发已满 → 排队等待
      await new Promise<void>((resolve) => {
        this.waiters.push({ key, resolve });
        this.dispatch();
      });
    }

    try {
      return await fn();
    } finally {
      this.active--;
      if (this.active <= 0) {
        this.currentModel = null;
        this.active = 0;
      }
      this.dispatch();
    }
  }
}

/** 全局单例（进程内共享，LLM 与 embedding 共用） */
export const ollamaSlot = new OllamaSlotPool();

/** 便捷出口：在 Ollama slot 内执行 fn（非 Ollama 端点直接执行） */
export async function withOllamaSlot<T>(
  baseURL: string | undefined | null,
  model: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return ollamaSlot.withSlot(baseURL, model, fn);
}