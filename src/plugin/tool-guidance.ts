/**
 * Tool-aware retrieval strategy helpers + Smart Tool Guidance.
 *
 * 4 层策略（Agent Harness 最佳实践）：
 *   L1 场景驱动 —— 根据 query 场景只推荐相关工具
 *   L2 渐进披露 —— 首轮不注入工具，agent 真正需要时才提示
 *   L3 使用追踪 —— 已使用的工具不再重复提示
 *   L4 疲劳衰减 —— 连续 N 轮未用某工具，降低其推荐权重
 *   L5 任务分解 —— 场景+关键词分解为有序子任务，按步骤推荐工具（规则版，不依赖 LLM）
 *
 * SessionToolTracker 是会话级状态，按 sessionKey 隔离。
 * 主入口：buildSmartToolGuidance()，替代旧版硬编码工具列表。
 */

import { decomposeTask, hasDecompositionTemplate } from './task-decomposer.js';
import {
  recordSadFeedback,
  isRecommendable,
  sortByWeight,
  setCategorizer,
} from './sad-feedback.js';

/** Extract available tool names from assemble params. Hardcoded fallback for Tool Search mode. */
export function extractAvailableTools(params: any): string[] {
  const tools = params.availableTools;
  // 完整 21 个工具列表，与 openclaw.plugin.json contracts.tools 完全对齐
  if (!tools) return [
    "lcmg_search","lcmg_experience_report","lcmg_backup","lcmg_restore","lcmg_import",
    "lcmg_pin","lcmg_sync","lcmg_qmd_status","lcmg_get_document","lcmg_batch_get",
    "lcmg_maintain","lcmg_diagnose","lcmg_forget","lcmg_distill","lcmg_distill_retry",
    "lcmg_backfill","lcmg_compact","lcmg_reset_breaker",
    "lcmg_config_get","lcmg_config_set","lcmg_moa_reply",
  ];
  if (tools instanceof Set) return [...tools].map((t: string) => t.toLowerCase());
  if (Array.isArray(tools)) return tools.map((t: string) => t.toLowerCase());
  return [];
}

/** Self-registered tool names — mirrors openclaw.plugin.json contracts.tools. */
export const SELF_REGISTERED_TOOLS = new Set([
  "lcmg_search", "lcmg_pin", "lcmg_import",
  "lcmg_experience_report",
  "lcmg_qmd_status", "lcmg_get_document", "lcmg_batch_get",
  "lcmg_maintain", "lcmg_diagnose",
  "lcmg_backup", "lcmg_restore", "lcmg_sync",
  "lcmg_forget", "lcmg_distill", "lcmg_distill_retry",
  "lcmg_backfill", "lcmg_compact", "lcmg_reset_breaker",
  "lcmg_config_get", "lcmg_config_set",
  "lcmg_moa_reply",
]);

/** Tool category to tool name mapping. */
export const TOOL_CATEGORIES_SELF: Record<string, Set<string>> = {
  graph: new Set(["lcmg_search"]),
  experience: new Set(["lcmg_experience_report", "lcmg_moa_reply"]),
  qmd: new Set(["lcmg_qmd_status", "lcmg_get_document", "lcmg_batch_get"]),
  maintenance: new Set([
    "lcmg_maintain", "lcmg_diagnose", "lcmg_compact",
    "lcmg_distill", "lcmg_distill_retry", "lcmg_backfill",
    "lcmg_reset_breaker",
  ]),
  lifecycle: new Set([
    "lcmg_backup", "lcmg_restore", "lcmg_import", "lcmg_sync",
  ]),
  knowledge: new Set(["lcmg_pin", "lcmg_forget"]),
  config: new Set(["lcmg_config_get", "lcmg_config_set"]),
};

/** Check if a category tool is self-registered (independent of Tool Search). */
export function hasSelfCategory(category: string): boolean {
  const names = TOOL_CATEGORIES_SELF[category];
  if (!names) return false;
  return [...names].some(n => SELF_REGISTERED_TOOLS.has(n));
}

/** Exact tool name sets per category — derived from contracts.tools. */
export const TOOL_CATEGORIES: Record<string, ReadonlySet<string>> = {
  graph: new Set(["lcmg_search"]),
  experience: new Set(["lcmg_experience_report", "lcmg_moa_reply"]),
  qmd: new Set(["lcmg_qmd_status", "lcmg_get_document", "lcmg_batch_get"]),
  maintenance: new Set([
    "lcmg_maintain", "lcmg_diagnose", "lcmg_compact",
    "lcmg_distill", "lcmg_distill_retry", "lcmg_backfill",
    "lcmg_reset_breaker",
  ]),
  lifecycle: new Set(["lcmg_backup", "lcmg_restore", "lcmg_import", "lcmg_sync"]),
  knowledge: new Set(["lcmg_pin", "lcmg_forget"]),
  config: new Set(["lcmg_config_get", "lcmg_config_set"]),
};

/** Check if a tool category is available (exact match, no fallback). */
export function hasToolCategory(availableTools: string[], category: string): boolean {
  const exactNames = TOOL_CATEGORIES[category];
  if (!exactNames) return false;
  return availableTools.some(t => exactNames.has(t));
}

export function listActiveCategories(availableTools: string[]): string[] {
  const active: string[] = [];
  for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
    if (availableTools.some(t => names.has(t))) {
      active.push(cat);
    }
  }
  return active;
}

/** Build tool guidance section for systemPromptAddition. */
export function buildToolGuidance(availableTools: string[]): string {
  const activeCategories = listActiveCategories(availableTools);
  if (activeCategories.length === 0 && availableTools.length === 0) {
    return "";
  }

  const categoryLabels: Record<string, { label: string; desc: string }> = {
    graph: { label: "知识图谱", desc: "实体关系查询" },
    experience: { label: "经验检索", desc: "历史解决方案检索" },
    qmd: { label: "记忆文件", desc: "QMD 文档管理" },
    maintenance: { label: "系统维护", desc: "健康检查与修复" },
    lifecycle: { label: "生命周期", desc: "备份/恢复/同步" },
    knowledge: { label: "知识管理", desc: "节点置顶与遗忘" },
    config: { label: "系统配置", desc: "读取/修改配置" },
  };

  const lines = ["## [Available Tools]"];
  for (const cat of Object.keys(TOOL_CATEGORIES)) {
    const info = categoryLabels[cat];
    if (!info) continue;
    if (activeCategories.includes(cat)) {
      lines.push("- [OK] **" + info.label + "** -- " + info.desc);
    } else {
      lines.push("- [AUTO] **" + info.label + "** -- auto-injected, no manual call needed");
    }
  }

  if (availableTools.length === 0) {
    lines.push("\n> Tip: no lcm-graph-extra tools available, context auto-injected.");
  }

  return lines.join("\n");
}

/**
 * 已知工具的简短描述映射表
 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  'lcmg_search': '搜索记忆库中的代码片段和文档',
  'lcmg_backup': '备份当前记忆数据',
  'lcmg_restore': '从备份恢复记忆数据',
  'lcmg_import': '从外部文件导入记忆数据',
  'lcmg_pin': '固定重要记忆节点',
  'lcmg_sync': '同步多端记忆数据',
  'lcmg_qmd_status': '查看记忆库状态',
  'lcmg_get_document': '获取完整文档内容',
  'lcmg_batch_get': '批量获取多个文档',
  'lcmg_maintain': '执行记忆库维护任务',
  'lcmg_diagnose': '诊断记忆库健康状态',
  'lcmg_experience_report': '查看经验总结报告',
  'lcmg_forget': '删除指定记忆',
  'lcmg_distill': '蒸馏经验',
  'lcmg_distill_retry': '重试失败的蒸馏任务',
  'lcmg_backfill': '从历史对话补录经验',
  'lcmg_compact': '压缩上下文',
  'lcmg_reset_breaker': '重置熔断器',
  'lcmg_config_get': '读取配置',
  'lcmg_config_set': '修改配置',
  'lcmg_moa_reply': 'MoA 多模型聚合回复',
};

/** 工具类别中文标签 —— 用于 low 层级分组展示 */
const ADAPTIVE_CATEGORY_LABELS: Record<string, string> = {
  graph: '知识图谱',
  experience: '经验检索',
  qmd: '记忆文件',
  maintenance: '系统维护',
  lifecycle: '生命周期',
  knowledge: '知识管理',
  config: '系统配置',
};

/**
 * 获取工具的简短描述
 * @param toolName 工具名称
 * @param maxLen 描述最大长度（可选），超出则截断并添加省略号
 * @returns 工具描述字符串，未知工具返回空字符串
 */
export function getToolDescription(toolName: string, maxLen?: number): string {
  const desc = TOOL_DESCRIPTIONS[toolName] ?? '';
  // 未指定长度上限或上限非法时，直接返回完整描述
  if (maxLen === undefined || maxLen <= 0) {
    return desc;
  }
  // 超过最大长度则截断并添加省略号
  if (desc.length > maxLen) {
    return desc.slice(0, Math.max(0, maxLen - 1)) + '…';
  }
  return desc;
}

/**
 * 根据场景获取推荐工具列表（类别驱动匹配）。
 * 返回当前可用工具中匹配场景类别的工具，最多 5 个。
 */
export function getRecommendedTools(scenario: string, available: string[]): string[] {
  return matchToolsForScenario(scenario, available);
}

/**
 * 构建低能力层级（low）工具指引
 * 包含完整描述，按 TOOL_CATEGORIES 类别分组，并附带场景推荐 Top 3
 */
function buildLowTierGuidance(scenario: string | null, availableTools: string[]): string {
  const lines: string[] = ["## [Adaptive Tool Guidance - Low Tier]"];
  const availableSet = new Set(availableTools);
  const listedTools = new Set<string>();

  // 按 TOOL_CATEGORIES 类别分组展示可用工具
  for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
    const label = ADAPTIVE_CATEGORY_LABELS[cat] ?? cat;
    const catTools = [...names].filter(t => availableSet.has(t));
    if (catTools.length === 0) continue;
    lines.push(`\n### ${label}`);
    for (const tool of catTools) {
      // low 层级输出完整描述
      lines.push(`- **${tool}**: ${getToolDescription(tool)}`);
      listedTools.add(tool);
    }
  }

  // 未归类工具统一放入「其他」分组
  const others = availableTools.filter(t => !listedTools.has(t));
  if (others.length > 0) {
    lines.push("\n### 其他");
    for (const tool of others) {
      lines.push(`- **${tool}**: ${getToolDescription(tool)}`);
    }
  }

  // 场景推荐工具（类别驱动，Top 3）
  if (scenario) {
    const recommended = getRecommendedTools(scenario, availableTools).slice(0, 3);
    if (recommended.length > 0) {
      lines.push(`\n### 场景推荐 (scenario: ${scenario})`);
      recommended.forEach((t, i) => {
        lines.push(`${i + 1}. **${t}**: ${getToolDescription(t)}`);
      });
    }
  }

  return lines.join("\n");
}

/**
 * 构建中能力层级（medium）工具指引
 * 每个工具一行：工具名 + 一行简短描述
 */
function buildMediumTierGuidance(availableTools: string[]): string {
  const lines: string[] = ["## [Adaptive Tool Guidance - Medium Tier]"];
  for (const tool of availableTools) {
    // medium 层级输出一行简短描述（截断到 40 字符）
    lines.push(`- ${tool}: ${getToolDescription(tool, 40)}`);
  }
  return lines.join("\n");
}

/**
 * 构建高能力层级（high）工具指引
 * 仅输出工具名列表，逗号分隔
 */
function buildHighTierGuidance(availableTools: string[]): string {
  return `## [Adaptive Tool Guidance - High Tier]\n${availableTools.join(", ")}`;
}

/**
 * 根据能力层级构建自适应工具指引
 *
 * 不同层级输出不同详细程度：
 * - low: 完整描述 + 场景推荐 Top 3 工具
 * - medium: 工具名 + 一行简短描述
 * - high: 仅工具名列表（逗号分隔）
 *
 * @param tier 能力层级：'low' | 'medium' | 'high'
 * @param scenario 当前场景标识（可为 null）
 * @param availableTools 当前可用工具列表
 * @returns 自适应工具指引字符串；无可用工具时返回空字符串
 */
export function buildAdaptiveToolGuidance(
  tier: string,
  scenario: string | null,
  availableTools: string[]
): string {
  // 无可用工具时不输出指引
  if (availableTools.length === 0) {
    return "";
  }

  if (tier === 'low') {
    // 低能力层级：完整描述 + 场景推荐 Top 3
    return buildLowTierGuidance(scenario, availableTools);
  } else if (tier === 'medium') {
    // 中能力层级：工具名 + 一行简短描述
    return buildMediumTierGuidance(availableTools);
  } else if (tier === 'high') {
    // 高能力层级：仅工具名列表（逗号分隔）
    return buildHighTierGuidance(availableTools);
  }

  // 未知层级：默认回退到 medium 层级输出
  return buildMediumTierGuidance(availableTools);
}

// ============================================================================
// Smart Tool Guidance — 4 层策略（L1-L4）
// ============================================================================

// ---------------------------------------------------------------------------
// 工具类别系统：按语义类别匹配，而非硬编码工具名
// LCM 工具优先查 TOOL_CATEGORIES，系统工具按名称模式推断
// ---------------------------------------------------------------------------

/** 工具名称模式 → 语义类别（用于非 LCM 工具的自动归类） */
const TOOL_NAME_PATTERNS: Record<string, RegExp[]> = {
  search:    [/search/i, /find/i, /grep/i, /glob/i, /query/i, /retrieve/i, /lookup/i, /scan/i],
  document:  [/read/i, /^get_/i, /fetch/i, /^cat$/i, /show/i, /view/i, /open/i, /document/i],
  file:      [/write/i, /edit/i, /create/i, /save/i, /^mk/i, /touch/i, /delete/i, /remove/i, /^mv$/i, /^cp$/i, /rename/i, /^ls$/i, /list/i],
  shell:     [/run/i, /exec/i, /shell/i, /bash/i, /command/i, /script/i, /terminal/i],
  web:       [/web/i, /browser/i, /^url$/i, /http/i, /fetch_page/i, /scrape/i],
  task:      [/task/i, /todo/i, /plan/i, /schedule/i],
  diagnosis: [/diagnose/i, /health/i, /status/i, /check/i, /probe/i, /ping/i, /validate/i],
  config:    [/config/i, /setting/i, /preference/i, /profile/i],
  experience:[/experience/i, /report/i, /history/i, /^log$/i],
  maintenance:[/maintain/i, /compact/i, /distill/i, /forget/i, /reset/i, /clean/i, /repair/i, /fix/i, /^ttl/i],
  lifecycle: [/backup/i, /restore/i, /sync/i, /import/i, /export/i, /^pin$/i, /archive/i],
  graph:     [/graph/i, /node/i, /edge/i, /neo4j/i, /^gm_/i],
};

/** 类别中文标签（用于工具描述自动推断） */
const CATEGORY_LABELS: Record<string, string> = {
  search: '搜索', document: '读取', file: '文件操作', shell: '执行命令',
  web: '网络', task: '任务', diagnosis: '诊断', config: '配置',
  experience: '经验', maintenance: '维护', lifecycle: '数据管理', graph: '知识图谱',
};

/**
 * 归类一个工具：返回其所属的语义类别列表（LCM 显式类别 ∪ 名称模式推断的通用类别）。
 *
 * 返回并集而非二选一：LCM 工具既属于其专属桶（如 lcmg_search → graph），
 * 也匹配通用能力词（lcmg_search → search）。这样场景模板（按通用类别匹配）
 * 才能命中 LCM 工具，使任务分解与场景推荐对 LCM 工具生效。
 */
export function categorizeTool(toolName: string): string[] {
  const lower = toolName.toLowerCase();
  const cats = new Set<string>();
  // 1. 精确匹配 LCM 工具类别
  for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
    if (names.has(lower)) cats.add(cat);
  }
  // 2. 名称模式推断（通用能力类别）
  for (const [cat, patterns] of Object.entries(TOOL_NAME_PATTERNS)) {
    if (patterns.some((re) => re.test(lower))) {
      cats.add(cat);
    }
  }
  return [...cats];
}

/** 工具描述：已知工具用精确描述，未知工具按类别标签推断 */
function inferToolDescription(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (TOOL_DESCRIPTIONS[lower]) return TOOL_DESCRIPTIONS[lower];
  const cats = categorizeTool(toolName);
  if (cats.length === 0) return '';
  return CATEGORY_LABELS[cats[0]] ?? '';
}

/** 场景 → 需要的能力类别映射（按优先级排序） */
const SCENARIO_CATEGORY_MAP: Record<string, string[]> = {
  'bug-fix':        ['search', 'document', 'file', 'diagnosis', 'experience', 'shell'],
  'config-debug':   ['search', 'config', 'diagnosis', 'document'],
  'feature-dev':    ['search', 'document', 'file', 'shell', 'task'],
  'code-review':    ['search', 'document', 'experience'],
  'security-audit': ['search', 'diagnosis', 'experience', 'shell'],
  'deployment':     ['lifecycle', 'diagnosis', 'shell', 'search'],
  'performance-opt':['search', 'diagnosis', 'shell'],
  'refactor':       ['search', 'document', 'file', 'shell'],
};

/**
 * 根据场景从 availableTools 中匹配相关工具。
 * 不依赖硬编码工具名——任何工具只要类别匹配就会被推荐。
 * 按类别匹配数 + 类别优先级排序，最多取 5 个。
 */
function matchToolsForScenario(scenario: string, availableTools: string[]): string[] {
  const wantedCategories = SCENARIO_CATEGORY_MAP[scenario];
  if (!wantedCategories || wantedCategories.length === 0) return [];

  const categorySet = new Set(wantedCategories);
  const categoryPriority = new Map(wantedCategories.map((c, i) => [c, i]));
  const scored: { tool: string; score: number; priority: number }[] = [];

  for (const tool of availableTools) {
    const toolCats = categorizeTool(tool);
    const matchCount = toolCats.filter((c) => categorySet.has(c)).length;
    if (matchCount === 0) continue;
    // 取最高优先级（数字越小越优先）
    const bestPriority = Math.min(
      ...toolCats.filter((c) => categorySet.has(c)).map((c) => categoryPriority.get(c) ?? 999),
    );
    scored.push({ tool, score: matchCount, priority: bestPriority });
  }

  // 按匹配数降序，同匹配数按优先级升序
  scored.sort((a, b) => b.score - a.score || a.priority - b.priority);
  return scored.map((s) => s.tool).slice(0, 5);
}

/** 单次工具注入记录 */
interface ToolInjectionRecord {
  /** 工具名 */
  tool: string;
  /** 注入的轮次（assemble 调用次数） */
  round: number;
  /** 该轮是否被 agent 实际调用 */
  used: boolean;
}

/** 会话级工具追踪状态 */
interface SessionToolState {
  /** 已注入的工具记录（按注入轮次排列） */
  injections: ToolInjectionRecord[];
  /** 本轮 assemble 序号（从 1 开始） */
  round: number;
  /** 上一轮是否注入了工具指引 */
  lastHadGuidance: boolean;
}

/** 会话级工具追踪器（LRU + TTL，按 sessionKey 隔离） */
const trackerCache = new Map<string, SessionToolState>();
const TRACKER_MAX_SESSIONS = 500;
const TRACKER_TTL_MS = 4 * 60 * 60 * 1000; // 4h

function getTracker(sessionKey: string): SessionToolState {
  let state = trackerCache.get(sessionKey);
  if (!state) {
    // LRU 清理
    if (trackerCache.size >= TRACKER_MAX_SESSIONS) {
      const oldest = trackerCache.keys().next().value;
      if (oldest !== undefined) trackerCache.delete(oldest);
    }
    state = { injections: [], round: 0, lastHadGuidance: false };
    trackerCache.set(sessionKey, state);
  }
  // TTL 清理
  const now = Date.now();
  for (const [key, s] of trackerCache) {
    if (now - (s as any)._lastAccess > TRACKER_TTL_MS) trackerCache.delete(key);
  }
  (state as any)._lastAccess = now;
  return state;
}

/** 从消息历史中提取 agent 实际调用的工具名 */
export function extractUsedTools(messages: any[]): string[] {
  const used = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_use' && typeof part?.name === 'string') {
        used.add(part.name.toLowerCase());
      }
    }
  }
  return [...used];
}

/**
 * 标记轮次开始并回填上一轮工具使用情况。
 * 调用时机：每次 assemble 开始时（在 buildSmartToolGuidance 之前）。
 *
 * SAD 反馈循环：回填后调用 recordSadFeedback 更新权重（用了→增强同类，
 * 未用→降权），替代旧版 L4 纯疲劳衰减的二元剔除。
 */
export function beginToolGuidanceRound(
  sessionKey: string,
  messages: any[],
): void {
  const state = getTracker(sessionKey);
  state.round++;

  // 回填上一轮：检查上一轮注入的工具是否被 agent 实际调用
  const usedTools = extractUsedTools(messages);
  const usedSet = new Set(usedTools);
  const prevRoundInjections: { tool: string; used: boolean; round: number }[] = [];
  for (const inj of state.injections) {
    if (inj.round === state.round - 1) {
      inj.used = usedSet.has(inj.tool);
      prevRoundInjections.push({ tool: inj.tool, used: inj.used, round: inj.round });
    }
  }

  // SAD：基于上一轮使用情况更新权重（用了增强同类，未用降权）
  if (prevRoundInjections.length > 0) {
    try {
      const availableTools = messages.flatMap((m: any) =>
        Array.isArray(m?.content) ? m.content.filter((b: any) => b?.type === 'tool_use' && typeof b?.name === 'string').map((b: any) => b.name.toLowerCase()) : [],
      );
      recordSadFeedback(sessionKey, prevRoundInjections, availableTools);
    } catch { /* non-fatal */ }
  }
}

/** 渐进披露：前 N 轮不注入工具指引（让 agent 先专注理解任务） */
const PROGRESSIVE_DISCLOSURE_ROUNDS = 0;

/**
 * 构建智能工具指引（4 层策略 + L5 任务分解）。
 *
 * 替代旧版硬编码 `## 记忆系统分工` 的常量注入。
 * 仅在以下条件之一满足时注入工具指引：
 *   1. 场景匹配到相关工具（L1）—— 按类别匹配，不限于 LCM 工具
 *   2. 已过渐进披露轮次且 agent 从未使用过工具（L2）
 * 不注入的情况：
 *   - agent 已使用过推荐工具 → 不再重复提示（L3）
 *   - 连续 3 轮未使用 → 疲劳衰减，不再提示（L4）
 *   - 高压力 tier → 不注入任何工具指引以节省上下文
 *
 * L5 任务分解模式（传入 userQuery 且场景有分解模板时启用）：
 *   - 将请求分解为有序子任务，每步绑定能力类别
 *   - 按子任务顺序推荐工具，引导 LLM 分步执行而非堆叠调用
 *   - 无模板时回退到 L1 平铺列表
 *
 * @param tier 压力层级（high 时直接返回空字符串）
 * @param scenario 当前场景（可为 null）
 * @param availableTools 可用工具列表（包含 LCM 工具 + 系统工具）
 * @param sessionKey 会话标识
 * @param userQuery 最新用户消息（可选，启用 L5 任务分解）
 * @returns 工具指引字符串，空字符串表示本轮不注入
 */
export function buildSmartToolGuidance(
  tier: string,
  scenario: string | null,
  availableTools: string[],
  sessionKey: string,
  userQuery?: string,
): string {
  // 高压力模式：不注入任何工具指引，节省上下文
  if (tier === 'high') return '';

  const state = getTracker(sessionKey);

  // L2 渐进披露：前 N 轮不注入工具指引
  if (state.round <= PROGRESSIVE_DISCLOSURE_ROUNDS) return '';

  // L5 任务分解模式：场景有模板 + 提供了用户消息 → 有序子任务推荐
  if (scenario && userQuery && hasDecompositionTemplate(scenario)) {
    const { subtasks } = decomposeTask(scenario, userQuery);
    if (subtasks.length > 0) {
      // 至少有一个子任务能匹配到工具才走分解模式
      const hasAnyMatch = subtasks.some((st) =>
        availableTools.some((tool) => categorizeTool(tool).includes(st.category)),
      );
      if (hasAnyMatch) {
        const guidance = renderDecomposedGuidance(subtasks, availableTools, state, sessionKey);
        if (guidance) {
          state.lastHadGuidance = true;
          return guidance;
        }
      }
    }
    // 分解模式未命中工具则回退到 L1
  }

  // 确定本轮候选工具
  let candidateTools: string[] = [];
  if (scenario) {
    // L1 场景驱动：按类别匹配，不限 LCM 工具
    candidateTools = matchToolsForScenario(scenario, availableTools);
  }

  // 如果场景未命中或没有可用工具，不注入
  if (candidateTools.length === 0) {
    state.lastHadGuidance = false;
    return '';
  }

  // L3+SAD：过滤已使用（L3 避免唠叨）+ 权重过低（SAD 替代旧版 L4 疲劳衰减）
  const unusedTools = candidateTools.filter((tool) => {
    const relevantInjections = state.injections.filter((i) => i.tool === tool);
    // L3：已使用过 → 不再提示（避免对同一工具唠叨）
    if (relevantInjections.some((i) => i.used)) return false;
    // SAD：有效权重低于阈值 → 渐次淡出（替代旧版 L4 连续未用硬剔除）
    return isRecommendable(tool, sessionKey);
  });

  if (unusedTools.length === 0) {
    state.lastHadGuidance = false;
    return '';
  }

  // SAD：按有效权重降序排序，高权重工具优先推荐
  const orderedTools = sortByWeight(unusedTools, sessionKey);

  // 记录本轮注入
  for (const tool of orderedTools) {
    state.injections.push({ tool, round: state.round, used: false });
  }
  state.lastHadGuidance = true;

  // 构建简洁指引（仅工具名 + 简短描述，不展开全部工具列表）
  const lines = ['## 相关工具提示'];
  lines.push(
    '以下工具可能在当前场景有用。已自动注入的知识库通常已包含所需信息，',
    '优先基于已有上下文直接执行，仅在必要时使用工具。',
  );
  for (const tool of orderedTools) {
    const desc = inferToolDescription(tool);
    lines.push(`- **${tool}**${desc ? ': ' + desc : ''}`);
  }

  return lines.join('\n');
}

/** 供 heartbeat 清理过期 tracker 的公开入口 */
export function evictStaleToolTrackers(): void {
  const now = Date.now();
  for (const [key, state] of trackerCache) {
    if (now - ((state as any)._lastAccess ?? 0) > TRACKER_TTL_MS) {
      trackerCache.delete(key);
    }
  }
}

/** 清除指定会话的工具追踪缓存（/new 等会话重置场景） */
export function clearSessionToolTracker(sessionKey: string): void {
  trackerCache.delete(sessionKey);
}

// ============================================================================
// L5 任务分解模式 —— 规则版子任务序列驱动有序推荐
// ============================================================================

/**
 * 为每个子任务匹配可用工具（按子任务的能力类别）。
 * 同一工具可命中多个子任务，但只在首次出现的子任务中展示，避免重复。
 */
function matchToolsForSubtasks(
  subtasks: { step: number; name: string; hint: string; category: string; optional?: boolean }[],
  availableTools: string[],
): { step: number; name: string; hint: string; tools: string[]; optional?: boolean }[] {
  const usedTools = new Set<string>();
  const result: { step: number; name: string; hint: string; tools: string[]; optional?: boolean }[] = [];

  for (const st of subtasks) {
    const matched: string[] = [];
    for (const tool of availableTools) {
      if (usedTools.has(tool)) continue;
      const cats = categorizeTool(tool);
      if (cats.includes(st.category)) {
        matched.push(tool);
        usedTools.add(tool);
      }
    }
    // 即使无工具命中，也保留该子任务作为"步骤指引"（LLM 可用非工具方式完成）
    result.push({ step: st.step, name: st.name, hint: st.hint, tools: matched, optional: st.optional });
  }

  return result;
}

/**
 * 构建任务分解模式的工具指引文本（由 buildSmartToolGuidance 调用）。
 *
 * 与旧版平铺列表的区别：
 *   - 工具按子任务顺序出现，引导 LLM 分步执行而非堆叠调用
 *   - 每步附带 hint 说明这一步要做什么
 *   - 无工具命中的子任务仍保留，作为"步骤提示"
 *
 * 应用 L3+SAD 过滤：已用（L3 避免唠叨）+ 权重过低（SAD 替代旧版 L4 疲劳）的工具从对应步骤移除，
 * 若某必选子任务的所有工具均被过滤，该子任务整体保留但标注"无可用工具"。
 */
function renderDecomposedGuidance(
  subtasks: { step: number; name: string; hint: string; category: string; optional?: boolean }[],
  availableTools: string[],
  state: SessionToolState,
  sessionKey: string,
): string {
  const stepTools = matchToolsForSubtasks(subtasks, availableTools);

  const lines: string[] = ['## 任务分解与工具推荐'];
  lines.push(
    '当前请求可拆解为以下有序步骤，请按步骤推进，每步完成后再进入下一步。',
    '已自动注入的知识库通常已包含所需信息，优先基于已有上下文直接执行，仅在必要时使用工具。',
  );

  for (const st of stepTools) {
    // L3+SAD 过滤本步骤的工具
    const filteredTools = st.tools.filter((tool) => {
      const relevantInjections = state.injections.filter((i) => i.tool === tool);
      // L3：已使用过 → 不再提示（避免对同一工具唠叨）
      if (relevantInjections.some((i) => i.used)) return false;
      // SAD：有效权重低于阈值 → 渐次淡出（替代旧版 L4 连续未用硬剔除）
      return isRecommendable(tool, sessionKey);
    });
    // SAD：按权重降序排序
    const orderedTools = sortByWeight(filteredTools, sessionKey);

    const optTag = st.optional ? '（可选）' : '';
    lines.push(`\n### 步骤 ${st.step}：${st.name}${optTag}`);
    lines.push(`_目标：${st.hint}_`);

    if (orderedTools.length > 0) {
      // 记录本轮注入
      for (const tool of orderedTools) {
        state.injections.push({ tool, round: state.round, used: false });
      }
      for (const tool of orderedTools) {
        const desc = inferToolDescription(tool);
        lines.push(`- **${tool}**${desc ? ': ' + desc : ''}`);
      }
    } else if (st.tools.length > 0) {
      // 有候选工具但全被过滤 → 提示已用/权重过低
      lines.push('- _候选工具已使用或暂时不推荐_');
    } else {
      // 该步骤无工具命中 → 纯步骤提示
      lines.push('- _本步骤无需特定工具，可直接执行_');
    }
  }

  return lines.join('\n');
}

/**
 * 提取最新用户消息文本（用于任务分解的关键词匹配）。
 */
export function extractLatestUserQuery(messages: any[]): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((b: any) => b?.type === 'text' || typeof b?.text === 'string')
        .map((b: any) => b.text);
      if (textParts.length > 0) return textParts.join('\n');
    }
  }
  return '';
}

// 模块加载末尾：向 sad-feedback 注册分类器，打破循环依赖（晚绑定）。
// 必须在 categorizeTool 定义之后执行；放于模块尾部保证 hoisting 已完成。
setCategorizer(categorizeTool);
