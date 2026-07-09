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
| 测试中心 | `/testing` | CE 引擎压测（BEIR 标准测试集 + 多轮会话分析 + CE 多引擎诊断 + **SSE 实时日志**）+ QMD MCP 测试工具（v2.3.2 整合） |
| 维护操作 | `/maintain` | 9 项维护卡片 + 操作日志（最近 20 条）|

> v2.3.2 起，原 `/benchmark` 和 `/qmd-test` 两个独立页面已整合为「测试中心」(`/testing`)，通过页面内 Tab 切换。旧路由仍保留并自动重定向到 `/testing?tab=<benchmark|qmd-test>`，向后兼容书签与外链。

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
| `DASHBOARD_URL` | http://127.0.0.1:7421 | dashboard 自身地址（benchmark CE 引擎模式默认） |
| `BENCHMARK_CACHE_DIR` | ~/.openclaw/.benchmark | benchmark 测试集缓存根目录 |
| `BENCHMARK_BEIR_MIRROR` | 无 | BEIR 下载镜像源（指向自建/内网镜像，拼接 `<mirror>/<name>.zip`） |

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

## 安全

### Basic Auth（可选）

生产环境建议启用 HTTP Basic Auth 保护 dashboard：

```bash
export DASHBOARD_AUTH="admin:your-secure-password"
npm start
```

**保护范围**：
- 所有 `/api/*` 路由（`/api/ping` 除外，用于健康检查）
- 生产模式下的前端静态资源（HTML/JS/CSS）

**默认不启用**（单机内网无鉴权模式）。生产模式下未配置 `DASHBOARD_AUTH` 时，服务启动会打印显著警告。

### 安全加固（v1.0.1+）

除可选 Basic Auth 外，dashboard 后端内置以下纵深防御措施：

| 措施 | 实现位置 | 说明 |
|------|---------|------|
| 速率限制 | `server/index.ts` `@fastify/rate-limit` | 全局 100 req/30s（生产 200/30s），防爆破 |
| 安全响应头 | `server/index.ts` `onSend` hook | `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` |
| MCP 工具白名单 | `server/routes/mcp.ts` `ALLOWED_MCP_TOOLS` | `POST /api/mcp/invoke` 仅转发 11 个已知工具，拒绝任意工具调用 |
| 路径安全校验 | 前端 `validateOpenclawPath` + 后端 `validatePathUnderOpenclaw` | backup/restore/import 路径必须落在 `~/.openclaw` 下，拒绝 `..` 穿越 |
| 错误响应脱敏 | `server/routes/*.ts` | catch 块统一返回"请查看服务端日志"，不泄漏堆栈/内部路径 |
| 配置路径不暴露 | `server/routes/config.ts` | `GET /api/config` 不再返回 `configPath` 绝对路径，仅返回 `configExists` 布尔 |

### 操作日志持久化

所有 MCP 工具调用自动记录到独立 SQLite 数据库：

- **路径**：`~/.openclaw/operation_logs.db`
- **保留**：最近 1000 条（LRU 淘汰）
- **查询**：`GET /api/operation-logs?n=50&tool=lcmg_maintain`

用于审计追溯和故障排查。

## 技术栈

- **后端**: Fastify 5 + node:sqlite + neo4j-driver
- **前端**: Vue 3 + Vite + Naive UI + ECharts + TanStack Query
- **设计系统**: CSS 自定义属性设计令牌（`tokens.css`）+ light/dark/auto 三态主题 + WCAG AA 可访问性（`:focus-visible` / `prefers-reduced-motion` / `prefers-contrast` / 双重编码状态指示）
- **测试**: Vitest + @vue/test-utils + happy-dom

## 测试

```bash
npm test           # 128 项测试
npm run typecheck  # 类型检查
```

详见 [E2E-REPORT.md](./E2E-REPORT.md)。

## 测试中心（v2.3.2 整合）

访问 `/testing` 页面，包含两个子 Tab：

- **CE 引擎压测**：测试 CE 引擎（L1 lossless-claw + L2 QMD + L3 Neo4j）的检索能力，支持 SSE 实时日志
- **QMD MCP 测试**：对单条 query 反复迭代 N 次，统计 REST/MCP 协议延迟与成功率

### 实时日志（SSE 流式，v2.3.2 新增）

压测执行期间，**不再需要等待全部完成**才能看到结果 —— 通过 SSE 流式推送，每完成一条 fixture 即时展示：

| 能力 | 说明 |
|------|------|
| 实时进度条 | 显示 `已完成/总数` 与百分比，运行中脉冲动画 |
| 逐条日志面板 | 每条 fixture 完成后立即追加一行：序号 / ✓✗ / fixtureId / 查询文本 / 分类 / CE 诊断标签 / 结果数 / 延迟（带颜色）/ 错误信息 |
| 中断按钮 | 测试运行中可随时点击「中断」终止（已完成结果保留在日志面板） |
| 清空日志 | 测试结束后可清空日志面板 |

**技术实现**：

- 后端新增 `POST /api/benchmark/run-stream` 端点，返回 `text/event-stream`，事件类型：`start` / `progress`（携带单条 item 结果）/ `done`（携带完整 BenchmarkResult）/ `error`
- runner 的 `onProgress` 回调已扩展为 4 参数（增加 `item: BenchmarkItemResult`），在 SSE 路径被接入，每条 fixture 完成时推送
- 前端用 `fetch + ReadableStream` 消费 SSE（EventSource 不支持 POST 请求体），逐块解析 `event:`/`data:` 行
- 原 `POST /api/benchmark/run` 同步端点保留，用于测试代码与 fallback

> 客户端断开会自动检测（`req.raw.on('close')`），不再向已关闭连接写数据。

## Benchmark CE 引擎能力压测（v2.3.1）

访问 `/benchmark` 页面，测试 CE 引擎（L1 lossless-claw + L2 QMD + L3 Neo4j）的检索能力。

### 测试集

| 测试集 ID | 类型 | 说明 | requiresDownload |
|----------|------|------|-------------------|
| `project-scenarios` | 单轮 | 21 条项目场景查询（知识/经验/错误/配置/多语言/复合） | 否 |
| `ce-multi-turn` | 多轮 | 7 条多轮会话（基于 lossless-claw 能力维度：opening/followup/clarify/recall/compress） | 否 |
| `beir-nfcorpus` | BEIR | 业界公认信息检索标准测试集 — 医学领域 3.2K 查询 | 是 |
| `beir-scifact` | BEIR | 业界公认信息检索标准测试集 — 科学论文 1.4K 查询 | 是 |

### 查询引擎

| 引擎 | 说明 | 测试目标 |
|------|------|---------|
| `qmd` | 直查 QMD `/query`（L2 hybrid 检索） | QMD 单引擎检索能力 |
| `ce` | 走 dashboard `/api/memory/search`（L1 lcm + L2 qmd + L3 neo4j 三引擎并行） | CE 多引擎联合检索能力 |

### CE 引擎诊断（v2.3.1）

当选择 `ce` 引擎时，每条查询结果附带 CE 诊断信息，区分"服务不可达"vs"无数据"：

| 诊断结论 | 含义 | 建议 |
|----------|------|------|
| `ok` | 三引擎正常返回 | - |
| `all-empty` | 三引擎均返回空结果 | lossless-claw 未摄入会话数据 / QMD 未索引代码 / Neo4j 无图节点 |
| `all-failed` | 三引擎全部报错 | dashboard 未启动 / OpenClaw 宿主 / QMD / Neo4j 依赖不可用 |
| `partial-failure` | 部分引擎失败 | 查看各引擎 error 字段 |

### BEIR 标准测试集部署

BEIR 数据集（`beir-nfcorpus` / `beir-scifact`）需要下载后缓存到本地。

#### 自动下载

在 `/benchmark` 页面选择 BEIR 测试集后，点击"立即下载"按钮。下载源优先级：

1. `BENCHMARK_BEIR_MIRROR` 环境变量指向的自建镜像（若配置）
2. HuggingFace BeIR 组织镜像（`huggingface.co/datasets/BeIR/`）
3. TU Darmstadt 官方源（`public.ukp.informatik.tu-darmstadt.de`，偶尔不稳定）

下载失败时页面自动展示手工下载指引。

#### 手工下载部署

若自动下载失败，按以下步骤手工部署：

**NFCorpus:**

```bash
# 1. 下载 zip（任选一个源）
wget https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip
# 或从 HuggingFace 镜像下载:
# wget https://huggingface.co/datasets/BeIR/nfcorpus/resolve/main/nfcorpus.zip

# 2. 解压
unzip nfcorpus.zip -d nfcorpus_tmp

# 3. 部署到缓存目录（BEIR zip 内有顶层目录 nfcorpus/，需将其内容放到缓存目录）
mkdir -p ~/.openclaw/.benchmark/beir/nfcorpus/qrels
cp nfcorpus_tmp/nfcorpus/corpus.jsonl ~/.openclaw/.benchmark/beir/nfcorpus/
cp nfcorpus_tmp/nfcorpus/queries.jsonl ~/.openclaw/.benchmark/beir/nfcorpus/
cp nfcorpus_tmp/nfcorpus/qrels/qrels.jsonl ~/.openclaw/.benchmark/beir/nfcorpus/qrels/

# 4. 清理临时文件
rm -rf nfcorpus_tmp nfcorpus.zip
```

**SciFact:** 同上，将 `nfcorpus` 替换为 `scifact`。

#### 缓存目录结构

部署完成后，缓存目录需包含以下文件：

```
~/.openclaw/.benchmark/beir/
├── nfcorpus/
│   ├── corpus.jsonl      # 文档库（每行 {"_id":"doc-1","title":"...","text":"..."}）
│   ├── queries.jsonl     # 查询集（每行 {"_id":"query-1","text":"..."}）
│   └── qrels/
│       └── qrels.jsonl   # 黄金答案（每行 {"query-id":"query-1","corpus-id":"doc-1","score":1}）
└── scifact/
    ├── corpus.jsonl
    ├── queries.jsonl
    └── qrels/
        └── qrels.jsonl
```

#### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/benchmark/fixture-sets` | 列出所有测试集元数据 |
| GET | `/api/benchmark/fixtures?set=<id>` | 获取指定测试集 fixtures |
| GET | `/api/benchmark/beir/status` | BEIR 缓存状态 |
| GET | `/api/benchmark/beir/manual?dataset=<name>` | 获取手工下载指引 |
| POST | `/api/benchmark/beir/download` | 触发 BEIR 下载 |
| GET | `/api/benchmark/default-url` | 系统配置中的 QMD + dashboard 地址 |
| POST | `/api/benchmark/run` | 执行压测（同步，返回完整结果） |
| POST | `/api/benchmark/run-stream` | 执行压测（**SSE 流式**，逐条推送 progress + 完成推送 done；v2.3.2） |
| GET | `/api/benchmark/history` | 历史运行列表 |
| GET | `/api/benchmark/report/:id` | 获取完整结果 |
| GET | `/api/benchmark/report/:id/markdown` | 下载 Markdown 报告 |

## 许可证

MIT
