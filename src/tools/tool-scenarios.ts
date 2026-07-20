/**
 * 场景感知工具策略 —— CE 根据对话上下文动态决策可用工具集
 *
 * 架构原理：
 *   SDK 不支持 per-turn 动态工具过滤（描述符缓存后永久复用），
 *   CE 通过 systemPromptAddition 注入结构化工具策略，引导模型行为。
 *   模型遵从系统提示词中的指令，等效于"软过滤"。
 */

// ===================================================================
// 场景定义
// ===================================================================

export type ConversationScenario =
  | "troubleshooting"    // 排障诊断
  | "document_lookup"    // 文档查询
  | "knowledge_management" // 知识管理
  | "maintenance"        // 运维管理
  | "casual_conversation" // 日常对话
  | "high_pressure";     // 上下文压力

// ===================================================================
// 场景 → 推荐工具映射
// ===================================================================

const SCENARIO_TOOLS: Record<ConversationScenario, string[]> = {
  troubleshooting: [
    "lcmg_experience_report",
    "lcmg_diagnose",
    "lcmg_search",
    "lcmg_qmd_status",
    "lcmg_get_document",
    "lcmg_pin",
    "lcmg_forget",
    "lcmg_compact",
  ],
  document_lookup: [
    "lcmg_get_document",
    "lcmg_batch_get",
    "lcmg_search",
    "lcmg_experience_report",
    "lcmg_pin",
    "lcmg_compact",
  ],
  knowledge_management: [
    "lcmg_pin",
    "lcmg_forget",
    "lcmg_experience_report",
    "lcmg_search",
    "lcmg_compact",
  ],
  maintenance: [
    "lcmg_experience_report",
    "lcmg_search",
    "lcmg_diagnose",
    "lcmg_qmd_status",
    "lcmg_compact",
  ],
  casual_conversation: [
    "lcmg_experience_report",
    "lcmg_search",
    "lcmg_compact",
  ],
  high_pressure: [
    "lcmg_experience_report",
    "lcmg_compact",
  ],
};

// ===================================================================
// 工具职责说明（用于生成引导文本）
// ===================================================================

const TOOL_ROLES: Record<string, string> = {
  lcmg_experience_report: "检索历史排障经验",
  lcmg_search: "跨引擎联合搜索",
  lcmg_diagnose: "系统健康诊断",
  lcmg_pin: "置顶/取消置顶知识节点",
  lcmg_forget: "废弃/降权过时知识",
  lcmg_compact: "压缩会话上下文",
  lcmg_moa_reply: "获取 MoA 多模型聚合回复",
  lcmg_get_document: "获取单个文档内容",
  lcmg_batch_get: "批量获取文档",
  lcmg_qmd_status: "QMD 索引健康检查",
};

// ===================================================================
// 场景识别
// ===================================================================

interface ScenarioContext {
  messages: Array<{ role: string; content?: string | unknown }>;
  tier: string;
  availableTools: string[];
  userProfile?: { role?: string } | null;
}

export function detectScenario(ctx: ScenarioContext): ConversationScenario {
  // 高压力优先
  if (ctx.tier === "high" || ctx.tier === "critical") {
    return "high_pressure";
  }

  // 提取最近用户消息
  const recentUserMessages = extractRecentUserContent(ctx.messages, 3);

  // 排障关键词
  if (matchesAny(recentUserMessages, [
    /报错|错误|error|失败|故障|异常|bug|崩溃|超时|timeout|崩溃/i,
    /排查|诊断|定位|修复|解决|为什么.*不行|怎么.*不工作/i,
    /circuit.*breaker|breaker.*open|熔断/i,
    /neo4j.*(?:连接|失败|错误)|连接.*neo4j/i,
    /检索.*(?:不到|失败|慢)|召回.*(?:不到|差)/i,
  ])) {
    return "troubleshooting";
  }

  // 文档查询关键词
  if (matchesAny(recentUserMessages, [
    /文档|document|readme|代码|源码|文件|路径|path/i,
    /查看.*(?:文件|文档|代码)|打开.*(?:文件|文档)/i,
    /搜索.*(?:文件|文档)|查找.*(?:文件|文档)/i,
    /glob|docid|batch.*get/i,
  ])) {
    return "document_lookup";
  }

  // 知识管理关键词
  if (matchesAny(recentUserMessages, [
    /记住|遗忘|忘记|置顶|pin|forget|废弃|过时|outdated/i,
    /知识.*(?:管理|更新|删除)|更新.*知识/i,
    /经验.*(?:提取|蒸馏|回溯)|distill|backfill/i,
    /supersede|deprecate/i,
  ])) {
    return "knowledge_management";
  }

  // 运维管理关键词
  if (matchesAny(recentUserMessages, [
    /备份|恢复|导入|同步|维护|配置|backup|restore|import|sync|maintain|config/i,
    /重置.*熔断|熔断.*重置|reset.*breaker/i,
    /ttl.*clean|clean.*ttl|清理|cleanup/i,
  ])) {
    return "maintenance";
  }

  // 默认：日常对话
  return "casual_conversation";
}

// ===================================================================
// 生成工具策略文本
// ===================================================================

export function buildToolPolicy(scenario: ConversationScenario): string {
  const activeTools = SCENARIO_TOOLS[scenario];
  const inactiveTools = Object.keys(TOOL_ROLES).filter(
    (t) => !activeTools.includes(t)
  );

  const activeList = activeTools
    .map((t) => `  - ${t}: ${TOOL_ROLES[t] || ""}`)
    .join("\n");

  const inactiveList = inactiveTools.length > 0
    ? inactiveTools.map((t) => `  - ${t}: ${TOOL_ROLES[t] || ""}`).join("\n")
    : "  (none)";

  const scenarioLabels: Record<ConversationScenario, string> = {
    troubleshooting: "排障诊断",
    document_lookup: "文档查询",
    knowledge_management: "知识管理",
    maintenance: "运维管理",
    casual_conversation: "日常对话",
    high_pressure: "上下文压力（最小工具集）",
  };

  return [
    `[Context Engine - Tool Policy]`,
    `Scenario: ${scenarioLabels[scenario]}`,
    ``,
    `Active tools (use these):`,
    activeList,
    ``,
    `Inactive tools (avoid unless necessary):`,
    inactiveList,
    scenario === "high_pressure"
      ? `\nCRITICAL: Context is near overflow. Use only the Active tools to minimize token usage.`
      : `\nIf you need an Inactive tool, explain briefly and the CE will consider activating it.`,
  ].join("\n");
}

// ===================================================================
// 辅助函数
// ===================================================================

function extractRecentUserContent(
  messages: Array<{ role: string; content?: string | unknown }>,
  count: number,
): string[] {
  const userMessages: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMessages.length < count; i--) {
    const msg = messages[i];
    if (msg?.role === "user" && typeof msg.content === "string") {
      userMessages.push(msg.content);
    }
  }
  return userMessages.reverse();
}

function matchesAny(texts: string[], patterns: RegExp[]): boolean {
  return texts.some((text) => patterns.some((p) => p.test(text)));
}