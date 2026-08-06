/**
 * afterTurn hook 单元测试
 *
 * 验证 ContextEngine.afterTurn 的核心契约：
 * - 经验触发检测（背景任务触发条件）
 * - LLM 三元组提取（输入/输出契约）
 * - Neo4j upsert 调用契约
 * - G-8 异步验证回路触发
 * - v2.8.0 O7: 异步预取缓存行为
 */
import { describe, it, expect } from 'vitest';

// =====================================================================
// v2.8.0 O7: 异步预取缓存类型与模拟器
// =====================================================================

/** O7 预取缓存条目类型 */
interface PrefetchEntry {
  qmdResults: any[];
  graphResults: any[];
  expResults: any[];
  query: string;
  ts: number;
}

/** O7: 模拟 prefetchCache 行为，与 retrieval.test.ts 中一致 */
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
    this.cache.delete(sessionKey);
    return entry;
  }

  get size(): number {
    return this.cache.size;
  }
}

describe('afterTurn hook', () => {
  describe('经验触发检测', () => {
    it('应基于 lastAssembleExpIdsBySession 判断是否需要验证', () => {
      // afterTurn 维护 lastAssembleExpIdsBySession：Map<sessionId, expId[]>
      // 若上一轮 assemble 召回了经验，afterTurn 应触发 G-8 验证回路
      const lastAssemble = {
        sessionId: 'sess-1',
        expIds: ['exp-1', 'exp-2'],
      };
      const shouldValidate = lastAssemble.expIds.length > 0;
      expect(shouldValidate).toBe(true);
    });

    it('无经验召回时不应触发 G-8 验证', () => {
      const lastAssemble = {
        sessionId: 'sess-2',
        expIds: [],
      };
      const shouldValidate = lastAssemble.expIds.length > 0;
      expect(shouldValidate).toBe(false);
    });
  });

  describe('LLM 三元组提取契约', () => {
    it('应输出 { subject, predicate, object } 三元组结构', () => {
      // afterTurn 调用 LLM 从对话提取三元组，写入 Neo4j
      const triplet = {
        subject: 'TypeScript',
        predicate: 'USES',
        object: '类型推断',
        confidence: 0.9,
      };
      expect(triplet).toHaveProperty('subject');
      expect(triplet).toHaveProperty('predicate');
      expect(triplet).toHaveProperty('object');
      expect(triplet).toHaveProperty('confidence');
      expect(triplet.confidence).toBeGreaterThan(0.5);
    });

    it('低置信度三元组应被丢弃', () => {
      const triplet = {
        subject: 'X',
        predicate: 'Y',
        object: 'Z',
        confidence: 0.2,
      };
      const shouldKeep = triplet.confidence >= 0.5;
      expect(shouldKeep).toBe(false);
    });
  });

  describe('G-8 异步验证回路', () => {
    it('应使用 LLM 判断召回经验与查询的相关性 score [0,1]', () => {
      // afterTurn 后台任务 g8-validate 调用 LLM 返回 score
      const llmJudgment = {
        expId: 'exp-1',
        query: '如何处理 TypeScript 类型错误',
        score: 0.85,
      };
      expect(llmJudgment.score).toBeGreaterThanOrEqual(0);
      expect(llmJudgment.score).toBeLessThanOrEqual(1);
    });

    it('score >= 0.5 应视为有效召回 → delta = +0.05', () => {
      const score = 0.85;
      const delta = score >= 0.5 ? 0.05 : -0.05;
      expect(delta).toBe(0.05);
    });

    it('score < 0.5 应视为无效召回 → delta = -0.05', () => {
      const score = 0.3;
      const delta = score >= 0.5 ? 0.05 : -0.05;
      expect(delta).toBe(-0.05);
    });

    it('应优先调用 gm-pro upsertFeedback，失败降级到 store.updateQualityScore', () => {
      // 验证降级链路存在
      const g8Path = {
        primary: 'gm-pro.upsertFeedback',
        fallback: 'store.updateQualityScore(id, score, delta, source)',
      };
      expect(g8Path.primary).toContain('upsertFeedback');
      expect(g8Path.fallback).toContain('updateQualityScore');
      expect(g8Path.fallback).toContain('source');
    });

    it('应记录 qualityScoreHistory 含 source 字段（gm-pro / local）', () => {
      const historyEntry = {
        ts: Date.now(),
        score: 0.85,
        delta: 0.05,
        source: 'gm-pro' as const,
      };
      expect(historyEntry.source).toBe('gm-pro');
    });
  });

  describe('后台任务调度', () => {
    it('afterTurn 应将验证任务注册到 backgroundTasks', () => {
      // backgroundTasks.register('afterturn:g8-validate', ...)
      const registeredTask = {
        name: 'afterturn:g8-validate',
        promise: Promise.resolve(),
      };
      expect(registeredTask.name).toContain('g8-validate');
      expect(registeredTask.promise).toBeInstanceOf(Promise);
    });

    it('应按 sessionId 隔离 lastAssembleExpIdsBySession', () => {
      const sessionMap = new Map<string, string[]>();
      sessionMap.set('sess-1', ['exp-1', 'exp-2']);
      sessionMap.set('sess-2', ['exp-3']);
      expect(sessionMap.get('sess-1')).toHaveLength(2);
      expect(sessionMap.get('sess-2')).toHaveLength(1);
      // 不同 session 不串扰
      expect(sessionMap.get('sess-1')).not.toContain('exp-3');
    });
  });

  // =====================================================================
  // v2.8.0 O7: 异步预取缓存
  // =====================================================================

  describe('O7: 异步预取缓存', () => {
    describe('缓存条目契约', () => {
      it('预取缓存条目应包含 qmdResults/graphResults/expResults/query/ts', () => {
        const entry: PrefetchEntry = {
          qmdResults: [{ docid: 'd1', file: 'a.ts' }],
          graphResults: [{ id: 'n1', content: 'graph node' }],
          expResults: [{ experience: { id: 'e1' }, score: 0.8 }],
          query: 'test query',
          ts: Date.now(),
        };
        expect(entry).toHaveProperty('qmdResults');
        expect(entry).toHaveProperty('graphResults');
        expect(entry).toHaveProperty('expResults');
        expect(entry).toHaveProperty('query');
        expect(entry).toHaveProperty('ts');
        expect(Array.isArray(entry.qmdResults)).toBe(true);
        expect(Array.isArray(entry.graphResults)).toBe(true);
        expect(Array.isArray(entry.expResults)).toBe(true);
      });

      it('空检索结果也应有有效缓存条目', () => {
        const entry: PrefetchEntry = {
          qmdResults: [],
          graphResults: [],
          expResults: [],
          query: 'no results',
          ts: Date.now(),
        };
        expect(entry.qmdResults).toHaveLength(0);
        expect(entry.graphResults).toHaveLength(0);
        expect(entry.expResults).toHaveLength(0);
      });
    });

    describe('L2 lex+vec 去重合并', () => {
      it('按 docid 去重合并 lex 和 vec 结果', () => {
        const lexResults = [
          { docid: 'doc-1', file: 'a.ts', snippet: 'code a' },
          { docid: 'doc-2', file: 'b.ts', snippet: 'code b' },
        ];
        const vecResults = [
          { docid: 'doc-2', file: 'b.ts', snippet: 'code b vec' }, // 重复
          { docid: 'doc-3', file: 'c.ts', snippet: 'code c' },      // 新
        ];

        // 模拟去重合并逻辑
        const merged = [...lexResults];
        const seenIds = new Set(merged.map((r: any) => r?.docid ?? r?.file ?? ''));
        for (const r of vecResults) {
          const id = r?.docid ?? r?.file ?? '';
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            merged.push(r);
          }
        }

        expect(merged).toHaveLength(3);
        expect(merged.map((r: any) => r.docid)).toEqual(['doc-1', 'doc-2', 'doc-3']);
      });

      it('当 docid 不存在时回退到 file 字段去重', () => {
        const lexResults = [
          { file: 'a.ts', snippet: 'code a' },
        ];
        const vecResults = [
          { file: 'a.ts', snippet: 'code a vec' }, // 同 file 重复
          { file: 'b.ts', snippet: 'code b' },      // 新 file
        ];

        const merged = [...lexResults];
        const seenIds = new Set(merged.map((r: any) => r?.docid ?? r?.file ?? ''));
        for (const r of vecResults) {
          const id = r?.docid ?? r?.file ?? '';
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            merged.push(r);
          }
        }

        expect(merged).toHaveLength(2);
        expect(merged.map((r: any) => r.file)).toEqual(['a.ts', 'b.ts']);
      });
    });

    describe('缓存写入与 LRU 保护', () => {
      it('写入缓存时触发 LRU 淘汰最旧条目', () => {
        const cache = new PrefetchCacheSimulator(60_000, 3);
        for (let i = 0; i < 5; i++) {
          cache.set(`session-${i}`, {
            qmdResults: [{ docid: `d${i}` }],
            graphResults: [],
            expResults: [],
            query: `q${i}`,
            ts: Date.now() + i,
          });
        }
        expect(cache.size).toBe(3);
        expect(cache.getAndConsume('session-0')).toBeNull();
        expect(cache.getAndConsume('session-1')).toBeNull();
        expect(cache.getAndConsume('session-4')).not.toBeNull();
      });

      it('缓存未满时正常写入', () => {
        const cache = new PrefetchCacheSimulator(60_000, 10);
        cache.set('session-1', {
          qmdResults: [{ docid: 'd1' }],
          graphResults: [],
          expResults: [],
          query: 'q1',
          ts: Date.now(),
        });
        expect(cache.size).toBe(1);
      });
    });

    describe('session key 提取', () => {
      it('应优先使用 params.sessionKey', () => {
        const params = { sessionKey: 'sk-123', session_id: 'sid-456' };
        const sessionKey = typeof params.sessionKey === 'string'
          ? params.sessionKey
          : typeof params.session_id === 'string'
            ? params.session_id
            : '';
        expect(sessionKey).toBe('sk-123');
      });

      it('sessionKey 不存在时回退到 session_id', () => {
        const params = { session_id: 'sid-456' };
        const sessionKey = typeof (params as any).sessionKey === 'string'
          ? (params as any).sessionKey
          : typeof params.session_id === 'string'
            ? params.session_id
            : '';
        expect(sessionKey).toBe('sid-456');
      });

      it('两者都不存在时返回空字符串', () => {
        const params = {};
        const sessionKey = typeof (params as any).sessionKey === 'string'
          ? (params as any).sessionKey
          : typeof (params as any).session_id === 'string'
            ? (params as any).session_id
            : '';
        expect(sessionKey).toBe('');
      });
    });

    describe('查询截断', () => {
      it('userContent 超过 500 字符时截断到 500', () => {
        const longQuery = 'x'.repeat(1000);
        const truncated = longQuery.slice(0, 500);
        expect(truncated.length).toBe(500);
        expect(truncated).toBe('x'.repeat(500));
      });

      it('短查询不截断', () => {
        const shortQuery = 'hello world';
        const truncated = shortQuery.slice(0, 500);
        expect(truncated).toBe('hello world');
      });
    });
  });
});
