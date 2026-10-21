/**
 * Harnessing P2a: Propose —— 从失败信号提出候选修改。
 *
 * 规则版映射（kind → component），每个失败分类产生至多一个候选修改，
 * basis 聚合同类信号（保持证据完整）。作用域规则对齐 Harness²：
 *   - 通用失败类（契约/轨迹/推理）→ invariant 修改
 *   - 指名具体工具的 tool-guidance 修改 → domain（仅在该工具场景生效建议）
 *
 * 纯函数、确定性、可测试。id = 内容寻址（同输入同 id，天然幂等）。
 */

import { createHash } from 'node:crypto';
import type {
  FailureKind,
  FailureSignal,
  HarnessComponentId,
  HarnessEdit,
  ToolGuidanceWeightHint,
} from './types.js';

/** 每步最多提出的候选修改数（四类失败恰好各一，上限即防线） */
export const MAX_EDITS_PER_STEP = 4;

/** 失败分类 → 应修改的 harness 组件 */
export const KIND_TO_COMPONENT: Record<FailureKind, HarnessComponentId> = {
  'action-realization': 'tool-guidance',
  'environment-contract': 'guardrails',
  'trajectory-degeneration': 'memory',
  'residual-reasoning': 'skills',
};

const KIND_EDIT_TEMPLATE: Record<FailureKind, { title: string; detail: string; rationale: string }> = {
  'action-realization': {
    title: '调整工具引导权重（动作实现失败）',
    detail: '针对工具调用失败信号，提升相关工具的推荐权重与使用提示，降低重复试错。',
    rationale: '动作实现失败最常见根因是推荐了低权重/不熟练路径；权重调整可被探针集直接验证。',
  },
  'environment-contract': {
    title: '补充环境契约护栏（契约失配）',
    detail: '针对环境契约失配信号，在注入的护栏文本中补充前置检查项（依赖/配置/版本）。',
    rationale: '契约失配应在执行前拦截，属于跨任务通用的护栏增强（invariant）。',
  },
  'trajectory-degeneration': {
    title: '强化记忆检索与轨迹约束（轨迹退化）',
    detail: '针对重复/循环/上下文丢失信号，增强历史步骤召回与去重提示，打断退化循环。',
    rationale: '轨迹退化的根因是上下文中缺少"已做过什么"的记忆锚点（invariant）。',
  },
  'residual-reasoning': {
    title: '沉淀推理类技能教训（残余推理失败）',
    detail: '针对理解/推理失败信号，沉淀为技能教训供后续任务参考；harness 侧不强行干预推理本身。',
    rationale: '推理失败不宜用提示词硬补；沉淀为可检索教训是 Harness² 对 residual 失败的处置方式。',
  },
};

/** 从失败文本中提取被提及的已知工具名（用于生成 tool-guidance 权重建议） */
function extractMentionedTools(text: string, knownTools: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return knownTools.filter((t) => lower.includes(t.toLowerCase()));
}

/**
 * 从失败信号提出候选修改。
 *
 * @param signals 已归一化的失败信号（见 failure-taxonomy.normalizeSignals）
 * @param opts.knownTools 已知工具名列表（用于把 tool-guidance 修改具体化为权重建议）
 */
export function proposeEdits(
  signals: readonly FailureSignal[],
  opts?: { knownTools?: readonly string[] },
): HarnessEdit[] {
  // 按分类聚合（保持首次出现顺序）
  const byKind = new Map<FailureKind, FailureSignal[]>();
  for (const s of signals) {
    const kind = s.kind ?? 'residual-reasoning';
    const bucket = byKind.get(kind);
    if (bucket) bucket.push(s);
    else byKind.set(kind, [s]);
  }

  const edits: HarnessEdit[] = [];
  for (const [kind, group] of byKind) {
    if (edits.length >= MAX_EDITS_PER_STEP) break;
    const component = KIND_TO_COMPONENT[kind];
    const tpl = KIND_EDIT_TEMPLATE[kind];

    let payload: HarnessEdit['payload'] | undefined;
    let scope: HarnessEdit['scope'] = 'invariant';

    if (component === 'tool-guidance' && opts?.knownTools?.length) {
      // 指名具体工具 → domain 修改 + 可 probe 的权重负载
      const mentioned = new Set<string>();
      const hints: ToolGuidanceWeightHint[] = [];
      for (const s of group) {
        for (const t of extractMentionedTools(s.text, opts.knownTools)) {
          if (!mentioned.has(t)) {
            mentioned.add(t);
            hints.push({ tool: t, delta: 0.15 });
          }
        }
      }
      if (hints.length > 0) {
        payload = { weightHints: hints };
        scope = 'domain';
      }
    }

    edits.push({
      id: 'edit_' + createHash('sha1')
        .update(component + '\u241f' + kind + '\u241f' + group.map((s) => s.text).join('\u241f'))
        .digest('hex')
        .slice(0, 16),
      component,
      scope,
      title: tpl.title,
      detail: tpl.detail,
      rationale: tpl.rationale,
      basis: group,
      payload,
    });
  }
  return edits;
}
