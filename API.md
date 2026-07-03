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

> 注：本插件实现 `ingest / ingestBatch / assemble / afterTurn / compact / maintain / dispose` 七个钩子。
> `bootstrap` 未作为顶层钩子暴露；afterTurn 内部通过 `lossless-claw-adapter.ensureBootstrapped()` 自动确保会话已 bootstrapped。
> `compact` 与 `maintain` 委托给 lossless-claw adapter；`assemble` 由本插件**自行实现**，仅借用 adapter 做 pressure-triggered compaction 与 conversationStore 查询。

#### `ingest({ sessionId, message, isHeartbeat })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `sessionKey` | `string` (optional) | 会话密钥 |
| `message` | `{ role, content }` | 消息对象（content 支持字符串或 rich-text 数组，会被归一化为字符串） |
| `isHeartbeat` | `boolean` (optional) | 是否为心跳消息 |

操作：
- 转发给 lossless-claw adapter 的 `ingest` 写入会话 DAG（实际存储由 lossless-claw 处理）

返回: `{ ingested: boolean }`

#### `ingestBatch({ sessionId, messages, isHeartbeat })`

批量版本，参数同 `ingest` 但 `messages` 为数组。返回 `{ ingestedCount: number }`。

---

#### `assemble({ sessionId, messages, prompt, tokenBudget })`

> **由 lcm-graph-extra 自行实现**（不委托 lossless-claw）。
> 详见下方[完整 assemble 文档](#assemble-完整流程)。

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `messages` | `unknown[]` | 当前会话消息 |
| `prompt` | `string` | 用户 prompt |
| `tokenBudget` | `number` | token 预算 |

简要流程：
1. 压力分级（`resolveContextProfile` + `determinePressureTier`）确定 contextWindow/tier
2. 并行检索：`RetrievalGateway.search(query)` 编排 qmd + graph + experience
3. `Merger.merge()` 实体级去重 + 衰减排序
4. `buildMemorySystemPromptAddition` 注入 `systemPromptAddition`
5. `applyTotalControl` 按 section 优先级 trim 到 maxContextChars
6. 压力响应：medium/high tier 时触发 lossless-claw `compact`（仅借调，非主体）

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
2. 写入压缩信号到 `conversation_compaction_maintenance` 表（触发后台 DAG 压缩）
3. 委托给 `_losslessClawAdapter.compact()` 执行实际 DAG 压缩与 LLM 摘要（带 15min 超时，可由 `LCM_GRAPH_EXTRA_COMPACT_TIMEOUT_MS` 覆盖）
4. AbortSignal 支持：信号触发立即返回 `{ ok: false, reason: 'aborted' }`

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
- 自动确保会话已 bootstrap（`_losslessClawAdapter.ensureBootstrapped()`）
- 委托给 lossless-claw 的 `afterTurn` 持久化会话状态
- 质量过滤：跳过 user/assistant 内容过短或词密度过低的低信号轮次
- 三元组抽取（fire-and-forget）：`graphAdapter.extractAndUpsertFromTurn()` 用 LLM 从对话抽取实体/关系写入 Neo4j，带 `tripletTimeoutMs`（默认 8000ms）超时
- 响应 token 跟踪：`tracker.onResponseReceived()` 记录模型用量（非阻塞）

---

#### `maintain({ sessionId, sessionFile })`

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `sessionFile` | `string` | 会话文件路径 |
| `sessionKey` | `string` (optional) | 会话密钥 |
| `runtimeContext` | `Record<string, unknown>` (optional) | 运行时上下文 |

操作：
- 委托给 lossless-claw adapter 的 `maintain` 执行 DAG 清理、碎片整理
- 本地：`evictStaleDedup()` 清理过期的跨轮去重缓存（LRU，TTL 1h）

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

#### `assemble` 完整流程

> **重要**：`assemble` 由 lcm-graph-extra **自行实现**，不调用 lossless-claw 的 assemble。
> lossless-claw adapter 在此路径仅用于：(1) 压力分级时触发 `compact`；(2) 查询 `getConversationStore` 判断是否已 bootstrap。
> 消息拼装与 `systemPromptAddition` 注入完全由本插件完成。

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 会话 ID |
| `sessionKey` | `string` (optional) | 会话密钥 |
| `messages` | `unknown[]` | 当前会话消息 |
| `tokenBudget` | `number` (optional) | token 预算 |
| `prompt` | `string` (optional) | 用户 prompt |
| `model` | `string` (optional) | 使用的模型（用于查 modelRegistry 解析 contextWindow） |
| `availableTools` | `string[] \| Set<string>` (optional) | 可用工具列表，影响检索策略 |
| `runtimeContext` | `Record<string, unknown>` (optional) | 运行时上下文 |
| `abortSignal` | `AbortSignal` (optional) | 取消信号，已取消时立即返回空 |

操作流程：
1. **L0 压力分级** — `resolveContextProfile` + `determinePressureTier` 计算 `contextWindow` / `tier`（low/medium/high）与检索配额
2. **L1 摘要注入** — 直接读 lcm.db 的 `getConversationSummaries()`（不走 adapter）
3. **L2~L4 并行检索** — `RetrievalGateway.search(query)` 编排：
   - L2 qmd: `QmdClient.query()` (MCP 优先，CLI 降级)
   - L3 graph: `GraphAdapter.search()` (Recaller 双路径召回)
   - L4 experience: `ExperienceStorage.searchByQuery()` (查询感知混合搜索)
4. **Merger 合并** — `Merger.merge()` 实体级去重 + 时间衰减 + 优先级排序
5. **systemPromptAddition 注入** — `buildMemorySystemPromptAddition`（SDK 提供）把检索结果格式化注入
6. **总量控制** — `applyTotalControl` 按 section 优先级（工具指引 > 记忆文件 > 知识图谱 > 经验 > 完整文档）trim 到 `maxContextChars`
7. **压力适配裁剪** — 当 `totalEst > contextWindow * 0.85` 时，从非 system 消息头部移除直到达标
8. **压力响应 compaction**（仅 medium/high tier）— 借调 `_losslessClawAdapter.compact(...)` 触发后台压缩并写入 compaction debt
9. **跨轮去重** — `sessionDedupCache` (LRU 500 sessions × 24 rounds) 抑制重复检索结果

返回:
```typescript
{
  messages: unknown[];                           // 组装后的消息列表
  estimatedTokens: number;                       // 估算的 token 数
  systemPromptAddition?: string;                 // 系统提示词补充（含检索结果）
  contextProjection?: {                          // 上下文投影信息
    mode: "per_turn" | "thread_bootstrap";
    epoch?: string;
    fingerprint?: string;
  };
  // 以下为调试/审计字段（非 SDK 契约，便于排查）
  promptAuthority?: "assembled" | "preassembly_may_overflow";
}
```

---

#### `dispose()`

清理：
- 停止 debt scheduler（`stopScheduler()`，等待活跃任务完成）
- 清除心跳定时器（`hbTimer`）
- 关闭 GraphAdapter（释放 driver pool）
- 关闭 UsageTracker
- 关闭 Neo4j driver（`closeNeo4jDriver()`）
- 重置单例状态，允许下次 init 重新初始化

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
| `QmdClient` | `src/qmd-client.ts` | qmd 搜索客户端（MCP REST 优先，CLI 降级，自动恢复） |
| `GraphAdapter` | `src/adapters/graph-adapter.ts` | graph-memory-pro 桥接（Recaller + upsertEntities + detectCommunities + mergeNodes） |
| `RetrievalGateway` | `src/retrieval-gateway.ts` | 并行检索编排 + 性能监控 + 经验检索 |
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
