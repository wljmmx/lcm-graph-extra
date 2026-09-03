/**
 * 全局期限兜底（SDK 2026.8.1 防挂起契约）。
 *
 * host 对引擎的 assemble / afterTurn 不设超时、不传 abortSignal（契约里只有
 * compact / maintain 携带 abortSignal）。引擎任何子调用挂起都会拖挂 run 管道，
 * 导致 executeLocalTurn 的 finally（释放 turn claim）永不执行，session 卡死
 * （"already has an active turn claim"）。本助手为引擎入口提供自限兜底。
 */

export type DeadlineOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'deadline' };

/**
 * 与 work 竞速一个期限 Promise。
 *
 * - work 先完成 → `{ status: 'fulfilled', value }`
 * - 期限先到 → `{ status: 'deadline' }`（work 继续在后台运行，其迟到 rejection
 *   已被预吞，不会产生 unhandledRejection）
 * - work 抛错 → 异常原样上抛（真实错误不应被期限机制掩盖）
 */
export async function raceDeadline<T>(
  work: Promise<T> | (() => Promise<T> | T),
  ms: number,
  label: string,
): Promise<DeadlineOutcome<T>> {
  const workP = typeof work === 'function' ? Promise.resolve(work()) : Promise.resolve(work);
  workP.catch(() => {}); // 期限胜出后 work 迟到 reject 时不产生 unhandledRejection

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineP = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), ms);
  });

  try {
    const winner = await Promise.race([workP.then((value) => ({ kind: 'value' as const, value })), deadlineP.then(() => ({ kind: 'deadline' as const }))]);
    if (winner.kind === 'deadline') {
      // 标记供日志识别（不抛错；调用方决定降级策略）
      void label;
      return { status: 'deadline' };
    }
    return { status: 'fulfilled', value: winner.value };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
