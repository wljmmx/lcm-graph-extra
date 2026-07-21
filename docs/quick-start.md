# 快速上手

5 分钟跑通 lcm-graph-extra 最小 demo。

## 前置条件

- Node.js ≥ 20（推荐 20 LTS）
- Neo4j 5.x（本地或远程）
- OpenClaw host（用于加载插件）

```bash
node --version  # 应输出 v20.x
```

## 步骤 1：安装

```bash
git clone https://github.com/wljmmx/lcm-graph-extra.git
cd lcm-graph-extra
npm install
```

## 步骤 2：配置 Neo4j

编辑 `~/.openclaw/openclaw.json`（首次运行自动生成）：

```json5
{
  "plugins": {
    "entries": {
      "lcm-graph-extra": {
        "config": {
          "neo4j": {
            "uri": "bolt://127.0.0.1:7687",
            "user": "neo4j",
            "password": "your-password"
          }
        }
      }
    }
  }
}
```

## 步骤 3：构建

```bash
npm run build
```

构建产物在 `dist/`，dashboard 前端在 `packages/dashboard/dist-client/`。

## 步骤 4：启动 dashboard（可选）

Dashboard 由两个独立 HTTP 服务组成：

| 服务 | 默认端口 | 实现 | 启动方 |
|------|---------|------|--------|
| Dashboard 后端（Fastify） | 7421 | `packages/dashboard/server/index.ts` | 独立进程 |
| 插件 Snapshot Server | 7423 | `src/dashboard-snapshot.ts`（node:http） | OpenClaw host 加载插件时自动启动 |

> Snapshot Server 无需手动启动 —— OpenClaw host 加载插件时由 `register()` 自动拉起，由 `openclaw.json` 的 `dashboardSnapshot` 配置控制（默认启用，端口 7423）。

### 4.1 开发模式（前端热更新）

```bash
cd packages/dashboard
npm run dev          # 同时启动后端 :7421（tsx watch）+ 前端 :7422（vite）
```

开发模式下前端由 Vite 在 7422 提供，`/api` 通过 Vite 代理转发到 7421。后端日志显示 `dev 模式：跳过静态资源 serve`。

### 4.2 生产模式

生产模式下后端用 `@fastify/static` 直接 serve `dist-client` 静态资源，无需 Vite。后端 TypeScript 由 `tsc` 编译为 `dist-server/`（配置见 `packages/dashboard/tsconfig.server.json`）。

```bash
# 1. 构建主插件（生成 dist/）
npm run build

# 2. 构建 dashboard 前端 + 后端
cd packages/dashboard
npm run build          # vite build（→ dist-client/）+ tsc 编译后端（→ dist-server/）

# 3. 启动（必须设置 NODE_ENV=production）
cd ../..
NODE_ENV=production node packages/dashboard/dist-server/index.js
```

启动后访问 http://127.0.0.1:7421 即可看到 dashboard。

> **构建产物说明**：
> - `dist-client/`：Vite 构建的前端静态资源（HTML/JS/CSS），生产模式由 Fastify `@fastify/static` serve
> - `dist-server/`：tsc 编译的后端 JavaScript（含 `index.js` 入口 + `lib/` + `routes/`），生产模式直接 `node` 运行

### 4.3 生产模式安全配置

生产模式必须配置以下环境变量，否则启动时会打印 CRITICAL 警告：

```bash
# Basic Auth 凭据（dashboard 后端 + snapshot server 共用）
export DASHBOARD_AUTH="admin:your-strong-password"

# snapshot server 关闭 token（防止未授权 POST /internal/shutdown）
export SNAPSHOT_SHUTDOWN_TOKEN="your-shutdown-token"

# 可选：限制 snapshot server 访问 IP（默认仅本机）
export SNAPSHOT_ALLOWED_IPS="127.0.0.1,::1,::ffff:127.0.0.1"

# 可选：严格模式 —— 未配置 DASHBOARD_AUTH 时拒绝启动
export REQUIRE_DASHBOARD_AUTH=true
```

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `NODE_ENV` | - | 设为 `production` 启用静态资源 serve + 生产模式安全检查 |
| `DASHBOARD_PORT` | `7421` | dashboard 后端端口 |
| `DASHBOARD_HOST` | `127.0.0.1` | dashboard 后端绑定地址（开放外网设为 `0.0.0.0`） |
| `DASHBOARD_AUTH` | 无 | Basic Auth `user:pass`，**生产模式必填** |
| `DASHBOARD_RATE_LIMIT_MAX` | `100` | dashboard 后端限流上限（每窗口请求数） |
| `DASHBOARD_RATE_LIMIT_WINDOW` | `60` | 限流窗口（秒） |
| `LOG_LEVEL` | `info` | 日志级别 |
| `PLUGIN_SNAPSHOT_URL` | `http://127.0.0.1:7423` | dashboard 后端访问插件 snapshot 的地址 |
| `SNAPSHOT_SHUTDOWN_TOKEN` | 无 | `/internal/shutdown` 鉴权 token |
| `SNAPSHOT_ALLOWED_IPS` | `127.0.0.1,::1,::ffff:127.0.0.1` | snapshot server IP 白名单 |
| `SNAPSHOT_RATE_LIMIT_MAX` | `60` | snapshot server 限流上限 |
| `SNAPSHOT_RATE_LIMIT_WINDOW` | `60` | snapshot server 限流窗口（秒） |
| `REQUIRE_DASHBOARD_AUTH` | 无 | 设为 `true` 时未配置 `DASHBOARD_AUTH` 拒绝启动 |

> **Snapshot Server 端口**：由 `openclaw.json` 的 `plugins.lcm-graph-extra.config.dashboardSnapshot.port` 控制（默认 7423），**不是**环境变量。如需修改端口，编辑 `~/.openclaw/openclaw.json`：
> ```json
> { "plugins": { "lcm-graph-extra": { "config": { "dashboardSnapshot": { "port": 7424 } } } } }
> ```

### 4.4 Docker 一键部署（推荐生产方式）

```bash
docker compose up -d
```

Docker 镜像已内置：
- 多阶段构建（builder 构建产物 → runtime 仅含 dist）
- `NODE_ENV=production` + `DASHBOARD_HOST=0.0.0.0`
- 启动前自动执行 `scripts/docker-security-check.sh` 安全检查
- `HEALTHCHECK` 探测 `http://127.0.0.1:7421/api/ping`

**生产部署前务必修改默认密码**：编辑 `docker-compose.yml` 中 `DASHBOARD_AUTH`（默认 `admin:changeme-docker-default`）。

启动后：
- Neo4j Browser: http://127.0.0.1:7474
- Dashboard: http://127.0.0.1:7421（需 Basic Auth）

### 4.5 健康检查

```bash
# 验证 dashboard 后端
curl http://127.0.0.1:7421/api/ping
# 应返回 {"ok":true,"ts":...}

# 验证插件 snapshot 服务
curl http://127.0.0.1:7423/internal/health
# 应返回 {"ok":true,"ts":...}

# 验证 Prometheus 指标
curl http://127.0.0.1:7423/metrics
# 应返回 text/plain 格式指标

# Docker 容器健康检查
docker compose ps   # STATUS 列应显示 healthy
docker compose logs dashboard
```

## 步骤 5：通过 OpenClaw host 加载插件

将插件路径加入 OpenClaw 配置，重启 host。插件会自动：
- 注册 16 个 MCP 工具（`lcmg_*`）
- 注册 ContextEngine（assemble / afterTurn / heartbeat）
- 启动 :7423 snapshot HTTP 服务（供 dashboard 读取，见步骤 4 表格）

加载完成后即可通过步骤 4.5 的健康检查验证。

## 下一步

- 阅读 [API.md](../API.md) 了解生命周期钩子
- 阅读 [ROADMAP.md](../ROADMAP.md) 了解能力边界
- 阅读 [FAQ](./faq.md) 排查常见问题
- 阅读 [配置参考手册](./config-reference.md) 了解完整配置项
