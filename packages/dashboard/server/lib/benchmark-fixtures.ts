/**
 * Benchmark 标准测试集（v2.3.0 重构）。
 *
 * 测试集分类：
 * 1. project-scenarios（项目场景集）：21 条，覆盖 6 个分类，基于本项目实际场景
 * 2. ce-multi-turn（CE 多轮会话集）：基于 lossless-claw 能力维度设计，
 *    测试 CE 引擎在多轮对话上下文累积、压缩触发、token 压力下的召回表现
 *
 * 设计原则：
 * - project-scenarios：单轮查询，覆盖典型用户场景（知识/经验/错误/配置/多语言/复合）
 * - ce-multi-turn：多轮会话序列，每条 fixture 是一个会话，含多轮 query 序列
 *   参考 lossless-claw 的 ingest/compact/assemble 能力维度：
 *   - 上下文累积：随轮次增加，相关上下文应在检索结果中累积
 *   - 压缩触发：长会话应触发 DAG 压缩，token 节省
 *   - 召回衰减：时间衰减（halfLife 30d）影响旧轮次相关性
 *
 * 召回率评估为可选：提供 expectedDocIds 的用例才计算 recall/precision/F1。
 * BEIR 标准测试集（NFCorpus + SciFact）通过 benchmark-beir.ts 单独加载。
 */

export type FixtureCategory =
  | 'knowledge'
  | 'experience'
  | 'error'
  | 'config'
  | 'multilingual'
  | 'mixed';

/** 测试集来源标识 */
export type FixtureSetId = 'project-scenarios' | 'ce-multi-turn' | 'beir-nfcorpus' | 'beir-scifact';

/** 单轮查询 fixture（project-scenarios 使用） */
export interface BenchmarkFixture {
  /** 用例唯一 ID */
  id: string;
  /** 测试查询文本 */
  query: string;
  /** 查询意图分类（用于分组统计） */
  category: FixtureCategory;
  /** 搜索类型组合（默认 lex+vec hybrid） */
  searches?: Array<{ type: 'lex' | 'vec' | 'hyde'; query?: string }>;
  /** 期望返回的文档 docid 列表（可选，用于召回率评估） */
  expectedDocIds?: string[];
  /** 期望结果数下限（可选，用于基本断言） */
  minExpectedResults?: number;
  /** 用例描述 */
  description?: string;
}

/** 多轮会话 fixture（ce-multi-turn 使用） */
export interface MultiTurnFixture {
  /** 用例唯一 ID */
  id: string;
  /** 会话主题分类 */
  category: FixtureCategory;
  /** 会话描述 */
  description?: string;
  /** 多轮查询序列（按时间顺序） */
  turns: Array<{
    /** 轮次查询文本 */
    query: string;
    /** 该轮期望命中的 docids（可选，用于召回率评估） */
    expectedDocIds?: string[];
    /** 该轮期望结果数下限 */
    minExpectedResults?: number;
    /** 该轮的上下文角色（用于多轮连贯性分析） */
    role?: 'opening' | 'followup' | 'clarify' | 'recall' | 'compress';
    /** 该轮描述（可选，用于报告展示） */
    description?: string;
  }>;
  /** 会话级期望：压缩应触发的轮次（可选） */
  expectCompressionAtTurn?: number;
  /** 会话级期望：token 压力分级应达到的等级（可选） */
  expectPressureTier?: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// 1. project-scenarios（项目场景集）—— 21 条单轮查询
// ---------------------------------------------------------------------------

export const PROJECT_SCENARIO_FIXTURES: BenchmarkFixture[] = [
  {
    id: 'kb-001',
    query: '知识图谱检索原理',
    category: 'knowledge',
    description: '基础知识检索 — 中文短查询',
    minExpectedResults: 1,
  },
  {
    id: 'kb-002',
    query: 'how does vector embedding work',
    category: 'knowledge',
    description: '基础知识检索 — 英文短查询',
    minExpectedResults: 1,
  },
  {
    id: 'kb-003',
    query: '记忆系统的压缩和召回机制',
    category: 'knowledge',
    description: '复合概念查询 — 中文',
    minExpectedResults: 1,
  },
  {
    id: 'exp-001',
    query: '之前遇到过的 Neo4j 连接超时问题怎么解决的',
    category: 'experience',
    description: '经验查询 — 问题排查',
    minExpectedResults: 0,
  },
  {
    id: 'exp-002',
    query: 'QMD 检索引擎性能优化经验',
    category: 'experience',
    description: '经验查询 — 性能优化',
    minExpectedResults: 0,
  },
  {
    id: 'exp-003',
    query: 'dashboard 接口报错排查步骤',
    category: 'experience',
    description: '经验查询 — 故障排查',
    minExpectedResults: 0,
  },
  {
    id: 'err-001',
    query: 'Dimension mismatch for query vector embedding column',
    category: 'error',
    description: '错误信息检索 — embedding 维度错误',
    minExpectedResults: 0,
  },
  {
    id: 'err-002',
    query: 'SQLITE_CANTOPEN unable to open database file',
    category: 'error',
    description: '错误信息检索 — sqlite 错误',
    minExpectedResults: 0,
  },
  {
    id: 'err-003',
    query: 'MCP initialize timeout aborted',
    category: 'error',
    description: '错误信息检索 — MCP 超时',
    minExpectedResults: 0,
  },
  {
    id: 'cfg-001',
    query: 'qmd mcp http 启动命令配置',
    category: 'config',
    description: '配置查询 — 启动命令',
    minExpectedResults: 0,
  },
  {
    id: 'cfg-002',
    query: 'openclaw plugin contracts tools 声明',
    category: 'config',
    description: '配置查询 — 插件契约',
    minExpectedResults: 0,
  },
  {
    id: 'cfg-003',
    query: 'embedding model 维度配置 1024 768',
    category: 'config',
    description: '配置查询 — 模型维度',
    minExpectedResults: 0,
  },
  {
    id: 'ml-001',
    query: 'assemble performance optimization 性能优化',
    category: 'multilingual',
    description: '中英混合查询 — 性能优化',
    minExpectedResults: 0,
  },
  {
    id: 'ml-002',
    query: 'token budget trim 裁剪策略',
    category: 'multilingual',
    description: '中英混合查询 — token 控制',
    minExpectedResults: 0,
  },
  {
    id: 'mix-001',
    query: 'lcm-graph-extra 插件的整体架构包括哪些模块，各模块之间如何协作',
    category: 'mixed',
    description: '复杂查询 — 架构理解',
    searches: [
      { type: 'lex', query: 'lcm-graph-extra 架构 模块' },
      { type: 'vec', query: '插件整体架构模块协作流程' },
    ],
    minExpectedResults: 0,
  },
  {
    id: 'mix-002',
    query: '从用户消息到 assemble 完成，中间经历了哪些阶段，每个阶段的延迟分布如何',
    category: 'mixed',
    description: '复杂查询 — 链路分析',
    searches: [
      { type: 'lex', query: 'assemble 阶段 延迟' },
      { type: 'vec', query: '用户消息到 assemble 完成的完整链路' },
    ],
    minExpectedResults: 0,
  },
  {
    id: 'mix-003',
    query: 'health metrics 采集了哪些指标，如何持久化，dashboard 如何展示',
    category: 'mixed',
    description: '复杂查询 — 指标体系',
    searches: [
      { type: 'lex', query: 'health metrics 指标 采集' },
      { type: 'vec', query: '指标采集持久化展示链路' },
    ],
    minExpectedResults: 0,
  },
  {
    id: 'mix-004',
    query: '经验图谱的节点和关系类型有哪些，如何确保图谱健康',
    category: 'mixed',
    description: '复杂查询 — 图谱健康',
    searches: [
      { type: 'lex', query: '经验图谱 节点 关系' },
      { type: 'vec', query: '图谱节点关系类型健康检查' },
    ],
    minExpectedResults: 0,
  },
  {
    id: 'mix-005',
    query: '降级策略有哪些层级，MCP 失败时如何自动切换到 REST 和 CLI',
    category: 'mixed',
    description: '复杂查询 — 降级策略',
    searches: [
      { type: 'lex', query: '降级 MCP REST CLI' },
      { type: 'vec', query: 'MCP 失败自动切换降级策略' },
    ],
    minExpectedResults: 0,
  },
  {
    id: 'mix-006',
    query: 'dashboard 的报告和导出能力，支持哪些格式',
    category: 'mixed',
    description: '复杂查询 — 导出能力',
    minExpectedResults: 0,
  },
  {
    id: 'mix-007',
    query: 'benchmark 压测能力评估哪些指标，如何输出报告',
    category: 'mixed',
    description: '复杂查询 — 压测能力',
    minExpectedResults: 0,
  },
];

// ---------------------------------------------------------------------------
// 2. ce-multi-turn（CE 多轮会话集）—— 基于 lossless-claw 能力维度
// ---------------------------------------------------------------------------

/**
 * CE 多轮会话测试集设计：
 *
 * 参考 lossless-claw 的核心能力：
 * - ingest：消息写入 DAG（每轮追加）
 * - compact：DAG 压缩（tokensBefore/After，触发条件 ratio>0.65）
 * - assemble：上下文组装（L1 摘要 + L2 检索 + L3 图谱 + L4 经验）
 *
 * 每条 fixture 是一个完整会话，含多轮 query：
 * - opening：开场查询，建立上下文
 * - followup：跟进查询，测试上下文累积召回
 * - clarify：澄清查询，测试精确度提升
 * - recall：召回查询，测试旧上下文检索（时间衰减）
 * - compress：压缩触发查询，测试长会话压缩效果
 *
 * 评估维度：
 * - 多轮召回率变化：随轮次增加，相关 docid 是否持续命中
 * - 上下文连贯性：followup 查询应召回 opening 的相关文档
 * - 压缩效果：compress 轮次应触发 token 节省
 */
export const CE_MULTI_TURN_FIXTURES: MultiTurnFixture[] = [
  {
    id: 'mt-001',
    category: 'knowledge',
    description: '知识检索多轮会话 — 逐步深入主题',
    turns: [
      {
        query: '知识图谱检索原理',
        role: 'opening',
        expectedDocIds: ['doc-1'],
        minExpectedResults: 1,
        description: '开场：建立知识图谱主题上下文',
      },
      {
        query: '向量检索和词法检索的区别',
        role: 'followup',
        expectedDocIds: ['doc-1'],
        minExpectedResults: 1,
      },
      {
        query: 'BM25 和 TF-IDF 哪个更适合中文检索',
        role: 'clarify',
        minExpectedResults: 0,
      },
      {
        query: '之前提到的知识图谱检索方法有哪些',
        role: 'recall',
        minExpectedResults: 0,
      },
    ],
  },
  {
    id: 'mt-002',
    category: 'experience',
    description: '经验查询多轮会话 — 问题排查链路',
    turns: [
      {
        query: 'Neo4j 连接超时怎么解决',
        role: 'opening',
        expectedDocIds: ['doc-1'],
        minExpectedResults: 0,
      },
      {
        query: '连接池配置参数有哪些',
        role: 'followup',
        expectedDocIds: ['doc-1'],
        minExpectedResults: 0,
      },
      {
        query: '之前遇到的类似数据库连接问题',
        role: 'recall',
        minExpectedResults: 0,
      },
      {
        query: '熔断器在连接失败时如何降级',
        role: 'clarify',
        minExpectedResults: 0,
      },
    ],
  },
  {
    id: 'mt-003',
    category: 'error',
    description: '错误排查多轮会话 — 错误信息追溯',
    turns: [
      {
        query: 'Dimension mismatch for query vector embedding column',
        role: 'opening',
        expectedDocIds: ['doc-1'],
        minExpectedResults: 0,
      },
      {
        query: 'embedding 模型维度如何配置',
        role: 'followup',
        expectedDocIds: ['doc-1'],
        minExpectedResults: 0,
      },
      {
        query: '768 维和 1024 维的模型有哪些区别',
        role: 'clarify',
        minExpectedResults: 0,
      },
      {
        query: '之前遇到的 embedding 相关错误',
        role: 'recall',
        minExpectedResults: 0,
      },
    ],
  },
  {
    id: 'mt-004',
    category: 'config',
    description: '配置查询多轮会话 — 配置项追溯',
    turns: [
      {
        query: 'qmd mcp 启动命令',
        role: 'opening',
        minExpectedResults: 0,
      },
      {
        query: '配置文件路径如何解析',
        role: 'followup',
        minExpectedResults: 0,
      },
      {
        query: 'XDG_CACHE_HOME 环境变量如何设置',
        role: 'clarify',
        minExpectedResults: 0,
      },
      {
        query: '之前遇到的配置相关问题',
        role: 'recall',
        minExpectedResults: 0,
      },
    ],
  },
  {
    id: 'mt-005',
    category: 'mixed',
    description: '复合查询多轮会话 — 架构理解链路',
    turns: [
      {
        query: 'lcm-graph-extra 插件架构',
        role: 'opening',
        minExpectedResults: 0,
      },
      {
        query: '四层检索架构 L1 L2 L3 L4 分别是什么',
        role: 'followup',
        minExpectedResults: 0,
      },
      {
        query: 'assemble 如何组装上下文',
        role: 'clarify',
        minExpectedResults: 0,
      },
      {
        query: 'compact 压缩何时触发',
        role: 'compress',
        minExpectedResults: 0,
      },
      {
        query: '之前讨论的架构和压缩机制',
        role: 'recall',
        minExpectedResults: 0,
      },
    ],
    expectCompressionAtTurn: 4,
  },
  {
    id: 'mt-006',
    category: 'multilingual',
    description: '多语言多轮会话 — 中英混合技术讨论',
    turns: [
      {
        query: 'performance optimization 性能优化方法',
        role: 'opening',
        minExpectedResults: 0,
      },
      {
        query: 'latency reduction 延迟降低策略',
        role: 'followup',
        minExpectedResults: 0,
      },
      {
        query: 'token budget control token 预算控制',
        role: 'clarify',
        minExpectedResults: 0,
      },
    ],
  },
  {
    id: 'mt-007',
    category: 'mixed',
    description: '长会话压缩测试 — 触发 DAG 压缩',
    turns: [
      { query: 'benchmark 压测能力', role: 'opening', minExpectedResults: 0 },
      { query: '召回率如何计算', role: 'followup', minExpectedResults: 0 },
      { query: 'tokens 消耗估算方法', role: 'followup', minExpectedResults: 0 },
      { query: '压缩率指标含义', role: 'followup', minExpectedResults: 0 },
      { query: '延迟分布百分位 P50 P95 P99', role: 'followup', minExpectedResults: 0 },
      { query: '报告生成支持哪些格式', role: 'followup', minExpectedResults: 0 },
      { query: '历史记录如何管理', role: 'followup', minExpectedResults: 0 },
      { query: '之前讨论的 benchmark 所有指标', role: 'recall', minExpectedResults: 0 },
    ],
    expectCompressionAtTurn: 6,
    expectPressureTier: 'medium',
  },
];

// ---------------------------------------------------------------------------
// 兼容性：保留 BUILTIN_FIXTURES 导出（指向 project-scenarios）
// ---------------------------------------------------------------------------

/** @deprecated 使用 PROJECT_SCENARIO_FIXTURES 代替 */
export const BUILTIN_FIXTURES = PROJECT_SCENARIO_FIXTURES;

// ---------------------------------------------------------------------------
// 测试集元数据
// ---------------------------------------------------------------------------

export interface FixtureSetMeta {
  id: FixtureSetId;
  name: string;
  description: string;
  /** 测试集类型：single-turn 单轮 / multi-turn 多轮 / beir BEIR 标准 */
  type: 'single-turn' | 'multi-turn' | 'beir';
  /** 是否需要在线下载 */
  requiresDownload?: boolean;
  /** 内置测试集数量（BEIR 需下载后才知道） */
  count?: number;
}

export const FIXTURE_SETS: FixtureSetMeta[] = [
  {
    id: 'project-scenarios',
    name: '项目场景集',
    description: '21 条单轮查询，覆盖知识/经验/错误/配置/多语言/复合 6 个分类，基于本项目实际场景',
    type: 'single-turn',
    count: PROJECT_SCENARIO_FIXTURES.length,
  },
  {
    id: 'ce-multi-turn',
    name: 'CE 多轮会话集',
    description: '7 条多轮会话序列，基于 lossless-claw 能力维度设计，测试上下文累积/压缩触发/召回衰减',
    type: 'multi-turn',
    count: CE_MULTI_TURN_FIXTURES.length,
  },
  {
    id: 'beir-nfcorpus',
    name: 'BEIR NFCorpus',
    description: '业界公认信息检索测试集 — 医学领域 3.2K 查询，含 expectedDocIds 黄金答案',
    type: 'beir',
    requiresDownload: true,
  },
  {
    id: 'beir-scifact',
    name: 'BEIR SciFact',
    description: '业界公认信息检索测试集 — 科学论文 1.4K 查询，含 expectedDocIds 黄金答案',
    type: 'beir',
    requiresDownload: true,
  },
];

/** 按分类统计 fixture 数量（单轮测试集） */
export function fixtureCategoryStats(fixtures: BenchmarkFixture[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const f of fixtures) {
    stats[f.category] = (stats[f.category] ?? 0) + 1;
  }
  return stats;
}

/** 按分类统计多轮会话 fixture 数量 */
export function multiTurnCategoryStats(fixtures: MultiTurnFixture[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const f of fixtures) {
    stats[f.category] = (stats[f.category] ?? 0) + 1;
  }
  return stats;
}

/** 将多轮会话 fixture 展开为单轮 fixture 列表（用于 runner 执行） */
export function flattenMultiTurnFixtures(fixtures: MultiTurnFixture[]): Array<BenchmarkFixture & { turnIndex: number; turnTotal: number; role?: string; sessionId: string }> {
  const result: Array<BenchmarkFixture & { turnIndex: number; turnTotal: number; role?: string; sessionId: string }> = [];
  for (const f of fixtures) {
    const turnTotal = f.turns.length;
    for (let i = 0; i < turnTotal; i++) {
      const turn = f.turns[i];
      result.push({
        id: `${f.id}-t${i + 1}`,
        query: turn.query,
        category: f.category,
        expectedDocIds: turn.expectedDocIds,
        minExpectedResults: turn.minExpectedResults,
        description: turn.description ?? `${f.description} - 轮次 ${i + 1}/${turnTotal}`,
        turnIndex: i,
        turnTotal,
        role: turn.role,
        sessionId: f.id,
      });
    }
  }
  return result;
}
