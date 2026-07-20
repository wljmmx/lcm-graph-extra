/**
 * CE 工具目录 —— 为 SDK 内置 toolSearch / directory 模式提供高质量检索元数据
 *
 * 架构原理：
 *   SDK 的 toolSearch 机制通过 tool_search / tool_describe / tool_call 三个控制工具
 *   动态发现和调用工具。directory 模式额外预 hydrate 评分最高的 N 个工具。
 *   CE 工具目录提供 tags + description，用于 tool_search 的语义匹配和 hydration 评分。
 *
 * 使用方式：
 *   - 注册到 SDK 的 toolSearch catalog 中（通过 toolMetadata 或客户端注册）
 *   - CE 的 assemble 钩子提供场景引导，帮助模型选择正确的搜索关键词
 */
export interface CeToolCatalogEntry {
  /** 工具名称 */
  name: string;
  /** 中文标签 */
  label: string;
  /** 搜索关键词（用于 tool_search 语义匹配） */
  tags: string[];
  /** 简短描述（用于 tool_search 结果和 hydration 评分） */
  description: string;
  /** 适用场景 */
  scenarios: string[];
  /** 工具类别 */
  category: string;
}

export const CE_TOOL_CATALOG: CeToolCatalogEntry[] = [
  // ===== 核心检索工具（高频使用） =====
  {
    name: "lcmg_search",
    label: "跨引擎搜索",
    tags: ["search", "find", "query", "检索", "搜索", "查找", "查询", "knowledge", "graph", "document", "qmd", "neo4j", "全文检索", "图谱检索"],
    description: "跨 QMD 全文索引和 Neo4j 知识图谱的联合搜索",
    scenarios: ["troubleshooting", "document_lookup", "knowledge_management", "maintenance"],
    category: "graph",
  },
  {
    name: "lcmg_experience_report",
    label: "经验报告",
    tags: ["experience", "report", "history", "经验", "报告", "历史", "排障", "troubleshooting", "lesson", "failure", "correction", "fix", "best_practice"],
    description: "检索历史排障经验，支持时间范围、标签、类型过滤，输出格式可选 text/json/markdown/pdf",
    scenarios: ["troubleshooting", "knowledge_management", "maintenance", "casual_conversation"],
    category: "experience",
  },
  {
    name: "lcmg_get_document",
    label: "文档获取",
    tags: ["document", "file", "read", "get", "fetch", "文档", "文件", "读取", "获取", "docid", "path", "content"],
    description: "通过路径或 docid 从 QMD 索引获取文档全文",
    scenarios: ["document_lookup", "troubleshooting"],
    category: "qmd",
  },
  {
    name: "lcmg_batch_get",
    label: "批量获取",
    tags: ["batch", "multi", "get", "fetch", "批量", "多个", "获取", "glob", "pattern", "documents", "files"],
    description: "批量获取文档，支持 glob 模式、逗号分隔路径或 docid 列表，最多 50 个",
    scenarios: ["document_lookup"],
    category: "qmd",
  },

  // ===== 诊断工具 =====
  {
    name: "lcmg_diagnose",
    label: "系统诊断",
    tags: ["diagnose", "health", "check", "status", "诊断", "健康", "检查", "状态", "troubleshoot", "debug", "排查", "problem"],
    description: "系统健康诊断分析，输出诊断报告",
    scenarios: ["troubleshooting", "maintenance"],
    category: "maintenance",
  },
  {
    name: "lcmg_qmd_status",
    label: "QMD 状态",
    tags: ["qmd", "status", "health", "index", "状态", "健康", "索引", "service", "ping", "uptime"],
    description: "查询 QMD MCP 服务健康状态：索引统计、集合元数据、运行时间",
    scenarios: ["troubleshooting", "maintenance"],
    category: "qmd",
  },

  // ===== 知识管理工具 =====
  {
    name: "lcmg_pin",
    label: "节点置顶",
    tags: ["pin", "unpin", "置顶", "取消置顶", "保留", "permanent", "知识", "knowledge", "node"],
    description: "置顶/取消置顶知识图谱节点，置顶节点不会被 TTL 清理",
    scenarios: ["knowledge_management", "troubleshooting"],
    category: "maintenance",
  },
  {
    name: "lcmg_forget",
    label: "主动遗忘",
    tags: ["forget", "delete", "remove", "遗忘", "删除", "废弃", "deprecate", "supersede", "soft", "hard", "过时", "outdated"],
    description: "遗忘或废弃知识图谱节点。soft 模式降权（仍可搜索），hard 模式标记废弃（排除搜索）",
    scenarios: ["knowledge_management"],
    category: "maintenance",
  },

  // ===== 运维管理工具 =====
  {
    name: "lcmg_maintain",
    label: "图谱维护",
    tags: ["maintain", "dedup", "pagerank", "community", "维护", "去重", "PageRank", "社区检测", "cleanup", "reconcile", "debt"],
    description: "触发知识图谱维护：去重、PageRank、社区检测，同时清理债务表",
    scenarios: ["maintenance"],
    category: "maintenance",
  },
  {
    name: "lcmg_compact",
    label: "上下文压缩",
    tags: ["compact", "compress", "压缩", "上下文", "context", "summarize", "摘要", "conversation"],
    description: "手动触发会话上下文压缩，处理最紧急的压缩债务",
    scenarios: ["troubleshooting", "knowledge_management", "high_pressure"],
    category: "maintenance",
  },
  {
    name: "lcmg_distill",
    label: "经验蒸馏",
    tags: ["distill", "蒸馏", "经验", "experience", "pending", "LLM", "extract", "提取", "结构化"],
    description: "手动触发经验蒸馏，将 PENDING 经验通过 LLM 提取为 DISTILLED 结构化经验",
    scenarios: ["knowledge_management", "maintenance"],
    category: "maintenance",
  },
  {
    name: "lcmg_distill_retry",
    label: "重试失败经验",
    tags: ["retry", "failed", "重试", "失败", "distill", "蒸馏", "reset", "重置", "pending"],
    description: "重置蒸馏失败的 FAILED 经验回 PENDING 状态，使其可重新蒸馏",
    scenarios: ["knowledge_management", "maintenance"],
    category: "maintenance",
  },
  {
    name: "lcmg_backfill",
    label: "经验回溯",
    tags: ["backfill", "回溯", "补录", "历史", "history", "conversation", "extract", "extract", "经验"],
    description: "从历史对话中重新提取经验写入 PENDING 队列，用于修复后补录丢失的经验",
    scenarios: ["knowledge_management", "maintenance"],
    category: "maintenance",
  },
  {
    name: "lcmg_reset_breaker",
    label: "熔断重置",
    tags: ["breaker", "circuit", "reset", "熔断", "重置", "lcm", "qmd", "neo4j", "reconnect", "重连"],
    description: "重置指定子系统（lcm/qmd/neo4j）的熔断器状态",
    scenarios: ["troubleshooting", "maintenance"],
    category: "maintenance",
  },

  // ===== 生命周期工具 =====
  {
    name: "lcmg_backup",
    label: "全量备份",
    tags: ["backup", "export", "备份", "导出", "json", "neo4j", "lcm", "memory", "full", "全量"],
    description: "全量备份：导出 Neo4j 节点关系、lossless-claw 对话、workspace 记忆文件到 JSON",
    scenarios: ["maintenance"],
    category: "lifecycle",
  },
  {
    name: "lcmg_restore",
    label: "数据恢复",
    tags: ["restore", "recover", "恢复", "还原", "backup", "json", "import", "导入", "neo4j", "lcm", "files"],
    description: "从备份 JSON 恢复到 Neo4j、lossless-claw 和记忆文件",
    scenarios: ["maintenance"],
    category: "lifecycle",
  },
  {
    name: "lcmg_import",
    label: "历史导入",
    tags: ["import", "导入", "历史", "history", "neo4j", "lcm", "messages", "memory", "files", "初始化"],
    description: "一次性导入历史数据到 Neo4j 知识图谱：对话消息或记忆文件",
    scenarios: ["maintenance"],
    category: "lifecycle",
  },
  {
    name: "lcmg_sync",
    label: "数据同步",
    tags: ["sync", "同步", "一致性", "consistency", "check", "repair", "检查", "修复", "orphan", "drift", "孤儿", "漂移"],
    description: "三端数据一致性检查和修复（lossless-claw ↔ Neo4j ↔ 文件），检测孤儿节点和时间戳漂移",
    scenarios: ["maintenance", "troubleshooting"],
    category: "lifecycle",
  },

  // ===== 配置工具 =====
  {
    name: "lcmg_config_get",
    label: "配置查看",
    tags: ["config", "get", "配置", "查看", "读取", "read", "settings", "参数", "runtime"],
    description: "查看运行时配置，敏感字段已脱敏，支持点分路径查询特定字段",
    scenarios: ["troubleshooting", "maintenance"],
    category: "config",
  },
  {
    name: "lcmg_config_set",
    label: "配置更新",
    tags: ["config", "set", "配置", "更新", "修改", "write", "update", "热更新", "hot", "reload"],
    description: "更新运行时配置（白名单控制），写入 openclaw.json，部分字段需重启生效",
    scenarios: ["troubleshooting", "maintenance"],
    category: "config",
  },

  // ===== MoA 工具 =====
  {
    name: "lcmg_moa_reply",
    label: "MoA 聚合回复",
    tags: ["moa", "mixture", "agents", "聚合", "多模型", "reply", "response", "回复", "参考模型", "aggregator"],
    description: "获取 MoA 多模型协作预计算的聚合回复，聚合进行中时返回 pending 状态",
    scenarios: ["casual_conversation"],
    category: "experience",
  },
];

/**
 * 场景 → 对应工具名称映射（用于 directory 模式的 hydration 引导）
 */
export const SCENARIO_TOOL_NAMES: Record<string, string[]> = {
  troubleshooting: [
    "lcmg_experience_report", "lcmg_diagnose", "lcmg_search",
    "lcmg_qmd_status", "lcmg_get_document", "lcmg_pin",
    "lcmg_forget", "lcmg_compact", "lcmg_reset_breaker",
    "lcmg_config_get", "lcmg_sync",
  ],
  document_lookup: [
    "lcmg_get_document", "lcmg_batch_get", "lcmg_search",
    "lcmg_experience_report", "lcmg_pin",
  ],
  knowledge_management: [
    "lcmg_pin", "lcmg_forget", "lcmg_experience_report",
    "lcmg_search", "lcmg_distill", "lcmg_distill_retry",
    "lcmg_backfill", "lcmg_compact",
  ],
  maintenance: [
    "lcmg_maintain", "lcmg_backup", "lcmg_restore",
    "lcmg_import", "lcmg_sync", "lcmg_diagnose",
    "lcmg_qmd_status", "lcmg_config_get", "lcmg_config_set",
    "lcmg_reset_breaker", "lcmg_compact",
  ],
  casual_conversation: [
    "lcmg_experience_report", "lcmg_search", "lcmg_moa_reply",
    "lcmg_compact", "lcmg_get_document",
  ],
  high_pressure: [
    "lcmg_experience_report", "lcmg_compact",
  ],
};

/**
 * 场景中文描述（用于 systemPromptAddition 场景引导）
 */
export const SCENARIO_LABELS: Record<string, string> = {
  troubleshooting: "故障排查与诊断",
  document_lookup: "文档查阅",
  knowledge_management: "知识管理",
  maintenance: "运维管理",
  casual_conversation: "日常对话",
  high_pressure: "上下文高压力",
};

/**
 * 场景 → 引导文本（CE 注入到 systemPromptAddition，帮助模型选择正确的搜索关键词）
 *
 * @deprecated 使用 buildModeAwareGuidance() 替代，支持 code/tools/directory 三种模式
 */
export const SCENARIO_GUIDANCE: Record<string, string> = {
  troubleshooting: "当前场景为故障排查。建议优先使用经验检索和诊断相关工具，搜索关键词可尝试 'diagnose'、'experience'、'status'、'breaker'。",
  document_lookup: "当前场景为文档查阅。建议优先使用文档获取和搜索工具，搜索关键词可尝试 'document'、'search'、'batch'、'get'。",
  knowledge_management: "当前场景为知识管理。建议优先使用节点管理、经验蒸馏和遗忘工具，搜索关键词可尝试 'pin'、'forget'、'distill'、'search'。",
  maintenance: "当前场景为运维管理。建议优先使用维护、备份、同步和配置工具，搜索关键词可尝试 'maintain'、'backup'、'restore'、'sync'、'config'。",
  casual_conversation: "当前为日常对话场景。优先基于已有上下文直接回答，仅在必要时使用经验检索或文档工具。",
  high_pressure: "⚠️ 上下文接近容量上限。请仅使用最必要的工具（经验检索、上下文压缩），避免不必要的工具调用。",
};

// ===================================================================
// 工具搜索模式检测（SDK toolSearch mode）
// ===================================================================

/**
 * SDK toolSearch 的三种模式。
 * - code: 模型仅看到 tool_search_code，通过编写 JS 代码调用工具
 * - tools: 模型看到 tool_search / tool_describe / tool_call，三步发现工具
 * - directory: 同 tools，但 SDK 预 hydrate 评分最高的 N 个工具
 * - legacy: 未启用 toolSearch，所有工具直接可见
 */
export type ToolSearchMode = "code" | "tools" | "directory" | "legacy";

/** 各模式下的控制工具名称 */
const MODE_CONTROL_TOOLS: Record<string, string[]> = {
  code: ["tool_search_code"],
  tools: ["tool_search", "tool_describe", "tool_call"],
  directory: ["tool_search", "tool_describe", "tool_call"],
  legacy: [],
};

/**
 * 根据 availableTools 中出现的控制工具推断当前 toolSearch 模式。
 * 无法区分 tools 和 directory（控制工具相同），默认返回 "tools"。
 */
export function detectToolSearchMode(availableTools: string[]): ToolSearchMode {
  const toolSet = new Set(availableTools);
  if (toolSet.has("tool_search_code")) return "code";
  if (toolSet.has("tool_search")) return "tools"; // 也可能是 directory，但从 CE 视角无法区分
  return "legacy";
}

// ===================================================================
// 各场景下的工具速查表（用于 code 模式）
// ===================================================================

/** 工具名 → 函数签名速查（code 模式注入，模型用此编写 tool_search_code 调用） */
const TOOL_CODE_REFERENCE: Record<string, string> = {
  lcmg_experience_report: "lcmg_experience_report({format?, tags?, limit?, from?, to?})",
  lcmg_search: "lcmg_search({query, engine?, limit?})",
  lcmg_diagnose: "lcmg_diagnose({})",
  lcmg_get_document: "lcmg_get_document({path?})",
  lcmg_batch_get: "lcmg_batch_get({paths, glob?})",
  lcmg_qmd_status: "lcmg_qmd_status({})",
  lcmg_pin: "lcmg_pin({node_ids, reason?})",
  lcmg_forget: "lcmg_forget({node_ids, mode?})",
  lcmg_compact: "lcmg_compact({})",
  lcmg_maintain: "lcmg_maintain({})",
  lcmg_distill: "lcmg_distill({})",
  lcmg_distill_retry: "lcmg_distill_retry({})",
  lcmg_backfill: "lcmg_backfill({from, to?})",
  lcmg_backup: "lcmg_backup({})",
  lcmg_restore: "lcmg_restore({path})",
  lcmg_import: "lcmg_import({source, type})",
  lcmg_sync: "lcmg_sync({})",
  lcmg_reset_breaker: "lcmg_reset_breaker({subsystem})",
  lcmg_config_get: "lcmg_config_get({key?})",
  lcmg_config_set: "lcmg_config_set({key, value})",
  lcmg_moa_reply: "lcmg_moa_reply({})",
};

// ===================================================================
// 模式感知的场景引导
// ===================================================================

interface ModeAwareGuidance {
  /** 模式标签（中文） */
  modeLabel: string;
  /** 引导文本 */
  guidance: string;
}

/**
 * 根据 toolSearch 模式和对话场景，生成自适应引导文本。
 *
 * 三种模式的核心差异：
 * ┌───────────┬──────────────────────────────────────────────────────┐
 * │ code      │ 模型写 JS 代码调用工具。CE 提供工具名+函数签名速查表  │
 * │           │ 让模型直接编写正确的调用代码，避免搜索开销。           │
 * ├───────────┼──────────────────────────────────────────────────────┤
 * │ tools     │ 模型三步发现工具。CE 提供搜索关键词和优先级建议，     │
 * │           │ 帮助模型用最少的搜索次数找到正确的工具。              │
 * ├───────────┼──────────────────────────────────────────────────────┤
 * │ directory │ 同 tools，但 SDK 已预加载场景相关工具。              │
 * │           │ CE 提示已加载工具可直接使用，减少重复搜索。           │
 * ├───────────┼──────────────────────────────────────────────────────┤
 * │ legacy    │ 所有工具直接可见。CE 提供场景相关的工具选择建议。     │
 * └───────────┴──────────────────────────────────────────────────────┘
 */
export function buildModeAwareGuidance(
  mode: ToolSearchMode,
  scenario: ConversationScenario,
  availableTools: string[],
): ModeAwareGuidance | null {
  const label = SCENARIO_LABELS[scenario] ?? scenario;
  const toolNames = SCENARIO_TOOL_NAMES[scenario] ?? [];

  switch (mode) {
    case "code":
      return buildCodeModeGuidance(label, toolNames);
    case "tools":
      return buildToolsModeGuidance(label, scenario, toolNames);
    case "directory":
      return buildDirectoryModeGuidance(label, scenario, toolNames, availableTools);
    case "legacy":
      return buildLegacyModeGuidance(label, scenario, toolNames);
    default:
      return null;
  }
}

/** code 模式：注入工具函数速查表 */
function buildCodeModeGuidance(
  label: string,
  toolNames: string[],
): ModeAwareGuidance {
  const refs = toolNames
    .filter((n) => TOOL_CODE_REFERENCE[n])
    .map((n) => `  ${TOOL_CODE_REFERENCE[n]}`)
    .join("\n");

  const guidance = refs
    ? `当前环境使用 tool_search_code 编写 JS 代码调用工具。\n场景相关工具函数速查:\n${refs}\n其他工具可通过 tool_search_code 搜索发现。`
    : `当前环境使用 tool_search_code 编写 JS 代码调用工具。请通过 tool_search_code 搜索当前场景所需工具。`;

  return { modeLabel: "code", guidance };
}

/** tools 模式：提供搜索关键词和优先级 */
function buildToolsModeGuidance(
  _label: string,
  scenario: ConversationScenario,
  toolNames: string[],
): ModeAwareGuidance {
  const keywords = getScenarioKeywords(scenario, toolNames);
  const priority = getScenarioPriority(scenario, toolNames.slice(0, 4));

  const guidance = `当前环境通过 tool_search 查找工具 → tool_describe 获取详情 → tool_call 执行调用。\n${keywords}\n${priority}`;

  return { modeLabel: "tools", guidance };
}

/** directory 模式：提示已预加载工具，减少重复搜索 */
function buildDirectoryModeGuidance(
  _label: string,
  scenario: ConversationScenario,
  toolNames: string[],
  availableTools: string[],
): ModeAwareGuidance {
  // 检测哪些场景工具已预加载（在 availableTools 中）
  const hydrated = toolNames.filter((n) => availableTools.includes(n));
  const notHydrated = toolNames.filter((n) => !availableTools.includes(n) && TOOL_CODE_REFERENCE[n]);

  const lines: string[] = [];
  lines.push("SDK 已预加载当前场景最相关的工具，可直接调用。");

  if (hydrated.length > 0) {
    lines.push(`已就绪: ${hydrated.slice(0, 6).join(", ")}`);
  }
  if (notHydrated.length > 0) {
    const keywords = getScenarioKeywords(scenario, notHydrated);
    lines.push(`如需其他工具，使用 tool_search 查找。${keywords}`);
  }

  return { modeLabel: "directory", guidance: lines.join("\n") };
}

/** legacy 模式：直接列出工具建议 */
function buildLegacyModeGuidance(
  _label: string,
  scenario: ConversationScenario,
  toolNames: string[],
): ModeAwareGuidance {
  if (scenario === "casual_conversation") {
    return {
      modeLabel: "legacy",
      guidance: "当前为日常对话场景。优先基于已有上下文直接回答，仅在必要时使用工具。",
    };
  }
  if (scenario === "high_pressure") {
    return {
      modeLabel: "legacy",
      guidance: "⚠️ 上下文接近容量上限。请仅使用最必要的工具（经验检索、上下文压缩），避免不必要的工具调用。",
    };
  }

  const top = toolNames.slice(0, 6).join(", ");
  return {
    modeLabel: "legacy",
    guidance: `当前场景下建议优先使用: ${top}。`,
  };
}

/** 生成场景搜索关键词 */
function getScenarioKeywords(scenario: ConversationScenario, toolNames: string[]): string {
  const keywordMap: Record<string, string> = {
    troubleshooting: "diagnose, experience, status, breaker, search, config, sync",
    document_lookup: "document, search, batch, get, experience, pin",
    knowledge_management: "pin, forget, distill, search, experience, backfill",
    maintenance: "maintain, backup, restore, sync, config, breaker, import",
    casual_conversation: "experience, search, document, moa",
    high_pressure: "experience, compact",
  };
  const kw = keywordMap[scenario] ?? "";
  return `建议搜索关键词: '${kw}'`;
}

/** 生成场景工具优先级 */
function getScenarioPriority(scenario: ConversationScenario, topTools: string[]): string {
  if (topTools.length === 0) return "";
  return `优先查找和执行顺序: ${topTools.join(" → ")}`;
}

// ===================================================================
// 场景识别
// ===================================================================

export type ConversationScenario =
  | "troubleshooting"
  | "document_lookup"
  | "knowledge_management"
  | "maintenance"
  | "casual_conversation"
  | "high_pressure";

interface ScenarioContext {
  messages: Array<{ role: string; content?: string | unknown }>;
  tier: string;
  availableTools: string[];
}

export function detectScenario(ctx: ScenarioContext): ConversationScenario {
  if (ctx.tier === "high" || ctx.tier === "critical") {
    return "high_pressure";
  }

  const recentUserMessages = extractRecentUserContent(ctx.messages, 3);

  if (matchesAny(recentUserMessages, [
    /报错|错误|error|失败|故障|异常|bug|崩溃|超时|timeout|崩溃/i,
    /排查|诊断|定位|修复|解决|为什么.*不行|怎么.*不工作/i,
    /circuit.*breaker|breaker.*open|熔断/i,
    /neo4j.*(?:连接|失败|错误)|连接.*neo4j/i,
    /检索.*(?:不到|失败|慢)|召回.*(?:不到|差)/i,
  ])) {
    return "troubleshooting";
  }

  if (matchesAny(recentUserMessages, [
    /文档|document|readme|代码|源码|文件|路径|path/i,
    /查看.*(?:文件|文档|代码)|打开.*(?:文件|文档)/i,
    /搜索.*(?:文件|文档)|查找.*(?:文件|文档)/i,
    /glob|docid|batch.*get/i,
  ])) {
    return "document_lookup";
  }

  if (matchesAny(recentUserMessages, [
    /记住|遗忘|忘记|置顶|pin|forget|废弃|过时|outdated/i,
    /知识.*(?:管理|更新|删除)|更新.*知识/i,
    /经验.*(?:提取|蒸馏|回溯)|distill|backfill/i,
    /supersede|deprecate/i,
  ])) {
    return "knowledge_management";
  }

  if (matchesAny(recentUserMessages, [
    /备份|恢复|导入|同步|维护|配置|backup|restore|import|sync|maintain|config/i,
    /重置.*熔断|熔断.*重置|reset.*breaker/i,
    /ttl.*clean|clean.*ttl|清理|cleanup/i,
  ])) {
    return "maintenance";
  }

  return "casual_conversation";
}

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