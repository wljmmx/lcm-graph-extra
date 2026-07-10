/**
 * Tool-aware retrieval strategy helpers
 *
 * 根据 assemble params.availableTools 判断可用工具类别，
 * 决定是否注入工具指引到 systemPromptAddition。
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
