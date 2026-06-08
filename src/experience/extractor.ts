/**
 * Experience Extractor — 从对话消息中检测并提取原始经验。
 *
 * 触发条件（在 afterTurn 中调用）:
 *   correction:  消息包含纠正信号（用户说"不对"/"错了"/主动修正）
 *   failure:     工具报错 / 超时 / 执行异常（toolResult.isError === true）
 *   fix_success: 前序失败的任务重新执行通过
 *   explicit_save:用户明确说"记住这个"、"记录下"、"别忘了"
 *
 * 提取方式: 轻量规则匹配 + 可选 LLM 确认
 */

import type { ExperienceSource, RawExperience } from './types';

// ---------------------------------------------------------------------------
// 纠正关键词 — 用户指出错误
// ---------------------------------------------------------------------------
const CORRECTION_PATTERNS = [
  /不对[，,。]?/,
  /错了[，,。]?/,
  /不是[，,。]?\s*(这样|这个|那个|如此)/,
  /不该[，,。]?\s*(这样|这么做|用这个)/,
  /不应该/,
  /错了[！!]/,
  /说错了/,
  /搞错了/,
  /理解错了/,
  /你会不会/,
  /不是叫你/,
  /我刚才说了/,
  /更正[：:]/,
  /纠正[：:]/,
];

// ---------------------------------------------------------------------------
// 显式保存关键词
// ---------------------------------------------------------------------------
const SAVE_PATTERNS = [
  /记住[，,。]?/,
  /记下来[，,。]?/,
  /记录[，,。]?(下|一下|下来)/,
  /别忘了[，,。]?/,
  /保存[，,。]?(这个|这条|这段)/,
  /keep this/i,
  /remember this/i,
  /note that/i,
];

// ---------------------------------------------------------------------------
// Failure 检测
// ---------------------------------------------------------------------------

/** 判断 toolResult 是否包含错误 */
function isToolResultError(message: Record<string, unknown>): boolean {
  if (message.role !== 'toolResult') return false;
  if (message.isError === true) return true;
  if (message.is_error === true) return true;

  // Deep check in content blocks
  const content = message.content;
  if (Array.isArray(content)) {
    return content.some((block: Record<string, unknown>) => {
      return block.isError === true || block.is_error === true;
    });
  }
  return false;
}

/** 判断文本是否包含失败信号 */
function hasFailureSignal(text: string): boolean {
  const signals = [
    /error/i, /fail/i, /timeout/i, /超时/i, /失败/i,
    /cannot resolve/i, /connection refused/i, /ECONNREFUSED/i,
    /ENOTFOUND/i, /EACCES/i, /EPERM/i, /ETIMEDOUT/i,
    /unexpected/i, /syntax error/i, /reference error/i,
  ];
  return signals.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Fix success 检测
// ---------------------------------------------------------------------------

/** 检测"重新执行成功了"的上下文 */
function isFixSuccess(
  text: string,
  priorMessages: Array<Record<string, unknown>>,
): boolean {
  // 当前消息有成功信号
  const successSignals = [
    /成功了/i, /通过了/i, /完成了/i, /已修复/i, /修复了/i,
    /正常运行/i, /成功部署/i, /不再报错/i,
  ];
  const hasSuccess = successSignals.some((p) => p.test(text));
  if (!hasSuccess) return false;

  // 前序消息中有失败记录（最近 5 条内）
  const recentPrior = priorMessages.slice(-5);
  return recentPrior.some((msg) => {
    if (typeof msg.content === 'string') return hasFailureSignal(msg.content);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Main detector
// ---------------------------------------------------------------------------

/**
 * 检测当前消息是否触发了经验提取条件。
 */
export function detectExperienceTrigger(
  message: Record<string, unknown>,
  priorMessages: Array<Record<string, unknown>>,
): ExperienceSource | null {
  const role = message.role;
  const text = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content || '');

  // 1. 工具调用失败
  if (role === 'toolResult' && isToolResultError(message)) {
    return 'failure';
  }

  // 2. 用户纠正
  if (role === 'user') {
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(text)) return 'correction';
    }
  }

  // 3. 明确保存
  if (role === 'assistant' || role === 'user') {
    for (const pattern of SAVE_PATTERNS) {
      if (pattern.test(text)) return 'explicit_save';
    }
  }

  // 4. 修复成功（当前消息是成功信号 + 前序有失败）
  if (isFixSuccess(text, priorMessages)) {
    return 'fix_success';
  }

  return null;
}

/**
 * 从消息中提取原始经验内容。
 * 返回的结构可用于写入 Neo4j PENDING 节点。
 */
export function extractRawExperience(
  source: ExperienceSource,
  message: Record<string, unknown>,
  sessionId: string,
  taskId?: string,
): RawExperience {
  const text = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content || '');

  // 截取关键片段（前 500 字）
  const shortContext = text.slice(0, 500);

  return {
    id: `exp_raw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    source,
    sessionId,
    timestamp: new Date(),
    context: describeTriggerContext(source, shortContext),
    detail: text.length > 2000 ? text.slice(0, 2000) + '...' : text,
    taskId,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function describeTriggerContext(source: ExperienceSource, text: string): string {
  const firstLine = text.split('\n')[0]?.slice(0, 120) || '(empty)';
  switch (source) {
    case 'correction':  return `纠正: ${firstLine}`;
    case 'failure':     return `失败: ${firstLine}`;
    case 'fix_success': return `修复通过: ${firstLine}`;
    case 'explicit_save': return `记录: ${firstLine}`;
  }
}
