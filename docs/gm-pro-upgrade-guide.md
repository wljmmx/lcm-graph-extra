# graph-memory-pro 升级指南

> 适用版本：从 graph-memory-pro v2.1.9 升级到 v2.1.10
> 关联插件：lcm-graph-extra v2.1.10

---

## 1. 为什么升级

lcm-graph-extra v2.1.10 引入了 5 个依赖 graph-memory-pro v2.1.10 的新能力：

| 能力 | 对应 ROADMAP | 说明 |
|------|-------------|------|
| `judgeRecall()` | R-2 成本感知级联 | Tier 1 召回置信度评估，触发 Tier 2/3 级联 |
| `upsertFeedback()` | G-8 LLM 异步验证回路 | 写入质量反馈，驱动经验质量分演进 |
| `getNodesByTimeRange()` | S-8' 时间范围回顾 | 按时间范围高效检索经验/事件节点 |
| `evolveNode()` | G-10 主动遗忘 | 节点状态演进（superseded/archived） |
| `getGraphHealth()` | N-4 健康指标导出 | 图谱健康快照（节点数/关系数/延迟） |

**不升级也能用**：所有新 API 都通过 `gm-pro-fallback` wrapper 实现优雅降级，未安装 gm-pro 时自动使用本地 Cypher/启发式实现。

---

## 2. 升级步骤

### 2.1 前置检查

```bash
# 检查当前 lcm-graph-extra 版本
cd ~/.openclaw/plugins/lcm-graph-extra
cat package.json | grep version
# 应 >= 2.1.10

# 检查当前 graph-memory-pro 版本（如已安装）
cd ~/.openclaw/plugins/graph-memory-pro
cat package.json | grep version
# 升级目标: >= 2.1.10
```

### 2.2 安装/升级 graph-memory-pro

```bash
# 方式一：通过 OpenClaw 插件市场安装
# 在 OpenClaw 设置中搜索 @openclaw/graph-memory-pro 并安装

# 方式二：手动安装
cd ~/.openclaw/plugins
git clone https://github.com/wljmmx/graph-memory-pro.git
cd graph-memory-pro
npm install
npm run build
```

### 2.3 重启 OpenClaw Host

```bash
# 重启 OpenClaw host 以加载新插件
# （根据你的部署方式，可能是重启桌面应用或 systemd 服务）
```

### 2.4 验证升级

```bash
# 1. 检查日志中是否有 gm-pro 加载成功
grep "gm-pro" ~/.openclaw/logs/*.log
# 应看到类似 "gm-pro available, using v2.1.10 APIs"

# 2. 调用 lcmg_diagnose 工具查看
# 应显示 graph-memory-pro: connected (v2.1.10)

# 3. 检查 dashboard 监控页
# Cascade 面板应显示 source = "gm-pro"（而非 "local"）
```

---

## 3. 升级影响

### 3.1 行为变化

| 模块 | 升级前（local fallback） | 升级后（gm-pro v2.1.10） |
|------|------------------------|------------------------|
| R-2 级联 Tier 1 | 本地 `evaluateTier1` 启发式规则（准确率 ~70%） | gm-pro `judgeRecall` LLM 判断（准确率 ~90%+） |
| G-8 验证回路 | 直接 `updateQualityScore` 写 Neo4j，source="local" | gm-pro `upsertFeedback` 统一反馈管线，source="gm-pro" |
| S-8' 时间查询 | Cypher `WHERE e.createdAt >= $from` 全表扫描 | gm-pro `getNodesByTimeRange` 时间索引优化查询 |
| G-10 主动遗忘 | Cypher 直接 `SET n.state='superseded'` | gm-pro `evolveNode` 带冲突消解 + 重要性评分联动 |
| N-4 图谱健康 | GraphAdapter 状态推断（仅连接状态） | gm-pro `getGraphHealth` 完整快照（节点/关系/延迟/错误率） |

### 3.2 性能影响

- **S-8' 时间范围查询**：从 O(n) 全表扫描优化到 O(log n) 索引查询，大数据量下提升显著
- **R-2 judgeRecall**：首次调用有 LLM 推理延迟（~200-500ms），但减少无效 Tier 2 调用，整体更优
- **G-8 upsertFeedback**：批处理写入，比单条 Cypher 更高效

### 3.3 数据兼容性

- **完全向后兼容**：所有数据 schema 变更为增量式（新增字段，不修改现有字段）
- **无需数据迁移**：v2.1.9 数据在 v2.1.10 中直接可用
- **新字段自动补全**：`qualityScoreHistory` 等新字段首次访问时自动初始化

---

## 4. 降级方案

如升级后遇到问题，可随时回退：

```bash
# 方式一：禁用 graph-memory-pro 插件
# 在 OpenClaw 设置中禁用 @openclaw/graph-memory-pro

# 方式二：卸载
cd ~/.openclaw/plugins
rm -rf graph-memory-pro

# 重启 OpenClaw host 后自动降级到 local fallback
```

降级后：
- 所有功能保持可用（自动 fallback）
- Cascade 置信度来源从 "gm-pro" 变为 "local"
- 经验质量分历史的 source 标记切换为 "local"

---

## 5. 常见问题

### Q1: 升级后 Cascade 置信度反而变低了？

**A**: 正常现象。gm-pro 的 `judgeRecall` 使用 LLM 更严格地评估召回相关性，
比本地启发式规则更准确但也更严格。低置信度会触发 Tier 2 LLM 重排，
最终检索质量反而更高。

### Q2: 升级后经验质量分波动大？

**A**: 正常。gm-pro 的 `upsertFeedback` 使用更精细的评分算法，
短期内质量分可能波动，长期会趋于稳定。可通过 dashboard 经验详情页的
质量分趋势图观察变化。

### Q3: 升级后 lcmg_sync 变慢了？

**A**: v2.1.10 的 sync 增加了 updatedAt 一致性校验，首次全量同步会稍慢。
后续增量同步会更快。可通过 `lcmg_sync { mode: "check" }` 先预检差异。

### Q4: 两个插件版本不匹配会怎样？

**A**: 不影响核心功能。lcm-graph-extra 会检测 gm-pro 的 API 可用性，
缺少的 API 自动降级到本地实现。版本差异仅影响新特性的启用。

### Q5: 如何确认哪些功能走了 gm-pro？

**A**: 三种方式：
1. Dashboard → MonitorView → Cascade 面板，查看 source 标签
2. `lcmg_diagnose` 工具输出中的 gm-pro 状态
3. 日志中搜索 `[gm-pro-fallback]`，成功调用会有 debug 日志

---

## 6. 版本对照矩阵

| lcm-graph-extra | graph-memory-pro | 新特性启用状态 |
|----------------|-----------------|--------------|
| v2.1.9 | v2.1.9 | —（基线版本） |
| v2.1.10 | 未安装 | 全部 fallback（5 项新能力走本地实现） |
| v2.1.10 | v2.1.9 | 部分 fallback（gm-pro v2.1.9 无新 API） |
| v2.1.10 | v2.1.10 | ✅ 全部启用（5 项新能力完整生效） |

---

## 7. 相关文档

- [ROADMAP.md](../ROADMAP.md) — 13 项演进任务说明
- [API.md](../API.md) — 完整 API 参考
- [FAQ.md](./faq.md) — 常见问题
- [CHANGELOG.md](../CHANGELOG.md) — 版本变更日志
