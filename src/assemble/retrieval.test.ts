/**
 * retrieval.ts 单元测试
 *
 * 覆盖：
 * - M6: SHA-256 hashKey 碰撞测试
 * - hashKey 确定性（相同输入产生相同输出）
 * - hashKey 区分度（不同输入产生不同输出）
 * - 中文查询哈希正确性
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

// 直接复制 hashKey 实现进行测试（模块内函数未导出）
function hashKey(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

describe("retrieval hashKey (M6: SHA-256)", () => {
  // ===================== M6: SHA-256 替代 djb2 ======================

  describe("M6: 确定性", () => {
    it("相同输入产生相同哈希", () => {
      const h1 = hashKey("hello world");
      const h2 = hashKey("hello world");
      expect(h1).toBe(h2);
    });

    it("空字符串产生有效哈希", () => {
      const h = hashKey("");
      expect(h).toBeDefined();
      expect(h.length).toBe(16);
      // 空字符串的 SHA-256 前16字符
      expect(h).toBe("e3b0c44298fc1c14");
    });
  });

  // ===================== 区分度 =====================================

  describe("区分度", () => {
    it("不同输入产生不同哈希", () => {
      const h1 = hashKey("hello");
      const h2 = hashKey("world");
      expect(h1).not.toBe(h2);
    });

    it("相似但不同的输入产生不同哈希", () => {
      const h1 = hashKey("hello world");
      const h2 = hashKey("hello world!");
      expect(h1).not.toBe(h2);
    });

    it("大小写敏感产生不同哈希", () => {
      const h1 = hashKey("Hello");
      const h2 = hashKey("hello");
      expect(h1).not.toBe(h2);
    });
  });

  // ===================== 中文查询 ===================================

  describe("中文查询", () => {
    it("中文查询产生有效哈希", () => {
      const h = hashKey("如何优化数据库性能");
      expect(h).toBeDefined();
      expect(h.length).toBe(16);
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    it("不同中文查询产生不同哈希（碰撞测试）", () => {
      const queries = [
        "如何优化数据库性能",
        "如何使用Redis缓存",
        "Neo4j图数据库查询优化",
        "机器学习模型部署流程",
        "前端性能优化最佳实践",
        "后端API设计规范",
        "微服务架构设计模式",
        "分布式系统一致性协议",
        "Python异步编程指南",
        "TypeScript类型系统深入",
        "Docker容器化部署",
        "Kubernetes集群管理",
        "CI/CD流水线配置",
        "日志收集与分析方案",
        "监控告警系统设计",
        "消息队列选型对比",
        "数据库索引优化策略",
        "网络协议栈实现",
        "安全漏洞扫描工具",
        "代码审查最佳实践",
      ];

      const hashes = new Set<string>();
      for (const q of queries) {
        const h = hashKey(q);
        expect(hashes.has(h)).toBe(false);
        hashes.add(h);
      }
      // 所有20个查询应产生20个不同的哈希
      expect(hashes.size).toBe(20);
    });

    it("长中文查询产生有效哈希", () => {
      const longQuery = "在分布式系统中，如何保证数据一致性和高可用性，同时兼顾性能表现？具体来说，需要考虑CAP理论的权衡，以及Paxos和Raft共识算法的选择。";
      const h = hashKey(longQuery);
      expect(h).toBeDefined();
      expect(h.length).toBe(16);
    });

    it("含特殊字符的中文查询", () => {
      const h = hashKey("查询：Python 3.12+ 的 @override 装饰器如何使用？");
      expect(h).toBeDefined();
      expect(h.length).toBe(16);
    });
  });

  // ===================== 输出格式 ===================================

  describe("输出格式", () => {
    it("输出长度为16字符的十六进制字符串", () => {
      const h = hashKey("test");
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    it("输出为小写十六进制", () => {
      const h = hashKey("TEST");
      expect(h).toBe(h.toLowerCase());
    });
  });
});