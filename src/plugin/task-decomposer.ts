/**
 * 规则版任务分解器（Rule-based Task Decomposer）
 *
 * 设计理念（受 SkillWeaver "Decompose→Retrieve→Compose" 启发）：
 *   旧版 buildSmartToolGuidance 直接把匹配场景的若干工具平铺给 LLM，
 *   缺少"先做什么、再做什么"的步骤化建议，导致 LLM 容易一次性调用一堆工具。
 *
 *   本模块用确定性规则（场景分类 + 关键词匹配，不依赖 LLM）把用户请求分解为
 *   有序的子任务序列，每个子任务绑定一个能力类别，assemble 时按子任务顺序
 *   有序推荐工具，引导 LLM 分步执行而非堆叠调用。
 *
 * 与现有 detectScenario 的关系：
 *   - detectScenario 负责识别"这是什么场景"（bug-fix / feature-dev / …）
 *   - 本模块负责在该场景下"分几步、每步要什么能力"
 *   - 关键词用于在模板基础上动态增删子任务（如用户提到"测试"则强化验证步骤）
 *
 * @module plugin/task-decomposer
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单个子任务描述 */
export interface Subtask {
  /** 子任务序号（从 1 开始） */
  step: number;
  /** 子任务名称（中文，用于展示给 LLM） */
  name: string;
  /** 简短说明（这一步要做什么） */
  hint: string;
  /** 该子任务需要的能力类别（对齐 TOOL_CATEGORIES / TOOL_NAME_PATTERNS） */
  category: string;
  /** 是否可选（关键词未命中时可省略） */
  optional?: boolean;
}

/** 分解结果 */
export interface DecompositionResult {
  /** 场景标识 */
  scenario: string;
  /** 有序子任务序列 */
  subtasks: Subtask[];
  /** 命中的关键词（用于调试/日志） */
  matchedKeywords: string[];
}

// ---------------------------------------------------------------------------
// 场景 → 子任务模板（有序）
// ---------------------------------------------------------------------------

interface SubtaskTemplate {
  name: string;
  hint: string;
  category: string;
  optional?: boolean;
}

const SCENARIO_SUBTASK_TEMPLATES: Record<string, SubtaskTemplate[]> = {
  'bug-fix': [
    { name: '定位问题', hint: '搜索相关代码/日志，确定出错位置', category: 'search' },
    { name: '阅读上下文', hint: '读取出错点附近的代码与依赖', category: 'document' },
    { name: '复现诊断', hint: '运行/诊断以确认根因', category: 'diagnosis' },
    { name: '修复代码', hint: '编辑代码修复缺陷', category: 'file' },
    { name: '验证修复', hint: '运行测试或命令确认修复生效', category: 'shell' },
    { name: '沉淀经验', hint: '记录此次排障经验以备后用', category: 'experience', optional: true },
  ],
  'feature-dev': [
    { name: '调研参考', hint: '搜索已有实现或相似模式', category: 'search' },
    { name: '阅读上下文', hint: '读取待扩展模块的代码', category: 'document' },
    { name: '编写代码', hint: '创建/编辑代码实现新功能', category: 'file' },
    { name: '验证实现', hint: '运行测试或命令验证', category: 'shell', optional: true },
  ],
  'code-review': [
    { name: '阅读代码', hint: '读取待审查的代码', category: 'document' },
    { name: '检索规范', hint: '搜索相关规范/历史经验', category: 'search' },
    { name: '总结建议', hint: '汇总审查意见', category: 'experience', optional: true },
  ],
  'config-debug': [
    { name: '读取配置', hint: '查看当前配置项', category: 'config' },
    { name: '诊断问题', hint: '检查配置与健康状态', category: 'diagnosis' },
    { name: '修改配置', hint: '调整配置项', category: 'config' },
    { name: '验证生效', hint: '确认修改生效', category: 'diagnosis', optional: true },
  ],
  'security-audit': [
    { name: '扫描代码', hint: '搜索潜在风险点', category: 'search' },
    { name: '诊断漏洞', hint: '检查健康与依赖状态', category: 'diagnosis' },
    { name: '修复问题', hint: '编辑代码修复漏洞', category: 'file' },
    { name: '验证修复', hint: '运行验证命令', category: 'shell', optional: true },
  ],
  'deployment': [
    { name: '备份现状', hint: '备份当前数据/配置', category: 'lifecycle' },
    { name: '检查状态', hint: '诊断当前健康状态', category: 'diagnosis' },
    { name: '执行部署', hint: '运行部署/同步命令', category: 'shell' },
    { name: '验证部署', hint: '检查部署后状态', category: 'diagnosis', optional: true },
  ],
  'performance-opt': [
    { name: '诊断瓶颈', hint: '定位性能瓶颈', category: 'diagnosis' },
    { name: '检索方案', hint: '搜索优化方案/经验', category: 'search' },
    { name: '修改代码', hint: '编辑代码实施优化', category: 'file' },
    { name: '验证提升', hint: '运行验证性能', category: 'shell', optional: true },
  ],
  'refactor': [
    { name: '检索引用', hint: '搜索所有引用点', category: 'search' },
    { name: '阅读理解', hint: '读取待重构代码', category: 'document' },
    { name: '执行重构', hint: '编辑代码完成重构', category: 'file' },
    { name: '验证一致', hint: '运行测试确认行为不变', category: 'shell', optional: true },
  ],
  'troubleshooting': [
    { name: '诊断状态', hint: '检查系统健康与日志', category: 'diagnosis' },
    { name: '搜索经验', hint: '检索历史相似故障', category: 'search' },
    { name: '查看文档', hint: '读取相关文档/日志', category: 'document' },
    { name: '修复问题', hint: '编辑配置或代码', category: 'file', optional: true },
    { name: '验证恢复', hint: '确认故障恢复', category: 'shell', optional: true },
  ],
  'document_lookup': [
    { name: '搜索定位', hint: '搜索目标文档/文件', category: 'search' },
    { name: '读取内容', hint: '读取文档完整内容', category: 'document' },
  ],
  'maintenance': [
    { name: '诊断状态', hint: '检查系统健康', category: 'diagnosis' },
    { name: '执行维护', hint: '执行维护/压缩/蒸馏操作', category: 'maintenance' },
    { name: '验证结果', hint: '确认维护效果', category: 'diagnosis', optional: true },
  ],
};

// ---------------------------------------------------------------------------
// 关键词 → 子任务增删规则
// ---------------------------------------------------------------------------

interface KeywordRule {
  /** 匹配的正则 */
  pattern: RegExp;
  /** 命中时强制保留/新增的子任务类别（可选子任务转必选） */
  enforceCategories?: string[];
  /** 命中时新增的子任务（追加到序列末尾，默认为可选） */
  addSubtask?: Omit<SubtaskTemplate, 'optional'> & { optional?: boolean };
  /** 命中关键词的标签（用于日志） */
  keyword: string;
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    keyword: 'test',
    pattern: /测试|test|验证|verify|断言|assert/i,
    enforceCategories: ['shell', 'diagnosis'],
  },
  {
    keyword: 'backup',
    pattern: /备份|backup|恢复|restore|回滚|rollback/i,
    enforceCategories: ['lifecycle'],
  },
  {
    keyword: 'config',
    pattern: /配置|config|设置|setting|参数|param/i,
    enforceCategories: ['config'],
  },
  {
    keyword: 'experience',
    pattern: /经验|experience|历史|曾经|上次|沉淀|总结/i,
    enforceCategories: ['experience'],
  },
  {
    keyword: 'diagnose',
    pattern: /诊断|diagnose|排查|定位|为什么|why|health|健康/i,
    enforceCategories: ['diagnosis'],
  },
  {
    keyword: 'doc',
    pattern: /文档|document|readme|说明|spec/i,
    enforceCategories: ['document'],
  },
  {
    keyword: 'search',
    pattern: /搜索|search|查找|find|查询|query|检索/i,
    enforceCategories: ['search'],
  },
];

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 规则版任务分解：根据场景 + 用户消息关键词，输出有序子任务序列。
 *
 * 不依赖 LLM，纯规则：
 *   1. 取场景对应的子任务模板（无模板则返回空序列，由调用方回退到旧逻辑）
 *   2. 扫描用户消息关键词，将匹配到的可选子任务提升为必选，或追加新子任务
 *   3. 编号后返回
 *
 * @param scenario 场景标识（对齐 detectScenario 的输出）
 * @param userQuery 最新用户消息（可为空）
 * @returns 分解结果；无模板时 subtasks 为空
 */
export function decomposeTask(
  scenario: string,
  userQuery: string = '',
): DecompositionResult {
  const templates = SCENARIO_SUBTASK_TEMPLATES[scenario];
  if (!templates || templates.length === 0) {
    return { scenario, subtasks: [], matchedKeywords: [] };
  }

  const query = typeof userQuery === 'string' ? userQuery : '';
  const matchedKeywords: string[] = [];
  const enforceSet = new Set<string>();
  const additions: SubtaskTemplate[] = [];

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(query)) {
      matchedKeywords.push(rule.keyword);
      if (rule.enforceCategories) {
        for (const c of rule.enforceCategories) enforceSet.add(c);
      }
    }
  }

  // 构建子任务序列：保留全部模板子任务（含可选）；
  // 可选子任务若被关键词 enforce 则提升为必选（optional=false）。
  const result: SubtaskTemplate[] = [];
  const seenCategories = new Set<string>();

  for (const t of templates) {
    const enforced = enforceSet.has(t.category);
    result.push({ ...t, optional: t.optional && !enforced });
    seenCategories.add(t.category);
  }

  // enforce 但模板中没有的类别 → 追加一个子任务
  for (const cat of enforceSet) {
    if (seenCategories.has(cat)) continue;
    result.push({
      name: cat,
      hint: `关键词命中，补充此步骤`,
      category: cat,
      optional: true,
    });
    seenCategories.add(cat);
  }

  // 编号
  const subtasks: Subtask[] = result.map((t, i) => ({
    step: i + 1,
    name: t.name,
    hint: t.hint,
    category: t.category,
    optional: t.optional,
  }));

  return { scenario, subtasks, matchedKeywords };
}

/**
 * 判断场景是否有任务分解模板。
 * 用于调用方决定是否启用分解模式（无模板则回退旧逻辑）。
 */
export function hasDecompositionTemplate(scenario: string): boolean {
  return !!SCENARIO_SUBTASK_TEMPLATES[scenario];
}
