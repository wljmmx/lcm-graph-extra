/**
 * SDK 2026.10.4 转录能力适配 —— **只读部分（P0 探测 + P1 枚举）**。
 *
 * 本模块刻意不做任何写盘操作。写能力（`runtimeContext.rewriteTranscriptEntries`）
 * 留待后续阶段，且必须先以 observe-only 方式验证判定准确性。
 *
 * ── 机制（依据 openclaw 2026.10.4 dist 源码，非推测）────────────────────
 *
 * 1) **注入位置唯一**：该能力只在 `maintain()` 的 runtimeContext 中出现
 *    （`context-engine-maintenance-*.mjs` 的 buildContextEngineMaintenanceRuntimeContext）。
 *    其他生命周期路径会被 `preparePreTurnRuntimeContext()` 围栏剥离。
 * 2) **前置条件**：必须有 `sessionKey`。宿主实现开头即校验：
 *    `if (!runtimeSessionKey) throw new Error("Context-engine transcript rewrite requires a session key")`
 *    ⇒ 缺 sessionKey 时「视为不可用」，绝不可调用。
 * 3) **语义是替换而非追加**：按 `entryId` 替换既有 `type === "message"` 条目，
 *    由运行时执行 branch-and-reappend；因此**不能**用它来追加新的 compaction entry。
 * 4) **返回契约**：`TranscriptRewriteResult { changed, bytesFreed, rewrittenEntries, reason? }`，
 *    与 `ContextEngineMaintenanceResult` 同型 —— 即 maintain 的返回值。
 * 5) `allowedRewriteSuffixEntryIds` 在 10.4 中**无运行时实现**（仅 .d.ts 声明），传入无效果。
 *
 * ── entryId 来源（可行性关键）──────────────────────────────────────
 * `openclaw/plugin-sdk/session-transcript-runtime` 导出
 * `readVisibleSessionTranscriptMessageEntries(...)`，按身份返回
 * `{ entryId, parentId, seq, message, role, createdAt?, idempotencyKey? }`。
 * 注意：该子路径在 2026.10.4 的 exports 中**未声明 types**（JS-only），
 * 且属内部子路径、跨版本可能变动 —— 故此处一律动态 import + 软失败。
 */

/** 仅识别为「可见消息条目」的最小结构（对齐宿主 projectVisibleMessageEntry 的返回形状） */
export interface VisibleTranscriptEntry {
  entryId: string;
  parentId?: string | null;
  seq?: number;
  message?: Record<string, unknown>;
  role?: string;
  createdAt?: string;
  idempotencyKey?: string;
}

/** P0：改写能力探测结果 */
export interface TranscriptRewriteCapability {
  available: boolean;
  /** 不可用原因（用于诊断，不抛错） */
  reason?: 'not_provided' | 'missing_session_key';
}

/**
 * P0：探测 maintain 的 runtimeContext 是否提供转录改写能力。
 *
 * 严格遵守宿主前置条件：缺 `sessionKey` 时即使回调存在也判为不可用 ——
 * 宿主会对该情况直接 throw，调用方必须提前规避。
 */
export function probeTranscriptRewriteCapability(
  runtimeContext: unknown,
  sessionKey?: unknown,
): TranscriptRewriteCapability {
  const ctx = (runtimeContext ?? {}) as Record<string, unknown>;
  if (typeof ctx.rewriteTranscriptEntries !== 'function') {
    return { available: false, reason: 'not_provided' };
  }
  if (typeof sessionKey !== 'string' || !sessionKey.trim()) {
    return { available: false, reason: 'missing_session_key' };
  }
  return { available: true };
}

/**
 * P1（只读）：按会话身份枚举可见转录消息条目。
 *
 * 全程软失败：子路径缺失（旧宿主）/ 版本变动 / 读取异常 → 返回空数组，绝不抛错。
 * 这是刻意的设计 —— 本模块处于「诊断」定位，任何失败都不应影响 maintain 主流程。
 */
export async function readVisibleTranscriptEntries(params: {
  sessionKey?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  storePath?: unknown;
}): Promise<VisibleTranscriptEntry[]> {
  const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey.trim() : '';
  if (!sessionKey) return [];

  try {
    // @ts-ignore - 该 SDK 子路径在 2026.10.4 exports 中未声明 types（JS-only），仅有运行时导出
    const mod: Record<string, unknown> = await import('openclaw/plugin-sdk/session-transcript-runtime');
    const read = mod.readVisibleSessionTranscriptMessageEntries;
    if (typeof read !== 'function') return [];

    const query: Record<string, unknown> = { sessionKey };
    if (typeof params.sessionId === 'string' && params.sessionId) query.sessionId = params.sessionId;
    if (typeof params.agentId === 'string' && params.agentId) query.agentId = params.agentId;
    if (typeof params.storePath === 'string' && params.storePath) query.storePath = params.storePath;

    const raw = await (read as (q: Record<string, unknown>) => Promise<unknown>)(query);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is VisibleTranscriptEntry =>
        !!e && typeof (e as VisibleTranscriptEntry).entryId === 'string',
    );
  } catch {
    // 旧宿主无该子路径 / 导入或读取失败 —— 软失败
    return [];
  }
}

/** P1（纯函数）：对枚举结果做轻量摘要，供诊断日志使用 */
export function summarizeTranscriptEntries(entries: readonly VisibleTranscriptEntry[]): {
  total: number;
  byRole: Record<string, number>;
} {
  const byRole: Record<string, number> = {};
  for (const e of entries) {
    const role = typeof e.role === 'string' && e.role ? e.role : 'unknown';
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  return { total: entries.length, byRole };
}
