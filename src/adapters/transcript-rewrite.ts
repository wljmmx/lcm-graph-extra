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

/**
 * 宿主 `isCompactionReplayCheckpoint` 接受的 provider 压缩回放类型。
 *
 * 依据 openclaw 2026.10.4 `session-DitLEF2L.mjs`：
 *   isCompactionReplayCheckpoint(replay) →
 *     replay.type === "anthropic-compaction"
 *     || "openai-responses-compaction"
 *     || "openai-responses-retained-compaction"
 * 这是宿主自身对「可剥离回放检查点」的唯一定义，故此处直接复用，不自造判据。
 */
export const COMPACTION_REPLAY_TYPES: readonly string[] = [
  'anthropic-compaction',
  'openai-responses-compaction',
  'openai-responses-retained-compaction',
];

/** P2 观察项：若执行改写，潜在可剥离的回放检查点统计 */
export interface ReplayCheckpointReport {
  /** 携带 provider 压缩回放检查点的 assistant 条目数（宿主 stripStalePrefixReplay 的目标集合） */
  count: number;
  /** 命中的条目 id（供后续构造 replacements 使用） */
  entryIds: string[];
  /** 预计可释放字节数（宿主 findTranscriptRewriteMatches 同款公式：原 JSON - 剥离后 JSON） */
  estimatedBytesFreed: number;
}

/**
 * P2（**纯函数 / 只读**）：量化「若调用 rewriteTranscriptEntries 剥离 providerReplay 能释放多少」。
 *
 * 设计意图：在真正写盘之前，先用可观测数据回答「改写是否值得」。
 * 若本函数长期返回 `count === 0`，说明该宿主路径下无可剥离内容，写入能力即可不启用。
 *
 * 字节估算与宿主 `findTranscriptRewriteMatches` 保持一致：
 *   byteLength(originalJson) - byteLength(stripStalePrefixReplay 后的 JSON)
 */
export function detectReplayCheckpointEntries(
  entries: readonly VisibleTranscriptEntry[],
): ReplayCheckpointReport {
  const entryIds: string[] = [];
  let estimatedBytesFreed = 0;

  for (const e of entries) {
    const message = e.message;
    if (!message || typeof message !== 'object') continue;
    // 宿主 stripStalePrefixReplay 的第一道条件：仅 assistant 消息
    if (message.role !== 'assistant') continue;
    const replay = (message as Record<string, unknown>).providerReplay;
    if (!replay || typeof replay !== 'object') continue;
    if (!COMPACTION_REPLAY_TYPES.includes((replay as { type?: unknown }).type as string)) continue;

    // 剥离 providerReplay 后的「回放安全」消息（与宿主 stripCompactionReplayCheckpoint 同语义）
    const replaySafe: Record<string, unknown> = { ...message };
    delete replaySafe.providerReplay;

    const originalJson = JSON.stringify(message);
    const safeJson = JSON.stringify(replaySafe);
    // 仅统计确有差异的条目：与宿主「无差异则不计入 matchedIndices」一致
    if (originalJson === safeJson) continue;

    entryIds.push(e.entryId);
    estimatedBytesFreed += Math.max(
      0,
      Buffer.byteLength(originalJson) - Buffer.byteLength(safeJson),
    );
  }

  return { count: entryIds.length, entryIds, estimatedBytesFreed };
}

/**
 * P4：写入开关（默认关闭 = observe-only）。
 *
 * 遵循「先观察后强执」：本能力会**改写活动转录**（破坏性），
 * 因此在观察数据证明 `lcm_transcript_replay_checkpoint_entries` 确有内容之前，
 * 默认只观察、不写盘；运维确认后才显式开启。
 *
 *   LCMG_TRANSCRIPT_REWRITE=enforce  → 执行剥离写入
 *   其他 / 未设置                     → 仅观察（默认）
 */
export function isTranscriptRewriteEnforced(): boolean {
  return (process.env.LCMG_TRANSCRIPT_REWRITE ?? '').trim().toLowerCase() === 'enforce';
}

/** P4：单次写入的条目数上限（保守，避免一次改动过多转录条目） */
export const TRANSCRIPT_REWRITE_MAX_ENTRIES = 50;

/** P4：构造 replacements 的结果 */
export interface ReplayStripPlan {
  replacements: Array<{ entryId: string; message: Record<string, unknown> }>;
  /** 计划改写的条目数（受上限截断后） */
  count: number;
  /** 因上限被截断而未纳入的条目数 */
  truncated: number;
}

/**
 * P4（**纯函数**）：把命中回放检查点的条目构造为 `replacements`。
 *
 * 替换内容 = 剥离 `providerReplay` 后的消息副本，与宿主 `stripCompactionReplayCheckpoint` 同语义。
 * 幂等性：剥离后该条目不再携带 `providerReplay`，下次 `detectReplayCheckpointEntries` 自然返回 0，
 * 因此**无需额外幂等标记** —— 不会重复改写同一条目。
 */
export function buildReplayStripReplacements(
  entries: readonly VisibleTranscriptEntry[],
  maxEntries: number = TRANSCRIPT_REWRITE_MAX_ENTRIES,
): ReplayStripPlan {
  const replacements: Array<{ entryId: string; message: Record<string, unknown> }> = [];
  let truncated = 0;

  for (const e of entries) {
    const message = e.message;
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'assistant') continue;
    const replay = (message as Record<string, unknown>).providerReplay;
    if (!replay || typeof replay !== 'object') continue;
    if (!COMPACTION_REPLAY_TYPES.includes((replay as { type?: unknown }).type as string)) continue;

    const replaySafe: Record<string, unknown> = { ...message };
    delete replaySafe.providerReplay;
    // 与宿主一致：无差异则不纳入（否则宿主 findTranscriptRewriteMatches 会判定 no-op）
    if (JSON.stringify(message) === JSON.stringify(replaySafe)) continue;

    if (replacements.length >= maxEntries) {
      truncated++;
      continue;
    }
    replacements.push({ entryId: e.entryId, message: replaySafe });
  }

  return { replacements, count: replacements.length, truncated };
}
