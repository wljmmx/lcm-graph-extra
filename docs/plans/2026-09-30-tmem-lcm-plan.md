# lcm-graph-extra · T-Mem 借鉴开发计划

> 契约：[2026-09-30-tmem-trigger-contract.md](./2026-09-30-tmem-trigger-contract.md)（两侧唯一事实来源）
> 审计脚本：[scripts/audit-cue-coverage.mjs](../../scripts/audit-cue-coverage.mjs)
> 对侧计划：[2026-09-30-tmem-gmp-plan.md](./2026-09-30-tmem-gmp-plan.md)

## 目标与边界

**做什么**：给本插件自己的 **`:EXPERIENCE`（工程经验）** 记忆补上 QII（Bridge）/ QIII（Horizon）关联通道，
让"与经验无字面重叠的查询"也能召回它。

**不做什么**：**不碰对话记忆**（`GmMessage`/`ConversationMessage`）——那属于 graph-memory-pro 的宿主范围
（见契约 §8）。本侧不做 scene 切分、不建 trigger 图、不做级联检索。

**为什么只做经验侧**：经验条目体量小、宿主明确（一条 = 一个 item），改动面可控且不依赖 gmp 交付。

---

## P0 · 度量闸门（零风险，先做，可止损）

| # | 任务 | 落点 | 验收 |
|---|---|---|---|
| **L0.1** | 跑关联盲区审计，拿到数字 | `node scripts/audit-cue-coverage.mjs --limit 300` | 输出四类计数 + `gap` 占比 |
| **L0.2** | 附加向量层可达性 | `--embed` | 过 0.85 硬门的比例 |
| **L0.3** | 把审计结论落到 `lcmg_diagnose` 输出，供日常观察 | [diagnose.ts](../../src/tools/diagnose.ts) | 诊断输出含盲区占比一行 |
| **L0.4** | 确认 gmp 侧对话记忆的盲区归属（读对侧 `recaller/recall.ts`，**尚未读**） | 只读 | 给出确切接入点，不靠猜 |

**止损闸门（必须显式判断）**：

| 审计结果 | 决策 |
|---|---|
| `gap` 占比很低（如 < 10%） | **停止 P1/P2**，只保留 L0.3 的观测 |
| `NO_INDEPENDENT_SIGNAL` 占比高 | P1 优先（先补线索，这批人任何检索机制都救不了） |
| `BLIND_SPOT` 占比高且 `--embed` 过门率低 | P1 + P2 都做 |

> 这一步的意义：**不要因为论文好看就投入**。先证明本机数据上盲区真实存在。

---

## P1 · 写入侧：经验 cues 生成

| # | 任务 | 落点 | 约束 |
|---|---|---|---|
| **L1.1** | `DistilledExperience` 增 `cues?: ExperienceCue[]`（结构见契约 §2，`hostKind:'item'`） | [types.ts:55](../../src/experience/types.ts#L55-L70) | 可选字段——旧数据无 cues 必须能正常工作 |
| **L1.2** | `distillOne` prompt 增 cues 字段：含契约 §4 的**负面清单 + 分档置信度 + 允许留空** | [distillation.ts:508-513](../../src/plugin/distillation.ts#L508-L513) | 复用**现有**那一次 LLM 调用，不新增往返 |
| **L1.3** | 解析 + 兜底：cues 解析失败**绝不能**影响蒸馏主流程 | [distillation.ts:571-605](../../src/plugin/distillation.ts#L571-L605) | 照 `relatedConcepts` 现有模式（失败→undefined→兜底），**蒸馏失败会丢经验，是最高危路径** |
| **L1.4** | 去重收敛（契约 §5）：规范化精确 + 相似度 ≥0.9 + `createdAt` 确定性 canonical + conf 取最大 | 新增 `src/experience/cue-dedup.ts` | 必须可单测 |
| **L1.5** | 持久化：Neo4j 无数组 → 逗号串（与 `tags_free` 同构） | [storage.ts:396-423](../../src/experience/storage.ts#L396-L423) | 与 `relatedConcepts` 保持一致 |
| **L1.6** | 通道命名本地化：**不要照抄** T-Mem 的 5 通道（`LEGACY_ANCHOR` 等是"人生叙事"语义） | 同上 | 工程经验通道建议：`同类报错 / 同类技术栈 / 同类变更风险 / 同类环境约束` |

**验收**：
- 旧经验（无 cues）检索行为**零变化**
- 蒸馏成功率不下降（有单测证明解析失败被兜住）
- 单条经验 cue 数有上限（默认 ≤ 6），避免写入膨胀

**回退**：cues 是新增可选字段，删除生成逻辑即回到现状；已写入的 cues 不参与检索（P2 未开启时）。

---

## P2 · 检索侧：独立关联通道（只加不替）

| # | 任务 | 落点 | 约束 |
|---|---|---|---|
| **L2.1** | 新增 `searchByCues()`，与 `searchByQuery()` **并列** | [storage.ts:432](../../src/experience/storage.ts#L432) 旁 | **不改** `searchByQuery` / `_searchByFulltextIndex` 一行 |
| **L2.2** | L4 之后**追加** cue 通道结果 | [retrieval.ts:369-424](../../src/assemble/retrieval.ts#L369-L424) | **不改** L2/L3/L4 的排序与合并逻辑 |
| **L2.3** | 去重复用现有 merger | [merger.ts](../../src/merger.ts) | 不新增去重实现 |
| **L2.4** | 配置面：`retrieval.graph.cues.{enabled:false, minCosine:0.85, topK:5, maxExtra:3}` | [config.ts:259](../../src/config.ts#L259) + `openclaw.plugin.json` + [schema-consistency.test.ts](../../src/config/schema-consistency.test.ts) | **三处必须同步**——上一轮刚被这类漂移坑过（整份配置被宿主拒绝） |
| **L2.5** | 文档 | [config-reference.md](../../docs/config-reference.md) | 含"并发上限 ≠ 频率控制"同款说明风格 |
| **L2.6** | 观测：命中来源（联想/相似度）计数 | dashboard + `lcmg_diagnose` | 支撑 L0.3 的持续观察 |

**验收（硬性）**：
1. `enabled:false`（默认）时**字节级等价**于现状——用回归测试证明（同 query 同结果同顺序）
2. 开启后既有 top-K 顺序**逐项不变**（契约 I2）
3. 未过 0.85 门时 `triggered=false` 且有 `reason`（契约 I1/I4）

**回退**：一个配置开关即可完全关闭；无数据迁移、无 schema 变更。

---

## P3 · 回填与调优

| # | 任务 | 落点 |
|---|---|---|
| **L3.1** | 旧经验 cues 回填工具（仿现有 `lcmg_backfill` 的分批 + `aborted` 检查 + 进度日志范式） | [tools.ts](../../src/tools.ts) |
| **L3.2** | 按审计数据调 `topK` / `maxExtra` / `minCosine` | 配置 |
| **L3.3** | 与 gmp 的 associationMatrix 协同（冷启动）——**依赖对侧 B3.1** | 见对侧计划 |

---

## 依赖与并行度

```
L0（度量）─┬─ gap 小 ─→ 停止
           └─ gap 大 ─→ L1 ─→ L2 ─→ L3.1/L3.2
                              └────→ L3.3（需 gmp 侧 B3.1 就绪）
```

**L1/L2 不依赖 gmp**，可立即独立推进。仅 L3.3 需对侧接口。

---

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 写入侧 LLM 成本上升 | 批量蒸馏耗时/成本增加 | 契约 §6 的去重收敛；**成本数字未知**（见下），L0 阶段先量 |
| cue 幻觉 | 引入噪声召回，拉低精度 | 契约 I6（允许留空）+ I1（0.85 硬门）+ I2（只加不替） |
| 与 `relatedConcepts` 功能重叠 | 白做工 | L0.1 的 `anchor` 变体正是测这个：若 tag 层已够用，`gap` 会很小 |
| cues 串过长膨胀属性 | 节点属性膨胀、全文索引负担 | 单条上限（L1.1 验收项） |

---

## 未验证项

1. **T-Mem 论文 §4.6 效率分析未核到** → 写入侧成本**具体数字未知**，L0 阶段必须实测。
2. 论文指标数字来自二手报道，论文原文仅核到 "state-of-the-art on both"。
3. 未运行 T-Mem 代码、未复现评测。
4. 本侧所有落点行号来自**当前 HEAD**，实施前需重新确认（仓库在演进）。
