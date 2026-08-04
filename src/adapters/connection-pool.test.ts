/**
 * connection-pool 单元测试
 *
 * 覆盖：
 * - 递归深度限制（M4 修复）
 * - acquireDriver 正常流程
 * - releaseDriver 引用计数
 * - drainPool 清理
 * - getPoolStats 统计
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock neo4j-driver
const mockDriver = {
  verifyConnectivity: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockAuth = { basic: vi.fn().mockReturnValue({}) };

vi.mock("neo4j-driver", () => ({
  default: {
    driver: vi.fn().mockReturnValue(mockDriver),
    auth: mockAuth,
  },
}));

import { acquireDriver, releaseDriver, drainPool, getPoolStats } from "./connection-pool";
import type { Neo4jConfig } from "../types";

const baseConfig: Neo4jConfig = {
  uri: "bolt://localhost:7687",
  user: "neo4j",
  password: "test",
};

describe("connection-pool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清空连接池状态
    drainPool();
  });

  afterEach(() => {
    drainPool();
  });

  // ===================== M4: 递归深度限制 ============================

  describe("M4: 递归深度限制", () => {
    it("正常获取 driver 不触发递归深度限制", async () => {
      const driver = await acquireDriver(baseConfig);
      expect(driver).toBe(mockDriver);
      expect(driver).toBeDefined();
    });

    it("显示传入 _depth=0 正常获取", async () => {
      const driver = await acquireDriver(baseConfig, 0);
      expect(driver).toBeDefined();
    });

    it("_depth=2 时正常获取（最后一次允许）", async () => {
      const driver = await acquireDriver(baseConfig, 2);
      expect(driver).toBeDefined();
    });

    it("_depth=3 时抛出 max refresh depth 错误", async () => {
      await expect(acquireDriver(baseConfig, 3)).rejects.toThrow(
        "max refresh depth (3) exceeded",
      );
    });

    it("_depth=10 时抛出 max refresh depth 错误", async () => {
      await expect(acquireDriver(baseConfig, 10)).rejects.toThrow(
        "max refresh depth (3) exceeded",
      );
    });
  });

  // ===================== acquireDriver ===============================

  describe("acquireDriver", () => {
    it("新建连接并验证连通性", async () => {
      const driver = await acquireDriver(baseConfig);
      expect(mockDriver.verifyConnectivity).toHaveBeenCalledTimes(1);
      expect(driver).toBe(mockDriver);
    });

    it("复用已有连接，引用计数 +1", async () => {
      const d1 = await acquireDriver(baseConfig);
      const d2 = await acquireDriver(baseConfig);
      expect(d1).toBe(d2);
      // verifyConnectivity 第一次新建时调用 1 次，第二次复用时调用 1 次
      expect(mockDriver.verifyConnectivity).toHaveBeenCalledTimes(2);
    });

    it("验证失败时关闭旧连接并重建", async () => {
      // 第一次：新建连接
      await acquireDriver(baseConfig);
      expect(mockDriver.verifyConnectivity).toHaveBeenCalledTimes(1);

      // 第二次：验证失败 → 关闭旧连接 → 重建
      mockDriver.verifyConnectivity.mockRejectedValueOnce(new Error("connection lost"));
      const driver = await acquireDriver(baseConfig);
      expect(mockDriver.close).toHaveBeenCalled();
      expect(driver).toBeDefined();
    });
  });

  // ===================== releaseDriver ===============================

  describe("releaseDriver", () => {
    it("引用计数减 1，不关闭连接", async () => {
      await acquireDriver(baseConfig); // refCount = 1
      await acquireDriver(baseConfig); // refCount = 2
      await releaseDriver(baseConfig); // refCount = 1
      expect(mockDriver.close).not.toHaveBeenCalled();
    });

    it("引用计数归零时关闭连接", async () => {
      await acquireDriver(baseConfig); // refCount = 1
      await releaseDriver(baseConfig); // refCount = 0
      expect(mockDriver.close).toHaveBeenCalled();
    });

    it("要释放的 key 不存在时不抛错", async () => {
      await expect(
        releaseDriver({ uri: "bolt://nonexistent:7687", user: "neo4j", password: "" }),
      ).resolves.toBeUndefined();
    });
  });

  // ===================== getPoolStats ================================

  describe("getPoolStats", () => {
    it("空池返回空数组", () => {
      const stats = getPoolStats();
      expect(stats).toEqual([]);
    });

    it("有连接时返回统计信息", async () => {
      await acquireDriver(baseConfig);
      const stats = getPoolStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]).toHaveProperty("uri");
      expect(stats[0]).toHaveProperty("refCount", 1);
      expect(stats[0]).toHaveProperty("ageMs");
      expect(stats[0]).toHaveProperty("idleMs");
    });
  });

  // ===================== drainPool ===================================

  describe("drainPool", () => {
    it("清空所有连接", async () => {
      await acquireDriver(baseConfig);
      await acquireDriver({
        uri: "bolt://other:7687",
        user: "neo4j",
        password: "test",
      });
      await drainPool();
      expect(mockDriver.close).toHaveBeenCalledTimes(2);
      expect(getPoolStats()).toEqual([]);
    });

    it("空池 drainPool 不抛错", async () => {
      await expect(drainPool()).resolves.toBeUndefined();
    });
  });
});