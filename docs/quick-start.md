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

```bash
# 开发模式（前端热更新）
cd packages/dashboard
npm run dev:server &  # 后端 :7421
npm run dev          # 前端 :7422

# 生产模式
npm run build
NODE_ENV=production node dist-server/index.js
```

访问 http://127.0.0.1:7421 即可看到 dashboard。

## 步骤 5：通过 OpenClaw host 加载插件

将插件路径加入 OpenClaw 配置，重启 host。插件会自动：
- 注册 16 个 MCP 工具（`lcmg_*`）
- 注册 ContextEngine（assemble / afterTurn / heartbeat）
- 启动 :7423 snapshot HTTP 服务（供 dashboard 读取）

## 步骤 6：验证安装

```bash
# 验证 snapshot 服务
curl http://127.0.0.1:7423/internal/health
# 应返回 {"ok":true,"ts":...}

# 验证 Prometheus 指标
curl http://127.0.0.1:7423/metrics
# 应返回 text/plain 格式指标

# 验证 dashboard 后端
curl http://127.0.0.1:7421/api/ping
# 应返回 {"ok":true,"ts":...}
```

## Docker 一键部署（可选）

```bash
docker compose up -d
```

启动后：
- Neo4j Browser: http://127.0.0.1:7474
- Dashboard: http://127.0.0.1:7421

## 下一步

- 阅读 [API.md](../API.md) 了解生命周期钩子
- 阅读 [ROADMAP.md](../ROADMAP.md) 了解能力边界
- 阅读 [FAQ](./faq.md) 排查常见问题
