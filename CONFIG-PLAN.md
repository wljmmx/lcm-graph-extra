# 魔术数字配置化方案

## 📋 现状分析

### config.ts 中已有的配置项（但未被 index.ts 引用）

| 已有配置 | 默认值 | 被硬编码的位置 | 问题 |
|---------|--------|--------------|------|
| `WindowMonitorConfigSchema.contextWindow` | 131072 | index.ts L342 `?? 131072` | ✅ 已使用（fallback） |
| `WindowMonitorConfigSchema.compactTokenBudget` | 57344 | index.ts L383 `?? 57344` | ✅ 已使用（fallback） |
| `WindowMonitorConfigSchema.maxContextChars.low` | 6000 | index.ts L347 `let maxContextChars = 6000` | ❌ **未使用**，直接写死 |
| `WindowMonitorConfigSchema.maxContextChars.medium` | 3000 | index.ts L362-363 fallback | ✅ 已使用（fallback） |

### index.ts 中的硬编码（需要从配置读取）

| 行号 | 当前硬编码 | 应改为 | 优先级 |
|------|----------|--------|--------|
| L347 | `let maxContextChars = 6000` | 从 `wm.maxContextChars?.low` 读取 | 🔴 |
| L540 | `doc.length > 2000` | 新增 `docTruncationMaxChars` 配置项 | 🔴 |
| L203 | `maxRounds: 24` | 从 `wm.messageTriggerCount` 读取 | 🟡 |

### session-created.ts 中的硬编码（需要从 config.compaction 读取）

| 行号 | 当前硬编码 | 应改为 | 优先级 |
|----|---------|--------|--------|
| L104 | `triggerThreshold: 10_000` | 从 `config.compaction.triggerThreshold` 读取 | 🔴 |
| L105 | `softThresholdTokens: 81_920` | 从 `config.compaction.softThresholdTokens` 读取 | 🔴 |
| L106 | `keepRecentTokens: 65_536` | 从 `config.compaction.keepRecentTokens` 读取 | 🔴 |

### config.ts 中的默认值需要更新（适配256K）

| Schema | 字段 | 当前默认 | 新默认 | 原因 |
|--------|------|---------|--------|------|
| PluginConfigSchema | `maxTokens` | 32768 | **65536** | 128K→256K翻倍 |
| WindowMonitorConfigSchema | `contextWindow` | 131072 | **262144** | 128K→256K |
| WindowMonitorConfigSchema | `compactTokenBudget` | 57344 | **114688** | 翻倍 |
| WindowMonitorConfigSchema | `maxContextChars.low` | 6000 | **12000** | 翻倍 |
| WindowMonitorConfigSchema | `maxContextChars.medium` | 3000 | **6000** | 翻倍 |
| WindowMonitorConfigSchema | `maxContextChars.high` | 800 | **1600** | 翻倍 |
| CompactionConfigSchema | `triggerThreshold` | 10000 | **20000** | 翻倍 |
| CompactionConfigSchema | `softThresholdTokens` | 81920 | **163840** | 翻倍 |
| CompactionConfigSchema | `keepRecentTokens` | 65536 | **131072** | 翻倍 |

### 需要新增的配置项

| 配置项 | 类型 | 默认值 | 用途 |
|--------|------|--------|------|
| `docTruncationMaxChars` | number | **4000** | fullDoc截断阈值（取代硬编码2000） |
| `dedupRounds` | number | **24** | 去重窗口轮数（取代L203硬编码） |

---

## 🔧 实施计划

### Step 1: 更新 config.ts 默认值（适配256K）
- [ ] PluginConfigSchema.maxTokens: 32768 → 65536
- [ ] WindowMonitorConfigSchema.contextWindow: 131072 → 262144
- [ ] WindowMonitorConfigSchema.compactTokenBudget: 57344 → 114688
- [ ] WindowMonitorConfigSchema.maxContextChars.low: 6000 → 12000
- [ ] WindowMonitorConfigSchema.maxContextChars.medium: 3000 → 6000
- [ ] WindowMonitorConfigSchema.maxContextChars.high: 800 → 1600
- [ ] CompactionConfigSchema.triggerThreshold: 10000 → 20000
- [ ] CompactionConfigSchema.softThresholdTokens: 81920 → 163840
- [ ] CompactionConfigSchema.keepRecentTokens: 65536 → 131072

### Step 2: 新增配置项
- [ ] WindowMonitorConfigSchema 添加 `docTruncationMaxChars: z.number().default(4000)`
- [ ] WindowMonitorConfigSchema 添加 `dedupRounds: z.number().default(24)`

### Step 3: index.ts 硬编码替换
- [ ] L347: `let maxContextChars = 6000` → 从配置读取
- [ ] L540: `doc.length > 2000` → 使用 `docTruncationMaxChars`
- [ ] L203: `maxRounds: 24` → 使用 `dedupRounds`

### Step 4: session-created.ts 硬编码替换
- [ ] L104-106: 从 `config.compaction` 读取而非硬编码

---
