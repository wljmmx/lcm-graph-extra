/**
 * 会话级缓存 key 解析（Goal Anchoring / Overhead / Dedup / Tool-guidance 共用）。
 *
 * 背景（BUG-AUDIT 2026-08-21）：
 *   - OpenClaw 的 `sessionKey` 是稳定路由桶（如 `agent:main:qq:group:<id>`），
 *     QQ bot 同群/好友在 `/new` 后**保持不变**；
 *   - `sessionId` 是当前会话标识，`/new`、idle 过期、每日重置都会生成**新值**。
 *
 * 因此会话级内存缓存的 key 必须**优先 sessionId**，否则 `/new` 后新会话会
 * 读到上一会话残留的 goal / overhead / dedup / 工具追踪，导致"新对话按旧继续"。
 *
 * 命中 sessionId 后，重置天然隔离（新会话 → 新 key → 无碰撞；旧条目靠 LRU/TTL
 * 淘汰），不再依赖 bootstrap 的 finally 清理——这正是原来 hadSessionFile gate
 * 导致清理被跳过的根因修复。
 */
export interface SessionCacheKeyParams {
  sessionId?: unknown;
  sessionKey?: unknown;
  session_id?: unknown;
  conversationId?: unknown;
}

export function resolveSessionCacheKey(params: SessionCacheKeyParams): string {
  if (params.sessionId != null && String(params.sessionId).trim() !== '') {
    return String(params.sessionId);
  }
  if (typeof params.sessionKey === 'string' && params.sessionKey.trim() !== '') {
    return params.sessionKey;
  }
  if (typeof params.session_id === 'string' && params.session_id.trim() !== '') {
    return params.session_id;
  }
  // 极端回退：conversationId / 兜底空串（调用方各自处理空 key）
  if (typeof params.conversationId === 'string' && params.conversationId.trim() !== '') {
    return params.conversationId;
  }
  return '';
}

/**
 * 判断某个会话是否应参与在线学习（关联矩阵 M 的 processFeedback）。
 * 定时任务（cron）、心跳、系统级会话不应喂入反馈闭环，否则会用无真实用户意图的
 * 批量召回污染 M 矩阵（学到垃圾关联）。仅真实用户对话参与学习。
 *
 * 迁移自 after-turn/index.ts（原为局部导出），供采集端（afterTurn O7 onGraph）
 * 与消费端（afterTurn feedback loop）及 assemble 后台补水共用，避免循环依赖。
 */
export function isLearningEligibleSession(sessionKey: string): boolean {
  if (!sessionKey) return false;
  if (
    sessionKey.includes(':cron:') ||
    sessionKey.includes('agent:main:cron') ||
    /heartbeat/i.test(sessionKey) ||
    /(^|:)system($|:)/i.test(sessionKey) ||
    /(^|:)auto($|:)/i.test(sessionKey)
  ) {
    return false;
  }
  return true;
}