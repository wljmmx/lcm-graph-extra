# lcm-graph-extra 代码 Wiki

> 本文件是仓库的结构化代码导航文档，覆盖：整体架构、主要模块职责、关键类与函数、依赖关系、配置体系、运行方式与安全设计。基于 v2.1.13（2026-09-04）源码整理。

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 整体架构](#2-整体架构)
- [3. 生命周期](#3-生命周期)
- [4. 目录结构总览](#4-目录结构总览)
- [5. 主要模块职责](#5-主要模块职责)
- [6. 关键类与函数](#6-关键类与函数)
- [7. Dashboard 监控看板](#7-dashboard-监控看板)
- [8. 依赖关系](#8-依赖关系)
- [9. 配置体系](#9-配置体系)
- [10. 运行方式](#10-运行方式)
- [11. 存储与数据流](#11-存储与数据流)
- [12. 测试与可观测性](#12-测试与可观测性)
- [13. 安全设计要点](#13-安全设计要点)
- [14. 术语表](#14-术语表)

---

## 1. 项目概述

**项目名**：`@openclaw/lcm-graph-extra`（插件内部名 `lcm-graph-extra`，子包 `@openclaw/lcm-dashboard`）
**类型**：OpenClaw 宿主（[openclaw.plugin.json](file:///workspace/openclaw.plugin.json) `kind=context-engine`）的 **ContextEngine 插件** + 独立**监控 Dashboard**（Vue 3）
**版本**：2.1.13 ｜ 语言：TypeScript（ESM，Node ≥ 20）｜ 许可证：MIT

**使命**：在每次 LLM 调用前自动注入检索上下文，协调 lossless-claw、qmd、graph-memory-pro 与经验总结层四层记忆，并提供轻量级可视化监控前台。

### 四层记忆检索架构

```
Layer 1  lossless-claw（内置）      会话消息 DAG + 摘要（无损压缩）
Layer 2  qmd MCP                   记忆文件 BM25 + 向量检索
Layer 3  Neo4j / graph-memory-pro  知识图谱实体 / 关系
Layer 4  EXPERIENCE 节点            异步蒸馏的经验总结（含 EVENT + SOLVED_BY 场景加权）
```

### 仓库构成

| 部分 | 路径 | 说明 |
|------|------|------|
| 主插件 | `src/` | ContextEngine 实现（检索、合并、级联、经验、工具等） |
| 监控看板 | `packages/dashboard/` | Fastify 后端 + Vue3 前端 |
| 文档 | `docs/`、`API.md`、`README.md`、`ROADMAP.md` 等 | 设计规格、API 参考、配置参考、故障排查 |
| 运维 | `Dockerfile`、`docker-compose.yml`、`.github/workflows/ci.yml`、`scripts/` | 容器化与 CI/CD |
| 审计/参考 | `audit/`、`.tmp-ref/` | 历史审计报告；graph-memory-pro 对接参考副本（非运行时依赖） |

---

## 2. 整体架构

### 2.1 分层结构（六层）

```
┌──────────────────────────────────────────────────────────────────┐
│ L1 入口/装配层（组合根）                                           │
│   src/index.ts 插件注册 · src/register.ts 类型 · src/lcm-bridge.ts │
│   构造 & 注入全部全局单例（graphAdapter/retrievalGateway/…）       │
├──────────────────────────────────────────────────────────────────┤
│ L2 生命周期编排层                                                  │
│   src/assemble/ · src/after-turn/ · src/hooks/ · src/core/lifecycle│
├──────────────────────────────────────────────────────────────────┤
│ L3 检索层                                                          │
│   assemble/retrieval.ts · retrieval-gateway.ts · merger.ts        │
│   entity-extract*.ts · assemble/retrieval-prefetch.ts             │
├──────────────────────────────────────────────────────────────────┤
│ L4 存储/服务层                                                     │
│   adapters/（Neo4j 池 + graph + embed + agent-db + gm-pro）       │
│   experience/storage.ts · core/graph.ts · async/usage-tracker     │
├──────────────────────────────────────────────────────────────────┤
│ L5 智能决策层                                                      │
│   moa/ · plugin/（tool-guidance/SAD/goal-cache/…）                │
│   cascade-manager.ts · circuit-breaker.ts · context-inference.ts  │
├──────────────────────────────────────────────────────────────────┤
│ L6 工具/基础层                                                     │
│   utils/ · config/ · async/ · tracing.ts · health-metrics.ts      │
│   dashboard-snapshot.ts · tools/（lcmg_* 工具实现）                │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 一逻辑轮的主调用链

```
host 调用 assemble
  → lcm-bridge 压力评估（PressureTier）
  → assemble/retrieval 消费「上一轮 afterTurn 预取缓存」或触发后台补水
  → 四引擎并行检索 → Merger 去重合并 → Cascade 级联评估/Thompson 重排
  → assemble/injection 四层注入 + Goal Anchoring + 冲突检测
  → （可选）MoA 触发决策/执行（异步聚合经 lcmg_moa_reply）
  → host LLM 生成
  → afterTurn：lossless-claw 落 DAG + 经验/三元组/用户画像 + 反馈闭环
      + 工具结果压缩 + 目标切换写债务 + O7 预取入队（供下一轮）
  → core/debt-manager（主轮门控让路）轮间异步压缩
  → hooks/onCompaction 兜底压缩
全程受 async/ 并发控制（main-turn-gate · ollama-slot · task-registry · prefetch-queue），
dashboard-snapshot / health-metrics / tracing 提供可观测性。
```

### 2.3 跨轮状态传递（assemble ↔ afterTurn）

| 缓存（会话级 Map） | 作用 |
|---|---|
| `prefetchCache`（O7） | afterTurn 预取 L2/L3/L4 结果，下一轮 assemble 直接消费，检索耗时移出用户感知路径 |
| `lastAssembleExpIdsBySession`（G-8） | 记录最近一轮 assemble 返回的经验 ID + query，供 afterTurn 异步验证；30min TTL |
| `sessionQualityScores`（R-5） | 会话级输出质量评分，assemble 用于调整检索门槛 |
| `conflictCache`（H-4） | 上一轮规则冲突检测结果注入本轮 |
| `llmRerankCache` / `l2QueryCache` / `l4QueryCache` | LLM 重排与 L2/L4 检索结果短期复用（5min TTL） |

会话级缓存（goal/overhead/dedup/tracker/SAD）统一按 `resolveSessionCacheKey`（sessionId 优先）隔离，在 `/new` 时由 [session-reset.ts](file:///workspace/src/session-reset.ts) 失效。

---

## 3. 生命周期

| 生命周期 | 位置 | 说明 |
|---|---|---|
| `ingest / ingestBatch` | `src/index.ts` | 轻量转发，真正落盘由 lossless-claw 处理 |
| `assemble` | [src/assemble/index.ts](file:///workspace/src/assemble/index.ts) + [src/index.ts](file:///workspace/src/index.ts) | 压力分级 → 四层检索 → MoA 管道 → 注入 → 总量控制 |
| `afterTurn` | [src/after-turn/index.ts](file:///workspace/src/after-turn/index.ts) | 经验触发检测 → LLM 三元组提取 → Neo4j upsert → G-8 异步验证回路 |
| `compact` | `src/hooks/compaction.ts`（onCompaction） | backup → lossless-claw DAG compact → 摘要质量验证 |
| `heartbeat` | `src/index.ts`（5min） | 压力检测 → TTL 清理 → 经验蒸馏 → 健康指标采集 |
| `maintain` / `dispose` | `src/index.ts`、`src/tools.ts` | 运维工具入口；资源释放（closeNeo4jDriver/closeLcmDb 等） |

详见 [API.md](file:///workspace/API.md) 生命周期钩子说明。

---

## 4. 目录结构总览

```
/workspace
├── src/                          # 主插件包（ContextEngine）
│   ├── index.ts                  # 插件注册组合根 + Window Monitor + Total Control + heartbeat
│   ├── register.ts               # OpenClawContext / PluginInstance 类型
│   ├── config.ts + config/       # TypeBox Schema + DEFAULTS 常量 + neo4j-helper
│   ├── types.ts                  # 公共类型（Neo4jConfig/RetrievalResult/GraphQueryExecutor）
│   ├── retrieval-gateway.ts      # 四引擎并行检索编排（R-1）
│   ├── merger.ts                 # 实体去重 + 时间衰减 + LLM 重排 + 冲突检测
│   ├── cascade-manager.ts        # R-2 成本感知级联 + Thompson 采样
│   ├── circuit-breaker.ts        # lcm/qmd/neo4j 三子系统熔断
│   ├── context-inference.ts      # 场景/技术栈/项目/紧急度规则推断
│   ├── health-metrics.ts         # N-4 健康指标 + 业务指标 + 延迟直方图
│   ├── dashboard-snapshot.ts     # 7423 端口内存态快照 / Prometheus / mcp-invoke
│   ├── capability-profiles.ts    # gm-pro 能力档次（4 档 + 硬件推荐）
│   ├── lcm-bridge.ts             # 与 lossless-claw 的 lcm.db 桥接（压力分级/debt/回溯）
│   ├── qmd-client.ts             # QMD 检索客户端（MCP→REST→CLI 三级降级）
│   ├── entity-extract.ts / entity-extractor.ts  # 实体提取与跨引擎去重
│   ├── session-reset.ts / topic-switch.ts / tracing.ts / tools-time.ts
│   ├── assemble/                 # 上下文组装：主流程/检索/注入/预取/指导语/查询改写/大工具存根
│   ├── after-turn/               # 轮后：经验提取/质量评分/工具结果压缩
│   ├── adapters/                 # graph-adapter / embed-fn / openclaw-agent-db / gm-pro-fallback / connection-pool
│   ├── experience/               # 经验系统：触发/提取/存储/TagRegistry/UserProfile
│   ├── moa/                      # 多智能体：orchestrator/classifier/complexity/learning-model/perf-tracker
│   ├── core/                     # 内存 DAG / TTL / 债务调度 / 生命周期
│   ├── hooks/                    # compaction 等生命周期 Hook
│   ├── middleware/               # lossless-claw 适配器（CE Factory 4 路发现）
│   ├── async/                    # 后台任务注册/主轮门控/Ollama 信号量/预取队列/冲突日志/用量追踪
│   ├── plugin/                   # 内部插件逻辑：dedup/goal/overhead/SAD/蒸馏/token 控制/tool-guidance
│   ├── tools/                    # lcmg_* 工具实现（diagnose/search/shared/tool-catalog）
│   └── utils/                    # logger / llm-call / commit-turn / deadline / session-key / url / pdf-export
├── packages/dashboard/           # @openclaw/lcm-dashboard 监控看板
│   ├── server/                   # Fastify 后端（index.ts + routes/ + lib/）
│   ├── src/                      # Vue3 + Naive UI + ECharts 前端
│   └── tests/                    # client/server 测试
├── scripts/                      # smoke.ts / verify-ce-registration.mjs / docker-security-check.sh
├── test/                         # bench / e2e / integration / perf
├── docs/                         # quick-start / config-reference / troubleshooting / specs / adr
└── 根配置                        # Dockerfile / docker-compose.yml / ci.yml / *.config.ts / openclaw.plugin.json
```

---

## 5. 主要模块职责

### 5.1 检索层

| 模块 | 文件 | 职责 |
|---|---|---|
| 四引擎检索网关 | [retrieval-gateway.ts](file:///workspace/src/retrieval-gateway.ts) | `RetrievalGateway` 并行编排 qmd / graph / distilledExp(L4) / eventExp 四路召回；`searchWithExperience()` 核心入口；显式超时 `globalTimeoutMs=15000ms`，慢查询阈值 `1000ms`；每引擎 `PerformanceStats` 统计 |
| 结果合并 | [merger.ts](file:///workspace/src/merger.ts) | `Merger.merge()`：id 去重（缺 id 用 md5(content) 兜底）→ 按实体分组（模糊阈值）→ 每实体 1 primary + ≤2 supplemental（0.85/0.7 系数）→ 实体优先级排序（跨源命中 > 实体分 > 类型 > 分数）→ 时间衰减 → 新鲜度加成；`llmRerank()` topK=10 |
| 冲突检测 | [merger.ts](file:///workspace/src/merger.ts) `detectConflicts()` | H-4 纯规则冲突（negation/version 两模式，≥500ms 可配），最多 3 条，零 LLM |
| 级联评估 | [cascade-manager.ts](file:///workspace/src/cascade-manager.ts) | R-2 三层置信度：Tier1 零成本启发式 / Tier2 LLM 判断（60s）/ Tier3 工具验证（90s，代码块+事实声明）；Thompson 采样重排（Beta 分布，`arms` LRU 上限 5000） |
| 场景推断 | [context-inference.ts](file:///workspace/src/context-inference.ts) | 纯规则：`inferQueryContext()` 结合 TagRegistry 推断 scenario/techStack/freeTags/项目/紧急度；`buildExperienceFilters()` |
| 查询改写 | [assemble/query-rewrite.ts](file:///workspace/src/assemble/query-rewrite.ts) | `needsQueryRewrite()` / `rewriteQuery()`：查询模糊时 LLM 改写 |
| 跨轮预取 | [assemble/retrieval-prefetch.ts](file:///workspace/src/assemble/retrieval-prefetch.ts) + [async/retrieval-prefetch-queue.ts](file:///workspace/src/async/retrieval-prefetch-queue.ts) | O7 预取缓存读写；队列内含查询相似度 coalesce + 有界并发 |

### 5.2 存储/服务适配层

| 模块 | 文件 | 职责 |
|---|---|---|
| 图谱适配 | [graph-adapter.ts](file:///workspace/src/adapters/graph-adapter.ts) | `GraphAdapter`：Neo4j 连接自愈、`searchWithCache/search/searchExperience`（PageRank 重排、superseded 过滤）、`batchUpsert`、`extractAndUpsertFromTurn`、`runMaintenance`、反馈闭环 | 动态 import graph-memory-pro 复用 Recaller/JudgeManager/AssociationMatrix |
| 连接池 | [connection-pool.ts](file:///workspace/src/adapters/connection-pool.ts) | 全局 Neo4j 驱动引用计数池 + 主动刷新防 session 断联（`acquireDriver/releaseDriver/drainPool/getPoolStats`） |
| 嵌入函数 | [embed-fn.ts](file:///workspace/src/adapters/embed-fn.ts) | Ollama（新 `/api/embed` + 旧 `/api/embeddings` 回退）+ OpenAI 兼容；keep_alive=1h；LRU 缓存 |
| 官方记忆只读 | [openclaw-agent-db.ts](file:///workspace/src/adapters/openclaw-agent-db.ts) | 只读 per-agent SQLite 索引，多词 OR + CJK bigram 召回 |
| gm-pro 降级 | [gm-pro-fallback.ts](file:///workspace/src/adapters/gm-pro-fallback.ts) | `withGmProFallback()` 对 judgeRecall/linkNodes/consolidateBuffer 等扩展 API 优雅降级 |
| 经验存储 | [experience/storage.ts](file:///workspace/src/experience/storage.ts) | EXPERIENCE 节点 CRUD：saveRaw/saveDistilled/searchByQuery（全文索引+CONTAINS 降级）/G-8 质量评分/Zettelkasten 关联/TTL 清理 |
| 内存 DAG | [core/graph.ts](file:///workspace/src/core/graph.ts) | 内存 DAG CRUD、深度/环检测、拓扑排序、序列化 |

### 5.3 经验系统（L4）

| 文件 | 职责 |
|---|---|
| [experience/index.ts](file:///workspace/src/experience/index.ts) | `detectExperienceTrigger()`（4 触发源：correction / failure / fix_success / explicit_save）+ `extractRawExperience()` |
| [experience/extractor.ts](file:///workspace/src/experience/extractor.ts) | 原始经验 → 蒸馏格式转换 |
| [experience/tag-registry.ts](file:///workspace/src/experience/tag-registry.ts) | 动态标签注册表（scenario/techStack 内置默认 + Neo4j 加载） |
| [experience/user-profile.ts](file:///workspace/src/experience/user-profile.ts) | S-7' 用户画像：零 LLM 规则提取 + SQLite 持久化 + 时间衰减；`observe()/computeBoost()/getTopTechStack()` |

### 5.4 并发/后台层

| 文件 | 关键导出 | 职责 |
|---|---|---|
| [async/task-registry.ts](file:///workspace/src/async/task-registry.ts) | `BackgroundTaskRegistry` / `backgroundTasks` | fire-and-forget 任务追踪，dispose 时 awaitAll |
| [async/main-turn-gate.ts](file:///workspace/src/async/main-turn-gate.ts) | `beginMainTurn/endMainTurn/isMainTurnActive` | 主轮门控：后台 LLM 任务让路主生成，防止 host "stopped making progress"（2.1.13 关键修复） |
| [async/ollama-slot.ts](file:///workspace/src/async/ollama-slot.ts) | `ollamaSlot` / `withOllamaSlot` | 全局 Ollama 并发信号量（默认 2） |
| [async/conflict-logger.ts](file:///workspace/src/async/conflict-logger.ts) | `ConflictLogger` | 图谱 upsert 冲突检测与日志（keep/replace/merge） |
| [async/usage-tracker.ts](file:///workspace/src/async/usage-tracker.ts) | `UsageTracker` | token 用量追踪（SQLite + JSON 降级） |

### 5.5 内部插件逻辑（plugin/）

| 文件 | 职责 |
|---|---|
| [plugin/dedup-cache.ts](file:///workspace/src/plugin/dedup-cache.ts) | 跨轮注入内容去重（hash） |
| [plugin/goal-cache.ts](file:///workspace/src/plugin/goal-cache.ts) | Goal Anchoring：会话级目标缓存，防目标漂移 |
| [plugin/overhead-cache.ts](file:///workspace/src/plugin/overhead-cache.ts) | SDK 系统 prompt token 开销缓存 |
| [plugin/sad-feedback.ts](file:///workspace/src/plugin/sad-feedback.ts) | SAD 自适应衰减反馈权重 |
| [plugin/tool-guidance.ts](file:///workspace/src/plugin/tool-guidance.ts) | L1-L5 智能工具策略（按查询意图推荐工具）+ 会话级追踪清理 |
| [plugin/task-decomposer.ts](file:///workspace/src/plugin/task-decomposer.ts) | 规则版任务分解 + SAD 联动 |
| [plugin/token-control.ts](file:///workspace/src/plugin/token-control.ts) | systemPromptAddition 按优先级裁剪（Total Control） |
| [plugin/distillation.ts](file:///workspace/src/plugin/distillation.ts) | 经验蒸馏 LLM 解析 + 本地主模型快照同步（G-MODEL-SYNC） |
| [plugin/keywords.ts](file:///workspace/src/plugin/keywords.ts) | 高频关键词提取 / 话题漂移检测 |

### 5.6 工具集（tools 层）

`src/tools.ts` 注册约 16~21 个 `lcmg_*` 操作工具（manifest 声明 21 个），核心工具：

| 工具 | 说明 |
|---|---|
| `lcmg_search` | 跨引擎联合搜索（all / lcm_only / qmd_only / neo4j_only） |
| `lcmg_experience_report` | 经验报告（时间范围 + type 过滤 + LLM 摘要） |
| `lcmg_get_document` / `lcmg_batch_get` | 单/批量文档查询 |
| `lcmg_pin` / `lcmg_forget` | 节点固定 / 主动遗忘（G-10 soft/hard） |
| `lcmg_distill` / `lcmg_distill_retry` / `lcmg_backfill` | 经验蒸馏/重试/回溯导入 |
| `lcmg_compact` | 手动触发放缩 compact |
| `lcmg_reset_breaker` | 重置熔断器（lcm/qmd/neo4j） |
| `lcmg_maintain` | 图谱维护（dedup/PageRank/community）+ 债务对账 |
| `lcmg_backup` / `lcmg_restore` / `lcmg_import` / `lcmg_sync` | 备份/恢复/导入/三端同步 |
| `lcmg_diagnose` | 健康诊断（6 章节：DB/qmd/Neo4j/熔断/指标/汇总） |
| `lcmg_config_get` / `lcmg_config_set` / `lcmg_moa_reply` | 配置读/热更/MoA 结果读取 |

安全相关实现：`CONFIG_UPDATABLE_WHITELIST` 热更新白名单、`redactConfigSecrets` 配置脱敏、`reconnectOrphanedDagSummaries` 孤儿 DAG 重连。

---

## 6. 关键类与函数

### 6.1 `RetrievalGateway`（src/retrieval-gateway.ts）

- 构造：`new RetrievalGateway(qmdClient, graphAdapter, mergerConfig)`
- `search(query): Promise<RetrievalResult[]>` — 双引擎检索
- `searchWithExperience(query): { general; experience }` — 四引擎增强检索（核心入口）
- `getPerfSummary(): string` / `health()` / `getLastQuery()` / getter `experience` `tags`

### 6.2 `Merger`（src/merger.ts）

- `merge(qmdResults, graphResults)` — 完整合并管线（见 5.1）
- `llmRerank(results, query, llmFn)` — LLM 重排（失败回退实体优先级）
- `detectConflicts(...)` — 规则冲突检测
- 时间衰减公式：`score * 0.5^(days/halfLife)`（halfLife 默认 30 天）；新鲜度加成：`0.85 + freshness*0.15`

### 6.3 `CascadeManager`（src/cascade-manager.ts，全局单例 `cascadeManager`）

- 置信度阈值默认 `0.7`
- `evaluateTier1(results)`：`tier1Score = clamp(avgScore*0.7 + countBonus(≤0.2) + matchBonus(≤0.15), 0, 1)`
- `evaluateTier2(query, results, llmFn)`：top5，超时 60s，只用于 `recordFeedback`
- `evaluateTier3(query, results, {searchFn, codeExecFn})`：超时 90s，`verified >= total/2`
- `thompsonRerank(results, scenario)`：`mixedScore = score*0.7 + betaSample*0.3`；新臂先验 `alpha = 1 + matchCount*0.1`
- `recordFeedback(armKey, success)`：`alpha+1 / beta+1`，clamp(100)；arm key 必须用 `makeArmKey(scenario, id)` 生成
- 监控：`getArmsCount()` / `getArmsSnapshot()`（top10，供 dashboard 只读）

### 6.4 `GraphAdapter`（src/adapters/graph-adapter.ts）

- 连接管理：`connect()` / `quickHealth()` / `health()`（驱动复用 + 自动自愈）
- 检索：`searchWithCache` / `search` / `searchExperience`（PageRank + PPR rerank + superseded 过滤）
- 写入：`batchUpsert` / `extractAndUpsertFromTurn`（LLM 三元组）/ `heuristicExtract` / `runMaintenance` / `detectCommunities` / `mergeNodes`
- 反馈闭环：`recordRecallToSessionCache → consumeAndProcessFeedback → processFeedback`

### 6.5 熔断器（src/circuit-breaker.ts）

- 子系统：`lcm | qmd | neo4j` ｜ 状态机：`CLOSED → OPEN → HALF_OPEN（单探测）→ CLOSED`
- 常量：`threshold=3`、`cooldownMs=30000`、`halfOpenTimeoutMs=5000`
- API：`isAvailable` / `recordSuccess` / `recordFailure` / `withCircuitBreaker(name, label, fn, retries=1)`（指数退避 `1000*2^(attempt-1)`）/ `getHealthSnapshot` / `resetCircuitBreaker`

### 6.6 健康指标（src/health-metrics.ts）

- 单例：`healthMetrics`（HealthMetricsCollector）/ `businessMetrics` / `latencyHistograms`
- 环形缓冲 `MAX_SNAPSHOTS=144`（≈12h @5min heartbeat）；SQLite 持久化 `~/.openclaw/lcm.db`（表：`health_metrics` 20 列、`health_cumulative`、`business_metrics`；保留 30 天）
- 延迟直方图：滑动 500 样本，P50/P90/P95/P99
- 关键方法：`collect` / `getLatest` / `getHistory(n=20)` / `recordAssemble` / `recordUxMetrics` / `recordCascadeConfidence`

### 6.7 `LosslessClawAdapter`（src/middleware/lossless-claw-adapter.ts）

- 单例：`getOrCreateLosslessClawAdapter()` / `resetSharedAdapter()`
- 4 路 CE Factory 发现：Symbol registry → shared-init → 文件扫描 → Fallback registry
- 代理能力：`ingest/ingestBatch/afterTurn/bootstrap/ensureBootstrapped/compact/allessemble/commitTurn/maintain/getSummaries`，含在途去重与 LLM 注入（G-MODEL-SYNC）

### 6.8 `DebtScheduler`（src/core/debt-manager.ts）

- `writeCompactionDebt`（在 lcm-bridge）/ `startScheduler` / `pollAndDispatch` / `processSingleDebt` / `resetStaleRunning` / `reconcileDebtTable`
- 与 `main-turn-gate` 协作：主轮进行时让路，轮间按优先级异步压缩

### 6.9 工具函数（src/utils/）

| 函数 | 职责 |
|---|---|
| `callLlm` / `isLocalLlm` | 统一 LLM 调用（openai/ollama/anthropic 兼容，Bearer/x-api-key 头） |
| `evaluateTurnCommit` | durable-turn 幂等提交 |
| `raceDeadline` | 全局期限兜底（避免挂起） |
| `resolveSessionCacheKey` | 会话缓存隔离键 |
| `cleanBaseURL` / `ensureOllamaV1Path` / `detectApiFormat` | URL 规范化 / API 格式自动探测 |
| `ensureFinalUserMessage` | 交付前 user 守卫（防止以 tool/assistant 结尾） |
| `exportMarkdownToPdf` / `exportMarkdownToFile` | 报告导出 |

---

## 7. Dashboard 监控看板

### 7.1 技术栈与结构

- **后端**：Fastify（`server/index.ts`），`@fastify/cors` / `rate-limit` / `static`
- **前端**：Vue 3（Composition API）+ Vue Router + Naive UI + ECharts（vue-echarts）+ TanStack Vue Query
- 目录：`server/`（index + routes/ 10 个 + lib/ 11 个）、`src/`（views + components + composables + api + utils + styles）

### 7.2 端口与代理

| 端口 | 服务 | 默认绑定 |
|---|---|---|
| 7421 | dashboard 后端（Fastify，含静态托管） | 127.0.0.1（Docker 内 0.0.0.0） |
| 7422 | 前端 dev（Vite，/api 代理 → 7421） | 127.0.0.1 |
| 7423 | 插件 /internal/snapshot（node:http） | 127.0.0.1 |

### 7.3 后端数据访问模型

```
直读 SQLite（node:sqlite 只读）: lcm.db / openclaw-agent.db / operation_logs.db（写日志）
直读 Neo4j（runReadQuery）    : experience/memory/graph-health
写操作主路径                   : POST /api/mcp/invoke → invokeMcpTool → 插件 :7423 /internal/mcp-invoke
  （工具白名单 ALLOWED_MCP_TOOLS + backup/restore 路径服务端硬校验 validatePathUnderOpenclaw）
gm-pro 写操作                  : /api/gm-pro/proxy/* 三张路径白名单（只读前缀/写精确/DELETE 精确）
```

### 7.4 后端端点清单

| 路由文件 | 端点（方法 + 路径） | 职责 |
|---|---|---|
| health.ts | GET `/api/health/history?n`、`/api/health/latest` | 健康指标时序/最新（结合 db + 插件 snapshot） |
| agent.ts | GET `/api/agent/status` | 转发 OpenClaw host 状态检查（默认 :18789） |
| experience.ts | GET `/api/experience/list|tags|relations/:id|:id/quality-history|:id`、POST `/api/experience/tags/merge`、GET `/api/operation-logs`、`/api/extract-rebuild/progress`、**POST `/api/mcp/invoke`** | 经验管理 + 运维 MCP 写转发 |
| memory.ts | GET `/api/memory/search?q=&engines=`、`/api/memory/graph?q=` | 四引擎记忆查询 + 图谱子图 |
| graph-health.ts | GET `/api/graph/health`、`/api/graph/health-score` | 图谱健康（转发插件 / gm-pro 落盘节点） |
| config.ts | GET/PATCH `/api/config`、`/api/config/schema/raw`、validate、PUT raw、`/api/capability-profile*`、`/api/gm-pro/config*` | 插件配置热更新（白名单）+ gm-pro 配置管理 |
| moa.ts | GET/PATCH `/api/moa/config`、`/api/moa/status`、`/api/moa/performance` | MoA 配置/状态/性能 |
| qmd-test.ts | GET `/api/qmd-test/default-url`、POST `/api/qmd-test` | QMD 延迟测试 |
| benchmark.ts | GET/POST `/api/benchmark/*`（fixtures/beir/history/report/run/run-stream SSE 等 15 个） | CE 引擎压测 + BEIR 数据集 + 报告导出 |
| gm-pro.ts | GET/POST/DELETE `/api/gm-pro/proxy/*` + SSE 透传 | graph-memory-pro HTTP 服务白名单代理 |

### 7.5 前端页面与组件

**页面（views/）**：

| 页面 | 职责 |
|---|---|
| overview（MonitorLayout 内） | 性能监控总览：KPI + 时序图 + 熔断器 + tier 趋势 |
| services | 核心服务状态（gm-pro/agent/熔断器/降级链路） |
| graph | 图谱健康中心（感知→洞察→运维→配置验证→探索） |
| ai | 智能引擎（AutoTuner/Doctor/关联矩阵） |
| metrics | 运行指标（runtime metrics/token/cascade/债务/用户画像） |
| moa | MoA 性能 |
| experience | 经验管理（过滤/列表/详情/关联图谱/遗忘固定） |
| memory | 记忆查询（列表/图谱双 Tab） |
| maintain | 维护（Operations 卡片 + 日志 + 历史） |
| settings | 设置（MOA/模型/通用/gm-pro 配置/能力档次/raw 编辑器） |
| testing（container） | 测试中心（benchmark / qmd-test tab 懒加载） |

**核心组件（components/monitor/ 共 25 个，按能力分组）**：
- 性能监控：`AgentStatusCard`、`CircuitBreakerCard`、`DegradedLayersCard`、`GmProHealth/Services/RuntimeMetricsCard`、`GraphHealthCard`、`TokenUsageCard`、`CascadeCard`、`DebtSchedulerCard`、`UserProfileCard`、`TopNodesChartCard`、`RetrievalStatusCard`
- 图谱/检索：`GraphExplorerCard`、`CommunitiesCard`、`DirtyNodesCard`、`GmProSchemaCard`、`RecallConfigCard`、`RecallTestCard`、`AutoTunerCard`、`DoctorCard`
- 关联矩阵：`AssociationMatrixCard/HeatmapCard/StateCard`
- 通用：`CardState` 及 `KpiCard`/`StatusIndicator`/`EChart`/`Icon`（零依赖 inline SVG）等

**Composables**：`useMonitorData`（14 路轮询聚合，health 10s / history 60s / agent 30s…）、`useBreakpoints`、`useTheme`（light/dark/auto，持久化 localStorage）

---

## 8. 依赖关系

### 8.1 内部依赖

```
index.ts（组合根）
 ├─► retrieval-gateway.ts ──► qmd-client.ts（MCP→REST→CLI 降级）
 │         │                 ► adapters/graph-adapter.ts（Neo4j via gm-pro）
 │         │                 ► merger.ts ──► entity-extractor.ts（跨引擎去重桥）
 │         │                 ► experience/storage.ts + tag-registry.ts（L4）
 │         │                 ► context-inference.ts（场景过滤）
 │         └─► 注入 dashboard-snapshot.ts 的 providers
 ├─► cascade-manager.ts（全局单例 cascadeManager）► config/defaults.ts
 ├─► circuit-breaker.ts（qmd/neo4j 调用侧包装）
 ├─► config.ts ──► config/defaults.ts（被几乎全部模块引用）
 ├─► lcm-bridge.ts ├─► lossless-claw 的 lcm.db
 ├─► health-metrics.ts ──► lcm.db（health_* / business_metrics 表）
 ├─► capability-profiles.ts（档次切换 → resolveContextProfile 反向配置）
 ├─► tools.ts ──► tools/shared.ts / search.ts / diagnose.ts
 └─► dashboard-snapshot.ts ► tools.getRegisteredToolHandler（/internal/mcp-invoke）
```

### 8.2 外部依赖

| 依赖 | 用途 |
|---|---|
| `openclaw`（peer ≥ 2026.7.2-beta.2） | 宿主插件 SDK（`plugin-sdk/plugin-entry`、CE 生命周期） |
| `@openclaw/graph-memory-pro`（可选 peer） | L3 图谱引擎（动态 import，Recaller/JudgeManager/AssociationMatrix） |
| `neo4j-driver ^6.0.1` | Neo4j 连接 |
| `better-sqlite3 ^11`（optional） | SQLite 原生加速（缺失时 JSON fallback） |
| `pino` / `typebox` / `vite` | 日志 / Schema / 构建 |
| Fastify + @fastify/cors·rate-limit·static | dashboard 后端 |
| vue / vue-router / naive-ui / echarts / vue-echarts / @tanstack/vue-query | dashboard 前端 |

### 8.3 外部服务端口

| 服务 | 地址/端口 | 用途 |
|---|---|---|
| QMD | `http://127.0.0.1:8081`（默认） | 记忆文件检索（REST/MCP） |
| Ollama | `http://127.0.0.1:18789`（默认） | 本地嵌入/蒸馏 LLM（keep_alive=1h） |
| OpenClaw host | `http://127.0.0.1:18789`（status 检查） | agent 状态 |
| Neo4j | `bolt://localhost:7687` / HTTP 7474 | 知识图谱 |

---

## 9. 配置体系

- 配置位置：`~/.openclaw/openclaw.json` 的 `plugins.entries["lcm-graph-extra"].config`（TypeBox Schema 校验 + 默认值），热更新受 `UPDATABLE_FIELDS`/`CONFIG_UPDATABLE_WHITELIST` 白名单限制
- Schema 数据源单一：`LLM_PROVIDERS = ['openai','ollama','deepseek','unsloth','custom','openclaw_hooks']`

### 9.1 压力等级（PressureTier）

| 等级 | 条件 | qmd | graph | exp | maxChars |
|---|---|---|---|---|---|
| low | 正常 | 5 | 5 | 3 | 6000 |
| medium | msg > 24 或 ratio > 0.70 | 3 | 3 | 1 | 3000 |
| high | msg > 48 或 ratio > 0.85 | 1 | 1 | 0 | 800 |

详见 [lcm-bridge.ts](file:///workspace/src/lcm-bridge.ts) `determinePressureTier()`（high: `msg>dedupRounds*2 || tokenRatio>=highThreshold`；medium: `msg>=dedupRounds || tokenRatio>=mediumThreshold`）。

### 9.2 主要配置分组（默认值节选）

| 分组 | 关键项 |
|---|---|
| experience | summaryMode、triggers（correction/failure/fix_success/explicit_save）、schedule（dreaming `0 3 * * *`、incremental `0 */12 * * *`）、relevanceThreshold=0.6 |
| compaction | triggerThreshold=20000、softThresholdTokens=163840、keepRecentTokens=131072 |
| lcmMonitor | contextWindow=262144、dedupRounds=24、highPressure=0.85、mediumPressure=0.70、proactive=0.55、systemPromptOverheadTokens=17000、compactTokenBudget=154624（≈`⌊window×0.59⌋`）、maxContextChars（low:12000/medium:6000/high:1600） |
| llmTimeouts | rerank 30s / judge 60s / validate 45s / summarize 90s / embed 60s / graphLlm 90s / cascadeTier2 60s / cascadeTier3 90s / distill 120s |
| qmd | qmdMcpTimeout=3000、qmdMcpQueryTimeout=30000、enableCliFallback=true |
| retrieval | limits{qmd:5, graph:5, exp:3}、judge(tier=1)、qmdQueryMaxChars=2000 |
| moa | complexityThreshold=0.6、benefitThreshold=0.10、mode auto/parallel/serial、enabledTiers=['low'] |
| embedding / neo4j | bolt://localhost:7687、GM_EMBED_API_KEY 兜底 |
| ttl | retentionDays=90、cleanupIntervalHours=24 |
| dashboardSnapshot | enabled=true、host=127.0.0.1、port=7423 |
| stubLargeToolPayloads | thresholdBytes=8000 |
| 全局常量 | `COMPACT_RATIO=0.59`、`SDK_OVERHEAD_TOKENS=55000`、`MAX_TOKENS_TIERS=[8192,16384,24576,32768]` |

### 9.3 能力档次（capability-profiles）

4 档：`minimal`(overhead=1) / `balanced`(=4，默认) / `performance`(=7) / `full`(=10)；每档含 9 个 gm-pro API 开关、`retrievalLimits`、9 个 feature 开关（r2CascadeTier2/3、s9TopicShift、s11Zettelkasten、s7UserProfile、r5DynamicMix、n2LlmRerank、g8Validation、incrementalMaintain）；`recommendProfileByHardware()` 按 CPU 核数 + 可用内存推荐。

### 9.4 主要环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DASHBOARD_PORT` / `DASHBOARD_HOST` | 7421 / 127.0.0.1 | dashboard 后端 |
| `DASHBOARD_AUTH` | 空 | `user:pass`，启用后所有 /api（除 ping）+ 生产模式所有路径需 Basic Auth |
| `REQUIRE_DASHBOARD_AUTH` | 空 | `true` 时 Docker 启动脚本拒绝无认证启动 |
| `DASHBOARD_RATE_LIMIT_MAX` / `_WINDOW` | 100 / 60 | 写操作限流 |
| `PLUGIN_SNAPSHOT_URL` | http://127.0.0.1:7423 | 插件快照地址 |
| `SNAPSHOT_ALLOWED_IPS` / `SNAPSHOT_SHUTDOWN_TOKEN` | 127.0.0.1 等 | 快照服务 IP 白名单 / shutdown 令牌 |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | bolt://localhost:7687 / neo4j / **neo4j** | Neo4j 集成 |
| `GM_EMBED_API_KEY` / `OPENAI_API_KEY` | 空 | 远程嵌入 / 蒸馏 LLM key 兜底 |
| `LOG_LEVEL` | info | 日志级别 |
| `LCMG_COMPACT_TIMEOUT_MS` / `LCMG_DISTILL_CONCURRENCY` | 300000 / 3 | 长任务保护 |

---

## 10. 运行方式

### 10.1 安装与构建

```bash
git clone https://github.com/wljmmx/lcm-graph-extra.git
cd lcm-graph-extra && npm install     # workspaces 装主包 + dashboard
npm run build                          # 主插件 tsup → dist/
npm run typecheck && npm run lint      # 类型检查 / lint
npm test                               # 主包 458 项测试
cd packages/dashboard && npm run build # dist-client/ + dist-server/index.js
```

### 10.2 Dashboard 运行

```bash
cd packages/dashboard
npm run dev          # 开发：后端 :7421 + 前端 :7422（/api 代理）
npm start            # 生产：NODE_ENV=production node dist-server/index.js
```

访问 `http://127.0.0.1:7421`（生产启用 Auth：`export DASHBOARD_AUTH="admin:your-secure-password"`）。

### 10.3 插件加载到 OpenClaw

插件作为 OpenClaw host 的**进程内扩展**加载：host 读取仓库根 [openclaw.plugin.json](file:///workspace/openclaw.plugin.json)（`id=lcm-graph-extra`、`kind=context-engine`、`requiresPlugins:["lossless-claw"]`、`activation.onStartup=true`）+ `package.json openclaw.extensions → ./dist/index.js`，经 `definePluginEntry` 的 `register()` 注册 ContextEngine 与 21 个 `lcmg_*` 工具，并在启动时拉起 :7423 快照服务（端口由配置 `dashboardSnapshot.port` 控制，非环境变量）。

### 10.4 Docker

```bash
docker compose up -d   # neo4j（7474/7687）+ dashboard（7421）
```

- `Dockerfile`：两阶段（node:20-alpine）；runtime 只装生产依赖；暴露 7421；HEALTHCHECK `wget /api/ping`；入口先跑 `docker-security-check.sh` 再起 dashboard 后端（镜像只含 dashboard，插件本体由 host 进程内加载）
- `docker-compose.yml`：neo4j（`NEO4J_AUTH=neo4j/lcmgraphextra`、apoc 插件）+ dashboard（`depends_on.service_healthy`，经 `host.docker.internal:7423` 访问宿主插件快照，默认 `DASHBOARD_AUTH=admin:changeme-docker-default` **生产必须改**）
- 注意：Docker 运行用户为 root；`docker-security-check.sh` 未设 `DASHBOARD_AUTH` 时打印 CRITICAL，`REQUIRE_DASHBOARD_AUTH=true` 时直接拒绝启动

### 10.5 CI（.github/workflows/ci.yml，push/PR 到 main）

5 个 job：`test`（typecheck+lint+主包测试）→ `version-check`（主包与 dashboard 版本一致）→ `dashboard-test` → `build`（依赖前三者，产物上传 artifact）→ `security-scan`（`npm audit --audit-level=high` + CodeQL）→ `perf-benchmark`（仅 push，性能基线）。

### 10.6 运维脚本

| 脚本 | 作用 |
|---|---|
| `npm run smoke`（scripts/smoke.ts） | 5 步 onboarding 冒烟（类型 → 插件表面 → register → assemble 降级 → dispose） |
| `scripts/verify-ce-registration.mjs` | 模拟 OpenClaw loader 校验 context-engine 注册 |
| `scripts/docker-security-check.sh` | 容器启动前安全门禁 |
| `run-perf-tests.sh`、`test/perf/*` | 性能测试（CE 报告见 test-perf/CE-report.md） |

---

## 11. 存储与数据流

| 存储 | 路径/位置 | 内容 |
|---|---|---|
| lcm.db（SQLite） | `~/.openclaw/lcm.db` | lossless-claw 消息/DAG + 本插件 `health_metrics`、`health_cumulative`、`business_metrics`、债务表 |
| openclaw-agent.sqlite | `~/.openclaw/agents/<id>/agent/` | per-agent 官方记忆（只读） |
| operation_logs.db | `~/.openclaw/` | dashboard 写操作日志（LRU 1000 条，写库前脱敏） |
| Neo4j | bolt://localhost:7687 | 图谱节点/关系 + EXPERIENCE + GraphHealthMetric |
| QMD | `~/.qmd/` | 记忆文件（BM25+向量） |
| 其他 | `~/.openclaw/lcm-graph-extra/logs/conflicts.log`、`state.json`、`archived_memory.json`、`large_files`（`~/.openclaw/lcm-files`） | 冲突日志/状态/归档/大工具外部分片 |

**核心数据流**：`assemble` 先查 `lcm-bridge` 算 PressureTier → `resolveContextProfile` + 能力档次决定配额 → `RetrievalGateway.searchWithExperience()` 四路并行召回 → `Merger.merge`（去重+衰减+freshness）→ 可选 Cascade（Thompson 重排/Tier2/Tier3，受 feature 开关控制）→ `health-metrics.recordAssemble` 采集 → `dashboard-snapshot` 经 :7423 暴露。`circuit-breaker` 在 qmd/neo4j 调用侧独立保护。

---

## 12. 测试与可观测性

- **测试**：521 项全通过（主包 26 文件 / 458 项；dashboard 8 文件 / 63 项）；含 unit/integration/e2e/bench/perf
- **可观测性**：
  - `/metrics`（Prometheus text v0.0.4，来自 snapshot server）—— 暴露 assemble/L2/L3/L4 延迟百分位、tier 分布、token 节省等
  - `/internal/snapshot`（内存态聚合：cascade/userProfile/graphAdapter/debt/retrieval/health/capabilityProfile）
  - `/internal/health`、`/internal/operation-graph`、`/internal/graph-health`、`/internal/moa-performance`
  - `lcmg_diagnose` 6 章节健康诊断、`tracing.ts` OTel 兼容 span
- **基准**：`test/perf/`（neo4j/qmd/latency-distribution/unit/CE 报告）；dashboard Benchmark 页面（内置 fixtures + BEIR 数据集 + SSE 流式压测）

---

## 13. 安全设计要点

> 依 security-best-practices 技能对 Vue 前端与 Node 后端进行检出，以下为已验证结果与注意事项（含行号依据）。

### 13.1 现状（已核查）

| 项 | 结论 | 依据 |
|---|---|---|
| 前端 XSS 面 | 仅 1 处 `v-html`（[Icon.vue:91](file:///workspace/packages/dashboard/src/components/Icon.vue#L91)），注入的是**硬编码本地 SVG 常量**（非用户输入），无 `innerHTML/insertAdjacentHTML/document.write`，无运行时模板编译 | Grep 全包检出 |
| 前端密钥泄漏 | **无 `VITE_` 环境变量**，`import.meta.env` 未用于敏感数据；localStorage 仅存主题/搜索历史/tier 趋势等非敏感 UI 状态 | Grep 全包检出 |
| 凭据携带 | API 客户端（[client.ts](file:///workspace/packages/dashboard/src/api/client.ts)）不写 cookie、不读 token；认证依赖**浏览器原生 Basic Auth** 自动附带（后端 `/api/auth/whoami` 探测） | 源码核实 |
| 后端认证 | `DASHBOARD_AUTH` 启用后覆盖所有 `/api/*`（除 `/api/ping`）+ 生产模式全部静态/SPA 路径；未配置且生产模式仅告警 | [server/index.ts](file:///workspace/packages/dashboard/server/index.ts) |
| 写路径白名单 | MCP 工具白名单 `ALLOWED_MCP_TOOLS`；backup/restore 路径服务端硬校验须在 `~/.openclaw` 下；`PATCH /api/config` 白名单 + 敏感字段禁止更新；gm-pro 代理三张路径白名单 | lib/mcp.ts、lib/neo4j.ts、routes/config.ts |
| 配置脱敏 | `redactSensitive`/`redactConfigSecrets` 递归脱敏 password/apiKey/token/secret/credential/auth 类字段（含 operation-logs 写库前） | [tools.ts](file:///workspace/src/tools.ts)、lib/operation-logs.ts |
| 响应头 | `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`；CORS 仅允许 127.0.0.1/localhost 来源 | [server/index.ts](file:///workspace/packages/dashboard/server/index.ts) |
| 限流 | 写操作限流（默认 100 次/60s，`keyGenerator: req.ip` 防 XFF 伪造）；snapshot 服务另有 IP 白名单 + 60/60s 限流 | server/index.ts、dashboard-snapshot.ts |
| 熔断器/subprocess 资源 | 半开单探测防雪崩；Snapshot 服务 maxConnections/socket 兜底防进程崩溃 | circuit-breaker.ts、dashboard-snapshot.ts |
| CI | `npm audit --audit-level=high` + CodeQL JS/TS 扫描 | ci.yml |

### 13.2 注意事项（建议关注）

| 级别 | 事项 | 依据 |
|---|---|---|
| 中 | **Neo4j 弱默认口令**：`process.env.NEO4J_PASSWORD ?? 'neo4j'` —— 生产必须显式配置强密码，否则图谱数据可被直读/写入 | [lib/neo4j.ts:20](file:///workspace/packages/dashboard/server/lib/neo4j.ts#L20)、docker-compose.yml（默认 `admin:changeme-docker-default`） |
| 中 | **直连写入口**：`lib/neo4j.ts` 的 `runWriteQuery` 是后端直连 Neo4j 的写能力（当前仅 experience tags merge 使用）——属少量直连写，建议后续收敛到 MCP 通道 | [lib/neo4j.ts](file:///workspace/packages/dashboard/server/lib/neo4j.ts) |
| 低 | **Docker 以 root 运行**（Dockerfile runtime 未切换非 root 用户）+ `require-trusted-types`/CSP 未在仓库层部署（若未在边缘层设置，建议补 CSP） | Dockerfile、VUE-HEADERS-001 |
| 低 | `GET /api/agent/status`、`/api/experience/tags`、`/api/extract-rebuild/progress` 为 GET 不限流 —— 只读探活场景，风险有限 | server/index.ts rate-limit allowList |

> 说明：本仓库无 `.env*` 被提交、无硬编码密钥（apiKey 均来自配置/环境变量）——符合 VUE-SECRETS-001/002 与前端"任何前端都属公开"的信任模型。

---

## 14. 术语表

| 术语 | 含义 |
|---|---|
| CE / ContextEngine | OpenClaw 宿主在每次 LLM 调用前执行上下文组装的引擎 |
| QMD | 记忆文件检索服务（BM25 + 向量），REST/MCP/CLI 三级可用 |
| lossless-claw | 会话消息 DAG 无损压缩引擎（Layer 1） |
| GM-Pro / graph-memory-pro | Neo4j 知识图谱引擎（Layer 3，可选集成，含 Recaller/Judge/关联矩阵） |
| EXPERIENCE | Layer 4 经验节点（蒸馏后固化到图谱） |
| PressureTier | low/medium/high 三级压力分级，动态调检索配额与注入预算 |
| R-2 级联 | 成本感知评估：Tier1 启发式 → Tier2 LLM 判断 → Tier3 工具验证 + Thompson 采样 |
| Merger | 实体级跨引擎合并（去重/衰减/新鲜度/LLM 重排） |
| DebtScheduler | compact 债务队列调度器（主轮门控让路） |
| MoA | Mixture-of-Agents 多模型编排（复杂度评估 + 能力校准 + 收益决策） |
| O7 预取 | afterTurn 预取下一轮 assemble 数据，检索耗时移出感知路径 |
| SAD 反馈 | 工具使用成功/失败的自适应衰减权重反馈 |