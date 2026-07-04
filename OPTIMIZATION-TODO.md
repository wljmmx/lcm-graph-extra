# lcm-graph-extra 优化清单

> 上次审计：2026-06-11 · 上次清理：2026-07-04（2.1.10）
>
> 历史条目（P0 fullDoc 截断 / P1 Merger 闲置 / P2 toolGuidance / P3 promptAuthority / P4 citationsMode / Step 4 全部硬编码）已在 2.1.10（commit d496fbd）落地，此文档仅保留未完成项。

---

## 🔴 P0: heartbeat fire-and-forget 任务无统一管理

### 现状

`runHeartbeat()` 与 `afterTurn()` 中存在 10 处 fire-and-forget 异步任务，全部用 `(async () => { ... })().catch(() => { /* swallowed */ })` 模式，没有任何引用持有这些 Promise。

| 位置 | 任务 | 风险 |
|------|------|------|
| index.ts heartbeat · runDistillation | 经验蒸馏（LLM 调用，可分钟级） | dispose 时仍在跑 → 写入已 dispose 的 expStore |
| index.ts heartbeat · N-3 EXPERIENCE TTL | 批量删除节点（最多 10 轮） | dispose 时仍在跑 → 调用已关闭的 graphAdapter |
| index.ts heartbeat · P0-2 Neo4j TTL | Cypher 衰减 + 清理 | 同上 |
| index.ts heartbeat · P0-3 debt reconcile | 债务表对账 | dispose 时仍在跑 → 写入已关闭的 DB |
| index.ts afterTurn · G-8 LLM 验证 | 5s 超时 LLM 调用 | 跨轮触发 → 可能 mutate 已被下一轮修改的 qualityScore |
| index.ts afterTurn · S-9' topic-shift compact | 触发 lossless-claw compact | 与下一轮 assemble 竞态 |
| index.ts afterTurn · triplet 提取 | 8s 超时 LLM 提取 | 与 dispose 竞态 |
| index.ts dispose · stopScheduler | 停止债务调度器 | dispose 自己又起 fire-and-forget，进程可能先退出 |
| index.ts dispose · closeNeo4jDriver | 关闭 driver 池 | 同上 |
| index.ts dispose · graphAdapter.close | 关闭图谱适配器 | 同上 |

### 核心问题

1. **dispose 不等待在途任务**：只清 `hbTimer`，已执行中的 `runHeartbeat()` 继续跑，可能写入已关闭的 DB / 调用已 dispose 的 graphAdapter
2. **dispose 自己又起了 3 个 fire-and-forget**：进程可能在它们完成前就退出
3. **无任务追踪**：所有 fire-and-forget 都是独立 Promise，无人持有引用
4. **跨轮竞态**：afterTurn 的 G-8 / S-9' / triplet 可能 mutate 下一轮 assemble 读到的状态

### 优化方案

引入轻量级 `BackgroundTaskRegistry`（单文件，不引入新依赖）：

```typescript
// src/async/task-registry.ts
class BackgroundTaskRegistry {
  private tasks = new Set<{ name: string; promise: Promise<void> }>();
  private shuttingDown = false;

  /** 注册 fire-and-forget 任务，自动捕获错误并追踪引用 */
  register(name: string, promise: Promise<any>): void {
    if (this.shuttingDown) return; // 关闭中拒绝新任务
    const tracked = { name, promise: promise.then(() => {}, () => {}) };
    this.tasks.add(tracked);
    tracked.promise.finally(() => this.tasks.delete(tracked));
  }

  /** dispose 时调用：等待所有在途任务完成（带超时） */
  async awaitAll(timeoutMs = 5000): Promise<void> {
    this.shuttingDown = true;
    if (this.tasks.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.tasks].map(t => t.promise)),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  }

  get pendingCount(): number { return this.tasks.size; }
  get pendingNames(): string[] { return [...this.tasks].map(t => t.name); }
}
export const backgroundTasks = new BackgroundTaskRegistry();
```

### 改造点（按风险排序）

| 优先级 | 改造点 | 做法 |
|--------|--------|------|
| P0 | heartbeat 4 处 `(async () => {...})().catch(...)` | 改为 `backgroundTasks.register('hb:distillation', (async () => {...})())` |
| P0 | dispose 顺序 | 先 `await backgroundTasks.awaitAll(5000)` 等待在途任务，再关 DB/driver |
| P1 | afterTurn G-8 / S-9' / triplet | 改为 `backgroundTasks.register('afterturn:g8', ...)` |
| P1 | dispose 自己起的 3 个 async 任务 | 也 register，但 awaitAll 时会包含它们 |
| P2 | assemble 内的 compact fire-and-forget（L743/778/839） | 暂不动（请求路径上，自然完成） |

### 不做的事

- 不引入真正的任务取消（AbortController 已在 compact 中使用）
- 不重构所有 `.catch(() => {})`（请求路径上的 fire-and-forget 是合理的）
- 不持久化任务状态（重启即丢失是可接受的）

### 验证

- `tsc --noEmit` 通过
- `vitest run` 全部通过
- dispose 时 `backgroundTasks.pendingCount` 应快速降到 0（5s 超时内）
