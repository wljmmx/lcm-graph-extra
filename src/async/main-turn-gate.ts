/**
 * 主轮门控（main-turn gate）—— 后台 LLM 任务给主对话轮让路。
 *
 * 背景：assemble 结束 → host LLM 生成（本地大模型可达数分钟）→ afterTurn 开始
 * 这段"生成窗口"内，插件没有任何进行中信号。蒸馏（LLM 批量）、债务压缩等
 * 后台任务在此窗口打进本地 Ollama，与主模型生成串行排队争抢 → 主生成无输出流
 * → host "stopped making progress" 中断。
 *
 * 语义：
 * - assemble 入口 beginMainTurn(sessionKey) 持门
 * - afterTurn 结束（finally）endMainTurn(sessionKey) 释放 —— 恰好覆盖生成窗口
 * - isMainTurnActive()：任一会话持门，或距最后一次释放不足 cooldown（默认 30s，
 *   覆盖 afterTurn 结束到用户下一条消息的间隙）
 * - 泄漏兜底：持门超过 maxTurnMs（默认 15min）的会话视为僵尸（afterTurn 因
 *   异常未达），自动过期释放
 *
 * 消费方：heartbeat 蒸馏、债务调度器 pollAndDispatch。二者都是"可推迟工作"，
 * 让路后靠自身轮询周期自然重试，不丢失。
 */

const _activeTurnSessions = new Map<string, number>(); // sessionKey → beginAt

/** 距最后一次主轮释放的让路窗口（覆盖 afterTurn → 下一条消息的间隙） */
const DEFAULT_COOLDOWN_MS = 30_000;
/** 持门会话的僵尸过期上限（afterTurn 未达时的泄漏兜底） */
const DEFAULT_MAX_TURN_MS = 15 * 60_000;

let _lastTurnEndAt = 0;

/** assemble 入口调用：标记该会话进入主对话轮（幂等，重复 begin 刷新时间戳） */
export function beginMainTurn(sessionKey: string): void {
  if (!sessionKey) return;
  _activeTurnSessions.set(sessionKey, Date.now());
}

/** afterTurn 结束时调用（finally）：释放该会话的主轮门 */
export function endMainTurn(sessionKey: string): void {
  if (!sessionKey) return;
  _activeTurnSessions.delete(sessionKey);
  _lastTurnEndAt = Date.now();
}

/**
 * 是否有主对话轮进行中（或刚结束不久）。
 * 后台 LLM 任务（蒸馏 / 债务压缩）在此期间应让路。
 */
export function isMainTurnActive(
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
  maxTurnMs: number = DEFAULT_MAX_TURN_MS,
): boolean {
  const now = Date.now();
  // 僵尸过期：持门超过 maxTurnMs 的会话视为泄漏（afterTurn 未达），释放
  for (const [sk, beginAt] of _activeTurnSessions) {
    if (now - beginAt > maxTurnMs) _activeTurnSessions.delete(sk);
  }
  if (_activeTurnSessions.size > 0) return true;
  return (now - _lastTurnEndAt) < cooldownMs;
}

/** 诊断：当前持门的会话 key 列表 */
export function activeTurnSessions(): string[] {
  return [..._activeTurnSessions.keys()];
}

/** 测试用：重置门控状态 */
export function resetMainTurnGate(): void {
  _activeTurnSessions.clear();
  _lastTurnEndAt = 0;
}
