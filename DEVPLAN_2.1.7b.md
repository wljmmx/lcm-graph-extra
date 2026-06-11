# lcm-graph-extra v2.1.7b 开发计划

> 目标版本：2.1.7b
> 基于：2.1.7 (patched) — P0 级修复已部署到生产

---

## 一、P1 级任务 — 功能性修复

### BUG-1: graph-adapter.ts 中 console.warn/console.error 残留
- 文件: src/adapters/graph-adapter.ts
- 行: 103 (console.warn), 109 (console.error), 162 (console.error), 354 (console.error)
- 修复: 统一改为 logger?.warn?.() / logger?.error?.()
- 预估: 15分钟

### BUG-2: sessionStore 内存泄漏
- 文件: src/hooks/session-created.ts
- 问题: module-level Map 无 TTL 清理机制
- 修复: 添加 TTL 过期清理（如 24h），或监听 session 销毁事件
- 预估: 30分钟

### BUG-3: turn-complete.ts 动态 import
- 文件: src/hooks/turn-complete.ts
- 问题: 每轮对话 await import(..) 获取 expStore 单例
- 修复: 改为模块导入或通过 Closure 传递实例
- 预估: 20分钟

## 二、P2 级任务 — 代码质量

### BUG-4: getExperienceStorage() 隐式 side effect
- 文件: src/hooks/before-turn.ts
- 问题: getRetrievalGateway() 的 side effect 设置 _experienceStorage
- 修复: 显式初始化，分离初始化和获取
- 预估: 15分钟

### BUG-5: experience/storage.ts 可能使用 console.log
- 文件: src/experience/storage.ts（需审计）
- 修复: 统一日志渠道
- 预估: 10分钟

### BUG-6: applyTotalControl 日志增强
- 文件: src/index.ts
- 修复: 添加各层（L2/L3/L4/工具）移除的字符数统计到日志
- 预估: 15分钟

## 三、P3 级任务 — 工程化

### TASK-7: 添加单元测试
- 范围: quickHash, dedupInject, applyTotalControl, retrievalLimits 计算
- 工具: vitest（已有配置）
- 预估: 1小时

### TASK-8: entry.ts 入口文件
- 文件: 新建 src/entry.ts
- 目的: 使 register.ts 新架构可部署
- 预估: 30分钟

## 四、执行顺序

BUG-1 -> BUG-2 -> BUG-3 -> BUG-4 -> BUG-5 -> BUG-6 -> TASK-7 -> TASK-8

每个修复：修改 -> tsup build -> 验证 -> 部署到生产

## 五、版本标签

- 当前生产版本：2.1.7 (patched, 2026-06-11)
- 下一目标版本：2.1.7b
- 版本标记位置：dist/RELEASE_NOTES.txt + package.json version 字段

## 六、风险项

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| sessionStore 改动引入 regression | 低 | 中 | 改动前加测试用例 |
| entry.ts 新入口与现有 CE 冲突 | 中 | 高 | 先保持双架构并行，逐步切换 |
| 日志统一后丢失排查线索 | 低 | 低 | 确保 verbose/debug 级别不变 |

