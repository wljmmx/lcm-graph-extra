/**
 * Tool-aware retrieval strategy helpers + Smart Tool Guidance.
 *
 * 4 层策略（Agent Harness 最佳实践）：
 *   L1 场景驱动 —— 根据 query 场景只推荐相关工具
 *   L2 渐进披露 —— 首轮不注入工具，agent 真正需要时才提示
 *   L3 使用追踪 —— 已使用的工具不再重复提示
 *   L4 疲劳衰减 —— 连续 N 轮未用某工具，降低其推荐权重
 *
 * SessionToolTracker 是会话级状态，按 sessionKey 隔离。
 * 主入口：buildSmartToolGuidance()，替代旧版硬编码工具列表。
 */

/** Extract available tool names from assemble params. Hardcoded fallback for Tool Search mode. */
export function extractAvailableTools(params: any): string[] {
  const tools = params.availableTools;
  // P2-14: 修复拼写错误 lcmg_batch_get_documents → lcmg_batch_get，
  // 并补全遗漏的 lcmg_diagnose（与 SELF_REGISTERED_TOOLS 保持一致）。
  // 2026-07: 进一步补全遗漏的 lcmg_forget/distill/compact/reset_breaker/config_get/config_set，
  // 与 openclaw.plugin.json contracts.tools 完全对齐（18 个工具）。
  if (!tools) return [
    "lcmg_search","lcmg_experience_report","lcmg_backup","lcmg_restore","lcmg_import",
    "lcmg_pin","lcmg_sync","lcmg_qmd_status","lcmg_get_document","lcmg_batch_get",
    "lcmg_maintain","lcmg_diagnose","lcmg_forget","lcmg_distill","lcmg_compact",
    "lcmg_reset_breaker","lcmg_config_get","lcmg_config_set",
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
  "lcmg_forget", "lcmg_distill", "lcmg_compact", "lcmg_reset_breaker",
  "lcmg_config_get", "lcmg_config_set",
]);

/** Tool category to tool name mapping. */
export const TOOL_CATEGORIES_SELF: Record<string, Set<string>> = {
  graph: new Set(["lcmg_search"]),
  experience: new Set(["lcmg_experience_report"]),
  qmd: new Set(["lcmg_qmd_status", "lcmg_get_document", "lcmg_batch_get"]),
};

/** Check if a category tool is self-registered (independent of Tool Search). */
export function hasSelfCategory(category: string): boolean {
  const names = TOOL_CATEGORIES_SELF[category];
  if (!names) return false;
  return [...names].some(n => SELF_REGISTERED_TOOLS.has(n));
}

/** Exact tool name sets per category — derived from contracts.tools. */
export const TOOL_CATEGORIES: Record<string, ReadonlySet<string>> = {
  graph: new Set(["lcmg_search", "lcmg_pin", "lcmg_import"]),
  experience: new Set(["lcmg_experience_report"]),
  qmd: new Set(["lcmg_qmd_status", "lcmg_get_document", "lcmg_batch_get"]),
  maintenance: new Set(["lcmg_maintain", "lcmg_diagnose"]),
  lifecycle: new Set(["lcmg_backup", "lcmg_restore", "lcmg_sync"]),
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
  'lcmg_compact': '压缩上下文',
  'lcmg_reset_breaker': '重置熔断器',
  'lcmg_config_get': '读取配置',
  'lcmg_config_set': '修改配置',
};

/**
 * 场景到推荐工具的映射表（按推荐优先级排序）
 */
const SCENARIO_RECOMMENDATIONS: Record<string, string[]> = {
  'bug-fix': ['lcmg_search', 'lcmg_experience_report', 'lcmg_diagnose'],
  'config-debug': ['lcmg_search', 'lcmg_qmd_status', 'lcmg_diagnose'],
  'feature-dev': ['lcmg_search', 'lcmg_get_document', 'lcmg_batch_get'],
  'code-review': ['lcmg_experience_report', 'lcmg_search'],
  'security-audit': ['lcmg_search', 'lcmg_experience_report', 'lcmg_diagnose'],
  'deployment': ['lcmg_backup', 'lcmg_sync', 'lcmg_diagnose'],
};

/** 工具类别中文标签 —— 用于 low 层级分组展示 */
const ADAPTIVE_CATEGORY_LABELS: Record<string, string> = {
  graph: '知识图谱',
  experience: '经验检索',
  qmd: '记忆文件',
  maintenance: '系统维护',
  lifecycle: '生命周期',
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
 * 根据场景获取推荐工具列表
 * 仅返回当前可用的工具，按推荐优先级排序，最多取前 3 个
 * @param scenario 场景标识
 * @param available 当前可用工具列表
 * @returns 推荐工具列表
 */
export function getRecommendedTools(scenario: string, available: string[]): string[] {
  const recommended = SCENARIO_RECOMMENDATIONS[scenario];
  // 未知场景无推荐
  if (!recommended) return [];
  const availableSet = new Set(available);
  // 按推荐顺序过滤出当前可用的工具，最多取 3 个
  return recommended.filter(t => availableSet.has(t)).slice(0, 3);
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

  // 场景推荐工具（Top 3）
  if (scenario) {
    const recommended = getRecommendedTools(scenario, availableTools);
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
  for (const inj of state.injections) {
    if (inj.round === state.round - 1) {
      inj.used = usedSet.has(inj.tool);
    }
  }
}

/**
 * 场景到推荐工具的映射表（按推荐优先级排序）
 */
const SCENARIO_TOOL_MAP: Record<string, string[]> = {
  'bug-fix':        ['lcmg_search', 'lcmg_experience_report', 'lcmg_diagnose', 'lcmg_get_document'],
  'config-debug':   ['lcmg_search', 'lcmg_qmd_status', 'lcmg_diagnose', 'lcmg_config_get'],
  'feature-dev':    ['lcmg_search', 'lcmg_get_document', 'lcmg_batch_get'],
  'code-review':    ['lcmg_experience_report', 'lcmg_search'],
  'security-audit': ['lcmg_search', 'lcmg_experience_report', 'lcmg_diagnose'],
  'deployment':     ['lcmg_backup', 'lcmg_diagnose', 'lcmg_sync'],
  'performance-opt':['lcmg_search', 'lcmg_diagnose'],
  'refactor':       ['lcmg_search', 'lcmg_get_document'],
};

/** 工具简短描述 */
const TOOL_DESC_MAP: Record<string, string> = {
  'lcmg_search': '搜索记忆库',
  'lcmg_experience_report': '经验报告',
  'lcmg_diagnose': '系统诊断',
  'lcmg_get_document': '读取文档',
  'lcmg_batch_get': '批量读取',
  'lcmg_qmd_status': '记忆库状态',
  'lcmg_config_get': '读取配置',
  'lcmg_backup': '备份数据',
  'lcmg_sync': '同步数据',
  'lcmg_maintain': '维护任务',
};

/** 疲劳衰减阈值：连续未使用超过 N 轮后不再推荐 */
const FATIGUE_THRESHOLD = 3;

/** 渐进披露：前 N 轮不注入工具指引（让 agent 先专注理解任务） */
const PROGRESSIVE_DISCLOSURE_ROUNDS = 0;

/**
 * 构建智能工具指引（4 层策略）。
 *
 * 替代旧版硬编码 `## 记忆系统分工` 的常量注入。
 * 仅在以下条件之一满足时注入工具指引：
 *   1. 场景匹配到相关工具（L1）
 *   2. 已过渐进披露轮次且 agent 从未使用过工具（L2）
 * 不注入的情况：
 *   - agent 已使用过推荐工具 → 不再重复提示（L3）
 *   - 连续 3 轮未使用 → 疲劳衰减，不再提示（L4）
 *   - 高压力 tier → 不注入任何工具指引以节省上下文
 *
 * @param tier 压力层级（high 时直接返回空字符串）
 * @param scenario 当前场景（可为 null）
 * @param availableTools 可用工具列表
 * @param sessionKey 会话标识
 * @returns 工具指引字符串，空字符串表示本轮不注入
 */
export function buildSmartToolGuidance(
  tier: string,
  scenario: string | null,
  availableTools: string[],
  sessionKey: string,
): string {
  // 高压力模式：不注入任何工具指引，节省上下文
  if (tier === 'high') return '';

  const state = getTracker(sessionKey);

  // L2 渐进披露：前 N 轮不注入工具指引
  if (state.round <= PROGRESSIVE_DISCLOSURE_ROUNDS) return '';

  // 确定本轮候选工具
  let candidateTools: string[] = [];
  if (scenario && SCENARIO_TOOL_MAP[scenario]) {
    // L1 场景驱动：只取场景相关工具
    const availableSet = new Set(availableTools);
    candidateTools = SCENARIO_TOOL_MAP[scenario]
      .filter((t) => availableSet.has(t))
      .slice(0, 3);
  }

  // 如果场景未命中或没有可用工具，不注入
  if (candidateTools.length === 0) {
    state.lastHadGuidance = false;
    return '';
  }

  // L3+L4：过滤已使用和疲劳的工具
  const unusedTools = candidateTools.filter((tool) => {
    const relevantInjections = state.injections.filter((i) => i.tool === tool);
    // L3：已使用过 → 不再提示
    if (relevantInjections.some((i) => i.used)) return false;
    // L4：连续未使用超过阈值 → 疲劳衰减
    const unusedStreak = relevantInjections.reduce((streak, inj) => {
      return inj.used ? 0 : streak + 1;
    }, 0);
    return unusedStreak < FATIGUE_THRESHOLD;
  });

  if (unusedTools.length === 0) {
    state.lastHadGuidance = false;
    return '';
  }

  // 记录本轮注入
  for (const tool of unusedTools) {
    state.injections.push({ tool, round: state.round, used: false });
  }
  state.lastHadGuidance = true;

  // 构建简洁指引（仅工具名 + 简短描述，不展开全部工具列表）
  const lines = ['## 相关工具提示'];
  lines.push(
    '以下工具可能在当前场景有用。已自动注入的知识库通常已包含所需信息，',
    '优先基于已有上下文直接执行，仅在必要时使用工具。',
  );
  for (const tool of unusedTools) {
    const desc = TOOL_DESC_MAP[tool] ?? '';
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
