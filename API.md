# lcm-graph-extra API Reference

## 插件入口

### `definePluginEntry({...})`

**路径**: `index.ts` → `export default definePluginEntry({...})`

使用 OpenClaw Plugin SDK 的 `definePluginEntry` 模式注册插件。

| 属性 | 值 | 说明 |
|------|-----|------|
| `id` | `"lcm-graph-extra"` | 插件 ID |
| `name` | `"LCM Graph Extra"` | 插件名称 |
| `kind` | `"context-engine"` | 插件类型 |

### 生命周期钩子

#### `bootstrap({ sessionId })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |

初始化操作：
- 连接 LCM DB（`lcm-store.ts`）
- 连接 Neo4j（`graph-adapter.ts`）
- 检查 qmd CLI 可用性
- 恢复持久化状态（`state-store.ts`）

返回: `{ bootstrapped: boolean }`

---

#### `ingest({ sessionId, message, isHeartbeat })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `message` | `{ role, content }` | 消息对象 |
| `isHeartbeat` | `boolean` | 是否为心跳消息 |

操作：
1. 写入 LCM DB（`lcmStore.insertMessage()`）
2. [可选] 触发异步抽取（`scheduleExtraction()`）

返回: `{ ingested: boolean }`

---

#### `assemble({ sessionId, messages, prompt, tokenBudget })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `messages` | `unknown[]` | 当前会话消息 |
| `prompt` | `string` | 用户 prompt |
| `tokenBudget` | `number` | token 预算 |

操作：
1. 从 prompt 提取搜索查询
2. 并行调用 `searchWithExperience(query)`：
   - `qmdAdapter.search()` — BM25 全文
   - `graphAdapter.search()` — Recaller 双路径召回
   - `graphAdapter.searchExperience()` — 历史 EVENT + SOLVED_BY
3. `Merger.merge()` — 实体级去重 + 衰减 + 优先级排序
4. 记录检索热度到 LCM DB
5. 构建 `<retrieval_context>` + `<historical_experience>` XML

返回: `{ messages, estimatedTokens, systemPromptAddition }`

---

#### `compact({ sessionId, force })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `force` | `boolean` | 是否强制压缩 |

操作：
1. 计算未压缩 token 数
2. 写入压缩信号到 `conversation_compaction_telemetry` 表
3. [尝试] 通过 `resolveContextEngine` SDK 直调 lossless-claw 引擎

**重要**: `ownsCompaction: true` — 关闭 OpenClaw 内置 auto-compaction

返回: `{ ok: boolean, compacted: boolean, reason: string }`

---

#### `afterTurn({ sessionId, messages })`

操作：
- 每 10 轮 → `processFeedback()` 更新 Neo4j 实体权重
- 每 50 轮 → `stateStore.cleanup()` 清理过期抽取状态
- 每 100 轮 → 归档可清理的旧记忆

---

#### `dispose()`

清理：
- 停止所有资源
- 刷新状态存储
- 关闭图数据库连接

## 注册的工具

### `lcmg_search`

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | `string` (required) | 搜索查询 |
| `limit` | `number` (optional) | 返回结果数上限 (max: 30) |

返回格式化搜索结果，来源标注为 `📄 Full-Text` 或 `🔗 Knowledge Graph`。

### `lcmg_pin`

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` (required) | 要标记的实体名 |
| `type` | `string` (optional) | 实体类型 (SKILL/TASK/EVENT) |

将指定实体标记为 `pinned: true`，不参与记忆衰减。

## 注册的钩子

### `before_prompt_build`

**作用**: 非 active context engine 模式下的兜底注入路径。

当 lcm-graph-extra 不是被选中的 context engine 时，通过此钩子仍然执行：
1. 经验检索（历史 EVENT + SOLVED_BY）
2. 注入 `<historical_experience>` 上下文

## 核心接口

### `RetrievalResult`

```typescript
interface RetrievalResult {
  id: string;                                // 内容哈希
  content: string;                           // 检索文本
  source: 'qmd' | 'graph';                  // 来源引擎
  type: 'definition' | 'relation' | 'raw';  // 类型
  score: number;                             // 相关性 (0-1)
  metadata: Record<string, unknown>;        // 元数据
}
```

### `LcmGraphExtraConfig`

```typescript
interface LcmGraphExtraConfig {
  neo4j: {
    uri: string;
    user: string;
    password: string;
  };
  retrieval: {
    qmd: { enabled: boolean; searchLimit: number };
    graph: { enabled: boolean; searchLimit: number };
    merger: {
      maxResults: number;
      fuzzyMatchThreshold: number;
      decayHalfLifeDays?: number;
    };
  };
  async: {
    extraction: {
      enabled: boolean;
      concurrency: number;
      batchSize?: number;
      llm?: LlmConfig;
    };
  };
}
```

## 内部模块

| 模块 | 文件 | 职责 |
|------|------|------|
| `QmdAdapter` | `src/adapters/qmd-adapter.ts` | qmd CLI 搜索适配器 |
| `GraphAdapter` | `src/adapters/graph-adapter.ts` | graph-memory-pro 桥接（Recaller + upsertEntities） |
| `RetrievalGateway` | `src/retrieval-gateway.ts` | 并行检索编排 + 经验检索 |
| `Merger` | `src/merger.ts` | 实体级去重 + 衰减 + 排序 |
| `EntityExtractor` | `src/entity-extractor.ts` | 实体名提取 + 归一化 + Levenshtein 匹配 |
| `LcmStore` | `src/lcm-store.ts` | LCM DB 读写 + 压缩信号 |
| `TaskQueue` | `src/async/task-queue.ts` | 后台异步任务队列 |
| `Extraction` | `src/async/extraction.ts` | LLM 实体抽取 + 熔断器 |
| `ConflictLogger` | `src/async/conflict-logger.ts` | 冲突消解 + 日志 |
| `Summarizer` | `src/async/summarizer.ts` | 实体归纳总结（≥5条LLM摘要合并） |
| `StateStore` | `src/async/state-store.ts` | 持久化抽取进度 |

## 配置格式

完整配置示例（JSON5 格式）：

```json5
{
  plugins: {
    slots: {
      contextEngine: "lcm-graph-extra"
    },
    entries: {
      "lcm-graph-extra": {
        enabled: true,
        config: {
          neo4j: {
            uri: "bolt://localhost:37687",
            user: "neo4j",
            password: "your-password"
          },
          retrieval: {
            qmd: { enabled: true, searchLimit: 5 },
            graph: { enabled: true, searchLimit: 5 },
            merger: {
              maxResults: 10,
              fuzzyMatchThreshold: 0.85,
              decayHalfLifeDays: 30
            }
          },
          async: {
            extraction: {
              enabled: false,
              concurrency: 1,
              batchSize: 5,
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

## 数据存储路径

| 数据 | 路径 | 说明 |
|------|------|------|
| LCM DB | `~/.openclaw/lcm.db` | 消息持久化 + DAG 摘要 |
| Neo4j | graph-memory-pro 配置 | 知识图谱 |
| qmd 索引 | `~/.qmd/` | BM25 全文索引 |
| 冲突日志 | `~/.openclaw/lcm-graph-extra/logs/conflicts.log` | JSONL 格式 |
| 抽取进度 | `~/.openclaw/lcm-graph-extra/state.json` | `lastExtractedSeq` |
| 归档记忆 | `~/.openclaw/lcm-graph-extra/archived_memory.json` | 清理前备份 |
