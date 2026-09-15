# lcm-graph-extra 稳定性与效率审计 + 优化方案

> 依据 **Staff Engineer Mode** 路由：`primary: dependency-resilience` / `secondary: performance-and-capacity`（confidence: high）
> 推断意图：对项目逐模块 / 逐功能验证，产出**稳定性（依赖韧性/过载）与效率（容量/尾部延迟）**的完整分析与优化方案；工作阶段：维护期（maintenance）。
> 本文件包含实测验证证据（2026-09-15 沙箱环境执行）。

---

## 0. 验证结果总览（实测）

| 验证项 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 依赖安装 | `npm install` | ❌ 失败 | 沙箱 Node v24.1.0 不满足 openclaw 引擎约束 `>=24.16.0 <25 \|\| >=26.1.0`，preinstall 中止；需 `--ignore-scripts` 或升级 Node |
| 主包类型检查 | `npx tsc --noEmit` | ✅ exit 0 | 无类型错误 |
| 主包 Lint | `npm run lint` | ⚠️ 0 errors / **1291 warnings** | 几乎全为 `no-explicit-any` / `eqeqeq` 卫生债 |
| 主包测试 | `npm test` | ✅ **52 文件 / 1164 项全过**（36s） | README 记录的 458 项已过时 |
| Dashboard 类型检查 | `npx tsc --noEmit` | ✅ exit 0 | |
| Dashboard 测试 | `npx vitest run` | ✅ **11 文件 / 153 项全过**（38s） | README 记录的 63 项已过时 |
| 合计 | — | ✅ 63 文件 / **1317 项测试**全部通过 | 无失败、无跳过 |

### 关键环境结论（dev-environment-parity）

1. **仓库未声明 Node engines / .nvmrc** —— 实测默认 Node 24.1.0 下 `npm install` 直接失败，而 CI 用 Node 26。开发者在新环境会因引擎约束踩坑。**P0 修复**：根 `package.json` 加 `engines: { node: ">=24.16.0 <25 || >=26.1.0" }` + 提交 `.nvmrc`（`26`），并让 dashboard 子包同步。
2. **better-sqlite3** 为 optional（原生构建需与 Node 匹配），有 JSON 降级兜底；测试环境无原生绑定也可全绿（node:sqlite 内建模块覆盖）。

---

## 1. 逐模块验证矩阵

> 结论口径：✅ 通过（无阻断问题）/ ⚠️ 有改进项（已在第 6 节编号）/ ❓ 待确认（给出验证方法）

| 模块 | 验证结果 | 稳定性判断 | 效率判断 | 主要发现（详见 §6） |
|---|---|---|---|---|
| `src/index.ts`（组合根/心跳/Total Control） | ✅ 测试覆盖 | 良好 | 良好 | 会话级缓存均有 TTL+上限；`committedTurnKeys` 2000 上限；2.1.13 主轮门控修复已落地 |
| `retrieval-gateway.ts`（四引擎检索） | ✅ 检索网关测试 | 良好 | 良好 | 每引擎显式超时 15000ms + 慢查询 1000ms 告警；失败降级为空（不抛错）；O7 预取把检索移出用户路径 |
| `merger.ts`（去重/衰减/重排） | ✅ merger 测试 | 良好 | 良好 | 纯 CPU 路径，无外部 IO；LLM 重排可选（能力开关） |
| `cascade-manager.ts`（级联+Thompson） | ✅ 单例 + 快照 | 良好 | 良好 | Tier2/3 有 60s/90s 超时且失败回填未验证；arm LRU 5000 上限 |
| `circuit-breaker.ts` | ✅ 8 项测试 | 良好 | 良好 | 阈值 3 / 冷却 30s / 半开单探测；失败计数 clamp(threshold*2) 防无界（P-CB-3）⚠️ 二进制开关 vs AIMD（建议项） |
| `adapters/graph-adapter.ts` + `connection-pool.ts` | ✅ 连接池测试 | 良好 | 良好 | 驱动级连接池引用计数+主动刷新；连接重试有限（3 次+冷却） |
| `adapters/embed-fn.ts` | ✅ embed 测试 | 良好 | 良好 | 新旧端点回退；keep_alive=1h；LRU 缓存 |
| `adapters/openclaw-agent-db.ts` | ✅ 测试 | 良好 | 良好 | 只读 + TTL 缓存 + LIKE 转义 |
| `experience/`（存储/蒸馏/Tag/UserProfile） | ✅ store/recall 测试 | 良好 | 良好 | FAILED 自动重试（上限 3）+ 手动重置工具；G-8 校验回路 |
| `moa/` | ✅ classifier/learning/orchestrator 测试 | 良好 | 良好 | 复杂度 0.6 阈值、能力校准、token 学习 |
| `core/debt-manager.ts` + `lcm-bridge.ts` | ✅ lifecycle/ttl 测试 | 良好 | 良好 | 债务写入 5min 频控；压力分级三档；SQLite PRAGMA/WAL/mmap 已优化 |
| `async/`（任务注册/门控/Ollama 槽位/预取队列） | ✅ task-registry 测试 | 良好 | 良好 | `ollamaSlot` 并发信号量（2）= 舱壁；主轮门控 = 优先级卸载 ❓ task-registry 是否有界需复核 |
| `plugin/`（dedup/goal/overhead/SAD/token-control） | ✅ token-control 测试 | 良好 | 良好 | 会话级隔离 + 过期淘汰 |
| `utils/llm-call.ts` | ✅ llm-call 测试 | 良好 | 良好 | 统一超时/头注入；未见无限重试 |
| `middleware/lossless-claw-adapter.ts` | ✅ lossless 测试 | 良好 | 良好 | 4 路 CE Factory 发现，重试 4 次有界+退避 10s/30s/60s |
| `dashboard-snapshot.ts`（:7423） | ✅ 测试 | 良好 | 良好 | IP 白名单 + Basic Auth + 限流 + 端口占用探测；`requestTimeout=0` 为长任务专项 ⚠️ |
| `dashboard server/`（Fastify :7421） | ✅ server 测试 | 良好 | 良好 | Basic Auth/CORS/写限流/白名单/安全头；`/api/mcp/invoke` 路径硬校验 ⚠️ `runWriteQuery` 直连写入口 |
| `dashboard 前端`（Vue3） | ✅ client 测试 | 良好 | 良好 | 14 路轮询集中 in-useMonitorData；无 v-html 注入风险 ⚠️ 轮询频率/批量请求可再收敛 |
| `scripts/`（smoke/verify-ce/docker-security） | ✅ smoke 逻辑 | 良好 | — | Docker 启动安全门禁完善 |
| CI（6 job） | ✅ 按配置核验 | 良好 | — | audit+CodeQL+版本一致性；lint 因 warnings 不失败 ⚠️ 建议 `--max-warnings` |

---

## 2. 依赖韧性矩阵（Dependency Resilience Matrix）

### 2.1 依赖契约

| 依赖 | 操作 | 关键度 | 超时 | 重试 | 幂等 |
|---|---|---|---|---|---|
| QMD（REST / MCP / CLI） | 检索(`query`/`multiGet`) | 高（L2） | MCP 3s / 查询 30s / CLI 30s | MCP→REST→CLI 三级降级；无无限重试 | 只读检索，天然幂等 |
| Neo4j / gm-pro（bolt + HTTP） | 图检索/写入/维护 | 高（L3/L4） | graphLlm 90s；整体 15s 检索预算 | 连接重试 3 次+冷却；breakTo retry(1) | `MERGE` 幂等；batchUpsert 幂等 |
| Ollama | 嵌入 + 蒸馏 LLM | 中 | embed 60s / distill 120s | 无自动重试（槽位信号量限制并发） | 蒸馏有 FAILED retryCount 上限 3 |
| OpenClaw 主模型 LLM | 重排/判断/验证/摘要 | 中 | 30–90s 分档（llmTimeouts） | withCircuitBreaker 单次重试（指数退避 1000·2ⁿ） | 重排/判断仅反馈记录，幂等 |
| lcm.db（SQLite） | 桥接读写 | 高（本地） | — | 单连接复用 | 债务写 5min 频控；durable-turn 幂等键 |
| OpenClaw host（status） | 健康检查 | 低 | 5s | 无 | 只读 |
| gm-pro HTTP 服务（dashboard 代理） | 读/写/流 | 中 | GET 5s / 长任务 30min | 无（SSE 流式） | 代理有路径白名单 |
| 插件 snapshot（:7423，dashboard 调用） | 内存态/健康/mcp-invoke | 高 | 5s（snapshot）/ 按工具 10s–60min | 无 | mcp-invoke 由工具处理幂等 |

### 2.2 失败行为与回退

| 依赖 | 熔断/快速失败策略 | 回退 | 失败行为 | 响应路径 |
|---|---|---|---|---|
| QMD | 熔断（threshold 3 / 30s 半开） | REST→CLI→空结果 | 返回空数组，不抛错；记慢查询告警 | `searchWithExperience` 降级其它引擎 |
| Neo4j | 熔断 + 连接自愈 | 空结果 / superseded 过滤 | 检索空、写跳过并记 ConflictLog | 降级到 L2/L4 |
| gm-pro 扩展 API | 无 | `withGmProFallback()` 降级 | 扩展能力不可用时走本地实现 | 半降级 |
| Ollama | 槽位信号量（并发 2） | OpenAI/compat 或本地嵌入 | 排队而非失败 | 压力分级降低检索配额 |
| 蒸馏 LLM | FAILED+retryCount | 下轮自动重试（≤3） | 标记 FAILED，可手动重置 | G-8 校验回路 |

### 2.3 外部依赖信号与健康检查

| 检查 | 类型 | 说明 | 依赖调用 |
|---|---|---|---|
| Docker `HEALTHCHECK /api/ping` | 存活 | 无依赖调用 ✅ | 无 |
| `/internal/health`（:7423） | 存活 | 返回 `{ok,ts}`，用于残留/存活探测 | 无 |
| `/internal/snapshot` | 就绪 | 聚合内存态，单 provider 隔离异常 | 内存态 |
| `GET /api/agent/status` | 就绪（外部） | host 状态，5s 超时降级 | host |
| qmd/neo4j 熔断快照 | 依赖 | `getHealthSnapshot()` 暴露 | 各依赖 |

> 按 specialist 红线：满足「存活探针不调用共享依赖」「就绪仅查直接依赖」「熔断有半开探测与恢复条件」三项。

---

## 3. 超时与重试预算

| 调用方 | 依赖 | 预算 | 退避/抖动 | 可重试条件 | 过载停止信号 |
|---|---|---|---|---|---|
| 检索网关 | 四引擎合计 | 全局 15000ms | 无（单次） | 无自动重试，超时→空 | 熔断 OPEN 直接抛错 |
| 断路器包装 | 任一子系统 | 与调用方一致 | 1000·2ⁿ 指数退避 | 仅首次失败重试 1 次（R-7 只计最终失败） | OPEN 状态不重试 |
| graph-adapter | Neo4j 连接 | connect 窗口 | 冷却 cooldown | 连接尝试 3 次上限 | 达上限后按周期自愈 |
| 蒸馏 | 蒸馏 LLM | 120s/条 | 下轮重试 | FAILED 且 retryCount<3 | 主轮门控让路 |
| lossless-claw 工厂 | engine 发现 | 10s/30s/60s 退避 | 指数 | 4 次上限 | 返回降级 |

**结论**：全链路满足「有界、单层、带预算、有终止」——未发现无限重试 / 无超时调用。（特例：dashboard `requestTimeout=0`，但已由 MCP 工具级超时表覆盖长任务，属经过设计的选择。）

---

## 4. 过载行为、队列与批量

| 路径 | 控制机制 | 同步行为 | 异步行为 | 阈值 |
|---|---|---|---|---|
| 主轮 vs 后台 | `main-turn-gate` 门控 | 主轮优先 | 后台让路/暂停 | 主轮进行中 |
| Ollama 并发 | `ollamaSlot` 信号量 | 排队 | 排队 | 并发 2 |
| 蒸馏/压缩 | 债务调度 + 蒸馏并发 | — | 轮间异步、主轮外执行 | `LCMG_DISTILL_CONCURRENCY=3` |
| O7 预取 | 预取队列 coalesce | — | 有界并发 + 相似 query 合并 | — |
| 压力分级 | PressureTier 降配额 | medium/high 立即降级注入预算 | compact 债务异步 | msg/ratio 阈值（0.70/0.85） |
| 视图层轮询 | useMonitorData 定时 | — | 14 路轮询（10s–120s） | — |

> specialist 提示采纳：过载时优先 `LIFO`、剩余截止时间跨跳透传 —— 当前债务调度按优先级处理，建议在 `debt-manager` 中确认按「剩余预算/新鲜度」而非纯 FIFO。

---

## 5. 性能与容量（Performance & Capacity）

### 5.1 用户侧目标（现有 vs 建议）

| 旅程 | 边界 | 分位 | 目标 | 现状 |
|---|---|---|---|---|
| assemble 注入 | 插件出口（assemble 返回） | p95/p99 | 检索预算 ≤15s（slowSearch 告警 1s） | 已有 `lastAssembleMs` / L2/L3/L4 延迟直方图（P50/90/95/99）采集 ✅ |
| lcmg_search 工具 | MCP 返回 | p95 | 同上继承 | 同 ✅ |

### 5.2 热路径/热点分析（已验证）

| 热点 | 证据 | 现状 | 优化方向 |
|---|---|---|---|
| token 估算 | 200–400ms/次 | 30s TTL 缓存 ✅ | 保持 |
| 检索结果 | l2/l4 缓存 5min TTL + LRU | 上限 50/200 ✅ | 保持，关注命中率指标 |
| SQLite 访问 | 预编译 statement + PRAGMA（WAL/cache/mmap） | 已优化 ✅ | 心跳只读 mtime 缓存已落地（P2-2） |
| Neo4j | 连接池引用计数 + 主动刷新 + searchCacheSize=50 | 已优化 ✅ | 关注池等待（Little's Law 校验） |
| 预取（O7） | assemble 消费上轮预取 | 检索移出用户路径 ✅ | 查询相似度 coalesce 已有 |

### 5.3 后台工作预算

| 后台路径 | 共享资源 | 限制/调度 | 预占行为 |
|---|---|---|---|
| 蒸馏 | 本地 LLM/Ollama | cron 3:00 + 12h 增量 + 手动 | FAILED 重试 ≤3；主轮让路 |
| TTL 清理 | CPU/DB | 每 24h | 窗口化清理 + 权重衰减 |
| 债务压缩 | CPU/DB/Ollama | 轮间异步，maxConcurrent 受控 | 主轮让路 |
| 健康采集 | DB | 每 5min | 环形缓冲 144（12h） |

### 5.4 负载测试现状与缺口

| 方法 | 场景 | 证据 | 缺口 |
|---|---|---|---|
| 单测/集成 | 全工程 1317 项 ✅ | 本次实测全绿 | — |
| 性能基准 | `test/perf/*` + dashboard Benchmark（BEIR/内置 fixtures/SSE） | test-perf/CE-report.md | ❓ 无「拐点/断裂点」记录：pending `saturation` 压力测试到非线性点，记录启动就绪时间与压力后恢复时间 |
| 故障注入 | circuit-breaker/connection-pool/stale-prefix 单测覆盖 | ✅ | ❓ 缺「依赖变慢/超时/过载」的全链路集成故障演练 |

---

## 6. 问题清单与优化方案（按优先级）

### P0（阻断性/环境一致性，建议立即修）

| 编号 | 问题 | 证据 | 影响 | 方案 |
|---|---|---|---|---|
| P0-1 | Node 引擎约束未声明 | `npm install` 在 Node 24.1.0 失败（openclaw preinstall 强制要求） | 新环境无法安装；CI 与本地版本漂移 | 根 + dashboard `package.json` 加 `engines`；提交 `.nvmrc`=26；CI 显式 `setup-node node-version '26'`（已用）并加引擎校验 |

### P1（应在下个版本修复）

| 编号 | 问题 | 证据 | 影响 | 方案 |
|---|---|---|---|---|
| P1-1 | Lint 1291 条警告无门槛 | `npm run lint`：0 errors / 1291 warnings | 掩盖真问题；新告警无感知 | 设置基线：CI `eslint --max-warnings 0` 前先按文件白名单存量降噪（优先 `no-explicit-any` 收敛公共类型，如 `assemble/types.ts`、`RetrievalResult[]` 等泛化），或先 `--max-warnings N` 留出预算逐轮收紧 |
| P1-2 | dashboard 直连 Neo4j 写入口 | `server/lib/neo4j.ts` `runWriteQuery`（当前仅 experience tags merge 使用） | 绕过 MCP 白名单的潜在越权写面 | 将该写操作收敛到 `/api/mcp/invoke` 统一通道；短期至少加操作审计日志 |
| P1-3 | Docker 以 root 运行 + compose 默认口令 | Dockerfile 未切换 USER；compose `DASHBOARD_AUTH=admin:changeme-docker-default` | 容器逃逸面 + 默认凭据风险 | runtime 阶段 `USER node` + 数据卷权限调整；compose 去掉默认口令，缺省要求必须显式传入（`REQUIRE_DASHBOARD_AUTH` 已有门禁，改为默认强制） |
| P1-4 | 文档与代码漂移 | README 记录测试 458/63，实测 1164/153；功能表与 21 个工具清单不完全一致 | 文档失真成本 | 运行期自动核验：CI 增加「测试计数/工具清单 vs 文档」断言；或人工按本次审计批量刷新 README/API.md |
| P1-5 | 熔断器二进制开关 | `circuit-breaker.ts` CLOSED/OPEN 二态（带半开探测） | 部分失败下可能抖动 | 评估 AIMD（加性增/乘性减）替代；短期保持半开单探测并补充「连续 N 次成功才关断」的恢复条件测试 |

### P2（优化项 / 待确认）

| 编号 | 问题 | 证据 | 方案 |
|---|---|---|---|
| P2-1 | dashboard `requestTimeout=0` | server/index.ts onReady 显式禁超时 | 属长任务设计，保留；建议加进程级兜底看门狗（如 90min 硬上限 + 告警） |
| P2-2 | `task-registry` 是否设上限 | `backgroundTasks` fire-and-forget | 确认是否可无界累积；建议加最大并发/队列深度 + 拒绝策略，并暴露到 /metrics |
| P2-3 | `GET /api/agent/status`、`/experience/tags`、`/extract-rebuild/progress` 无写限流豁免 | rate-limit allowList | 收益低，仅记录；如暴露到公网按入口限流 |
| P2-4 | 前端 14 路独立轮询各自定时 | useMonitorData | 可合并为统一心跳调度 + 离焦暂停（visibilitychange），减少空转请求 |
| P2-5 | 压力场景无「拐点」测试 | test/perf 无 breakpoint 分析 | 用 dashboard benchmark/SSE 跑 spike/soak，记录 P99 拐点与压力后恢复时间，写回 test-perf |

### 优化方向汇总表

| 方向 | 动作 | 期望收益 | 验收标准 |
|---|---|---|---|
| 环境一致性（P0-1） | engines + .nvmrc + CI 引擎校验 | install 成功率 100% | 全新 Node 26 环境 `npm ci` 通过 |
| 代码卫生（P1-1） | lint 告警降噪 + 门槛 | 告警可执行 | CI lint 0 warnings |
| 写路径收敛（P1-2） | runWriteQuery→MCP | 统一审计面 | tags merge 经 mcp-invoke 成功 + 日志到位 |
| 容器加固（P1-3） | USER node + 强口令门禁 | 逃逸面收敛 | 默认配置无弱口令即可启动失败并提示 |
| 文档自动核验（P1-4） | CI 断言工具/测试计数 | 文档不失真 | 文档与实测一致 |
| 韧性观测（P2） | /metrics 增加每依赖重试/超时/拒绝计数、债务队列年龄、task-registry 深度 | 过载可发现 | 仪表盘可见 + 告警规则（alerting-rules.yml 已有基建） |
| 容量验证（P2-5） | spike/soak 压测记录拐点 | 明确断裂点 | CE-report 含 P99 拐点与恢复时间 |

---

## 7. 落地节奏建议

1. **本周**（P0-1、P1-3）：环境一致 + 容器加固 —— 低风险高收益，回归由现有 1317 项测试保障。
2. **里程碑 v2.2**（P1-1、P1-2、P1-4）：卫生收口 + 写路径收敛 + 文档核验。任何新配置/熔断阈值调整先以 **observe-only** 模式上线（输出到 /metrics 但不强停），确认阈值符合现实后再 enforcement（遵循 specialist：新隔离/准入限制先观察后强执）。
3. **持续**（P2 系列）：可观测性指标补齐 + 故障演练（依赖变慢/超时/过载场景）+ 压测拐点记录。

> 建议复盘基线：现有 `alerting-rules.yml` + `/metrics`（Prometheus）+ `latencyHistograms`（P50/90/95/99）已构成闭环，新增指标只需复用 `health_metrics`/`dashboard-snapshot` 的现有管道。

---

## 8. 必须复盘的检查项（Checks Before Moving On）

- [ ] `dependency_matrix`：全部远程依赖/队列均已有超时、重试、失败行为（✅ 验证通过，见 §3）
- [ ] `deadline_budget`：每跳超时在调用方总预算内（✅ 15s 全局 / 分档 LLM 超时）
- [ ] `retry_safety`：可重试调用均有预算与幂等/去重（✅ committedTurnKeys / 蒸馏 retryCount / MERGE）
- [ ] `backpressure_mode`：过载响应可停止同步重试风暴、异步慢速消费（✅ 熔断 OPEN 拒重试 / 门控让路）
- [ ] `overload_bound`：队列有界且过载可观测（⚠️ task-registry 上限待确认 → P2-2）
- [ ] `health_check_safety`：存活探针不依赖共享依赖（✅ Docker /api/ping、/internal/health）
- [ ] `tail_metric`：以分位而非均值评估（✅ 延迟直方图 P50/90/95/99）
- [ ] `traffic_model`：峰值/突发/扇出已建模或已标未知（⚠️ 见 §5.4 缺口）
- [ ] `test_result`：压测有场景与停止条件（本次 1317 项回归 ✅；spike/soak 拐点待补）
- [ ] `background_budget`：后台工作有资源上限与让路（✅ 门控/信号量/并发上限）