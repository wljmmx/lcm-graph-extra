/**
 * Harnessing P1: 经验作用域分层（invariant / domain）。
 *
 * 对齐 Harness²（arXiv:2610.14224）的反过拟合设计：
 * 领域特定经验（domain）不得跨任务默认迁移 —— 仅当当前上下文的场景标签
 * 与经验标签命中时才注入；通用教训（invariant）常驻。
 *
 * 兼容性契约：
 *   - 存量数据无 scope 字段 → 按 'invariant' 处理 → 行为与历史**完全一致**。
 *   - 仅显式 scope='domain' 的经验（由 harnessing 步骤产出）参与过滤。
 *
 * 纯函数、零 IO —— 注入层（assemble/injection）与测试可直接复用。
 */

import type { DistilledExperience, ExperienceScope } from './types.js';

/** 缺省作用域：存量经验视为 invariant（常驻），保持向后兼容 */
export const DEFAULT_EXPERIENCE_SCOPE: ExperienceScope = 'invariant';

/** 取经验的有效作用域（undefined → invariant） */
export function effectiveScope(exp: DistilledExperience | undefined | null): ExperienceScope {
  return exp?.scope === 'domain' ? 'domain' : DEFAULT_EXPERIENCE_SCOPE;
}

/** 作用域判定上下文：当前请求的场景标签（如 'bug-fix'、用户画像高频场景） */
export interface ScopeContext {
  scenarioTags?: string[];
}

const lower = (s: string): string => s.trim().toLowerCase();

/**
 * 判断经验是否应注入当前上下文。
 *
 *   invariant → 恒 true（常驻）
 *   domain    → 场景标签命中才 true；当前无场景信号时**不注入**（防跨域泄漏，宁可保守）
 *
 * 命中规则：经验的 tags.scenario 或 tags.freeTags 与上下文 scenarioTags 有交集（大小写不敏感）。
 */
export function scopeMatchesContext(
  exp: DistilledExperience | undefined | null,
  ctx?: ScopeContext,
): boolean {
  if (!exp) return true;
  if (effectiveScope(exp) !== 'domain') return true;
  const ctxTags = (ctx?.scenarioTags ?? []).map(lower).filter(Boolean);
  if (ctxTags.length === 0) return false;
  const expTags = [
    ...(exp.tags?.scenario ?? []),
    ...(exp.tags?.freeTags ?? []),
  ].map(lower).filter(Boolean);
  return expTags.some((t) => ctxTags.includes(t));
}

/**
 * 对检索结果批量应用作用域分层。
 *
 * @param results 检索结果（experience 字段可为空，空者原样保留）
 * @returns kept: 保留的结果；droppedDomain: 被 filter 掉的 domain 经验数（供日志/指标）
 */
export function applyScopeLayering<T extends { experience?: DistilledExperience }>(
  results: readonly T[] | undefined | null,
  ctx?: ScopeContext,
): { kept: T[]; droppedDomain: number } {
  const kept: T[] = [];
  let droppedDomain = 0;
  for (const r of results ?? []) {
    if (r?.experience && !scopeMatchesContext(r.experience, ctx)) {
      droppedDomain++;
      continue;
    }
    kept.push(r);
  }
  return { kept, droppedDomain };
}
