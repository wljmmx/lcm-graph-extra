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

> 注：本插件实现 `ingest / assemble / afterTurn / compact / maintain / dispose` 六个钩子。
> `bootstrap` 未单独实现，afterTurn 内部自动确保会话已 bootstrapped。

#### `ingest({ sessionId, message, isHeartbeat })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `message` | `{ role, content }` | 消息对象 |
| `isHeartbeat` | `boolean` | 是否为心跳消息 |

操作：
1. 写入 LCM DB（lossless-claw 适配器）
2. [可选] 触发异步实体抽取

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

#### `compact({ sessionId, force, tokenBudget, currentTokenCount, compactionTarget })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `sessionKey` | `string` (optional) | 会话密钥 |
| `sessionFile` | `string` | 会话文件路径 |
| `force` | `boolean` | 是否强制压缩 |
| `tokenBudget` | `number` (optional) | token 预算 |
| `currentTokenCount` | `number` (optional) | 当前 token 数 |
| `compactionTarget` | `'budget' \| 'threshold'` | 压缩目标类型 |
| `customInstructions` | `string` (optional) | 自定义指令 |

操作：
1. 计算未压缩 token 数
2. 写入压缩信号到 `conversation_compaction_telemetry` 表
3. [尝试] 通过 `resolveContextEngine` SDK 直调 lossless-claw 引擎

**重要**: `ownsCompaction: true` — 关闭 OpenClaw 内置 auto-compaction

返回:
```typescript
{
  ok: boolean;                          // 操作是否成功
  compacted: boolean;                   // 是否实际执行了压缩
  reason?: string;                      // 压缩结果说明
  summaryId?: string;                   // 生成的摘要 ID
  summary?: string;                     // 摘要内容
  error?: string;                       // 错误信息（如有）
  result?: {                            // 详细结果
    actionTaken: boolean;
    tokensBefore: number;
    tokensAfter: number;
    condensed: boolean;
    createdSummaryId?: string;
    summary?: string;
  };
  exhausted?: boolean;                  // 是否已用尽压缩空间
}
```

---

#### `afterTurn({ sessionId, messages, prePromptMessageCount })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `sessionKey` | `string` (optional) | 会话密钥 |
| `sessionFile` | `string` | 会话文件路径 |
| `messages` | `unknown[]` | 当前会话消息 |
| `prePromptMessageCount` | `number` | 前置 prompt 消息数量 |
| `isHeartbeat` | `boolean` (optional) | 是否为心跳消息 |
| `tokenBudget` | `number` (optional) | token 预算 |

操作：
- 每 10 轮 → `processFeedback()` 更新 Neo4j 实体权重
- 每 50 轮 → `stateStore.cleanup()` 清理过期抽取状态
- 每 100 轮 → 归档可清理的旧记忆
- 委托给 lossless-claw 的 `afterTurn` 处理会话状态

---

#### `maintain({ sessionId, sessionFile })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `sessionFile` | `string` | 会话文件路径 |
| `sessionKey` | `string` (optional) | 会话密钥 |
| `runtimeContext` | `Record<string, unknown>` (optional) | 运行时上下文 |

操作：
- 委托给 lossless-claw 的 `maintain` 执行后台维护
- 包括 DAG 清理、碎片整理等操作

返回:
```typescript
{
  changed: boolean;           // 是否有变更
  bytesFreed: number;        // 释放的字节数
  rewrittenEntries: number;  // 重写的条目数
  reason?: string;           // 操作说明
}
```

---

#### `assemble({ sessionId, messages, tokenBudget })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `sessionKey` | `string` (optional) | 会话密钥 |
| `messages` | `unknown[]` | 当前会话消息 |
| `tokenBudget` | `number` (optional) | token 预算 |
| `prompt` | `string` (optional) | 用户 prompt |
| `model` | `string` (optional) | 使用的模型 |
| `runtimeContext` | `Record<string, unknown>` (optional) | 运行时上下文 |

操作：
- 委托给 lossless-claw 的 `assemble` 组装会话上下文
- 进行消息归一化和 token 估算

返回:
```typescript
{
  messages: unknown[];                           // 组装后的消息列表
  estimatedTokens: number;                       // 估算的 token 数
  systemPromptAddition?: string;                 // 系统提示词补充
  contextProjection?: {
    mode: "per_turn" | "thread_bootstrap";
    epoch?: string;
    fingerprint?: string;
  };
}
```

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
| `id` | `string` (required) | 要标记的节点 ID |
| `unpin` | `boolean` (optional) | 设为 true 则取消标记（默认 false） |

将指定节点标记为 `pinned: true`，不参与 TTL 记忆衰减。

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
| `GraphAdapter` | `src/adapters/graph-adapter.ts` | graph-memory-pro 桥接（Recaller + upsertEntities + detectCommunities + mergeNodes） |
| `RetrievalGateway` | `src/retrieval-gateway.ts` | 并行检索编排 + 经验检索 |
| `Merger` | `src/merger.ts` | 实体级去重 + 衰减 + 排序 |
| `EntityExtractor` | `src/entity-extractor.ts` | 实体名提取 + 归一化 + Levenshtein 匹配 |
| `LcmBridge` | `src/lcm-bridge.ts` | LCM DB 读写 + 压缩信号 |
| `ConflictLogger` | `src/async/conflict-logger.ts` | 冲突消解 + 日志 |
| `UsageTracker` | `src/async/usage-tracker.ts` | Token 用量追踪 + 成本统计 |

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
