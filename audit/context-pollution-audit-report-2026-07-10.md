# lcm-graph-extra 上下文污染专项审计报告

> **审计日期**: 2026-07-10  
> **审计版本**: v2.1.11  
> **审计范围**: `/workspace/src` 全目录 + `/workspace/packages/dashboard`  
> **审计重点**: 上下文污染（Context Pollution）风险评估  
> **审计维度**: 上下文注入、污染传播、跨会话隔离、系统提示词管理、Token 预算控制  
> **审计结论**: ⚠️ 整体良好，发现 3 个 P1 级上下文污染风险点，2 个 P2 级优化建议

---

## 一、审计总览

### 1.1 项目架构概览

```
lcm-graph-extra (v2.1.11)
│
├── Layer 1: lossless-claw (内置) — 会话消息 DAG + 摘要树
├── Layer 2: qmd MCP — 记忆文件 BM25 + 向量搜索
├── Layer 3: Neo4j / graph-memory-pro — 知识图谱实体/关系
├── Layer 4: EXPERIENCE 节点 — 异步蒸馏经验层
│
├── Context Engine (src/index.ts)
│   ├── assemble()  — 上下文组装（每轮 LLM 调用前触发）
│   ├── afterTurn() — 事后经验提取 + 三元组写入
│   ├── compact()   — 委托 lossless-claw 执行 DAG 压缩
│   └── bootstrap() — 会话启动初始化
│
├── 检索网关 (src/retrieval-gateway.ts)
│   ├── search()               — 标准双引擎搜索（qmd + graph）
│   ├── searchWithExperience() — 上下文感知增强搜索
│   └── timedSearch()          — 带超时保护的搜索执行
│
├── 上下文推理 (src/context-inference.ts)
│   ├── inferQueryContext()     — 从 query 推断场景/技术栈/紧急度
│   ├── extractFreeTags()       — 开放词汇标签提取
│   ├── extractProjects()       — 项目名推断
│   └── computeContextMatchScore() — 经验匹配度计算
│
├── 插件层 (src/plugin/)
│   ├── token-control.ts  — 上下文 token 总量控制（section 优先级裁剪）
│   ├── tool-guidance.ts  — 工具感知检索策略
│   ├── keywords.ts       — 关键词提取 + 话题漂移检测
│   ├── dedup-cache.ts    — 会话级跨轮去重缓存
│   ├── overhead-cache.ts — 会话级 overhead 跟踪
│   └── distillation.ts   — LLM 经验蒸馏
│
├── 结果合并 (src/merger.ts)
│   └── 实体级跨引擎去重 + 时间衰减
│
├── 级联管理 (src/cascade-manager.ts)
│   └── Thompson 采样 + 三级置信度评估
│
├── 经验系统 (src/experience/)
│   ├── storage.ts   — Neo4j EXPERIENCE 节点 CRUD
│   ├── extractor.ts — 经验触发检测
│   ├── tag-registry.ts — 动态标签注册
│   └── user-profile.ts — 用户画像
│
└── Dashboard (packages/dashboard/)
    ├── 快照服务 (7423 端口)
    ├── 配置热更新
    └── 四大视图模块
```

### 1.2 上下文污染定义

在 Agent Harness 框架中，**上下文污染**指以下风险：

| 风险类别 | 描述 | 严重度 |
|---------|------|--------|
| **跨会话泄漏** | 会话 A 的上下文（检索结果、经验、消息）混入会话 B | 严重 |
| **历史污染** | 过时/错误的历史摘要污染当前推理 | 严重 |
| **注入失控** | systemPromptAddition 超过 token 预算，挤出核心对话 | 高 |
| **去重失效** | 重复内容跨轮注入，浪费上下文窗口 | 高 |
| **全局状态串扰** | 模块级单例在多会话间共享可变状态 | 中 |
| **经验偏差** | 低质量经验被高频召回，形成正反馈循环 | 中 |
| **标签泄漏** | 一个用户的标签/画像影响其他用户 | 低 |

---

## 二、上下文污染逐项审计

### 2.1 跨会话隔离审计

#### 2.1.1 会话级去重缓存 ✅ 通过

**文件**: [src/plugin/dedup-cache.ts](file:///workspace/src/plugin/dedup-cache.ts)

- 使用 `sessionDedupCache: Map<string, { window: string[][]; ... }>` 按 sessionKey 隔离
- 容量上限 500 sessions，1h TTL，防止无界增长
- 已在 [index.ts](file:///workspace/src/index.ts#L391-L393) 的 assemble 中正确使用 `sessionKey` 作为隔离键

**评估**: 设计合理，会话间完全隔离，无跨会话去重数据泄漏风险。

#### 2.1.2 会话级 Overhead 缓存 ✅ 通过

**文件**: [src/plugin/overhead-cache.ts](file:///workspace/src/plugin/overhead-cache.ts)

- 使用 `_sessionOverheadCache: Map<string, { tokens: number; ... }>` 按 sessionKey 隔离
- 容量/TTL 与 dedup-cache 对齐（500 sessions, 1h TTL）

**评估**: 设计合理，会话间完全隔离。

#### 2.1.3 G-8 验证回路会话隔离 ✅ 通过（已修复）

**文件**: [src/index.ts](file:///workspace/src/index.ts#L76-L82)

```typescript
// B-1 修复: 原为模块级 let 变量，多 session 并发时 G-8 验证回路会串数据
const lastAssembleExpIdsBySession = new Map<string, {
  ids: Array<{ id: string; summary: string; query: string }>;
  ts: number;
}>();
const LAST_EXP_MAP_MAX = 200;
const LAST_EXP_MAP_TTL_MS = 30 * 60 * 1000; // 30min TTL
```

**评估**: 已在 v2.1.10 修复，从模块级 `let` 变量改为 `Map<string, ...>` 按 sessionKey 隔离，并增加了 30 分钟 TTL 和 LRU 上限保护。

#### 2.1.4 全局单例状态审计 ⚠️ 需关注

以下模块级单例在多会话间共享，但属于**只读/无状态**或**有意设计为全局共享**：

| 单例 | 文件 | 类型 | 跨会话污染风险 | 评估 |
|------|------|------|:---:|------|
| `cascadeManager` | [cascade-manager.ts](file:///workspace/src/cascade-manager.ts#L410) | 全局 Thompson 采样臂 | 低 | 有意设计为跨会话学习，arms 按 scenario+id 维度隔离 |
| `userProfile` | [index.ts](file:///workspace/src/index.ts#L70) | 用户画像 | 低 | 不持久化，重启重置，按关键词维度聚合 |
| `healthMetrics` | [health-metrics.ts](file:///workspace/src/health-metrics.ts) | 健康指标 | 无 | 只写/只读，不参与上下文组装 |
| `_modelRegistry` | [index.ts](file:///workspace/src/index.ts#L147) | 模型上下文窗口注册表 | 无 | 只读缓存，不包含会话数据 |
| `_cachedGmpLlmConfig` | [index.ts](file:///workspace/src/index.ts#L87) | gm-pro LLM 配置缓存 | 无 | 只读配置，进程级缓存 |

**评估**: 无高风险跨会话污染。`cascadeManager` 的跨会话 Thompson 采样是设计意图，arms 按 `scenario:id` 隔离，虽有跨会话学习但不会导致数据泄漏。

---

### 2.2 上下文注入审计（systemPromptAddition）

#### 2.2.1 注入内容来源分析

`assemble()` 函数向系统提示词注入以下内容：

| 注入层 | 内容 | 来源 | 隔离性 |
|--------|------|------|:---:|
| L1 | 历史摘要（lossless-claw summaries） | 当前会话的 DAG 摘要树 | ✅ 会话级 |
| L2 | qmd 记忆文件搜索结果 | BM25/向量检索 | ⚠️ 全局索引 |
| L3 | 知识图谱实体/关系 | Neo4j 图谱查询 | ⚠️ 全局图谱 |
| L4 | 经验召回（蒸馏经验） | EXPERIENCE 节点 | ⚠️ 全局经验池 |
| 工具指引 | 可用工具列表 | 插件注册表 | ✅ 全局只读 |

**关键发现**: L2/L3/L4 的内容来自全局存储（qmd 索引、Neo4j 图谱），理论上可能包含其他会话/用户的数据。但这是**设计意图**——知识图谱和经验池本身就是跨会话共享的知识库。

#### 2.2.2 Token 预算控制机制 ✅ 优秀

**文件**: [src/plugin/token-control.ts](file:///workspace/src/plugin/token-control.ts)

`applyTotalControl()` 实现了按 section 优先级的分层裁剪：

```
优先级（数字大 = 最后被裁）：
  1. 历史摘要 / 完整文档（最低，最先裁）
  2. 记忆文件 / 文档摘要（L2）
  3. 知识图谱（L3）
  4. 经验（L4，最高保留优先级）
  5. 工具指引（可安全删除）
```

配合 [index.ts](file:///workspace/src/index.ts#L464-L498) 中的三级压力判定：

| 压力等级 | 触发条件 | 检索限制 | 最大注入字符数 |
|---------|---------|---------|:---:|
| low | tokenRatio < 0.70 | qmd:5, graph:5, exp:3 | 12,000 |
| medium | 0.70 ≤ tokenRatio < 0.85 | qmd:3, graph:3, exp:1 | 6,000 |
| high | tokenRatio ≥ 0.85 | qmd:1, graph:1, exp:0 | 1,600 |

**评估**: 多层防御机制完善。压力感知 → 检索限制 → 注入裁剪 → 硬截断，形成完整的上下文预算控制链。

#### 2.2.3 跨轮去重机制 ✅ 通过

**文件**: [src/plugin/dedup-cache.ts](file:///workspace/src/plugin/dedup-cache.ts)

- 每轮 assemble 生成 `currentRoundHashes`（基于检索结果内容哈希）
- 与历史轮次的哈希窗口（最多 24 轮）对比
- 重复内容自动跳过，不注入 systemPromptAddition

**评估**: 有效防止重复内容跨轮污染上下文。

#### 2.2.4 场景感知检索 ⚠️ P2 优化建议

**文件**: [src/index.ts](file:///workspace/src/index.ts#L708-L717)

`detectScenarioAndAdjustLimits` 根据 query 内容调整各层检索比例，但逻辑较简单：
- bug-fix/config-debug/performance-opt → QMD 权重高
- feature-dev/refactor → Graph 权重稍高
- code-review/security-audit → Experience 权重高

**潜在问题**: 若 query 被错误分类，可能导致检索偏向不相关的内容，间接污染上下文。建议未来引入置信度阈值，低置信度时回退到均衡比例。

---

### 2.3 历史摘要污染审计

#### 2.3.1 摘要树机制 ✅ 通过

- 使用 lossless-claw 内置的 DAG 摘要树
- 摘要以层级结构存储，高层摘要覆盖多轮对话
- 索引现有摘要时优先使用高层级摘要（减少注入量）

**评估**: 摘要树设计合理，层级压缩有效减少历史上下文占用。

#### 2.3.2 摘要质量验证 ⚠️ P1 风险

**文件**: [src/hooks/compaction.ts](file:///workspace/src/hooks/compaction.ts)

压缩后的摘要**没有质量验证步骤**。虽然 lossless-claw 内部有摘要生成逻辑，但：
- 没有对摘要内容进行事实性校验
- 没有检测摘要是否丢失关键信息
- 压缩失败静默降级，可能导致不完整摘要污染后续推理

**影响**: 若压缩生成的低质量摘要进入上下文窗口，后续轮次可能基于错误信息推理。

**建议**: 在压缩后增加轻量级摘要质量检查（如关键词覆盖率、长度合理性）。

#### 2.3.3 摘要 Token 预算 ✅ 通过

**文件**: [src/index.ts](file:///workspace/src/index.ts#L606-L608)

```typescript
const trimmedSummaryMsgs = trimSummariesToBudget(
  freshSummaries.map(...),
  resolvedCtx.compactTokenBudget * maxSummaryRatio, // 默认 114,688 * 0.45 = 51,609 tokens
);
```

**评估**: 摘要 token 预算受 `maxSummaryTokenRatio`（默认 0.45）控制，避免摘要膨胀挤出新消息。

---

### 2.4 经验系统污染审计

#### 2.4.1 经验蒸馏质量 ✅ 通过

**文件**: [src/plugin/distillation.ts](file:///workspace/src/plugin/distillation.ts)

- LLM 提示词约束了输出格式（JSON + 枚举值）
- 对 LLM 输出进行严格校验：
  - `scenario` 白名单过滤（`SCENARIO_SET`）
  - `techStack` 白名单过滤（`TECH_SET`）
  - `severity` 白名单过滤（`SEVERITY_SET`）
  - `freeTags` 长度限制（≤30 字符，最多 8 个）
  - `relevanceScore` 范围限制 [0, 1]
  - `relatedConcepts` 长度限制（≤50 字符，最多 5 个）

**评估**: 输入校验完善，有效防止 LLM 幻觉污染经验池。

#### 2.4.2 经验召回偏差 ⚠️ P1 风险

**文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts)

经验召回按 `relevanceScore DESC, matchCount DESC` 排序，且每次召回后 `incrementMatchCount`。这形成了**正反馈循环**：

1. 经验被召回 → matchCount 增加
2. matchCount 高 → 排序更靠前
3. 排序更靠前 → 更容易被召回
4. 回到步骤 1

**影响**: 早期被高频召回的经验（即使质量一般）会持续占据召回榜首，形成"经验回声室"，新经验难以突破。

**缓解措施**: 
- `CascadeManager.thompsonRerank` 引入了 30% 探索权重（Beta 采样）
- `G-8 验证回路` 对低相关性经验施加负反馈（delta = -0.05）
- 但 matchCount 只增不减，仍存在长期偏差累积

**建议**: 为 matchCount 增加时间衰减因子，或引入定期"经验质量重评估"机制。

#### 2.4.3 经验 TTL 和超期清理 ✅ 通过

**文件**: [src/config.ts](file:///workspace/src/config.ts#L55-L59)

```typescript
ttl: {
  enabled: true,
  retentionDays: 90,
  cleanupIntervalHours: 24,
}
```

**评估**: 经验有明确的 TTL 和清理机制，过期经验不会永久污染上下文。

---

### 2.5 工具指引注入审计

#### 2.5.1 工具列表来源 ✅ 通过

**文件**: [src/plugin/tool-guidance.ts](file:///workspace/src/plugin/tool-guidance.ts)

- 从 `params.availableTools` 读取实际可用工具列表
- 硬编码 fallback 列表与 `openclaw.plugin.json` 的 `contracts.tools` 对齐
- 按类别分类（graph/experience/qmd/maintenance/lifecycle）

**评估**: 工具列表来源可靠，不会注入虚假工具信息。

#### 2.5.2 工具指引注入时机 ⚠️ P2 优化建议

工具指引始终注入 systemPromptAddition，但按 token-control 优先级属于"可安全删除"（priority 5），在上下文紧张时最先被裁剪。这在 token 预算紧张时合理，但在 token 充裕时，工具指引可能占据不必要的上下文空间。

**建议**: 在 token 充裕时也考虑工具指引的注入量，避免冗长的工具描述。

---

### 2.6 上下文推理准确性审计（context-inference）

#### 2.6.1 紧急度推断 ✅ 通过

**文件**: [src/context-inference.ts](file:///workspace/src/context-inference.ts#L25-L29)

```typescript
const URGENT_PATTERNS = [
  { pattern: /(?:error.*error|critical|panic|segfault|core.?dump|fatal)/i, level: 1.0 },
  { pattern: /(?:cannot.start|connection.refused|timeout.*retry|out.of.memory|OOM)/i, level: 0.8 },
  { pattern: /(?:fail|error|exception|throw|raise|not.found)/i, level: 0.5 },
];
```

**评估**: 紧急度模式覆盖常见故障场景，但 `error.*error` 模式可能误匹配正常讨论（如"handle error in error middleware"）。误判为高紧急度不会导致污染，但会影响检索优先级。

#### 2.6.2 项目名提取 ✅ 通过

**文件**: [src/context-inference.ts](file:///workspace/src/context-inference.ts#L85-L140)

- 多模式匹配（路径/引用/URL）
- 停用词过滤（`src`, `lib`, `dist`, `build` 等）
- 结果限制（最多 5 个）

**评估**: 项目名提取用于经验搜索的软过滤，不修改上下文内容，无污染风险。

#### 2.6.3 标签注册表动态加载 ✅ 通过

**文件**: [src/retrieval-gateway.ts](file:///workspace/src/retrieval-gateway.ts#L66-L85)

- 带退避重试（10s/30s/60s）
- 失败时使用缓存默认值

**评估**: 标签来自 Neo4j 图谱中的已有标签，不会引入外部未验证标签。

---

### 2.7 结果合并与去重审计

#### 2.7.1 实体级去重 ✅ 通过

**文件**: [src/merger.ts](file:///workspace/src/merger.ts)

- 三层去重：ID 去重 → 实体分组 → 模糊合并
- 跨源结果合并（graph + qmd）
- 只保留最佳 primary + 1-2 个 supplemental

**评估**: 去重逻辑完善，有效防止跨引擎重复内容污染上下文。

#### 2.7.2 时间衰减 ✅ 通过

**文件**: [src/merger.ts](file:///workspace/src/merger.ts#L178-L201)

```typescript
// 公式: score_final = score * 0.5^(daysSinceUpdate / halfLifeDays)
// 默认 halfLifeDays = 45
```

**评估**: 对图谱结果施加时间衰减，防止过时知识长期占据高位。

#### 2.7.3 LLM 重排隔离 ✅ 通过

**文件**: [src/index.ts](file:///workspace/src/index.ts#L847-L876)

LLM 重排仅在 `tier === 'low' && tokenRatio < 0.25` 时触发，超时 1.5s，失败不阻塞主路径。

**评估**: 重排条件严格，不会在上下文紧张时引入额外延迟或污染。

---

### 2.8 Dashboard 快照服务审计 ✅ 通过

**文件**: [src/dashboard-snapshot.ts](file:///workspace/src/dashboard-snapshot.ts)

- 仅监听 `127.0.0.1:7423`，不暴露到外部网络
- 只读访问，不修改上下文状态
- 通过 `SnapshotProviders` 接口注入数据源

**评估**: Dashboard 快照服务不参与上下文组装，无污染风险。

---

## 三、发现的问题

### 3.1 P1-1: 经验召回正反馈循环（matchCount 只增不减）

**严重度**: P1（高）  
**文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts#L96-L99)  
**影响**: 早期被高频召回的经验会持续占据召回榜首，形成"经验回声室"，新经验难以突破。

**详细分析**:

```
召回路径: searchByQuery → ORDER BY relevanceScore DESC, matchCount DESC
反馈路径: incrementMatchCount → matchCount += 1
```

虽然 `CascadeManager.thompsonRerank` 引入了 30% 探索权重，但 matchCount 的累积效应会随时间放大。假设：
- 经验 A：初始 relevanceScore=0.7, matchCount=0
- 经验 B：初始 relevanceScore=0.9, matchCount=0

经过 10 次召回后，若 A 被优先召回 8 次，B 被召回 2 次：
- A: score=0.7, matchCount=8
- B: score=0.9, matchCount=2

按 `ORDER BY relevanceScore DESC, matchCount DESC` 排序，A 的 matchCount 优势可能压倒 B 的 relevanceScore 优势。

**修复建议**:
1. 为 matchCount 引入时间衰减因子（如每 7 天衰减 50%）
2. 或改为综合评分：`combinedScore = relevanceScore * 0.7 + normalizedMatchCount * 0.3`
3. 或定期运行"经验质量重评估"（已有 dreaming/cron 机制，可扩展）

### 3.2 P1-2: 压缩摘要无质量验证

**严重度**: P1（高）  
**文件**: [src/hooks/compaction.ts](file:///workspace/src/hooks/compaction.ts)  
**影响**: 低质量摘要可能污染后续推理，形成"错误积累"。

**详细分析**:

`onCompaction` hook 在压缩完成后：
1. 备份 memory 文件 ✅
2. 委托 lossless-claw 执行 DAG 压缩 ✅
3. 写入压缩标记文件 ✅
4. **缺少摘要质量验证** ❌

若压缩生成的摘要丢失关键信息（如 bug 修复的具体步骤），后续轮次可能基于不完整摘要产生错误推理。

**修复建议**:
1. 压缩后检查摘要长度是否在合理范围（如 100-2000 tokens）
2. 检查摘要是否包含原始消息中的关键实体/关键词
3. 可选：用轻量级 LLM 验证摘要是否与原始消息一致

### 3.3 P1-3: 场景感知检索的误分类无降级

**严重度**: P1（高）  
**文件**: [src/index.ts](file:///workspace/src/index.ts#L708-L717)  
**影响**: 场景分类错误可能导致检索偏向不相关的领域，间接污染上下文。

**详细分析**:

`detectScenarioAndAdjustLimits` 基于简单的关键词匹配进行场景分类，但：
- 没有置信度阈值
- 没有分类回退机制
- 若 query 同时匹配多个场景，行为不确定

**修复建议**:
1. 增加场景分类置信度（如匹配关键词数量/权重）
2. 低置信度时回退到均衡比例
3. 记录分类结果到 metrics，便于后续优化规则

### 3.4 P2-1: 工具指引注入量无上限

**严重度**: P2（中）  
**文件**: [src/plugin/tool-guidance.ts](file:///workspace/src/plugin/tool-guidance.ts)  
**影响**: 在 token 充裕时，全量工具指引可能占用不必要的上下文空间。

**修复建议**:
1. 压缩工具描述（如仅保留工具名和一句话描述）
2. 或根据 token 预算动态调整工具指引详细程度

### 3.5 P2-2: 紧急度检测误匹配风险

**严重度**: P2（中）  
**文件**: [src/context-inference.ts](file:///workspace/src/context-inference.ts#L26)  
**影响**: `error.*error` 模式可能误匹配正常讨论，导致不必要的紧急处理。

**修复建议**:
1. 收紧 `error.*error` 为 `error.*error|error.*occurred|multiple.*error`
2. 或增加负向模式（如 `handle.*error`、`catch.*error` 不触发）

---

## 四、防御机制总结

项目在上下文污染防御方面表现出色，以下是已实现的防御层次：

```
┌─────────────────────────────────────────────────────────┐
│ 第 1 层: 会话隔离                                        │
│  - dedup-cache / overhead-cache 按 sessionKey 隔离       │
│  - G-8 验证回路按 sessionKey 隔离 (v2.1.10 修复)         │
│  - lastAssembleExpIds 带 TTL (30min) + LRU 上限          │
├─────────────────────────────────────────────────────────┤
│ 第 2 层: 跨轮去重                                        │
│  - 24 轮哈希窗口去重                                     │
│  - 内容哈希 + 实体级去重                                 │
│  - 跨引擎结果 dedup (merger.ts)                          │
├─────────────────────────────────────────────────────────┤
│ 第 3 层: Token 预算控制                                  │
│  - 三级压力判定 (low/medium/high)                        │
│  - 检索限制动态调整                                      │
│  - applyTotalControl 分层裁剪                            │
│  - 硬截断兜底 (maxChars)                                 │
├─────────────────────────────────────────────────────────┤
│ 第 4 层: 内容质量                                        │
│  - 经验蒸馏白名单校验                                    │
│  - 时间衰减 (merger decay)                               │
│  - TTL 过期清理                                          │
│  - 熔断器保护 (circuit-breaker)                          │
├─────────────────────────────────────────────────────────┤
│ 第 5 层: 反馈修正                                        │
│  - G-8 异步验证回路 (delta ±0.05)                        │
│  - Thompson 采样探索 (30% 权重)                          │
│  - Tier 2/3 级联评估                                    │
│  - R-2 gm-pro judgeRecall 远程验证                      │
└─────────────────────────────────────────────────────────┘
```

---

## 五、与 GitHub 最新版本对比

**检查日期**: 2026-07-10  
**本地版本**: v2.1.11 (commit: `c2a4164`)  
**GitHub 最新 commit**: `c2a4164 perf: 第四批一致性与健壮性修复 + 版本升级至 2.1.11`

**结论**: 本地代码与 GitHub 最新版本一致，无差异。

### 近期关键修复（v2.1.10 → v2.1.11）

| 修复 | 关联上下文污染 | 说明 |
|------|:---:|------|
| B-1: G-8 验证回路会话隔离 | ✅ | 从模块级变量改为 Map<sessionKey> |
| P0-2 BUG-1: 修复 ?? 链失效 | 间接 | 配置读取正确后，token 预算控制更准确 |
| P2-9: LLM 超时集中化 | 间接 | 防止 LLM 调用超时导致上下文组装异常 |
| P1-5/6/9/10: 批量 I/O 优化 | 间接 | 减少 SQLite 阻塞，提升上下文组装稳定性 |

---

## 六、综合评分

| 维度 | 评分 | 说明 |
|------|:---:|------|
| 跨会话隔离 | 9/10 | 会话级缓存隔离完善，全局单例设计合理 |
| Token 预算控制 | 9/10 | 多层防御，压力感知 + 分层裁剪 + 硬截断 |
| 跨轮去重 | 9/10 | 哈希窗口 + 实体级去重 + 跨引擎合并 |
| 经验质量管理 | 7/10 | 蒸馏校验完善，但召回正反馈循环需关注 |
| 摘要质量保障 | 7/10 | 有压缩机制，但缺少质量验证步骤 |
| 场景分类准确度 | 7/10 | 简单规则匹配，无置信度和降级机制 |
| 整体架构设计 | 9/10 | 四层解耦，职责清晰，可扩展性强 |
| **综合** | **8.1/10** | **整体良好，3 个 P1 项建议修复** |

---

## 七、修复优先级建议

| 优先级 | 问题 | 建议时间 | 工作量 |
|:---:|------|:---:|:---:|
| P1 | 经验召回 matchCount 增加时间衰减 | 下个迭代 | 2h |
| P1 | 压缩摘要增加质量验证步骤 | 下个迭代 | 3h |
| P1 | 场景分类增加置信度阈值和降级 | 下个迭代 | 2h |
| P2 | 工具指引注入量优化 | 后续迭代 | 1h |
| P2 | 紧急度检测误匹配优化 | 后续迭代 | 0.5h |

---

**审计人**: AI 工程师 + Agent Harness 专家  
**审计工具**: 静态代码分析 + 架构审查  
**下次审计建议**: 在 P1 项修复后重新审计，并增加运行时上下文污染检测（如注入 token 分布监控）