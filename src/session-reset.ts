/**
 * 会话重置（/new、程序化 reset）时的会话级状态失效。
 *
 * SDK 2026.8.1 时序：
 * - host 在 reset 时触发插件 typed hook `before_reset`（ctx 携带旧会话
 *   sessionId 与不变的 sessionKey）——这是 /new 场景唯一可靠的通知点。
 * - host 仅在 `hadSessionFile=true`（会话已有转录历史）时才调用引擎的
 *   `bootstrap()`；/new 产生的新会话没有转录文件，bootstrap 被跳过，
 *   因此清理不能只依赖 bootstrap。
 *
 * 本函数被两处调用：before_reset 钩子（/new 主路径）与 bootstrap finally
 * （带历史文件的会话启动路径，兜底）。
 *
 * 独立模块（不引入 openclaw SDK 依赖），便于单测直接导入验证。
 */
import { invalidateConvIdCache } from './lcm-bridge.js';

export interface ResetLog {
  info?: (msg: string, ctx?: unknown) => void;
  debug?: (msg: string, ctx?: unknown) => void;
  warn?: (msg: string, ctx?: unknown) => void;
}

export async function invalidateSessionStateForReset(
  sessionKey: string,
  prevSessionId: string,
  log?: ResetLog,
  /** durable-turn 幂等记录（key = `${sessionId}|${turnId}`），由 index.ts 模块级持有 */
  committedTurnKeys?: Set<string>,
): Promise<void> {
  // BUG-AUDIT: 会话级缓存一律按 sessionId 隔离；清理也必须用 sessionId，
  // 不能退化为 sessionKey（/new 时 sessionKey 不变，按其清除会清错桶/漏清目标桶）。
  const sk = sessionKey || prevSessionId;
  try {
    // 1. 失效 conversation_id 缓存（10min TTL，不主动清除会导致 uncomp 统计错误）
    invalidateConvIdCache(sk, prevSessionId);

    // 2. 清除会话级缓存（overhead / dedup / goal / tool-guidance，均按 sessionKey 键控）
    try {
      const { clearOverheadCache } = await import('./plugin/overhead-cache.js');
      clearOverheadCache(sk);
    } catch { /* non-fatal */ }
    try {
      const { clearSessionDedup } = await import('./plugin/dedup-cache.js');
      clearSessionDedup(sk);
    } catch { /* non-fatal */ }
    try {
      const { clearGoalCache } = await import('./plugin/goal-cache.js');
      clearGoalCache(sk);
    } catch { /* non-fatal */ }
    try {
      const { clearSessionToolTracker } = await import('./plugin/tool-guidance.js');
      clearSessionToolTracker(sk);
    } catch { /* non-fatal */ }
    // durable-turn：按 sessionId 清空已提交逻辑轮幂等记录，防止 /new 后跨会话去重误判
    if (committedTurnKeys) {
      try {
        const _prefix = `${prevSessionId}|`;
        for (const k of Array.from(committedTurnKeys)) {
          if (typeof k === 'string' && k.startsWith(_prefix)) committedTurnKeys.delete(k);
        }
      } catch { /* non-fatal */ }
    }

    // 3. 清除 MoA 缓存（防止上一轮 MoA 结果被误用）
    try {
      const { getMoaResultCache } = await import('./moa/orchestrator.js');
      getMoaResultCache(); // 读取并清空
    } catch { /* non-fatal */ }

    log?.info?.('[lcm-graph-extra] session state invalidated for reset', { sessionKey: sk, prevSessionId });
  } catch { /* non-fatal */ }
}
