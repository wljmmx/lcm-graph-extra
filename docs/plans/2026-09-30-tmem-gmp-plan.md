# graph-memory-pro · T-Mem 借鉴开发计划（交付给 `wljmmx/graph-memory-pro`）

> **本文是跨仓库交付物**。目标仓库：`wljmmx/graph-memory-pro`（当前观测 HEAD `406c08d`）。
> 契约：[2026-09-30-tmem-trigger-contract.md](./2026-09-30-tmem-trigger-contract.md)（两侧唯一事实来源）
> 依据：腾讯 T-Mem（EMNLP 2026，arXiv:2606.15405），代码 `github.com/Sherlockwz/T-Mem`
>
> ⚠️ **本计划的接入点均为待验证假设**：我读过 gmp 的目录结构与 `src/engine/embed.ts`(31KB) 全文，
> 但 **`src/recaller/recall.ts`(33KB)、`src/store/schema.ts`(20KB)、`src/store/nodes.ts`(31KB) 未读**。
> P0 的第一件事就是读它们定接入点，不得跳过。

## 目标与边界

**做什么**：把 T-Mem 的四象限 trigger 机制移植到 **对话记忆**——gmp 是 scene/item 的宿主，
因此 QI/QII/QIII/QIV 四象限全在 gmp 侧实现。

**不做什么**：不实现 lcm 的工程经验 cues（那是 lcm 侧，见对侧计划）；不改动既有召回打分公式（契约 I2）。

**已验证的 gmp 结构**（目录级，来自 GitHub API）：

| 目录/文件 | 与本计划的关系 |
|---|---|
| `src/recaller/recall.ts` (33KB) | **主召回路径**——trigger bypass 的接入点（未读） |
| `src/recaller/judge.ts` (19KB) | JudgeManager，反馈闭环 |
| `src/recaller/association-matrix.ts` (29KB) + `association-matrix-persist.ts` | 关联矩阵 M，**有冷启动依赖**（见 P3） |
| `src/recaller/rerank.ts` / `chunk.ts` / `query-cache.ts` / `session-recall-cache.ts` | 重排/分块/缓存 |
| `src/store/schema.ts` (20KB) | schema 定义——trigger 节点/索引落地处（未读） |
| `src/store/nodes.ts` (31KB) / `edges.ts` / `messages.ts` | 节点/边写入（未读） |
| `src/store/vector.ts` / `vector-query.ts` / `embed-helper.ts` | 向量索引与查询 |
| `src/extractor/extract.ts` | 抽提流程——trigger 生成的挂载点 |
| `src/engine/embed.ts` (31KB) | **已读**：信号量 + pacing + 缓存 + 重试，与本计划的批量生成直接相关 |
| `src/engine/llm.ts` (33KB) / `circuit-breaker.ts` | LLM 调用与熔断 |
| `src/routes/` / `src/services/` / `src/server/` | 对外 HTTP 面——重建接口暴露处 |

---

## P0 · 设计决策（必须先定，不得先写代码）

| # | 决策 | 建议 | 理由 |
|---|---|---|---|
| **G0.1** | 读 `recall.ts` / `schema.ts` / `nodes.ts`，定 bypass 接入点与 trigger 落地 | — | 假设不得代替阅读 |
| **G0.2** | trigger 存**独立节点**还是宿主属性？ | **独立节点**（新 label） | T-Mem 用独立 `TriggerGraph`；其 `item_confidences` 是**一对多**（一个 trigger 挂多个 item）→ 属性存不下 |
| **G0.3** | 三视角 embedding（concept/bridge/joint）怎么落？ | trigger 节点 **3 个向量属性** + 各自 `vectorConfig` 索引 | 不必像 T-Mem 外挂 `.npz`；正好复用已验证的 2026.x 索引路径 |
| **G0.4** | 是否搬 T-Mem 的 top-down 级联（topic→scene→item）？ | **不搬**，只做 **trigger bypass** | gmp 已有自己的召回排序；级联是 T-Mem 的结构选择，硬搬会与既有路径打架 |
| **G0.5** | 成本预算与闸门 | 见 P1 验收 | 写入侧要新增 LLM 调用，必须先定预算 |

**G0 产出**：一份含确切函数名/文件行号的接入点说明 + schema 变更草案。**没有它不进 P1。**

---

## P1 · 写入侧：四象限 trigger 生成

| # | 任务 | 契约依据 | 验收 |
|---|---|---|---|
| **G1.1** | item 级 entity/bridge 生成（Route A 语义锚 / Route B 强关联场景） | §4 负面清单 | 产出的 trigger 中 **Restatement/Over-general 比例可统计且低**（用契约 §4 的判据做抽样人工核 + 自动近似检测） |
| **G1.2** | scene 级 scene/horizon 生成，**通道允许留空** | §4、I6 | 空通道占比合理（若接近 0 说明提示词在强填 → 违规） |
| **G1.3** | 去重收敛 | §5 | `createdAt` 确定性；同输入两次运行 canonical **完全一致**（可测） |
| **G1.4** | 构建期过滤 `conf ≥ 0.70`；**保留"已无宿主"的 trigger** | §5 | 反直觉项——须有测试锁定该行为 |
| **G1.5** | 超 `N_TURNS_SKIP = 10` 轮的 scene 跳过 | §6 | 成本闸门，须统计跳过量 |
| **G1.6** | 批量生成走 `engine/embed.ts` 既有信号量/pacing | 已读实现 | 不得绕过（避免又一次请求风暴） |

**成本（最大未知）**：T-Mem 论文 §4.6 效率分析**我未核到**，因此**给不出 trigger 生成的单位成本**。
P1 必须先做小样量测（如 50 个 item）得出「LLM 调用次数 / 耗时 / token」，再决定是否全量回填。

**回退**：trigger 节点是**新增 label**，不参与既有召回（P2 未开时），删除即回退。

---

## P2 · 检索侧：trigger-aware 索引 + bypass

| # | 任务 | 契约依据 | 验收 |
|---|---|---|---|
| **G2.1** | trigger 向量索引（3 视角，`vector-2.0`，维度与现有 embedding 一致） | — | 复用已验证的 provider 运行时解析；建后读回校验 |
| **G2.2** | `TriggerRecaller`：三视角 cos 的 **nanmax** + 硬门 0.85 + top-K + 跨 trigger 宿主去重 | I1 | 逐条对齐 T-Mem `trigger_recaller.py`（含 `nanmax` 与 `-inf` 处理） |
| **G2.3** | **trigger bypass**：相似度路径未达标时追加 trigger 命中 | I2 | 既有 top-K **逐项不变**（回归测试证明） |
| **G2.4** | 返回 `TriggerRecallResult`（含 `reason`） | I4 | 可区分"联想命中/相似度命中" |
| **G2.5** | 默认关 + 配置面 | I3 | 关闭时字节级等价于现状 |

**验收（硬性）**：① 默认关时回归等价；② 开启后既有排序不变；③ 未过门必 `triggered=false`。

---

## P3 · 与本仓库既有反馈闭环协同（本项目独有机会）

既有 `association-matrix.ts`（M）+ `judge.ts` 是**事后学习式**关联，需要 warmup 反馈才起作用
→ 天然冷启动。而 T-Mem 的 trigger 是**写入时预生成**、**零冷启动**。两者性质互补：

| 机制 | 解决什么 | 冷启动 |
|---|---|---|
| triggers（本计划新增） | 首次就能联想 | 无 |
| associationMatrix（既有） | 长期个性化：哪些关联真实有效 | 需要 warmup 反馈 |

| # | 任务 | 验收 |
|---|---|---|
| **G3.1** | 用 trigger 命中作为 M 的**初始信号源**（而非只等用户反馈）：冷启动期由 triggers 顶上，M 成熟后逐步接管 | 冷启动期召回质量相对纯 M 有提升；M 成熟后二者不打架（有分权/衰减策略） |
| **G3.2** | 把 trigger 命中写入既有 `feedback.ts` 或独立计数，供 `/api/metrics` 暴露 | 可观测 |
| **G3.3** | 效率：answer-time 延迟增量受控（T-Mem §4.6 未核，须自测） | 报出 P50/P95 增量 |

> **这是 T-Mem 论文没有、而本仓库架构天然支持的点**，建议作为差异化重点。

---

## P4 · 对外接口（供 lcm 消费）

| # | 任务 | 验收 |
|---|---|---|
| **G4.1** | 暴露 trigger 配置面（enabled / minCosine / topK / maxExtra） | 文档化 |
| **G4.2** | 触发重建接口（异步 job + jobId + 进度查询），**复用现有 `POST /api/extract/rebuild-all` 同款模式** | lcm 可轮询进度 |
| **G4.3** | 覆盖率指标：`trigger 命中 / 相似度命中` 比例 | 供 lcm 聚合成 dashboard 卡片 |

**G4 是 lcm 侧 L3.3（协同）的前置依赖。**

---

## 依赖与顺序

```
G0（读码+决策）→ G1（写入）→ G2（检索）→ G3（协同，可选）→ G4（对外）
                                    └──────────────────────→ lcm L3.3
```

G2.5 的配置面可与 G4.1 合并交付。

---

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **写入成本未知** | 全量回填可能很贵 | G1 先小样量测；G1.3 去重收敛；G1.5 跳过超长 scene |
| trigger 幻觉 | 噪声召回 | I1 硬门 + I2 只加不替 + I6 允许留空 |
| 硬门 0.85 过严导致几乎不触发 | 功能形同虚设 | 用 `reason` 里的 `n_dropped_by_gate` 观测；按实测调 |
| 与 M 抢权 | 排序互相打架 | G3.1 明确分权/衰减 |
| recall.ts 改动面大 | 回归风险 | I2 只加不替；默认关；回归测试锁定既有排序 |

---

## 未验证项（交付方须知）

1. **`recall.ts` / `schema.ts` / `nodes.ts` 未读** → 所有接入点为假设，G0 必须先证伪/证实。
2. **T-Mem §4.6 效率数字未核到**。
3. 论文指标数字来自二手报道（论文原文仅核到 "state-of-the-art on both LoCoMo and LoCoMo-Plus"）。
4. 未运行 T-Mem 代码、未复现评测；未在 gmp 上跑过任何东西。
5. 观测 HEAD 为 `406c08d`（`src/engine/embed.ts` blob `20d9263`），实际实施时版本可能已前进。
