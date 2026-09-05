/**
 * 会话交付前不变式守卫：确保发送给 LLM 的 messages 至少含一条非空 user。
 *
 * 动机（see http 500 "no user query found in messages" on Ollama）：
 * 记忆插件在 low/medium/high 及 compact 路径重建 messages 时，若上游转录出现 wedge
 * （transcript wedge detected / afterTurn failing closed，user 轮次丢失），重建结果可能
 * 完全不包含 user 角色消息。向 Ollama 等 chat 模板发送该数组会被正确拒绝并返回 500。
 * 这里只关心"是否含 ≥1 条非空 user"——对话以 assistant 结尾是合法正常态，不应改动。
 *
 * 非污染原则（硬约束）：
 * 1. 只要含 ≥1 条非空 user → 原样放行，不做任何干预（不截断、不追加、不伪造）。
 * 2. 重建结果完全无 user 且原始转录仍含真实 user → 回退原始转录（真实内容，恢复 user 轮次）。
 * 3. 总 wedge（连转录都无 user）→ fail-closed：如实降级并告警，绝不伪造一条查询去"救火"，
 *    因为基于坏输入作答会自催化放大转录 wedge。
 */

export type EnsureUserNote = 'ok' | 'from_original' | 'none';

export interface EnsureFinalUserResult {
  messages: any[];
  note: EnsureUserNote;
}

function isNonEmptyUser(m: any): boolean {
  if (!m || m.role !== 'user') return false;
  const c = m.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) {
    return c.some((p: any) => {
      if (typeof p === 'string') return p.trim().length > 0;
      return typeof p?.text === 'string' && p.text.trim().length > 0;
    });
  }
  return false;
}

function hasNonEmptyUser(msgs: any[]): boolean {
  return Array.isArray(msgs) && msgs.some((m) => isNonEmptyUser(m));
}

/**
 * @param msgs          重建后的消息数组（可能缺 user）
 * @param originalMsgs  原始转录（params.messages），用于总缺 user 时回退真实内容
 */
export function ensureFinalUserMessage(msgs: any[], originalMsgs: any[]): EnsureFinalUserResult {
  if (!Array.isArray(msgs) || msgs.length === 0) {
    return { messages: msgs, note: 'ok' };
  }

  // 已含 ≥1 条非空 user（对话以 assistant 结尾也合法）→ 原样交付
  if (hasNonEmptyUser(msgs)) {
    return { messages: msgs, note: 'ok' };
  }

  // 重建结果完全无 user → 若原始转录仍含真实 user，回退原始转录（真实内容，恢复 user 轮次）
  if (Array.isArray(originalMsgs) && hasNonEmptyUser(originalMsgs)) {
    return { messages: originalMsgs, note: 'from_original' };
  }

  // 总 wedge：转录本身无 user。fail-closed——不伪造，如实保留，交由上层降级处理
  return { messages: msgs, note: 'none' };
}

/**
 * 给重建后的消息数组补充一条最近的真实 user 消息（若缺失）。
 *
 * 动机：上游裁剪/重建路径（low-tier fallback、cascading trim、P0-5 trimming）可能产出
 * 仅含 system/assistant/tool 的消息数组。若交给 ensureFinalUserMessage 处理，会逐轮
 * 回退为「全量原始转录」——丢失裁剪效果、token 超窗，并每轮产生 from_original warn。
 * 这里在源头保证：从 source 中取最近一条非空 user 消息补到末尾——真实内容、不伪造。
 */
export function appendRecentUser(built: any[], source: any[]): any[] {
  if (hasNonEmptyUser(built)) return built;
  if (!Array.isArray(source)) return built;
  for (let i = source.length - 1; i >= 0; i--) {
    if (isNonEmptyUser(source[i])) {
      return [...built, source[i]];
    }
  }
  return built;
}