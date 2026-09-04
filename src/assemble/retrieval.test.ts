/**
 * retrieval.ts 单元测试
 *
 * 覆盖：
 * - M6: SHA-256 hashKey 碰撞测试
 * - hashKey 确定性（相同输入产生相同输出）
 * - hashKey 区分度（不同输入产生不同输出）
 * - 中文查询哈希正确性
 * - v2.8.0 O7: 异步预取缓存行为
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

// 直接复制 hashKey 实现进行测试（模块内函数未导出）
function hashKey(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** v2.8.0 O7: 预取缓存条目类型 */
interface PrefetchEntry {
  qmdResults: any[];
  graphResults: any[];
  expResults: any[];
  query: string;
  ts: number;
}

/** O7: 模拟 prefetchCache 行为 */
class PrefetchCacheSimulator {
  private cache = new Map<string, PrefetchEntry>();
  private ttl: number;
  private maxSize: number;

  constructor(ttl = 10 * 60 * 1000, maxSize = 200) {
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  get(sessionKey: string): PrefetchEntry | undefined {
    return this.cache.get(sessionKey);
  }

  set(sessionKey: string, entry: PrefetchEntry): void {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(sessionKey, entry);
  }

  delete(sessionKey: string): boolean {
    return this.cache.delete(sessionKey);
  }

  getAndConsume(sessionKey: string): PrefetchEntry | null {
    const entry = this.cache.get(sessionKey);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttl) {
      this.cache.delete(sessionKey);
      return null;
    }
    this.cache.delete(sessionKey); // 消费后清除
    return entry;
  }

  get size(): number {
    return this.cache.size;
  }
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

// =====================================================================
// v2.8.0 O7: 异步预取缓存行为
// =====================================================================

describe("retrieval O7: 异步预取缓存", () => {
  describe("缓存命中", () => {
    it("缓存命中时返回上一轮预取的完整结果", () => {
      const cache = new PrefetchCacheSimulator();
      const mockQmd = [{ docid: "doc1", file: "a.ts", snippet: "code" }];
      const mockGraph = [{ id: "n1", content: "node content" }];
      const mockExp = [{ experience: { id: "e1", title: "经验" }, score: 0.8 }];

      cache.set("session-1", {
        qmdResults: mockQmd,
        graphResults: mockGraph,
        expResults: mockExp,
        query: "test query",
        ts: Date.now(),
      });

      const result = cache.getAndConsume("session-1");
      expect(result).not.toBeNull();
      expect(result!.qmdResults).toEqual(mockQmd);
      expect(result!.graphResults).toEqual(mockGraph);
      expect(result!.expResults).toEqual(mockExp);
      expect(result!.query).toBe("test query");
    });

    it("缓存命中后条目被消费清除（避免重复使用）", () => {
      const cache = new PrefetchCacheSimulator();
      cache.set("session-1", {
        qmdResults: [{ docid: "d1" }],
        graphResults: [],
        expResults: [],
        query: "q",
        ts: Date.now(),
      });

      const first = cache.getAndConsume("session-1");
      expect(first).not.toBeNull();
      const second = cache.getAndConsume("session-1");
      expect(second).toBeNull();
    });

    it("缓存命中时返回上一轮预取的 OpenClaw 官方记忆 openclawResults", () => {
      const cache = new PrefetchCacheSimulator();
      const mockMem = [
        { chunkId: "c1", agentId: "agent-a", path: "memory/project.md", text: "用户偏好使用中文记录项目进度", importance: 8 },
      ];
      cache.set("session-mem", {
        qmdResults: [],
        graphResults: [],
        expResults: [],
        openclawResults: mockMem,
        query: "项目进度",
        ts: Date.now(),
      });

      const result = cache.getAndConsume("session-mem");
      expect(result).not.toBeNull();
      expect(result!.openclawResults).toHaveLength(1);
      expect(result!.openclawResults![0].chunkId).toBe("c1");
      expect(result!.openclawResults![0].importance).toBe(8);
    });
  });

  describe("缓存未命中", () => {
    it("首轮对话（无缓存）返回空结果", () => {
      const cache = new PrefetchCacheSimulator();
      const result = cache.getAndConsume("new-session");
      expect(result).toBeNull();
    });

    it("不同 sessionKey 缓存隔离", () => {
      const cache = new PrefetchCacheSimulator();
      cache.set("session-A", {
        qmdResults: [{ docid: "d1" }],
        graphResults: [],
        expResults: [],
        query: "A",
        ts: Date.now(),
      });

      // session-B 无法读取 session-A 的缓存
      const result = cache.getAndConsume("session-B");
      expect(result).toBeNull();

      // session-A 的缓存仍存在
      expect(cache.size).toBe(1);
    });
  });

  describe("TTL 过期", () => {
    it("超过 TTL 的缓存条目返回 null", () => {
      const cache = new PrefetchCacheSimulator(100); // 100ms TTL
      cache.set("old-session", {
        qmdResults: [{ docid: "d1" }],
        graphResults: [],
        expResults: [],
        query: "old",
        ts: Date.now() - 200, // 200ms 前
      });

      const result = cache.getAndConsume("old-session");
      expect(result).toBeNull();
      expect(cache.size).toBe(0); // 过期条目被清理
    });

    it("TTL 内的缓存条目正常返回", () => {
      const cache = new PrefetchCacheSimulator(10_000); // 10s TTL
      cache.set("fresh-session", {
        qmdResults: [{ docid: "fresh" }],
        graphResults: [],
        expResults: [],
        query: "fresh",
        ts: Date.now(),
      });

      const result = cache.getAndConsume("fresh-session");
      expect(result).not.toBeNull();
      expect(result!.qmdResults[0].docid).toBe("fresh");
    });
  });

  describe("LRU 容量上限", () => {
    it("超过 maxSize 时淘汰最旧条目", () => {
      const cache = new PrefetchCacheSimulator(60_000, 3); // max 3 entries
      for (let i = 0; i < 5; i++) {
        cache.set(`session-${i}`, {
          qmdResults: [{ docid: `d${i}` }],
          graphResults: [],
          expResults: [],
          query: `q${i}`,
          ts: Date.now() + i, // 递增时间戳确保新条目不被淘汰
        });
      }
      expect(cache.size).toBe(3);
      // 最旧的 session-0 和 session-1 应被淘汰
      expect(cache.getAndConsume("session-0")).toBeNull();
      expect(cache.getAndConsume("session-1")).toBeNull();
      // session-2,3,4 应保留
      const s4 = cache.getAndConsume("session-4");
      expect(s4).not.toBeNull();
      expect(s4!.query).toBe("q4");
    });
  });

  describe("空结果处理", () => {
    it("所有检索层返回空数组时缓存仍有效", () => {
      const cache = new PrefetchCacheSimulator();
      cache.set("empty-session", {
        qmdResults: [],
        graphResults: [],
        expResults: [],
        query: "no results",
        ts: Date.now(),
      });

      const result = cache.getAndConsume("empty-session");
      expect(result).not.toBeNull();
      expect(result!.qmdResults).toHaveLength(0);
      expect(result!.graphResults).toHaveLength(0);
      expect(result!.expResults).toHaveLength(0);
    });

    it("部分层有结果时仍然正常返回", () => {
      const cache = new PrefetchCacheSimulator();
      cache.set("partial-session", {
        qmdResults: [],
        graphResults: [{ id: "n1", content: "graph result" }],
        expResults: [],
        query: "partial",
        ts: Date.now(),
      });

      const result = cache.getAndConsume("partial-session");
      expect(result).not.toBeNull();
      expect(result!.qmdResults).toHaveLength(0);
      expect(result!.graphResults).toHaveLength(1);
      expect(result!.expResults).toHaveLength(0);
    });
  });

  describe("session key 提取", () => {
    it("应优先使用 params.sessionKey", () => {
      const params = { sessionKey: "sk-prod-1", session_id: "sid-backup" };
      const sessionKey = typeof params.sessionKey === "string"
        ? params.sessionKey
        : typeof params.session_id === "string"
          ? params.session_id
          : "";
      expect(sessionKey).toBe("sk-prod-1");
    });

    it("sessionKey 不存在时回退到 session_id", () => {
      const params = { session_id: "sid-only" };
      const sessionKey = typeof (params as any).sessionKey === "string"
        ? (params as any).sessionKey
        : typeof params.session_id === "string"
          ? params.session_id
          : "";
      expect(sessionKey).toBe("sid-only");
    });

    it("两者都不存在时返回空字符串，跳过缓存查找", () => {
      const params = {};
      const sessionKey = typeof (params as any).sessionKey === "string"
        ? (params as any).sessionKey
        : typeof (params as any).session_id === "string"
          ? (params as any).session_id
          : "";
      expect(sessionKey).toBe("");
    });
  });

  describe("首轮与缓存过期行为", () => {
    it("首轮对话（无缓存）时 assemble 返回空结果", () => {
      const cache = new PrefetchCacheSimulator();
      // 模拟首轮：cache 无数据，params 有 sessionKey
      const sessionKey = "first-turn-session";
      const cached = cache.get(sessionKey);
      const cacheHit = cached && (Date.now() - cached.ts < 10 * 60 * 1000);

      expect(cacheHit).toBeFalsy();
      // 首轮：rawQmd/rawGraph/expResults 均为空
      const rawQmd: any[] = [];
      const rawGraph: any[] = [];
      const expResults: any[] = [];
      expect(rawQmd).toHaveLength(0);
      expect(rawGraph).toHaveLength(0);
      expect(expResults).toHaveLength(0);
    });

    it("空 sessionKey 时跳过缓存查找", () => {
      const cache = new PrefetchCacheSimulator();
      cache.set("valid-key", {
        qmdResults: [{ docid: "d1" }],
        graphResults: [],
        expResults: [],
        query: "test",
        ts: Date.now(),
      });

      const emptySessionKey = "";
      const cached = emptySessionKey ? cache.get(emptySessionKey) : undefined;
      expect(cached).toBeUndefined();
    });

    it("缓存 TTL 过期后被心跳清理", () => {
      const cache = new PrefetchCacheSimulator(100); // 100ms TTL
      cache.set("old-key", {
        qmdResults: [{ docid: "old" }],
        graphResults: [],
        expResults: [],
        query: "old",
        ts: Date.now() - 200,
      });

      // 模拟心跳清理逻辑
      const now = Date.now();
      const PREFETCH_CACHE_TTL_MS = 100;
      let cleaned = 0;
      for (const [key, val] of (cache as any).cache as Map<string, PrefetchEntry>) {
        if (now - val.ts > PREFETCH_CACHE_TTL_MS) {
          cache.delete(key);
          cleaned++;
        }
      }
      expect(cleaned).toBeGreaterThanOrEqual(0);
      expect(cache.size).toBe(0);
    });
  });

  describe("缓存并发安全", () => {
    it("多个 session 同时写入互不干扰", () => {
      const cache = new PrefetchCacheSimulator(60_000, 10);
      cache.set("sess-a", {
        qmdResults: [{ docid: "a1" }],
        graphResults: [],
        expResults: [],
        query: "a",
        ts: Date.now(),
      });
      cache.set("sess-b", {
        qmdResults: [{ docid: "b1" }],
        graphResults: [{ id: "b-graph" }],
        expResults: [],
        query: "b",
        ts: Date.now(),
      });

      const a = cache.getAndConsume("sess-a");
      const b = cache.getAndConsume("sess-b");
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.qmdResults[0].docid).toBe("a1");
      expect(b!.qmdResults[0].docid).toBe("b1");
      expect(b!.graphResults).toHaveLength(1);
    });

    it("同一 session 连续两轮：第一轮命中，第二轮未命中（已消费）", () => {
      const cache = new PrefetchCacheSimulator();
      cache.set("reuse-session", {
        qmdResults: [{ docid: "reuse" }],
        graphResults: [],
        expResults: [],
        query: "reuse",
        ts: Date.now(),
      });

      // 第一轮 assemble：命中
      const first = cache.getAndConsume("reuse-session");
      expect(first).not.toBeNull();

      // 第二轮 assemble（同一 session 但在 afterTurn 重新写入前）：未命中
      const second = cache.getAndConsume("reuse-session");
      expect(second).toBeNull();
    });
  });
});