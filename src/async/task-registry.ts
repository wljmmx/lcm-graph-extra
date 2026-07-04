/**
 * BackgroundTaskRegistry — 轻量级 fire-and-forget 任务追踪。
 *
 * 解决问题：heartbeat / afterTurn / dispose 中存在 10+ 处
 * `(async () => { ... })().catch(() => {})` 模式，无引用持有 Promise，
 * dispose 时无法等待在途任务，可能导致写入已关闭的 DB / 调用已 dispose 的 adapter。
 *
 * 设计原则：
 * - 单文件，零依赖
 * - 自动捕获错误（注册方无需 .catch）
 * - dispose 时 awaitAll(timeoutMs) 等待在途任务
 * - shuttingDown 后拒绝新任务（避免 dispose 后又起活）
 *
 * 不做的事：
 * - 不引入任务取消（AbortController 已在 compact 中使用）
 * - 不持久化任务状态
 */

interface TrackedTask {
  name: string;
  promise: Promise<void>;
  startedAt: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

class BackgroundTaskRegistry {
  private tasks = new Set<TrackedTask>();
  private shuttingDown = false;

  /**
   * 注册 fire-and-forget 任务。
   * 自动吞掉 rejection（避免 unhandledRejection），并追踪引用。
   * shuttingDown 后拒绝新任务（避免 dispose 后又起新活）。
   */
  register(name: string, promise: Promise<unknown>): void {
    if (this.shuttingDown) return;
    // 把任意 Promise 归一化为 Promise<void>，吞掉 rejection
    const normalized: Promise<void> = promise.then(
      () => {},
      (err) => {
        // 错误已捕获，调用方仍可通过 onUnhandled 钩子观察（如需）
        // 此处保持静默，与原 `.catch(() => {})` 语义一致
        void err;
      },
    );
    const tracked: TrackedTask = { name, promise: normalized, startedAt: Date.now() };
    this.tasks.add(tracked);
    // 完成后自动从 Set 移除，避免无界增长
    normalized.finally(() => this.tasks.delete(tracked));
  }

  /**
   * dispose 时调用：标记 shuttingDown，等待所有在途任务完成（带超时）。
   * 超时后强制返回，避免 dispose 卡死。
   */
  async awaitAll(timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.shuttingDown = true;
    if (this.tasks.size === 0) return;

    // 拷贝当前快照（awaitAll 期间完成的任务会自动从 this.tasks 移除，
    // 但 allSettled 接收的是数组快照，不受影响）
    const snapshot = [...this.tasks];
    await Promise.race([
      Promise.allSettled(snapshot.map((t) => t.promise)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** 当前在途任务数（用于诊断） */
  get pendingCount(): number {
    return this.tasks.size;
  }

  /** 当前在途任务名（用于诊断日志） */
  get pendingNames(): string[] {
    return [...this.tasks].map((t) => t.name);
  }

  /** 是否已进入关闭模式（测试/诊断用） */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** 重置（仅测试用） */
  reset(): void {
    this.tasks.clear();
    this.shuttingDown = false;
  }
}

export const backgroundTasks = new BackgroundTaskRegistry();
export { BackgroundTaskRegistry };
