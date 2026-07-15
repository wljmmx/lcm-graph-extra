/**
 * 会话级目标缓存（Goal Anchoring）。
 *
 * 解决长对话中 LLM 注意力漂移问题：
 * - 提取首轮用户消息作为"目标任务"
 * - 每轮 assemble 将目标注入 system prompt，提醒 LLM 不要偏离
 * - 压缩/摘要时保留原始目标，防止丢失
 *
 * 缓存策略：LRU + TTL，与 tool-guidance 的 trackerCache 保持一致。
 */

/** 目标缓存条目 */
interface GoalEntry {
  /** 用户原始目标（截断到 300 字符，防止过长） */
  goal: string;
  /** 首轮消息时间戳 */
  createdAt: number;
  /** 最后访问时间（用于 TTL 淘汰） */
  lastAccess: number;
}

const goalCache = new Map<string, GoalEntry>();
const GOAL_MAX_SESSIONS = 500;
const GOAL_TTL_MS = 4 * 60 * 60 * 1000; // 4h
const GOAL_MAX_LENGTH = 300; // 截断到 300 字符，防止注入过长

/**
 * 从消息列表中提取首轮用户消息。
 * 返回截断后的文本，空字符串表示未找到。
 */
export function extractFirstUserGoal(messages: any[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  for (const msg of messages) {
    if (msg?.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ')
        : '';
    if (content.trim()) {
      return content.length > GOAL_MAX_LENGTH
        ? content.slice(0, GOAL_MAX_LENGTH) + '…'
        : content;
    }
  }
  return '';
}

/**
 * 缓存会话目标。
 * 调用时机：首轮 assemble 时（round 1）。
 */
export function cacheGoal(sessionKey: string, goal: string): void {
  if (!sessionKey || !goal) return;

  // LRU 清理
  if (goalCache.size >= GOAL_MAX_SESSIONS) {
    const oldest = goalCache.keys().next().value;
    if (oldest !== undefined) goalCache.delete(oldest);
  }

  const now = Date.now();
  goalCache.set(sessionKey, { goal, createdAt: now, lastAccess: now });

  // TTL 清理
  for (const [key, entry] of goalCache) {
    if (now - entry.lastAccess > GOAL_TTL_MS) {
      goalCache.delete(key);
    }
  }
}

/**
 * 读取会话目标。
 * 返回目标文本，空字符串表示未缓存或已过期。
 */
export function getGoal(sessionKey: string): string {
  if (!sessionKey) return '';

  const entry = goalCache.get(sessionKey);
  if (!entry) return '';

  const now = Date.now();
  if (now - entry.lastAccess > GOAL_TTL_MS) {
    goalCache.delete(sessionKey);
    return '';
  }

  entry.lastAccess = now;
  return entry.goal;
}

/**
 * 构建目标锚定提示词。
 * 注入到 system prompt 顶部，提醒 LLM 不要偏离原始任务。
 */
export function buildGoalAnchor(goal: string): string {
  if (!goal) return '';
  return `\n## 目标任务提醒\n你正在处理用户的任务：「${goal}」\n请始终以此任务为核心，不要偏离到无关话题。如果之前的探索已经偏离了方向，请回到这个任务上来。`;
}

/** 供 heartbeat 清理过期缓存的公开入口 */
export function evictStaleGoalCache(): void {
  const now = Date.now();
  for (const [key, entry] of goalCache) {
    if (now - entry.lastAccess > GOAL_TTL_MS) {
      goalCache.delete(key);
    }
  }
}