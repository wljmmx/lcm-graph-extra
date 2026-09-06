/**
 * SD-DEF-1: 新会话残留转录前缀防御 —— 触发条件纯函数单测。
 *
 * 覆盖：
 * - 新会话 + 大量输入（/new 后残留转录前缀）→ 触发
 * - 正常长会话（uncomp 与 msgCount 一致增长）→ 不触发
 * - 边界：uncomp 阈值、msgCount 阈值、差距阈值
 */
import { describe, it, expect } from "vitest";

// 项目惯例（同 retrieval.test.ts）：纯函数未导出时为避免整链依赖在测试内复制实现。
// 此处 assemble/index.ts 的导出函数引入大量依赖（typebox/config 链），测试环境仅有
// vitest/vite 缓存，故复制实现验证触发条件（与 assemble/index.ts L228-233 保持一致）。
function detectStaleTranscriptPrefix(uncompressedMsgs: number, msgCount: number): boolean {
  return (
    uncompressedMsgs >= 0 && uncompressedMsgs <= 3 &&
    msgCount > 30 && msgCount - uncompressedMsgs > 10
  );
}

describe("detectStaleTranscriptPrefix (SD-DEF-1)", () => {
  it("触发：新会话（uncomp=1）但输入含 209 条残留前缀（/new 后 SDK 未轮换转录）", () => {
    expect(detectStaleTranscriptPrefix(1, 209)).toBe(true);
  });

  it("触发：uncomp=0（引擎零未压缩）但输入仍有大量旧消息", () => {
    expect(detectStaleTranscriptPrefix(0, 100)).toBe(true);
  });

  it("触发：uncomp=3（新会话上界）且差距足够大", () => {
    expect(detectStaleTranscriptPrefix(3, 50)).toBe(true);
  });

  it("不触发：正常长会话，uncomp 与 msgCount 同步增长（差距小）", () => {
    // 用户会话未压缩 200 条、输入 209 条 → 仅差 9，非残留前缀
    expect(detectStaleTranscriptPrefix(200, 209)).toBe(false);
  });

  it("不触发：新会话但输入消息数未超阈值（msgCount=30 不 > 30）", () => {
    expect(detectStaleTranscriptPrefix(1, 30)).toBe(false);
  });

  it("不触发：新会话但差距未超 10 条", () => {
    // 未压缩 3 条、输入 12 条 → 差 9，仍在正常增量范围内
    expect(detectStaleTranscriptPrefix(3, 12)).toBe(false);
  });

  it("不触发：uncomp 未知（-1，无会话状态）时保守不裁", () => {
    expect(detectStaleTranscriptPrefix(-1, 209)).toBe(false);
  });

  it("不触发：uncomp 超过新会话上界（comp=4，可能为旧会话误报）", () => {
    expect(detectStaleTranscriptPrefix(4, 100)).toBe(false);
  });
});
