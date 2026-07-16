# LCM Graph Extra 故障排查指南

> 版本：v2.1.11+ | 2026-07-16

## 快速诊断

运行内置诊断工具获取系统状态：

```
/lcmg_diagnose
```

Dashboard 路径：`http://127.0.0.1:7421` → 监控面板 → 系统诊断卡片

---

## 一、常见问题与解决方案

### 1.1 检索返回空结果

**症状**：Agent 回复中缺少上下文知识，`lcmg_search` 返回空。

**排查步骤**：

1. 检查 Dashboard 熔断面板 → 确认 Neo4j/QMD 子系统状态
2. 查看日志中 `[retrieval]` 相关错误
3. 运行 `lcmg_qmd_status` 检查 QMD 服务

**解决方案**：
- Neo4j 断开 → 熔断器自动恢复（30s 冷却），或 `lcmg_reset_breaker neo4j`
- QMD 不可用 → 检查 QMD MCP 服务是否运行，MCP 不可用时会自动降级到 CLI 模式
- 压力等级过高 → 降低 `lcmMonitor.proactiveThreshold` 或检查消息数

### 1.2 复杂度数据全为 0

**症状**：Dashboard 复杂度趋势图表数据全为 0。

**解决方案**：此问题已在 v2.1.11 修复。确保已更新到最新版本。根因是 `recordAllComplexity` 在 MoA 失败时被跳过。

### 1.3 Compact 失败或挂起

**症状**：日志出现 `compact timeout` 或 `compact input overflow`。

**排查步骤**：

1. 查看 Dashboard 压力面板 → 检查 `maxTokenRatio` 是否超过 0.85
2. 检查日志中 `[assemble] compact input overflow` 警告

**解决方案**：
- 输入超限（`effectiveTokenCount > contextWindow * 0.90`）→ 系统已自动降级，使用已有摘要 + 最近消息。这是预期行为，不需要手动干预。
- 超时 → 增大 `LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS` 环境变量（默认 300s）
- 持续失败 → 运行 `lcmg_compact` 手动触发，或启动新会话

### 1.4 MoA 不触发

**症状**：设置了 MoA 配置但未见多模型协作输出。

**排查步骤**：

1. 检查 Dashboard 设置页 → 确认 `moa.enabled = true`
2. 检查 `moa.complexityThreshold` 是否过高（默认 0.6）
3. 检查 `moa.enabledTiers` 是否包含当前压力等级
4. 检查日志中 `[assemble] MoA complexity check` 的 score 值

**解决方案**：
- 降低 `complexityThreshold`（如 0.4）
- 使用 `/moa force` 命令强制触发
- 确保 `referenceModels` 至少配置 2 个模型
- 检查 LLM 服务是否可达（Ollama: `http://127.0.0.1:18789/v1/models`）

### 1.5 Dashboard 显示"插件未响应"

**症状**：Dashboard 监控面板 memory 区域显示"插件未响应"。

**排查步骤**：

1. 检查插件是否运行 → `curl http://127.0.0.1:7423/ping`
2. 检查端口占用 → `lsof -i :7423`

**解决方案**：
- 确认 `dashboardSnapshot.enabled = true` 且 `port = 7423`
- 确认插件已正确加载到 OpenClaw
- 三层架构解耦：即使插件未响应，Dashboard 仍可通过 DB 直读展示历史数据

### 1.6 经验不生成

**症状**：对话后经验列表无新增。

**排查步骤**：

1. 检查 `experience.enabled = true`
2. 检查是否命中触发源（correction/failure/fix_success/explicit_save）
3. 检查日志中 `[experience]` 相关输出

**解决方案**：
- 确认 `experience.triggers` 包含所需触发源
- 手动触发：`lcmg_distill` 将 PENDING 经验转为 DISTILLED
- 检查 Neo4j 中 EXPERIENCE 节点：`MATCH (e:EXPERIENCE) RETURN count(e)`

### 1.7 熔断器频繁触发

**症状**：Dashboard 熔断面板显示红色，Agent 功能降级。

**排查步骤**：

1. 查看日志中 `[circuit-breaker]` 相关错误
2. 检查对应子系统状态（Neo4j/QMD）

**解决方案**：
- 手动重置：`lcmg_reset_breaker qmd` 或 `lcmg_reset_breaker neo4j`
- 调整熔断阈值：目前不可配置（硬编码 3 次失败/30s 冷却），需修改 `DEFAULTS.circuitBreaker`
- 检查 Neo4j 连接：`bolt://localhost:7687`
- 熔断器采用"半开"探测模式，恢复后自动关闭

### 1.8 类型检查报错

**症状**：`tsc --noEmit` 输出 30+ 错误。

**说明**：这些是已知的 `@types/node` 缺失和 `neo4j-driver` 类型声明问题，不影响构建产物（tsup 正常打包）。IDE 中可忽略，或安装 `@types/node` 解决。

---

## 二、日志分析

### 2.1 关键日志模式

| 日志模式 | 含义 | 操作 |
|---------|------|------|
| `[assemble] compact input overflow` | 输入超过压缩窗口 | 预期降级，无需干预 |
| `[circuit-breaker] OPEN` | 子系统熔断 | 检查对应服务 |
| `[retrieval] slow query` | 检索耗时 > 1s | 检查 Neo4j 索引 |
| `[moa] Reference models phase failed` | MoA 参考模型全部失败 | 检查 LLM 服务 |
| `[assemble] Auto-classified preset` | 自动分类已匹配预设 | 信息日志 |
| `Merger dedup failed` | 结果去重失败 | 已降级为原始结果 |

### 2.2 日志级别

| 环境 | 建议级别 | 配置 |
|------|---------|------|
| 生产 | `warn` | `"logging": {"level": "warn"}` |
| 开发 | `debug` | `"logging": {"level": "debug"}` |
| 调试 | `trace` | `"logging": {"level": "trace"}` |

---

## 三、性能问题

### 3.1 检索延迟高

**症状**：`lastAssembleMs` > 5000ms。

**排查**：
- 检查 Dashboard 检索延迟时序图 → 定位慢的层（L2/L3/L4）
- Neo4j 检索慢 → 检查索引：`CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n.name)`
- QMD 检索慢 → 检查 QMD 服务的向量索引

### 3.2 内存持续增长

**症状**：进程内存持续增长，最终 OOM。

**排查**：
- 检查 `sessionDedupCache` 大小（默认 500 session，4h TTL）
- 检查 `healthMetrics` 环形缓冲区（默认 144 条，5min heartbeat）

**解决方案**：
- 重启插件释放内存
- 当前版本已内置 TTL 清理，长运行场景下内存增长应趋于平稳

---

## 四、数据一致性

### 4.1 三端数据不同步

**症状**：`lcmg_search` 查询结果与 Neo4j 直接查询不一致。

**解决方案**：
```
/lcmg_sync  → 检测并报告不一致
/lcmg_sync repair  → 自动修复
```

### 4.2 图谱节点异常

**症状**：大量孤立节点或过期节点。

**解决方案**：
```
/lcmg_maintain  → 运行 dedup + PageRank + 社区检测 + 债务对账
```
TTL 清理每 24h 自动执行一次。

---

## 五、Dashboard 问题

### 5.1 前端白屏

**解决方案**：
1. 检查 `packages/dashboard/dist-client/` 是否存在构建产物
2. 运行 `cd packages/dashboard && npm run build`
3. 检查浏览器控制台错误

### 5.2 API 返回 401

**解决方案**：
- 检查 `DASHBOARD_AUTH` 环境变量配置
- 格式：`export DASHBOARD_AUTH="admin:password"`
- `/api/ping` 端点不受 Basic Auth 保护

### 5.3 图表无数据

**解决方案**：
1. 确认时间范围选择器选择了有效范围
2. 确认 health-history 数据存在（至少等待 5min 心跳周期）
3. 检查 Dashboard 后端日志：`GET /api/health/history`

---

## 六、获取帮助

1. 运行 `lcmg_diagnose` 获取完整诊断报告
2. 查看 Dashboard 系统诊断卡片
3. 检查日志文件（如配置了 `logging.file`）
4. 提交 Issue：https://github.com/wljmmx/lcm-graph-extra/issues