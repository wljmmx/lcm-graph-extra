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
  if (!tools) return ["lcmg_search","lcmg_experience_report","lcmg_backup","lcmg_restore","lcmg_import","lcmg_pin","lcmg_sync","lcmg_qmd_status","lcmg_get_document","lcmg_batch_get","lcmg_maintain","lcmg_diagnose"];
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
