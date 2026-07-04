# LCM Dashboard 设计文档

> 日期: 2026-07-04
> 状态: Draft → 待用户审批
> 技术栈: Vue 3 + Vite + Naive UI + ECharts + Fastify
> 部署: monorepo 子包 `packages/dashboard`，独立进程

## 1. 目标与范围

为 lcm-graph-extra（含其下挂的 graph-memory-pro / lossless-claw）提供轻量级前台，覆盖四大能力域：

| 模块 | 能力 |
|------|------|
| 性能监控 | 健康指标时序、熔断状态、tier 分布、检索延迟、OpenClaw agent 状态 |
| 经验管理 | 经验列表/详情、G-8 验证记录、蒸馏状态流转、质量分趋势 |
| 记忆查询 | 跨引擎搜索、图谱节点浏览、EXPERIENCE 关联可视化 |
| 维护操作 | 手动触发蒸馏/compact/熔断重置/TTL 清理/备份恢复/同步修复 |

## 2. 架构

```
┌─────────────────────────────────────────────────────────────────┐
│ packages/dashboard (独立 Node 进程, 默认 :7421)                  │
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────────────────────────┐ │
│  │   Vue 3 SPA     │    │ Fastify API 层                       │ │
│  │  Naive UI       │←──→│  读路径: 直读 lcm.db + Neo4j         │ │
│  │  ECharts        │    │  + 插件 /internal/snapshot           │ │
│  │  TanStack Query │    │  写路径: 调用 MCP 工具                │ │
│  └─────────────────┘    │  + OpenClaw host /api/status         │ │
│                         └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
        ↑ 读              ↑ 写                    ↑ 内存态快照
        │                 │                       │
   ┌────┴────┐      ┌─────┴─────┐          ┌──────┴──────────────┐
   │ lcm.db  │      │ OpenClaw  │          │ lcm-graph-extra 插件 │
   │ Neo4j   │      │ MCP host  │          │ /internal/snapshot  │
   └─────────┘      └───────────┘          └─────────────────────┘
```

### 2.1 三层解耦

1. **数据层**: dashboard 后端直读 lcm.db (SQLite) + Neo4j，零跨进程开销
2. **能力层**: 写操作通过 OpenClaw MCP host 调用 lcmg_* 工具，复用插件安全校验
3. **内存态层**: 插件新增 `/internal/snapshot` 端点，聚合 cascadeManager / userProfile / graphAdapter / debt scheduler 状态

### 2.2 monorepo 结构

```
/workspace
├── package.json              # root: workspaces 配置
├── pnpm-workspace.yaml       # 或 npm workspaces
├── src/                      # lcm-graph-extra 主包（保持不变）
├── packages/
│   └── dashboard/
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── server/           # Fastify 后端
│       │   ├── index.ts      # 入口
│       │   ├── routes/
│       │   │   ├── health.ts
│       │   │   ├── experience.ts
│       │   │   ├── memory.ts
│       │   │   ├── maintain.ts
│       │   │   └── agent.ts      # OpenClaw agent 状态
│       │   ├── lib/
│       │   │   ├── db.ts         # lcm.db 只读连接
│       │   │   ├── neo4j.ts      # Neo4j 只读连接
│       │   │   ├── mcp.ts        # MCP 工具调用客户端
│       │   │   └── snapshot.ts   # 插件 /internal/snapshot 客户端
│       │   └── auth.ts           # 可选 Basic Auth
│       ├── src/              # Vue 3 前端
│       │   ├── App.vue
│       │   ├── main.ts
│       │   ├── router.ts
│       │   ├── api/          # TanStack Query + fetch
│       │   ├── components/
│       │   ├── views/
│       │   │   ├── MonitorView.vue       # 模块 1
│       │   │   ├── ExperienceView.vue    # 模块 2
│       │   │   ├── MemoryView.vue        # 模块 3
│       │   │   └── MaintainView.vue      # 模块 4
│       │   └── stores/
│       └── tests/
│           ├── server/       # Fastify 路由测试
│           └── client/       # Vue 组件测试
└── src/
    └── dashboard-snapshot.ts # 插件侧新增: /internal/snapshot 端点实现
```

## 3. API 契约

### 3.1 读路径（dashboard 后端直读）

#### `GET /api/health/history?n=144`
直读 lcm.db `health_metrics` 表，返回历史健康快照数组。

```typescript
interface HealthHistoryResponse {
  snapshots: HealthSnapshot[];  // 复用 src/health-metrics.ts 的 HealthSnapshot
}
```

#### `GET /api/health/latest`
直读 lcm.db 最新一条 + 插件 `/internal/snapshot` 内存态聚合。

```typescript
interface HealthLatestResponse {
  db: HealthSnapshot | null;
  memory: {
    cascade: {
      armsCount: number;
      topArms: Array<{ armKey: string; alpha: number; beta: number; sample: number }>;
      confidenceThreshold: number;
    };
    userProfile: {
      techStack: Array<{ name: string; weight: number }>;
      scenario: Array<{ name: string; weight: number }>;
      language: 'zh' | 'en' | 'mixed';
    };
    graphAdapter: {
      connected: boolean;
      connectFailed: boolean;
      lastError?: string;
    };
    debt: {
      running: number;
      pendingCount: number;
      pollIntervalMs: number;
      maxConcurrent: number;
    };
    retrieval: {
      lastQuery: string;
      perfSummary: string;
    };
  } | null;  // null 表示插件未响应
}
```

#### `GET /api/experience/list?status=&type=&from=&to=&limit=20&offset=0`
直读 Neo4j，列出 EXPERIENCE 节点。

```typescript
interface ExperienceListResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    summary: string;
    type: string;
    status: string;          // PENDING | DISTILLED
    state: string | null;     // superseded 等
    relevanceScore: number;
    qualityScore: number | null;
    matchCount: number;
    createdAt: number;
    lastValidatedAt: number | null;
    tags: { scenario: string[]; techStack: string[]; severity: string; free: string[] };
    projectName: string;
  }>;
}
```

#### `GET /api/experience/:id`
直读 Neo4j，返回经验详情 + RELATED_TO 关联节点。

#### `GET /api/experience/relations/:id`
直读 Neo4j，返回 EXPERIENCE 节点的 RELATED_TO 邻接子图（供 ECharts Graph 可视化）。

```typescript
interface ExperienceGraphResponse {
  nodes: Array<{ id: string; name: string; type: string; pagerank: number }>;
  edges: Array<{ source: string; target: string; type: string }>;
}
```

#### `GET /api/memory/search?q=&engines=all&limit=10`
直读 QMD (FTS5) + Neo4j，跨引擎联合搜索（不走 MCP，复用 lcm-bridge 的 FTS5 查询逻辑）。

#### `GET /api/memory/graph?q=&limit=20`
直读 Neo4j，返回图谱节点子集（供 ECharts Graph 浏览）。

#### `GET /api/agent/status`
调用 OpenClaw host `/api/status`（如可用），返回 agent 运行状态。

### 3.2 写路径（调用 MCP 工具）

所有写路径通过 `POST /api/mcp/invoke`，body 含 `tool` + `params`：

```typescript
// POST /api/mcp/invoke
interface McpInvokeRequest {
  tool: string;       // 如 "lcmg_maintain"
  params: Record<string, unknown>;
}
interface McpInvokeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}
```

dashboard 后端将请求转发到 OpenClaw MCP host（HTTP）。封装的工具：
- `lcmg_maintain` —— 图谱维护
- `lcmg_forget` —— 主动遗忘
- `lcmg_pin` / `lcmg_unpin` —— 节点固定
- `lcmg_backup` / `lcmg_restore` —— 备份恢复
- `lcmg_sync` —— 同步修复
- `lcmg_import` —— 历史导入
- `lcmg_distill`（新增，见 3.3）
- `lcmg_compact`（新增，见 3.3）
- `lcmg_reset_breaker`（新增，见 3.3）

### 3.3 插件侧新增能力

#### 3.3.1 `/internal/snapshot` 端点（只读，供 dashboard 用）

插件启动时注册一个轻量 HTTP 服务（默认 :7423，仅 127.0.0.1），暴露：

```
GET /internal/snapshot
```

聚合返回 cascadeManager / userProfile / graphAdapter / debt / retrieval 内存态。**不暴露给 agent，仅本机 dashboard 访问**。

实现位置：`src/dashboard-snapshot.ts`，在 `register()` 中启动。

#### 3.3.2 新增 MCP 工具（手动触发）

当前缺手动触发入口的三项操作，新增为 MCP 工具：

| 工具 | 参数 | 能力 |
|------|------|------|
| `lcmg_distill` | `limit?` (默认 50) | 手动触发经验蒸馏（fetchPending → LLM → saveDistilled） |
| `lcmg_compact` | `conversationId?` | 手动触发指定会话 compact |
| `lcmg_reset_breaker` | `name` (lcm/qmd/neo4j) | 重置指定熔断器（graphAdapter 用 resetConnectFlag，CircuitBreaker 新增 reset） |

## 4. 前端模块设计

### 4.1 模块 1: 性能监控 Dashboard (`MonitorView.vue`)

**布局**: 上方 KPI 卡片行 + 中部时序图区 + 下方状态面板

| 区域 | 内容 | 数据源 | 刷新 |
|------|------|--------|------|
| KPI 卡片 | pendingMessages / maxTokenRatio / lastAssembleMs / cbFailures | `/api/health/latest` | 10s 轮询 |
| 时序图: 压力信号 | pendingMessages + summaryFragments + maxTokenRatio 三条线 | `/api/health/history?n=144` | 1min |
| 时序图: 检索延迟 | lastAssembleMs + L2/L3/L4Ms 堆叠 | 同上 | 1min |
| 时序图: tier 分布 | tierLow/Medium/High 堆叠面积图 | 同上 | 1min |
| 熔断状态面板 | 三子系统 available + failures，红绿灯样式 | `/api/health/latest` | 10s |
| Cascade 面板 | arms 数量 + top 10 arms Beta 分布柱状图 | `/api/health/latest` (memory.cascade) | 10s |
| 用户画像面板 | top techStack/scenario + language | `/api/health/latest` (memory.userProfile) | 30s |
| 债务调度面板 | running/pendingCount/pollInterval | `/api/health/latest` (memory.debt) | 10s |
| Agent 状态 | OpenClaw host 在线/会话数/token 使用 | `/api/agent/status` | 30s |

**ECharts 图表类型**: Line (时序) / Bar (Beta 分布) / Gauge (熔断) / Pie (tier)

### 4.2 模块 2: 经验管理 (`ExperienceView.vue`)

**布局**: 左侧过滤侧栏 + 主区列表 + 右侧详情抽屉

| 区域 | 内容 |
|------|------|
| 过滤侧栏 | status (PENDING/DISTILLED/superseded) / type / tag / 时间范围 / 项目名 |
| 列表表格 | title / type / status / relevanceScore / qualityScore / matchCount / lastValidatedAt |
| 详情抽屉 | 完整字段 + G-8 验证历史时间线 + RELATED_TO 关联图谱 (ECharts Graph) |
| 操作按钮 | 遗忘(soft/hard) / 固定/解固 / 触发蒸馏 / 查看原始证据 |

**质量分趋势**: 详情抽屉内嵌 mini Line 图，展示 qualityScore 随 lastValidatedAt 变化（需插件侧补 qualityScoreHistory 记录，MVP 阶段先用单点 + lastValidatedAt）。

### 4.3 模块 3: 记忆查询 (`MemoryView.vue`)

**布局**: 顶部搜索栏 + 下方双 Tab（列表 / 图谱）

| 区域 | 内容 |
|------|------|
| 搜索栏 | query 输入 + engines 选择 (all/lcm_only/qmd_only/neo4j_only) + limit |
| Tab 1: 列表 | 跨引擎搜索结果，按引擎分组，每条展示 content/score/source |
| Tab 2: 图谱 | ECharts Graph force layout，节点 = 实体/经验，边 = 关系；点击节点展示详情 |
| 节点详情 | 选中节点后右侧抽屉展示 pagerank / community / 关联经验 |

### 4.4 模块 4: 维护操作 (`MaintainView.vue`)

**布局**: 操作卡片网格，每张卡片 = 一项维护操作

| 卡片 | 操作 | 确认 |
|------|------|------|
| 图谱维护 | `lcmg_maintain` (dedup/PageRank/community) | 二次确认 |
| 触发蒸馏 | `lcmg_distill` (limit 输入) | 直接执行 |
| 触发 compact | `lcmg_compact` (conversationId 输入) | 二次确认 |
| 重置熔断器 | `lcmg_reset_breaker` (name 选择) | 二次确认 |
| TTL 清理 | `lcmg_maintain` (含 cleanupExpired) | 二次确认 |
| 备份 | `lcmg_backup` (outputPath 输入) | 直接执行 |
| 恢复 | `lcmg_restore` (backupPath + targets + dryRun) | 三次确认（dryRun 默认 true）|
| 同步修复 | `lcmg_sync` (mode=check/repair, dryRun) | repair 二次确认 |
| 历史导入 | `lcmg_import` (source + limit) | 二次确认 |

**操作日志**: 底部固定日志区，展示最近 20 条操作结果（成功/失败 + 耗时 + 错误信息）。

## 5. 数据流

### 5.1 读路径示例：监控页 KPI 刷新

```
Vue (useQuery, 10s refetch)
  → GET /api/health/latest
    → Fastify route handler
      → 并行: db.query('SELECT * FROM health_metrics ORDER BY timestamp DESC LIMIT 1')
              + fetch('http://127.0.0.1:7422/internal/snapshot')
      → 合并返回 { db, memory }
  ← Vue 更新 KPI 卡片
```

### 5.2 写路径示例：触发遗忘

```
Vue (useMutation)
  → POST /api/mcp/invoke { tool: 'lcmg_forget', params: { id, mode: 'hard', confirm: true } }
    → Fastify route handler
      → 转发到 OpenClaw MCP host HTTP 接口
        → 插件 lcmg_forget 工具执行
          → Neo4j: SET n.state='superseded', n.relevanceScore=0
        ← 返回结果
      ← 透传
  ← Vue 显示操作结果 + 刷新经验列表
```

## 6. 安全

### 6.1 网络绑定
- dashboard 后端默认绑定 `127.0.0.1:7421`，仅本机访问
- 前端 dev 默认 `127.0.0.1:7422`（vite，/api 代理到 7421）
- 插件 `/internal/snapshot` 绑定 `127.0.0.1:7423`，仅本机访问
- 三者均不暴露到外网

### 6.2 鉴权
- dashboard 默认无鉴权（单机内网）
- 可选通过环境变量 `DASHBOARD_AUTH=user:pass` 启用 Basic Auth
- MCP 工具调用复用 OpenClaw host 现有鉴权

### 6.3 写操作安全
- 所有危险操作（restore/sync repair/hard forget）前端二次确认
- `lcmg_restore` 强制 `dryRun=true` 默认
- `lcmg_forget` hard 模式强制 `confirm=true`
- pinned 节点的保护逻辑在插件侧（已有，无需 dashboard 重复实现）

## 7. 测试策略

### 7.1 后端测试 (vitest)
- 路由测试: 每条 `/api/*` 路由的 happy path + 错误路径
- db.ts: lcm.db 只读查询正确性
- mcp.ts: MCP 工具调用转发 + 错误处理
- snapshot.ts: 插件 /internal/snapshot 客户端 + 超时降级

### 7.2 前端测试 (@vue/test-utils)
- 组件渲染测试: 关键组件（KPI 卡片、时序图、列表、详情抽屉）
- TanStack Query 集成测试: mock /api 返回验证数据流

### 7.3 E2E 测试
- 启动 dashboard + mock 插件 /internal/snapshot + mock MCP host
- 四模块全流程：
  1. 监控页加载 → KPI/时序图/熔断状态正确渲染
  2. 经验列表 → 过滤 → 详情 → 关联图谱
  3. 记忆搜索 → 列表/图谱切换
  4. 维护操作 → 触发 → 日志展示

### 7.4 系统全流程测试报告
完整交付前输出 `packages/dashboard/E2E-REPORT.md`，覆盖：
- 四模块功能清单 + 通过/失败状态
- 性能基线（首屏 TTI / 图表渲染耗时 / API P95 延迟）
- 内存常驻占用（Node 进程 + 浏览器 tab）
- 已知问题与降级行为

## 8. 实施顺序

| 阶段 | 内容 | 验证 |
|------|------|------|
| P1 | monorepo 改造 + dashboard 骨架 + 插件 /internal/snapshot | `pnpm dev` 启动两个进程 |
| P2 | 模块 1: 性能监控 | 监控页渲染真实 health_metrics 数据 |
| P3 | 模块 2: 经验管理 | 列表/详情/关联图谱可用 |
| P4 | 模块 3: 记忆查询 | 跨引擎搜索 + 图谱浏览可用 |
| P5 | 模块 4: 维护操作 | 9 项操作可触发 + 日志展示 |
| P6 | 系统全流程测试报告 | E2E-REPORT.md 输出 |

每阶段独立测试验证后再进入下一阶段。

## 9. 配置

### 9.1 dashboard 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DASHBOARD_PORT` | 7421 | dashboard HTTP 端口 |
| `DASHBOARD_HOST` | 127.0.0.1 | 绑定地址 |
| `DASHBOARD_AUTH` | 无 | `user:pass` 启用 Basic Auth |
| `PLUGIN_SNAPSHOT_URL` | http://127.0.0.1:7423 | 插件快照端点 |
| `OPENCLAW_MCP_URL` | http://127.0.0.1:18789 | OpenClaw MCP host |
| `LCM_DB_PATH` | ~/.openclaw/lcm.db | lcm.db 路径 |
| `NEO4J_URI` | bolt://localhost:7687 | Neo4j 连接 |

### 9.2 插件侧配置

`openclaw.json` 的 `lcm-graph-extra.config` 新增：

```json
{
  "dashboardSnapshot": {
    "enabled": true,
    "port": 7423,
    "host": "127.0.0.1"
  }
}
```

## 10. 降级行为

| 故障 | 降级 |
|------|------|
| 插件 /internal/snapshot 不可用 | 监控页 memory 面板显示"插件未响应"，DB 历史数据正常 |
| OpenClaw MCP host 不可用 | 维护操作报错"host 不可达"，读路径不受影响 |
| Neo4j 不可用 | 经验列表/图谱报错，监控页显示熔断状态 |
| lcm.db 不存在 | 健康历史显示空，KPI 仅显示 memory 快照 |
