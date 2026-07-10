# lcm-graph-extra 上下文污染修复方案

> **版本**: v2.1.11 → v2.2.0  
> **日期**: 2026-07-10  
> **作者**: AI 工程师 + Agent Harness 专家  
> **范围**: P1-1 (经验召回正反馈) + P1-2 (摘要质量验证) + P1-3 (场景分类误分类)

---

## 总览

本文档针对审计报告中的 3 个 P1 级上下文污染风险点，提供完整可执行的修复方案。每个方案包含：

- **问题根因分析**：精确到代码行的根因
- **处理思路**：为什么这样修，以及如何通过 Harness 提升模型实际执行能力
- **完整代码变更**：可直接应用的 diff
- **验证方法**：如何确认修复生效

---

## 修复一：P1-1 — 经验召回正反馈循环

### 1.1 问题定位

**根因文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts)

**核心问题**：`incrementMatchCount()` 只增不减，而 `SEARCH_RELEVANT` 和 `SEARCH_BY_QUERY` 的排序均依赖 `matchCount DESC`，形成正反馈：

```
召回 → incrementMatchCount → matchCount 上升 → 排序更靠前 → 更容易被召回 → 循环
```

涉及的 Cypher 查询：

| 查询 | 行号 | 排序逻辑 |
|------|:---:|------|
| `SEARCH_RELEVANT` | 65 | `ORDER BY e.relevanceScore DESC, e.matchCount DESC` |
| `SEARCH_QUERY_TAIL` | 137 | `ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) DESC, e.matchCount DESC` |

**现有缓解措施不充分**：
- `CascadeManager.thompsonRerank` 引入 30% 探索权重，但只作用于 assemble 侧的运行时重排，不改变 Neo4j 查询结果
- `G-8 验证回路` 调整 `relevanceScore`（±0.05），但 matchCount 的累积效应独立于 relevanceScore
- 没有时间衰减机制

### 1.2 处理思路：为什么这样修，以及如何提升模型执行能力

#### 核心洞察

经验召回的本质是**信息检索**问题，不是**流行度排名**问题。当前 matchCount 等同于"被点开次数"，这是典型的推荐系统思维，但经验的"正确性"不等于"流行度"。

#### 设计原则

1. **时间衰减优先**：经验价值随时间递减，越久远的经验权重越低。这是最自然的修正——一个 3 个月前被高频召回的经验，不应该比上周刚产生的、relevanceScore 更高的经验排在前面。

2. **保留 matchCount 的正面作用**：matchCount 确实有信息量——被多次召回说明经验覆盖了多个不同的查询场景。完全去掉 matchCount 会丢失多样性信号。正确的做法是让它"有序衰减"。

3. **非侵入式**：不改变现有写入路径（incrementMatchCount 不变），只在读取路径（排序）引入衰减。这样已有数据无需迁移。

#### 对模型执行能力的提升

| 提升维度 | 具体效果 |
|---------|---------|
| **召回多样性** | 新蒸馏的经验（matchCount=0）不再被旧经验（matchCount=50+）完全压制，有公平机会被召回 |
| **时效性** | 与当前查询场景更相关的新经验优先展示，模型获得更准确的上下文 |
| **幻觉降低** | 旧经验可能包含过时的 API 用法或已修复的 bug 模式，时间衰减让这些自然退场 |
| **探索能力** | 与 Thompson 采样形成互补：Thompson 负责运行时随机探索，时间衰减负责长期结构优化 |

#### 为什么不直接用 combinedScore 替代

如果用 `combinedScore = relevanceScore * 0.7 + normalizedMatchCount * 0.3`，权重需要手动调参，且 matchCount 本身没有上限边界，normalizedMatchCount 需要一个"分母"——这个分母很难定义（是全局最大？还是预设上限？）。时间衰减更优雅：matchCount 的衰减速率由 `halfLifeDays` 控制，不需要预设上限。

### 1.3 方案设计

**核心改动**：在 Neo4j EXPERIENCE 节点上新增 `lastRecalledAt` 时间戳字段，在 Cypher 排序中引入时间衰减因子。

**衰减公式**：
```
decayFactor = 0.5 ^ ((currentTime - lastRecalledAt) / (halfLifeDays * 86400000))
decayedMatchCount = matchCount * decayFactor
```

**新的排序逻辑**：
```
ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) + (decayedMatchCount * 0.1) DESC
```

递减权重设计：
- `relevanceScore` 权重 0.6：静态质量（蒸馏时 LLM 评分 + G-8 动态调整）
- `queryMatch` 权重 0.4：动态匹配（当前查询与经验内容的语义相关性）
- `decayedMatchCount * 0.1`：边际贡献，衰减后的命中次数提供微小加成（最多 0.1 分）

### 1.4 代码变更

#### 变更 1: 修改 `INCREMENT_MATCH_COUNT` Cypher → 同时更新 `lastRecalledAt`

**文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts)

```diff
 const INCREMENT_MATCH_COUNT = `
   MATCH (e:${LABEL} {id: $id})
-  SET e.matchCount = coalesce(e.matchCount, 0) + 1
+  SET e.matchCount = coalesce(e.matchCount, 0) + 1,
+      e.lastRecalledAt = timestamp()
 `;
```

#### 变更 2: 修改 `SEARCH_RELEVANT` — 引入时间衰减排序

**文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts)

```diff
 const SEARCH_RELEVANT = `
   MATCH (e:${LABEL})
   WHERE e.status = 'DISTILLED'
     AND (e.state IS NULL OR e.state <> 'superseded')
     AND e.relevanceScore >= $minScore
     AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
-  RETURN e.id AS id,
+  WITH e,
+    CASE WHEN e.lastRecalledAt IS NOT NULL
+      THEN coalesce(e.matchCount, 0) * (0.5 ^ ((timestamp() - e.lastRecalledAt) / (1000.0 * 60 * 60 * 24 * $halfLifeDays)))
+      ELSE coalesce(e.matchCount, 0) * 0.5
+    END AS decayedMatchCount
+  RETURN e.id AS id,
          e.title AS title,
          e.summary AS summary,
          ... (fields unchanged)
          e.tags_free AS tags_free
-  ORDER BY e.relevanceScore DESC, e.matchCount DESC
+  ORDER BY e.relevanceScore DESC, decayedMatchCount DESC
   LIMIT $limit
 `;
```

#### 变更 3: 修改 `SEARCH_QUERY_TAIL` — 引入时间衰减排序

**文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts)

```diff
 const SEARCH_QUERY_TAIL = `
-        WITH e,
+        WITH e, $halfLifeDays AS halfLifeDays,
           (CASE WHEN toLower(COALESCE(e.summary, '')) CONTAINS toLower($queryKeyword) THEN 1.0 ELSE 0.0 END)
           ... (queryMatch calculation unchanged)
             ELSE 0.0 END) AS queryMatch
+        WITH e, queryMatch,
+          CASE WHEN e.lastRecalledAt IS NOT NULL
+            THEN coalesce(e.matchCount, 0) * (0.5 ^ ((timestamp() - e.lastRecalledAt) / (1000.0 * 60 * 60 * 24 * halfLifeDays)))
+            ELSE coalesce(e.matchCount, 0) * 0.5
+          END AS decayedMatchCount
         RETURN e.id AS id, e.title AS title, ... (fields unchanged),
                queryMatch AS queryMatch
-        ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) DESC, e.matchCount DESC
+        ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) + (decayedMatchCount * 0.1) DESC
         LIMIT $limit
 `;
```

#### 变更 4: 修改 `searchRelevant` 方法 — 传入 `halfLifeDays`

**文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts)

```diff
   async searchRelevant(
     minScore: number = 0.6,
     limit: number = 5,
+    halfLifeDays: number = 30,
   ): Promise<ExperienceSearchResult[]> {
     const rows = await this.adapter.query<ExperienceSearchRow>(
       SEARCH_RELEVANT,
-      { minScore, limit: Math.trunc(limit) },
+      { minScore, limit: Math.trunc(limit), halfLifeDays },
     );
```

#### 变更 5: 修改 `searchByQuery` 方法 — 传入 `halfLifeDays` 并添加 `lastRecalledAt` 到返回字段

**文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts)

```diff
   async searchByQuery(options: ExperienceQueryOptions): Promise<ExperienceSearchResult[]> {
     const {
       freeTags: queryFreeTags = [],
       query,
       scenarioTags = [],
       techStackTags = [],
       projects = [],
       minScore = 0.6,
       limit = 5,
+      halfLifeDays = 30,
     } = options;
```

在 `SEARCH_QUERY_TAIL` 的 RETURN 中增加 `e.lastRecalledAt AS lastRecalledAt`：

```diff
         RETURN e.id AS id, e.title AS title, e.summary AS summary, e.detail AS detail,
                e.context AS context, e.relevanceScore AS relevanceScore, e.createdAt AS createdAt,
-               e.matchCount AS matchCount, e.rawIds AS rawIds, e.type AS type,
+               e.matchCount AS matchCount, e.lastRecalledAt AS lastRecalledAt, e.rawIds AS rawIds, e.type AS type,
```

在 params 中传入 `halfLifeDays`：

```diff
     const params: Record<string, unknown> = {
       minScore,
       queryKeyword: query || '',
       scenarioTags: scenarioTags.length > 0 ? scenarioTags : [],
       techStackTags: techStackTags.length > 0 ? techStackTags : [],
       queryFreeTags: queryFreeTags.length > 0 ? queryFreeTags : [],
       projects: projects.length > 0 ? projects : [],
       limit: Math.trunc(limit),
+      halfLifeDays,
     };
```

#### 变更 6: 新增 `decayMatchCount` 方法（可选，用于 dreaming/cron 批量衰减）

**文件**: [src/experience/storage.ts](file:///workspace/src/experience/storage.ts) — 在 `cleanupExpired` 方法后添加

```typescript
  /**
   * P1-1 修复: 批量衰减长期未被召回的 matchCount。
   * 对 lastRecalledAt 超过 staleThresholdDays 的经验，matchCount 衰减 50%。
   * 由 dreaming/cron 定期调用，避免 matchCount 无限累积。
   *
   * @param staleThresholdDays 超过此天数未召回，触发衰减
   * @param batchSize 每批处理数量
   * @returns 本批次衰减的节点数
   */
  async decayMatchCount(
    staleThresholdDays: number = 14,
    batchSize: number = 100,
  ): Promise<number> {
    const result = await this.adapter.query(`
      MATCH (e:${LABEL})
      WHERE e.status = 'DISTILLED'
        AND e.lastRecalledAt IS NOT NULL
        AND e.lastRecalledAt < timestamp() - ${staleThresholdDays * 24 * 60 * 60 * 1000}
        AND e.matchCount > 0
      WITH e LIMIT ${batchSize}
      SET e.matchCount = round(e.matchCount * 0.5)
      RETURN count(e) AS decayed
    `);
    const row = result?.[0] as { decayed?: number } | undefined;
    return typeof row?.decayed === 'number' ? row.decayed : 0;
  }
```

#### 变更 7: 修改 `ExperienceStorage` 类型 — 增加 `halfLifeDays` 配置（可选）

**文件**: [src/experience/types.ts](file:///workspace/src/experience/types.ts) — 在 `ExperienceQueryOptions` 中增加字段

```diff
 export interface ExperienceQueryOptions {
   query?: string;
   freeTags?: string[];
   scenarioTags?: string[];
   techStackTags?: string[];
   projects?: string[];
   minScore?: number;
   limit?: number;
+  halfLifeDays?: number;  // P1-1: matchCount 时间衰减半衰期（天）
 }
```

#### 变更 8: 在 `config/defaults.ts` 中增加默认值

**文件**: [src/config/defaults.ts](file:///workspace/src/config/defaults.ts)

```diff
   retrieval: {
     expMinScore: 0.5,
+    expHalfLifeDays: 30,  // P1-1: matchCount 时间衰减半衰期
   },
```

### 1.5 验证方法

1. **单元测试**：在 `experience/storage.test.ts` 中增加测试用例
   - 创建经验 A（relevanceScore=0.7, matchCount=0）
   - 创建经验 B（relevanceScore=0.9, matchCount=50, lastRecalledAt=30天前）
   - 验证 B 的 decayedMatchCount 已衰减到约 25
   - 验证 A 排在 B 前面（因为 A 的 relevanceScore 更高且 matchCount 未衰减）

2. **集成测试**：
   - 观察 10 轮对话后的经验召回列表，确认新经验有机会进入前 3 名
   - 使用 `decayMatchCount` cron 任务后，确认长期未召回的经验 matchCount 降低

3. **Dashboard 观察**：
   - 在 Dashboard 经验视图查看 `lastRecalledAt` 和 `decayedMatchCount` 趋势

---

## 修复二：P1-2 — 压缩摘要质量验证

### 2.1 问题定位

**根因文件**: [src/hooks/compaction.ts](file:///workspace/src/hooks/compaction.ts)

`onCompaction` hook 在压缩完成后执行了以下步骤：
1. 备份 memory 文件 ✅
2. 委托 lossless-claw 执行 DAG 压缩 ✅
3. 写入压缩标记文件 ✅
4. **缺少摘要质量验证** ❌

**具体风险**：lossless-claw 的 `compact()` 返回 `CompactionResult`，包含 `result.summary`（摘要文本）和 `result.tokensBefore/tokensAfter`。当前代码 [行 170-179] 只打印日志，不验证摘要质量。

如果压缩生成的摘要：
- 丢失了关键信息（如 bug 修复的具体步骤、配置文件路径）
- 生成了幻觉内容（与原始消息不符）
- 过度压缩（摘要过短，丢失语义）

则后续轮次会基于错误/不完整的摘要进行推理，形成"错误积累"——每一轮基于错误摘要的回答，都可能产生新的错误信息，进一步污染上下文。

### 2.2 处理思路：为什么这样修，以及如何提升模型执行能力

#### 核心洞察

摘要压缩是 Agent Harness 上下文管理的**关键防线**。压缩做得好，模型获得精炼但完整的历史；压缩做得差，模型获得的是"垃圾进垃圾出"。当前代码把压缩质量完全交给 lossless-claw 内部机制，但 lossless-claw 是通用 DAG 压缩器，不了解业务上下文。

#### 设计原则

1. **零 LLM 调用**：质量检查必须是纯规则/统计的，不能引入额外 LLM 调用（否则在上下文紧张时反而加重负担）
2. **非阻塞**：质量检查不阻塞主流程，压缩结果无论好坏都会被使用，但低质量结果会被标记并记录
3. **渐进式**：先实现基础的统计检查，后续可扩展为语义检查

#### 检查维度

| 维度 | 检查方法 | 阈值 | 目的 |
|------|---------|------|------|
| 长度合理性 | 摘要 token 数 / 原始消息 token 数 | 0.05 ~ 0.50 | 过度压缩或压缩不足 |
| 实体保留率 | 摘要中出现的原始实体 / 原始实体总数 | ≥ 0.30 | 关键信息是否丢失 |
| 关键词保留率 | 摘要中出现的 TF-IDF 关键词 / 原始消息关键词 | ≥ 0.25 | 语义是否保持 |
| 空内容检测 | 摘要是否为空或仅含标点 | 非空 | 压缩完全失败 |

#### 对模型执行能力的提升

| 提升维度 | 具体效果 |
|---------|---------|
| **推理准确性** | 高质量摘要 = 准确的历史上下文 → 模型正确理解对话脉络 |
| **错误阻断** | 低质量摘要被标记 → 可触发降级策略（如使用原始消息替代摘要） |
| **可观测性** | 质量分数写入 metrics → Dashboard 可监控压缩质量趋势 |
| **自适应** | 质量分数反馈给 `compactTokenBudget` 调整 → 动态优化压缩激进程度 |

### 2.3 方案设计

在 `onCompaction` 的 step 2（压缩完成）之后，step 3 之前，插入质量检查步骤。

**数据流**：
```
compact() → CompactionResult
  ↓
extract quality metrics (length ratio, entity retention, keyword coverage)
  ↓
compute qualityScore [0, 1]
  ↓
if qualityScore < threshold → warn + mark degraded
  ↓
record qualityScore to metrics
```

### 2.4 代码变更

#### 变更 1: 新增质量检查函数

**文件**: [src/hooks/compaction.ts](file:///workspace/src/hooks/compaction.ts) — 在 `resolveBackupDir` 函数后添加

```typescript
/**
 * P1-2: 压缩摘要质量检查结果。
 */
interface CompactionQualityMetrics {
  qualityScore: number;       // [0, 1] 综合质量分数
  lengthRatio: number;        // 摘要 token 数 / 原始 token 数
  entityRetention: number;    // [0, 1] 实体保留率
  keywordRetention: number;   // [0, 1] 关键词保留率
  isEmpty: boolean;           // 摘要是否为空
  warnings: string[];         // 质量警告信息
}

/**
 * P1-2: 对压缩摘要进行质量检查。
 *
 * 检查维度：
 *   1. 空内容检测
 *   2. 长度合理性（过度压缩/压缩不足）
 *   3. 实体保留率（代码中的函数名、类名、文件路径等）
 *   4. 关键词保留率（高频词/TF-IDF top 词）
 *
 * 纯规则/统计方法，零 LLM 调用，不阻塞主流程。
 */
function validateCompactionQuality(
  summary: string,
  tokensBefore: number,
  tokensAfter: number,
  originalContent?: string,  // 可选：原始消息文本（用于实体/关键词对比）
): CompactionQualityMetrics {
  const warnings: string[] = [];

  // 1. 空内容检测
  const trimmed = (summary ?? '').trim();
  const isEmpty = trimmed.length === 0 || /^[\s\p{P}]+$/u.test(trimmed);
  if (isEmpty) {
    return {
      qualityScore: 0, lengthRatio: 0, entityRetention: 0, keywordRetention: 0,
      isEmpty: true, warnings: ['摘要为空或仅含标点符号'],
    };
  }

  // 2. 长度合理性
  const lengthRatio = tokensBefore > 0 ? tokensAfter / tokensBefore : 0;
  if (lengthRatio < 0.05) {
    warnings.push(`摘要过度压缩: 压缩比 ${(lengthRatio * 100).toFixed(1)}%（低于 5%），可能丢失关键信息`);
  }
  if (lengthRatio > 0.50) {
    warnings.push(`压缩不足: 压缩比 ${(lengthRatio * 100).toFixed(1)}%（高于 50%），摘要可能过于冗长`);
  }

  // 3. 实体保留率
  // 提取代码实体：函数名、类名、文件路径、配置项
  const entityPattern = /`([a-zA-Z_]\w{2,})`|([./][\w./-]+)|([A-Z][a-z]+(?:[A-Z][a-z]+)+)/g;
  let entityRetention = 1.0; // 无原始内容时默认满分
  if (originalContent) {
    const origEntities = new Set(Array.from(originalContent.matchAll(entityPattern), m => m[0]));
    const summaryEntities = new Set(Array.from(trimmed.matchAll(entityPattern), m => m[0]));
    if (origEntities.size > 0) {
      let retained = 0;
      for (const e of origEntities) {
        if (summaryEntities.has(e)) retained++;
      }
      entityRetention = retained / origEntities.size;
      if (entityRetention < 0.30) {
        warnings.push(`实体保留率过低: ${(entityRetention * 100).toFixed(0)}%（低于 30%），关键实体可能丢失`);
      }
    }
  }

  // 4. 关键词保留率（基于词频的简单 TF）
  let keywordRetention = 1.0;
  if (originalContent) {
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in', 'with', 'to', 'for',
      'of', 'that', 'this', 'was', 'are', 'be', 'been', 'has', 'had', 'have', 'it', 'its',
      '的', '是', '在', '了', '和', '与', '或', '不', '有', '我', '你', '他', '她', '它', '们',
    ]);
    const extractWords = (text: string): Map<string, number> => {
      const words = text.toLowerCase().split(/[\s,.;:!?()\[\]{}"'\n\r\t]+/).filter(w => w.length > 2 && !stopWords.has(w));
      const freq = new Map<string, number>();
      for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
      return freq;
    };
    const origWords = extractWords(originalContent);
    const summaryWords = extractWords(trimmed);

    // 取原始消息中 top 10 关键词
    const topOrig = [...origWords.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);
    if (topOrig.length > 0) {
      let retained = 0;
      for (const w of topOrig) {
        if (summaryWords.has(w)) retained++;
      }
      keywordRetention = retained / topOrig.length;
      if (keywordRetention < 0.25) {
        warnings.push(`关键词保留率过低: ${(keywordRetention * 100).toFixed(0)}%（低于 25%），语义可能偏离`);
      }
    }
  }

  // 综合评分
  const lengthScore = lengthRatio >= 0.05 && lengthRatio <= 0.50 ? 1.0
    : lengthRatio < 0.05 ? 0.3 : 0.7;
  const qualityScore = Math.round(
    (lengthScore * 0.3 + entityRetention * 0.4 + keywordRetention * 0.3) * 100
  ) / 100;

  return { qualityScore, lengthRatio, entityRetention, keywordRetention, isEmpty, warnings };
}
```

#### 变更 2: 在 `onCompaction` 中插入质量检查

**文件**: [src/hooks/compaction.ts](file:///workspace/src/hooks/compaction.ts) — 在 step 2 的日志记录之后插入

```diff
       if (didCompact) {
         logger?.info?.("compaction: lossless-claw DAG compact completed", {
           compacted: compactResult.compacted,
           tokensBefore: resultData.tokensBefore,
           tokensAfter: resultData.tokensAfter,
           condensed: resultData.condensed,
           createdSummaryId: resultData.createdSummaryId,
           summaryId: compactResult.summaryId,
           exhausted: compactResult.exhausted,
         });
+
+        // P1-2: 压缩摘要质量验证
+        try {
+          const summary = compactResult?.result?.summary ?? '';
+          const tokensBefore = compactResult?.result?.tokensBefore ?? 0;
+          const tokensAfter = compactResult?.result?.tokensAfter ?? 0;
+          
+          if (summary && tokensBefore > 0) {
+            const metrics = validateCompactionQuality(summary, tokensBefore, tokensAfter);
+            
+            // 记录质量指标
+            logger?.info?.("compaction: quality check", {
+              qualityScore: metrics.qualityScore,
+              lengthRatio: Number(metrics.lengthRatio.toFixed(3)),
+              entityRetention: Number(metrics.entityRetention.toFixed(3)),
+              keywordRetention: Number(metrics.keywordRetention.toFixed(3)),
+              warnings: metrics.warnings,
+            });
+
+            // 低质量摘要 → 告警 + 降级标记
+            if (metrics.qualityScore < 0.40) {
+              logger?.warn?.("compaction: LOW QUALITY summary detected", {
+                qualityScore: metrics.qualityScore,
+                warnings: metrics.warnings,
+                summaryId: compactResult.summaryId,
+              });
+              // 写入质量事件到 memory 目录，供 Dashboard 和后续流程参考
+              try {
+                const qualityPath = path.join(memoryDir, '.compaction-quality.json');
+                const previousMetrics = (() => {
+                  try {
+                    const raw = require('fs').readFileSync(qualityPath, 'utf-8');
+                    return JSON.parse(raw);
+                  } catch { return []; }
+                })();
+                previousMetrics.push({
+                  timestamp: new Date().toISOString(),
+                  summaryId: compactResult.summaryId,
+                  ...metrics,
+                });
+                // 只保留最近 20 条
+                await fs.writeFile(qualityPath, JSON.stringify(previousMetrics.slice(-20), null, 2));
+              } catch (e) { /* non-fatal */ }
+            }
+          }
+        } catch (qualityErr) {
+          logger?.debug?.("compaction: quality check failed (non-fatal)", { err: String(qualityErr) });
+        }
       } else {
```

### 2.5 验证方法

1. **单元测试**：在 `hooks/compaction.test.ts` 中增加测试
   - 正常摘要：`qualityScore ≈ 1.0`
   - 空摘要：`qualityScore = 0, isEmpty = true`
   - 过度压缩（1000 tokens → 5 tokens）：`qualityScore < 0.4`
   - 实体丢失（原始有 10 个实体，摘要仅保留 1 个）：`entityRetention < 0.3`

2. **集成测试**：
   - 触发一次压缩，观察日志中的 `compaction: quality check` 输出
   - 检查 `.compaction-quality.json` 文件是否正确生成

3. **Dashboard 集成**（可选后续）：
   - 在 Dashboard 压缩视图中展示最近 N 次压缩的质量分数趋势

---

## 修复三：P1-3 — 场景分类误分类无降级

### 3.1 问题定位

**根因文件**: [src/lcm-bridge.ts](file:///workspace/src/lcm-bridge.ts)

`detectScenarioAndAdjustLimits` 函数 [行 362-449] 使用简单的关键词匹配进行场景分类，存在以下问题：

1. **无置信度阈值**：`maxScore >= 1` 即认为检测到场景（[行 405]），但匹配 1 个关键词（如 query 中包含"error"）的置信度很低
2. **无平局处理**：多个场景得分相同时，取 `for...in` 遍历中第一个遇到的（[行 397-401]），行为不确定
3. **无分类降级**：分类后直接按场景调整比例（[行 415-436]），不验证分类是否合理
4. **关键问题**：`security-audit` 场景被映射到 `code-review` 类别（[行 427-431]），但 `security-audit` 和 `code-review` 的检索需求差异很大——安全审计更需要 QMD（查找漏洞模式），代码审查更需要 Experience（历史经验）

### 3.2 处理思路：为什么这样修，以及如何提升模型执行能力

#### 核心洞察

场景分类的目的是**优化检索资源分配**，而不是**精确识别用户意图**。因此，分类的容错性比准确性更重要——宁可"不调整"（使用均衡比例），也不要"错误调整"（把安全审计的资源分配给经验层）。

#### 设计原则

1. **置信度门控**：低置信度分类 → 不调整，使用均衡比例。这是最安全的策略。
2. **信号增强**：给不同关键词赋予不同权重。例如"crash"比"error"更能指示 bug-fix 场景，"安全"比"检查"更能指示 security-audit。
3. **平局打破**：当多个场景得分相同时，按优先级排序（bug-fix > config-debug > ...），优先选择更具体的场景。
4. **可观测性**：记录分类结果和置信度到 metrics，便于后续优化规则。

#### 场景优先级（平局打破顺序）

```
bug-fix > config-debug > performance-opt > security-audit > code-review > deployment > feature-dev > refactor
```

理由：bug-fix 是最紧急的场景，需要最精确的检索；refactor 是最宽泛的场景，可以作为兜底。

#### 对模型执行能力的提升

| 提升维度 | 具体效果 |
|---------|---------|
| **检索精度** | 高置信度分类 → 精确资源分配 → 模型获得更相关的上下文 |
| **稳定性** | 低置信度不调整 → 避免检索偏差 → 上下文质量稳定 |
| **安全审计** | 独立分类 → 安全场景获得正确的 QMD 权重 → 模型能参考漏洞模式 |
| **可观测性** | 分类置信度写入 metrics → 可监控分类质量，持续优化规则 |

### 3.3 方案设计

**核心改动**：
1. 引入加权关键词匹配（不同关键词不同权重）
2. 增加置信度阈值（默认 0.30，即加权分数 < 0.30 时视为不可靠）
3. 增加平局打破逻辑（按场景优先级）
4. 拆分 `security-audit` 为独立场景（与 `code-review` 有不同的检索偏好）
5. 记录分类结果到 metrics

### 3.4 代码变更

#### 变更: 重写 `detectScenarioAndAdjustLimits`

**文件**: [src/lcm-bridge.ts](file:///workspace/src/lcm-bridge.ts)

```typescript
/**
 * P1-3 修复: 场景感知检索 — 加权关键词匹配 + 置信度门控 + 平局打破。
 *
 * 核心改进：
 *   1. 关键词加权：不同关键词有不同权重（如 "crash" > "error"）
 *   2. 置信度门控：weightedScore < CONFIDENCE_THRESHOLD → 不调整，使用均衡比例
 *   3. 平局打破：按场景优先级排序
 *   4. security-audit 独立分类（与 code-review 有不同的检索偏好）
 *
 * 返回对象的 scenario 字段仅在置信度足够时非 null。
 */
export function detectScenarioAndAdjustLimits(
  query: string,
  baseLimits: RetrievalLimits,
): ScenarioAdjustResult {
  if (!query || !query.trim()) {
    return { scenario: null, limits: baseLimits, confidence: 0 };
  }

  const q = query.toLowerCase();

  // ---- 加权关键词（权重越高的词越能指示场景） ----
  // 最高权重 (1.0)：强信号词，单一命中即可确认场景
  // 中等权重 (0.6)：正常信号词
  // 低权重 (0.3)：弱信号词，需要组合命中

  const patterns: Record<string, { keywords: Array<[string, number]>; priority: number }> = {
    'bug-fix': {
      keywords: [
        ['crash', 1.0], ['segfault', 1.0], ['panic', 1.0], ['fatal', 1.0],
        ['exception', 0.6], ['修复', 0.6], ['报错', 0.6], ['崩溃', 0.6],
        ['bug', 0.6], ['error', 0.3], ['fail', 0.3], ['错误', 0.3], ['异常', 0.3],
      ],
      priority: 1, // 最高优先级
    },
    'config-debug': {
      keywords: [
        ['配置', 0.6], ['config', 0.6], ['setting', 0.6], ['设置', 0.6],
        ['deploy', 0.6], ['部署', 0.6], ['env', 0.6], ['环境变量', 0.6],
        ['环境', 0.3],
      ],
      priority: 2,
    },
    'performance-opt': {
      keywords: [
        ['perf', 0.6], ['性能', 0.6], ['优化', 0.6], ['optim', 0.6],
        ['slow', 0.6], ['慢', 0.6], ['latency', 0.6],
        ['提速', 0.3],
      ],
      priority: 3,
    },
    'security-audit': {
      keywords: [
        ['安全', 0.6], ['security', 0.6], ['vuln', 0.6], ['漏洞', 0.6],
        ['attack', 0.6], ['攻击', 0.6], ['inject', 0.6], ['注入', 0.6],
        ['auth', 0.6], ['认证', 0.6], ['permission', 0.6], ['权限', 0.6],
      ],
      priority: 4, // 独立分类，不同于 code-review
    },
    'code-review': {
      keywords: [
        ['review', 0.6], ['审查', 0.6], ['评审', 0.6],
        ['检查', 0.3], ['check', 0.3], ['audit', 0.3],
      ],
      priority: 5,
    },
    'deployment': {
      keywords: [
        ['deploy', 0.6], ['release', 0.6], ['发布', 0.6], ['上线', 0.6],
        ['ci', 0.6], ['pipeline', 0.6], ['流水线', 0.6],
        ['cd', 0.3],
      ],
      priority: 6,
    },
    'feature-dev': {
      keywords: [
        ['feature', 0.6], ['新功能', 0.6], ['implement', 0.6],
        ['add', 0.3], ['create', 0.3], ['build', 0.3], ['实现', 0.3], ['添加', 0.3], ['开发', 0.3],
      ],
      priority: 7,
    },
    'refactor': {
      keywords: [
        ['refactor', 0.6], ['重构', 0.6], ['rework', 0.6],
        ['改造', 0.3], ['整理', 0.3], ['restructure', 0.3],
      ],
      priority: 8, // 最低优先级（最宽泛）
    },
  };

  // 计算加权分数
  const scores: Array<{ scenario: string; score: number; priority: number }> = [];
  const maxPossibleScore = Object.values(patterns).reduce(
    (sum, p) => sum + p.keywords.reduce((s, [_, w]) => s + w, 0),
    0,
  );

  for (const [scenario, { keywords, priority }] of Object.entries(patterns)) {
    let weightedScore = 0;
    let totalWeight = 0;
    for (const [kw, weight] of keywords) {
      totalWeight += weight;
      if (q.includes(kw)) {
        weightedScore += weight;
      }
    }
    // 归一化：该场景的 weightedScore / 该场景的总权重
    const normalizedScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    scores.push({ scenario, score: normalizedScore, priority });
  }

  // 按 score 降序 → priority 升序（score 相同时，优先级高（数字小）的胜出）
  scores.sort((a, b) => b.score - a.score || a.priority - b.priority);

  const best = scores[0];

  // 置信度门控：加权分数低于阈值 → 不使用场景分类
  const CONFIDENCE_THRESHOLD = 0.30;
  if (!best || best.score < CONFIDENCE_THRESHOLD) {
    return {
      scenario: null,
      limits: baseLimits,
      confidence: best?.score ?? 0,
    };
  }

  // 高压力模式下不做调整（已经是最低限度）
  if (baseLimits.qmd <= 1 && baseLimits.graph <= 1) {
    return { scenario: best.scenario, limits: baseLimits, confidence: best.score };
  }

  // 按场景调整比例
  const totalBase = baseLimits.qmd + baseLimits.graph + baseLimits.exp;
  let qmdRatio = 0.45;
  let graphRatio = 0.35;
  let expRatio = 0.20;

  switch (best.scenario) {
    case 'bug-fix':
    case 'config-debug':
    case 'performance-opt':
      qmdRatio = 0.55; graphRatio = 0.30; expRatio = 0.15;
      break;
    case 'feature-dev':
    case 'refactor':
      qmdRatio = 0.40; graphRatio = 0.45; expRatio = 0.15;
      break;
    case 'code-review':
      qmdRatio = 0.30; graphRatio = 0.30; expRatio = 0.40;
      break;
    case 'security-audit':
      // P1-3: 安全审计独立分类 —— QMD 优先（查找漏洞模式/安全配置），
      // Experience 次之（历史安全事件），Graph 最低（代码结构关联性弱）
      qmdRatio = 0.50; graphRatio = 0.20; expRatio = 0.30;
      break;
    case 'deployment':
      qmdRatio = 0.55; graphRatio = 0.20; expRatio = 0.25;
      break;
  }

  const adjusted: RetrievalLimits = {
    qmd: Math.max(1, Math.round(totalBase * qmdRatio)),
    graph: Math.max(0, Math.round(totalBase * graphRatio)),
    exp: Math.max(0, Math.round(totalBase * expRatio)),
  };

  return { scenario: best.scenario, limits: adjusted, confidence: best.score };
}
```

#### 关联变更: 更新 `ScenarioAdjustResult` 类型

**文件**: [src/lcm-bridge.ts](file:///workspace/src/lcm-bridge.ts) — 找到该类型定义并修改

```diff
 export interface ScenarioAdjustResult {
   scenario: string | null;
   limits: RetrievalLimits;
+  confidence: number;  // P1-3: 分类置信度 [0, 1]
 }
```

#### 关联变更: 在 `index.ts` 中记录分类置信度

**文件**: [src/index.ts](file:///workspace/src/index.ts#L713-L717)

```diff
   const scenarioAdjust = detectScenarioAndAdjustLimits(qmdQuery, retrievalLimits);
   retrievalLimits = scenarioAdjust.limits;
   if (scenarioAdjust.scenario) {
-    logger?.debug?.("R-5 scenario-adjusted retrieval limits", { scenario: scenarioAdjust.scenario, limits: retrievalLimits });
+    logger?.debug?.("R-5 scenario-adjusted retrieval limits", {
+      scenario: scenarioAdjust.scenario,
+      confidence: Number(scenarioAdjust.confidence?.toFixed(3) ?? 0),
+      limits: retrievalLimits,
+    });
   }
```

#### 关联变更: 在 `index.ts` 中记录场景分类到 healthMetrics

**文件**: [src/index.ts](file:///workspace/src/index.ts#L944-L948) — 在 assemble 日志中增加场景信息

```diff
   logger?.info?.(`⚡ assemble=...`, {
     ...,
+    scenario: scenarioAdjust.scenario ?? 'none',
+    scenarioConfidence: scenarioAdjust.scenario ? Number(scenarioAdjust.confidence.toFixed(3)) : 0,
   });
```

### 3.5 验证方法

1. **单元测试**：在 `lcm-bridge.test.ts` 中增加测试
   ```typescript
   it('高置信度: "fix crash in login" → bug-fix', () => {
     const r = detectScenarioAndAdjustLimits('fix crash in login', { qmd: 5, graph: 5, exp: 3 });
     expect(r.scenario).toBe('bug-fix');
     expect(r.confidence).toBeGreaterThan(0.3);
   });

   it('低置信度: "hello world" → null (不调整)', () => {
     const r = detectScenarioAndAdjustLimits('hello world', { qmd: 5, graph: 5, exp: 3 });
     expect(r.scenario).toBeNull();
     expect(r.limits).toEqual({ qmd: 5, graph: 5, exp: 3 });
   });

   it('安全审计: "check SQL injection vulnerability" → security-audit', () => {
     const r = detectScenarioAndAdjustLimits('check SQL injection vulnerability', { qmd: 5, graph: 5, exp: 3 });
     expect(r.scenario).toBe('security-audit');
     // QMD 权重应高于 code-review
     expect(r.limits.qmd).toBeGreaterThanOrEqual(r.limits.exp);
   });
   ```

2. **集成测试**：
   - 用不同 query 触发 assemble，观察日志中的 `scenario` 和 `scenarioConfidence`
   - 验证低置信度 query 不触发检索比例调整

---

## 四、迭代计划

| 阶段 | 内容 | 预估工时 | 依赖 |
|:---:|------|:---:|------|
| **Phase 1** | P1-3 (场景分类) — 改动最小，风险最低 | 2h | 无 |
| **Phase 2** | P1-1 (经验召回) — 改动集中在 storage.ts | 2h | 无 |
| **Phase 3** | P1-2 (摘要质量) — 需要引入新函数 | 3h | 无 |
| **Phase 4** | 集成测试 + Dashboard 适配 | 2h | Phase 1-3 |
| **Phase 5** | 发布 v2.2.0 | 0.5h | Phase 4 |

**总计**: 约 9.5 工时

---

## 五、回滚方案

每个修复都是**独立模块**，可以单独回滚：

| 修复 | 回滚方式 | 影响范围 |
|------|---------|------|
| P1-1 | 回退 `storage.ts` 中 Cypher 查询，`lastRecalledAt` 字段保留无副作用 | 仅经验召回排序 |
| P1-2 | 回退 `compaction.ts` 中新增的质量检查代码块 | 仅压缩后处理 |
| P1-3 | 回退 `lcm-bridge.ts` 中 `detectScenarioAndAdjustLimits` 函数 | 仅检索比例调整 |

---

## 六、附录：变更文件清单

| 文件 | 变更类型 | 行数 |
|------|:---:|:---:|
| `src/experience/storage.ts` | 修改 Cypher + 新增方法 | ~40 |
| `src/experience/types.ts` | 新增字段 | ~2 |
| `src/config/defaults.ts` | 新增配置项 | ~1 |
| `src/hooks/compaction.ts` | 新增函数 + 插入调用 | ~80 |
| `src/lcm-bridge.ts` | 重写函数 + 新增类型 | ~100 |
| `src/index.ts` | 日志增强 | ~6 |
| **总计** | | **~229** |