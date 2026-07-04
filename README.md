# lcm-graph-extra v2.1.9

**OpenClaw Context Engine 插件** -- 四层检索上下文注入引擎

## 概述

lcm-graph-extra 协调 lossless-claw、qmd、graph-memory-pro 和经验总结层
作为 OpenClaw ContextEngine，在每次 LLM 调用前自动注入上下文。

### 生命周期

```
assemble: windowMonitor -> L2 qmd + L3 Neo4j + L4 exp -> Merger -> inject
afterTurn: LLM triplet extraction -> Neo4j upsert
compact: backup -> lossless-claw DAG compact -> entity extraction
```

## 安装

```bash
git clone https://github.com/wljmmx/lcm-graph-extra.git
cd lcm-graph-extra && npm install && npm run build
```

## 功能模块

| 模块 | 说明 |
|------|------|
| src/index.ts | CE 入口 + Window Monitor + Total Control |
| src/qmd-client.ts | QMD MCP+CLI 双模式搜索 |
| src/adapters/graph-adapter.ts | Neo4j 图谱适配 + PageRank |
| src/merger.ts | 实体级去重 + 时间衰减 + LLM 重排 |
| src/entity-extractor.ts | 实体提取 + 模糊匹配 |
| src/experience/ | 经验系统 (4 种触发源) |
| src/hooks/* | 5 个生命周期 Hook |
| src/tools.ts | 11 个操作工具
| src/circuit-breaker.ts | 熔断 + 重试 |
| src/core/graph.ts | DAG 管理器 |
| src/core/ttl.ts | TTL 清理 |
| src/config.ts | Zod Schema 校验 |

## 压力等级

| 等级 | 条件 | qmd | graph | exp | maxChars |
|------|------|-----|-------|-----|---------|
| low | 正常 | 5 | 5 | 3 | 6000 |
| medium | msg>24 或 ratio>0.70 | 3 | 3 | 1 | 3000 |
| high | msg>48 或 ratio>0.85 | 1 | 1 | 0 | 800 |

## 工具

- lcmg_experience_report: Neo4j 经验报告
- lcmg_backup: 全量备份
- lcmg_restore: 备份恢复
- lcmg_import: 导入 Neo4j
- lcmg_diagnose: 健康诊断
- lcmg_search: 跨引擎搜索
- lcmg_pin: 标记永久保留
- lcmg_sync: 数据一致性修复
- lcmg_qmd_status: QMD 状态
- lcmg_get_document: 获取文档
- lcmg_batch_get: 批量获取

## 开发

```bash
npm run build
npx tsc --noEmit
npm test
```

## 许可证

MIT
