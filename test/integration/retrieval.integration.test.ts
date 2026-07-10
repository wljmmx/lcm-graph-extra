/**
 * ExperienceStorage 集成测试 — 验证 Cypher 查询在真实 Neo4j 环境中的正确性。
 *
 * 前置条件:
 *   - NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD 环境变量
 *   - 无环境变量时整个套件跳过（describe.skip）
 *
 * 运行:
 *   npx vitest run test/integration/retrieval.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import neo4j from 'neo4j-driver';
import { ExperienceStorage } from '../../src/experience/storage.js';
import type { GraphQueryExecutor } from '../../src/types.js';
import type { DistilledExperience, RawExperience } from '../../src/experience/types.js';

// ---------------------------------------------------------------------------
// 环境检测
// ---------------------------------------------------------------------------

const NEO4J_URI = process.env.NEO4J_URI;
const NEO4J_USER = process.env.NEO4J_USER;
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

const hasNeo4j = !!(NEO4J_URI && NEO4J_USER && NEO4J_PASSWORD);

// ---------------------------------------------------------------------------
// 测试数据工厂
// ---------------------------------------------------------------------------

function makeDistilled(overrides: Partial<DistilledExperience> = {}): DistilledExperience {
  const id = overrides.id ?? `test-exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    rawIds: overrides.rawIds ?? [`raw-${id}`],
    type: overrides.type ?? 'lesson',
    title: overrides.title ?? 'Test Experience Title',
    summary: overrides.summary ?? 'This is a test experience summary for integration testing.',
    detail: overrides.detail ?? 'Detailed description of the test experience.',
    context: overrides.context ?? 'Integration test context',
    projectName: overrides.projectName ?? 'test-project',
    relevanceScore: overrides.relevanceScore ?? 0.8,
    createdAt: overrides.createdAt ?? new Date(),
    matchCount: overrides.matchCount ?? 0,
    tags: overrides.tags,
  };
}

function makeRaw(overrides: Partial<RawExperience> = {}): RawExperience {
  const id = overrides.id ?? `test-raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    source: overrides.source ?? 'explicit_save',
    sessionId: overrides.sessionId ?? 'test-session',
    timestamp: overrides.timestamp ?? new Date(),
    context: overrides.context ?? 'Test raw experience context',
    detail: overrides.detail ?? 'Test raw experience detail',
    projectName: overrides.projectName ?? 'test-project',
    taskId: overrides.taskId ?? 'test-task',
  };
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

const suite = hasNeo4j ? describe : describe.skip;

suite('ExperienceStorage Integration', () => {
  let driver: neo4j.Driver;
  let storage: ExperienceStorage;

  beforeAll(async () => {
    driver = neo4j.driver(
      NEO4J_URI!,
      neo4j.auth.basic(NEO4J_USER!, NEO4J_PASSWORD!),
    );

    // 将 neo4j driver 包装为 GraphQueryExecutor 接口
    const adapter: GraphQueryExecutor = {
      query: async <T = Record<string, unknown>>(
        cypher: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        const session = driver.session();
        try {
          const result = await session.run(cypher, params ?? {});
          return result.records.map((r) => {
            const obj: Record<string, unknown> = {};
            r.keys.forEach((k) => {
              obj[k] = r.get(k);
            });
            return obj;
          });
        } finally {
          await session.close();
        }
      },
    };

    storage = new ExperienceStorage(adapter, 5);
  });

  afterAll(async () => {
    if (driver) await driver.close();
  });

  beforeEach(async () => {
    // 清理所有测试数据（ID 以 "test-" 开头）
    const session = driver.session();
    try {
      await session.run(
        'MATCH (e:EXPERIENCE) WHERE e.id STARTS WITH "test-" DETACH DELETE e',
      );
    } finally {
      await session.close();
    }
  });

  // =========================================================================
  // 1. searchRelevant 基础查询
  // =========================================================================

  it('should return DISTILLED experiences filtered by minScore, ordered by relevanceScore DESC', async () => {
    // 创建 3 个 DISTILLED 经验，不同 relevanceScore
    const exp1 = makeDistilled({ id: 'test-r1', relevanceScore: 0.9, title: 'High Score' });
    const exp2 = makeDistilled({ id: 'test-r2', relevanceScore: 0.7, title: 'Mid Score' });
    const exp3 = makeDistilled({ id: 'test-r3', relevanceScore: 0.5, title: 'Low Score' });

    await storage.saveDistilled(exp1);
    await storage.saveDistilled(exp2);
    await storage.saveDistilled(exp3);

    const results = await storage.searchRelevant(0.6, 10);

    // 应该返回 2 个结果（0.9 和 0.7），0.5 被过滤
    expect(results).toHaveLength(2);
    expect(results[0].experience.id).toBe('test-r1');
    expect(results[0].score).toBe(0.9);
    expect(results[1].experience.id).toBe('test-r2');
    expect(results[1].score).toBe(0.7);
  });

  // =========================================================================
  // 2. searchByQuery 关键词匹配
  // =========================================================================

  it('should prioritize experiences matching query keywords via queryMatch', async () => {
    // 创建 2 个经验，summary 包含不同关键词
    const exp1 = makeDistilled({
      id: 'test-q1',
      relevanceScore: 0.7,
      summary: 'This is about React component optimization',
      title: 'React Performance',
      context: 'Frontend development',
    });
    const exp2 = makeDistilled({
      id: 'test-q2',
      relevanceScore: 0.8,
      summary: 'This is about Node.js server configuration',
      title: 'Node Config',
      context: 'Backend development',
    });

    await storage.saveDistilled(exp1);
    await storage.saveDistilled(exp2);

    // 搜索 "React" — exp1 应该优先返回
    const results = await storage.searchByQuery({
      query: 'React',
      minScore: 0.6,
      limit: 5,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    // exp1 匹配了 "React"，应该排在前面
    expect(results[0].experience.id).toBe('test-q1');
  });

  it('should compute queryMatch correctly when query matches summary and title', async () => {
    const exp = makeDistilled({
      id: 'test-qmatch',
      relevanceScore: 0.7,
      summary: 'Debugging TypeScript type errors in monorepo',
      title: 'TypeScript Debugging',
      context: 'TypeScript monorepo setup',
    });

    await storage.saveDistilled(exp);

    const results = await storage.searchByQuery({
      query: 'TypeScript',
      minScore: 0.6,
      limit: 5,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    // queryMatch 由 summary (1.0) + title (0.7) + context (0.5) 组成
    expect(results[0].score).toBeGreaterThan(0.7); // 混合打分 > 静态 relevanceScore
  });

  // =========================================================================
  // 3. searchByQuery 标签过滤
  // =========================================================================

  it('should filter by scenarioTags', async () => {
    const exp1 = makeDistilled({
      id: 'test-tag1',
      relevanceScore: 0.8,
      tags: { scenario: ['bug-fix'], techStack: ['frontend'] },
      summary: 'Bug fix experience',
    });
    const exp2 = makeDistilled({
      id: 'test-tag2',
      relevanceScore: 0.8,
      tags: { scenario: ['feature-dev'], techStack: ['backend'] },
      summary: 'Feature dev experience',
    });

    await storage.saveDistilled(exp1);
    await storage.saveDistilled(exp2);

    const results = await storage.searchByQuery({
      scenarioTags: ['bug-fix'],
      minScore: 0.6,
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].experience.id).toBe('test-tag1');
  });

  it('should return empty when scenarioTags do not match any experience', async () => {
    const exp = makeDistilled({
      id: 'test-tag-nomatch',
      relevanceScore: 0.8,
      tags: { scenario: ['bug-fix'] },
      summary: 'Bug fix experience',
    });

    await storage.saveDistilled(exp);

    const results = await storage.searchByQuery({
      scenarioTags: ['deployment'], // 不匹配
      minScore: 0.6,
      limit: 5,
    });

    expect(results).toHaveLength(0);
  });

  it('should filter by techStackTags', async () => {
    const exp1 = makeDistilled({
      id: 'test-tech1',
      relevanceScore: 0.8,
      tags: { scenario: ['bug-fix'], techStack: ['TypeScript' as any] },
      summary: 'TypeScript bug fix',
    });

    await storage.saveDistilled(exp1);

    const results = await storage.searchByQuery({
      techStackTags: ['TypeScript' as any],
      minScore: 0.6,
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].experience.id).toBe('test-tech1');
  });

  // =========================================================================
  // 4. saveRaw + saveDistilled 生命周期
  // =========================================================================

  it('should save raw experience with PENDING status and distilled with DISTILLED status', async () => {
    const rawId = `test-lifecycle-${Date.now()}`;
    const raw = makeRaw({ id: rawId });

    // 写入原始经验
    await storage.saveRaw(raw);

    // 直接用 driver 查询验证 status=PENDING
    const session1 = driver.session();
    let result: any;
    try {
      const res = await session1.run(
        'MATCH (e:EXPERIENCE {id: $id}) RETURN e.status AS status, e.detail AS detail',
        { id: rawId },
      );
      result = res.records[0];
    } finally {
      await session1.close();
    }
    expect(result.get('status')).toBe('PENDING');
    expect(result.get('detail')).toBe(raw.detail);

    // 写入精炼经验（覆盖）
    const distilled = makeDistilled({
      id: rawId,
      type: 'lesson',
      relevanceScore: 0.85,
      summary: 'Distilled summary for the raw experience',
      detail: 'Refined detail after distillation',
    });
    await storage.saveDistilled(distilled);

    // 验证 status 变为 DISTILLED
    const session2 = driver.session();
    try {
      const res = await session2.run(
        'MATCH (e:EXPERIENCE {id: $id}) RETURN e.status AS status, e.detail AS detail, e.relevanceScore AS relevanceScore',
        { id: rawId },
      );
      const record = res.records[0];
      expect(record.get('status')).toBe('DISTILLED');
      expect(record.get('detail')).toBe('Refined detail after distillation');
      expect(record.get('relevanceScore')).toBe(0.85);
    } finally {
      await session2.close();
    }
  });

  // =========================================================================
  // 5. incrementMatchCount + 时间衰减
  // =========================================================================

  it('should increment matchCount and set lastRecalledAt', async () => {
    const exp = makeDistilled({
      id: 'test-matchcount',
      relevanceScore: 0.8,
      matchCount: 0,
    });
    await storage.saveDistilled(exp);

    await storage.incrementMatchCount('test-matchcount');

    // 直接查询验证
    const session = driver.session();
    try {
      const res = await session.run(
        'MATCH (e:EXPERIENCE {id: $id}) RETURN e.matchCount AS matchCount, e.lastRecalledAt AS lastRecalledAt',
        { id: 'test-matchcount' },
      );
      const record = res.records[0];
      const mc = neo4j.integer.toNumber(record.get('matchCount'));
      expect(mc).toBe(1);
      expect(record.get('lastRecalledAt')).toBeDefined();
      expect(record.get('lastRecalledAt')).not.toBeNull();
    } finally {
      await session.close();
    }
  });

  // =========================================================================
  // 6. upsert 更新（幂等写入）
  // =========================================================================

  it('should not create duplicate nodes on repeated upsert', async () => {
    const id = 'test-upsert';
    const exp1 = makeDistilled({
      id,
      relevanceScore: 0.8,
      title: 'First write',
      summary: 'Original summary',
    });
    await storage.saveDistilled(exp1);

    // 用相同 ID 再次写入，更新属性
    const exp2 = makeDistilled({
      id,
      relevanceScore: 0.9,
      title: 'Second write (updated)',
      summary: 'Updated summary',
    });
    await storage.saveDistilled(exp2);

    // 验证只有 1 个节点
    const session = driver.session();
    try {
      const res = await session.run(
        'MATCH (e:EXPERIENCE {id: $id}) RETURN count(e) AS cnt',
        { id },
      );
      const record = res.records[0];
      expect(neo4j.integer.toNumber(record.get('cnt'))).toBe(1);
    } finally {
      await session.close();
    }

    // 验证最新属性生效
    const results = await storage.searchRelevant(0.6, 10);
    const found = results.find((r) => r.experience.id === id);
    expect(found).toBeDefined();
    expect(found!.experience.title).toBe('Second write (updated)');
    expect(found!.experience.summary).toBe('Updated summary');
    expect(found!.score).toBe(0.9);
  });
});