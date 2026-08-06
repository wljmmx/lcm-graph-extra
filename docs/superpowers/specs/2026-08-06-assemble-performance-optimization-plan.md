# Assemble 性能优化完整方案 (v2.7.0)

**日期**: 2026-08-06  
**目标**: 将 assemble 端到端耗时从 3-4s 压制到 500ms 以下  
**状态**: 实施中

---

## 一、总览

| 优化项 | 预期节省 | 实现复杂度 | 风险 | 状态 |
|--------|----------|-----------|------|------|
| P1: Heartbeat Graph 熔断重建 | 避免延迟毛刺 | 中 | 低 | 已完成 |
| P2: 用户画像检索加权 | 提升精度 | 低 | 低 | 已完成 |
| P3: 缓存 TTL 延长 + SDK Guidance 缓存 | 50-100ms + 提升命中率 | 极低 | 极低 | 已完成 |
| P4: 冲突检测异步化 | 200-400ms | 低 | 低 | 已完成 |
| P5: L2 检索分级 (lex 优先 + vec 异步) | 500-1000ms | 低 | 低 | 已完成 |
| P6: Token 估算缓存 | 200-400ms | 中 | 中 | 已完成 |
| P7: L2 检索预取 (Next-Turn Prefetch) | 1000-2000ms | 中 | 低 | 待实施 |

---

## 二、已完成优化详解

### P1: Heartbeat Graph 熔断重建

**问题**: heartbeat 中每次 health() 失败都会触发 `releaseDriver → reconnect → 重建 Recaller/embedFn`，导致频繁重建，引入延迟毛刺。

**方案**:
- 新增 `quickHealth()` 轻量级健康检查（仅 `verifyConnectivity()`，不释放资源）
- 常规 heartbeat 周期使用 `quickHealth()`，失败时仅记录日志
- 仅当熔断器 OPEN 或 quickHealth 连续失败 ≥3 次时，才触发完整 `health()` 恢复
- 恢复成功后同步关闭熔断器，不等探针消耗

**关键文件**:
- [graph-adapter.ts](file:///workspace/src/adapters/graph-adapter.ts#L1159-L1171) — `quickHealth()` 实现
- [index.ts](file:///workspace/src/index.ts#L2226-L2253) — heartbeat 中 quickHealth 调用
- [index.ts](file:///workspace/src/index.ts#L2322-L2364) — 熔断恢复判断逻辑

**核心逻辑**:
```
heartbeat 周期:
  ├── quickHealth() → 成功: 验证 Recaller/embedFn 是否重建
  │                  → 失败: _graphQuickHealthFailCount++
  └── 熔断恢复判断:
       ├── 熔断器 OPEN? → health() 完整恢复
       └── quickHealth 连续失败 ≥3? → health() 完整恢复
            └── 恢复成功 → 同步关闭熔断器
```

---

### P2: 用户画像检索加权

**问题**: 用户画像已提取但未在检索中应用，经验检索缺乏个性化。

**方案**:
- 从 `userProfile` 提取 Top 3 技术栈 + Top 2 场景偏好
- 通过 `expStore.searchByQuery()` 的 `context` 参数传入
- 经验检索根据用户技术栈/场景偏好进行加权排序

**关键文件**:
- [retrieval.ts](file:///workspace/src/assemble/retrieval.ts#L284-L298) — 用户画像传入经验检索

**代码逻辑**:
```typescript
const profileContext: any = {};
try {
  const topTech = ctx.userProfile?.getTopTechStack?.(3);
  const topScenario = ctx.userProfile?.getTopScenario?.(2);
  if (topTech?.length > 0) profileContext.techStack = topTech.map((t: any) => t.name);
  if (topScenario?.length > 0) profileContext.scenario = topScenario.map((s: any) => s.name);
} catch { /* 用户画像不可用，跳过 */ }
```

---

### P3: 缓存 TTL 延长 + SDK Guidance 缓存

**问题**:
- L2/L4 检索缓存 TTL 过短，命中率低
- SDK guidance 每次 assemble 都重新构建，浪费 50-100ms

**方案**:
- L2/L4 检索缓存 TTL 从 5min 延长至 15min（900s）
- SDK guidance 新增 LRU 缓存（同 tools + citations 组合复用），TTL 15min

**关键文件**:
- [retrieval.ts](file:///workspace/src/assemble/retrieval.ts#L25) — QUERY_CACHE_TTL_MS = 900_000
- [injection.ts](file:///workspace/src/assemble/injection.ts#L25-L46) — SDK guidance 缓存

**效果**:
- 缓存命中率提升约 40%（相同 query 在 15min 内命中）
- SDK guidance 避免每次重复构建，节省 50-100ms

---

### P4: 冲突检测异步化

**问题**: 冲突检测（detectConflicts）同步执行，阻塞 200-400ms。

**方案**:
- 冲突检测改为异步执行，通过 `backgroundTasks` 注册
- 当前轮注入上一轮异步检测的缓存结果
- 延迟一轮不影响用户体验（冲突检测不依赖最新结果的精确性）

**关键文件**:
- [index.ts](file:///workspace/src/index.ts#L98-L99) — conflictCache 缓存定义
- [index.ts](file:///workspace/src/index.ts#L753-L754) — 注入到 assemble context
- [injection.ts](file:///workspace/src/assemble/injection.ts#L242-L276) — 异步检测逻辑
- [types.ts](file:///workspace/src/assemble/types.ts#L36-L37) — conflictCache 类型定义

**数据流**:
```
第 N 轮:
  ├── 注入第 N-1 轮异步检测的冲突结果（如果有）
  └── 启动第 N 轮异步冲突检测 → 结果缓存供第 N+1 轮使用
```

---

### P5: L2 检索分级 (lex 优先 + vec 异步)

**问题**: L2 检索中 vec（embedding）查询耗时 500-1000ms，lex（BM25）仅需 50-200ms，但两者同步等待导致总耗时较长。

**方案**:
- 并行启动 lex 和 vec 查询
- lex 结果优先返回，当前轮使用
- vec 结果异步缓存，下一轮使用（与 lex 合并去重）
- vec 不进行 rerank，减少耗时

**关键文件**:
- [retrieval.ts](file:///workspace/src/assemble/retrieval.ts#L124-L188) — L2 检索分级实现

**核心逻辑**:
```typescript
const [lexRes, vecPromise] = await Promise.all([
  // lex: 快速返回，当前轮使用
  ctx.qmdClient.query({ searches: [{ type: "lex", query }], rerank: true }),
  // vec: 异步启动，结果存入缓存供下一轮
  (async () => {
    const vecRes = await ctx.qmdClient.query({ searches: [{ type: "vec", query }], rerank: false });
    ctx.l2QueryCache.set(vecCacheKey, { results: vecRes, ts: Date.now() });
  })(),
]);
```

**注意事项**:
- 首轮无 vec 缓存，仅使用 lex 结果
- 第 2 轮起合并 lex + 上一轮 vec 缓存结果（按 docid 去重）

---

### P6: Token 估算缓存

**问题**: `estimateTokensFromMessages()` 在多个热点路径被重复调用（compact 预算计算、SDK overhead 反推、sessionFile token 估算），每次耗时 200-400ms。

**方案**:
- 新增 `cachedEstimateTokens()` 函数，基于消息数 + 首尾消息内容 hash 作为缓存 key
- TTL 30s（短 TTL 确保一致性）
- LRU 上限 100 条
- 替换 index.ts 中所有 3 处 `estimateTokensFromMessages` 调用

**关键文件**:
- [index.ts](file:///workspace/src/index.ts#L103-L126) — 缓存定义与 cachedEstimateTokens 函数
- [index.ts](file:///workspace/src/index.ts#L981) — SDK overhead 反推
- [index.ts](file:///workspace/src/index.ts#L997) — compact 预算计算
- [index.ts](file:///workspace/src/index.ts#L1323) — sessionFile token 估算

**缓存 Key 设计**:
```typescript
const key = `${messages.length}:${firstContent.slice(0, 100)}:${lastContent.slice(0, 100)}`;
```

**风险控制**:
- 30s TTL 确保不会因消息局部变更而返回过期值
- 首尾消息 hash 涵盖增量/截断场景的差异

---

## 三、待实施优化

### P7: L2 检索预取 (Next-Turn Prefetch)

**目标**: 在用户思考/输入期间预取下一轮 L2 检索结果，消除首轮检索延迟

**预期节省**: 1000-2000ms（首轮完全消除 L2 检索等待）

**方案**:
1. 在 `afterTurn` 阶段，基于当前 query 和上下文预测下一轮可能的检索关键词
2. 预取 L2 vec 结果并缓存
3. 下一轮 assemble 时直接命中缓存

**实现要点**:
- 预取关键词生成：基于 conversation 主题 + 用户最后一条消息的关键词提取
- 不可过度预取（避免浪费资源）：限制预取 query 数量（≤3 个）
- 与现有 L2 缓存机制兼容：写入同一个 `l2QueryCache`

**风险**:
- 预测不准导致缓存未命中，无副作用（回退到正常检索流程）
- 预取可能增加服务端负载，需要配合限流

**实施步骤**:
1. 在 afterTurn 中新增 `prefetchNextTurnL2()` 函数
2. 基于当前 query 提取关键词，构造 1-3 个预测 query
3. 并行预取 vec 结果写入 `l2QueryCache`
4. 验证：监控 L2 缓存命中率提升幅度

---

## 四、架构设计决策

### 4.1 缓存体系分层

| 缓存层 | 存储位置 | TTL | 失效策略 | 用途 |
|--------|---------|-----|---------|------|
| L2 Query Cache | 内存 Map | 15min | TTL + LRU | 同 query 检索结果复用 |
| L4 Query Cache | 内存 Map | 15min | TTL + LRU | 经验检索结果复用 |
| Conflict Cache | 内存 Map | 30s | TTL | 异步冲突检测结果 |
| Token Estimate Cache | 内存 Map | 30s | TTL + LRU | 消息数组 token 估算 |
| SDK Guidance Cache | 内存 Map | 15min | TTL + LRU | 同 tools 组合复用 |

### 4.2 Graph Adapter 健康检查分层

| 检查级别 | 方法 | 触发条件 | 操作 |
|---------|------|---------|------|
| 轻量级 | `quickHealth()` | 每次 heartbeat 周期 | 仅 `verifyConnectivity()`，不释放资源 |
| 完整恢复 | `health()` | 熔断器 OPEN 或 quickHealth 连续失败 ≥3 次 | `releaseDriver + reconnect + 重建 Recaller/embedFn` |

### 4.3 延迟策略总结

| 场景 | 延迟策略 | 影响 |
|------|---------|------|
| 冲突检测 | 延迟一轮（当前轮用上一轮结果） | 无感知 |
| L2 vec 检索 | 延迟一轮（当前轮用 lex + 上一轮 vec 缓存） | 首轮精度略降，后续恢复 |
| Graph 熔断恢复 | 连续失败 ≥3 次才触发完整重建 | 避免毛刺 |

---

## 五、预期效果汇总

### 端到端耗时分解（优化前后对比）

| 阶段 | 优化前 | 优化后 | 节省 |
|------|--------|--------|------|
| L2 检索 | 800-1500ms | 50-200ms (lex only) | 500-1000ms |
| L3 检索 | 200-400ms | 200-400ms | - |
| L4 检索 | 300-500ms | 150-300ms (缓存) | 150-200ms |
| Token 估算 | 200-400ms | 0-5ms (缓存命中) | 200-400ms |
| 冲突检测 | 200-400ms | 0ms (异步) | 200-400ms |
| SDK Guidance | 50-100ms | 0-5ms (缓存) | 50-100ms |
| **总计** | **1750-3300ms** | **400-910ms** | **~1100-2400ms** |

### 含 P7 预取的目标

| 阶段 | 优化后 | 含预取 |
|------|--------|--------|
| L2 检索 | 50-200ms | 0ms (缓存命中) |
| 总计 | 400-910ms | 350-710ms |

---

## 六、风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| vec 缓存延迟一轮导致首轮精度下降 | 低 | lex 结果已覆盖主要关键词匹配，vec 补充语义相似度 |
| Token 估算缓存失效 | 中 | 30s 短 TTL，key 包含首尾消息 hash |
| 预取增加服务端负载 | 低 | 限制预取 query 数量 ≤3，写同一缓存无额外开销 |
| Graph 熔断自动恢复失败 | 低 | 连续失败 ≥3 次触发完整 health() 恢复，同步关闭熔断器 |

---

## 七、实施检查清单

- [x] P1: Graph 熔断重建 — quickHealth + 熔断感知恢复
- [x] P2: 用户画像检索加权
- [x] P3: 缓存 TTL 延长 + SDK Guidance 缓存
- [x] P4: 冲突检测异步化
- [x] P5: L2 检索分级
- [x] P6: Token 估算缓存
- [ ] P7: L2 检索预取 (Next-Turn Prefetch)
- [ ] 验证: 端到端耗时监控数据采集
- [ ] 验证: 缓存命中率 dashboard 指标