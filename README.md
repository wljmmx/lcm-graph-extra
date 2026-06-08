# lcm-graph-extra

**双引擎检索上下文引擎** — 协调 LCM（lossless-claw）的全文无损能力与 graph-memory-pro 的知识图谱增强检索。

## 概述

lcm-graph-extra 是一个 OpenClaw `kind: "context-engine"` 插件，作为 **检索网关调度层**：

- **不修改**上游组件（LCM、qmd、graph-memory-pro）源码
- 通过 **适配器** 调用各引擎能力
- 在 `assemble()` 阶段并行检索 qmd + graph-memory-pro
- 通过 **实体级去重** 合并异构结果
- 通过 **历史经验检索** 关联过往 Bug 与修复方案

## 架构

```
用户消息 → ingest()
  ├── LCM DB 持久化
  └── [可选] 异步抽取 → graph-memory-pro Extractor → Neo4j

LLM 调用 → assemble()
  ├── qmd search       ← BM25 全文搜索
  ├── Recaller.recall() ← 知识图谱双路径召回
  ├── experience search ← 历史 Bug + SOLVED_BY 链
  ├── Merger → 实体去重 + 衰减 + 排序
  └── systemPromptAddition → LLM
```

## 安装

### 前置依赖

| 组件 | 版本要求 | 说明 |
|------|---------|------|
| OpenClaw | ≥ 2026.3.24-beta.2 | Plugin SDK |
| lossless-claw | ≥ 0.11.3 | LCM 插件 |
| graph-memory-pro | ≥ 1.5.8 | Neo4j 图谱插件 |
| qmd | ≥ 2.5.3 | BM25 全文搜索引擎 |
| Neo4j | ≥ 5.x | 图谱数据库 |
| Node.js | ≥ 22 | 运行环境 |

### 安装步骤

```bash
# 1. 克隆/复制插件到 workspace
cp -r lcm-graph-extra ~/.openclaw/workspace/main/

# 2. 安装依赖
cd ~/.openclaw/workspace/main/lcm-graph-extra
npm install

# 3. 构建
npm run build
```

### 配置

在 `~/.openclaw/openclaw.json` 中手工添加：

```json5
{
  plugins: {
    slots: {
      contextEngine: "lcm-graph-extra" // 激活本插件
    },
    entries: {
      "lcm-graph-extra": {
        enabled: true,
        config: {
          neo4j: {
            uri: "bolt://localhost:37687",
            user: "neo4j",
            password: "your-password" // 与 graph-memory-pro 一致
          },
          retrieval: {
            qmd: { enabled: true, searchLimit: 5 },
            graph: { enabled: true, searchLimit: 5 },
            merger: {
              maxResults: 10,
              fuzzyMatchThreshold: 0.85,
              decayHalfLifeDays: 30 // 记忆半衰期（天）
            }
          },
          async: {
            extraction: {
              enabled: false, // 设为 true 开启自动实体抽取
              concurrency: 1,
              llm: {
                baseURL: "http://localhost:11434",
                model: "qwen3.6:27b"
              }
            }
          }
        }
      }
    }
  }
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GM_PRO_PATH` | `~/.openclaw/extensions/graph-memory-pro` | graph-memory-pro 插件路径 |

## 功能

### 双引擎检索

| 引擎 | 来源 | 检索方式 | 返回类型 |
|------|------|---------|---------|
| **qmd** | 全文索引 (BM25) | `qmd search` CLI | `raw`（原文片段） |
| **graph-memory-pro** | Neo4j 知识图谱 | `Recaller.recall()` 双路径召回 | `definition` / `relation` / `raw` |

### 实体级去重

跨引擎结果按实体名聚合：
1. **提取** — 从每条结果中提取实体名（graph 取节点名，qmd 取标题）
2. **归一化** — 小写 + 去除前缀
3. **模糊匹配** — Levenshtein 距离（阈值 0.75）
4. **合并** — 同一实体的 qmd + graph 结果合并为一条，双源优先

### 记忆衰减

`score_final = score × 0.5^(daysSinceUpdate / halfLifeDays)`

- 默认半衰期：**30 天**（与 OpenClaw 内置 temporalDecay 一致）
- 仅作用于 graph 引擎结果（有 `updatedAt` 时间戳）
- 配置：`retrieval.merger.decayHalfLifeDays`

### 历史经验检索

自动搜索 Neo4j 中 **EVENT 节点**（故障/Bug）+ **SOLVED_BY 关系**（修复方案），在 `assemble()` 中作为 `<historical_experience>` 独立段注入。

### 主动预防

在 `before_prompt_build` 钩子中（非 active context engine 时兜底），自动检测当前问题是否命中已知问题模式，注入预防提示。

### 实体抽取（可选）

开启 `async.extraction.enabled: true` 后：
1. 每个对话轮次后异步抽取实体三元组
2. 通过 graph-memory-pro 的 Extractor 识别 TASK/SKILL/EVENT
3. 写入 Neo4j（含冲突消解 + 归纳总结）
4. 熔断保护（连续 5 次失败冷却 5 分钟）

### 冲突消解

当同一实体名有多个版本时：
| 条件 | 策略 |
|------|------|
| 内容相同 | 合并 validatedCount |
| 更新且置信度高 | replace_with_new |
| 更新或置信度任一低 | keep_existing + 日志 |
| 所有冲突 | 记录到 `~/.openclaw/lcm-graph-extra/logs/conflicts.log` |

## 工具

### `lcmg_search`

```text
/lcmg_search query="TypeScript 类型系统"
```

双引擎搜索（qmd + graph），返回结构化结果。

### `lcmg_pin`

```text
/lcmg_pin name="TypeScript 类型系统"
```

标记实体为永久（不受衰减影响），存为 Neo4j `pinned: true`。

## 反馈闭环

| 时机 | 动作 | 目标 |
|------|------|------|
| 每 10 轮对话 | `processFeedback()` | 更新 Neo4j 实体权重 |
| 每次检索命中 | `recordRetrieval()` | LCM DB 热度计数 |
| 每 100 轮对话 | `stateStore.cleanup()` | 清理过期抽取状态 |
| compact() | 信号写入 + SDK 直调 | 触发 LCM DAG 压缩 |

## 性能数据

| 场景 | 延迟 | 条件 |
|------|------|------|
| 检索（不含 LLM 重排） | < 200ms | 双引擎并行 |
| LLM 重排模式 | < 2s | Top-K 精排 |
| 项目总代码 | ~3,360 行 TypeScript | ~24KB JS |

## 常见问题

**Q: 和 Active Memory 插件冲突吗？**
A: 不冲突。active-memory 使用 hidden untrusted prompt prefix（agent harness 层），lcm-graph-extra 使用 systemPromptAddition（系统提示词层），两者在不同的注入层工作。

**Q: 需要关闭 lossless-claw 吗？**
A: 不需要。lossless-claw 的工具（lcm_grep/lcm_describe/lcm_expand_query）和钩子（session_end/before_prompt_build）仍然工作。lcm-graph-extra 替换的是 context engine 角色。

**Q: 压缩如何处理？**
A: lcm-graph-extra 设置了 `ownsCompaction: true`（关闭 OpenClaw 内置压缩），`compact()` 通过信号写入 LCM DB 遥测表并尝试直调 lossless-claw 引擎触发 DAG 压缩。

**Q: 是否支持团队协作？**
A: Neo4j 天然支持多用户并发访问。不同 agent 可配置独立的 Neo4j 连接指向同一图谱，实现知识共享。

## 许可证

MIT
