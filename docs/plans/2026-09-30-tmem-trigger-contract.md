# T-Mem 借鉴：trigger 契约（两侧唯一事实来源）

> 依据：腾讯 T-Mem（EMNLP 2026，arXiv:2606.15405），代码 `github.com/Sherlockwz/T-Mem`。
> 本文是 **lcm-graph-extra** 与 **graph-memory-pro** 之间的接口契约。
> **任何一侧改动此文件的结构，必须同步另一侧**——历史上 JSON schema 与 TypeBox 漂移导致过整份配置被宿主拒绝，接口契约同理。

## 1. 触发空间（T-Mem 的 2×2）

| | descriptive（表面相似） | associative（潜在关联） |
|---|---|---|
| **item**（单条事实/经验） | **QI Entity**：比宿主高 1~2 级的 is-a 命名 | **QII Bridge**：`P(宿主相关 \| 该场景被提及)` 高的具体场景 |
| **scene**（成段对话/场景） | **QIV Scene**：对 cue 本身的 4 属性描述 | **QIII Horizon**：沿对话向前推演的跨步预期 |

现有两侧机制覆盖情况：QI ✅（tags/freeTags/relatedConcepts + cjk 全文 + 向量）、QIV ⚠️ 半个、**QII ❌**、**QIII ❌**。

## 2. 数据结构

```
Trigger {
  id: string                  // 稳定 id（去重后 canonical）
  hostId: string              // 宿主 id（item 或 scene）
  hostKind: 'item' | 'scene'
  family: 'entity' | 'bridge' | 'horizon' | 'scene'
  text: string                // entity/bridge: 2~6 词名词短语；horizon/scene: 一句（<=35 词）
  bridge?: string             // 仅 entity/bridge：'<取自宿主的线索> -> <一步推理>'
  relationship?: string       // horizon 用：causal | state | goal | value
  confidence: number          // [0,1]
  activationPatterns?: string[]
  createdAt: number           // ms——**去重 canonical 选择依赖它，必须稳定**
  quality: number             // = max(confidence over hosts)；由实现派生，不手填
}

TriggerRecallResult {
  triggered: boolean
  reason: string              // 必须可读，用于观测（I4）
  top1: { triggerId, family, cosine } | null
  hosts: Array<{ hostId, viaTriggerId, cosine, confidence }>
}
```

## 3. 不变式（违反即等于回归，不是"风格差异"）

| # | 不变式 | 内容 | 依据 |
|---|---|---|---|
| **I1** | 硬门 | `minCosineGate` 默认 **0.85**；未过门 → `triggered=false` | T-Mem `trigger_recaller.py` 默认 0.85，注释自称 "HIGH, additive-safe" |
| **I2** | 只加不替 | trigger 通道**不参与**既有 top-K 排序/打分，只做追加 | 否则补盲区的同时污染原高精度路径 |
| **I3** | 默认关 | opt-in；配置缺省 = 完全不启用 | T-Mem 源码："default OFF if caller never instantiates" |
| **I4** | 可观测 | 每次召回必须回 `reason`（含命中 gate 值、被门拦下的数量）与命中来源 | 用于区分"联想命中/相似度命中" |
| **I5** | 去重确定性 | canonical 选择按 `createdAt` 排序，**不得依赖容器迭代顺序** | T-Mem 源码有一条 CRITICAL 注释专讲此点 |
| **I6** | 允许留空 | 生成侧不得强填；无信号通道 `confidence=0`、`text` 缺省 | T-Mem 原文：*"Hallucination hurts recall more than a missing channel"* |

## 4. 生成侧规则（提示词必须包含的负面清单）

来源：T-Mem `trigger_prompts.py`

| family | 只接受的两条路 | 明确禁止（须写进提示词） |
|---|---|---|
| entity / bridge | **Route A 语义锚**：宿主向上 1~2 级的 is-a 命名<br>**Route B 强关联场景**：命名该场景即几乎必然想起本宿主 | **Restatement**（换词复述宿主）<br>**Over-general**（放之四海）<br>**Weakly-predictive**（不能可靠指向本宿主） |

T-Mem 给的实例（可直接用作少样本示例）：

- 宿主：*"Tim developed urticaria after eating shrimp at a dinner party"*
- ✅ Route A：`seafood sensitivity` / `food allergy` / `allergic reaction`
- ✅ Route B：`seafood buffet` / `ordering at a sushi bar`
- ❌ `shrimp allergy`（Restatement）、`health issue`（Over-general）、`EpiPen in a purse`（Weakly-predictive）

置信度分档（照抄）：

- `[0.8, 1.0]` 紧致中层锚 / 几乎必然命中的场景
- `[0.5, 0.8)` 清晰上层锚 / 强关联场景
- `[0.3, 0.5)` 较宽泛上位 / 中等关联场景
- `[0.0, 0.3)` 过于宽泛或弱预测 —— **宁可不产出**

`bridge` 字段格式：`<从宿主原文取出的线索> -> <一步推理>`；推理必须是真实语义步（归类 / 因果蕴含 / 决策相关性），**禁止写类型标签**（不得出现 "semantic anchor" 这类词）。

## 5. 去重与收敛（写入侧的成本闸门）

照抄 T-Mem `TriggerGraph.dedup_entity_bridge()`：

1. 先按 `concept_norm`（text 的小写去空白规范形）**精确匹配**
2. 再按 `rapidfuzz.ratio >= 0.9` 模糊匹配（JS 侧用等价实现的字符串相似度）
3. 命中 → `merge_from(other)`：逐 `hostId` 取 `confidence` **最大值**；`activationPatterns` 并集；**保留先出现者的 text**
4. **按 `createdAt` 升序遍历**，保证 canonical 选择确定性（I5）
5. 构建期过滤：`confidence < 0.70` 的宿主关联剔除
6. **保留"已无宿主"的 trigger**——其 `activationPatterns` 在召回时仍可能贡献（T-Mem 源码显式注释）

## 6. 效率约束

| 约束 | 值 | 来源 |
|---|---|---|
| 超过 N 轮的 scene 跳过抽取 | `N_TURNS_SKIP = 10` | T-Mem 源码 |
| 单请求批量 embedding 文本数 | 32（可配） | 两侧已对齐 |
| trigger 生成成本 | **未知**——T-Mem 论文 §4.6 效率分析未核到 | 见下方"未验证" |

## 7. 未验证项（不得当成已确认）

1. **T-Mem 论文 §4.6（构建开销/问答时延）未读到**（WebFetch 在 §3.1 截断）→ 写入侧 LLM 成本的**具体数字未知**。这是本方案最大未知。
2. 论文指标（LoCoMo 80.26% / LoCoMo-Plus 74.81% / 差距收到 5.45pp）来自**二手报道**；论文原文只核到 "state-of-the-art on both LoCoMo and LoCoMo-Plus"。
3. 未运行 T-Mem 代码、未复现评测。以上全部来自**读论文 + 读其源码**。
4. graph-memory-pro 的 `src/recaller/recall.ts`(33KB)、`src/store/schema.ts`(20KB)、`src/store/nodes.ts`(31KB) **未读** → gmp 侧的接入点是**待验证假设**。

## 8. 两侧分工

| | graph-memory-pro | lcm-graph-extra |
|---|---|---|
| 拥有宿主 | 对话记忆（scene/item 本体） | 工程经验（`:EXPERIENCE`） |
| 生成 | QI/QII/QIII/QIV 全部 | 仅 QII/QIII（经验的 bridge/horizon） |
| 存储 | trigger 独立节点 + 向量属性 | 经验节点属性（逗号串，与 `tags_free` 同构） |
| 检索 | trigger-aware 索引 + 级联/bypass | 独立关联通道（只加不替） |
| 对外 | 暴露配置面 + 重建接口 | 配置面、注入装配、可观测、回填工具 |
