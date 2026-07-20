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
  lcmg_experience_report: "lcmg_experience_report({format?, limit?, tag?, from?, to?})",
  lcmg_search: "lcmg_search({query, engines?, limit?})",
  lcmg_diagnose: "lcmg_diagnose({})",
  lcmg_get_document: "lcmg_get_document({file})",
  lcmg_batch_get: "lcmg_batch_get({pattern})",
  lcmg_qmd_status: "lcmg_qmd_status({})",
  lcmg_pin: "lcmg_pin({id, unpin?})",
  lcmg_forget: "lcmg_forget({id?, query?, mode?, confirm?})",
  lcmg_compact: "lcmg_compact({conversationId?})",
  lcmg_maintain: "lcmg_maintain({})",
  lcmg_distill: "lcmg_distill({limit?})",
  lcmg_distill_retry: "lcmg_distill_retry({mode?})",
  lcmg_backfill: "lcmg_backfill({limit?})",
  lcmg_backup: "lcmg_backup({outputPath?})",
  lcmg_restore: "lcmg_restore({backupPath, targets?})",
  lcmg_import: "lcmg_import({source, limit?})",
  lcmg_sync: "lcmg_sync({mode?})",
  lcmg_reset_breaker: "lcmg_reset_breaker({name})",
  lcmg_config_get: "lcmg_config_get({path?})",
  lcmg_config_set: "lcmg_config_set({path, value})",
  lcmg_moa_reply: "lcmg_moa_reply({})",
};

// ===================================================================
// 全量工具命名空间分类
// ===================================================================

/**
 * 工具命名空间元信息。
 * CE 通过命名空间前缀对所有工具（包括非 LCM 工具）进行分类和引导。
 */
interface ToolNamespaceInfo {
  /** 命名空间前缀 */
  prefix: string;
  /** 中文标签 */
  label: string;
  /** 简要说明（模型可见） */
  description: string;
  /** 典型场景 */
  scenarios: string[];
}

/** 已知命名空间（按前缀匹配） */
const KNOWN_NAMESPACES: ToolNamespaceInfo[] = [
  { prefix: "lcmg_", label: "LCM 知识引擎", description: "知识图谱、经验管理、文档检索、系统诊断", scenarios: ["troubleshooting", "document_lookup", "knowledge_management", "maintenance"] },
  { prefix: "memory_", label: "记忆系统", description: "对话记忆、长期记忆存储与检索", scenarios: ["knowledge_management", "casual_conversation"] },
  { prefix: "drive_", label: "云存储", description: "文件上传、下载、管理", scenarios: ["document_lookup", "maintenance"] },
  { prefix: "browser_", label: "浏览器", description: "网页浏览、截图、自动化", scenarios: ["troubleshooting", "document_lookup"] },
  { prefix: "canvas_", label: "画布", description: "可视化创作、图表绘制", scenarios: ["casual_conversation", "document_lookup"] },
  { prefix: "xai_", label: "xAI", description: "AI 模型推理与解释", scenarios: ["troubleshooting", "casual_conversation"] },
  { prefix: "file_", label: "文件传输", description: "文件收发、格式转换", scenarios: ["document_lookup", "maintenance"] },
  { prefix: "wiki_", label: "Wiki", description: "知识库文档管理", scenarios: ["document_lookup", "knowledge_management"] },
  { prefix: "workboard_", label: "工作台", description: "任务管理、看板协作", scenarios: ["casual_conversation", "maintenance"] },
  { prefix: "codex_", label: "Codex", description: "代码审查、监督执行", scenarios: ["troubleshooting", "maintenance"] },
];

/** 系统控制工具（非命名空间工具） */
const SYSTEM_TOOL_PREFIXES = ["tool_", "task_", "agent_"];

/** 分类结果 */
interface ToolClassification {
  /** 命名空间 → 工具名列表 */
  byNamespace: Map<string, { info: ToolNamespaceInfo; tools: string[] }>;
  /** 系统工具 */
  systemTools: string[];
  /** 未识别工具 */
  unrecognized: string[];
  /** 全量工具总数 */
  total: number;
  /** 命名空间数量 */
  namespaceCount: number;
}

/**
 * 对全量 availableTools 进行命名空间分类。
 * 过滤掉 SDK 控制工具（tool_search 等），保留业务工具。
 */
export function classifyAllTools(availableTools: string[]): ToolClassification {
  const byNamespace = new Map<string, { info: ToolNamespaceInfo; tools: string[] }>();
  const systemTools: string[] = [];
  const unrecognized: string[] = [];
  const controlToolSet = new Set([
    "tool_search_code", "tool_search", "tool_describe", "tool_call",
  ]);

  for (const name of availableTools) {
    // 跳过 SDK 控制工具
    if (controlToolSet.has(name)) continue;

    // 系统工具
    if (SYSTEM_TOOL_PREFIXES.some((p) => name.startsWith(p))) {
      systemTools.push(name);
      continue;
    }

    // 命名空间匹配
    const ns = KNOWN_NAMESPACES.find((n) => name.startsWith(n.prefix));
    if (ns) {
      const entry = byNamespace.get(ns.prefix);
      if (entry) {
        entry.tools.push(name);
      } else {
        byNamespace.set(ns.prefix, { info: ns, tools: [name] });
      }
    } else {
      unrecognized.push(name);
    }
  }

  return {
    byNamespace,
    systemTools,
    unrecognized,
    total: availableTools.length - controlToolSet.size,
    namespaceCount: byNamespace.size + (systemTools.length > 0 ? 1 : 0) + (unrecognized.length > 0 ? 1 : 0),
  };
}

/**
 * 生成 Layer 1: 全量工具分类概览（极简，~50-100 tokens）
 */
function buildToolOverview(classification: ToolClassification): string {
  const parts: string[] = [];

  for (const [, { info, tools }] of classification.byNamespace) {
    if (tools.length > 0) {
      parts.push(`${info.label}(${tools.length})`);
    }
  }
  if (classification.systemTools.length > 0) {
    parts.push(`系统(${classification.systemTools.length})`);
  }

  return parts.length > 0 ? `工具分类: ${parts.join(" ")}` : "";
}

// ===================================================================
// 模式感知的场景引导（v2：全量工具覆盖）
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
 * 三层引导结构：
 *   Layer 1: 全量工具分类概览（所有命名空间，模型认知对齐）
 *   Layer 2: 场景相关工具建议（LCM 详细 + 非 LCM 按类别）
 *   Layer 3: 搜索/调用细节（仅 LCM 工具，CE 深度掌握）
 *
 * 四种模式的核心差异：
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
  const classification = classifyAllTools(availableTools);
  const lcmToolNames = SCENARIO_TOOL_NAMES[scenario] ?? [];
  // 当前场景下相关的非 LCM 命名空间
  const relevantNamespaces = KNOWN_NAMESPACES.filter(
    (ns) => ns.prefix !== "lcmg_" && ns.scenarios.includes(scenario),
  );

  switch (mode) {
    case "code":
      return buildCodeModeGuidanceV2(label, lcmToolNames, classification, relevantNamespaces);
    case "tools":
      return buildToolsModeGuidanceV2(label, scenario, lcmToolNames, classification, relevantNamespaces);
    case "directory":
      return buildDirectoryModeGuidanceV2(label, scenario, lcmToolNames, availableTools, classification, relevantNamespaces);
    case "legacy":
      return buildLegacyModeGuidanceV2(label, scenario, lcmToolNames, classification, relevantNamespaces);
    default:
      return null;
  }
}

/** code 模式：注入工具函数速查表 + 全量工具概览 */
function buildCodeModeGuidanceV2(
  _label: string,
  lcmToolNames: string[],
  classification: ToolClassification,
  relevantNamespaces: ToolNamespaceInfo[],
): ModeAwareGuidance {
  const lines: string[] = [];

  // Layer 1: 全量工具概览
  lines.push(buildToolOverview(classification));

  // Layer 2: 非 LCM 相关工具提示
  const nonLcmHints = buildNonLcmHints(classification, relevantNamespaces);
  if (nonLcmHints) lines.push(nonLcmHints);

  // Layer 3: LCM 工具速查表
  const refs = lcmToolNames
    .filter((n) => TOOL_CODE_REFERENCE[n])
    .map((n) => `  ${TOOL_CODE_REFERENCE[n]}`)
    .join("\n");

  if (refs) {
    lines.push(`当前环境使用 tool_search_code 编写 JS 代码调用工具。\nLCM 工具速查:\n${refs}`);
  } else {
    lines.push("当前环境使用 tool_search_code 编写 JS 代码调用工具。");
  }
  lines.push("其他工具可通过 tool_search_code 搜索发现。");

  return { modeLabel: "code", guidance: lines.join("\n") };
}

/** tools 模式：搜索关键词 + 优先级 + 全量工具概览 */
function buildToolsModeGuidanceV2(
  _label: string,
  scenario: ConversationScenario,
  lcmToolNames: string[],
  classification: ToolClassification,
  relevantNamespaces: ToolNamespaceInfo[],
): ModeAwareGuidance {
  const lines: string[] = [];

  // Layer 1: 全量工具概览
  lines.push(buildToolOverview(classification));

  // Layer 2: 非 LCM 相关工具提示
  const nonLcmHints = buildNonLcmHints(classification, relevantNamespaces);
  if (nonLcmHints) lines.push(nonLcmHints);

  // Layer 3: LCM 搜索指引
  const keywords = getScenarioKeywords(scenario, lcmToolNames);
  const priority = getScenarioPriority(scenario, lcmToolNames.slice(0, 4));
  lines.push(`通过 tool_search 查找工具 → tool_describe 获取详情 → tool_call 执行调用。`);
  lines.push(keywords);
  if (priority) lines.push(priority);

  return { modeLabel: "tools", guidance: lines.join("\n") };
}

/** directory 模式：已就绪工具 + 补充搜索 + 全量工具概览 */
function buildDirectoryModeGuidanceV2(
  _label: string,
  scenario: ConversationScenario,
  lcmToolNames: string[],
  availableTools: string[],
  classification: ToolClassification,
  relevantNamespaces: ToolNamespaceInfo[],
): ModeAwareGuidance {
  const lines: string[] = [];

  // Layer 1: 全量工具概览
  lines.push(buildToolOverview(classification));

  // Layer 2: 非 LCM 相关工具提示
  const nonLcmHints = buildNonLcmHints(classification, relevantNamespaces);
  if (nonLcmHints) lines.push(nonLcmHints);

  // Layer 3: LCM 已就绪 / 补充搜索
  const hydrated = lcmToolNames.filter((n) => availableTools.includes(n));
  const notHydrated = lcmToolNames.filter((n) => !availableTools.includes(n) && TOOL_CODE_REFERENCE[n]);

  if (hydrated.length > 0) {
    lines.push(`SDK 已预加载: ${hydrated.slice(0, 6).join(", ")}`);
  }
  if (notHydrated.length > 0) {
    const keywords = getScenarioKeywords(scenario, notHydrated);
    lines.push(`如需其他 LCM 工具，使用 tool_search 查找。${keywords}`);
  }

  return { modeLabel: "directory", guidance: lines.join("\n") };
}

/** legacy 模式：全量工具概览 + 场景工具建议 */
function buildLegacyModeGuidanceV2(
  _label: string,
  scenario: ConversationScenario,
  lcmToolNames: string[],
  classification: ToolClassification,
  relevantNamespaces: ToolNamespaceInfo[],
): ModeAwareGuidance {
  const lines: string[] = [];

  // Layer 1: 全量工具概览
  lines.push(buildToolOverview(classification));

  // high_pressure / casual 场景特殊处理
  if (scenario === "casual_conversation") {
    lines.push("优先基于已有上下文直接回答，仅在必要时使用工具。");
    return { modeLabel: "legacy", guidance: lines.join("\n") };
  }
  if (scenario === "high_pressure") {
    lines.push("⚠️ 上下文接近容量上限。仅使用最必要的工具，避免不必要的工具调用。");
    return { modeLabel: "legacy", guidance: lines.join("\n") };
  }

  // Layer 2: 非 LCM 相关工具提示
  const nonLcmHints = buildNonLcmHints(classification, relevantNamespaces);
  if (nonLcmHints) lines.push(nonLcmHints);

  // Layer 3: LCM 工具建议
  const top = lcmToolNames.slice(0, 6).join(", ");
  lines.push(`LCM 工具建议: ${top}。`);

  return { modeLabel: "legacy", guidance: lines.join("\n") };
}

/**
 * 生成非 LCM 命名空间提示（按场景相关性）。
 * 例如故障排查场景: "也可能需要: 浏览器(2), Codex(1)"
 */
function buildNonLcmHints(
  classification: ToolClassification,
  relevantNamespaces: ToolNamespaceInfo[],
): string {
  const hints: string[] = [];
  for (const ns of relevantNamespaces) {
    const entry = classification.byNamespace.get(ns.prefix);
    if (entry && entry.tools.length > 0) {
      hints.push(`${ns.label}(${entry.tools.length})`);
    }
  }
  return hints.length > 0 ? `也可能需要: ${hints.join(" ")}` : "";
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