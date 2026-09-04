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
  // FIX-SK4: 双 key 清理（sessionKey + prevSessionId 各清一遍）。
  // 写入侧（assemble/after-turn）经 resolveSessionCacheKey 取 key：sessionId 优先，
  // host 未传 sessionId 时回退 sessionKey —— 因此条目可能落在任一桶。
  // 修复前仅清 `sessionKey || prevSessionId` 单桶 → host 传 sessionId 时清理恒为
  // no-op，/new 后旧会话的 goal/overhead/dedup/tracker/SAD 残留到 TTL/LRU 淘汰。
  const sks = [...new Set(
    [sessionKey, prevSessionId].filter((k) => typeof k === 'string' && k.trim() !== '')
  )];
  /** 对每个候选 key 执行一次清理，逐 key 记录失败（non-fatal） */
  const clearEach = (name: string, fn: (k: string) => void): void => {
    for (const k of sks) {
      try { fn(k); } catch (e) {
        log?.debug?.(`[session-reset] ${name} failed (non-fatal)`, { key: k, err: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  try {
    // 1. 失效 conversation_id 缓存（10min TTL，不主动清除会导致 uncomp 统计错误）
    for (const k of sks) invalidateConvIdCache(k, prevSessionId);
    // FIX-SK3 遗留清理：旧版把 sessionId 值当 sessionKey 传入，convIdCache 可能
    // 残留 `sk:<sessionId值>` 污染条目；按双前缀再删一次（幂等，no-op 无害）。
    if (prevSessionId) invalidateConvIdCache(prevSessionId, prevSessionId);

    // 2. 清除会话级缓存（写入侧均经 resolveSessionCacheKey，双 key 覆盖）
    {
      const { clearOverheadCache } = await import('./plugin/overhead-cache.js');
      clearEach('clearOverheadCache', clearOverheadCache);
    }
    {
      const { clearSessionDedup } = await import('./plugin/dedup-cache.js');
      clearEach('clearSessionDedup', clearSessionDedup);
    }
    {
      const { clearGoalCache } = await import('./plugin/goal-cache.js');
      clearEach('clearGoalCache', clearGoalCache);
    }
    {
      const { clearSessionToolTracker } = await import('./plugin/tool-guidance.js');
      clearEach('clearSessionToolTracker', clearSessionToolTracker);
    }
    {
      // 工具结果异步压缩缓存清理（防止 /new 后旧轮工具结果被误替换）
      const { clearCompressedToolResults } = await import('./after-turn/tool-result-compressor.js');
      clearEach('clearCompressedToolResults', clearCompressedToolResults);
    }
    {
      // SAD 反馈循环权重缓存清理（防止 /new 后旧权重污染新会话推荐）
      const { clearSadWeights } = await import('./plugin/sad-feedback.js');
      clearEach('clearSadWeights', clearSadWeights);
    }
    {
      // G-MODEL-SYNC: 清理该会话的主模型快照与远程标记，
      // /new 后由下一轮 recordRuntimeLlm 重新记录
      const { clearSessionLlmState } = await import('./plugin/distillation.js');
      clearEach('clearSessionLlmState', clearSessionLlmState);
    }
    // durable-turn：按 sessionId 清空已提交逻辑轮幂等记录，防止 /new 后跨会话去重误判
    if (committedTurnKeys) {
      try {
        const _prefix = `${prevSessionId}|`;
        for (const k of Array.from(committedTurnKeys)) {
          if (typeof k === 'string' && k.startsWith(_prefix)) committedTurnKeys.delete(k);
        }
      } catch (e) { log?.debug?.('[session-reset] committedTurnKeys cleanup failed (non-fatal)', { err: e instanceof Error ? e.message : String(e) }); }
    }

    // 3. 清除 MoA 缓存（防止上一轮 MoA 结果被误用）
    {
      const { getMoaResultCache, clearMoaRefCacheBySession } = await import('./moa/orchestrator.js');
      getMoaResultCache(); // 读取并清空一次性结果缓存
      clearEach('clearMoaRefCacheBySession', clearMoaRefCacheBySession);
    }

    // 4. 清除 index.ts 模块级 per-session Map（lastAssembleExpIds / warmup）
    //    防止 /new 后旧会话的经验追踪和预热数据污染新会话
    {
      const mod = await import('./index.js');
      clearEach('clearLastAssembleExpIdsBySession', (k) => mod.clearLastAssembleExpIdsBySession?.(k));
      clearEach('clearSessionWarmupCache', (k) => mod.clearSessionWarmupCache?.(k));
    }

    log?.info?.('[lcm-graph-extra] session state invalidated for reset', { sessionKeys: sks, prevSessionId });
  } catch (e) { log?.warn?.('[session-reset] session state invalidation failed (non-fatal)', { sessionKeys: sks, prevSessionId, err: e instanceof Error ? e.message : String(e) }); }
}
