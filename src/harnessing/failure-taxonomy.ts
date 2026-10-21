/**
 * Harnessing P6: 失败四分类法。
 *
 * 借鉴 Life-Harness（arXiv:2605.22166）的 failure annotation 协议，
 * 把自由文本失败描述归入四类，让 propose 的输入结构化：
 *
 *   action-realization      动作实现失败 —— 工具/命令执行出错、参数错误
 *   environment-contract    环境契约失配 —— 配置缺失、依赖/版本不符、接口约定变化
 *   trajectory-degeneration 轨迹退化     —— 重复、循环、上下文丢失
 *   residual-reasoning      残余推理失败 —— 理解/推理错误（harness 侧无解，仅记录）
 *
 * 纯规则（关键词，中英双语）、零 LLM、确定性。规则顺序即优先级：
 * 环境契约最先（最具基础设施特异性），推理失败最后兜底。
 */

import type { FailureKind, FailureSignal } from './types.js';

export const FAILURE_KIND_LABELS: Record<FailureKind, string> = {
  'action-realization': '动作实现失败（工具/命令执行出错）',
  'environment-contract': '环境契约失配（配置/依赖/接口约定不符）',
  'trajectory-degeneration': '轨迹退化（重复/循环/上下文丢失）',
  'residual-reasoning': '残余推理失败（理解/推理错误）',
};

/** 分类规则（顺序 = 优先级） */
const RULES: ReadonlyArray<{ kind: FailureKind; patterns: RegExp[] }> = [
  {
    kind: 'environment-contract',
    patterns: [
      /找不到模块|无法找到模块|module not found|cannot find module|ERR_MODULE_NOT_FOUND/i,
      /未安装|依赖缺失|not installed|peer dep|版本不满足|EBADENGINE|engine.*not satisf/i,
      /配置缺失|配置错误|missing config|invalid config|契约|contract mis/i,
      /权限被拒|EACCES|ENOENT|连接失败|connection refused/i,
    ],
  },
  {
    kind: 'action-realization',
    patterns: [
      /工具调用失败|工具执行失败|tool (call |execution )?fail|invalid (params|arguments|tool)|参数错误/i,
      /命令执行失败|command fail|非零退出|exit code| ExitStatus /i,
      /超时|timeout|timed out|aborted|中断/i,
      /越界|越权|permission denied|not allowed/i,
    ],
  },
  {
    kind: 'trajectory-degeneration',
    patterns: [
      /重复输出|原地打转|死循环|无限循环|repetiti|loop(ing)? (forever|infinitely)|degenerat/i,
      /上下文丢失|上下文溢出|context (lost|overflow|exceed)|遗忘|forget(ting)? context/i,
      /反复(尝试|请求)|again and again|keeps? (retry|asking)/i,
    ],
  },
  {
    kind: 'residual-reasoning',
    patterns: [
      /理解错|误解|misunderstand|理解偏差/i,
      /推理错误|错误结论|reasoning (error|fail)|wrong (answer|conclusion)|逻辑错误/i,
      /幻觉|hallucinat|编造|虚构/i,
    ],
  },
];

/**
 * 从失败描述文本推断分类。
 * @returns 命中的分类；无任何规则命中返回 null（调用方决定兜底策略）
 */
export function classifyFailure(text: string): FailureKind | null {
  if (!text || typeof text !== 'string') return null;
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(text)) return rule.kind;
    }
  }
  return null;
}

/**
 * 归一化失败信号：字符串输入自动分类；缺 kind 的对象信号补分类。
 * 无法分类的文本按 residual-reasoning 兜底（记录而不丢弃 —— 与 Harness²
 * "残余失败也要进审计"的态度一致），count 缺省为 1。
 */
export function normalizeSignals(inputs: ReadonlyArray<string | FailureSignal>): FailureSignal[] {
  const out: FailureSignal[] = [];
  for (const raw of inputs ?? []) {
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (!t) continue;
      out.push({ kind: classifyFailure(t) ?? 'residual-reasoning', text: t, count: 1 });
    } else if (raw && typeof raw.text === 'string' && raw.text.trim()) {
      out.push({
        kind: raw.kind ?? classifyFailure(raw.text) ?? 'residual-reasoning',
        text: raw.text.trim(),
        source: raw.source,
        count: typeof raw.count === 'number' && raw.count > 0 ? Math.trunc(raw.count) : 1,
      });
    }
  }
  return out;
}
