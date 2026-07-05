# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **全量测试**: 424 通过（主包）+ 56 通过（dashboard），无回归

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

[2.1.10]: https://github.com/wljmmx/lcm-graph-extra/releases/tag/v2.1.10
[2.1.9]: https://github.com/wljmmx/lcm-graph-extra/releases/tag/v2.1.9
