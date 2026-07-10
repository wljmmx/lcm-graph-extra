# lcm-graph-extra v2.1.10 性能审计与优化改造方案

> 审计日期：2026-07-04｜重新评估日期：2026-07-10
> 审计范围：`/workspace/src` 全量代码（生命周期/检索/存储/适配器/工具/熔断/债务/快照）
> 基线版本：v2.1.10（commit 8f8b114，main 分支）+ 第一批修复（未提交）
> 测试基线：619 项通过（30 个文件）｜tsc 类型检查：通过
> 审计方法：逐文件源码追溯 + 配置值核对 + 调用链验证 + 2026-07-10 三路并行复审

---

## 〇、重新评估结论（2026-07-10）

**合并状态**：`main` 是 GitHub 上唯一远程分支（commit 8f8b114），无待合并分支；前序会话已清理所有 `trae/*` 分支。

**第一批修复进展**（5/25 项，未提交，已通过 tsc + 619 项测试验证）：

| 编号 | 问题 | 状态 | 验证 |
|------|------|------|------|
| P0-5 | embed keep_alive 失效 | ✅ 已修复 | 5 个 embed-fn 测试更新通过 |
| P1-1 | fuzzyMatchThreshold 死配置 | ✅ 已修复 | entity-extractor + merger 测试通过 |
| P1-2 | decayHalfLifeDays 不一致 | ✅ 已修复 | 统一为 DEFAULTS.ttl.halfLifeDays |
| P1-3 | afterTurn 同步 I/O | ✅ 已修复 | 缓存函数 + 调用点替换 |
| P1-7 | Tier2 LLM 缺 keep_alive | ✅ 已修复 | withKeepAliveIfOllama 注入 |

**待修复（20 项）**：经 2026-07-10 三路并行子代理逐项核查，4 个 P0 + 6 个 P1 + 10 个 P2 **全部确认仍存在**，行号已同步至当前代码。

**优先级建议**：下一批应聚焦剩余 4 个 P0（P0-1 双管线 / P0-2 优先级冲突 / P0-3 compact 超时 / P0-4 tags 类型），它们影响核心功能与稳定性。

---

## 一、能力清单与成熟度评估

| 能力域 | 子能力 | 成熟度 | 评估依据 |
|--------|--------|--------|----------|
| **检索** | 四层并行（L1 lossless / L2 qmd / L3 graph / L4 experience） | ⚠️ 中 | `RetrievalGateway` 与 `assemble` 两套管线并存，主路径绕过 gateway |
| | qmd MCP+REST+CLI 三层降级 | ✅ 高 | 超时 3s/30s 分层，ping 30s 自动恢复 |
| | multiGet 批量文档 | ✅ 高 | 基于 L2 file paths 聚合 |
| | 标签过滤 | ⚠️ 中 | tags 存逗号字符串、查询按数组迭代，类型不匹配 |
| **经验层** | 4 触发源 + PENDING→DISTILLED 蒸馏 | ✅ 高 | heartbeat 2h 调度，串行 LLM（15s 超时） |
| | Query-aware 混合搜索（60% relevance + 40% queryMatch） | ✅ 高 | 四维 queryMatch 加权 |
| | Zettelkasten link 关联 | ⚠️ 中 | `linkRelated` 无 LIMIT 中间结果，大图性能风险 |
| | TTL 清理（90 天 + 24h cleanup） | ✅ 高 | heartbeat 分批删除，最多 10 轮 |
| **压力/Token** | PressureTier 三级（low/medium/high） | ✅ 高 | 阈值 0.70/0.85，maxContextChars 12k/6k/1.6k |
| | applyTotalControl 优先级裁剪 | ⚠️ 中 | 与 priority-trim 两套优先级体系冲突 |
| | 预压缩（ratio>0.65） | ✅ 高 | fire-and-forget，不阻塞主路径 |
| **压缩/维护** | compact lifecycle（300s timeout + AbortSignal） | ⚠️ 中 | lossless-claw adapter compact 无超时透传 |
| | debt-manager（60s 轮询 + 紧急度 0.7 + 并发 1） | ⚠️ 中 | sessionFile 线性扫描 O(N) |
| | applyWeightDecay（0.5^(days/halfLife)） | ✅ 高 | halfLife 已统一为 DEFAULTS.ttl.halfLifeDays（P1-2 已修复） |
| **工具** | 18 个 MCP 工具 | ⚠️ 中 | 4 个工具每次新建 QmdClient，不复用单例 |
| | lcmg_backup/restore 全量 I/O | ❌ 低 | 全表扫描无 LIMIT + 同步文件读写 |
| | lcmg_sync 孤儿检测 | ⚠️ 中 | Phase 1 嵌套 SQLite N 次往返 |
| **编排** | assemble 三引擎 Promise.all 并行 | ✅ 高 | 每路独立 try/catch + 熔断器 |
| | Merger 实体级去重 + 时间衰减 | ✅ 高 | fuzzyMatchThreshold 配置已生效（P1-1 已修复） |
| | LLM 重排（low tier + tokenRatio<0.25） | ✅ 高 | 1500ms 超时收紧，失败 fallback |
| **故障保护** | 三个熔断器（lcm/qmd/neo4j） | ⚠️ 中 | lcm 熔断器空转（无生产调用点） |
| | 自动重试 + AbortSignal 全生命周期 | ✅ 高 | withCircuitBreaker backoff 1s/2s |
| | BackgroundTaskRegistry dispose 等待 | ✅ 高 | awaitAll(5s) + 15 处注册点 |
| **Dashboard** | /internal/snapshot 内存态聚合 | ✅ 高 | 6 provider 延迟求值，无 DB 调用 |
| | /metrics Prometheus 导出 | ✅ 高 | 纯内存计算 |
| | 四模块前端（监控/经验/记忆/维护） | ✅ 高 | Vue 3 + Naive UI + ECharts |

**总体成熟度**：**中高**。核心检索与编排稳定，但存在配置死代码、双管线并存、I/O 阻塞等可优化点。

---

## 二、发现的问题分级

### P0（严重 — 影响核心功能或稳定性）

| 编号 | 问题 | 位置 | 影响 |
|------|------|------|------|
| **P0-1** | `assemble` 完全绕过 `RetrievalGateway`，两套检索管线并存 | [index.ts](file:///workspace/src/index.ts#L694-L791) vs [retrieval-gateway.ts](file:///workspace/src/retrieval-gateway.ts#L132-L195) | gateway 的超时保护/统计/上下文推断在主路径失效；minScore 不一致（0.5 vs 0.6）；维护成本翻倍 |
| **P0-2** | `applyTotalControl` 与 `priority-trim` 优先级冲突 | [token-control.ts](file:///workspace/src/plugin/token-control.ts#L81-L104) vs [index.ts](file:///workspace/src/index.ts#L1298-L1316) | priority-trim 保护经验(L4)→applyTotalControl 又先裁经验，实际裁剪顺序与设计意图相悖 |
| **P0-3** | lossless-claw adapter `compact()` 无超时透传 | [lossless-claw-adapter.ts](file:///workspace/src/middleware/lossless-claw-adapter.ts#L486) | compact 是唯一 `throw` 的调用，若 lossless-claw 内部挂起，调用方无限等待 |
| **P0-4** | experience tags 类型不匹配（存逗号字符串、查询按数组迭代） | [storage.ts](file:///workspace/src/experience/storage.ts#L229-L234) 写入 vs [L142-L145](file:///workspace/src/experience/storage.ts#L142-L145) 查询 | `ANY(s IN COALESCE(e.tags_scenario, []))` 对字符串逐字符迭代，标签过滤可能完全失效 |
| **P0-5** ✅ 已修复（第一批） | embed keep_alive 完全失效：默认 baseURL 带 `/v1` 导致走 OpenAI 兼容端点，Ollama 忽略 keep_alive | [embed-fn.ts](file:///workspace/src/adapters/embed-fn.ts#L82-L90) 改用 `isOllamaEndpoint` 判断并剥离 `/v1` 后缀走原生 `/api/embed`；[neo4j-helper.ts](file:///workspace/src/config/neo4j-helper.ts#L131) 默认改为 `http://127.0.0.1:11434` | 修复后 keep_alive=1h 生效，模型常驻内存；配套 5 个测试已更新验证新行为 |

### P1（中等 — 性能损耗或配置失效）

| 编号 | 问题 | 位置 | 影响 |
|------|------|------|------|
| **P1-1** ✅ 已修复（第一批） | `fuzzyMatchThreshold` 死配置 | [entity-extractor.ts](file:///workspace/src/entity-extractor.ts#L33) 已接受 `fuzzyMatchThreshold` 参数；[merger.ts](file:///workspace/src/merger.ts#L66) 传递 `this.config.fuzzyMatchThreshold` | 配置现生效（0.85），用户可调 |
| **P1-2** ✅ 已修复（第一批） | `decayHalfLifeDays` 双常量不一致 | [index.ts](file:///workspace/src/index.ts#L220) 改为 `DEFAULTS.ttl.halfLifeDays` | 统一为 45，与 defaults.ts 一致 |
| **P1-3** ✅ 已修复（第一批） | `afterTurn` 热路径每次 `readFileSync` 读 openclaw.json | [index.ts](file:///workspace/src/index.ts#L82-L96) 缓存函数 + [L1649](file:///workspace/src/index.ts#L1649) 调用点替换 | 进程生命周期内仅读一次，与 neo4j-helper 模式一致 |
| **P1-4** | 4 个 MCP 工具每次 `new QmdClient()` 不复用单例 | [tools.ts](file:///workspace/src/tools.ts#L1200) lcmg_search、L1712 lcmg_qmd_status、L1753 lcmg_get_document、L1786 lcmg_batch_get（另 L1030 第 5 处） | 与 retrieval-gateway 行为不一致，重复建连开销 |
| **P1-5** | `lcmg_backup` 全表扫描无 LIMIT + 同步文件读写 | [tools.ts](file:///workspace/src/tools.ts#L671) `MATCH (n) RETURN n` + [L678](file:///workspace/src/tools.ts#L678) `MATCH ()-[r]->() RETURN r`；同步 I/O L713/L717/L725 | 全表扫描无 LIMIT + 同步 readFileSync/writeFileSync |
| **P1-6** | `lcmg_sync` Phase 1 嵌套 SQLite N 次往返 | [tools.ts](file:///workspace/src/tools.ts#L1512) 逐行 `SELECT COUNT(*)`（另 L1568-1570、L1603-105 同类） | Neo4j session 内逐行 SQLite 往返 |
| **P1-7** ✅ 已修复（第一批） | Tier2 LLM 判断未注入 keep_alive | [index.ts](file:///workspace/src/index.ts#L1050-L1056) body 改用 `withKeepAliveIfOllama` | 与其他 LLM 调用一致，避免模型卸载 |
| **P1-8** | lcm 熔断器空转（无生产调用点） | [circuit-breaker.ts](file:///workspace/src/circuit-breaker.ts#L10) 定义 `lcm`；仅 [circuit-breaker.test.ts L73](file:///workspace/src/circuit-breaker.test.ts#L73) 测试调用 | 生产无 `withCircuitBreaker("lcm", ...)` 调用点 |
| **P1-9** | `searchWithCache` 标记 @deprecated 仍活跃使用 | [graph-adapter.ts](file:///workspace/src/adapters/graph-adapter.ts#L395) 标注 vs [index.ts L756](file:///workspace/src/index.ts#L756) 调用 | 每次 L3 搜索额外 1 次 Neo4j session 做 community enrichment |
| **P1-10** | `graph-adapter.upsertEntities()` per-entity N+1 | [graph-adapter.ts](file:///workspace/src/adapters/graph-adapter.ts#L715) 循环、[L718](file:///workspace/src/adapters/graph-adapter.ts#L718) findById、L734/747/761 upsertNode；batchUpsert 存在于 [L579](file:///workspace/src/adapters/graph-adapter.ts#L579) 未替换 | per-entity findById + upsertNode，与 batchUpsert 并存 |

### P2（轻微 — 优化空间或一致性）

| 编号 | 问题 | 位置 | 影响 |
|------|------|------|------|
| **P2-1** | `lastAssembleExpIdsBySession` 无 TTL | [index.ts L79-80](file:///workspace/src/index.ts#L79) 声明 + [L1203-1205](file:///workspace/src/index.ts#L1203) 仅 size 淘汰 | 仅 LRU 上限 200，长生命周期进程 200 条 session 元数据常驻 |
| **P2-2** | `runDistillation` 串行 LLM 调用 | [distillation.ts L136-200](file:///workspace/src/plugin/distillation.ts#L136) 循环内 await；[L70-71](file:///workspace/src/plugin/distillation.ts#L70) 15s 超时 | batch=5 时 5 次串行 15s 超时 |
| **P2-3** | G-8 验证回路串行 LLM（每经验一次，最多 3 条） | [index.ts L1747-1802](file:///workspace/src/index.ts#L1747) 循环内 await；[L1762](file:///workspace/src/index.ts#L1762) 5s 超时 | 3 次串行 5s 超时 |
| **P2-4** | `lcmg_search` Neo4j 分支无索引全属性 CONTAINS 扫描 | [tools.ts L1241-1247](file:///workspace/src/tools.ts#L1241)（另 L1350-1355 同类） | `n.name CONTAINS $k OR n.content CONTAINS $k` 无索引提示 |
| **P2-5** | `linkRelated`/`findRelatedByConcepts` 无 LIMIT 中间结果 | [storage.ts L369-405](file:///workspace/src/experience/storage.ts#L369) + [L415-444](file:///workspace/src/experience/storage.ts#L415) | `MATCH (other:EXPERIENCE) WHERE other.status='DISTILLED'` 大图中间结果集巨大 |
| **P2-6** | health-metrics 与 lcm-bridge 共用 lcm.db 但驱动不同 + 无 WAL | [health-metrics.ts L278-302](file:///workspace/src/health-metrics.ts#L278) 无 PRAGMA；[lcm-bridge.ts L73-77](file:///workspace/src/lcm-bridge.ts#L73) 设 WAL | node:sqlite 无 PRAGMA，与 lcm-bridge WAL 连接共存行为依赖 SQLite 版本 |
| **P2-7** | debt-manager `processSingleDebt` 同步 `readdirSync` + `JSON.parse` | [debt-manager.ts L362](file:///workspace/src/core/debt-manager.ts#L362) readdirSync + [L365](file:///workspace/src/core/debt-manager.ts#L365) readFileSync；setInterval [L513](file:///workspace/src/core/debt-manager.ts#L513) | setInterval 回调中阻塞事件循环 |
| **P2-8** | 错误路径 O(N²) token 估算 | [index.ts L1504-1520](file:///workspace/src/index.ts#L1504) while [L1508-1516](file:///workspace/src/index.ts#L1508) | catch 分支 while 循环内反复全量 `estimateTokensFromMessages` |
| **P2-9** | LLM 超时不一致（1500ms ~ 30000ms 跨 20 倍） | index.ts L853(1500)/L1762(5000)/L1057(8000)；tools.ts L194(15000)；embed-fn.ts L146(30000)；graph-adapter.ts L966(30000) | 6 处 LLM fetch 无统一策略 |
| **P2-10** | `tagRegistry.load()` fire-and-forget 静默吞错 | [retrieval-gateway.ts L65](file:///workspace/src/retrieval-gateway.ts#L65) `.catch(() => {})` | 首次启动加载失败，整个会话周期上下文推断用空 tag |

---

## 三、性能优化改造方案

### 改造原则
1. **稳定性优先**：不改变现有对外接口，渐进式重构
2. **热路径先行**：assemble/afterTurn/heartbeat 是性能敏感路径
3. **可验证**：每项改造配套测试，336 项基线不回归

### 3.1 第一批：热路径与稳定性（P0 + 关键 P1）

#### 3.1.1 统一检索管线（P0-1）

**目标**：`assemble` 主路径复用 `RetrievalGateway`，消除双管线。

**改造**：
- `RetrievalGateway` 新增 `searchForAssemble(query, limits, context)` 方法，接收 tier-aware limits
- `assemble`（index.ts L694-791）改为调用 `retrievalGateway.searchForAssemble`
- 统一 `minScore` 为 0.5（从 gateway），消除 0.6 不一致
- 保留 `timedSearch` 超时保护 + `tagRegistry` 上下文推断

**接入点**：[retrieval-gateway.ts](file:///workspace/src/retrieval-gateway.ts)、[index.ts](file:///workspace/src/index.ts#L694-L791)

**风险**：中等 — 需保证 assemble 的 circuitBreaker/degraded 标记逻辑不丢失

---

#### 3.1.2 对齐优先级裁剪体系（P0-2）

**目标**：`applyTotalControl` 与 `priority-trim` 使用统一优先级。

**改造**：
- 定义 `SECTION_PRIORITY` 常量映射（layer → 优先级）
- `applyTotalControl` 改为按 layer 升序裁剪（L1 先裁 → L2 → L3 → L4 经验最后）
- `priority-trim` 复用同一常量
- `removedSections` 记录真实裁剪顺序

**接入点**：[token-control.ts](file:///workspace/src/plugin/token-control.ts)、[index.ts](file:///workspace/src/index.ts#L1298-L1316)

**风险**：低 — 仅调整裁剪顺序，不改变接口

---

#### 3.1.3 compact 超时保护（P0-3）

**目标**：lossless-claw adapter compact 增加超时兜底。

**改造**：
- `compact()` 内部用 `Promise.race([engine.compact(params), timeoutPromise])` 包裹
- 超时默认 300s（与 schema compactTimeout 一致），可 env 覆盖
- 超时后返回 `{ ok: false, reason: 'timeout' }` 而非 throw

**接入点**：[lossless-claw-adapter.ts](file:///workspace/src/middleware/lossless-claw-adapter.ts#L486)

**风险**：低 — 仅增加超时兜底

---

#### 3.1.4 修复 experience tags 类型不匹配（P0-4）

**目标**：tags 存储与查询类型一致。

**改造**：
- 存储改为 Neo4j 原生数组属性（`e.tags_scenario: ['bug-fix', 'feature-dev']`）
- 查询 `ANY(s IN e.tags_scenario WHERE s IN $scenarioTags)` 保持不变
- 数据迁移：启动时检测逗号字符串并 split 转数组（一次性）

**接入点**：[storage.ts](file:///workspace/src/experience/storage.ts#L229-L234) 写入、[L142-L145](file:///workspace/src/experience/storage.ts#L142-L145) 查询

**风险**：中等 — 需数据迁移逻辑

---

#### 3.1.5 修复死配置与常量不一致（P1-1, P1-2）

**目标**：`fuzzyMatchThreshold` 和 `decayHalfLifeDays` 配置生效。

**改造**：
- `entity-extractor.ts` L186 硬编码 0.75 → 读取 `config.fuzzyMatchThreshold`
- `index.ts` L202 `decayHalfLifeDays = 30` → `DEFAULTS.ttl.halfLifeDays`（45）

**接入点**：[entity-extractor.ts](file:///workspace/src/entity-extractor.ts#L186)、[index.ts](file:///workspace/src/index.ts#L202)

**风险**：低

---

#### 3.1.6 afterTurn 热路径去除同步 I/O（P1-3）

**目标**：消除 afterTurn 中 `readFileSync` 读 openclaw.json。

**改造**：
- 启动时一次性读取并缓存到闭包变量 `_cachedLlmConfig`
- 提供 `refreshLlmConfig()` 方法供 `lcmg_config_set` 调用后刷新
- afterTurn 直接读内存缓存

**接入点**：[index.ts](file:///workspace/src/index.ts#L1626-L1629)

**风险**：低

---

#### 3.1.7 MCP 工具复用 QmdClient 单例（P1-4）

**目标**：4 个工具复用闭包内 `qmdClient` 单例。

**改造**：
- `tools.ts` 注册时注入 `qmdClient` 引用（与 `dashboardContext` 同模式）
- 移除 4 处 `new QmdClient()`

**接入点**：[tools.ts](file:///workspace/src/tools.ts#L1200)、L1712、L1753、L1786

**风险**：低

---

#### 3.1.8 Tier2 LLM 注入 keep_alive（P1-7）

**目标**：统一所有 LLM 调用的 keep_alive 注入。

**改造**：
- [index.ts L1031-1034](file:///workspace/src/index.ts#L1031-L1034) body 增加 `withKeepAliveIfOllama`

**接入点**：[index.ts](file:///workspace/src/index.ts#L1031-L1034)

**风险**：低

---

### 3.2 第二批：I/O 与批量优化（P1 剩余 + P2）

#### 3.2.1 lcmg_backup 流式化（P1-5）

**目标**：消除全表扫描 + 同步文件读写。

**改造**：
- Neo4j 改为分批 stream（`MATCH (n) RETURN n LIMIT 1000 SKIP $offset`）
- 文件读写改为 `fs/promises` 异步
- 大备份自动分片（>100MB 分多个文件）

**接入点**：[tools.ts](file:///workspace/src/tools.ts#L635-L741)

---

#### 3.2.2 lcmg_sync 批量化（P1-6）

**目标**：消除嵌套 SQLite N 次往返。

**改造**：
- Phase 1 一次性 `SELECT conversation_id FROM conversations` 加载到 Set
- Neo4j 侧 `MATCH (n:ConversationMessage) RETURN n.conversation_id` 一次性取全部
- 内存 Set 差集计算孤儿

**接入点**：[tools.ts](file:///workspace/src/tools.ts#L1475-L1532)

---

#### 3.2.3 graph-adapter upsertEntities 批量化（P1-10）

**目标**：消除 per-entity N+1。

**改造**：
- `upsertEntities()` 改为调用 `batchUpsert()`
- 标记旧 `upsertEntities` 为 `@deprecated`

**接入点**：[graph-adapter.ts](file:///workspace/src/adapters/graph-adapter.ts#L706-L783)

---

#### 3.2.4 debt-manager 异步化 sessionFile 扫描（P2-7）

**目标**：消除 setInterval 回调中的同步 I/O。

**改造**：
- `fs.readdirSync` → `fs.promises.readdir`
- `JSON.parse(readFileSync(...))` → `JSON.parse(await fs.promises.readFile(...))`

**接入点**：[debt-manager.ts](file:///workspace/src/core/debt-manager.ts#L360-L379)

---

#### 3.2.5 distillation 并发化（P2-2, P2-3）

**目标**：串行 LLM 调用改为有限并发。

**改造**：
- `runDistillation` 用 `Promise.all` + 限制并发 3（`p-limit` 模式或手写信号量）
- G-8 验证回路同样并发 3

**接入点**：[distillation.ts](file:///workspace/src/plugin/distillation.ts#L136-L200)、[index.ts](file:///workspace/src/index.ts#L1731-L1786)

---

#### 3.2.6 searchWithCache 去废弃标记或迁移（P1-9）

**目标**：明确 searchWithCache 的定位。

**改造**：
- 评估 community enrichment 的实际收益（A/B 测试召回质量）
- 若收益显著：去掉 `@deprecated` 标记，补充文档
- 若收益有限：assemble L3 改用 `search()`，消除额外 session 开销

**接入点**：[graph-adapter.ts](file:///workspace/src/adapters/graph-adapter.ts#L396-L449)

---

### 3.3 第三批：一致性与健壮性（P2 剩余）

#### 3.3.1 统一 LLM 超时策略（P2-9）

**目标**：建立 LLM 调用超时分级。

**改造**：
- 定义 `LLM_TIMEOUT` 常量：`rerank: 1500ms / validate: 5000ms / distill: 15000ms / summarize: 15000ms / triplet: 8000ms / tier2: 8000ms`
- 所有 LLM fetch 统一引用常量

**接入点**：8 处 fetch 调用

---

#### 3.3.2 linkRelated 加 LIMIT 中间结果（P2-5）

**目标**：防止大图中间结果集爆炸。

**改造**：
- `MATCH (other:EXPERIENCE) WHERE other.status='DISTILLED' WITH other LIMIT 500 ...`

**接入点**：[storage.ts](file:///workspace/src/experience/storage.ts#L369-L444)

---

#### 3.3.3 lastAssembleExpIdsBySession 加 TTL（P2-1）

**目标**：过期 session 元数据自动清理。

**改造**：
- Map value 改为 `{ ids: string[], ts: number }`
- get 时检查 `Date.now() - ts > 1h` 则 miss
- heartbeat 周期 `evictStale`

**接入点**：[index.ts](file:///workspace/src/index.ts#L79)

---

#### 3.3.4 错误路径 token 估算增量优化（P2-8）

**目标**：catch 分支复用增量扣减逻辑。

**改造**：
- 提取 `trimByIncrementalEstimate(buffer, budgetCeiling)` 工具函数
- 成功路径与错误路径共用

**接入点**：[index.ts](file:///workspace/src/index.ts#L1481-L1495)

---

#### 3.3.5 tagRegistry.load 失败重试（P2-10）

**目标**：首次加载失败不静默放弃。

**改造**：
- `.catch(() => {})` → `.catch(() => setTimeout(retry, 5000))` 最多重试 3 次
- 重试期间用 DEFAULT_TAGS 降级

**接入点**：[retrieval-gateway.ts](file:///workspace/src/retrieval-gateway.ts#L65)

---

#### 3.3.6 lcm 熔断器接入或移除（P1-8）

**目标**：消除死配置。

**改造**：
- 评估：lcm 子系统是否有需要熔断的调用点（lcm-bridge SQLite 查询）
- 若有：lcm-bridge 查询包裹 `withCircuitBreaker("lcm", ...)`
- 若无：移除 lcm 熔断器定义，减少认知负担

**接入点**：[circuit-breaker.ts](file:///workspace/src/circuit-breaker.ts#L10)、[lcm-bridge.ts](file:///workspace/src/lcm-bridge.ts)

---

## 四、实施顺序与依赖

```
第一批（热路径与稳定性，P0 + 关键 P1）
  ├─ 3.1.1 统一检索管线（P0-1）        ← 待执行（最高优先，消除双管线）
  ├─ 3.1.2 对齐优先级裁剪（P0-2）      ← 待执行
  ├─ 3.1.3 compact 超时保护（P0-3）    ← 待执行
  ├─ 3.1.4 修复 tags 类型（P0-4）      ← 待执行（需数据迁移）
  ├─ 3.1.5 修复死配置（P1-1, P1-2）    ← ✅ 已完成
  ├─ 3.1.6 afterTurn 去同步 I/O（P1-3）← ✅ 已完成
  ├─ 3.1.7 工具复用 QmdClient（P1-4）  ← 待执行
  ├─ 3.1.8 Tier2 keep_alive（P1-7）    ← ✅ 已完成
  └─ P0-5 embed keep_alive             ← ✅ 已完成（新增项）

第二批（I/O 与批量优化，P1 剩余 + P2）
  ├─ 3.2.1 lcmg_backup 流式化（P1-5）
  ├─ 3.2.2 lcmg_sync 批量化（P1-6）
  ├─ 3.2.3 upsertEntities 批量化（P1-10）
  ├─ 3.2.4 debt-manager 异步化（P2-7）
  ├─ 3.2.5 distillation 并发化（P2-2, P2-3）
  └─ 3.2.6 searchWithCache 定位（P1-9）

第三批（一致性与健壮性，P2 剩余）
  ├─ 3.3.1 统一 LLM 超时（P2-9）
  ├─ 3.3.2 linkRelated LIMIT（P2-5）
  ├─ 3.3.3 expIds TTL（P2-1）
  ├─ 3.3.4 token 估算增量（P2-8）
  ├─ 3.3.5 tagRegistry 重试（P2-10）
  └─ 3.3.6 lcm 熔断器（P1-8）
```

**依赖关系**：
- 3.1.1（统一检索管线）是后续检索相关优化的基础
- 3.1.4（tags 类型修复）需在 3.2.5（distillation 并发）之前完成（蒸馏写入 tags）
- 其余项相互独立，可并行推进

---

## 五、预期收益

| 改造批次 | 预期收益 | 验证方式 |
|----------|----------|----------|
| **第一批** | assemble 主路径延迟降低 10-20%（消除双管线开销 + 超时保护统一）| 端到端 assemble 延迟基准测试 |
| | afterTurn 热路径无同步 I/O | afterTurn 延迟 p99 基准 |
| | 配置实际生效（fuzzyMatch/decay/tags）| 单元测试验证配置读取 |
| **第二批** | lcmg_backup 大规模数据 5-10x 加速 | 5000 节点备份耗时对比 |
| | lcmg_sync 消除 N 次往返 | sync 耗时对比 |
| | distillation 吞吐 2-3x 提升 | batch=5 蒸馏耗时对比 |
| **第三批** | 长时间运行内存稳定（TTL 清理）| 7 天运行内存基线 |
| | LLM 超时统一可调 | 配置覆盖测试 |

---

## 六、风险与对策

| 风险 | 对策 |
|------|------|
| 3.1.1 统一检索管线可能丢失 assemble 特有的 degraded 标记逻辑 | 改造前提取 assemble 现有的 circuitBreaker/degraded 逻辑，在新方法中保留 |
| 3.1.4 tags 数据迁移可能影响在线数据 | 迁移前做 dry-run 检测，迁移脚本幂等可重试 |
| 3.2.5 distillation 并发可能触发 Ollama 限流 | 并发数可配置（默认 3），超时降级串行 |
| 3.3.6 移除 lcm 熔断器可能影响 dashboard reset_breaker | 保留 resetCircuitBreaker 接口兼容性，仅内部不注册 |

---

## 七、附录：审计基线

- **代码版本**：v2.1.10（commit 8f8b114，main 分支）+ 第一批修复（未提交）
- **测试基线**：619 项通过（30 个文件）
- **tsc 类型检查**：通过
- **审计文件数**：32 个 src/ 文件 + 4 个配置文件
- **发现总数**：5 个 P0 + 10 个 P1 + 10 个 P2 = 25 项
- **第一批已修复**：P0-5、P1-1、P1-2、P1-3、P1-7（5 项）
- **待修复**：4 个 P0 + 6 个 P1 + 10 个 P2 = 20 项（全部经 2026-07-10 三路并行复审确认仍存在）
- **重新评估日期**：2026-07-10（基于 main 8f8b114 + 第一批修复，逐项核查确认）
