# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.13] - 2026-09-04

### Fixed

- **FIX-CR11: 压缩前复查主轮门控** — `processSingleDebt` 在调用压缩前复查 `isMainTurnActive()`，主轮活跃时抛错走既有 catch → `markDebtFailed` 保留债务供下次 poll 重试，避免 Ollama LLM 压缩与主生成串行排队导致 host "stopped making progress" 中断
- **FIX-CR01-b / FIX-CR03: 补齐异步缓存淘汰** — heartbeat 周期清理新增 `evictStaleSadWeights` / `evictStaleOverheadPublic` / `evictStaleCompressedResults`，此前仅 lazy evict
- **FIX-CR10: 关键 catch 补日志** — register/bootstrap/heartbeat 等处的静默 `catch {}` 补上 debug/warn 日志，便于内存泄漏与淘汰失效定位
- **蒸馏让路主轮** — heartbeat 触发的 `runDistillation` 传入 `deferToMainTurn: true`
- **会话重置缓存清理** — index.ts 导出 `clearLastAssembleExpIdsBySession` / 预热缓存清理函数，供 session-reset.ts 动态 import 调用
- connection-pool / after-turn / tools 等若干稳定性修复

## [Unreleased] - 2026-08-11


### Changed

- **Recaller 复用以消除关联矩阵 M 分叉**：`graph-adapter` 不再各自 `new Recaller`，而是优先复用 gm-pro 模块级单例(A)（`getRecaller()`），仅当 A 未就绪/未导出时回退自建(B) 并打降级日志。
  - 新增 `_initRecaller()`：优先复用 A（含 5×300ms 轮询提升命中率）→ 自建 B 兜底 → 统一注入/复用 embedding。
  - 重构 `_configureRecallerOnline()`：JudgeManager / AssociationMatrix 已由 gm-pro 注入则直接复用，缺失时才按 lcm 配置补齐，避免双实例导致 M 矩阵在线学习数据不共享。
  - 新增 `online-learning readiness` 配置对齐日志（sharedRecaller / judgeReady / matrixReady / embedReady / matrixEnabled）。
  - 依赖 gm-pro 侧新增 `getRecaller()` 导出（gm-pro 仓库单独提交，未包含于本仓库）。

### Changed

- **配置复用，消除重复维护一套 Judge/AssociationMatrix/Embedding 默认值**：`graph-adapter` 不再以 lcm 自己的默认值二次覆盖 gm-pro 的生效配置，改为优先使用 gm-pro 在 openclaw.json 中配置的参数值。
  - 依赖 gm-pro 侧新增 `getEffectiveConfig()` 导出（返回模块级生效 `GmConfig`，即 `plugins.entries["graph-memory-pro"].config` 填充默认值后的值）。
  - `_configureRecallerOnline()`：JudgeManager / AssociationMatrix 的取值来源改为 `getEffectiveConfig()`（gm-pro 生效配置）优先，缺失字段才回退 lcm 配置；已由 gm-pro 注入的实例直接复用，不重复构建。
  - embedding：仅当 lcm 显式配置了 `model/apiKey/baseURL` 时才覆盖，否则复用 gm-pro 已注入的 embed，避免重复维护 embedding 配置。
  - 新增 `configSource: 'graph-memory-pro' | 'lcm'` 对齐日志，便于诊断实际生效的配置来源。

## [2.1.12] - 2026-07-23

### Added

- **S-12**: `stubLargeToolPayloads` — 大工具负载外部分片 + 存根替换，完全兼容 lossless-claw 的 `lcm_describe`/`lcm_expand` 按需回溯
  - assemble 阶段遍历消息 → 检测大工具负载 → 外部化到 `~/.openclaw/lcm-files/<convId>/<fileId>.txt`
  - 写入 lossless-claw 的 `large_files` 表，使 `lcm_describe(id="file_xxx", expandFile=true)` 可直接检索
  - 存根格式与 lossless-claw 的 `formatToolOutputReference` 完全一致（含 Exploration Summary）
  - 块元数据对齐：`externalizedFileId` / `originalByteSize` / `toolOutputExternalized` / `externalizationReason`
  - 确定性探索摘要：结构化数据（JSON 解析）/ 代码检测 / 文本头部
  - Fresh tail 保护：最近 N 条消息不存根（默认 8）
  - 配置项：`stubLargeToolPayloads.enabled` / `thresholdBytes` / `filesDir` / `freshTailCount`
  - 简写：`stubLargeToolPayloads: true` / `largeFileThreshold` / `largeFilesDir`

### Changed

- **lcm-bridge.ts**: 新增 `insertLargeFile()` 方法，向 lossless-claw 的 `large_files` 表写入记录
- **assemble/index.ts**: `stubLargeToolPayloads` 调用处传入 `conversationId`，确保 `large_files` 表外键关联正确

## [2.1.11] - 2026-07-10

### Fixed

- **P0-1**: 统一检索管线 minScore 到 `DEFAULTS.retrieval.expMinScore`（0.5），消除 assemble(0.6) 与 RetrievalGateway(0.5) 不一致
- **P0-2**: 对齐 `applyTotalControl` 与 `priority-trim` 优先级体系，经验优先级 2→4（最高保护），与 layer 语义一致
- **P0-3**: `compact()` 超时保护（Promise.race + 300s，`LCMG_COMPACT_TIMEOUT_MS` 可覆盖），超时返回 `ok:false` 而非无限挂起
- **P0-4**: experience tags 类型修复，查询改用 `split(coalesce(...), ',')`，与写入 `.join(',')` 一致，无需数据迁移
- **P0-5**: embed keep_alive 修复，`isOllamaEndpoint` 判断 + 剥离 `/v1` 走原生 `/api/embed`，keep_alive=1h 生效
- **P1-1**: `fuzzyMatchThreshold` 死配置修复，entity-extractor 读取配置现生效（0.85）
- **P1-2**: `decayHalfLifeDays` 统一为 `DEFAULTS.ttl.halfLifeDays`（45）
- **P1-3**: `afterTurn` 热路径去除 `readFileSync`，改为进程级缓存
- **P1-4**: MCP 工具复用 QmdClient 单例（`acquireQmdClient()` + owned 标记），5 处调用统一
- **P1-7**: Tier2 LLM 注入 keep_alive（`withKeepAliveIfOllama`）
- **P2-1**: `lastAssembleExpIdsBySession` 增加 30min TTL（写入时间戳 + 读取时过期清理），长生命周期进程不再常驻 200 条 session 元数据
- **P2-6**: health-metrics 与 lcm-bridge 对齐 WAL PRAGMA（`journal_mode=WAL` / `synchronous=NORMAL` / `cache_size` / `temp_store=MEMORY`），消除双驱动共存行为依赖
- **P2-10**: `tagRegistry.load()` 失败带退避重试（10s/30s/60s 共 3 次），替代原 `.catch(() => {})` 静默吞错，避免整个会话周期用空 tag

### Performance

- **P1-5**: `lcmg_backup` 异步 I/O（`fsp.*` 替代同步 fs）+ Neo4j 全表扫描加 `LIMIT 50000/100000` 防 OOM
- **P1-6**: `lcmg_sync` 批量化，逐行 `COUNT(*)` → 批量 `IN(...)`；逐行 `SELECT` → `GROUP BY`；逐条 MERGE → `UNWIND` 批量 MERGE
- **P1-9**: `searchWithCache` 去 `@deprecated` 误标（L3 正式入口，唯一调用点 index.ts:763）
- **P1-10**: 删除 `upsertEntities` 死代码（零调用方，生产走 `batchUpsert`）
- **P2-2/3**: `runDistillation` 并发化，串行 for-await → 分批并发（默认 3，`LCMG_DISTILL_CONCURRENCY` 可覆盖）
- **P2-7**: `debt-manager` 异步化，`readdirSync`/`readFileSync` → `fs.promises`
- **P2-4**: `lcmg_search` 去除冗余 `toLower(n.name) CONTAINS toLower($k)`（与 `n.name CONTAINS $k` 重复扫描），减少一次全属性 CONTAINS
- **P2-5**: `linkRelated`/`findRelatedByConcepts` 加 `LIMIT $candidateLimit` 中间结果裁剪（`max(maxLinks*5, 15)`），防止大图中间结果集爆炸
- **P2-8**: 错误路径 token 估算改增量（splice 前算被删消息 token 数，splice 后从总数扣减），消除 catch 分支 O(N²) 全量重算

### Changed

- 版本号统一升级至 2.1.11（package.json / openclaw.plugin.json / dashboard / src/index.ts / package-lock.json）
- **P2-9**: LLM 超时集中化到 `DEFAULTS.llm`（`rerankTimeoutMs=3000` / `judgeTimeoutMs=10000` / `validateTimeoutMs=8000` / `summarizeTimeoutMs=20000` / `embedTimeoutMs=30000` / `graphLlmTimeoutMs=30000`），原 6 处散落硬编码（1.5s~30s 跨 20 倍）统一引用
- **P1-8**: `lcm` 熔断器文档化为死注册（生产无 `withCircuitBreaker("lcm", ...)` 调用点），保留类型定义以兼容 DB schema（`cb_lcm_ok/cb_lcm_fails`）与 dashboard `reset_breaker` 工具

### Fixed (2026-07-22 — lossless-claw 适配器 API 审计)

通过对照 lossless-claw 源码 (`Martian-Engineering/lossless-claw`) 逐一审计，修复 5 个问题：

- **适配器 `getSummaries()` 幽灵方法调用**: 原调用 `convStore.listSummaries()`（ConversationStore 不存在此方法，永远返回 `[]`），改用 `getSummaryStore().getContextItems(conversationId)` + `getSummary()`。此 bug 导致 compact 生成的 summary 永远无法被 assemble 获取，LLM 始终收到未压缩的完整上下文。
- **适配器 `compact()` 同样幽灵方法**: `compact()` 内获取 summary 也使用了不存在的 `convStore.listSummaries()`，改用相同正确 API。
- **`ensureBootstrapped()` 字段名错误**: `existing.bootstrapped_at`（snake_case）→ `existing.bootstrappedAt`（camelCase），源码 `toConversationRecord` 返回驼峰对象。此前 `bootstrapped_at` 永远为 `undefined`，导致每次都要重新 bootstrap。
- **`MemorySupplementCtxEngine` 缺失方法代理**: 补全 `getConversationStore` / `getSummaryStore` / `assemble` / `maintain` / `info` 代理方法，shared-init 路径下这些方法不可用。
- **`AssembleContext` 类型修复**: `losslessClawAdapter` 从 `any` 改为 `LosslessClawAdapter`，修复 TypeScript 无法推断 `getSummaries` 返回类型的问题。

影响文件：
- `src/middleware/lossless-claw-adapter.ts` — adapter API 修复
- `src/assemble/types.ts` — 类型系统修复

## [2.1.10] - 2026-07-05

### Added

- **graph-memory-pro v2.1.10 API 对接**（5 个新能力）
  - `judgeRecall` (R-2): 级联 Tier 1 置信度评估，优先调用 gm-pro，失败降级到本地 `evaluateTier1`
  - `upsertFeedback` (G-8): afterTurn 验证回路反馈，优先调用 gm-pro，失败降级到 `store.updateQualityScore`
  - `getNodesByTimeRange` (S-8'): 时间范围节点查询，优先调用 gm-pro，失败降级到 Cypher
  - `evolveNode` (G-10): 主动遗忘时节点状态演进，优先调用 gm-pro，失败降级到 Cypher SET superseded
  - `getGraphHealth` (G-5): 图谱健康快照，优先调用 gm-pro，失败降级到本地 GraphAdapter 状态推断
- **gm-pro fallback wrapper** (`src/adapters/gm-pro-fallback.ts`): 统一 graceful degradation 入口，所有新 API 调用通过此 wrapper 实现"优先 gm-pro → 失败降级"模式
- **Prometheus /metrics 端点** (`src/dashboard-snapshot.ts`): 输出 text/plain v0.0.4 格式指标，覆盖压力信号、熔断器、检索性能、经验层、Tier 分布、Graph adapter 状态
- **R-2 cascade Tier 1 置信度上报** (`src/health-metrics.ts`): 新增 `recordCascadeConfidence` 方法，通过 :7423 snapshot + Prometheus 暴露 `lcm_cascade_tier1_confidence{source}` 指标
- **Dashboard 图谱健康卡片** (`packages/dashboard/src/views/MonitorView.vue`): 显示 status/source/nodeCount/relationshipCount/graphAdapterConnected
- **Dashboard Cascade 置信度展示**: MonitorView Cascade 面板新增 Tier1 置信度 + judge source tag（gm-pro/local）
- **Dashboard 系统诊断卡片** (`packages/dashboard/src/views/MaintainView.vue`): 通过 `/api/mcp/invoke` 触发 `lcmg_diagnose` 工具
- **Dashboard 后端图谱健康路由** (`packages/dashboard/server/routes/graph-health.ts`): `GET /api/graph/health`，5s 超时，失败降级
- **Dashboard 前端 fetcher** (`packages/dashboard/src/api/health.ts`): `fetchGraphHealth()` + `GraphHealthResponse` 类型定义
- **Dashboard MCP 封装** (`packages/dashboard/src/api/maintain.ts`): `invokeDiagnose()` 封装

### Changed

- **N-1 Sync 算法升级**: Phase 1.5 新增 updatedAt 时间戳 drift 检测，对比 lcm.db messages.created_at 与 Neo4j ConversationMessage.updatedAt，差异 > 60s 视为 drift，repair 模式下增量 MERGE 更新到 Neo4j
- **G-10 lcmg_forget hard 模式**: 优先调用 gm-pro evolveNode API，失败降级到 Cypher SET superseded
- **S-8' lcmg_experience_report**: 支持 from/to 时间范围过滤（ISO 8601 / 相对时间如 '7d'/'24h' / 中文如 '今天'/'本周'），优先调用 gm-pro getNodesByTimeRange
- **lcmg_maintain**: 触发 gm-pro 维护管线（dedup / PageRank / 社区检测）+ 债务表对账
- **HealthSnapshotLite 类型**: 新增 `cascadeTier1Confidence` / `cascadeJudgeSource` 字段
- **HealthSnapshot 类型**: 前端同步新增 R-2 字段

### Fixed

- **TypeScript 'health' is of type 'unknown'**: 新增 `HealthSnapshotLite` 接口，修复 `buildPrometheusMetrics` 中访问 health 字段的类型错误
- **'await' expressions are only allowed within async functions**: `/internal/graph-health` 路由改用 `.then/.catch` 链处理

## [Unreleased]

### Dashboard 安全审计与质量加固 (2026-07-07)

对 `packages/dashboard` 进行 6 维度完整审计（安全/可访问性/暗色模式/代码质量/build/性能），按 P0 → P1 → P2 优先级分三批修复，共 3 个提交（`72adde0` / `2da25d7` / `636572e`）。

**P0 — 暗色模式与安全硬伤（4 项）**

- **ECharts 暗色模式** (`src/components/EChart.vue` + `src/styles/theme.ts`): 新增 `echartsDarkThemeColors` + `echartsDarkBaseOption`，暗色模式下坐标轴/splitLine/legend/tooltip 切换为浅色字面值（ECharts 不支持 CSS var()）
- **DataTable 浅合并穿透** (`src/styles/theme.ts`): `darkThemeOverrides` 显式覆盖 `DataTable.thColor`/`thTextColor`，避免亮色表头字面值穿透到暗色模式
- **build 警告** (`vite.config.ts`): `manualChunks` 拆分 echarts/vue/naive-ui/vendor + `chunkSizeWarningLimit=800`
- **路径安全 + MCP 白名单** (`server/routes/mcp.ts` + `server/lib/path-security.ts`): 前端 `validateOpenclawPath` + 后端 `validatePathUnderOpenclaw` 双重校验；`ALLOWED_MCP_TOOLS` Set 限制 `POST /api/mcp/invoke` 仅转发 11 个已知工具

**P1 — 安全加固 + 可访问性 + 代码质量（13 项）**

- **安全加固（5 项）**:
  - `@fastify/rate-limit` 速率限制（全局 100 req/30s，生产 200/30s）
  - 错误响应脱敏（catch 块统一返回"请查看服务端日志"，不泄漏堆栈）
  - 安全响应头（`X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer`，用 `onSend` hook 替代 `@fastify/helmet` 避免新增依赖）
  - 生产模式未配置 `DASHBOARD_AUTH` 时打印显著警告
  - rate-limit 信任 `X-Forwarded-For` 仅在显式 proxy 场景下
- **可访问性 WCAG AA（6 项）**:
  - 表格键盘导航（↑↓ 切换行 + Enter 打开详情）
  - 抽屉 focus trap（`NDrawer` `trap-focus` + `auto-focus` + `close-on-esc`）
  - 每页 `h1` 语义标题
  - `layer-cell` 状态指示双重编码（形状 + 符号 + 颜色，不依赖颜色单一信号，WCAG 1.4.1）
  - `--color-text-tertiary` 从 `#86909c`（3.28:1）提色到 `#6b7280`（~4.6:1，满足 WCAG AA 4.5:1）
  - `KpiCard` count-up 动画尊重 `prefers-reduced-motion`
- **代码质量（2 项）**:
  - `format.ts` 去重：消除各组件重复的 `fmtTime`/`fmtDuration`/`formatTs`，统一为 `formatTime`/`formatTimeWithSeconds`/`formatDateTime`/`formatDuration`
  - `MaintainView` `pendingLogIds` 重入竞态修复：`onMutate` 异步调度竞态，改为 `mutate` 调用前同步置位 `loadingMap` 硬守卫

**P2 — 死代码清理 + 路径暴露 + token 收敛**

- 删除未使用 API：`maintain.ts` 删除 `fetchOperationLogs*` + `OperationLog` 类型；`config.ts` 删除 `fetchRuntimeConfig`/`fetchConfigSchema`/`patchConfig`/`fetchProfileRecommendation` + 6 个未使用类型；`client.ts` 删除 `apiPatch`；`format.ts` 删除 5 个未使用导出
- font-size token 化：7 处硬编码 `12px`/`13px`/`11px`/`10px` 替换为 `var(--fs-caption)`/`var(--fs-label)`
- 重复样式清理：4 个文件的 scoped `.muted`/`.mono`/`.cell-wrap` 精简，统一依赖 `tokens.css` 全局定义
- token 清理：删除 25 个闲置 CSS token（颜色 10 + 字号 1 + 间距 3 + 圆角 1 + 阴影 3 + 动效 2 + z-index 5）及暗色覆盖块对应 3 个覆盖
- 安全：`/api/config` 不再返回 `configPath` 绝对路径（泄漏用户名/部署结构），仅保留 `configExists` 布尔

**验证**：tsc --noEmit 通过；vite build 通过（13.4s）；63 个测试全部通过。

### PM × PD 双视角审计与 v1.1 演进路线

- **审计报告** (`docs/pm-pd-audit-2026-07-06.md`): 并行启动项目经理（PM）与产品经理（PD）两路独立审计，覆盖代码质量/技术债务/CI-CD/文档/风险/资源进度（PM）与产品定位/功能完整度/UX/降级链路/竞品/演进建议（PD）双视角
- **综合评分**: PM 4.0/5.0 · PD 4.2/5.0 · 综合 B+（准 A）
- **v1.0.0 验收**: ROADMAP 13 项全部落地，16 工具 + 7 钩子 + 4 Dashboard 视图齐备，6 项独家/领先能力（PressureTier / debt-manager / experience distillation / 四层检索 / R-2 级联 / 可观测 Dashboard）
- **v1.1 演进路线** (12 项，分三批):
  - 第一批 - 还债与门禁 (P0): 拆分 `src/index.ts` (146KB) / CI lint 关闭 continue-on-error / dashboard 版本号统一 / 文档测试统计对齐
  - 第二批 - 体验下沉: 降级输出有效性校验 + `degraded` 标记 / UX 指标面板 / Dashboard 降级状态可视化 / onboarding 冒烟脚本
  - 第三批 - 稳定性收尾: 空 catch 块补日志 / qmd-client status() CLI fallback / timer .unref() + SIGTERM handler / 资源释放断言测试

### Resource Leak & Lifecycle Audit (2026-07-05)

**P0 - 严重资源泄漏修复（8 项）**

- **Neo4j Session 泄漏** (`graph-adapter.ts`): `searchWithCache` / `searchExperience` 中 `session.close()` 从 try 块移至 finally，避免异常路径 session 不释放导致连接池耗尽
- **dispose 完整性** (`index.ts`): 新增 `_losslessClawAdapter.dispose()` 调用（触发底层 engine.dispose）；新增 `qmdClient.dispose()` 调用（清理 recoveryTimer）；`graphAdapter.close()` 改为 await（确保 TCP 连接优雅关闭）
- **SQLite 连接泄漏** (`tools.ts`): 新增 `closeSharedDb()` 导出函数，dispose 时关闭模块级单例 `_sharedDb`
- **MCP Session 并发竞态** (`qmd-client.ts`): 新增 `_initPromise` inflight promise 去重，避免并发请求各自调用 `_doInitialize()` 导致服务端 session 泄漏
- **Promise.race timer 泄漏** (`cascade-manager.ts`): `evaluateTier2` 中 `setTimeout` 句柄提取并在 race 后 `clearTimeout`，预吞 rejection 防 unhandledRejection

**P1 - 稳定性与竞态修复（5 项）**

- **连接池兜底清理** (`index.ts`): dispose 中新增 `await drainPool()` 调用，防止 refCount 失衡导致连接池条目泄漏
- **dispose 幂等性** (`index.ts`): 开头增加 `if (!initialized && !snapshotServerStop && !hbTimer) return;` 短路，避免重复执行动态 import 和清理逻辑
- **dispose 单例置 null** (`index.ts`): 末尾统一置 null `_retrievalGateway` / `tracker` / `_modelRegistry` / `snapshotHandle` / `snapshotConfig`，避免热重载后旧实例残留
- **connect() 重复 acquire 守卫** (`graph-adapter.ts`): 开头增加 `if (this.driver && this.mod) return true;`，防止 refCount 失衡
- **MCP 恢复后清空 sessionId** (`qmd-client.ts`): `scheduleRecovery` 恢复回调中 `this.mcpSessionId = null`，使首请求主动重新初始化

**审计报告**: 完整审计报告见 `docs/resource-leak-audit-2026-07-05.md`

### Message Order & Stability Fixes (2026-07-06)

**P0 - 消息顺序问题修复**

- **Medium tier 消息顺序修复** (`index.ts`): medium pressure 场景下 `finalMessages = summaryMsgs` 只保留了摘要，**完全丢弃了所有原始消息**（包括用户最新消息）。修复为 `[...summaryMsgs, ...messages]`，摘要在前 + 全部原始消息在后，保证最新消息在末尾
- **High tier 消息保留修复** (`index.ts`): high pressure 场景下只保留最后 1 条消息，对话上下文丢失严重。修复为保留最近 4 条原始消息（最近 2 轮对话），确保对话连贯性
- **Fallback 路径消息保留修复** (`index.ts`): async-compaction fallback 路径同样只保留最后 1 条消息，修复为保留最近 4 条

**P1 - 错误与稳定性修复**

- **better-sqlite3 构造函数兼容** (`usage-tracker.ts`): ESM dynamic import 下 `BetterSqlite3.default is not a constructor` 错误。修复为 `BetterSqlite3 = mod.default ?? mod`，兼容 CJS 与 ESM 两种导出形态
- **high-pressure compact timeout timer 泄漏** (`index.ts`): Promise.race 中 compact timeout 的 setTimeout 句柄未清理，导致 timer 泄漏 + unhandledRejection 风险。修复为提取 timer 句柄 + race 后 clearTimeout + 预吞 rejection

**P2 - 降级与告警**

- **gm-pro PPR failed** (`graph-adapter.ts`): gm-pro 的 personalizedPageRank 调用失败属于预期降级路径（gm-pro 未安装/内部 session 管理问题），已有 fallback 到 Cypher PageRank，再降级到 degree-based 排序。日志级别为 warn，属正常降级行为
- **L4 experience search failed** (`index.ts`): experience 层搜索失败有完整 try/catch 降级（返回空数组不阻塞主流程），通常由 Neo4j 连接波动或 expStore 未初始化导致
- **MCP query failed → CLI fallback** (`qmd-client.ts`): MCP 不可用时自动降级到 qmd CLI 查询，属预期降级机制

### Testing

- **新增 7 测试用例**:
  - `dashboard-snapshot.test.ts`: 5 个（Prometheus /metrics + /internal/graph-health 端点覆盖）
  - `health-metrics.test.ts`: 3 个（recordCascadeConfidence 单元测试）
- **全量测试**: 458 通过（主包）+ 63 通过（dashboard），无回归

### 生产就绪（P0/P1/P2 全量补齐）

**P0 - 紧急且重要（7 项）**

- 版本号统一：主包与 dashboard 均为 v2.1.10
- CHANGELOG：完整版本变更记录
- E2E-REPORT 4 问题修复：EChart chunk 拆分、质量分历史、perfSummary 空串、graphAdapter 类型安全
- CI/CD：GitHub Actions 三 job 流水线（test / dashboard-test / build）
- Docker：多阶段构建 + docker-compose 一键部署
- 主插件 E2E 测试：工具/钩子/搜索/持久化/健康检查 全覆盖
- afterTurn/heartbeat 专测：24 项单元测试

**P1 - 重要不紧急（6 项）**

- Quick Start + FAQ：快速上手指南 + 常见问题解答
- 告警通道扩展：Prometheus /metrics 端点（v0.0.4 格式）
- G-8 完整时序：验证时间线 + upsertFeedback 闭环
- 报告导出：Markdown / PDF / JSON / 摘要 多格式
- 多用户 Auth：Dashboard Basic Auth（`DASHBOARD_AUTH` 环境变量）
- gm-pro 升级文档：完整升级指南 + 降级方案

**P2 - 紧急不紧急（4 项）**

- 操作日志持久化：独立 SQLite 数据库，LRU 1000 条
- S-8' 路径对齐：getNodesByTimeRange + from/to 过滤
- evolveNode 元数据：G-10 主动遗忘 + gm-pro evolveNode API
- PDF 导出：pandoc + 纯 JS fallback 双模式自动降级

## [2.1.9] - 2026-06-xx

### Added

- **ROADMAP 第一批 8 项全部落地**:
  - S-6' 场景隔离扩展
  - S-7' 用户画像轻量版
  - S-9' 情节缓冲扩展
  - S-11' Zettelkasten 增强
  - R-5' 动态混合简化
  - N-1 Sync 算法升级
  - N-2 Merger LLM 重排启用
  - N-3 TTL-经验层集成
- **ROADMAP 第二批 4 项全部落地**:
  - R-2 成本感知级联 Tier 2/3
  - G-8 LLM 异步验证回路
  - S-8' 时间范围回顾总结
  - N-4 健康指标导出
- **ROADMAP 第三批 G-10 落地**:
  - G-10 主动遗忘命令（lcmg_forget）
- **Dashboard 四大模块**: MonitorView / ExperienceView / MemoryView / MaintainView（4 view + 13 组件）
- **16 个 MCP 工具**: lcmg_search / backup / restore / import / pin / forget / sync / qmd_status / get_document / batch_get / maintain / diagnose / experience_report / distill / compact / reset_breaker
- **三层架构**: 插件 snapshot 服务（:7423）→ dashboard 后端（:7421）→ 前端 SPA（:7422）

### Security

- **SEC-5 M-11/M-12**: backup/restore 路径校验，防止路径穿越到 `~/.openclaw` 之外
- **SEC-L**: FTS5 MATCH 查询字符串转义，防止语法错误和意外匹配

[2.1.11]: https://github.com/wljmmx/lcm-graph-extra/releases/tag/v2.1.11
[2.1.10]: https://github.com/wljmmx/lcm-graph-extra/releases/tag/v2.1.10
[2.1.9]: https://github.com/wljmmx/lcm-graph-extra/releases/tag/v2.1.9
