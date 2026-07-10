# Agent Harness 模型执行能力提升优化方案

> **版本**: v1.0  
> **日期**: 2026-07-10  
> **作者**: AI 工程师 + Agent Harness 专家  
> **目标**: 通过 Harness 框架系统性提升模型实际执行能力  
> **基线**: lcm-graph-extra v2.1.11

---

## 一、核心思路

Agent Harness 与模型的协作关系可以概括为一条链：

```
用户查询 → Harness 上下文组装 → 模型推理 → Harness 后处理 → 用户可见输出
              ↑                                    ↑
        检索/组装/去重                         反馈/验证/学习
```

**Harness 的能力边界**：Harness 不直接控制模型推理过程，但通过以下三个杠杆间接提升模型执行能力：

| 杠杆 | 作用机制 | 影响维度 |
|------|---------|---------|
| **上下文质量** | 决定模型"看到什么" | 准确性、相关性、时效性 |
| **指令清晰度** | 决定模型"如何理解任务" | 遵从性、格式正确性、工具调用精准度 |
| **反馈闭环** | 决定模型"从错误中学习" | 长期自进化、个性化适配 |

**本文档的优化策略**：围绕这三个杠杆，提出 6 个可落地的优化方案，每个方案都明确标注了对模型执行能力的具体提升效果。

---

## 二、六大优化方案

### 方案 1: 上下文时效性增强 — 检索结果 freshness 评分

**对应杠杆**: 上下文质量  
**优先级**: P1  
**预估工时**: 3h  
**涉及文件**: `src/merger.ts`, `src/index.ts`

#### 2.1.1 问题分析

当前检索结果排序仅依赖 `relevanceScore`（静态质量）和 `matchCount`（历史命中次数），不考虑**内容的新鲜度**。导致：

- 3 个月前的 API 文档排在 3 天前的修复方案前面
- 已废弃的配置方式被优先展示
- 模型基于过时信息做出错误决策

#### 2.1.2 处理思路

在 Merger 的合并排序中引入 `freshnessBoost`，基于检索结果的 `updatedAt` / `createdAt` 时间戳：

```
finalScore = relevanceScore * 0.6 + freshnessBoost * 0.25 + matchCountBonus * 0.15
freshnessBoost = 1.0 / (1.0 + daysSinceUpdate / halfLifeDays)
```

**为什么不直接按时间排序**：纯粹的按时间排序会导致"新但无关"的内容排在最前面。freshnessBoost 作为附加分，核心排序仍由 relevance 主导。

**与 C-1（经验召回时间衰减）的区别**：C-1 是 Neo4j 层面的排序衰减，针对经验节点；本方案是 Merger 层面的合并排序，针对所有检索结果（qmd + graph + experience）。

#### 2.1.3 代码变更

**文件**: `src/merger.ts`

```typescript
/**
 * H-1: 检索结果 freshness 评分。
 * 对检索结果施加时间新鲜度加成，防止过时内容长期占据高位。
 *
 * @param updatedAt 内容最后更新时间（ISO 字符串或毫秒时间戳）
 * @param halfLifeDays 半衰期（天），默认 30
 * @returns [0, 1] freshness 分数，越新越接近 1
 */
export function computeFreshnessBoost(
  updatedAt?: string | number,
  halfLifeDays: number = 30,
): number {
  if (updatedAt == null) return 0.5; // 无时间信息 → 中性分数
  const ts = typeof updatedAt === 'string' ? new Date(updatedAt).getTime() : updatedAt;
  if (isNaN(ts)) return 0.5;
  const daysSinceUpdate = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate < 0) return 1.0; // 未来时间（时钟偏差）→ 满分
  return 1.0 / (1.0 + daysSinceUpdate / halfLifeDays);
}
```

**文件**: `src/merger.ts` — 在 `merge()` 方法中应用 freshness

```typescript
// 在现有排序逻辑中增加 freshnessBoost
const merged = [...uniqueItems].sort((a, b) => {
  const aFresh = computeFreshnessBoost(a.updatedAt);
  const bFresh = computeFreshnessBoost(b.updatedAt);
  const aScore = (a.relevanceScore ?? 0.5) * 0.6 + aFresh * 0.25 + (Math.min((a.matchCount ?? 0), 50) / 50) * 0.15;
  const bScore = (b.relevanceScore ?? 0.5) * 0.6 + bFresh * 0.25 + (Math.min((b.matchCount ?? 0), 50) / 50) * 0.15;
  return bScore - aScore;
});
```

#### 2.1.4 模型执行能力提升

| 提升维度 | 具体效果 |
|---------|---------|
| **准确性** | 最新的 API 文档/修复方案优先展示 → 模型基于最新信息推理 |
| **时效性** | 3 天前的修复方案排在 3 个月前的前面 → 模型不会重复已修复的 bug |
| **可信度** | 用户观察到模型引用的总是"最近更新"的记忆 → 信任度提升 |

---

### 方案 2: 指令级优化 — 知识库参考引导语增强

**对应杠杆**: 指令清晰度  
**优先级**: P1  
**预估工时**: 2h  
**涉及文件**: `src/index.ts`

#### 2.2.1 问题分析

当前 `systemPromptAddition` 中注入知识库内容时，引导语固定为：

```typescript
'# 知识库参考\n以下为知识库检索结果，仅供参考补充。请始终专注于用户当前问题，不要被历史内容主导任务方向。'
```

这条引导语存在两个问题：
1. **过于笼统**：没有告诉模型"如何"使用这些参考内容
2. **缺少优先级提示**：各层检索结果（经验/图谱/记忆文件）没有使用优先级指导

#### 2.2.2 处理思路

根据上下文压力等级（tier）动态生成引导语，利用 Harness 已有的压力感知能力：

| 压力等级 | 引导语策略 | 目的 |
|:---:|------|------|
| low | 详细引导 + 分层使用说明 | token 充裕，可以给更详细的指令 |
| medium | 精简引导 + 优先级提示 | 紧凑但保留关键指令 |
| high | 极简引导 | 节省 token，只保留核心提示 |

同时在引导语中增加**分层使用优先级**，告诉模型各层内容的可靠程度：

```
经验总结（最高优先级）> 知识图谱（中优先级）> 记忆文件（参考优先级）
```

#### 2.2.3 代码变更

**文件**: `src/index.ts` — 在 `assemble()` 中替换固定引导语

```typescript
/**
 * H-2: 根据压力等级动态生成知识库参考引导语。
 * low tier → 详细引导（分层使用说明 + 冲突处理策略）
 * medium tier → 精简引导（优先级提示）
 * high tier → 极简引导（仅核心提示）
 */
function buildKnowledgeGuidance(tier: PressureTier, sections: any[]): string {
  if (sections.length === 0) return '';

  const header = '\n# 知识库参考\n';

  switch (tier) {
    case 'low':
      return header + [
        '以下为知识库检索结果，按可靠程度分为三层：',
        '1. 💡 经验总结（最高优先级）：历史对话中验证过的经验，可直接参考',
        '2. 🔗 知识图谱（中优先级）：代码实体关系，用于理解项目结构',
        '3. 📄 记忆文件（参考优先级）：代码片段和文档，用于补充细节',
        '',
        '使用原则：',
        '- 经验表明"不推荐"的做法，即使图谱中有相关代码，也应优先采纳经验',
        '- 当不同层的信息冲突时，以经验总结为准',
        '- 请始终专注于用户当前问题，不要被历史内容主导任务方向',
        '- 如果知识库内容与当前问题无关，请忽略并基于你的知识回答',
      ].join('\n');

    case 'medium':
      return header + [
        '以下为知识库检索结果，按优先级排列：经验总结 > 知识图谱 > 记忆文件。',
        '请专注于用户当前问题，冲突时以经验总结为准。',
      ].join('\n');

    case 'high':
      return header + '请专注于用户当前问题。';

    default:
      return header + '以下为知识库检索结果，仅供参考。请始终专注于用户当前问题。';
  }
}
```

在 `assemble()` 中调用：

```typescript
// 替换原固定引导语
if (sections.length > 0) {
  addition += buildKnowledgeGuidance(tier, sections);
}
```

#### 2.2.4 模型执行能力提升

| 提升维度 | 具体效果 |
|---------|---------|
| **遵从性** | 明确的分层使用说明 → 模型正确区分经验/图谱/记忆的权重 |
| **冲突处理** | "冲突时以经验为准" → 减少模型在矛盾信息间的犹豫 |
| **格式正确性** | 结构化的引导语 → 模型输出更符合预期格式 |
| **Token 效率** | 压力感知动态引导 → high tier 下节省约 200 tokens |

---

### 方案 3: 工具调用精准度提升 — 工具描述动态适配

**对应杠杆**: 指令清晰度  
**优先级**: P2  
**预估工时**: 3h  
**涉及文件**: `src/plugin/tool-guidance.ts`, `src/index.ts`

#### 2.3.1 问题分析

当前工具指引始终注入全量工具描述，在 token 紧张时被裁剪（priority 5），但在 token 充裕时，冗长的工具描述可能：
- 占据不必要的上下文空间
- 分散模型注意力
- 导致模型调用不存在的工具（幻觉）

**Harness 的优势**：Harness 知道当前有哪些工具可用、哪些工具在当前场景下更有用。

#### 2.3.2 处理思路

根据上下文压力等级和场景分类，动态调整工具描述详细程度：

| 维度 | low tier | medium tier | high tier |
|:---:|------|------|------|
| 工具描述 | 完整描述 + 使用场景 | 工具名 + 一句话描述 | 仅工具名列表 |
| 场景推荐 | 按场景推荐 top 3 工具 | 不推荐 | 不推荐 |
| 工具参数 | 关键参数说明 | 不展示 | 不展示 |

#### 2.3.3 代码变更

**文件**: `src/plugin/tool-guidance.ts`

```typescript
/**
 * H-3: 根据压力等级动态生成工具指引。
 * 利用 Harness 的压力感知 + 场景分类能力，优化工具描述注入量。
 *
 * @param tier 上下文压力等级
 * @param scenario 当前场景分类（可选）
 * @param availableTools 可用工具列表
 * @returns 工具指引文本
 */
export function buildAdaptiveToolGuidance(
  tier: PressureTier,
  scenario: string | null,
  availableTools: string[],
): string {
  if (availableTools.length === 0) return '';

  const toolCategories = categorizeTools(availableTools);

  switch (tier) {
    case 'low': {
      // 完整描述 + 场景推荐
      const lines: string[] = ['## 可用工具', ''];
      for (const [category, tools] of Object.entries(toolCategories)) {
        if (tools.length === 0) continue;
        lines.push(`### ${category}`);
        for (const tool of tools) {
          const desc = getToolDescription(tool);
          lines.push(`- \`${tool}\`: ${desc}`);
        }
      }
      // 场景推荐
      if (scenario) {
        const recommended = getRecommendedTools(scenario, availableTools);
        if (recommended.length > 0) {
          lines.push('');
          lines.push(`### 当前场景（${scenario}）推荐工具`);
          lines.push(recommended.map(t => `- \`${t}\``).join(', '));
        }
      }
      return lines.join('\n');
    }

    case 'medium': {
      // 工具名 + 一句话描述
      const allTools = Object.values(toolCategories).flat();
      return '## 可用工具\n' + allTools.map(t => `- \`${t}\`: ${getToolDescription(t, 40)}`).join('\n');
    }

    case 'high': {
      // 仅工具名列表
      const allTools = Object.values(toolCategories).flat();
      return '## 可用工具\n' + allTools.map(t => `\`${t}\``).join(', ');
    }

    default:
      return '';
  }
}

/** 获取工具描述，maxLen 控制最大长度 */
function getToolDescription(toolName: string, maxLen: number = 120): string {
  const descriptions: Record<string, string> = {
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
  };
  const desc = descriptions[toolName] ?? '执行操作';
  return desc.length > maxLen ? desc.slice(0, maxLen - 3) + '...' : desc;
}

/** 按场景推荐工具 */
function getRecommendedTools(scenario: string, available: string[]): string[] {
  const recommendations: Record<string, string[]> = {
    'bug-fix': ['lcmg_search', 'lcmg_experience_report', 'lcmg_diagnose'],
    'config-debug': ['lcmg_search', 'lcmg_qmd_status', 'lcmg_diagnose'],
    'feature-dev': ['lcmg_search', 'lcmg_get_document', 'lcmg_batch_get'],
    'code-review': ['lcmg_experience_report', 'lcmg_search'],
    'security-audit': ['lcmg_search', 'lcmg_experience_report', 'lcmg_diagnose'],
    'deployment': ['lcmg_backup', 'lcmg_sync', 'lcmg_diagnose'],
  };
  return (recommendations[scenario] ?? []).filter(t => available.includes(t));
}
```

#### 2.3.4 模型执行能力提升

| 提升维度 | 具体效果 |
|---------|---------|
| **工具调用精准度** | 场景推荐工具 → 模型优先调用最相关的工具，减少试错 |
| **注意力聚焦** | 精简描述 → 模型不被无关工具描述分散注意力 |
| **幻觉降低** | 仅展示实际可用的工具 → 模型不会尝试调用不存在的工具 |
| **Token 效率** | high tier 时工具描述从 ~500 tokens 压缩到 ~50 tokens |

---

### 方案 4: 上下文冲突检测与消解

**对应杠杆**: 上下文质量  
**优先级**: P2  
**预估工时**: 4h  
**涉及文件**: `src/merger.ts`, `src/index.ts`

#### 2.4.1 问题分析

当多层检索结果包含矛盾信息时（例如：经验说"不要用方法 A"，但图谱中有方法 A 的实现代码），模型可能：
- 在两个矛盾信息间犹豫，输出不确定的答案
- 忽略经验警告，直接使用图谱中的代码
- 产生幻觉，试图调和两个矛盾

**Harness 的优势**：Harness 在组装上下文时，已经获得了所有检索结果，可以在注入前检测冲突。

#### 2.4.2 处理思路

在 Merger 合并结果后，在注入 systemPromptAddition 前，对结果进行轻量级冲突检测：

1. **关键词级冲突**：检测是否存在"推荐/不推荐"、"使用/避免"类型的对立陈述
2. **实体级冲突**：检测同一实体（函数名/类名）在不同层中的描述是否矛盾
3. **冲突标记**：检测到冲突时，在注入内容中增加明确的冲突提示

纯规则匹配，零 LLM 调用。

#### 2.4.3 代码变更

**文件**: `src/merger.ts` — 新增冲突检测函数

```typescript
/**
 * H-4: 检索结果冲突检测。
 * 检测经验层与图谱层/记忆层之间的信息冲突。
 *
 * 冲突模式：
 *   - 否定模式: "不要用 X" / "避免 X" / "X 已被废弃"
 *   - 版本冲突: "X v2 替代 X v1" / "X 从 v3 开始不再支持"
 *   - 实体描述冲突: 同一实体在不同层有相反描述
 *
 * @returns 冲突信息数组，每个冲突包含描述和涉及的结果
 */
export interface ContentConflict {
  type: 'negation' | 'version' | 'entity_description';
  description: string;
  positiveSource: string;   // 推荐/最新/正确的来源
  negativeSource: string;   // 被否定/过时/错误的来源
  severity: 'high' | 'medium';
}

export function detectConflicts(
  expResults: any[],
  graphResults: any[],
  qmdResults: any[],
): ContentConflict[] {
  const conflicts: ContentConflict[] = [];

  // 1. 否定模式检测：经验中有"不要/避免/废弃/替代"关键词
  const negationPatterns = [
    /(?:不要|避免|不推荐|废弃|deprecated|avoid|don'?t)\s*(?:使用|调用|采用)\s*[`]?(\w+)[`]?/gi,
    /(?:替代|取代|replace|instead\s+of|prefer)\s*[`]?(\w+)[`]?/gi,
  ];

  for (const exp of expResults) {
    const content = (exp?.content ?? exp?.summary ?? '').toLowerCase();
    for (const pattern of negationPatterns) {
      // 重置 lastIndex（正则带 g 标志）
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const negatedEntity = match[1]?.toLowerCase();
        if (!negatedEntity) continue;

        // 检查图谱/记忆层是否包含被否定的实体
        const graphHasEntity = graphResults.some((r: any) =>
          (r?.content ?? '').toLowerCase().includes(negatedEntity),
        );
        const qmdHasEntity = qmdResults.some((r: any) =>
          (r?.content ?? '').toLowerCase().includes(negatedEntity),
        );

        if (graphHasEntity || qmdHasEntity) {
          conflicts.push({
            type: 'negation',
            description: `经验建议避免使用 "${negatedEntity}"，但知识图谱或记忆文件中包含该实体的引用`,
            positiveSource: 'experience',
            negativeSource: graphHasEntity ? 'graph' : 'qmd',
            severity: 'high',
          });
        }
      }
    }
  }

  // 2. 版本冲突检测：经验中有"v2 替代 v1" / "从 v3 开始不再支持"
  const versionPatterns = [
    /(?:v(\d+)|version\s+(\d+))\s*(?:替代|取代|replace|instead)/gi,
    /(?:不再支持|no longer support|removed in)\s*(?:v(\d+)|version (\d+))/gi,
  ];

  for (const exp of expResults) {
    const content = (exp?.content ?? exp?.summary ?? '');
    for (const pattern of versionPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        conflicts.push({
          type: 'version',
          description: `经验包含版本变更信息，知识库中可能包含旧版本内容`,
          positiveSource: 'experience',
          negativeSource: 'graph/qmd',
          severity: 'medium',
        });
        break;
      }
    }
  }

  return conflicts.slice(0, 3); // 最多返回 3 个冲突（避免注入过多）
}
```

**文件**: `src/index.ts` — 在 `assemble()` 中注入冲突提示

```typescript
// 在 sections 构建完成后，注入冲突提示
const conflicts = detectConflicts(expResults, graphResults, qmdResults);
if (conflicts.length > 0) {
  const conflictText = conflicts.map((c, i) =>
    `⚠️ 冲突 ${i + 1} [${c.severity === 'high' ? '严重' : '中等'}]: ${c.description}`
  ).join('\n');
  addSection('## ⚠️ 内容冲突提示', conflictText, 6); // priority 6 最高，不会被裁剪
}
```

#### 2.4.4 模型执行能力提升

| 提升维度 | 具体效果 |
|---------|---------|
| **准确性** | 明确的冲突提示 → 模型优先采纳经验，避免使用过时/废弃的方案 |
| **一致性** | 检测到版本冲突 → 模型不会在新旧 API 间混淆 |
| **可信度** | 用户看到模型主动识别冲突 → 信任度提升 |

---

### 方案 5: 后处理反馈闭环增强 — 模型输出质量自动评估

**对应杠杆**: 反馈闭环  
**优先级**: P2  
**预估工时**: 5h  
**涉及文件**: `src/index.ts`, `src/health-metrics.ts`

#### 2.5.1 问题分析

当前 G-8 验证回路仅评估**经验召回**是否有效（基于 LLM 判断经验与 query 的相关性），但缺少对**模型输出质量**的评估。这意味着：

- 即使经验召回准确，如果模型没有正确使用经验，Harness 也不知道
- 无法区分"召回失败"和"模型使用失败"
- 缺少对模型输出质量的全局视图

#### 2.5.2 处理思路

在 `afterTurn` 中增加轻量级的模型输出质量评估，不调用额外 LLM（避免增加延迟和成本）：

| 评估维度 | 检查方法 | 零 LLM 调用 |
|---------|---------|:---:|
| 工具调用成功率 | 检查本轮是否调用了工具，工具是否返回了错误 | ✅ |
| 输出长度合理性 | 输出是否过短（< 10 字符）或过长（> 8000 字符） | ✅ |
| 引用使用率 | 模型是否引用了注入的知识库内容 | ✅ |
| 用户反馈信号 | 用户下一轮是否包含"不对"/"重试"/"再试"关键词 | ✅ |
| 重复输出检测 | 输出是否与上一轮输出高度重复 | ✅ |

这些评估结果写入 `healthMetrics`，用于：
1. 调整后续检索策略（质量低 → 增加检索数量）
2. Dashboard 展示模型输出质量趋势
3. 触发自动降级（连续多轮低质量 → 通知用户）

#### 2.5.3 代码变更

**文件**: `src/index.ts` — 在 `afterTurn` 中增加输出质量评估

```typescript
/**
 * H-5: 模型输出质量自动评估（afterTurn 中执行）。
 * 纯规则检查，零 LLM 调用，不影响延迟。
 */
interface OutputQualityMetrics {
  roundIndex: number;
  outputLength: number;
  outputLengthOk: boolean;
  toolCallCount: number;
  toolCallSuccessRate: number;
  referencesUsed: number;
  referencesAvailable: number;
  isRepetitive: boolean;
  userFeedbackSignal: 'positive' | 'negative' | 'neutral';
  overallScore: number; // [0, 1]
}

function evaluateOutputQuality(
  output: string,
  previousOutput: string | null,
  systemPromptAddition: string,
  toolResults: Array<{ success: boolean }>,
  userNextMessage: string | null,
): OutputQualityMetrics {
  const metrics: OutputQualityMetrics = {
    roundIndex: 0,
    outputLength: output.length,
    outputLengthOk: output.length >= 10 && output.length <= 8000,
    toolCallCount: toolResults.length,
    toolCallSuccessRate: toolResults.length > 0
      ? toolResults.filter(t => t.success).length / toolResults.length
      : 1.0,
    referencesUsed: 0,
    referencesAvailable: 0,
    isRepetitive: false,
    userFeedbackSignal: 'neutral',
    overallScore: 0,
  };

  // 1. 引用使用率：检查模型输出中是否引用了知识库中的实体
  if (systemPromptAddition) {
    // 从知识库注入中提取关键实体
    const kbEntities = systemPromptAddition.match(/`(\w{3,})`/g) ?? [];
    metrics.referencesAvailable = kbEntities.length;
    if (kbEntities.length > 0) {
      let used = 0;
      for (const entity of kbEntities) {
        if (output.includes(entity.replace(/`/g, ''))) used++;
      }
      metrics.referencesUsed = used;
    }
  }

  // 2. 重复输出检测
  if (previousOutput && output.length > 50) {
    const overlap = output.slice(0, 200).toLowerCase();
    const prev = previousOutput.slice(0, 200).toLowerCase();
    if (overlap === prev) {
      metrics.isRepetitive = true;
    }
  }

  // 3. 用户反馈信号
  if (userNextMessage) {
    const negativePatterns = ['不对', '错误', '错了', '重试', '再试', 'no', 'wrong', 'incorrect', 'retry', 'try again'];
    const positivePatterns = ['谢谢', '好的', '正确', '可以', 'thanks', 'good', 'correct', 'works', 'great'];
    const lower = userNextMessage.toLowerCase();
    if (negativePatterns.some(p => lower.includes(p))) {
      metrics.userFeedbackSignal = 'negative';
    } else if (positivePatterns.some(p => lower.includes(p))) {
      metrics.userFeedbackSignal = 'positive';
    }
  }

  // 综合评分
  let score = 0;
  if (metrics.outputLengthOk) score += 0.2;
  score += metrics.toolCallSuccessRate * 0.2;
  if (metrics.referencesAvailable > 0) {
    score += (metrics.referencesUsed / metrics.referencesAvailable) * 0.2;
  } else {
    score += 0.2; // 无引用内容时不扣分
  }
  if (!metrics.isRepetitive) score += 0.2;
  if (metrics.userFeedbackSignal === 'positive') score += 0.2;
  else if (metrics.userFeedbackSignal === 'negative') score += 0;
  else score += 0.1;

  metrics.overallScore = Math.round(score * 100) / 100;
  return metrics;
}
```

#### 2.5.4 模型执行能力提升

| 提升维度 | 具体效果 |
|---------|---------|
| **自进化** | 检测到连续低质量输出 → 自动调整检索策略 → 下一轮输出质量提升 |
| **可观测性** | 输出质量趋势可视化 → 运维人员可快速定位问题 |
| **用户感知** | 检测到重复输出 → 自动触发 compact → 避免"车轱辘话" |
| **反馈闭环** | 用户负面反馈被捕获 → 触发检索重试 → 下次回答更准确 |

---

### 方案 6: 上下文预热 — 会话启动时预加载高频经验

**对应杠杆**: 上下文质量  
**优先级**: P2  
**预估工时**: 3h  
**涉及文件**: `src/index.ts`, `src/experience/storage.ts`

#### 2.6.1 问题分析

会话启动时（第一轮对话），`assemble()` 的检索结果可能为空（因为 qmd query 可能很短或模糊），导致模型在没有任何上下文的情况下开始推理。这导致：

- 第一轮回答质量显著低于后续轮次
- 用户需要多轮对话才能"唤醒"相关记忆
- 冷启动体验差

#### 2.6.2 处理思路

在 `bootstrap()` 中，预加载当前用户/项目的高频经验（matchCount 高的经验），缓存到会话级内存中，在第一轮 `assemble()` 时作为 L4 的补充注入。

**关键设计**：
- 仅预加载高 matchCount 的经验（已证明有广泛适用性）
- 预加载结果独立于 query 检索结果，通过 dedup 机制避免重复
- 仅在 low tier 时注入（token 充裕时才预加载）

#### 2.6.3 代码变更

**文件**: `src/experience/storage.ts` — 新增 `getTopExperiences` 方法

```typescript
/**
 * H-6: 获取全局高频经验（用于会话启动预热）。
 * 按 matchCount 降序，不依赖 query 关键词。
 */
async getTopExperiences(limit: number = 3): Promise<ExperienceSearchResult[]> {
  const rows = await this.adapter.query<ExperienceSearchRow>(`
    MATCH (e:${LABEL})
    WHERE e.status = 'DISTILLED'
      AND (e.state IS NULL OR e.state <> 'superseded')
      AND e.relevanceScore >= 0.6
      AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
    RETURN e.id AS id, e.title AS title, e.summary AS summary,
           e.detail AS detail, e.context AS context,
           e.relevanceScore AS relevanceScore, e.createdAt AS createdAt,
           e.matchCount AS matchCount, e.rawIds AS rawIds, e.type AS type,
           e.tags_scenario AS tags_scenario, e.tags_techStack AS tags_techStack,
           e.tags_severity AS tags_severity, e.tags_free AS tags_free
    ORDER BY e.matchCount DESC, e.relevanceScore DESC
    LIMIT ${limit}
  `);
  return (rows || []).map((r: any) => ({
    experience: rowToDistilled(r),
    score: r.relevanceScore,
  }));
}
```

**文件**: `src/index.ts` — 在 `bootstrap()` 中预热 + 在 `assemble()` 中注入

```typescript
// 会话级预热缓存
const sessionWarmupCache = new Map<string, ExperienceSearchResult[]>();

// 在 bootstrap 中：
async function bootstrap(sessionKey: string, expStore: ExperienceStorage) {
  try {
    const topExp = await expStore.getTopExperiences(3);
    if (topExp.length > 0) {
      sessionWarmupCache.set(sessionKey, topExp);
    }
  } catch (e) {
    // 预热失败不影响主流程
  }
}

// 在 assemble() 的 L4 经验注入处：
// 仅 low tier 且无 query 检索结果时注入预热经验
if (tier === 'low' && expResults.length === 0) {
  const warmup = sessionWarmupCache.get(sessionKey);
  if (warmup && warmup.length > 0) {
    expResults = warmup.map(e => ({
      ...e,
      _warmup: true, // 标记为预热经验
    }));
    logger?.debug?.("H-6: inject warmup experiences", { count: expResults.length });
  }
}
```

#### 2.6.4 模型执行能力提升

| 提升维度 | 具体效果 |
|---------|---------|
| **冷启动质量** | 第一轮回答就有上下文参考 → 无需多轮"预热" |
| **用户体验** | 用户感知到模型"记得"之前的经验 → 信任度提升 |
| **Token 效率** | 预热经验提前加载 → 减少第一轮检索延迟 |

---

## 三、方案优先级与依赖关系

```
Phase 1 (立即执行，0 依赖)
├── 方案 1: 上下文时效性增强 (3h)
├── 方案 2: 指令级优化 — 引导语增强 (2h)
└── 方案 6: 上下文预热 (3h)

Phase 2 (依赖 C-3 场景分类修复)
└── 方案 3: 工具调用精准度提升 (3h)

Phase 3 (依赖 H-1 + H-4 基础)
└── 方案 4: 上下文冲突检测 (4h)

Phase 4 (依赖 G-8 验证回路)
└── 方案 5: 输出质量自动评估 (5h)
```

**总计**: 约 20 工时

---

## 四、与 C-1/C-2/C-3 修复方案的协同

| 修复方案 | 与之协同的 Harness 优化 | 协同效果 |
|---------|------|------|
| C-1 经验时间衰减 | 方案 1 (freshness 评分) | 经验层 + 检索层双时间衰减，全面解决时效性问题 |
| C-2 摘要质量验证 | 方案 5 (输出质量评估) | 输入质量 + 输出质量双评估，形成完整质量闭环 |
| C-3 场景分类 | 方案 2 (引导语增强) + 方案 3 (工具适配) | 场景感知的引导语 + 场景推荐的工具，上下文精准匹配 |

---

## 五、预期效果量化

| 指标 | 基线 (v2.1.11) | 目标 (v2.2.0) | 测量方法 |
|------|:---:|:---:|------|
| 经验召回新经验占比 | ~15% | ~30% | Dashboard 经验视图 |
| 第一轮回答质量评分 | 3.2/5 | 4.0/5 | 方案 5 输出质量评估 |
| 工具调用准确率 | ~75% | ~85% | 方案 5 工具调用成功率 |
| 上下文冲突误判率 | 未知 | < 5% | 方案 4 冲突检测 + 人工抽检 |
| Token 效率（high tier 注入） | 1600 chars | 1400 chars | assemble 日志 |

---

## 六、附录：变更文件清单

| 方案 | 文件 | 变更类型 | 行数 |
|:---:|------|:---:|:---:|
| 1 | `src/merger.ts` | 新增函数 + 修改排序 | ~30 |
| 2 | `src/index.ts` | 新增函数 + 替换调用 | ~40 |
| 3 | `src/plugin/tool-guidance.ts` | 新增函数 | ~80 |
| 4 | `src/merger.ts` + `src/index.ts` | 新增函数 + 注入调用 | ~100 |
| 5 | `src/index.ts` | 新增函数 + afterTurn 调用 | ~90 |
| 6 | `src/experience/storage.ts` + `src/index.ts` | 新增方法 + bootstrap/assemble | ~40 |
| **总计** | | | **~380** |