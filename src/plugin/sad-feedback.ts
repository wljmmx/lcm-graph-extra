/**
 * SAD（Self-Adaptive Decay）反馈循环
 *
 * 设计理念（替代旧版 L4 纯疲劳衰减）：
 *   旧版 L4：连续 N 轮未用某工具 → 硬剔除，不再推荐。问题：
 *     - 二元决策，丢失渐变信号
 *     - 未区分"该工具不相关"与"该类别整体不需要"
 *     - 用了某工具不产生任何正向反馈，同类工具得不到加权
 *
 *   SAD：维护会话级 per-tool / per-category 连续权重（0..1，默认 0.5），
 *     - 工具被使用 → 增强该工具 + 同类工具的权重（正向反馈，同类更可能被推荐）
 *     - 工具被注入但未使用 → 降权该工具 + 同类（负向反馈，渐次淡出而非硬剔除）
 *     - 推荐时按"有效权重"排序与过滤（权重 < MIN_WEIGHT 才剔除）
 *
 * 与 L3（已用→不重复提示）的关系：
 *   L3 仍保留（避免对同一工具唠叨），但 SAD 权重影响"是否推荐同类其他工具"
 *   以及排序优先级。即 SAD 接管 L4 的"何时停止推荐"，L3 只管"不重复已用工具"。
 *
 * @module plugin/sad-feedback
 */

// ---------------------------------------------------------------------------
// 工具分类器（晚绑定，打破与 tool-guidance.ts 的循环依赖）
// ---------------------------------------------------------------------------
//
// sad-feedback.ts 与 tool-guidance.ts 互导会形成循环依赖，导致运行时
// categorizeTool 在某些打包/变换场景下不可用（权重无法按类别更新/读取，
// 表现为 SAD 衰减不收敛）。这里用 setter 晚绑定：tool-guidance.ts 在模块
// 加载末尾调用 setCategorizer(categorizeTool) 注入实现，本模块统一用
// _categorize() 调用。运行期（assemble/afterTurn）调用 SAD 函数时注入已完成。
//
// 单测直接调用 SAD 函数前，只要从 tool-guidance.ts 导入任意符号，即可触发
// 其模块加载并完成 setCategorizer 注册。

let _categorize: (toolName: string) => string[] = () => [];

/**
 * 注册工具分类函数（由 tool-guidance.ts 在模块加载末尾调用）。
 */
export function setCategorizer(fn: (toolName: string) => string[]): void {
  if (typeof fn === 'function') _categorize = fn;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认权重 */
export const DEFAULT_WEIGHT = 0.5;

/** 低于此权重的工具不再推荐（替代旧版 FATIGUE_THRESHOLD 的硬剔除） */
export const MIN_WEIGHT = 0.2;

/** 被使用时，该工具自身权重增量 */
export const BOOST_USED_SELF = 0.10;

/** 被使用时，同类（同 category）工具权重增量 */
export const BOOST_USED_CATEGORY = 0.15;

/** 被注入但未使用时，该工具自身权重衰减 */
export const DECAY_UNUSED_SELF = 0.12;

/** 被注入但未使用时，同类工具权重衰减 */
export const DECAY_UNUSED_CATEGORY = 0.05;

/** 权重上限 */
export const WEIGHT_MAX = 1.0;

/** 权重下限（不低于 0，但低于 MIN_WEIGHT 会被过滤） */
export const WEIGHT_MIN = 0.0;

/** 工具自身权重在有效权重中的占比（剩余给类别权重） */
export const SELF_WEIGHT_RATIO = 0.6;
export const CATEGORY_WEIGHT_RATIO = 0.4;

// ---------------------------------------------------------------------------
// 会话级权重缓存（LRU + TTL，对齐 trackerCache）
// ---------------------------------------------------------------------------

interface SadWeights {
  /** tool → 权重 */
  toolWeights: Map<string, number>;
  /** category → 权重 */
  categoryWeights: Map<string, number>;
  /** 最近访问时间（用于 TTL 淘汰） */
  lastAccess: number;
}

const MAX_SAD_SESSIONS = 500;
const SAD_TTL_MS = 4 * 60 * 60 * 1000; // 4h，对齐 trackerCache

const _sadCache = new Map<string, SadWeights>();

function evictStaleSad(): void {
  const now = Date.now();
  for (const [key, entry] of _sadCache) {
    if (now - entry.lastAccess > SAD_TTL_MS) {
      _sadCache.delete(key);
    } else {
      break; // Map 按插入序，遇到未过期的即可停止（前提是访问时 touch）
    }
  }
  while (_sadCache.size > MAX_SAD_SESSIONS) {
    const firstKey = _sadCache.keys().next().value;
    if (firstKey === undefined) break;
    _sadCache.delete(firstKey);
  }
}

function getSadWeights(sessionKey: string): SadWeights {
  let entry = _sadCache.get(sessionKey);
  if (!entry) {
    evictStaleSad();
    entry = {
      toolWeights: new Map(),
      categoryWeights: new Map(),
      lastAccess: Date.now(),
    };
    _sadCache.set(sessionKey, entry);
  }
  entry.lastAccess = Date.now();
  // LRU touch：删除后重新插入到末尾
  _sadCache.delete(sessionKey);
  _sadCache.set(sessionKey, entry);
  return entry;
}

function clamp(w: number): number {
  if (w < WEIGHT_MIN) return WEIGHT_MIN;
  if (w > WEIGHT_MAX) return WEIGHT_MAX;
  return w;
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 记录上一轮工具反馈，更新权重。
 *
 * 调用时机：beginToolGuidanceRound 在回填上一轮 used 状态后调用。
 *
 * @param sessionKey 会话标识
 * @param injections 上一轮的注入记录（含 used 标记）
 * @param availableTools 当前可用工具列表（用于确定同类工具范围）
 */
export function recordSadFeedback(
  sessionKey: string,
  injections: { tool: string; used: boolean; round: number }[],
  availableTools: string[],
): void {
  if (!sessionKey || injections.length === 0) return;

  const weights = getSadWeights(sessionKey);

  // 仅处理"上一轮"的注入（避免重复处理历史轮次）
  // 调用方应只传入上一轮的记录
  for (const inj of injections) {
    const tool = inj.tool;
    const toolCats = _categorize(tool);

    if (inj.used) {
      // 正向反馈：增强该工具 + 同类
      const prevToolW = weights.toolWeights.get(tool) ?? DEFAULT_WEIGHT;
      weights.toolWeights.set(tool, clamp(prevToolW + BOOST_USED_SELF));
      for (const cat of toolCats) {
        const prevCatW = weights.categoryWeights.get(cat) ?? DEFAULT_WEIGHT;
        weights.categoryWeights.set(cat, clamp(prevCatW + BOOST_USED_CATEGORY));
      }
      // 同类工具也获得小幅加权（扩散正向信号）
      for (const otherTool of availableTools) {
        if (otherTool === tool) continue;
        const otherCats = _categorize(otherTool);
        if (otherCats.some((c: string) => toolCats.includes(c))) {
          const prev = weights.toolWeights.get(otherTool) ?? DEFAULT_WEIGHT;
          weights.toolWeights.set(otherTool, clamp(prev + BOOST_USED_CATEGORY * 0.5));
        }
      }
    } else {
      // 负向反馈：降权该工具 + 同类
      const prevToolW = weights.toolWeights.get(tool) ?? DEFAULT_WEIGHT;
      weights.toolWeights.set(tool, clamp(prevToolW - DECAY_UNUSED_SELF));
      for (const cat of toolCats) {
        const prevCatW = weights.categoryWeights.get(cat) ?? DEFAULT_WEIGHT;
        weights.categoryWeights.set(cat, clamp(prevCatW - DECAY_UNUSED_CATEGORY));
      }
    }
  }
}

/**
 * 计算工具的有效权重（自身权重 × SELF_WEIGHT_RATIO + 类别权重 × CATEGORY_WEIGHT_RATIO）。
 * 默认 0.5（未观测过的工具）。
 */
export function getEffectiveWeight(tool: string, sessionKey: string): number {
  const weights = _sadCache.get(sessionKey);
  if (!weights) return DEFAULT_WEIGHT;

  const toolW = weights.toolWeights.get(tool) ?? DEFAULT_WEIGHT;
  const toolCats = _categorize(tool);
  // 取该工具所属类别中已观测过的最高类别权重（一个工具可能多类别）；
  // 类别从未被观测时才退回 DEFAULT_WEIGHT。注意衰减后类别权重会低于默认值，
  // 必须使用实际值而非默认值，否则负向反馈无法拉低有效权重。
  let catWObserved: number | null = null;
  for (const cat of toolCats) {
    const w = weights.categoryWeights.get(cat);
    if (w !== undefined && (catWObserved === null || w > catWObserved)) {
      catWObserved = w;
    }
  }
  const catW = catWObserved ?? DEFAULT_WEIGHT;
  return toolW * SELF_WEIGHT_RATIO + catW * CATEGORY_WEIGHT_RATIO;
}

/**
 * 判断工具是否值得推荐（有效权重 >= MIN_WEIGHT）。
 * 替代旧版 FATIGUE_THRESHOLD 的二元剔除。
 */
export function isRecommendable(tool: string, sessionKey: string): boolean {
  return getEffectiveWeight(tool, sessionKey) >= MIN_WEIGHT;
}

/**
 * 按有效权重对工具排序（降序），权重高的优先推荐。
 */
export function sortByWeight(tools: string[], sessionKey: string): string[] {
  return [...tools].sort(
    (a, b) => getEffectiveWeight(b, sessionKey) - getEffectiveWeight(a, sessionKey),
  );
}

/** 清除指定会话的 SAD 权重缓存（/new 等会话重置场景） */
export function clearSadWeights(sessionKey: string): void {
  _sadCache.delete(sessionKey);
}

/** 供 heartbeat 清理过期 SAD 缓存的公开入口 */
export function evictStaleSadWeights(): void {
  evictStaleSad();
}
