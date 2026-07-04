# @openclaw/lcm-dashboard

LCM Dashboard — lcm-graph-extra 的轻量级监控前台。

## 概述

独立 Node 进程，提供对 lcm-graph-extra（含 graph-memory-pro / lossless-claw）的性能监控、经验管理、记忆查询、维护操作可视化界面。

### 架构（三层解耦）

```
┌─────────────────────────────────────────────────────────────┐
│ packages/dashboard (独立进程, :7421)                         │
│  Vue 3 SPA ←→ Fastify API 层                                │
│    读路径: 直读 lcm.db + Neo4j + 插件 /internal/snapshot    │
│    写路径: 调用 OpenClaw MCP 工具                           │
└─────────────────────────────────────────────────────────────┘
```

## 快速开始

### 开发模式

```bash
cd packages/dashboard
npm install        # 首次需安装依赖
npm run dev        # concurrently 启动后端(7421) + 前端(7422)
```

访问 http://127.0.0.1:7422

### 生产模式

```bash
npm run build      # 构建前端到 dist-client/
npm start          # 启动后端，serve 静态资源
```

访问 http://127.0.0.1:7421

## 四大功能模块

| 模块 | 路由 | 能力 |
|------|------|------|
| 性能监控 | `/` | KPI 卡片 + 压力/延迟/tier 时序图 + 熔断状态 + Cascade Beta 分布 + 用户画像 + 债务调度 + Agent 状态 |
| 经验管理 | `/experience` | 经验列表（过滤/分页）+ 详情抽屉 + G-8 验证时间线 + RELATED_TO 关联图谱 + 遗忘/固定操作 |
| 记忆查询 | `/memory` | 跨引擎联合搜索（lcm+qmd+neo4j 并行）+ 图谱浏览（ECharts force layout）+ 节点详情 |
| 维护操作 | `/maintain` | 9 项维护卡片 + 操作日志（最近 20 条）|

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DASHBOARD_PORT` | 7421 | 后端端口 |
| `DASHBOARD_HOST` | 127.0.0.1 | 绑定地址 |
| `DASHBOARD_AUTH` | 无 | `user:pass` 启用 Basic Auth |
| `PLUGIN_SNAPSHOT_URL` | http://127.0.0.1:7423 | 插件快照端点 |
| `OPENCLAW_MCP_URL` | http://127.0.0.1:18789 | OpenClaw MCP host |
| `LCM_DB_PATH` | ~/.openclaw/lcm.db | lcm.db 路径 |
| `NEO4J_URI` | bolt://localhost:7687 | Neo4j 连接 |
| `NEO4J_USER` | neo4j | Neo4j 用户 |
| `NEO4J_PASSWORD` | neo4j | Neo4j 密码 |
| `QMD_URL` | http://127.0.0.1:8081 | QMD 服务地址 |

## 端口规划

| 端口 | 服务 | 绑定 |
|------|------|------|
| 7421 | dashboard 后端（Fastify）| 127.0.0.1 |
| 7422 | 前端 dev（Vite，/api 代理到 7421）| 127.0.0.1 |
| 7423 | 插件 /internal/snapshot（内存态快照）| 127.0.0.1 |

## 降级行为

| 故障 | 降级 |
|------|------|
| 插件 /internal/snapshot 不可用 | 监控页 memory 面板显示"插件未响应"，DB 历史数据正常 |
| OpenClaw MCP host 不可用 | 维护操作报错"host 不可达"，读路径不受影响 |
| Neo4j 不可用 | 经验列表/图谱报错，监控页显示熔断状态 |
| lcm.db 不存在 | 健康历史显示空，KPI 仅显示 memory 快照 |

## 技术栈

- **后端**: Fastify 5 + node:sqlite + neo4j-driver
- **前端**: Vue 3 + Vite + Naive UI + ECharts + TanStack Query
- **测试**: Vitest + @vue/test-utils + happy-dom

## 测试

```bash
npm test           # 56 项测试
npm run typecheck  # 类型检查
```

详见 [E2E-REPORT.md](./E2E-REPORT.md)。

## 许可证

MIT
