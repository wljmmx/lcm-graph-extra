/**
 * 会话级来源并集（官方转录 ∪ lcm.db）。
 *
 * 为什么需要它（真实缺陷，勿回退成"互斥选择"）：
 *   官方 per-agent SQLite 转录是权威源，但**迁移常常不完整** —— 老会话可能只留在
 *   lcm.db 里。若实现写成"官方有数据就直接 return"，那些会话会**静默丢失、永不进图**，
 *   且没有任何可见信号。本模块把"补集"这一步显式化，并给出可上报的计数。
 *
 * 为什么是会话级而不是消息级：
 *   消息身份是内容指纹契约 `gm:<sessionKey>:<role>:<fnv1a64(全文)>:<序号>`。
 *   同一消息在两侧的 content 扁平化口径可能不同 → 算出不同 id → 消息级合并会
 *   **造出重复节点**。会话级合并不在同一会话内混源（同 key 一律以官方为准），
 *   因此只会新增整段缺失会话，不会产生重复。
 */

export interface MessageSourceSessionLike {
  /** 稳定会话键（session_key ?? session_id，由 resolveGmSessionKey 归一） */
  sessionKey: string;
  sessionId: string;
  msgs: { role: unknown; content: unknown; createdAt: number }[];
}

export interface SessionSourceUnion<T extends MessageSourceSessionLike> {
  /** 官方全量 + 仅存在于 lcm.db 的会话（顺序：官方在前） */
  sessions: T[];
  /** 官方侧会话数 */
  officialSessions: number;
  /** lcm.db 侧会话数 */
  lcmSessions: number;
  /** 仅存在于 lcm.db、被补入的会话数（>0 说明 lcm.db 尚不能退役） */
  lcmOnlySessions: number;
  /** 两侧都有的会话数（这些以官方为准，不用 lcm 版本） */
  overlapSessions: number;
}

/**
 * 会话级并集：官方为准，补齐"仅 lcm.db 有"的会话。
 *
 * @param official 官方转录解析出的会话
 * @param lcmSessions lcm.db 解析出的会话
 */
export function mergeMessageSourceSessions<T extends MessageSourceSessionLike>(
  official: T[],
  lcmSessions: T[],
): SessionSourceUnion<T> {
  const seen = new Set<string>();
  const sessions: T[] = [];
  for (const s of official) {
    if (!s.sessionKey || seen.has(s.sessionKey)) continue;
    seen.add(s.sessionKey);
    sessions.push(s);
  }
  const officialSessions = sessions.length;
  let lcmOnlySessions = 0;
  let overlapSessions = 0;
  for (const s of lcmSessions) {
    if (!s.sessionKey) continue;
    if (seen.has(s.sessionKey)) {
      // 同一会话两侧都有：以官方为准，不混源（避免重复消息节点）
      overlapSessions += 1;
      continue;
    }
    seen.add(s.sessionKey);
    sessions.push(s);
    lcmOnlySessions += 1;
  }
  return { sessions, officialSessions, lcmSessions: lcmSessions.length, lcmOnlySessions, overlapSessions };
}