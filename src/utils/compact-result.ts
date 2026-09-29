/**
 * compact() 早退结果的统一构造 —— 走真实报错，不污染正确压缩结果。
 *
 * 背景：ContextEngine.compact() 有多个"未真正发生压缩"的早退分支：
 * 宿主已 abort、初始化失败、主轮进行中（让路）、同会话冷却（跳过）。
 * 这些分支此前各自内联返回 `{ ok:false, compacted:false, reason }`，缺少契约声明的
 * error 字段，读者无法区分"压缩失败"与"压缩被跳过"，且分散在多处容易漂移。
 *
 * 契约对齐：LosslessClawAdapter.compact 的错误分支约定为
 *   { ok:false, compacted:false, reason:<msg>, error:<msg> }
 * （见 src/middleware/lossless-claw-adapter.ts 的 catch 分支）。
 * 本模块让引擎层早退与之保持一致。
 *
 * 不污染原则（硬约束，由 compactEarlyExit 的返回值形状保证）：
 *  1. ok / compacted 恒为 false —— 绝不把早退伪装成"压缩成功"。
 *  2. 绝不携带 result（tokensBefore / tokensAfter / summary / firstKeptEntryId /
 *     summaryId）—— result 是"正确压缩结果"的载体，早退路径不得伪造，
 *     否则 SDK 与仪表盘会把"跳过一次压缩"统计成一次有效压缩。
 *  3. error 必须可读且非空，便于定位与用户提示；空白 error 回退为 reason，
 *     避免出现"报了错但看不出错在哪"的空报错。
 *
 * 边界（不在本模块职责内）：真正跑过 lossless-claw 但"无新压缩可做"的路径
 * （context 已低于阈值）会返回 compacted:true 以避免 SDK recovery 判定失败后
 * 无限重试，见 src/index.ts 的 "no compaction produced" 分支——那是该路径刻意
 * 为之的既有取舍，不属于早退，也不由本模块构造。
 */

export interface CompactEarlyExitResult {
  ok: false;
  compacted: false;
  reason: string;
  error: string;
}

/**
 * 构造早退结果：恒 ok=false / compacted=false / 无 result。
 *
 * @param reason 稳定的原因码（供日志与分支判断，如 'cooldown'、'main_turn_active'）
 * @param error  可读的报错说明（做什么被拒、为何被拒、后续如何补救）
 */
export function compactEarlyExit(reason: string, error: string): CompactEarlyExitResult {
  const msg = typeof error === 'string' && error.trim() ? error : reason;
  return { ok: false, compacted: false, reason, error: msg };
}