# LCM Graph Extra 配置参考手册

> 版本：v2.1.11+ | 2026-07-16
> 配置文件路径：`~/.openclaw/openclaw.json` 中 `plugins.lcm-graph-extra` 段

## 配置方式

所有配置通过 `openclaw.json` 的 `plugins.lcm-graph-extra` 段设置，TypeBox Schema 自动校验并填充默认值。

```json
{
  "plugins": {
    "lcm-graph-extra": {
      // 配置项
    }
  }
}
```

部分紧急参数支持环境变量覆盖（见各配置项说明）。

---

## 一、基础配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `summaryStrategy` | `"strategy" \| "hybrid" \| "full"` | `"strategy"` | 摘要策略：strategy=精简摘要，hybrid=混合，full=完整 |
| `maxGraphDepth` | `number` | `10` | 图谱最大遍历深度 |
| `maxNodeCount` | `number` | `5000` | 图谱最大节点数 |
| `enableCrossFileLinkage` | `boolean` | `true` | 跨文件关联 |
| `crossReferenceRetentionDays` | `number` | `90` | 交叉引用保留天数 |
| `maxTokens` | `number` | `65536` | 最大 token 数 |
| `budgetRatio` | `number` | `0.3` | 上下文预算比例 (0-1) |

---

## 二、LLM 配置

### 2.1 通用 LLM 提供商

```json
{
  "llmProvider": {
    "provider": "openclaw_hooks",
    "model": "default",
    "maxTokens": 4096
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `llmProvider.provider` | `"openclaw_hooks" \| "openai" \| "ollama" \| "custom"` | `"openclaw_hooks"` | LLM 提供商 |
| `llmProvider.model` | `string` | `"default"` | 模型名称 |
| `llmProvider.maxTokens` | `number` | `4096` | 最大输出 token |

### 2.2 LLM 超时配置

针对本地大模型调优，各 LLM 调用场景独立超时。

```json
{
  "llmTimeouts": {
    "rerankTimeoutMs": 30000,
    "judgeTimeoutMs": 60000,
    "validateTimeoutMs": 45000,
    "summarizeTimeoutMs": 90000,
    "embedTimeoutMs": 60000,
    "graphLlmTimeoutMs": 90000,
    "cascadeTier2Ms": 60000,
    "cascadeTier3Ms": 90000,
    "distillMs": 120000
  }
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `llmTimeouts.rerankTimeoutMs` | `30000` | merger LLM 重排超时 |
| `llmTimeouts.judgeTimeoutMs` | `60000` | R-2 Tier2 LLM 判断超时 |
| `llmTimeouts.validateTimeoutMs` | `45000` | G-8 验证超时 |
| `llmTimeouts.summarizeTimeoutMs` | `90000` | 经验回顾摘要超时 |
| `llmTimeouts.embedTimeoutMs` | `60000` | embedding 调用超时 |
| `llmTimeouts.graphLlmTimeoutMs` | `90000` | 图谱 LLM 超时 |
| `llmTimeouts.cascadeTier2Ms` | `60000` | 级联 Tier2 判断超时 |
| `llmTimeouts.cascadeTier3Ms` | `90000` | 级联 Tier3 验证超时 |
| `llmTimeouts.distillMs` | `120000` | 单条经验蒸馏超时 |

### 2.3 蒸馏专用 LLM

```json
{
  "distillationLlm": {
    "provider": "openclaw_hooks",
    "model": "ollama/qwen3.6:27b",
    "apiKey": "",
    "baseURL": "http://127.0.0.1:18789/v1",
    "keepAlive": "1h"
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `distillationLlm.provider` | `"openclaw_hooks" \| "openai" \| "ollama" \| "custom"` | `"openclaw_hooks"` | 蒸馏 LLM 提供商 |
| `distillationLlm.model` | `string` | `"ollama/qwen3.6:27b"` | 蒸馏模型 |
| `distillationLlm.apiKey` | `string` | - | API Key |
| `distillationLlm.baseURL` | `string` | - | API 地址 |
| `distillationLlm.keepAlive` | `string` | `"1h"` | Ollama 模型驻留时间 |

---

## 三、存储配置

### 3.1 Neo4j

```json
{
  "neo4j": {
    "uri": "bolt://localhost:7687",
    "user": "neo4j",
    "password": ""
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `neo4j.uri` | `string` | `"bolt://localhost:7687"` | Neo4j 连接 URI |
| `neo4j.user` | `string` | `"neo4j"` | 用户名 |
| `neo4j.password` | `string` | `""` | 密码 |

### 3.2 Embedding

```json
{
  "embedding": {
    "apiKey": "",
    "baseURL": "http://127.0.0.1:18789/v1",
    "model": "nomic-embed-text",
    "dimensions": 768,
    "keepAlive": "1h"
  }
}
```

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `embedding.apiKey` | `string` | API Key |
| `embedding.baseURL` | `string` | 嵌入服务地址 |
| `embedding.model` | `string` | 嵌入模型名 |
| `embedding.dimensions` | `number` | 向量维度 |
| `embedding.keepAlive` | `string` | Ollama keepAlive |

---

## 四、检索配置

```json
{
  "retrieval": {
    "qmd": {
      "mcpEndpoint": ""
    },
    "limits": {
      "qmd": 5,
      "graph": 5,
      "exp": 3
    },
    "graph": {
      "enabled": true,
      "searchLimit": 5
    }
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `retrieval.qmd.mcpEndpoint` | `string` | - | QMD MCP 端点 |
| `retrieval.limits.qmd` | `number` | `5` | QMD 检索上限 |
| `retrieval.limits.graph` | `number` | `5` | 图谱检索上限 |
| `retrieval.limits.exp` | `number` | `3` | 经验检索上限 |
| `retrieval.graph.enabled` | `boolean` | `true` | 图谱检索开关 |
| `retrieval.graph.searchLimit` | `number` | `5` | 图谱搜索限制 |

---

## 五、窗口监控（lcmMonitor）

控制压力分级和上下文管理的核心配置。

```json
{
  "lcmMonitor": {
    "enabled": true,
    "contextWindow": 262144,
    "dedupRounds": 24,
    "highPressureThreshold": 0.85,
    "mediumPressureThreshold": 0.70,
    "proactiveThreshold": 0.65,
    "systemPromptOverheadTokens": 17000,
    "compactTokenBudget": 114688,
    "compactTimeout": 60000,
    "maxSummaryTokenRatio": 0.45,
    "retrievalLimits": {
      "low":    { "qmd": 5, "graph": 5, "exp": 3 },
      "medium": { "qmd": 3, "graph": 3, "exp": 1 },
      "high":   { "qmd": 1, "graph": 1, "exp": 0 }
    },
    "maxContextChars": {
      "low":    12000,
      "medium": 6000,
      "high":   1600
    }
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `lcmMonitor.enabled` | `boolean` | `true` | 窗口监控开关 |
| `lcmMonitor.contextWindow` | `number` | `262144` | 上下文窗口大小（token） |
| `lcmMonitor.dedupRounds` | `number` | `24` | 去重回顾轮数 |
| `lcmMonitor.highPressureThreshold` | `number` | `0.85` | 高压力阈值 |
| `lcmMonitor.mediumPressureThreshold` | `number` | `0.70` | 中压力阈值 |
| `lcmMonitor.proactiveThreshold` | `number` | `0.65` | 主动压缩阈值 |
| `lcmMonitor.systemPromptOverheadTokens` | `number` | `17000` | 系统提示词开销 token |
| `lcmMonitor.compactTokenBudget` | `number` | `114688` | 压缩 token 预算 |
| `lcmMonitor.compactTimeout` | `number` | `60000` | 压缩超时（ms） |
| `lcmMonitor.maxSummaryTokenRatio` | `number` | `0.45` | 摘要 token 最大比例 |
| `lcmMonitor.retrievalLimits.low` | `object` | `{qmd:5, graph:5, exp:3}` | 低压力检索限制 |
| `lcmMonitor.retrievalLimits.medium` | `object` | `{qmd:3, graph:3, exp:1}` | 中压力检索限制 |
| `lcmMonitor.retrievalLimits.high` | `object` | `{qmd:1, graph:1, exp:0}` | 高压力检索限制 |
| `lcmMonitor.maxContextChars.low` | `number` | `12000` | 低压力最大字符数 |
| `lcmMonitor.maxContextChars.medium` | `number` | `6000` | 中压力最大字符数 |
| `lcmMonitor.maxContextChars.high` | `number` | `1600` | 高压力最大字符数 |

### 压力等级规则

| 等级 | 触发条件 | 检索量 | 注入量 | 行为 |
|------|---------|--------|--------|------|
| low | 正常 | qmd:5, graph:5, exp:3 | 12000 chars | 全量检索 + LLM 重排 |
| medium | msg>24 或 ratio>0.70 | qmd:3, graph:3, exp:1 | 6000 chars | 异步 compact + 摘要注入 |
| high | msg>48 或 ratio>0.85 | qmd:1, graph:1, exp:0 | 1600 chars | 同步 compact + 降级上下文 |

---

## 六、Compact 配置

```json
{
  "compaction": {
    "enabled": true,
    "mode": "auto",
    "triggerThreshold": 20000,
    "softThresholdTokens": 163840,
    "keepRecentTokens": 131072
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `compaction.enabled` | `boolean` | `true` | 压缩开关 |
| `compaction.mode` | `string` | - | 压缩模式 |
| `compaction.triggerThreshold` | `number` | `20000` | 触发压缩的 token 阈值 |
| `compaction.softThresholdTokens` | `number` | `163840` | 软阈值 token |
| `compaction.keepRecentTokens` | `number` | `131072` | 保留最近 token |

**环境变量**：`LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS` 覆盖同步 compact 超时（默认 300s）。

---

## 七、经验系统

```json
{
  "experience": {
    "enabled": true,
    "triggers": ["correction", "failure", "fix_success", "explicit_save"],
    "summaryMode": "async",
    "schedule": {
      "dreaming": "0 3 * * *",
      "incremental": "0 */12 * * *"
    },
    "relevanceThreshold": 0.6
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `experience.enabled` | `boolean` | `true` | 经验系统开关 |
| `experience.triggers` | `array` | `["correction","failure","fix_success","explicit_save"]` | 触发源 |
| `experience.summaryMode` | `"async" \| "sync"` | `"async"` | 摘要模式 |
| `experience.schedule.dreaming` | `string` | `"0 3 * * *"` | 深度蒸馏 cron |
| `experience.schedule.incremental` | `string` | `"0 */12 * * *"` | 增量蒸馏 cron |
| `experience.relevanceThreshold` | `number` | `0.6` | 相关性阈值 |

### 触发源说明

| 触发源 | 说明 |
|--------|------|
| `correction` | 用户纠正 Agent 输出 |
| `failure` | Agent 执行失败 |
| `fix_success` | 修复问题后成功 |
| `explicit_save` | 用户显式保存 |

---

## 八、MoA 多模型协作

```json
{
  "moa": {
    "enabled": false,
    "complexityThreshold": 0.6,
    "mode": "serial",
    "referenceModels": [],
    "aggregatorModel": {
      "provider": "ollama",
      "model": "qwen3.6:27b",
      "temperature": 0.3,
      "timeoutMs": 1200000
    },
    "enabledTiers": ["low"],
    "presets": [],
    "activePreset": ""
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `moa.enabled` | `boolean` | `false` | MoA 开关 |
| `moa.complexityThreshold` | `number` | `0.6` | 复杂度阈值 (0-1) |
| `moa.mode` | `"parallel" \| "serial"` | `"serial"` | 执行模式 |
| `moa.referenceModels` | `array` | `[]` | 参考模型列表 (2-4 个) |
| `moa.aggregatorModel` | `object` | - | 聚合模型配置 |
| `moa.enabledTiers` | `array` | `["low"]` | 启用压力等级 |
| `moa.presets` | `array` | `[]` | 自定义预设 |
| `moa.activePreset` | `string` | - | 激活预设名 |

### 参考模型配置

```json
{
  "provider": "ollama",
  "model": "qwen3.6:27b",
  "temperature": 0.6,
  "systemPrompt": "你是一位...",
  "timeoutMs": 900000,
  "apiKey": "",
  "baseURL": "http://127.0.0.1:18789/v1",
  "keepAlive": "1h"
}
```

### 内置预设

| 预设名 | 视角 | 参考模型 |
|--------|------|---------|
| `code-review` | 代码审查 | 架构专家 + 安全专家 + 性能专家 |
| `architecture` | 架构设计 | 系统架构师 + 技术选型专家 |
| `security` | 安全审计 | 漏洞分析师 + 合规审计专家 |

使用 `/moa <preset-name>` 命令切换，或由自动分类器自动匹配。

---

## 九、TTL 与备份

### 9.1 TTL 过期清理

```json
{
  "ttl": {
    "enabled": true,
    "retentionDays": 90,
    "cleanupIntervalHours": 24
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `ttl.enabled` | `boolean` | `true` | TTL 开关 |
| `ttl.retentionDays` | `number` | `90` | 保留天数 |
| `ttl.cleanupIntervalHours` | `number` | `24` | 清理间隔（小时） |

### 9.2 备份

```json
{
  "backupConfig": {
    "enabled": true,
    "retentionDays": 30,
    "maxBackups": 10,
    "intervalHours": 24,
    "backupDir": ""
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `backupConfig.enabled` | `boolean` | `true` | 自动备份开关 |
| `backupConfig.retentionDays` | `number` | `30` | 备份保留天数 |
| `backupConfig.maxBackups` | `number` | `10` | 最大备份数 |
| `backupConfig.intervalHours` | `number` | `24` | 备份间隔（小时） |
| `backupConfig.backupDir` | `string` | - | 备份目录 |

---

## 十、日志与监控

### 10.1 日志

```json
{
  "logging": {
    "level": "info",
    "file": ""
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `logging.level` | `"silent" \| "fatal" \| "error" \| "warn" \| "info" \| "debug" \| "trace"` | `"info"` | 日志级别 |
| `logging.file` | `string` | - | 日志文件路径 |

### 10.2 Webhook

```json
{
  "webhook": {
    "enabled": false,
    "url": "",
    "events": ["dag_update", "compaction", "backup", "error"]
  }
}
```

| 事件 | 说明 |
|------|------|
| `dag_update` | DAG 更新 |
| `compaction` | 压缩完成 |
| `backup` | 备份完成 |
| `error` | 错误事件 |

### 10.3 Dashboard 快照

插件 snapshot server（端口 7423）由 OpenClaw host 加载插件时自动启动，无需手动运行。通过 `openclaw.json` 配置控制开关/端口/绑定地址。

```json
{
  "dashboardSnapshot": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 7423
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `dashboardSnapshot.enabled` | `boolean` | `true` | 快照服务开关 |
| `dashboardSnapshot.host` | `string` | `"127.0.0.1"` | 绑定地址 |
| `dashboardSnapshot.port` | `number` | `7423` | 绑定端口（1-65535） |

**Snapshot Server 环境变量**（运行时行为控制，不覆盖上述配置项）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DASHBOARD_AUTH` | 无 | Basic Auth `user:pass`，与 dashboard 后端共用凭据；`/internal/health` 豁免 |
| `SNAPSHOT_ALLOWED_IPS` | `127.0.0.1,::1,::ffff:127.0.0.1` | IP 白名单（逗号分隔） |
| `SNAPSHOT_RATE_LIMIT_MAX` | `60` | 限流上限（每窗口请求数） |
| `SNAPSHOT_RATE_LIMIT_WINDOW` | `60` | 限流窗口（秒） |
| `SNAPSHOT_SHUTDOWN_TOKEN` | 无 | `POST /internal/shutdown` 鉴权 token |

**Dashboard 后端环境变量**（独立进程，见 [快速上手](./quick-start.md#43-生产模式安全配置) 步骤 4.3）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NODE_ENV` | - | `production` 启用静态资源 serve + 生产模式安全检查 |
| `DASHBOARD_PORT` | `7421` | dashboard 后端端口 |
| `DASHBOARD_HOST` | `127.0.0.1` | 绑定地址（开放外网设为 `0.0.0.0`） |
| `DASHBOARD_RATE_LIMIT_MAX` | `100` | 限流上限 |
| `DASHBOARD_RATE_LIMIT_WINDOW` | `60` | 限流窗口（秒） |
| `PLUGIN_SNAPSHOT_URL` | `http://127.0.0.1:7423` | dashboard 后端访问插件 snapshot 的地址 |
| `REQUIRE_DASHBOARD_AUTH` | 无 | `true` 时未配置 `DASHBOARD_AUTH` 拒绝启动 |

---

## 十一、其他配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `cliTimeout` | `number` | `30000` | CLI 命令超时（ms） |
| `cliFallbackSearchType` | `"search" \| "query"` | `"search"` | QMD CLI 回退搜索类型 |
| `distillationIntervalMs` | `number` | `7200000` | 蒸馏间隔（ms，默认 2h） |
| `tripletTimeoutMs` | `number` | `60000` | 三元组提取超时（ms） |
| `experienceTtlIntervalMs` | `number` | `86400000` | 经验 TTL 检查间隔（ms，默认 24h） |

---

## 十二、环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS` | 同步 compact 超时 | `300000` |
| `LCMG_COMPACT_TIMEOUT_MS` | compact 操作超时 | `300000` |
| `LCMG_DISTILL_CONCURRENCY` | 蒸馏并发数 | `3` |
| `DASHBOARD_AUTH` | Dashboard Basic Auth（后端 + snapshot 共用） | 无 |
| `DASHBOARD_PORT` | dashboard 后端端口 | `7421` |
| `DASHBOARD_HOST` | dashboard 后端绑定地址 | `127.0.0.1` |
| `DASHBOARD_RATE_LIMIT_MAX` | dashboard 后端限流上限 | `100` |
| `DASHBOARD_RATE_LIMIT_WINDOW` | dashboard 后端限流窗口（秒） | `60` |
| `PLUGIN_SNAPSHOT_URL` | dashboard 访问插件 snapshot 的地址 | `http://127.0.0.1:7423` |
| `REQUIRE_DASHBOARD_AUTH` | 严格模式：未配置 `DASHBOARD_AUTH` 拒绝启动 | 无 |
| `SNAPSHOT_ALLOWED_IPS` | snapshot server IP 白名单 | `127.0.0.1,::1,::ffff:127.0.0.1` |
| `SNAPSHOT_RATE_LIMIT_MAX` | snapshot server 限流上限 | `60` |
| `SNAPSHOT_RATE_LIMIT_WINDOW` | snapshot server 限流窗口（秒） | `60` |
| `SNAPSHOT_SHUTDOWN_TOKEN` | `/internal/shutdown` 鉴权 token | 无 |
| `NEO4J_URI` | Neo4j 连接 URI | - |
| `NEO4J_USER` | Neo4j 用户名 | - |
| `NEO4J_PASSWORD` | Neo4j 密码 | - |

> **注意**：snapshot server 端口由 `openclaw.json` 的 `dashboardSnapshot.port` 配置控制，**不**受环境变量影响。

---

## 配置示例（完整）

```json
{
  "plugins": {
    "lcm-graph-extra": {
      "summaryStrategy": "strategy",
      "maxGraphDepth": 10,
      "logging": { "level": "info" },
      "neo4j": {
        "uri": "bolt://localhost:7687",
        "user": "neo4j",
        "password": "your-password"
      },
      "lcmMonitor": {
        "enabled": true,
        "contextWindow": 262144,
        "proactiveThreshold": 0.65
      },
      "moa": {
        "enabled": true,
        "complexityThreshold": 0.6,
        "mode": "parallel",
        "referenceModels": [
          {
            "provider": "ollama",
            "model": "qwen3.6:27b",
            "temperature": 0.7,
            "systemPrompt": "你是一位代码架构专家。",
            "timeoutMs": 900000
          },
          {
            "provider": "ollama",
            "model": "qwen3.6:27b",
            "temperature": 0.5,
            "systemPrompt": "你是一位安全专家。",
            "timeoutMs": 900000
          }
        ],
        "aggregatorModel": {
          "provider": "ollama",
          "model": "qwen3.6:27b",
          "temperature": 0.3,
          "timeoutMs": 1200000
        },
        "enabledTiers": ["low"],
        "activePreset": "code-review"
      },
      "experience": {
        "enabled": true,
        "triggers": ["correction", "failure", "fix_success"]
      },
      "dashboardSnapshot": {
        "enabled": true,
        "port": 7423
      }
    }
  }
}
```