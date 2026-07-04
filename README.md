# lcm-graph-extra

**OpenClaw Context Engine 插件** — 四层检索上下文注入引擎 + 轻量级监控前台

## 概述

lcm-graph-extra 协调 lossless-claw、qmd、graph-memory-pro 和经验总结层，作为 OpenClaw ContextEngine 在每次 LLM 调用前自动注入上下文。配套 `packages/dashboard` 提供独立的可视化监控前台。

### 生命周期

```
assemble:  WindowMonitor → L2 qmd + L3 Neo4j + L4 exp → R-2 级联评估 → Merger → Total Control → inject
afterTurn: 经验触发检测 → LLM 三元组提取 → Neo4j upsert → G-8 异步验证回路
compact:   backup → lossless-claw DAG compact → entity extraction
heartbeat: 压力检测 → TTL 清理 → 经验蒸馏 → 健康指标采集（5min）
```

## 仓库结构

```
lcm-graph-extra/
├── src/                          # 主插件包
│   ├── index.ts                  # CE 入口 + Window Monitor + Total Control
│   ├── tools.ts                  # 16 个 lcmg_* 操作工具
│   ├── retrieval-gateway.ts      # 四引擎并行检索编排
│   ├── adapters/graph-adapter.ts # Neo4j 图谱适配 + PageRank + PPR rerank
│   ├── adapters/embed-fn.ts      # Ollama/OpenAI 嵌入函数（keep_alive=1h）
│   ├── merger.ts                 # 实体级去重 + 时间衰减 + LLM 重排
│   ├── cascade-manager.ts        # R-2 成本感知级联 + Thompson 采样
│   ├── health-metrics.ts         # N-4 健康指标采集（环形缓冲 + SQLite 持久化）
│   ├── dashboard-snapshot.ts     # /internal/snapshot 端点（供 dashboard 读取内存态）
│   ├── circuit-breaker.ts        # 三子系统熔断 + 重试
│   ├── experience/               # 经验系统（4 触发源 + TagRegistry + UserProfile）
│   ├── core/                     # DAG / TTL / 债务调度 / 生命周期
│   ├── hooks/                    # 生命周期 Hook（compaction 等）
│   ├── middleware/               # lossless-claw 适配器
│   └── config/                   # Zod Schema 配置
├── packages/dashboard/           # @openclaw/lcm-dashboard — 独立监控前台
│   ├── server/                   # Fastify 后端（读直读 + 写走 MCP）
│   ├── src/                      # Vue 3 + Naive UI + ECharts 前端
│   └── E2E-REPORT.md             # 系统全流程测试报告
├── docs/superpowers/specs/       # 设计文档
├── ROADMAP.md                    # 演进路线图（v1.0.0，13 项已全部落地）
└── API.md                        # API 参考
```

## 安装

```bash
git clone https://github.com/wljmmx/lcm-graph-extra.git
cd lcm-graph-extra && npm install && npm run build
```

## 功能模块

| 模块 | 文件 | 说明 |
|------|------|------|
| CE 入口 | src/index.ts | Window Monitor + Total Control + Heartbeat |
| 检索编排 | src/retrieval-gateway.ts | 四引擎并行（qmd/graph/distilledExp/eventExp）|
| 图谱适配 | src/adapters/graph-adapter.ts | Neo4j + PageRank + PPR rerank + superseded 过滤 |
| 嵌入函数 | src/adapters/embed-fn.ts | Ollama（/api/embed 新版 + /api/embeddings 旧版回退）+ OpenAI 兼容 |
| 实体合并 | src/merger.ts | 实体级去重 + 时间衰减 + LLM 重排 |
| 成本感知级联 | src/cascade-manager.ts | R-2 三层置信度 + Thompson 采样（Beta 分布探索）|
| 健康指标 | src/health-metrics.ts | N-4 压力/熔断/延迟/tier 采集 + SQLite 持久化 |
| Dashboard 快照 | src/dashboard-snapshot.ts | /internal/snapshot 内存态聚合端点 |
| 熔断器 | src/circuit-breaker.ts | lcm/qmd/neo4j 三子系统熔断 + 指数退避 |
| 经验系统 | src/experience/ | 4 触发源 + TagRegistry + UserProfile + G-8 验证回路 |
| 债务调度 | src/core/debt-manager.ts | compact 债务队列 + 调度器 |
| TTL 清理 | src/core/ttl.ts | 过期节点清理 + 权重衰减（24h）|
| 配置 | src/config.ts | Zod Schema 校验 + PressureTier |

## 压力等级

| 等级 | 条件 | qmd | graph | exp | maxChars |
|------|------|-----|-------|-----|---------|
| low | 正常 | 5 | 5 | 3 | 6000 |
| medium | msg>24 或 ratio>0.70 | 3 | 3 | 1 | 3000 |
| high | msg>48 或 ratio>0.85 | 1 | 1 | 0 | 800 |

## Agent 工具（16 个）

| 工具 | 说明 |
|------|------|
| lcmg_search | 跨引擎联合搜索（all/lcm_only/qmd_only/neo4j_only）|
| lcmg_experience_report | 经验报告（S-8' 时间范围 + type 过滤 + summary LLM 摘要）|
| lcmg_get_document / lcmg_batch_get | 单/批量文档查询 |
| lcmg_qmd_status | QMD 服务健康 |
| lcmg_pin / lcmg_forget | 节点固定 / 主动遗忘（G-10 soft/hard 模式）|
| lcmg_distill | 手动触发经验蒸馏 |
| lcmg_compact | 手动触发 compact |
| lcmg_reset_breaker | 重置熔断器（lcm/qmd/neo4j）|
| lcmg_maintain | 图谱维护（dedup/PageRank/community）+ 债务对账 |
| lcmg_backup / lcmg_restore | 全量备份 / 恢复 |
| lcmg_import | 历史数据导入 |
| lcmg_sync | 三端数据同步修复 |
| lcmg_diagnose | 健康诊断（6 章节：DB/qmd/Neo4j/熔断/指标/汇总）|

## Dashboard 监控前台

`packages/dashboard` 提供独立的可视化监控前台，覆盖四大能力域：

| 模块 | 能力 |
|------|------|
| 性能监控 | 健康指标时序、熔断状态、tier 分布、检索延迟、Cascade Beta 分布、用户画像、Agent 状态 |
| 经验管理 | 经验列表/详情、G-8 验证时间线、RELATED_TO 关联图谱、遗忘/固定操作 |
| 记忆查询 | 跨引擎联合搜索（lcm+qmd+neo4j 并行）、图谱浏览（ECharts force layout）|
| 维护操作 | 9 项维护卡片（蒸馏/compact/熔断重置/TTL/备份/恢复/同步/导入）+ 操作日志 |

### 启动 Dashboard

```bash
cd packages/dashboard
npm run dev      # 开发模式：后端 :7421 + 前端 :7422
npm run build && npm start  # 生产模式
```

详见 [packages/dashboard/E2E-REPORT.md](packages/dashboard/E2E-REPORT.md)。

### 端口规划

| 端口 | 服务 | 绑定 |
|------|------|------|
| 7421 | dashboard 后端（Fastify）| 127.0.0.1 |
| 7422 | 前端 dev（Vite，/api 代理到 7421）| 127.0.0.1 |
| 7423 | 插件 /internal/snapshot（内存态快照）| 127.0.0.1 |

## 开发

```bash
npm run build         # 构建主插件
npm run typecheck     # 类型检查
npm test              # 运行测试（329 项）

cd packages/dashboard
npm run typecheck     # dashboard 类型检查
npm test              # dashboard 测试（56 项）
```

## 测试

- 主包：20 文件 / 329 项测试
- Dashboard：7 文件 / 56 项测试
- 合计：27 文件 / 385 项测试全部通过

## 路线图

[ROADMAP.md](ROADMAP.md) 定义了 13 项演进任务（3 批），已全部落地：
- 第一批：N-3/N-2/N-1/S-6'/S-9'/S-11'/S-7'/R-5'
- 第二批：R-2/G-8/S-8'/N-4
- 第三批：G-10

## 许可证

MIT
