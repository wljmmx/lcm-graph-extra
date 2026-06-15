# lcm-graph-extra 问题总清单 (2026-06-11)

> 来源：Step 1-4 完整代码审计 + 合并去重
> 状态：待修复
---

## 🔴 Step 1: assemble() 数据流与逻辑问题（4个）

| ID | 问题 | 位置 | 严重度 |
|----|------|------|--------|
| ~~S1-1~~ | ~~Merger 实体去重类闲置未调用~~ → ✅ 已接入 entity-level dedup | index.ts (ensureInitialized + assemble) | 🟢 |
| S1-2 | P5 priority trim 顺序错误：记忆文件优先级最高(4)但最先被裁 | index.ts L95-140 | 🔴 |
| S1-3 | estimatedTokens 用 length/4 估算，不准确 | index.ts L608 | 🟡 |
| S1-4 | window monitor enabled 检查在 P3 之前，wm 可能为 undefined 导致短路 | index.ts L320 | 🟡 |

---

## 🔴 Step 2: P4/P5 数据流关系问题（5个）

| ID | 问题 | 位置 | 严重度 |
|----|------|------|--------|
| S2-1 | fullDoc 超过2000字符硬截断，无摘要保留 | index.ts L540 | 🔴 |
| S2-2 | lossless-claw summary (getSummaryStore) 从未被调用，summary记忆断层 | LosslessClawAdapter + index.ts | 🔴 |
| S2-3 | P4 中 qmdResults snippet 和 fullDocs 全文来自同一数据源，冗余注入浪费token | index.ts L518+L533 | 🔴 |
| S2-4 | applyTotalControl 的 section 分割依赖 emoji 标题匹配，Markdown格式变化即失效 | index.ts L72-92 | 🟡 |
| S2-5 | L2 snippet 和 fullDoc 可能重复（同文件出现两次），quickHash 不生效 | index.ts L470-560 | 🟡 |

---

## 🔴 Step 3: SDK 标准合规性问题（7个）

| ID | 问题 | 位置 | 严重度 |
|----|------|------|--------|
| S3-1 | toolGuidance 未用 SDK 标准方法 buildMemorySystemPromptAddition，工具名硬编码不跟随注册变化 | index.ts L156-175 | 🔴 |
| ~~S3-2~~ | ~~assemble() 返回结果缺少 promptAuthority 字段~~ | ✅ 已修复 (2026-06-16, commit 4edaf52) | 🟢 |
| S3-3 | citationsMode SDK 参数被忽略，未传入 buildMemorySystemPromptAddition | index.ts (全局) | 🟡 |
| S3-4 | tokenBudget SDK 参数被忽略，assemble 未根据 budget 裁剪消息 | index.ts (全局) | 🟡 |
| S3-5 | 手动消息归一化（content array→string）可能破坏 OpenClaw session pruning 内部管道 | index.ts L594-602 | 🟢 |
| S3-6 | estimatedTokens 用 length/4 粗略估算而非 tokencount API，影响 compaction 触发时机 | index.ts L620+L634 | 🟢 |
| S3-7 | fallback 异常路径返回 undefined systemPromptAddition，丢失已注入上下文 | index.ts L635 | 🟢 |

---

## 🔴 Step 4: 硬编码/魔术数字问题（10个）

### index.ts（6个）

| ID | 行号 | 魔术数字 | 含义 | 问题 |
|----|------|---------|------|------|
| S4-1 | L342 | `131072` | contextWindow 默认值 | 未跟随256K更新 | 🔴 |
| S4-2 | L347 | `6000` | maxContextChars low 默认 | 偏小，应提高 | 🟡 |
| S4-3 | L362-363 | `6000/3000` | low/medium tier 字符限制 | 同上 | 🟡 |
| S4-4 | L383 | `57344` | compactTokenBudget 默认值 | 128K时代的值，应为114688 | 🔴 |
| S4-5 | L540 | `2000` | fullDoc 截断阈值 | 与S2-1重复（保留以跟踪具体代码行） | 🔴 |
| S4-6 | L203 | `24` | MAX_DEDUP_ROUNDS | 去重窗口硬编码 | 🟡 |

### config.ts（1个）

| ID | 行号 | 魔术数字 | 含义 | 问题 |
|----|------|---------|------|------|
| S4-7 | L123 | `32768` | maxTokens 默认值 | **严重过时**，应为更高值 | 🔴 |

### hooks/session-created.ts（3个）

| ID | 行号 | 魔术数字 | 含义 | 问题 |
|----|------|---------|------|------|
| S4-8 | L104 | `10_000` | triggerThreshold | 128K时代的值，应翻倍 | 🔴 |
| S4-9 | L105 | `81_920` | softThresholdTokens | 128K时代的值，应翻倍 | 🔴 |
| S4-10 | L106 | `65_536` | keepRecentTokens | 128K时代的值，应翻倍 | 🔴 |

---

## 📊 最终问题汇总统计

| 类别 | 🔴 高 | 🟡 中 | 合计 |
|------|-------|-------|------|
| Step 1: 数据流逻辑 | 2 | 2 | **4** |
| Step 2: P4/P5关系 | **3** | **2** | **5** |
| Step 3: SDK合规性 | **2** | **2** | **7** (含3个🟢低风险) |
| Step 4: 硬编码/魔术数字 | **7** | **3** | **10** |
| **总计** | **14** 🔴 | **9** 🟡 + **3** 🟢 | **26** |

---

## 🔗 合并与去重说明

| 原始ID | 合并后ID | 原因 |
|--------|---------|------|
| S1-1 + S3-2 | **S1-1** | L2/L3无交叉去重 = Merger闲置未调用（现象+根因） |
| S4-5 | 保留但标注 | fullDoc截断阈值与S2-1是同一问题的代码级别跟踪 |

---

## 🔴 高优先级修复顺序建议（14个）

**第一批（快速修复，⚡小工作量）：**
| # | ID | 简述 |
|---|-----|------|
| 1 | S4-7/8/9/10 | compaction相关阈值翻倍 |
| 2 | S4-1 | contextWindow默认值更新 |
| 3 | S4-4 | compactTokenBudget默认值更新 |
| 4 | S3-2 | promptAuthority字段补全 |

**第二批（中等工作量，🔧）：**
| # | ID | 简述 |
|---|-----|------|
| 5 | S1-2 | P5 priority trim顺序修正 |
| 6 | S2-1/S4-5 | fullDoc截断优化（head-tail策略） |
| 7 | S2-3 | snippet+fullDoc冗余注入消除 |
| 8 | S3-1 | toolGuidance改用SDK标准方法 |

**第三批（大工作量，🛠️）：**
| # | ID | 简述 |
|---|-----|------|
| 9 | S1-1 | Merger集成到assemble() |
| 10 | S2-2 | lossless-claw summary注入 |

---

## ✅ 修正记录

| 时间 | 修正内容 |
|------|---------|
| 2026-06-16 02:45 | S2-3 hasFullDocs guard、S2-5随修、S3-1 SDK方法已用、S3-3 citationsMode已传 — 仅剩S3-5未修复 |

| 2026-06-16 02:15 | S1-1 Merger entity-level dedup 接入 assemble()，总计高优问题剩12个未修复 |
| 2026-06-16 02:15 | S3-2 promptAuthority 已补全（P1 修复时完成） |
| 2026-06-11 21:37 | 恢复 S3-5（现S3-4）手动消息归一化问题，总数23个 |
