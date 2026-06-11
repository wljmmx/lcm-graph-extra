# lcm-graph-extra 优化清单 (2026-06-11)

## 🔴 P0: fullDoc 2000字符硬截断优化

### 当前问题
- `index.ts` L536-545: `doc.length > 2000` 直接 `slice(0, 2000)` 粗暴截断
- 丢失文档后半部分重要信息
- 没有摘要/summary保留机制

### 优化方案（按优先级）

#### 方案A: 智能尾部保留 + 头部摘要（推荐）
```typescript
// 代替当前的 slice(0, 2000)
function smartTruncate(doc: string, maxChars: number): string {
  if (doc.length <= maxChars) return doc;
  
  const headRatio = 0.6;   // 60%头部
  const tailRatio = 0.3;   // 30%尾部（保留结论/总结）
  const summaryLen = 10;   // 中间摘要标记
  
  const headChars = Math.floor(maxChars * headRatio);
  const tailChars = Math.floor(maxChars * tailRatio);
  
  return [
    doc.slice(0, headChars),
    `...（省略 ${doc.length - headChars - tailChars} 字符）...`,
    doc.slice(-tailChars)
  ].join('');
}
```
**优点：** 保留开头（通常有重要定义）+ 结尾（通常有结论/总结）
**缺点：** 中间内容丢失

#### 方案B: LLM摘要截断（高质量但贵）
```typescript
async function llmSummarize(doc: string, maxChars: number): Promise<string> {
  // 调用 LLM 生成摘要，控制在 maxChars 以内
  const summary = await callLLM({
    prompt: `用中文简要总结以下文档（不超过${maxChars}字符）:\n\n${doc}`,
    model: 'gpt-4o-mini',  // 便宜模型
  });
  return summary;
}
```
**优点：** 高质量摘要，保留核心信息
**缺点：** 增加延迟和成本

#### 方案C: 配置化截断阈值 + 分级处理（实用）
```typescript
// 在 windowMonitor 配置中添加
interface WindowMonitorConfig {
  // ...
  docTruncation?: {
    maxChars: number;        // 默认2000，可配置
    strategy: 'head' | 'head-tail' | 'llm-summary';  // 截断策略
    headRatio: number;       // 头部保留比例（0.6）
    tailRatio: number;       // 尾部保留比例（0.3）
    llmModel?: string;       // LLM摘要模型ID
  };
}
```
**优点：** 灵活可配置，适应不同场景
**缺点：** 增加配置复杂度

#### 方案D: 关键段落提取（基于Markdown标题）
```typescript
function extractKeySections(doc: string, maxChars: number): string {
  // 1. 识别 Markdown 标题 (## H2, ### H3)
  // 2. 提取每个标题下的第一段
  // 3. 按 maxChars 限制输出
  const sections = doc.split(/^##/m).filter(Boolean);
  let result = '';
  for (const section of sections) {
    if (result.length + section.length > maxChars) break;
    result += '##' + section.slice(0, 500); // 每段最多500字符
  }
  return result;
}
```
**优点：** 保留结构化信息
**缺点：** 依赖 Markdown 格式

### 推荐实施顺序
1. **立即**: 方案C - 配置化 `maxChars`，从2000改为可配置（默认4000适配256K上下文）
2. **短期**: 方案A - head-tail 截断策略，保留开头和结尾
3. **中期**: 方案D - Markdown关键段落提取
4. **长期**: 方案B - LLM摘要（需评估成本/延迟）

---

## 🔴 P1: Merger 实体去重类闲置修复
- `Merger` 类完整实现但未被 assemble() 调用
- 当前只用 quickHash 做文本级别去重
- **修复**: 在 L2+L3 结果注入前插入 Merger.merge() 调用

## 🔴 P2: toolGuidance 硬编码修复
- 未使用 `buildMemorySystemPromptAddition` SDK 标准方法
- **修复**: 替换为 `import { buildMemorySystemPromptAddition } from 'openclaw/plugin-sdk/core'`

## 🔴 P3: promptAuthority 缺失
- assemble() 返回结果缺少 `promptAuthority` 字段
- **修复**: 添加 `promptAuthority: 'preassembly_may_overflow'`

## 🟡 P4: citationsMode 未处理
- SDK params 包含 citationsMode 但被忽略
- **修复**: 传入 buildMemorySystemPromptAddition

---


---

## Step 4: 硬编码/魔术数字全面扫描结果 (2026-06-11)

### 🔴 index.ts 核心硬编码（高优先级）

| 行号 | 魔术数字 | 含义 | 问题 | 修复方案 |
|------|---------|------|------|---------|
| L342 | `131072` | contextWindow 默认值 | 未跟随配置更新到262144 | 改为从 config 读取或使用常量 |
| L347 | `6000` | maxContextChars low 默认 | 硬编码阈值 | 已可配置，但默认值偏小（256K应提高） |
| L362 | `6000/3000` | low/medium tier 字符限制 | 同上 | 同上 |
| L383 | `57344` | compactTokenBudget 默认值 | 旧128K时代的值，应为114688 | 改为从 config 读取 |
| L540 | `2000` | fullDoc 截断阈值 | 粗暴截断，无摘要保留 | 见 P0 优化方案 |
| L203 | `24` | MAX_DEDUP_ROUNDS | 去重窗口轮数硬编码 | 改为可配置 |

### 🟡 config.ts 默认值硬编码（中优先级）

| 行号 | 魔术数字 | 含义 | 问题 | 修复方案 |
|------|---------|------|------|---------|
| L119 | `10` | maxGraphDepth | 合理，但应文档化 |
| L120 | `5000` | maxNodeCount | 合理，但应文档化 |
| L122 | `90` | crossReferenceRetentionDays | 合理 |
| L123 | `32768` | maxTokens | **过时！** 应为 262144 |
| L126 | `30_000` | cliTimeout | 合理 |

### 🟢 hooks/session-created.ts 硬编码（需检查）

| 行号 | 魔术数字 | 含义 | 问题 | 修复方案 |
|------|---------|------|------|---------|
| L104 | `10_000` | triggerThreshold | **过时！** 应为 20000（翻倍） |
| L105 | `81_920` | softThresholdTokens | **过时！** 应为 163840（翻倍） |
| L106 | `65_536` | keepRecentTokens | **过时！** 应为 131072（翻倍） |

### 🔴 关键发现：session-created.ts 中的 compaction 配置未跟随 256K 更新！

这些值基于 128K 上下文设计，需要按比例翻倍：

```typescript
// 当前（错误）：
triggerThreshold: 10_000,
softThresholdTokens: 81_920,      // 80K / 128K = 62.5%
keepRecentTokens: 65_536,         // 64K / 128K = 50%

// 应改为（256K）：
triggerThreshold: 20_000,
softThresholdTokens: 163_840,     // 160K / 256K = 62.5%
keepRecentTokens: 131_072,        // 128K / 256K = 50%
```

---

## Step 4 优先级修复清单

| 优先级 | 文件 | 问题 | 当前值 | 目标值 | 状态 |
|--------|------|------|--------|--------|------|
| P0 | config.ts L123 | maxTokens 过时 | 32768 | **65536**（或更高） | 🔴 待修复 |
| P0 | hooks/session-created.ts L105 | softThresholdTokens 过时 | 81920 | **163840** | 🔴 待修复 |
| P0 | hooks/session-created.ts L106 | keepRecentTokens 过时 | 65536 | **131072** | 🔴 待修复 |
| P1 | index.ts L342 | contextWindow 默认值过时 | 131072 | **262144** | 🔴 待修复 |
| P1 | index.ts L540 | fullDoc 截断阈值 | 2000 | **可配置（默认4000）** | 🟡 待优化 |
| P2 | index.ts L203 | MAX_DEDUP_ROUNDS 硬编码 | 24 | **可配置** | 🟡 待优化 |

---
