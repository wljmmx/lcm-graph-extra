# PM × PD 双视角项目审计报告与演进路线

> 审计日期：2026-07-06
> 审计版本：v2.1.10
> 审计范围：`/workspace` 全仓（src / packages/dashboard / docs / CI / 测试）
> 审计方法：并行启动项目经理（PM）与产品经理（PD）两路独立审计，最终综合两份报告形成统一的下一阶段演进路线
> 审计基线：v1.0.0 ROADMAP 13 项已全部落地、本轮资源泄漏与消息顺序 P0/P1 已全量修复

---

## 审计概览

| 视角 | 综合评分 | 核心结论 |
|---|---|---|
| **项目经理（PM）** | 4.0 / 5.0 | 交付质量稳健、风险可控；CI 质量门禁与单文件膨胀是主要技术债 |
| **产品经理（PD）** | 4.2 / 5.0 | v1.0.0 功能完备；下一阶段重心应从"功能堆叠"转向"运营成熟 + 体验下沉" |
| **综合判定** | **B+（准 A）** | 具备进入 v1.1 运营成熟期的基础，需先关闭 6 项 P2 收尾与 1 项架构拆分 |

---

# 第一部分 · 项目经理视角审计报告

## 1. 审计维度与评分

| 维度 | 评分 | 说明 |
|---|---|---|
| 代码质量 | 4 / 5 | TypeScript 严格模式、单测 424+56、覆盖核心路径；`src/index.ts` 146KB 单文件需拆分 |
| 技术债务 | 4 / 5 | v1.0.0 ROADMAP 13 项全部落地；本轮 13 处 P0/P1 资源泄漏已清零；P2 残留 6 项 |
| CI / CD | 3 / 5 | 三 job 流水线（test / dashboard-test / build）已建；lint `continue-on-error: true` 使质量门禁失效 |
| 文档完整性 | 4 / 5 | CHANGELOG / ROADMAP / quick-start / faq / gm-pro-upgrade / 资源泄漏审计齐备；文档与测试统计存在不一致 |
| 风险评估 | 4 / 5 | 资源泄漏系统性修复后无阻塞性风险；降级链路完整但缺"输出有效性"校验 |
| 资源与进度 | 5 / 5 | v1.0.0 三批 13 项按依赖关系按时落地，无延期；本轮紧急修复在 24h 内闭环 |
| **综合** | **4.0 / 5.0** | — |

## 2. 已交付成果（项目经理视角）

### 2.1 v1.0.0 ROADMAP 全量落地

- **第一批 8 项（无 gm-pro 新 API 依赖）**：S-6' 场景隔离 / S-7' 用户画像 / S-9' 情节缓冲 / S-11' Zettelkasten / R-5' 动态混合 / N-1 Sync 升级 / N-2 Merger LLM 重排 / N-3 TTL-经验集成
- **第二批 4 项（依赖 gm-pro v2.1.10）**：R-2 成本感知级联 Tier 2/3 / G-8 LLM 异步验证回路 / S-8' 时间范围回顾 / N-4 健康指标导出
- **第三批 1 项**：G-10 主动遗忘命令

### 2.2 本轮（2026-07-05/06）紧急修复

| 类别 | 数量 | 详情 |
|---|---|---|
| P0 资源泄漏 | 8 | Neo4j Session 泄漏 / dispose 不完整 / SQLite 连接泄漏 / MCP session 并发竞态 / Promise.race timer 泄漏 等 |
| P1 稳定性 | 5 | 连接池兜底清理 / dispose 幂等 / connect 重复 acquire 守卫 / MCP 恢复后清空 sessionId |
| P0 消息顺序 | 3 | medium tier 丢弃全部原始消息 / high tier 只留 1 条 / fallback 只留 1 条 |
| P1 错误与稳定性 | 2 | better-sqlite3 ESM 兼容 / high-pressure compact timer 泄漏 |
| 可观测性 | 1 | QMD MCP 全链路 debug 日志 + SSE 格式解析 |
| 自愈能力 | 1 | snapshot server 心跳重试 |

### 2.3 测试与 CI

- 主包测试：424 通过
- dashboard 测试：56 通过
- CI：GitHub Actions 三 job 流水线（test / dashboard-test / build）

## 3. 项目经理视角发现的问题

### 3.1 P1 - 必须在 v1.1 关闭

| 编号 | 问题 | 影响 | 修复方向 |
|---|---|---|---|
| PM-1 | `src/index.ts` 单文件 146KB / 2944 行 | 维护成本高、merge 冲突频发、热重载慢 | 按 assemble / hooks / lifecycle / retrieval 拆分多文件 |
| PM-2 | CI lint `continue-on-error: true` | 质量门禁失效，lint 错误无法阻断 PR | 改为 false，先清理存量 lint 错误 |
| PM-3 | dashboard 版本号 0.1.0 ≠ 主包 2.1.10 | 发版混乱、依赖追踪困难 | 同步为 2.1.10，CI 增加版本一致性校验 |
| PM-4 | 文档测试统计与实际不一致 | 文档可信度下降 | CHANGELOG 测试数字以 `npm test` 实际输出为准 |

### 3.2 P2 - 短期收尾（本轮审计遗留）

| 编号 | 问题 | 状态 |
|---|---|---|
| PM-5 | 26+ 处空 catch 块未补日志 | 待补 |
| PM-6 | qmd-client `status()` 仅走 MCP，无 CLI fallback | 待补 |
| PM-7 | timer `.unref()` 全局未补齐 | 待补 |
| PM-8 | 缺 SIGTERM/SIGINT 优雅退出 handler | 待补 |
| PM-9 | 缺 dispose 后置断言测试（资源是否真的释放） | 待补 |
| PM-10 | 缺端到端"重载不泄漏"集成测试 | 待补 |

### 3.3 风险评估

| 风险项 | 等级 | 对策 |
|---|---|---|
| 单文件膨胀导致协作阻塞 | 中 | v1.1 第一优先拆分 `src/index.ts` |
| 降级路径缺"输出有效性"校验 | 中 | 见 PD-3，v1.1 增加 fallback 输出 schema 校验 |
| CI 质量门禁失效累积技术债 | 中 | PM-2 立即关闭 |
| gm-pro 可选依赖在未安装环境下行为未明 | 低 | 已有 fallback，但缺端到端验证 |

## 4. 项目经理视角结论

- **交付能力**：强。13 项 ROADMAP + 13 处 P0/P1 + 3 处消息顺序 P0 全部按时闭环。
- **质量基础**：稳。单测 480 通过，无回归；本轮所有修复均补测。
- **主要技术债**：`src/index.ts` 膨胀 + CI 门禁失效。这两项是阻塞性债务，必须在 v1.1 优先偿还。
- **下一阶段建议**：进入"运营成熟期"，重心从功能交付转向稳定性 + 可观测性 + 架构健康度。

---

# 第二部分 · 产品经理视角审计报告

## 1. 产品定位与价值主张

| 维度 | 现状 |
|---|---|
| 定位 | OpenClaw 的"上下文编排层"——四层检索 + 经验层 + 压力感知 + 16 工具 |
| 用户画像 | AI Agent 开发者 / 长对话应用构建者 / 需要可解释记忆的团队 |
| 核心价值 | ① 压力感知的上下文裁剪 ② 四层并行检索降级链 ③ 经验层自蒸馏 ④ 16 工具可观测可维护 |
| 差异化 | PressureTier + debt-manager + experience distillation 三件套，竞品（Mem0/Zep）无对应 |

## 2. 功能完整度审计

### 2.1 ROADMAP v1.0.0 落地情况

| 批次 | 项数 | 落地 | 缺口 |
|---|---|---|---|
| 第一批（补强） | 8 | 8 | 无 |
| 第二批（自主进化） | 4 | 4 | 无 |
| 第三批（用户控制） | 1 | 1 | 无 |
| **合计** | **13** | **13** | **0** |

**结论**：v1.0.0 ROADMAP 100% 落地。

### 2.2 16 个 MCP 工具完整度

| 工具 | 完整度 | 缺口 |
|---|---|---|
| lcmg_search / backup / restore / import / pin / forget / sync | 完整 | — |
| lcmg_qmd_status / get_document / batch_get / maintain / diagnose | 完整 | — |
| lcmg_experience_report / distill / compact / reset_breaker | 完整 | — |

**结论**：16/16 完整，1 处体验缺口（`lcmg_qmd_status` 在 MCP 不可用时无 CLI fallback）。

### 2.3 7 个生命周期钩子

| 钩子 | 触发 | 现状 |
|---|---|---|
| assemble | 每轮请求 | ✅ 三引擎并行 + PressureTier 裁剪 + Merger 重排 |
| afterTurn | 每轮结束 | ✅ G-8 验证回路 + S-9' 语义边界判断 |
| heartbeat | 5min | ✅ 健康指标 + TTL 清理 + 蒸馏调度 + snapshot 重试 |
| compact | 触发式 | ✅ 300s timeout + AbortSignal + debt-manager |
| dispose | 卸载/重载 | ✅ 幂等 + 全资源清理 + 单例置 null |
| distillOne | heartbeat 2h | ✅ LLM 蒸馏 + link 生成 |
| pre-emptive compaction | ratio>0.65 | ✅ 触发式 |

### 2.4 Dashboard 4 视图

| 视图 | 完整度 | 缺口 |
|---|---|---|
| MonitorView | 完整 | — |
| ExperienceView | 完整 | — |
| MemoryView | 完整 | — |
| MaintainView | 完整 | — |

## 3. 产品经理视角发现的问题

### 3.1 PD-1 · 降级链路缺"输出有效性"校验

- **现象**：所有降级路径（gm-pro → Cypher → degree / MCP → CLI / L4 失败 → 空数组）只校验"是否拿到数据"，不校验"数据是否有效"。
- **影响**：降级返回的空数组 / 默认排序会被上游当作"有效结果"使用，导致用户感知到"上下文变差但无告警"。
- **修复方向**：在 `assemble` 出口增加 schema 校验 + 降级标记位（`degraded: true`），上层可据此调整 prompt 或提示用户。

### 3.2 PD-2 · 缺端到端用户体验指标

- **现象**：有 424 + 56 单测、Prometheus 指标，但无"用户感知"层指标（如：上下文相关性评分、降级触发频率、Token 节省率）。
- **影响**：无法量化"功能完备 ≠ 体验好"。
- **修复方向**：v1.1 引入 UX 指标面板，至少包含：① 降级触发次数/分钟 ② 平均 Token 节省率 ③ 经验层命中率 ④ Tier 1 置信度分布。

### 3.3 PD-3 · 单文件膨胀影响"上手体验"

- **现象**：`src/index.ts` 146KB / 2944 行，新开发者阅读门槛极高。
- **影响**：社区贡献门槛高、PR 评审困难、文档与代码同步成本高。
- **修复方向**：与 PM-1 一致，按职责拆分。

### 3.4 PD-4 · 缺 onboarding 验证路径

- **现象**：quick-start 文档齐全，但缺"5 分钟验证插件是否工作"的端到端脚本。
- **影响**：新用户安装后无法快速自证可用。
- **修复方向**：提供 `npm run smoke` 一键冒烟脚本（覆盖 MCP ping / Neo4j ping / assemble / snapshot server）。

### 3.5 PD-5 · Dashboard 缺"降级状态"可视化

- **现象**：MonitorView 显示压力信号 + 熔断器状态，但不显示"当前是否处于降级路径"。
- **影响**：用户无法一眼判断"系统现在是否在 fallback 模式"。
- **修复方向**：MonitorView 增加"降级链路状态"卡片，实时展示 L1/L2/L3/L4 + gm-pro 各路径当前状态。

## 4. 竞品差异化分析

| 能力 | 本项目 | Mem0 | Zep | 差异化结论 |
|---|---|---|---|---|
| 压力感知裁剪 | ✅ PressureTier 三级 | ❌ | ❌ | **独家** |
| 债务调度压缩 | ✅ debt-manager | ❌ | ✅ 简化版 | **领先** |
| 经验层自蒸馏 | ✅ distillOne + LLM | ✅ 简化 | ❌ | **领先** |
| 四层并行检索 | ✅ L1+L2+L3+L4 | ❌ 单层 | ❌ 单层 | **独家** |
| 成本感知级联 | ✅ R-2 Tier 1/2/3 | ❌ | ❌ | **独家** |
| 可观测 Dashboard | ✅ 4 视图 + Prometheus | ❌ | ✅ 简化 | **领先** |
| 主动遗忘 | ✅ G-10 soft/hard | ✅ | ❌ | 持平 |

**结论**：6 项独家/领先能力，差异化护城河已建立。

## 5. 产品经理视角结论

- **功能完备性**：v1.0.0 100% 落地，16 工具 + 7 钩子 + 4 Dashboard 视图齐备。
- **体验短板**：降级路径缺有效性校验、缺 UX 指标、单文件膨胀影响上手。
- **差异化**：6 项独家/领先能力，护城河稳固。
- **下一阶段建议**：从"功能完备"转向"运营成熟 + 体验下沉"，重点投资 PD-1/PD-2/PD-5。

---

# 第三部分 · 综合演进路线计划（v1.1 运营成熟期）

## 1. 路线原则

综合 PM（架构健康度、CI 门禁、技术债）与 PD（体验下沉、UX 指标、降级有效性）两份报告，v1.1 阶段遵循以下原则：

1. **先还债，后增量**：PM-1/PM-2/PM-3 三项阻塞性债务优先偿还，再新增功能。
2. **体验下沉优先于功能扩展**：PD-1/PD-2/PD-5 三项体验短板优先于新能力。
3. **不破坏 v1.0.0 既有契约**：所有变更保持 16 工具 + 7 钩子 + 4 Dashboard 视图 API 向后兼容。
4. **测试先行**：所有新功能必须先写测试，CI lint 必须从 `continue-on-error: true` 改为 false。

## 2. v1.1 演进路线（分三批，共 12 项）

### 第一批：还债与门禁（阻塞项，无新功能依赖）

| 编号 | 来源 | 项目 | 验收标准 | 优先级 |
|---|---|---|---|---|
| v1.1-1 | PM-1 / PD-3 | `src/index.ts` 拆分 | 单文件 < 50KB，按 assemble/hooks/lifecycle/retrieval 拆 4-6 文件 | P0 |
| v1.1-2 | PM-2 | CI lint 质量门禁激活 | `continue-on-error: false`，存量 lint 错误清零 | P0 |
| v1.1-3 | PM-3 | 版本号统一 | dashboard 0.1.0 → 2.1.10，CI 增加版本一致性校验 | P0 |
| v1.1-4 | PM-4 | 文档测试统计对齐 | CHANGELOG 测试数字以 `npm test` 实际输出为准 | P1 |

### 第二批：体验下沉与可观测性（依赖第一批拆分完成）

| 编号 | 来源 | 项目 | 验收标准 | 优先级 |
|---|---|---|---|---|
| v1.1-5 | PD-1 | 降级输出有效性校验 | assemble 出口增加 schema 校验 + `degraded` 标记位 | P0 |
| v1.1-6 | PD-2 | UX 指标面板 | Dashboard 新增：降级频率 / Token 节省率 / 经验命中率 / Tier1 置信度分布 | P1 |
| v1.1-7 | PD-5 | Dashboard 降级状态可视化 | MonitorView 新增"降级链路状态"卡片 | P1 |
| v1.1-8 | PD-4 | onboarding 冒烟脚本 | `npm run smoke` 一键验证 MCP/Neo4j/assemble/snapshot | P2 |

### 第三批：稳定性收尾与架构健康（独立可并行）

| 编号 | 来源 | 项目 | 验收标准 | 优先级 |
|---|---|---|---|---|
| v1.1-9 | PM-5 | 空 catch 块补日志 | 26+ 处空 catch 全部补 warn/debug 日志 | P2 |
| v1.1-10 | PM-6 | qmd-client status() CLI fallback | MCP 不可用时降级到 `qmd status` CLI | P2 |
| v1.1-11 | PM-7 / PM-8 | timer `.unref()` + SIGTERM/SIGINT handler | 所有 timer 调用 `.unref()`，新增优雅退出 handler | P2 |
| v1.1-12 | PM-9 / PM-10 | 资源释放断言测试 + 重载不泄漏集成测试 | dispose 后断言连接池为空；模拟 reload 10 次无句柄增长 | P2 |

## 3. 依赖关系图

```
第一批（还债，阻塞所有第二批）
  v1.1-1 (拆分 index.ts) ─┬─→ v1.1-5 (降级校验，需在拆分后的 assemble 出口加)
  v1.1-2 (CI 门禁)        ─┼─→ v1.1-6 (UX 指标，需 CI 通过)
  v1.1-3 (版本统一)        ─┼─→ v1.1-7 (Dashboard 降级可视化)
  v1.1-4 (文档对齐)        ─┘
                            ↓
第二批（体验下沉，依赖第一批拆分完成）
  v1.1-5 / v1.1-6 / v1.1-7 / v1.1-8 可并行
                            ↓
第三批（稳定性收尾，独立可并行，不阻塞前两批）
  v1.1-9 / v1.1-10 / v1.1-11 / v1.1-12
```

## 4. 验收里程碑

| 里程碑 | 完成项 | 验收命令 |
|---|---|---|
| M1 - 还债完成 | v1.1-1/2/3/4 | `wc -c src/index.ts` < 50KB；CI lint 不再 continue-on-error；dashboard 版本 = 2.1.10 |
| M2 - 体验下沉完成 | v1.1-5/6/7/8 | assemble 输出含 `degraded` 字段；Dashboard 显示 UX 指标 + 降级状态；`npm run smoke` 通过 |
| M3 - 稳定性收尾 | v1.1-9/10/11/12 | 空 catch 块 = 0；reload 10 次句柄数无增长 |

## 5. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| `src/index.ts` 拆分引入回归 | 高 | 拆分前先补"拆分前行为快照"测试，拆分后跑全量 424+56 用例 |
| CI lint 关闭 continue-on-error 后阻塞所有 PR | 中 | 先单独提一个 PR 清理存量 lint 错误，再关闭开关 |
| 降级校验误报（误判有效输出为降级） | 中 | `degraded` 标记初版只读不阻塞，观察 1 周后决定是否参与 prompt 调整 |
| Dashboard 版本号升级影响已发布产物 | 低 | dashboard 私有包，无外部消费者，直接升级 |

## 6. 不在 v1.1 范围内的事项

明确排除以下内容，避免 v1.1 范围蔓延：

- 新增 MCP 工具（v1.0.0 已 16 个，足够）
- 新增检索层（四层已足够）
- 重写经验层（distillOne 已稳定）
- 多租户 / RBAC（不在当前用户画像内）
- 非 OpenClaw 网关适配（保持单网关专注）

## 7. 版本信息

- **规划版本**：v1.1.0（运营成熟期）
- **基线**：v2.1.10（v1.0.0 ROADMAP 全量落地后）
- **规划日期**：2026-07-06
- **任务总数**：12 项（第一批 4 + 第二批 4 + 第三批 4）
- **依赖**：无新 gm-pro API 依赖，全部基于 v2.1.10 既有能力
- **来源**：综合 PM 审计（PM-1~PM-10）与 PD 审计（PD-1~PD-5）形成

---

## 附录 · 审计方法说明

### 审计流程

1. 并行启动 PM 与 PD 两路独立审计 agent，互不干扰
2. PM 审计覆盖：代码质量 / 技术债务 / CI-CD / 文档 / 风险 / 资源进度 六维
3. PD 审计覆盖：产品定位 / 功能完整度 / UX / 降级链路 / 竞品 / 用户反馈 / 演进建议 七维
4. 综合两份报告，剔除重复项，按依赖关系排序，形成 v1.1 三批 12 项路线

### 审计依据

- 代码：`/workspace/src` 全目录 + `/workspace/packages/dashboard`
- 文档：CHANGELOG / ROADMAP / quick-start / faq / gm-pro-upgrade / resource-leak-audit
- 测试：主包 424 通过 + dashboard 56 通过
- CI：`.github/workflows/ci.yml`
- 历史：本轮 3 次 commit（资源泄漏修复 / 消息顺序修复 / QMD MCP debug 日志）

### 评分标准

- 5.0：行业领先，无短板
- 4.0：稳健交付，存在可改进项
- 3.0：及格，存在明显短板
- 2.0：不及格，存在阻塞性问题
- 1.0：不可交付
