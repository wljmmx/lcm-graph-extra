# 常见问题（FAQ）

## 安装与启动

### Q1: 端口被占（EADDRINUSE）

**现象**：插件启动报 `EADDRINUSE :7423`，或 dashboard 报 `EADDRINUSE :7421`。

**原因**：上一个实例残留（常见于 `kill -9` 未走 dispose）。

**解决**：
```bash
# 查找占用端口的进程
lsof -i :7423
# 优雅关闭
kill <PID>
```

或修改端口：

```bash
# dashboard 后端（环境变量）
export DASHBOARD_PORT=7425

# 插件 snapshot server（openclaw.json 配置，非环境变量）
# 编辑 ~/.openclaw/openclaw.json：
# { "plugins": { "lcm-graph-extra": { "config": { "dashboardSnapshot": { "port": 7424 } } } } }
```

### Q2: Neo4j 连接失败

**现象**：日志报 `init: Neo4j unavailable, L3/L4 will be skipped`。

**排查**：
1. 确认 Neo4j 服务运行：`curl http://127.0.0.1:7474`
2. 确认 Bolt 端口可达：`telnet 127.0.0.1 7687`
3. 确认 `~/.openclaw/openclaw.json` 中 neo4j.uri / user / password 正确
4. 检查密码是否含特殊字符（需 JSON 转义）

### Q3: graph-memory-pro 未安装

**现象**：日志报 `gm-pro not available, fallback to local`。

**说明**：graph-memory-pro 是 optional peerDep，未安装时所有 v2.1.10 新 API（judgeRecall / upsertFeedback / getNodesByTimeRange / evolveNode / getGraphHealth）会自动降级到本地实现，不影响核心功能。

**安装**：
```bash
npm install @openclaw/graph-memory-pro
```

### Q4: QMD MCP 服务不可达

**现象**：日志报 `qmd MCP unavailable, fallback to CLI`。

**排查**：
1. 确认 QMD 服务运行：`curl http://127.0.0.1:8081/mcp`
2. 配置 `retrieval.qmd.mcpEndpoint`（默认 `http://127.0.0.1:8081/mcp`）
3. QMD 不可用时降级到 CLI 模式（需安装 qmd CLI）

### Q5: lossless-claw 适配器连接失败

**现象**：日志报 `init: lossless-claw adapter connection failed, compact will be backup-only`。

**说明**：lossless-claw 是 requiresPlugins，必须先加载。compact 会降级为 backup-only 模式。

**解决**：确认 `openclaw.plugin.json` 的 `requiresPlugins: ["lossless-claw"]` 已满足。

## 性能与调优

### Q6: assemble 响应慢

**排查步骤**：
1. 查看 dashboard MonitorView 的 `lastAssembleMs`
2. 查看 Prometheus `/metrics` 的 `lcm_retrieval_last_assemble_ms`
3. 检查各引擎耗时：`lcm_retrieval_engine_ms{engine="l2_qmd"}` / `{engine="l3_graph"}` / `{engine="l4_experience"}`

**优化**：
- 降低 `retrieval.limits.qmd / graph / exp`
- 启用 `retrieval.qmd.rerank`（精确但慢）或关闭（快但召回差）
- 调整 `lcmMonitor.retrievalLimits` 按 tier 缩减

### Q7: 高压力触发频繁 compact

**现象**：日志频繁报 `tier=high, triggering blocking emergency compact`。

**解决**：
- 调高 `lcmMonitor.highPressureThreshold`（默认 0.85）
- 调高 `lcmMonitor.dedupRounds`（默认 24）
- 增大 `maxContextChars.high`（默认 1600）

### Q8: 经验蒸馏不触发

**原因**：heartbeat 间隔 5min，需积累 PENDING 经验才会蒸馏。

**手动触发**：
```bash
# 通过 MCP 工具
lcmg_distill { "limit": 10 }
```

## Dashboard

### Q9: dashboard 显示"插件未响应"

**原因**：插件 :7423 snapshot 服务未启动。

**排查**：
1. `curl http://127.0.0.1:7423/internal/health` 应返回 `{"ok":true}`
2. 若返回连接拒绝，确认插件已加载且 `dashboardSnapshot.enabled` 不为 false
3. 端口冲突时插件会放弃启动（见 Q1）

### Q10: Prometheus /metrics 为空

**原因**：healthMetrics 尚未采集到快照（首次 heartbeat 前）。

**解决**：等待 5min 或手动触发一次 assemble。

## 数据与备份

### Q11: 如何备份所有数据

```bash
# 通过 MCP 工具
lcmg_backup { "path": "~/.openclaw/backup-$(date +%Y%m%d).json" }
```

备份包含：Neo4j 全量 + lcm.db + memory/*.md。

### Q12: 如何恢复

```bash
# dryRun 预览
lcmg_restore { "path": "backup.json", "dryRun": true }

# 实际恢复
lcmg_restore { "path": "backup.json", "confirm": true }
```

## 容器化部署

### Q13: docker compose 启动后 Neo4j 连接失败

**原因**：容器内无法访问宿主机 Neo4j。

**解决**：
- 使用 compose 内置的 neo4j 服务（默认配置已就绪）
- 或修改 `docker-compose.yml` 中 `NEO4J_URI` 指向宿主机：`bolt://host.docker.internal:7687`

### Q14: dashboard 容器健康检查失败

**排查**：
```bash
docker compose logs dashboard
docker exec lcm-dashboard wget -q -O- http://127.0.0.1:7421/api/ping
```

## 更多帮助

- [API.md](../API.md) - 完整 API 参考
- [ROADMAP.md](../ROADMAP.md) - 演进路线图
- [E2E-REPORT.md](../packages/dashboard/E2E-REPORT.md) - dashboard 端到端报告
- [GitHub Issues](https://github.com/wljmmx/lcm-graph-extra/issues) - 提交问题
