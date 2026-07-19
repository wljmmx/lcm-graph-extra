/**
 * 会话级目标缓存（Goal Anchoring）。
 *
 * 解决长对话中 LLM 注意力漂移问题：
 * - 跟踪最新用户意图作为"目标任务"
 * - 每轮 assemble 将目标注入 system prompt，提醒 LLM 不要偏离
 * - 压缩/摘要时保留原始目标，防止丢失
 * - 复用 context-inference 的 extractFreeTags 做相似度计算
 *
 * 缓存策略：LRU + TTL，与 tool-guidance 的 trackerCache 保持一致。
 */

import { extractFreeTags } from '../context-inference.js';

/** 目标缓存条目 */
interface GoalEntry {
  /** 用户原始目标（截断到 300 字符，防止过长） */
  goal: string;
  /** 目标的关键词标签（缓存，避免每次 shouldUpdateGoal 重复提取） */
  freeTags: string[];
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
 * 从消息列表中提取最后一轮用户消息。
 * 用于跟踪最新用户意图，在 Goal Anchoring 中更新缓存。
 * 返回截断后的文本，空字符串表示未找到。
 */
export function extractLatestUserGoal(messages: any[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
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
  goalCache.set(sessionKey, {
    goal,
    freeTags: extractFreeTags(goal),
    createdAt: now,
    lastAccess: now,
  });

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
 * 判断新消息是否应该更新目标缓存。
 *
 * 设计原则：信号评分模型，多因子独立打分后阈值判定。
 * 每个信号独立贡献分数，不互相阻塞，避免顺序短路模型的硬阈值缺陷。
 *
 * 负面信号（续问特征）:
 *   - 极短消息(<5字)        → -3
 *   - 引用前文               → -2
 *   - 续问句式匹配           → -3
 *   - 关键词高重叠(>0.6)    → -2
 *
 * 正面信号（新问题特征）:
 *   - 疑问词/问号 + ≥6字    → +3
 *   - 关键词零重叠           → +2
 *   - 关键词低重叠(<0.4)     → +1
 *   - 长消息(>50字)          → +1
 *   - 消息≥12字             → +1
 *
 * 判定: 分 > 0 → 更新，分 ≤ 0 → 不更新
 *
 * @param newGoal 最新用户消息
 * @param sessionKey 会话标识，用于获取缓存的 freeTags
 */
export function shouldUpdateGoal(newGoal: string, sessionKey: string): boolean {
  if (!newGoal) return false;

  const entry = goalCache.get(sessionKey);
  if (!entry) return true; // 无现有目标，首次缓存

  const trimmed = newGoal.trim();
  let score = 0;

  // ── 负面信号 ──

  // 极短消息（< 5 字）→ 确认/回复
  if (trimmed.length < 5) score -= 3;

  // 引用前文 → 续问
  if (/^(这个|上面|前面|之前|刚才|刚刚)(的|说的|那个|提到)?[。.！!]?/.test(trimmed)) score -= 2;

  // 续问句式匹配
  const FOLLOWUP_PATTERNS = [
    /^(好的?|ok|可以|行|嗯+|对|是[的]?|没错|正确|了解了?|明白了?)([。.！!]?)$/i,
    /^(继续|接着|然后|还有|下一步|go\s*on|next)([。.！!]?)$/i,
    /^(具体|详细|展开)(说说|讲讲|解释|说明|介绍|描述)[。.！!]?/,
    /^(能|可以|能否|可否)(详细|具体|再)?(说说|讲讲|解释|说明|介绍|描述)/,
    /^(为什么|怎么会|为啥|为何)[。.！!]?/,
    /^(没(有|啥|什么)|不懂|不(太|是|怎么)明白|不清楚|没看懂|没理解)[。.！!]?/,
    /^(再|多|补充)(说|讲|来|给)?(一些|一点|几个|些|点)[。.！!]?/,
    /^(例子|举例|比如|example|示例|演示)[。.！!]?/i,
    /^(翻译|translate|总结|summarize|概括|归纳|提炼)[。.！!]?/i,
    /^(然后呢|之后呢|还有呢|接下来呢|还有吗|还有别的吗)[。.！!]?/,
    /^(什么意思|怎么说|怎样的|什么样的)[。.！!]?/,
    /^(帮我)?(优化|改进|改善|修改|调整|重构)[一下]?(这个|代码|上面|之前)/,
    /^(请|麻烦|帮我)?(再|重新)?(说|解释|描述|说明|讲)[一遍|一下|一次]/,
  ];
  if (FOLLOWUP_PATTERNS.some((p) => p.test(trimmed))) score -= 3;

  // ── 关键词相似度（使用缓存的 freeTags，避免重复提取）──
  const tagsNew = extractFreeTags(trimmed);
  const tagsOld = new Set(entry.freeTags);
  const intersection = new Set(tagsNew.filter((t) => tagsOld.has(t)));
  const similarity = (tagsNew.length > 0 && entry.freeTags.length > 0)
    ? intersection.size / Math.min(tagsNew.length, entry.freeTags.length)
    : 0;
  const hasZeroOverlap = tagsNew.length > 0 && entry.freeTags.length > 0 && intersection.size === 0;

  if (similarity > 0.6) score -= 2;  // 高重叠 → 同一话题

  // ── 正面信号 ──

  // 疑问词/问号 + 非极短（≥6 字）
  const hasQuestionMark = /[?？]/.test(trimmed);
  const hasInterrogative = /(怎么|如何|什么|哪些|哪个|谁|为什么|是否|能不能|可不可以|可以吗|有没有|怎样|何时|多久|多大|多少)/.test(trimmed);
  if ((hasQuestionMark || hasInterrogative) && trimmed.length >= 6) score += 3;

  // 关键词零重叠 → 明确话题切换
  if (hasZeroOverlap) score += 2;

  // 关键词低重叠 → 弱话题切换信号
  if (similarity < 0.4 && similarity > 0) score += 1;

  // 长消息 → 弱新问题信号
  if (trimmed.length > 50) score += 1;

  // 非极短消息 → 弱信号
  if (trimmed.length >= 12) score += 1;

  // ── 判定 ──
  return score > 0;
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

/** 清除指定会话的目标缓存（/new 等会话重置场景） */
export function clearGoalCache(sessionKey: string): void {
  goalCache.delete(sessionKey);
}