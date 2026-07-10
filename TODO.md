# lcm-graph-extra 待办工作列表

## 🚀 v1.0.1 — 安全合规 Hotfix (P0)

### 🔒 安全修复
- [x] :7423 Snapshot服务添加Basic Auth认证
- [x] Docker默认强制启用DASHBOARD_AUTH环境变量
- [x] /internal/shutdown改为POST方法并添加token验证
- [x] 添加IP白名单中间件

### 📊 合规审计
- [x] lcmg_*工具注入appendOperationLog操作审计
- [x] 操作日志增加user/session_id字段
- [x] 敏感参数脱敏（password/apiKey等）

## 🔴 v1.0.2 — 上下文污染 P1 修复 ✅ 已完成

> 审计报告: [audit/context-pollution-audit-report-2026-07-10.md](audit/context-pollution-audit-report-2026-07-10.md)
> 修复方案: [audit/context-pollution-fix-plan-2026-07-10.md](audit/context-pollution-fix-plan-2026-07-10.md)
> 完成日期: 2026-07-10

### 🧹 经验召回
- [x] C-1: matchCount 时间衰减（`lastRecalledAt` + Cypher 排序改造 + `decayMatchCount`）
- [x] C-1: `ExperienceQueryOptions` 增加 `halfLifeDays` 字段
- [x] C-1: `config/defaults.ts` 增加 `expHalfLifeDays` 默认值

### 📋 摘要质量
- [x] C-2: `validateCompactionQuality` 函数（长度比/实体保留率/关键词覆盖）
- [x] C-2: `onCompaction` 中插入质量检查步骤
- [x] C-2: `.compaction-quality.json` 低质量记录文件

### 🎯 场景分类
- [x] C-3: `detectScenarioAndAdjustLimits` 加权关键词匹配
- [x] C-3: 置信度门控（threshold=0.30）+ 平局打破
- [x] C-3: `security-audit` 独立分类
- [x] C-3: `ScenarioAdjustResult` 增加 `confidence` 字段

### 🚀 Agent Harness 优化 (6 项，同步完成)
- [x] H-1: 上下文时效性增强（`computeFreshnessBoost`）
- [x] H-2: 指令级优化（`buildKnowledgeGuidance` 分层引导语）
- [x] H-3: 工具调用精准度提升（`buildAdaptiveToolGuidance` 三级能力适配）
- [x] H-4: 上下文冲突检测（`detectConflicts` 否定/版本模式）
- [x] H-5: 输出质量自动评估（`evaluateOutputQuality`）
- [x] H-6: 上下文预热（`sessionWarmupCache` bootstrap 预加载）

## 🟡 v2.1.12 — 代码质量与架构优化 ✅ 已完成

> 评审日期: 2026-07-10
> 评审评分: 综合 8.4/10
> 完成日期: 2026-07-10
> 演进路线: [ROADMAP.md](ROADMAP.md#三-bisv2112-详细任务8-项按依赖关系分三批)

### 🏗️ 第一批：类型安全 + 韧性修复 (P1)
- [x] R-2: `GraphQueryExecutor` 接口替代 `as any`
- [x] R-7: `recordFailure` 仅对最终失败计数

### 📦 第二批：架构优化 + 内存泄漏修复 (P1-P2)
- [x] R-1: 拆分 `index.ts`（`src/assemble/` + `src/after-turn/`）
- [x] R-4: heartbeat 主动清理过期 session 元数据
- [x] R-5: H-5 输出质量信号反馈到检索策略

### 🧪 第三批：测试 + 性能 (P2-P3)
- [x] R-3: Neo4j 集成测试（检索链路）
- [x] R-6: 性能基准测试套件
- [x] R-8: EXPERIENCE 节点全文索引

## ✅ v1.1.0 — 运维便捷性 + 集成验证 (P1)

### 🛠️ 配置API
- [x] GET /api/config 运行时配置查看
- [x] PATCH /api/config 白名单热更新
- [x] GET /api/config/schema 配置schema文档

### 🧪 集成测试
- [ ] gm-pro真实集成测试（需gm-pro环境可用）

### 🎨 前端UI
- [x] Dashboard能力档次切换UI（Vue组件）
- [x] lcmg_config_get/set MCP工具

### 📋 审计增强
- [x] 操作日志查询API增强（时间范围+操作者过滤）

## 📈 v1.2.0 — 性能优化 + 监控增强 (P2)

### 📡 监控指标
- [ ] Prometheus histogram指标（P95/P99延迟）
- [ ] Grafana Dashboard JSON模板
- [ ] 健康历史保留期可配置（默认30天）
- [ ] 业务指标补充（经验质量分布/TTL命中率）

### 🤖 自动化
- [ ] 能力档次自动推荐（基于硬件资源）
- [x] Rate Limiting（@fastify/rate-limit）✅ v1.0.1 安全加固已落地（全局 100 req/30s）

### 🧪 性能测试
- [ ] 性能基准测试套件（4档对比）

## 🏗️ v2.0.0 — 架构演进 (P3)

### 📐 架构扩展
- [ ] S-12 rawIds多聚合实现
- [ ] 多租户支持（user/session隔离）
- [ ] 插件化引擎架构
- [ ] 分布式部署支持

### ⚡ 性能极限
- [ ] WebAssembly性能关键路径优化
- [ ] 自然语言配置（LLM辅助参数调优）

---

## 📋 当前进度统计

| 版本 | 总任务 | 完成 | 进行中 | 待开始 | 完成率 |
|------|--------|------|--------|--------|--------|
| v1.0.1 | 7 | 7 | 0 | 0 | 100% |
| v1.0.2 | 16 | 16 | 0 | 0 | 100% |
| v1.1.0 | 7 | 6 | 0 | 1 | 86% |
| v1.2.0 | 6 | 1 | 0 | 5 | 17% |
| **v2.1.12** | **8** | **8** | **0** | **0** | **100%** |
| v2.0.0 | 6 | 0 | 0 | 6 | 0% |
| **合计** | **50** | **38** | **0** | **12** | **76%** |

---

## 🔴 优先级标记

- **🔴 P0** — 立即修复（安全漏洞/功能阻塞）
- **🟡 P1** — 高优先级（核心功能/用户体验）
- **🟢 P2** — 中优先级（性能优化/监控增强）
- **🔵 P3** — 低优先级（架构演进/长期规划）

---

## 📝 备注

- 本文件随项目迭代更新
- 完成的任务请标记为 [x]
- 进度统计需同步更新
