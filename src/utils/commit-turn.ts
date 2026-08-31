/**
 * OpenClaw durable-turn 逻辑轮提交的幂等判定（纯函数）。
 *
 * 从 plugin 注册闭包中抽取，便于单元测试。commitTurn 的核心职责：
 *   1. 校验 advancementKey 是否等于 admission.logicalTurnId（陈旧提交 → duplicate）
 *   2. 依会话+turnId 在幂等集内去重（重复提交 → duplicate）
 *
 * @module utils/commit-turn
 */

export interface TurnAdmissionLike {
  logicalTurnId?: unknown;
}

export interface CommitTurnDecision {
  /** 命中陈旧/去重 */
  duplicate: boolean;
  /** 去重使用的幂等 key = `${sessionId}|${turnId}` */
  key: string;
  /** 判定显示的 turnId */
  turnId: string;
  /** 是否因 advancementKey 与 logicalTurnId 不一致而判定重复 */
  keyMismatch: boolean;
}

/** 依 entrance/isDuplicate 逻辑求幂等判定（不含副作用）。 */
export function evaluateTurnCommit(opts: {
  sessionId: string;
  advancementKey: string;
  logicalTurnId: unknown;
  seen: ReadonlySet<string>;
}): CommitTurnDecision {
  const advancementKey = String(opts.advancementKey ?? opts.logicalTurnId ?? '');
  const logicalTurnId = opts.logicalTurnId != null ? String(opts.logicalTurnId) : '';
  const turnId = logicalTurnId || advancementKey;

  const keyMismatch = Boolean(advancementKey && logicalTurnId && advancementKey !== logicalTurnId);
  const key = `${opts.sessionId}|${turnId}`;
  const duplicate = keyMismatch || opts.seen.has(key);

  return { duplicate, key, turnId, keyMismatch };
}