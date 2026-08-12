/**
 * MoA 自适应学习模型
 *
 * 用累积的实测数据逐步校准 MoA 决策中"能力分档"与"成本预估"两个静态启发式，
 * 使决策随使用时间越来越贴合实际环境：
 *
 * 1. 能力校准（优化点 1）
 *    每个 (model, task) 记录成功/总次数，用贝叶斯平滑得到一个"可靠性"，
 *    在启发式能力分档基础上做温和修正：持续稳定产出的模型能力上调，
 *    常失败的模型能力下调。样本很少时不偏离启发式（受 prior 约束）。
 *
 * 2. Token 成本学习（优化点 3）
 *    每个 model 记录实际输入/输出 token 的滑动均值，替代"相对单价"的粗估，
 *    让"便宜但长输出" / "贵但短输出"的模型成本被真实反映。
 *
 * 持久化：~/.openclaw/moa-learning.json，异步节流写入，失败静默不影响主流程。
 */

import { mkdirSync, existsSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// 内存状态
// ============================================================================

interface CapabilityStat {
  /** 去重键 = model + '::' + (task || '') */
  key: string;
  model: string;
  task?: string;
  /** 成功（可靠产出有效结果）次数 */
  success: number;
  /** 总调用次数 */
  total: number;
}

interface TokenStat {
  model: string;
  inputTotal: number;
  outputTotal: number;
  calls: number;
}

/** key: model + '::' + (task || '') */
const capabilityStats = new Map<string, CapabilityStat>();
/** key: model */
const tokenStats = new Map<string, TokenStat>();

// ============================================================================
// 贝叶斯平滑参数
// ============================================================================

/**
 * 先验可靠性：启发式能力分档默认假定模型约 90% 可靠。
 * 样本越少，实测可靠性越被拉向先验，避免少数样本导致能力大幅漂移。
 */
const RELIABILITY_PRIOR = 0.9;
/** 先验等效样本量：低于该次样本时，校准偏移被显著抑制 */
const PRIOR_N = 5;
/** 可靠性 → 能力修正的增益（能力分档本身 0-1，不宜大幅摆动） */
const RELIABILITY_GAIN = 0.8;

// ============================================================================
// 记录 API
// ============================================================================

/** 标准化模型键（统一小写，便于跨配置匹配） */
function normalizeModel(model: string): string {
  return (model || '').trim().toLowerCase();
}

/**
 * 记录一次模型调用结果，用于能力校准。
 * @param model 模型名
 * @param success 是否成功（产出有效结果）
 * @param task 任务类型（code-review/architecture/security，可选）
 */
export function recordModelOutcome(model: string, success: boolean, task?: string): void {
  const m = normalizeModel(model);
  if (!m) return;
  const key = m + '::' + (task ?? '');
  const cur = capabilityStats.get(key) ?? { key, model: m, task, success: 0, total: 0 };
  cur.total += 1;
  if (success) cur.success += 1;
  capabilityStats.set(key, cur);
  persistThrottled();
}

/**
 * 记录一次模型的实际 token 消耗，用于成本预估学习。
 * @param model 模型名
 * @param inputTokens 输入 token 数
 * @param outputTokens 输出 token 数
 */
export function recordTokenUsage(model: string, inputTokens: number, outputTokens: number): void {
  const m = normalizeModel(model);
  if (!m) return;
  const cur = tokenStats.get(m) ?? { model: m, inputTotal: 0, outputTotal: 0, calls: 0 };
  cur.inputTotal += Number(inputTokens) || 0;
  cur.outputTotal += Number(outputTokens) || 0;
  cur.calls += 1;
  tokenStats.set(m, cur);
  persistThrottled();
}

// ============================================================================
// 读取 API（供复杂度决策使用）
// ============================================================================

/**
 * 返回校准后的模型能力（0-1）。
 *
 * 逻辑：先取启发式分档 heuristicBase，再用实测可靠性做温和修正。
 * 可靠性 = 贝叶斯平滑后的 success/total。样本少时可靠性≈先验 → 几乎不偏移。
 *
 * 匹配策略：优先 (model, task) 精确键；无任务/无数据时退化为 model 单独统计；
 * 仍无数据则原样返回启发式。
 */
export function getCalibratedStrength(
  model: string,
  _baseURL: string | undefined,
  task: string | undefined,
  heuristicBase: number,
): number {
  const m = normalizeModel(model);
  if (!m) return heuristicBase;

  // 1) 精确 (model, task)
  let stat = m !== '' && task ? capabilityStats.get(m + '::' + task) : undefined;
  // 2) 退化为 model 单独（跨任务聚合）
  if (!stat) {
    // 聚合所有该 model 的条目（无论 task）
    let success = 0;
    let total = 0;
    for (const [, s] of capabilityStats) {
      if (s.model === m) {
        success += s.success;
        total += s.total;
      }
    }
    if (total > 0) stat = { key: m, model: m, success, total };
  }
  if (!stat || stat.total <= 0) return heuristicBase;

  // 贝叶斯平滑可靠性
  const reliability = (stat.success + RELIABILITY_PRIOR * PRIOR_N) / (stat.total + PRIOR_N);
  const calibrated = heuristicBase + (reliability - RELIABILITY_PRIOR) * RELIABILITY_GAIN;
  return Math.min(1, Math.max(0, calibrated));
}

/** 返回某模型的实测平均输入/输出 token（无数据返回 undefined） */
export function getExpectedTokens(model: string): { input: number; output: number } | undefined {
  const m = normalizeModel(model);
  const stat = m ? tokenStats.get(m) : undefined;
  if (!stat || stat.calls <= 0) return undefined;
  return {
    input: stat.inputTotal / stat.calls,
    output: stat.outputTotal / stat.calls,
  };
}

/** 学习数据摘要（供 UI/调试查看） */
export function getLearningSummary(): {
  capability: Array<{ model: string; task?: string; success: number; total: number; reliability: number }>;
  tokens: Array<{ model: string; avgInput: number; avgOutput: number; calls: number }>;
} {
  const capability = [...capabilityStats.values()].map((s) => ({
    model: s.model,
    task: s.task,
    success: s.success,
    total: s.total,
    reliability: s.total > 0 ? Math.round((s.success / s.total) * 1000) / 1000 : 0,
  }));
  const tokens = [...tokenStats.values()].map((t) => ({
    model: t.model,
    avgInput: t.calls > 0 ? Math.round((t.inputTotal / t.calls) * 100) / 100 : 0,
    avgOutput: t.calls > 0 ? Math.round((t.outputTotal / t.calls) * 100) / 100 : 0,
    calls: t.calls,
  }));
  return { capability, tokens };
}

// ============================================================================
// 持久化
// ============================================================================

const LEARNING_FILE = join(homedir(), '.openclaw', 'moa-learning.json');
const FILE_VERSION = 1;

let lastPersistTime = 0;
const PERSIST_THROTTLE_MS = 5_000;

interface PersistedFile {
  version: number;
  savedAt: number;
  capability: CapabilityStat[];
  tokens: TokenStat[];
}

function persistThrottled(): void {
  const now = Date.now();
  if (now - lastPersistTime < PERSIST_THROTTLE_MS) return;
  lastPersistTime = now;
  setImmediate(async () => {
    try {
      const dir = join(homedir(), '.openclaw');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload: PersistedFile = {
        version: FILE_VERSION,
        savedAt: Date.now(),
        capability: [...capabilityStats.values()],
        tokens: [...tokenStats.values()],
      };
      await writeFile(LEARNING_FILE, JSON.stringify(payload), 'utf-8');
    } catch {
      // 静默失败，不影响主流程
    }
  });
}

async function loadFromDisk(): Promise<void> {
  try {
    if (!existsSync(LEARNING_FILE)) return;
    const raw = await readFile(LEARNING_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedFile>;
    if (typeof parsed.version !== 'number' || parsed.version !== FILE_VERSION) return;
    if (Array.isArray(parsed.capability)) {
      for (const c of parsed.capability) {
        if (c && c.key && typeof c.total === 'number') {
          capabilityStats.set(c.key, c);
        }
      }
    }
    if (Array.isArray(parsed.tokens)) {
      for (const t of parsed.tokens) {
        if (t && t.model && typeof t.calls === 'number') {
          tokenStats.set(t.model, t);
        }
      }
    }
  } catch {
    // 静默失败
  }
}

// 模块加载时异步还原（不阻塞导入）
void loadFromDisk();

export { LEARNING_FILE, loadFromDisk };