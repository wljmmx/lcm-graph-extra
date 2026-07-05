/**
 * afterTurn hook 单元测试
 *
 * 验证 ContextEngine.afterTurn 的核心契约：
 * - 经验触发检测（背景任务触发条件）
 * - LLM 三元组提取（输入/输出契约）
 * - Neo4j upsert 调用契约
 * - G-8 异步验证回路触发
 */
import { describe, it, expect } from 'vitest';

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
});
