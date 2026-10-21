/**
 * Harnessing 类型定义 —— Propose–Probe–Compose 对比优化协议。
 *
 * 思想来源：Harness²（Google Research, arXiv:2610.14224, Apache-2.0）。
 * 不改模型权重，只对 harness 组件做**有行为证据支撑**的演进：
 *   Propose —— 从失败信号提出候选修改（invariant / domain 两类）
 *   Probe   —— 同一探针集上对比基线与候选的行为差异（verifier-free）
 *   Compose —— 仅采纳有行为对比证据支持的修改，其余拒绝/存疑
 *
 * 本实现为规则版（零 LLM、确定性、可测试）；LLM 版 Editor/Composer
 * 角色 prompt 见 roles.ts，作为后续可选增强路径。
 */

/** 8 组件分类法（Harness² 的可编辑面枚举） */
export type HarnessComponentId =
  | 'system-prompt'
  | 'guardrails'
  | 'memory'
  | 'tool-guidance'
  | 'subagents'
  | 'skills'
  | 'scripts'
  | 'plugins';

/** 修改作用域：invariant = 跨领域通用；domain = 领域特定（防跨任务泄漏） */
export type HarnessScope = 'invariant' | 'domain';

/**
 * P6: 失败四分类法（借鉴 Life-Harness 的 failure taxonomy）。
 * propose 的结构化输入，让"提出什么修改"有据可依。
 */
export type FailureKind =
  | 'action-realization'        // 动作实现失败：工具/命令执行出错、参数错误
  | 'environment-contract'      // 环境契约失配：配置缺失、依赖不符、接口约定变化
  | 'trajectory-degeneration'   // 轨迹退化：重复、循环、上下文丢失
  | 'residual-reasoning';       // 残余推理失败：理解/推理错误（harness 侧无解，仅记录）

/** 失败信号：propose 的输入单元 */
export interface FailureSignal {
  /** 分类（缺省时由 failure-taxonomy.classifyFailure 从 text 推断） */
  kind?: FailureKind;
  /** 失败描述原文（中英均可） */
  text: string;
  /** 源轨迹引用（工具名 / diagnose / 会话 ID 等，写入经验证据链） */
  source?: string;
  /** 出现次数（聚合信号） */
  count?: number;
}

/** tool-guidance 组件的权重调整建议（probe 的可执行负载） */
export interface ToolGuidanceWeightHint {
  /** 按工具名调整 */
  tool?: string;
  /** 按工具类别调整（categorizeTool 的类别） */
  category?: string;
  /** 权重增量（正=增强推荐，负=降权） */
  delta: number;
}

/** tool-guidance 编辑的负载：probe 据此构造候选权重表 */
export interface ToolGuidancePayload {
  weightHints: ToolGuidanceWeightHint[];
}

/** 候选修改（Propose 产出） */
export interface HarnessEdit {
  id: string;
  component: HarnessComponentId;
  scope: HarnessScope;
  title: string;
  detail: string;
  rationale: string;
  /** 支撑该修改的失败信号（写入经验证据链） */
  basis: FailureSignal[];
  /** 组件特定负载（当前仅 tool-guidance 支持 probe） */
  payload?: ToolGuidancePayload;
}

/** 单个探针集上的运行得分 */
export interface ProbeRun {
  /** 归一化得分 [0,1]：命中 fixture 数 / 总 fixture 数 */
  score: number;
  /** 探针 fixture 总数 */
  fixtures: number;
  /** 命中的 fixture 数 */
  hits: number;
}

/** 单个候选修改的探针对比结论 */
export interface ProbeOutcome {
  editId: string;
  baseline: ProbeRun;
  candidate: ProbeRun;
  /** candidate.score - baseline.score */
  contrast: number;
  verdict: 'adopt' | 'reject' | 'inconclusive';
}

/** Compose 汇总 */
export interface ComposeResult {
  adopted: HarnessEdit[];
  rejected: HarnessEdit[];
  inconclusive: HarnessEdit[];
  outcomes: ProbeOutcome[];
}

/** 探针 fixture：查询 + 期望命中的工具（Probe 的输入单元） */
export interface ProbeFixture {
  query: string;
  expectedTools: string[];
}

/** 采纳后产出的经验草稿（由总线补身份字段后写入经验库） */
export interface HarnessingLessonDraft {
  type: 'lesson';
  title: string;
  summary: string;
  detail: string;
  context: string;
  relevanceScore: number;
  tags?: { scenario?: string[]; techStack?: string[]; severity?: 'critical' | 'major' | 'minor'; freeTags?: string[] };
  relatedConcepts?: string[];
  scope: 'invariant' | 'domain';
  evidence: {
    probeId: string;
    baseline?: number;
    candidate?: number;
    contrast?: number;
    trajectoryRef?: string;
    adoptedAt: string;
  };
}
