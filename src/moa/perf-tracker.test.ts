/**
 * MoA PerfTracker 单元测试
 *
 * 覆盖：
 * - H2: 异步写入（fs.promises.writeFile 替代 writeFileSync）
 * - H4: getMoaPerformance 结果缓存
 * - recordMoaRun / recordAllComplexity 环形缓冲区
 * - percentiles 计算
 * - 时间分桶
 * - 启动时从磁盘加载持久化数据
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// Mock fs 相关模块
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn().mockReturnValue("/mock/home"),
}));

vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: vi.fn((...args: string[]) => args.join("/")) };
});

// 重新导入被测模块
import {
  recordMoaRun,
  recordAllComplexity,
  getMoaPerformance,
  loadFromDisk,
  PERF_FILE,
} from "./perf-tracker";

// 用于测试的辅助函数 —— 通过动态导入获取内部函数
// 这些函数通过 getMoaPerformance 间接测试

describe("MoA PerfTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理内部状态：通过 recordMoaRun 多次写入来"重置"缓冲区
    // 由于模块是单例，我们通过 getMoaPerformance() 来验证状态
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===================== H2: 异步写入 ================================

  describe("H2: 异步持久化", () => {
    it("recordMoaRun 调用后触发异步写入（使用 fs.promises.writeFile）", async () => {
      recordMoaRun(
        "test query",
        {
          totalMs: 1000,
          referenceTimings: [300, 400],
          aggregatorTiming: 300,
          estimatedTokens: 500,
          referenceOutputs: ["ref1", "ref2"],
          finalResponse: "test response",
        },
        null,
        {
          mode: "parallel",
          referenceModels: [
            { model: "gpt-4o", provider: "openai" },
            { model: "claude-3", provider: "anthropic" },
          ],
          aggregatorModel: { model: "gpt-4o-mini", provider: "openai" },
        },
        0.5,
      );

      // 等待异步写入完成
      await vi.waitFor(
        () => {
          expect(writeFile).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("moa-perf.json"),
        expect.any(String),
        "utf-8",
      );
    });

    it("recordAllComplexity 通过节流触发异步写入", async () => {
      recordAllComplexity(0.3);
      recordAllComplexity(0.5);
      recordAllComplexity(0.8);

      // 节流 5s，这里只应触发一次（或多次取决于时间间隔）
      await vi.waitFor(
        () => {
          expect(writeFile).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );
    });

    it("写入失败时静默处理，不抛错", async () => {
      vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"));

      // 不应抛错
      expect(() => {
        recordMoaRun(
          "test",
          {
            totalMs: 500,
            referenceTimings: [200],
            aggregatorTiming: 300,
            estimatedTokens: 100,
            referenceOutputs: ["ref"],
            finalResponse: "ok",
          },
          null,
          {
            mode: "sequential",
            referenceModels: [{ model: "gpt-4o", provider: "openai" }],
            aggregatorModel: { model: "gpt-4o-mini", provider: "openai" },
          },
        );
      }).not.toThrow();
    });
  });

  // ===================== H4: 结果缓存 ================================

  describe("H4: getMoaPerformance 结果缓存", () => {
    it("连续两次调用返回相同缓存结果（5s 内）", () => {
      recordMoaRun(
        "test",
        {
          totalMs: 1000,
          referenceTimings: [300],
          aggregatorTiming: 700,
          estimatedTokens: 200,
          referenceOutputs: ["ref"],
          finalResponse: "response",
        },
        null,
        {
          mode: "sequential",
          referenceModels: [{ model: "gpt-4o", provider: "openai" }],
          aggregatorModel: { model: "gpt-4o-mini", provider: "openai" } },
      );

      const result1 = getMoaPerformance();
      const result2 = getMoaPerformance();

      // 缓存机制：两次结果应该完全相同（引用相同）
      expect(result1).toBe(result2);
      expect(result1.totalRuns).toBe(result2.totalRuns);
    });

    it("新数据写入后缓存失效，返回更新后的结果", () => {
      const before = getMoaPerformance().totalRuns;

      recordMoaRun(
        "test1",
        {
          totalMs: 500,
          referenceTimings: [200],
          aggregatorTiming: 300,
          estimatedTokens: 100,
          referenceOutputs: ["ref"],
          finalResponse: "r1",
        },
        null,
        {
          mode: "sequential",
          referenceModels: [{ model: "gpt-4o", provider: "openai" }],
          aggregatorModel: { model: "gpt-4o-mini", provider: "openai" } },
      );

      const result1 = getMoaPerformance();
      expect(result1.totalRuns).toBe(before + 1);

      // 写入新数据
      recordMoaRun(
        "test2",
        {
          totalMs: 600,
          referenceTimings: [250],
          aggregatorTiming: 350,
          estimatedTokens: 150,
          referenceOutputs: ["ref"],
          finalResponse: "r2",
        },
        null,
        {
          mode: "sequential",
          referenceModels: [{ model: "claude-3", provider: "anthropic" }],
          aggregatorModel: { model: "gpt-4o-mini", provider: "openai" } },
      );

      const result2 = getMoaPerformance();
      expect(result2.totalRuns).toBe(before + 2);
    });

    it("recordAllComplexity 也清除缓存", () => {
      const beforeLow = getMoaPerformance().allComplexityDistribution.low;

      recordAllComplexity(0.2);

      const result = getMoaPerformance();
      // 缓存已失效，应包含新的复杂度数据
      expect(result.allComplexityDistribution.low).toBe(beforeLow + 1);
    });
  });

  // ===================== 环形缓冲区 ==================================

  describe("环形缓冲区", () => {
    it("超过 MAX_RECORDS 时丢弃最旧记录", () => {
      // 写入 55 条记录（MAX_RECORDS=50）
      for (let i = 0; i < 55; i++) {
        recordMoaRun(
          `query_${i}`,
          {
            totalMs: 500,
            referenceTimings: [200],
            aggregatorTiming: 300,
            estimatedTokens: 100,
            referenceOutputs: ["ref"],
            finalResponse: `response_${i}`,
          },
          null,
          {
            mode: "sequential",
            referenceModels: [{ model: "gpt-4o", provider: "openai" }],
            aggregatorModel: { model: "gpt-4o-mini", provider: "openai" } },
        );
      }

      const perf = getMoaPerformance();
      expect(perf.totalRuns).toBeLessThanOrEqual(50);
    });
  });

  // ===================== 失败记录 ====================================

  describe("失败记录", () => {
    it("记录失败运行的错误信息", () => {
      recordMoaRun(
        "failing query",
        null,
        "Connection timeout",
        {
          mode: "sequential",
          referenceModels: [{ model: "gpt-4o", provider: "openai" }],
          aggregatorModel: { model: "gpt-4o-mini", provider: "openai" } },
      );

      const perf = getMoaPerformance();
      expect(perf.failedRuns).toBeGreaterThanOrEqual(1);
      expect(perf.recentRuns[0].error).toBe("Connection timeout");
      expect(perf.recentRuns[0].success).toBe(false);
    });

    it("错误分类正确", () => {
      recordMoaRun(
        "q",
        null,
        "Request timeout after 30s",
        {
          mode: "sequential",
          referenceModels: [{ model: "gpt-4o", provider: "openai" }],
          aggregatorModel: { model: "gpt-4o-mini", provider: "openai" } },
      );

      const perf = getMoaPerformance();
      expect(perf.errorBreakdown.timeout).toBeGreaterThanOrEqual(1);
    });
  });

  // ===================== 复杂度追踪 ==================================

  describe("复杂度追踪", () => {
    it("recordAllComplexity 记录全量复杂度", () => {
      recordAllComplexity(0.3);
      recordAllComplexity(0.5);
      recordAllComplexity(0.8);

      const perf = getMoaPerformance();
      expect(perf.allComplexityDistribution.low).toBeGreaterThanOrEqual(1);
      expect(perf.allComplexityDistribution.medium).toBeGreaterThanOrEqual(1);
      expect(perf.allComplexityDistribution.high).toBeGreaterThanOrEqual(1);
    });
  });

  // ===================== 百分位计算 ==================================

  describe("延迟百分位", () => {
    it("至少有一条记录时计算百分位", () => {
      recordMoaRun(
        "test",
        {
          totalMs: 1000,
          referenceTimings: [300, 400],
          aggregatorTiming: 300,
          estimatedTokens: 500,
          referenceOutputs: ["ref1", "ref2"],
          finalResponse: "test",
        },
        null,
        {
          mode: "parallel",
          referenceModels: [
            { model: "gpt-4o", provider: "openai" },
            { model: "claude-3", provider: "anthropic" },
          ],
          aggregatorModel: { model: "gpt-4o-mini", provider: "openai" } },
      );

      const perf = getMoaPerformance();
      expect(perf.latencyPercentiles.p50).toBeGreaterThan(0);
    });
  });

  // ===================== 启动时从磁盘加载 ============================

  describe("loadFromDisk：启动时还原持久化数据", () => {
    /**
     * 验证 snapshot 服务重启后，从 ~/.openclaw/moa-perf.json 还原
     * runRecords / allComplexityRecords，Dashboard MoA 监控页不再显示空数据。
     */
    it("v1 格式：还原 runRecords 和 allComplexityRecords", async () => {
      const persisted = {
        version: 1,
        savedAt: Date.now(),
        runRecords: [
          {
            id: "moa-restored-1",
            timestamp: Date.now() - 60_000,
            queryPreview: "restored query",
            totalMs: 1500,
            refMs: 1000,
            aggMs: 500,
            totalTokens: 800,
            refCount: 2,
            validRefCount: 2,
            refTimings: [500, 500],
            refModels: ["gpt-4o", "claude-3"],
            refTokens: [400, 400],
            aggModel: "gpt-4o-mini",
            aggTokens: 0,
            responseLen: 1200,
            success: true,
            mode: "parallel",
            complexityScore: 0.7,
          },
        ],
        allComplexityRecords: [
          { timestamp: Date.now() - 60_000, score: 0.7 },
          { timestamp: Date.now() - 30_000, score: 0.5 },
        ],
        summary: { totalRuns: 1 } as any,
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(persisted));

      await loadFromDisk();

      const perf = getMoaPerformance();
      expect(perf.totalRuns).toBeGreaterThanOrEqual(1);
      expect(perf.recentRuns.some((r) => r.queryPreview === "restored query")).toBe(true);
      expect(perf.allComplexityHistory.some((r) => r.score === 0.7)).toBe(true);
    });

    it("文件不存在时静默跳过，不抛错", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      await expect(loadFromDisk()).resolves.toBeUndefined();
    });

    it("旧格式（无 version 字段）静默跳过，不还原数据", async () => {
      // 旧格式仅写入 MoaPerformanceSummary（无 version / runRecords 字段）
      const legacy = { totalRuns: 99, recentRuns: [{ id: "legacy" }] };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(legacy));

      const before = getMoaPerformance().totalRuns;
      await loadFromDisk();
      const after = getMoaPerformance().totalRuns;

      // 不应还原 legacy 数据
      expect(after).toBe(before);
    });

    it("文件解析失败时静默跳过，不抛错", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValueOnce("{invalid json");
      await expect(loadFromDisk()).resolves.toBeUndefined();
    });
  });
});