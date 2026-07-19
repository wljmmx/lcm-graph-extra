/**
 * MoA 任务分类器 — 根据用户输入自动推荐预设
 *
 * 纯规则匹配，零 LLM 调用，延迟 < 1ms。
 * 分类优先级：/moa 命令显式指定 > 自动分类 > 默认配置
 */

export type TaskCategory = 'code-review' | 'architecture' | 'security';

export interface ClassificationResult {
  /** 推荐预设名，null 表示无法分类（回退默认） */
  preset: TaskCategory | null;
  /** 置信度 0-1 */
  confidence: number;
  /** 匹配理由 */
  reasons: string[];
  /** 针对该领域的 system prompt 补充上下文（注入参考模型，不覆盖模型选择） */
  context: string;
}

/**
 * 分类规则：按优先级排列，匹配到即停止。
 * 每个规则包含关键词列表和权重。
 */
const CLASSIFICATION_RULES: Array<{
  category: TaskCategory;
  keywords: RegExp[];
  weight: number;
}> = [
  // ── 安全审计 ──
  {
    category: 'security',
    keywords: [
      /安全/i, /漏洞/i, /注入/i, /injection/i, /XSS/i, /CSRF/i, /OWASP/i,
      /CWE/i, /权限/i, /认证/i, /授权/i, /加密/i, /encrypt/i, /解密/i,
      /审计/i, /audit/i, /攻击/i, /attack/i, /威胁/i, /threat/i,
      /GDPR/i, /SOC2/i, /合规/i, /compliance/i, /数据泄露/i, /隐私/i,
      /privacy/i, /SQL注入/i, /命令注入/i, /反序列化/i, /deserialization/i,
      /密钥/i, /secret/i, /token/i, /JWT/i, /OAuth/i, /SAML/i,
      /敏感信息/i, /脱敏/i, /sanitize/i, /escape/i, /白名单/i, /黑名单/i,
    ],
    weight: 1.0,
  },

  // ── 架构设计 ──
  {
    category: 'architecture',
    keywords: [
      /架构/i, /architecture/i, /设计模式/i, /design pattern/i,
      /系统设计/i, /system design/i, /模块划分/i, /技术选型/i,
      /微服务/i, /microservice/i, /单体/i, /monolith/i, /分布式/i,
      /distributed/i, /高可用/i, /HA/i, /可扩展/i, /scalable/i,
      /扩展性/i, /scalability/i, /解耦/i, /decouple/i, /耦合/i,
      /接口设计/i, /API设计/i, /API design/i, /数据模型/i,
      /database schema/i, /数据库设计/i, /ER图/i, /时序图/i,
      /架构图/i, /选型/i, /POC/i, /原型/i, /prototype/i,
      /消息队列/i, /MQ/i, /Kafka/i, /RabbitMQ/i, /事件驱动/i,
      /event-driven/i, /CQRS/i, /Event Sourcing/i, /DDD/i,
      /领域驱动/i, /分层/i, /分层架构/i, /六边形/i, /整洁架构/i,
    ],
    weight: 1.0,
  },

  // ── 代码审查 ──
  {
    category: 'code-review',
    keywords: [
      /代码审查/i, /code review/i, /review/i, /检查代码/i,
      /bug/i, /缺陷/i, /重构/i, /refactor/i, /优化/i, /optimize/i,
      /性能/i, /performance/i, /内存泄漏/i, /memory leak/i,
      /代码质量/i, /code quality/i, /lint/i, /规范/i, /convention/i,
      /命名/i, /naming/i, /注释/i, /comment/i, /文档/i, /document/i,
      /测试/i, /test/i, /单元测试/i, /unit test/i, /集成测试/i,
      /类型/i, /type/i, /TypeScript/i, /类型安全/i, /type safety/i,
      /异常处理/i, /error handling/i, /边界条件/i, /edge case/i,
      /空指针/i, /null/i, /undefined/i, /资源泄漏/i, /并发/i,
      /concurrency/i, /死锁/i, /deadlock/i, /竞态/i, /race condition/i,
      /复杂度/i, /complexity/i, /圈复杂度/i, /可读性/i, /readability/i,
      /可维护/i, /maintainable/i, /坏味道/i, /code smell/i,
    ],
    weight: 0.9, // 权重略低，避免"优化"等通用词误匹配
  },
];

/** 各领域分类上下文 —— 注入参考模型 user message 头部，帮助聚焦分析方向 */
const DOMAIN_CONTEXTS: Record<TaskCategory, string> = {
  security: '【安全审计模式】请从以下角度重点分析：OWASP Top 10 漏洞、认证授权缺陷、数据泄露风险、加密与密钥管理、注入攻击面、合规性（GDPR/SOC2）。',
  architecture: '【架构设计模式】请从以下角度重点分析：系统架构合理性、模块划分与解耦、技术选型适配性、可扩展性与高可用性、接口设计规范、数据模型与存储方案。',
  'code-review': '【代码审查模式】请从以下角度重点分析：代码质量与可读性、设计模式与架构合理性、潜在bug与边界条件、性能瓶颈与资源消耗、安全漏洞与异常处理、测试覆盖与可维护性。',
};

/**
 * 根据查询文本和上下文自动分类任务类型。
 *
 * @param query 用户查询文本
 * @param conversationContext 可选：最近对话上下文（用于用户画像）
 * @returns 分类结果，preset 为 null 表示无法分类
 */
export function classifyTaskType(
  query: string,
  conversationContext?: string,
): ClassificationResult {
  const scores: Record<TaskCategory, { score: number; matches: string[] }> = {
    security: { score: 0, matches: [] },
    architecture: { score: 0, matches: [] },
    'code-review': { score: 0, matches: [] },
  };

  const text = query + (conversationContext ? '\n' + conversationContext : '');

  for (const rule of CLASSIFICATION_RULES) {
    for (const kw of rule.keywords) {
      kw.lastIndex = 0;
      const match = kw.exec(text);
      if (match) {
        scores[rule.category].score += rule.weight;
        scores[rule.category].matches.push(match[0]);
      }
    }
  }

  // 找到最高分
  const entries = Object.entries(scores) as Array<[TaskCategory, { score: number; matches: string[] }]>;
  entries.sort((a, b) => b[1].score - a[1].score);

  const [topCategory, topResult] = entries[0];

  // 分数太低或没有匹配 → 无法分类
  if (topResult.score < 1.0) {
    return { preset: null, confidence: 0, reasons: [], context: '' };
  }

  // 计算置信度：最高分与第二高分的差距
  const secondScore = entries[1]?.[1].score ?? 0;
  const confidence = Math.min(
    1.0,
    topResult.score / (topResult.score + secondScore + 0.01),
  );

  return {
    preset: topCategory,
    confidence: Math.round(confidence * 100) / 100,
    reasons: [...new Set(topResult.matches)].slice(0, 5),
    context: DOMAIN_CONTEXTS[topCategory],
  };
}

/**
 * 根据分类结果获取配置中的预设名。
 * 如果分类结果匹配到预设（且预设存在），返回预设名；否则返回 null。
 *
 * @param classification 分类结果
 * @param availablePresets 可用预设名列表
 * @returns 预设名或 null
 */
export function resolveClassifiedPreset(
  classification: ClassificationResult,
  availablePresets: string[],
): string | null {
  if (!classification.preset) return null;
  if (classification.confidence < 0.5) return null;
  if (availablePresets.includes(classification.preset)) return classification.preset;
  return null;
}