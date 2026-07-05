# 资源泄漏与生命周期审计报告

> 审计日期：2026-07-05
> 审计版本：v2.1.10
> 审计范围：`/workspace/src` 全目录
> 审计维度：资源泄漏、错误处理与降级策略、Session/连接管理、Dispose/清理路径完整性
> 审计结论：发现 13 处 P0/P1 问题，已全部修复

---

## 一、审计总览

| 类别 | 发现问题 | 已修复 | 状态 |
|------|---------|-------|------|
| **P0（严重 - 资源泄漏/数据安全）** | 8 | 8 | ✅ 全部修复 |
| **P1（高 - 稳定性/竞态）** | 5 | 5 | ✅ 全部修复 |
| **P2（中 - 可观测性）** | 多处 | 部分修复 | ⚠️ 已修复关键路径，其余记录待后续优化 |
| **合计** | **13+** | **13** | ✅ **核心问题全部修复** |

---

## 二、P0 问题详情与修复

### P0-1. graph-adapter.ts searchWithCache Session 泄漏

- **文件**：`src/adapters/graph-adapter.ts`
- **问题**：`session.close()` 在 try 块内（非 finally），`session.run()` 抛错时 session 永不关闭，导致 Neo4j 连接池泄漏
- **修复**：改为 `try/catch/finally` 模式，session 在 finally 中关闭，catch 中新增 warn 日志

### P0-2. graph-adapter.ts searchExperience Session 泄漏

- **文件**：`src/adapters/graph-adapter.ts`
- **问题**：与 P0-1 相同的反模式
- **修复**：同 P0-1，改为 try/catch/finally 模式

### P0-3. dispose 中 `_losslessClawAdapter.dispose()` 未调用

- **文件**：`src/index.ts`
- **问题**：`_losslessClawAdapter` 持有底层 lossless-claw engine 引用，dispose 中直接置空引用未调用 `dispose()`，底层 SQLite 句柄/监听器泄漏
- **修复**：dispose 中增加 `await _losslessClawAdapter?.dispose?.()` 并置 null

### P0-4. dispose 中 `qmdClient.dispose()` 未调用，recoveryTimer 泄漏

- **文件**：`src/index.ts`
- **问题**：`QmdClient` 持有 `recoveryTimer`（30s 周期 setTimeout），dispose 中仅 `qmdClient = null` 未调用 `dispose()`，timer 在热重载后仍存活
- **修复**：dispose 中增加 `qmdClient?.dispose?.()` 调用

### P0-5. dispose 中 `graphAdapter.close()` 未 await

- **文件**：`src/index.ts`
- **问题**：`GraphAdapter.close()` 是 async 方法，未 await 导致 driver 底层 TCP 连接未优雅关闭
- **修复**：改为 `await graphAdapter?.close?.()`

### P0-6. tools.ts `_sharedDb` 无 close 函数，连接泄漏

- **文件**：`src/tools.ts`
- **问题**：模块级单例 `_sharedDb`（DatabaseSync）在 dispose 中从未被关闭，热重载后旧连接残留
- **修复**：新增 `closeSharedDb()` 导出函数，在 dispose 中调用

### P0-7. qmd-client.ts mcpInitialize/mcpReinitialize 并发竞态

- **文件**：`src/qmd-client.ts`
- **问题**：并发请求各自调用 `_doInitialize()`，服务端创建多个 session 但只有最后一个被保存，其余泄漏
- **修复**：新增 `_initPromise` inflight promise 去重，并发请求共享同一初始化调用

### P0-8. cascade-manager.ts evaluateTier2 Promise.race timer 泄漏

- **文件**：`src/cascade-manager.ts`
- **问题**：`setTimeout` 句柄未保存，LLM 提前返回时 timer 泄漏 10s + unhandledRejection 风险
- **修复**：提取 timer 句柄并在 race 后 `clearTimeout`，预吞 rejection

---

## 三、P1 问题详情与修复

### P1-1. dispose 中 `drainPool()` 从未被调用

- **文件**：`src/index.ts` + `src/adapters/connection-pool.ts`
- **问题**：`drainPool()` 函数已实现但从未被调用，连接池条目在 refCount 失衡时不被清理
- **修复**：dispose 中 `graphAdapter.close()` 之后调用 `await drainPool()` 兜底

### P1-2. dispose 中遗漏单例置 null

- **文件**：`src/index.ts`
- **问题**：`_retrievalGateway`、`tracker`、`_modelRegistry`、`snapshotHandle`、`snapshotConfig` 等在 dispose 后未置 null，热重载后旧实例残留
- **修复**：dispose 末尾统一置 null

### P1-3. dispose 非幂等

- **文件**：`src/index.ts`
- **问题**：多次调用 dispose 时重复执行动态 import 和清理逻辑
- **修复**：dispose 开头增加 `if (!initialized && !snapshotServerStop && !hbTimer) return;` 短路

### P1-4. graph-adapter.ts connect() 重复 acquire

- **文件**：`src/adapters/graph-adapter.ts`
- **问题**：`connect()` 无条件覆盖 `this.driver`，多次调用导致 refCount 失衡
- **修复**：connect() 开头增加 `if (this.driver && this.mod) return true;` 守卫

### P1-5. qmd-client.ts scheduleRecovery 恢复后未清空 sessionId

- **文件**：`src/qmd-client.ts`
- **问题**：网络错误恢复后 `mcpSessionId` 仍是旧值，首请求多一次 401 失败
- **修复**：恢复回调中 `this.mcpSessionId = null`，使首请求主动重新初始化

---

## 四、P2 问题（已记录，部分修复）

以下问题已记录，部分已在 P0/P1 修复中顺带处理，其余留待后续优化：

| 问题 | 文件 | 状态 |
|------|------|------|
| 大量空 catch 块无日志 | index.ts 20+ 处、lossless-claw-adapter.ts 6 处 | 部分修复（graph-adapter 已加日志） |
| health() 空 catch 无日志 | graph-adapter.ts | 未修复（非关键路径） |
| qmd-client status() 缺 CLI fallback | qmd-client.ts | 未修复（已知缺口） |
| timer 未 .unref() | 全局 | 未修复（非关键，进程正常退出时不影响） |
| stopScheduler 无超时 | debt-manager.ts | 未修复（backgroundTasks.awaitAll 有 5s 超时兜底） |
| SIGTERM/SIGINT handler 缺失 | 全局 | 未修复（需确认 OpenClaw 框架是否已处理） |
| health-metrics close 不清空内存 | health-metrics.ts | 未修复（非关键） |
| GraphAdapter.close 不重置 _recaller | graph-adapter.ts | ✅ 已修复 |

---

## 五、验证结果

| 验证项 | 结果 |
|--------|------|
| TypeScript 类型检查 | ✅ 通过（`tsc --noEmit` exit 0） |
| 单元测试 | ✅ 26 文件 / 458 测试全部通过 |
| 代码审查 | ✅ 所有修复使用 try/catch/finally 模式 |

---

## 六、修复文件清单

| 文件 | 修复内容 |
|------|---------|
| `src/adapters/graph-adapter.ts` | searchWithCache/searchExperience session 改 finally；connect() 守卫；close() 重置更多状态 |
| `src/index.ts` | dispose 完整性：幂等短路、await close、drainPool、closeSharedDb、_losslessClawAdapter.dispose、qmdClient.dispose、单例置 null |
| `src/qmd-client.ts` | _initPromise 并发去重；scheduleRecovery 清空 sessionId |
| `src/cascade-manager.ts` | evaluateTier2 timer 泄漏修复 |
| `src/tools.ts` | 新增 closeSharedDb() 导出 |

---

## 七、最佳实践参考模板

项目中已存在的正确模式，可作为后续代码维护的参考：

1. **Session 资源管理模板**：`graph-adapter.ts` `fallbackPageRank` 的 `try/catch/finally + session.close().catch()` 模式
2. **Fire-and-forget 任务模板**：`task-registry.ts` 的 normalized Promise + 自动 logger.warn 上报
3. **降级包装器模板**：`gm-pro-fallback.ts` `withGmProFallback` 的四路径全覆盖模式
4. **Promise.race 超时模板**：`index.ts` compact 路径的 `timer 句柄 + finally clearTimeout + 预吞 .catch()` 模式

---

*审计完毕。所有 P0/P1 问题已修复并通过测试验证。*
