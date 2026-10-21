/**
 * Harnessing P3: 8 组件分类法 —— 本引擎对 harness 的"可编辑面"枚举。
 *
 * 对齐 Harness²（arXiv:2610.14224）的组件分组（context-construction /
 * tool-interface / orchestration / middleware），并把每个组件映射到
 * 本引擎实际控制的模块，使 Propose/Compose 有明确的操作枚举，
 * 也让 dashboard 可按组件展示"哪个组件被谁为何改过"。
 */

import type { HarnessComponentId } from './types.js';

export interface HarnessComponentMeta {
  id: HarnessComponentId;
  /** 中文标签 */
  label: string;
  group: 'context-construction' | 'tool-interface' | 'orchestration' | 'middleware';
  /** 本引擎中控制该组件的模块（人读映射，也是后续可进化面的锚点） */
  engineSurface: string;
}

export const HARNESS_COMPONENTS: readonly HarnessComponentMeta[] = [
  {
    id: 'system-prompt',
    label: '系统提示注入',
    group: 'context-construction',
    engineSurface: 'assemble/guidance.ts + assemble/injection.ts（systemPromptAddition 构建）',
  },
  {
    id: 'guardrails',
    label: '护栏与约束',
    group: 'context-construction',
    engineSurface: 'plugin/token-control.ts + circuit-breaker.ts（预算裁剪/熔断）',
  },
  {
    id: 'memory',
    label: '记忆检索',
    group: 'context-construction',
    engineSurface: 'experience/ + qmd-client.ts + adapters/graph-adapter.ts（三层检索）',
  },
  {
    id: 'tool-guidance',
    label: '工具引导',
    group: 'tool-interface',
    engineSurface: 'plugin/tool-guidance.ts（5 层策略 + SAD 反馈）',
  },
  {
    id: 'subagents',
    label: '子代理编排',
    group: 'orchestration',
    engineSurface: 'moa/orchestrator.ts（多模型路由）',
  },
  {
    id: 'skills',
    label: '技能沉淀',
    group: 'context-construction',
    engineSurface: 'plugin/distillation.ts（经验蒸馏产物）',
  },
  {
    id: 'scripts',
    label: '脚本化工具',
    group: 'tool-interface',
    engineSurface: 'tools/（lcmg_* 工具实现）',
  },
  {
    id: 'plugins',
    label: '中间件钩子',
    group: 'middleware',
    engineSurface: 'hooks/（compaction / after-turn / heartbeat）',
  },
] as const;

const _byId = new Map(HARNESS_COMPONENTS.map((c) => [c.id, c]));

export function getHarnessComponent(id: HarnessComponentId): HarnessComponentMeta | undefined {
  return _byId.get(id);
}

export function isHarnessComponentId(v: unknown): v is HarnessComponentId {
  return typeof v === 'string' && _byId.has(v as HarnessComponentId);
}
