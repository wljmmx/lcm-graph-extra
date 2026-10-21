/**
 * Harnessing P5: Editor / Composer 角色定义（LLM 可选增强路径）。
 *
 * 当前运行时为规则版（propose.ts / compose.ts，零 LLM、确定性）。
 * 本模块提供两个角色的 prompt 构建器，供后续把 Editor/Composer 升级为
 * LLM 会话（经 moa/orchestrator 路由）时复用 —— 纯字符串构建，无副作用，
 * 不接入任何运行时路径。
 *
 * 角色分工（对齐 Harness²）：
 *   Editor   —— 阅读失败信号与现有组件面，提出 invariant / domain 两类候选修改
 *   Composer —— 阅读探针行为对比证据，裁决采纳/拒绝/存疑（证据不足默认不采纳）
 */

import type { FailureSignal, HarnessEdit, ProbeOutcome } from './types.js';
import { HARNESS_COMPONENTS } from './components.js';

export const EDITOR_ROLE_PROMPT = [
  '你是 Harness Editor：在不修改模型权重的前提下，为 agent harness 提出候选修改。',
  '输入：结构化失败信号（四分类：action-realization / environment-contract /',
  'trajectory-degeneration / residual-reasoning）与可编辑组件清单。',
  '要求：',
  '1. 每个失败分类最多提出一个候选修改；',
  '2. 区分两类作用域：invariant（跨领域通用）与 domain（领域特定，需标注适用场景标签）；',
  '3. tool-guidance 类修改必须给出可验证的权重调整负载（工具/类别 + delta）；',
  '4. 输出 JSON 数组，字段：component / scope / title / detail / rationale / payload。',
].join('\n');

export const COMPOSER_ROLE_PROMPT = [
  '你是 Harness Composer：依据探针行为对比证据裁决候选修改。',
  '裁决纪律：只采纳有正向行为对比证据（contrast ≥ 采纳阈值）的修改；',
  '负向证据 → 拒绝；无证据或差异不显著 → 存疑（默认不采纳）。',
  '输入：候选修改列表 + 每项的基线/候选探针得分。',
  '输出 JSON 数组，字段：editId / verdict (adopt|reject|inconclusive) / reason。',
].join('\n');

/** 构建 Editor 输入 prompt（含组件清单与失败信号） */
export function buildEditorPrompt(input: {
  signals: readonly FailureSignal[];
  lessons?: readonly string[];
}): string {
  const components = HARNESS_COMPONENTS
    .map((c) => `- ${c.id}（${c.label}，${c.group}）：${c.engineSurface}`)
    .join('\n');
  const signals = input.signals
    .map((s, i) => `${i + 1}. [${s.kind ?? 'unclassified'}] ${s.text}${s.source ? `（来源: ${s.source}）` : ''}`)
    .join('\n');
  const lessons = input.lessons?.length
    ? `\n已有相关教训（避免重复提出）：\n${input.lessons.map((l) => `- ${l}`).join('\n')}`
    : '';
  return `${EDITOR_ROLE_PROMPT}\n\n## 可编辑组件\n${components}\n\n## 失败信号\n${signals || '（无）'}${lessons}\n`;
}

/** 构建 Composer 输入 prompt（含候选修改与探针证据） */
export function buildComposerPrompt(input: {
  edits: readonly HarnessEdit[];
  outcomes: readonly ProbeOutcome[];
}): string {
  const edits = input.edits
    .map((e) => `- ${e.id}（${e.component}/${e.scope}）：${e.title}`)
    .join('\n');
  const outcomes = input.outcomes
    .map((o) => `- ${o.editId}: 基线 ${(o.baseline.score * 100).toFixed(0)}% → 候选 ${(o.candidate.score * 100).toFixed(0)}%（对比 ${(o.contrast * 100).toFixed(0)}%，规则版判定 ${o.verdict}）`)
    .join('\n');
  return `${COMPOSER_ROLE_PROMPT}\n\n## 候选修改\n${edits || '（无）'}\n\n## 探针证据\n${outcomes || '（无）'}\n`;
}
