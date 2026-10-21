/**
 * Experience abstraction types — Layer 4 knowledge layer.
 *
 * 经验是独立于消息 DAG、记忆文件、知识图谱的第四层抽象。
 * 仅在特定场景（用户纠正/任务失败/修复成功）触发提取，
 * 并在 dreaming / cron 批次总结。
 */

/** 经验原始来源 */
export type ExperienceSource = 'correction' | 'failure' | 'fix_success' | 'explicit_save';

/**
 * Harnessing P1: 经验作用域 —— 对齐 Harness²（arXiv:2610.14224）的 invariant / domain 二分。
 *
 *   invariant —— 跨领域通用教训，常驻注入（存量数据的缺省语义，保持历史行为不变）
 *   domain    —— 领域特定教训，仅在场景标签命中时注入（防止跨任务泄漏，反过拟合）
 */
export type ExperienceScope = 'invariant' | 'domain';

/**
 * Harnessing P1: 经验证据链 —— 记录经验由哪次行为对比产生（可审计）。
 * 由 harnessing 的 Propose–Probe–Compose 步骤采纳后写入。
 */
export interface ExperienceEvidence {
  /** 产生该经验的探测步骤 ID（runHarnessingStep 的 stepId） */
  probeId?: string;
  /** 基线探针得分（0~1，命中率） */
  baseline?: number;
  /** 候选探针得分（0~1，命中率） */
  candidate?: number;
  /** 行为对比差值（candidate - baseline） */
  contrast?: number;
  /** 源轨迹引用（失败信号来源，如 工具名/diagnose/会话 ID） */
  trajectoryRef?: string;
  /** 采纳时间（ISO 字符串，Neo4j 属性友好） */
  adoptedAt?: string;
}

/** 经验原始记录（afterTurn 提取后写入） */
export interface RawExperience {
  id: string;                    // uuid
  source: ExperienceSource;
  sessionId: string;
  timestamp: Date;
  context: string;               // 触发时的简短上下文描述
  detail: string;                // 原始消息内容片段
  projectName?: string;          // 归属项目
  taskId?: string;               // 归属任务
}

/** 场景维度标签 */
export type ScenarioTag =
  | 'bug-fix'
  | 'feature-dev'
  | 'code-review'
  | 'config-debug'
  | 'deployment'
  | 'performance-opt'
  | 'security-audit'
  | 'refactor';

/** 技术栈维度标签 */
export type TechStackTag =
  | 'frontend'
  | 'backend'
  | 'devops'
  | 'database'
  | 'mobile'
  | 'ai-ml'
  | 'infrastructure'
  | 'general';

/** 经验多维度标签 */
export interface ExperienceTags {
  scenario?: ScenarioTag[];      // 场景类型
  techStack?: TechStackTag[];    // 技术栈
  severity?: 'critical' | 'major' | 'minor';  // 严重程度（通用性参考）
  freeTags?: string[];               // 开放标签池（自动提取，未归类前的自由标签）
}

/** 精炼后的经验（dreaming/cron 总结后） */
export interface DistilledExperience {
  id: string;
  rawIds: string[];              // 关联的原始经验 ID
  type: 'correction' | 'failure' | 'fix' | 'lesson' | 'best_practice';
  title: string;                 // 精炼摘要标题
  summary: string;               // 精炼摘要（200-500 字）
  detail: string;                // 完整经验描述
  context: string;               // 适用场景
  projectName?: string;
  tags?: ExperienceTags;         // 多维标签（场景 + 技术栈 + 严重度）
  relevanceScore: number;        // 0.0 ~ 1.0
  createdAt: Date;
  expiresAt?: Date;              // TTL
  matchCount: number;            // 被命中间接召回次数
  relatedIds?: string[];         // S-11': Zettelkasten 关联 — 相关经验 ID 列表
  /** Harnessing P1: 作用域。缺省（undefined）按 'invariant' 处理 —— 存量数据行为完全不变 */
  scope?: ExperienceScope;
  /** Harnessing P1: 证据链（由 harnessing 探测采纳后写入，可审计） */
  evidence?: ExperienceEvidence;
}

/** Neo4j 存储格式 */
export interface ExperienceNode {
  id: string;
  labels: string[];              // ['EXPERIENCE', 'Correction'] etc
  properties: Record<string, unknown>;
}

/** Query-aware 搜索参数 */
export interface ExperienceQueryOptions {
  query?: string;                // 查询文本（用于关键词匹配）
  scenarioTags?: ScenarioTag[];  // 场景过滤
  techStackTags?: TechStackTag[];// 技术栈过滤
  freeTags?: string[];              // 自由标签（开放词汇匹配）
  projects?: string[];          // S-6': 项目名过滤（软过滤，命中任一即可）
  minScore?: number;             // 最低相关性分数
  limit?: number;                // 返回上限
  halfLifeDays?: number;         // C-1: matchCount 时间衰减半衰期（天），默认 30
}

export interface ExperienceSearchResult {
  experience: DistilledExperience;
  score: number;                 // 混合打分：静态 relevanceScore + 动态 query 匹配
}


// ---------------------------------------------------------------------------
/** 动态标签注册表条目 */
export interface DynamicTag {
  id: string;                          // unique slug, e.g. "microservice-migration"
  label: string;                       // 人类可读名称, e.g. "微服务迁移"
  category: 'scenario' | 'techStack';  // 标签维度
  keywords: string[];                  // 匹配关键词（正则或子串）
  confidence: number;                  // 聚类置信度 0~1，>0.7 视为正式标签
  freeTagCount: number;                // 被自由标注的次数（用于升格判断）
  createdAt: Date;
}

/** Tag Registry 查询结果 */
export interface TagRegistryResult {
  tags: DynamicTag[];
  scenarioPatterns: Array<{ pattern: RegExp; tag: string }>;
  techStackPatterns: Array<{ pattern: RegExp; tag: string }>;
}
