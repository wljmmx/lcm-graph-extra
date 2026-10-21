/**
 * Harnessing 自动信号收集器 —— 默认介入路径的信号源（纯内存、零 IO）。
 *
 * 职责：
 *   1. 收集运行时失败信号（工具调用失败等），自动四分类，聚合计数；
 *   2. 从信号构造自动探针集（信号中提到的已知工具 → {query, expectedTools}）；
 *   3. 保存最近一次自动观察步摘要（供诊断展示）。
 *
 * 设计约束（对齐本仓 P0–P4 风格）：
 *   - 环形缓冲（上限 200 条）+ 24h TTL，重启即清零，零持久化成本；
 *   - drain 语义：心跳步取走即清空，同一信号不会被重复消费；
 *   - 收集本身**不触发任何写盘**——写入必须显式走 lcmg_harness_step mode=apply。
 */

import type { FailureSignal, ProbeFixture } from './types.js';
import { classifyFailure } from './failure-taxonomy.js';

const MAX_SIGNALS = 200;
const SIGNAL_TTL_MS = 24 * 60 * 60 * 1000;

interface SignalEntry extends FailureSignal {
  _key: string;
  _ts: number;
}

const _ring: SignalEntry[] = [];

function prune(): void {
  const now = Date.now();
  while (_ring.length > 0 && now - _ring[0]._ts > SIGNAL_TTL_MS) _ring.shift();
  while (_ring.length > MAX_SIGNALS) _ring.shift();
}

/**
 * 记录一条失败信号（文本自动分类；同 text+source 聚合计数，不重复占位）。
 * @returns 是否实际记录（空文本返回 false）
 */
export function recordHarnessSignal(
  text: string,
  source?: string,
  kind?: FailureSignal['kind'],
): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  prune();
  const key = (source ?? '') + '\u241f' + t;
  const existing = _ring.find((e) => e._key === key);
  if (existing) {
    existing.count = (existing.count ?? 1) + 1;
    existing._ts = Date.now();
    return true;
  }
  _ring.push({
    _key: key,
    _ts: Date.now(),
    kind: kind ?? classifyFailure(t) ?? 'residual-reasoning',
    text: t,
    source,
    count: 1,
  });
  return true;
}

/** 取走全部信号（清空缓冲 —— drain 语义，避免重复消费） */
export function drainHarnessSignals(): FailureSignal[] {
  prune();
  const out: FailureSignal[] = _ring.map((e) => ({
    kind: e.kind,
    text: e.text,
    source: e.source,
    count: e.count,
  }));
  _ring.length = 0;
  return out;
}

/** 观察当前信号池（不清空，供诊断展示） */
export function peekHarnessSignals(): {
  count: number;
  totalOccurrences: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
} {
  prune();
  const byKind: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let totalOccurrences = 0;
  for (const e of _ring) {
    const k = e.kind ?? 'unclassified';
    byKind[k] = (byKind[k] ?? 0) + 1;
    if (e.source) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    totalOccurrences += e.count ?? 1;
  }
  return { count: _ring.length, totalOccurrences, byKind, bySource };
}

/**
 * 从失败信号构造自动探针集：
 * 信号文本中提到的已知工具 → {query: 信号文本截断, expectedTools: [该工具]}。
 * 这是真实观察对（该工具确实在该场景失败过），cap 20 与探测预算对齐。
 */
export function buildAutoFixtures(
  signals: readonly FailureSignal[],
  knownTools: readonly string[],
  cap: number = 20,
): ProbeFixture[] {
  const fixtures: ProbeFixture[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    if (fixtures.length >= cap) break;
    const lower = s.text.toLowerCase();
    for (const tool of knownTools) {
      if (fixtures.length >= cap) break;
      const tl = tool.toLowerCase();
      if (lower.includes(tl) && !seen.has(tl)) {
        seen.add(tl);
        fixtures.push({ query: s.text.slice(0, 200), expectedTools: [tool] });
      }
    }
  }
  return fixtures;
}

// ---------------------------------------------------------------------------
// 最近一次自动观察步摘要（诊断展示用，非持久化）
// ---------------------------------------------------------------------------

export interface AutoStepSnapshot {
  ts: number;
  ran: boolean;
  skipped?: string;
  signalCount: number;
  stepId?: string;
  proposals?: number;
  adopted?: number;
  rejected?: number;
  inconclusive?: number;
  lessonsWritten?: number;
}

let _lastAutoStep: AutoStepSnapshot | null = null;

export function setLastAutoStep(s: AutoStepSnapshot): void {
  _lastAutoStep = s;
}

export function getLastAutoStep(): AutoStepSnapshot | null {
  return _lastAutoStep;
}

/** 清空信号池与快照（测试/运维用） */
export function resetHarnessingDiagnostics(): void {
  _ring.length = 0;
  _lastAutoStep = null;
}
