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
  /** v2.7.0 G-U: 目标切换次数，>0 表示发生过切换，用于防漂移锚点 */
  switchCount: number;
  /** v2.7.0 G-U: 上一个目标（切换前），用于防漂移提醒 */
  previousGoal: string;
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
  const existing = goalCache.get(sessionKey);

  // v2.7.0 G-U: 检测目标切换，递增 switchCount 并记录旧目标
  const previousGoal = existing?.goal ?? '';
  const switched = existing && existing.goal !== goal;
  const switchCount = switched ? (existing.switchCount ?? 0) + 1 : (existing?.switchCount ?? 0);

  goalCache.set(sessionKey, {
    goal,
    freeTags: extractFreeTags(goal),
    createdAt: existing?.createdAt ?? now,
    lastAccess: now,
    switchCount,
    previousGoal: switched ? existing.goal : (existing?.previousGoal ?? ''),
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
 * v2.7.1 T-S: 爆破中英混排，把粘连的中文与"结构化命名"（插件名/文件名/命令名）拆开。
 *
 * 原 extractFreeTags 仅按标点/空格切词，导致 "graph-memory-pro最新参数配置建议"
 * 被当成一个整 token，无法把目标实体（graph-memory-pro）从措辞里独立出来。
 * 这里在中文字符与相邻拉丁/数字字符之间插入空格，使结构化命名成为独立 token。
 *
 * @example splitHybrid('请根据graph-memory-pro最新参数配置建议')
 *   → ['请根据', 'graph-memory-pro', '最新参数配置建议']
 */
function splitHybrid(text: string): string[] {
  const spaced = text
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2');
  return spaced.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * v2.7.1 T-S: 提取目标实体（任务的强语义载体）。
 *
 * 目标实体 = 结构化命名 token（含 `-`/`.`/`_`/`/`，或纯字母数字长度>=4 且非纯数字），
 * 例如插件名 graph-memory-pro、lcm-graph-extra，文件名 openclaw.json，命令名 pagerankIterations。
 * 这些是"目标名词"最可靠的载体，用于区分"换了个新目标"和"同一目标换个措辞"。
 */
export function extractTaskEntities(text: string): string[] {
  if (!text) return [];
  const entities = new Set<string>();
  for (const t of splitHybrid(text)) {
    const lower = t.toLowerCase();
    if (!lower) continue;
    const isStructural = /[._\-/]/.test(lower);
    const isNameLike = /^[a-z0-9]{4,}$/.test(lower) && !/^\d+$/.test(lower);
    if (isStructural || isNameLike) {
      entities.add(lower);
    }
  }
  return [...entities];
}

/**
 * v2.7.1 T-S: 判断是否发生了"目标实体替换"（真正的任务切换）。
 *
 * 相比信号评分模型（把高措辞相似度当作"续问"），这里用目标实体做强信号：
 * 当新目标引入了旧目标没有的实体，且旧目标也有被换掉的实体（替换而非补充），
 * 即便措辞高度相似（模板化续问句式），也判定为切换到了新任务。
 *
 * 规则：
 * - 无实体信息（任一侧为空）→ 无法判断，返回 false，交由信号评分模型处理。
 * - 目标实体被"替换"（新有且旧无 + 旧有且新无）→ 判定为切换。
 * - 仅新增实体（如补充另一个文件）→ 不强制切换，避免误把"同一任务补充"当新任务。
 */
export function hasTaskTargetSwitch(oldGoal: string, newGoal: string): boolean {
  const oldEntities = extractTaskEntities(oldGoal);
  const newEntities = extractTaskEntities(newGoal);
  if (oldEntities.length === 0 || newEntities.length === 0) return false;

  const oldSet = new Set(oldEntities);
  const newSet = new Set(newEntities);
  const newOnly = newEntities.filter((e) => !oldSet.has(e));
  const oldOnly = oldEntities.filter((e) => !newSet.has(e));

  // 替换：新目标引入了旧目标没有的实体，且旧目标也有被换掉的实体
  return newOnly.length >= 1 && oldOnly.length >= 1;
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

  // v2.7.1 T-S: 目标实体强切换 —— 新目标替换了旧目标的结构化目标实体（插件名/文件名/命令名）。
  // 即便措辞高度相似（模板化续问句式），只要目标实体被替换，就判为切换到新任务，
  // 从而避免"旧目标锚点继续把 LLM 钉在上一个任务"。
  if (hasTaskTargetSwitch(entry.goal, newGoal)) {
    return true;
  }

  const trimmed = newGoal.trim();
  // v2.7.2 G-U-FIX: 完全相同的目标文本 -> 直接判定为同一话题，不切换。
  // 修复误报风暴：同一长任务消息被重复判为 goal switch（93 次/会话），
  // 导致 compaction debt 反复写入、上下文被无谓压缩。
  if (entry.goal === trimmed) return false;

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
  // v2.7.2 G-U-FIX: 疑问词仅在低/零重叠（真正的新话题）时才作为强信号加分。
  // 高重叠时疑问词多是同话题追问（"怎么优化？"），不应触发切换。
  if ((hasQuestionMark || hasInterrogative) && trimmed.length >= 6 && similarity <= 0.6) score += 3;

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
 *
 * v2.7.0 G-U: 当 switchCount > 0 时使用防漂移锚点，明确告知 LLM 旧目标已归档、
 * 不得回退。用户无感知，纯 system prompt 层面强化。
 *
 * @param goal 当前目标
 * @param switched 是否发生过目标切换（用于选择锚点强度）
 * @param previousGoal 上一个目标（切换场景下用于明确告知）
 */
export function buildGoalAnchor(goal: string, switched?: boolean, previousGoal?: string): string {
  if (!goal) return '';

  // v2.7.0 G-U: 防漂移锚点 —— 目标切换后使用，防止 LLM 回到旧任务
  if (switched && previousGoal) {
    return `\n## 任务切换提醒
你已从旧任务「${previousGoal}」切换到新任务。
当前任务：「${goal}」
重要：旧任务已完成或归档。上下文中可能残留旧任务的摘要或引用，这些仅供历史参考，不得作为当前任务目标。
请严格聚焦于当前任务，忽略任何与「${goal}」无关的上下文暗示。如果出现旧任务相关的内容，不要回到旧任务上。`;
  }

  // 首次切换或温和锚点（无 previousGoal 时）
  if (switched) {
    return `\n## 任务切换提醒
当前任务已更新为：「${goal}」
之前的任务已完成或归档。请聚焦当前任务，不要回到之前的任务。`;
  }

  // 默认温和锚点（无切换）
  return `\n## 目标任务提醒
你正在处理用户的任务：「${goal}」
请始终以此任务为核心，不要偏离到无关话题。如果之前的探索已经偏离了方向，请回到这个任务上来。`;
}

/**
 * v2.7.0 G-U: 获取目标切换次数。
 * >0 表示发生过切换，调用方应用防漂移锚点。
 */
export function getGoalSwitchCount(sessionKey: string): number {
  if (!sessionKey) return 0;
  const entry = goalCache.get(sessionKey);
  if (!entry) return 0;
  return entry.switchCount ?? 0;
}

/**
 * v2.7.0 G-U: 获取上一个目标。
 * 返回空字符串表示未切换过。
 */
export function getPreviousGoal(sessionKey: string): string {
  if (!sessionKey) return '';
  const entry = goalCache.get(sessionKey);
  if (!entry) return '';
  return entry.previousGoal ?? '';
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