# lcm-graph-extra 性能优化演进路线图

> 版本：v2.1.10 → v2.2.0
> 基线：commit 8f8b114（main）+ 第一/二/三批修复，630 项测试通过，tsc 通过
> 审计报告：[2026-07-04-performance-audit-and-optimization.md](docs/superpowers/specs/2026-07-04-performance-audit-and-optimization.md)
> 发现总数：5 个 P0 + 10 个 P1 + 10 个 P2 = 25 项｜已修复 17 项｜待修复 8 项

---

## 一、改造原则

1. **稳定性优先**：不改变现有对外接口，渐进式重构，每项配套测试
2. **热路径先行**：assemble/afterTurn/heartbeat 是性能敏感路径
3. **可验证**：630 项基线不回归，tsc 类型检查通过
4. **低风险先行**：先修独立低风险项，最后处理高风险的管线统一

---

## 二、分批实施计划

### 第一批：热路径修复（P0-5 + P1 快速修复，低风险独立项）

| 序号 | 编号 | 任务 | 风险 | 接入点 | 状态 |
|------|------|------|------|--------|------|
| 1 | P0-5 | embed keep_alive 修复：embed-fn.ts 使用 isOllamaEndpoint + 默认 baseURL 去 /v1 | 低 | embed-fn.ts, neo4j-helper.ts | ✅ 已完成 |
| 2 | P1-7 | Tier2 LLM 注入 keep_alive | 低 | index.ts L1050 | ✅ 已完成 |
| 3 | P1-1 | fuzzyMatchThreshold 死配置：entity-extractor 读取配置 | 低 | entity-extractor.ts L33 | ✅ 已完成 |
| 4 | P1-2 | decayHalfLifeDays 统一为 DEFAULTS.ttl.halfLifeDays | 低 | index.ts L220 | ✅ 已完成 |
| 5 | P1-3 | afterTurn 去除 readFileSync，改为进程级缓存 | 低 | index.ts L82/L1649 | ✅ 已完成 |
| 6 | P1-4 | MCP 工具复用 QmdClient 单例 | 低 | tools.ts L1200/1712/1753/1786 | ✅ 已完成 |

### 第二批：核心稳定性（P0 架构修复，中等风险）

| 序号 | 编号 | 任务 | 风险 | 接入点 | 状态 |
|------|------|------|------|--------|------|
| 7 | P0-2 | 对齐 applyTotalControl 与 priority-trim 优先级体系 | 低 | token-control.ts, index.ts | ✅ 已完成 |
| 8 | P0-3 | compact 超时保护（Promise.race + 300s） | 低 | lossless-claw-adapter.ts L486 | ✅ 已完成 |
| 9 | P0-4 | experience tags 类型修复（split(coalesce)，无需迁移） | 中 | storage.ts | ✅ 已完成 |
| 10 | P0-1 | 统一检索管线 minScore + 文档化双管线关系 | 中 | index.ts, retrieval-gateway.ts | ✅ 已完成 |

### 第三批：I/O 与批量优化（P1 剩余 + P2）

| 序号 | 编号 | 任务 | 风险 | 接入点 | 状态 |
|------|------|------|------|--------|------|
| 11 | P1-5 | lcmg_backup 流式化（异步 I/O + LIMIT） | 低 | tools.ts L681-L754 | ✅ 已完成 |
| 12 | P1-6 | lcmg_sync 批量化（批量 IN + UNWIND MERGE） | 低 | tools.ts L1537-L1677 | ✅ 已完成 |
| 13 | P1-10 | upsertEntities 删除死代码（零调用方） | 低 | graph-adapter.ts L706 | ✅ 已完成 |
| 14 | P2-7 | debt-manager 异步化 sessionFile 扫描 | 低 | debt-manager.ts L360 | ✅ 已完成 |
| 15 | P2-2/3 | distillation 并发化（并发 3） | 低 | distillation.ts L136 | ✅ 已完成 |
| 16 | P1-9 | searchWithCache 去 @deprecated 标记 | 低 | graph-adapter.ts L395 | ✅ 已完成 |

### 第四批：一致性与健壮性（P2 剩余 + P1-8）

| 序号 | 编号 | 任务 | 风险 | 接入点 | 状态 |
|------|------|------|------|--------|------|
| 17 | P2-9 | 统一 LLM 超时策略 | 低 | 8 处 fetch | ⏳ 待执行 |
| 18 | P2-5 | linkRelated 加 LIMIT 中间结果 | 低 | storage.ts | ⏳ 待执行 |
| 19 | P2-1 | lastAssembleExpIdsBySession 加 TTL | 低 | index.ts L79 | ⏳ 待执行 |
| 20 | P2-8 | 错误路径 token 估算增量优化 | 低 | index.ts L1481 | ⏳ 待执行 |
| 21 | P2-10 | tagRegistry.load 失败重试 | 低 | retrieval-gateway.ts L65 | ⏳ 待执行 |
| 22 | P1-8 | lcm 熔断器接入或移除 | 低 | circuit-breaker.ts | ⏳ 待执行 |

---

## 三、执行顺序与依赖

```
第一批（热路径修复，6 项，低风险独立）
  1→2→3→4→5→6  （相互独立，可并行，但按序逐一验证）

第二批（核心稳定性，4 项，中等风险）
  7→8          （独立）
  9            （独立，需数据迁移）
  10           （依赖第一批完成，统一管线最后做）

第三批（I/O 与批量优化，6 项）
  11→12→13→14→15→16 （相互独立）

第四批（一致性与健壮性，6 项）
  17→18→19→20→21→22 （相互独立）
```

---

## 四、预期收益

| 批次 | 收益 | 验证 |
|------|------|------|
| 第一批 | embed 模型驻留内存（keep_alive 生效）；配置实际生效；afterTurn 无同步 I/O | 单元测试 + 配置读取测试 |
| 第二批 | 裁剪顺序符合设计意图；compact 不再无限挂起；tags 过滤生效；检索统一管线 | 集成测试 + 端到端 assemble 测试 |
| 第三批 | backup 5-10x 加速；sync 消除 N 次往返；distillation 2-3x 吞吐 | 性能对比基准 |
| 第四批 | 长时间运行内存稳定；LLM 超时统一可调 | 7 天运行内存基线 |
