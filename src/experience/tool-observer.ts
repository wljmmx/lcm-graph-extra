/**
 * after_tool_call 经验观察器 — OpenClaw SDK 2026.10.9 的 Observe 钩子接入。
 *
 * 背景：
 *   afterTurn 的经验提取只能看到「已落盘的消息」，工具失败往往在后续轮次被
 *   模型修复后，原始错误文本已被截断或合并，`fix_success` 只能靠关键词启发式
 *   （见 extractor.ts 的 isFixSuccess）在消息里找「成功了/通过了」。
 *
 * 10.9 把 `after_tool_call` 正式定义为 Observe 语义，事件携带
 * `toolName / params / result / error / durationMs`，因此在工具返回的瞬间即可
 * 精确地：
 *   - failure：工具报错（error 非空 / result.isError / details.ok === false）
 *   - fix_success：同一 session 内「同工具 + 同参数签名」先失败、后成功
 *
 * 约束：
 *   - 仅真实用户会话参与（cron / heartbeat / system 会话不写入，避免污染经验库）
 *   - failure 按签名去重（DEDUPE_TTL_MS 内不重复写）
 *   - 会话表 / 签名表均有上限，长生命周期进程中不会无界增长
 *   - 写入走 backgroundTasks，与 afterTurn 一致（fire-and-forget + 统一日志）
 */

import { randomUUID } from 'node:crypto';
import { backgroundTasks } from '../async/task-registry.js';
import { quickHash } from '../plugin/keywords.js';
import { isLearningEligibleSession } from '../utils/session-key.js';
import type { ExperienceSource, RawExperience } from './types.js';

/** 与 PluginHookAfterToolCallEvent 对齐（10.9） */
export interface ToolCallObservation {
  toolName: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ToolExperienceObserverLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ToolExperienceObserverOptions {
  /** 延迟读取：expStore 在 ensureInitialized 之后才可用 */
  getStore: () => { saveRaw(raw: RawExperience): Promise<void> } | null;
  /** 延迟读取插件配置，运行期变更可即时生效 */
  isEnabled?: () => boolean;
  getTriggers?: () => readonly ExperienceSource[];
  /** 经验写入成功后失效 L4 检索缓存 */
  onSaved?: () => void;
  logger?: ToolExperienceObserverLogger;
  now?: () => number;
}

export const DEFAULT_EXPERIENCE_TRIGGERS: readonly ExperienceSource[] = [
  'correction', 'failure', 'fix_success', 'explicit_save',
];

const DEDUPE_TTL_MS = 5 * 60 * 1000;
const FAILURE_TRACK_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_SIGNATURES_PER_SESSION = 50;
const MAX_DETAIL_CHARS = 2000;

interface TrackedFailure {
  ts: number;
  savedAt: number;
  error: string;
  detail: string;
}

interface SessionTrack {
  lastSeen: number;
  failures: Map<string, TrackedFailure>;
}

/** 判断一次工具调用是否失败（10.9 after_tool_call 事件形态） */
export function isToolCallFailure(event: ToolCallObservation): boolean {
  if (typeof event.error === 'string' && event.error.trim() !== '') return true;

  const result = event.result as Record<string, unknown> | null | undefined;
  if (!result || typeof result !== 'object') return false;

  if (result.isError === true || result.is_error === true) return true;

  const details = result.details as Record<string, unknown> | undefined;
  if (details && typeof details === 'object' && details.ok === false) return true;

  const content = result.content;
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (!block || typeof block !== 'object') return false;
      const b = block as Record<string, unknown>;
      return b.isError === true || b.is_error === true;
    });
  }

  return false;
}

/** 稳定签名：同工具 + 同参数视为同一「调用点」，用于 fix_success 配对 */
export function toolCallSignature(toolName: string, params?: unknown): string {
  return `${toolName}:${quickHash(safeStringify(params ?? {}))}`;
}

/** 生成可读的失败摘要（优先 error 字段，其次结果内容） */
export function describeToolCallFailure(event: ToolCallObservation): string {
  const direct = typeof event.error === 'string' ? event.error : '';
  const fromResult = pickErrorText(event.result);
  const text = firstLine(direct || fromResult || '工具执行失败');
  return text.slice(0, 160) || '工具执行失败';
}

export function createToolExperienceObserver(options: ToolExperienceObserverOptions) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionTrack>();

  function triggers(): readonly ExperienceSource[] {
    const configured = options.getTriggers?.();
    return Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_EXPERIENCE_TRIGGERS;
  }

  function getSession(key: string, ts: number): SessionTrack {
    const existing = sessions.get(key);
    if (existing) {
      existing.lastSeen = ts;
      return existing;
    }
    const created: SessionTrack = { lastSeen: ts, failures: new Map() };
    sessions.set(key, created);
    if (sessions.size > MAX_SESSIONS) {
      let oldestKey = '';
      let oldestTs = Infinity;
      for (const [k, v] of sessions) {
        if (v.lastSeen < oldestTs) { oldestTs = v.lastSeen; oldestKey = k; }
      }
      if (oldestKey) sessions.delete(oldestKey);
    }
    return created;
  }

  function prune(session: SessionTrack, ts: number): void {
    if (session.failures.size <= MAX_SIGNATURES_PER_SESSION) return;
    for (const [sig, entry] of session.failures) {
      if (ts - entry.ts > FAILURE_TRACK_TTL_MS) session.failures.delete(sig);
    }
    // 仍超限：按时间淘汰最旧的签名
    while (session.failures.size > MAX_SIGNATURES_PER_SESSION) {
      let oldestSig = '';
      let oldestTs = Infinity;
      for (const [sig, entry] of session.failures) {
        if (entry.ts < oldestTs) { oldestTs = entry.ts; oldestSig = sig; }
      }
      if (!oldestSig) break;
      session.failures.delete(oldestSig);
    }
  }

  /** 返回是否真正入队；store 未就绪时不标记已写，便于后续重试 */
  function save(source: ExperienceSource, sessionId: string, context: string, detail: string): boolean {
    const store = options.getStore();
    if (!store) return false;
    const raw: RawExperience = {
      id: `exp_raw_${randomUUID()}`,
      source,
      sessionId,
      timestamp: new Date(now()),
      context,
      detail: truncate(detail, MAX_DETAIL_CHARS),
    };
    options.logger?.debug?.(`[after_tool_call] experience observed: source=${source}, id=${raw.id}`);
    backgroundTasks.register('exp:tool-observe', store.saveRaw(raw).then(() => {
      options.onSaved?.();
    }));
    return true;
  }

  function handle(event: ToolCallObservation, ctx?: Record<string, unknown>): void {
    if (!event || typeof event.toolName !== 'string' || !event.toolName) return;
    if (options.isEnabled?.() === false) return;

    const t = triggers();
    if (!t.includes('failure') && !t.includes('fix_success')) return;

    const sessionId = pickSessionId(ctx);
    if (!sessionId || !isLearningEligibleSession(sessionId)) return;

    const ts = now();
    const session = getSession(sessionId, ts);
    prune(session, ts);

    const signature = toolCallSignature(event.toolName, event.params);

    if (isToolCallFailure(event)) {
      const error = describeToolCallFailure(event);
      const detail = buildFailureDetail(event, error);
      const tracked = session.failures.get(signature);
      const shouldSave = t.includes('failure') && (!tracked || ts - tracked.savedAt >= DEDUPE_TTL_MS);

      if (tracked) {
        tracked.ts = ts;
        tracked.error = error;
        tracked.detail = detail;
      } else {
        session.failures.set(signature, { ts, savedAt: 0, error, detail });
      }

      if (shouldSave) {
        const entry = session.failures.get(signature)!;
        if (save('failure', sessionId, `失败: ${event.toolName} — ${error}`, detail)) {
          entry.savedAt = ts;
        }
      }
      return;
    }

    // 成功调用：只有命中「此前的失败签名」才算 fix_success，避免每次成功都写经验
    const prior = session.failures.get(signature);
    if (!prior) return;
    session.failures.delete(signature);

    if (ts - prior.ts > FAILURE_TRACK_TTL_MS) return;
    if (!t.includes('fix_success')) return;

    save(
      'fix_success',
      sessionId,
      `修复通过: ${event.toolName} — ${prior.error}`,
      buildFixDetail(event, prior),
    );
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pickSessionId(ctx?: Record<string, unknown>): string {
  if (!ctx) return '';
  const key = ctx.sessionKey;
  if (typeof key === 'string' && key.trim() !== '') return key.trim();
  const id = ctx.sessionId;
  if (typeof id === 'string' && id.trim() !== '') return id.trim();
  return '';
}

function buildFailureDetail(event: ToolCallObservation, error: string): string {
  const lines = [
    `工具: ${event.toolName}`,
    `参数: ${truncate(safeStringify(event.params ?? {}), 800)}`,
    `错误: ${truncate(error, 800)}`,
  ];
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)) {
    lines.push(`耗时: ${Math.round(event.durationMs)}ms`);
  }
  return lines.join('\n');
}

function buildFixDetail(event: ToolCallObservation, prior: TrackedFailure): string {
  const lines = [
    `工具: ${event.toolName}`,
    `参数: ${truncate(safeStringify(event.params ?? {}), 800)}`,
    `前序失败: ${truncate(prior.error, 800)}`,
    `本次结果: ${truncate(pickResultText(event.result) || '(无输出)', 600)}`,
  ];
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)) {
    lines.push(`耗时: ${Math.round(event.durationMs)}ms`);
  }
  return lines.join('\n');
}

function pickErrorText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const details = r.details as Record<string, unknown> | undefined;
  if (details && typeof details === 'object') {
    if (typeof details.error === 'string' && details.error) return details.error;
    if (typeof details.message === 'string' && details.message) return details.message;
  }
  if (typeof r.error === 'string' && r.error) return r.error;
  return pickResultText(result);
}

/** 从 content blocks 中拼接文本（用于错误摘要 / 修复结果摘要） */
function pickResultText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return typeof result === 'string' ? result : '';
  }
  const r = result as Record<string, unknown>;
  if (typeof r.output === 'string' && r.output) return r.output;
  if (typeof r.result === 'string' && r.result) return r.result;

  const content = r.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string' && b.text) parts.push(b.text);
      }
    }
    return parts.join('\n');
  }

  if (typeof content === 'string') return content;
  return '';
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
