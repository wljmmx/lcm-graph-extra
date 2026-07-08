/**
 * 内置标准 benchmark 测试集。
 *
 * 设计原则：
 * - 覆盖典型用户场景：知识检索、经验查询、错误排查、配置查询、跨语言
 * - 每条用例含可选 expectedDocIds（黄金答案），用于召回率评估
 * - 用户可通过 POST /api/benchmark/run 传入自定义 fixtures 覆盖内置集
 *
 * 召回率评估为可选：未提供 expectedDocIds 的用例只统计性能，不计算召回率。
 */

export interface BenchmarkFixture {
  /** 用例唯一 ID */
  id: string;
  /** 测试查询文本 */
  query: string;
  /** 查询意图分类（用于分组统计） */
  category: 'knowledge' | 'experience' | 'error' | 'config' | 'multilingual' | 'mixed';
  /** 搜索类型组合（默认 lex+vec hybrid） */
  searches?: Array<{ type: 'lex' | 'vec' | 'hyde'; query?: string }>;
  /** 期望返回的文档 docid 列表（可选，用于召回率评估） */
  expectedDocIds?: string[];
  /** 期望结果数下限（可选，用于基本断言） */
  minExpectedResults?: number;
  /** 用例描述 */
  description?: string;
}

export const BUILTIN_FIXTURES: BenchmarkFixture[] = [
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
];

/** 按分类统计 fixture 数量 */
export function fixtureCategoryStats(fixtures: BenchmarkFixture[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const f of fixtures) {
    stats[f.category] = (stats[f.category] ?? 0) + 1;
  }
  return stats;
}
