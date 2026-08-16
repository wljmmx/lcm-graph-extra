/**
 * ExperienceStorage 集成测试 — 验证 Cypher 查询在真实 Neo4j 环境中的正确性。
 *
 * 运行模式:
 *   - 有 NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD 环境变量时，使用真实 Neo4j
 *   - 无环境变量时，使用内存 mock 适配器（验证存储逻辑）
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
// 内存 mock 适配器 — 模拟 Neo4j Cypher 行为
// ---------------------------------------------------------------------------

class InMemoryNeo4jAdapter implements GraphQueryExecutor {
  private nodes = new Map<string, Record<string, unknown>>();

  async query<T = Record<string, unknown>>(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const p = params ?? {};
    const c = cypher.trim();

    // CREATE TEXT INDEX — noop
    if (c.startsWith('CREATE TEXT INDEX')) return [] as any;

    // CALL db.index.fulltext — 模拟不可用，触发降级
    if (c.startsWith('CALL db.index.fulltext')) throw new Error('fulltext index not available in mock');

    // MERGE (upsert)
    if (c.startsWith('MERGE')) {
      const id = p.id as string;
      const props = (p.props ?? {}) as Record<string, unknown>;
      const isDistilled = c.includes("'DISTILLED'");
      const existing = this.nodes.get(id);
      const node: Record<string, unknown> = existing ? { ...existing } : {};
      node.id = id; // 确保 id 存储在节点属性中
      // e += $props
      for (const [k, v] of Object.entries(props)) {
        node[k] = v;
      }
      // ON CREATE SET
      if (!existing) {
        node.createdAt = Date.now();
      }
      // status
      if (isDistilled) {
        node.status = 'DISTILLED';
      } else if (!existing) {
        node.status = 'PENDING';
      }
      this.nodes.set(id, node);
      return [] as any;
    }

    // DELETE (cleanup: WHERE e.id STARTS WITH "test-")
    if (c.includes('DETACH DELETE')) {
      const prefix = (c.match(/STARTS WITH "(.*?)"/) || [])[1];
      if (prefix) {
        for (const [id] of [...this.nodes]) {
          if (id.startsWith(prefix)) this.nodes.delete(id);
        }
      }
      return [] as any;
    }

    // SET e.matchCount = coalesce(e.matchCount, 0) + 1
    if (c.includes('SET e.matchCount = coalesce')) {
      const id = p.id as string;
      const node = this.nodes.get(id);
      if (node) {
        node.matchCount = (node.matchCount as number || 0) + 1;
        node.lastRecalledAt = Date.now();
      }
      return [] as any;
    }

    // SET e.qualityScore
    if (c.includes('SET e.qualityScore')) {
      const id = p.id as string;
      const node = this.nodes.get(id);
      if (node) {
        node.qualityScore = p.qualityScore;
        const delta = p.delta as number;
        const cur = (node.relevanceScore as number) ?? 0.5;
        if (delta > 0) node.relevanceScore = Math.min(cur + delta, 1.0);
        else if (delta < 0) node.relevanceScore = Math.max(cur + delta, 0.3);
        node.lastValidatedAt = Date.now();
      }
      return [] as any;
    }

    // DELETE e (单节点删除)
    if (c.includes('DELETE e') && !c.includes('DETACH')) {
      const id = p.id as string;
      this.nodes.delete(id);
      return [] as any;
    }

    // cleanupExpired
    if (c.includes('expiresAt < timestamp()') && c.includes('DELETE e')) {
      let deleted = 0;
      const batchSize = (p.batchSize as number) || 100;
      for (const [id, node] of [...this.nodes]) {
        if (deleted >= batchSize) break;
        const exp = node.expiresAt as number | undefined;
        if (exp !== undefined && exp < Date.now()) {
          this.nodes.delete(id);
          deleted++;
        }
      }
      return [{ deleted }] as any;
    }

    // decayMatchCount
    if (c.includes('round(e.matchCount * 0.5)')) {
      const staleMs = Number((c.match(/timestamp\(\) - (\d+)/) || [])[1] || 0);
      let decayed = 0;
      for (const [, node] of this.nodes) {
        const lr = node.lastRecalledAt as number | undefined;
        if (lr && lr < Date.now() - staleMs && (node.matchCount as number) > 0) {
          node.matchCount = Math.round((node.matchCount as number) * 0.5);
          decayed++;
        }
      }
      return [{ decayed }] as any;
    }

    // count(e) — 直接查询 count
    if (c.includes('RETURN count(e) AS cnt')) {
      const id = p.id as string;
      const cnt = this.nodes.has(id) ? 1 : 0;
      return [{ cnt }] as any;
    }

    // RETURN e.status AS status — 直接查节点属性
    if (c.includes('RETURN e.status AS status')) {
      const id = p.id as string;
      const node = this.nodes.get(id);
      if (!node) return [] as any;
      const result: Record<string, unknown> = {};
      if (c.includes('e.status AS status')) result.status = node.status;
      if (c.includes('e.detail AS detail')) result.detail = node.detail;
      if (c.includes('e.relevanceScore AS relevanceScore')) result.relevanceScore = node.relevanceScore;
      return [result] as any;
    }

    // RETURN e.matchCount AS matchCount, e.lastRecalledAt AS lastRecalledAt
    if (c.includes('RETURN e.matchCount AS matchCount')) {
      const id = p.id as string;
      const node = this.nodes.get(id);
      if (!node) return [] as any;
      return [{
        matchCount: node.matchCount ?? 0,
        lastRecalledAt: node.lastRecalledAt ?? null,
      }] as any;
    }

    // SEARCH_RELEVANT — 按 relevanceScore 排序
    if (c.includes('ORDER BY e.relevanceScore DESC') && c.includes('decayedMatchCount DESC')) {
      const minScore = (p.minScore as number) ?? 0;
      const limit = (p.limit as number) ?? 5;
      const results = [...this.nodes.values()]
        .filter(n => n.status === 'DISTILLED')
        .filter(n => (n.relevanceScore as number) >= minScore)
        .filter(n => !n.expiresAt || (n.expiresAt as number) > Date.now())
        .filter(n => !n.state || n.state !== 'superseded')
        .sort((a, b) => (b.relevanceScore as number) - (a.relevanceScore as number))
        .slice(0, limit);
      return results.map(n => this._nodeToRow(n)) as any;
    }

    // searchByQuery CONTAINS 路径
    if (c.includes('queryMatch') || c.includes('CONTAINS toLower')) {
      return this._searchByContains(c, p);
    }

    // SEARCH_BY_CONTEXT
    if (c.includes('toLower(e.context) CONTAINS')) {
      const keyword = (p.keyword as string) || '';
      const limit = (p.limit as number) ?? 5;
      const results = [...this.nodes.values()]
        .filter(n => n.status === 'DISTILLED')
        .filter(n => !n.state || n.state !== 'superseded')
        .filter(n => !n.expiresAt || (n.expiresAt as number) > Date.now())
        .filter(n => ((n.context as string) || '').toLowerCase().includes(keyword.toLowerCase()))
        .sort((a, b) => (b.relevanceScore as number) - (a.relevanceScore as number))
        .slice(0, limit);
      return results.map(n => this._nodeToRow(n)) as any;
    }

    // getTopExperiences
    if (c.includes('ORDER BY e.matchCount DESC')) {
      const limitMatch = c.match(/LIMIT (\d+)/);
      const limit = limitMatch ? Number(limitMatch[1]) : 3;
      const results = [...this.nodes.values()]
        .filter(n => n.status === 'DISTILLED')
        .filter(n => !n.state || n.state !== 'superseded')
        .filter(n => (n.relevanceScore as number) >= 0.6)
        .filter(n => !n.expiresAt || (n.expiresAt as number) > Date.now())
        .sort((a, b) => ((b.matchCount as number) || 0) - ((a.matchCount as number) || 0)
          || (b.relevanceScore as number) - (a.relevanceScore as number))
        .slice(0, limit);
      return results.map(n => this._nodeToRow(n)) as any;
    }

    // FETCH_PENDING
    if (c.includes("e.status = 'PENDING'") && c.includes('e.source AS source')) {
      const limit = (p.limit as number) ?? 200;
      const results = [...this.nodes.values()]
        .filter(n => n.status === 'PENDING')
        .sort((a, b) => (a.createdAt as number) - (b.createdAt as number))
        .slice(0, limit);
      return results.map(n => ({
        id: n.id,
        source: n.source,
        context: n.context,
        detail: n.detail,
        projectName: n.projectName,
        taskId: n.taskId,
        createdAt: n.createdAt,
      })) as any;
    }

    // linkRelated
    if (c.includes('MERGE (e)-[r:RELATED_TO]')) {
      return [{ linked: 0 }] as any;
    }

    // findRelatedByConcepts
    if (c.includes('RETURN other.id AS id')) {
      return [] as any;
    }

    return [] as any;
  }

  private _nodeToRow(n: Record<string, unknown>): Record<string, unknown> {
    return {
      id: n.id,
      title: n.title ?? '',
      summary: n.summary ?? '',
      detail: n.detail ?? '',
      context: n.context ?? '',
      relevanceScore: n.relevanceScore ?? 0,
      createdAt: n.createdAt ?? Date.now(),
      matchCount: n.matchCount ?? 0,
      rawIds: n.rawIds ?? '',
      type: n.type ?? 'lesson',
      tags_scenario: n.tags_scenario ?? '',
      tags_techStack: n.tags_techStack ?? '',
      tags_severity: n.tags_severity ?? '',
      tags_free: n.tags_free ?? '',
    };
  }

  private _searchByContains(cypher: string, p: Record<string, unknown>): Record<string, unknown>[] {
    const minScore = (p.minScore as number) ?? 0;
    const limit = (p.limit as number) ?? 5;
    const queryKeyword = ((p.queryKeyword as string) || '').toLowerCase();
    const scenarioTags = (p.scenarioTags as string[]) || [];
    const techStackTags = (p.techStackTags as string[]) || [];
    const queryFreeTags = (p.queryFreeTags as string[]) || [];
    const projects = (p.projects as string[]) || [];
    const halfLifeDays = (p.halfLifeDays as number) ?? 30;

    const hasFilters = scenarioTags.length > 0 || techStackTags.length > 0 || projects.length > 0;

    let results = [...this.nodes.values()]
      .filter(n => n.status === 'DISTILLED')
      .filter(n => !n.state || n.state !== 'superseded')
      .filter(n => (n.relevanceScore as number) >= minScore)
      .filter(n => !n.expiresAt || (n.expiresAt as number) > Date.now());

    // 项目过滤（软过滤）
    if (projects.length > 0) {
      const lowerProjects = projects.map(p => p.toLowerCase());
      results = results.filter(n => {
        const pn = ((n.projectName as string) || '').toLowerCase();
        return pn === '' || lowerProjects.includes(pn);
      });
    }

    // 标签过滤
    if (hasFilters) {
      results = results.filter(n => {
        const scenarios = ((n.tags_scenario as string) || '').split(',').filter(Boolean);
        const techStacks = ((n.tags_techStack as string) || '').split(',').filter(Boolean);
        const matchScenario = scenarioTags.some(s => scenarios.includes(s));
        const matchTech = techStackTags.some(t => techStacks.includes(t));
        return matchScenario || matchTech;
      });
    }

    // 计算 queryMatch
    const scored = results.map(n => {
      let queryMatch = 0;
      if (queryKeyword) {
        if (((n.summary as string) || '').toLowerCase().includes(queryKeyword)) queryMatch += 1.0;
        if (((n.context as string) || '').toLowerCase().includes(queryKeyword)) queryMatch += 0.5;
        if (((n.title as string) || '').toLowerCase().includes(queryKeyword)) queryMatch += 0.7;
      }
      // freeTags 匹配
      if (queryFreeTags.length > 0) {
        const freeTags = ((n.tags_free as string) || '').split(',').filter(Boolean);
        const lowerQueryFree = queryFreeTags.map(f => f.toLowerCase());
        if (freeTags.some(f => lowerQueryFree.includes(f.toLowerCase()))) {
          queryMatch += 0.3;
        }
      }
      // decayedMatchCount
      let decayedMatchCount: number;
      const mc = (n.matchCount as number) || 0;
      if (n.lastRecalledAt) {
        const daysSince = (Date.now() - (n.lastRecalledAt as number)) / (1000 * 60 * 60 * 24);
        decayedMatchCount = mc * Math.pow(0.5, daysSince / halfLifeDays);
      } else {
        decayedMatchCount = mc * 0.5;
      }
      return { node: n, queryMatch, decayedMatchCount };
    });

    // ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) + (decayedMatchCount * 0.1) DESC
    scored.sort((a, b) => {
      const sa = (b.node.relevanceScore as number) * 0.6 + b.queryMatch * 0.4 + b.decayedMatchCount * 0.1;
      const sb = (a.node.relevanceScore as number) * 0.6 + a.queryMatch * 0.4 + a.decayedMatchCount * 0.1;
      return sa - sb;
    });

    return scored.slice(0, limit).map(s => {
      const row = this._nodeToRow(s.node);
      row.queryMatch = s.queryMatch;
      return row;
    });
  }

  clear() {
    this.nodes.clear();
  }
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

// 真实 Neo4j 环境
let driver: neo4j.Driver | null = null;
let mockAdapter: InMemoryNeo4jAdapter | null = null;

beforeAll(async () => {
  if (hasNeo4j) {
    driver = neo4j.driver(
      NEO4J_URI!,
      neo4j.auth.basic(NEO4J_USER!, NEO4J_PASSWORD!),
    );
  } else {
    mockAdapter = new InMemoryNeo4jAdapter();
  }
});

afterAll(async () => {
  if (driver) await driver.close();
});

function createStorage(): ExperienceStorage {
  if (hasNeo4j && driver) {
    const adapter: GraphQueryExecutor = {
      query: async <T = Record<string, unknown>>(
        cypher: string,
        params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>[]> => {
        const session = driver!.session();
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
    return new ExperienceStorage(adapter);
  }
  return new ExperienceStorage(mockAdapter!);
}

describe('ExperienceStorage Integration', () => {
  let storage: ExperienceStorage;

  beforeEach(async () => {
    storage = createStorage();
    if (hasNeo4j && driver) {
      // 清理所有测试数据（ID 以 "test-" 开头）
      const session = driver.session();
      try {
        await session.run(
          'MATCH (e:EXPERIENCE) WHERE e.id STARTS WITH "test-" DETACH DELETE e',
        );
      } finally {
        await session.close();
      }
    } else {
      mockAdapter!.clear();
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

    if (hasNeo4j && driver) {
      // 真实 Neo4j 环境：直接用 driver 查询验证
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
    } else {
      // Mock 环境：通过 storage API 验证
      const results = await storage.searchRelevant(0, 10);
      // raw 初始为 PENDING，searchRelevant 只返回 DISTILLED，不应包含
      expect(results.find(r => r.experience.id === rawId)).toBeUndefined();

      // 写入精炼经验
      const distilled = makeDistilled({
        id: rawId,
        type: 'lesson',
        relevanceScore: 0.85,
        summary: 'Distilled summary for the raw experience',
        detail: 'Refined detail after distillation',
      });
      await storage.saveDistilled(distilled);

      // 验证 status 变为 DISTILLED（通过 searchRelevant 能查到）
      const results2 = await storage.searchRelevant(0, 10);
      const found = results2.find(r => r.experience.id === rawId);
      expect(found).toBeDefined();
      expect(found!.experience.detail).toBe('Refined detail after distillation');
      expect(found!.experience.relevanceScore).toBe(0.85);
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

    if (hasNeo4j && driver) {
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
    } else {
      // Mock 环境：再次 incrementMatchCount 后通过 searchRelevant 验证 matchCount
      await storage.incrementMatchCount('test-matchcount');
      const results = await storage.searchRelevant(0, 10);
      const found = results.find(r => r.experience.id === 'test-matchcount');
      expect(found).toBeDefined();
      expect(found!.experience.matchCount).toBe(2);
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

    if (hasNeo4j && driver) {
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

// =========================================================================
// 全文索引查询时自愈：索引缺失（历史误建 TEXT / 初始化时 Neo4j 未就绪）时，
// 首次搜索应触发 ensureIndexes 重建 FULLTEXT 索引并重试成功，而非永久降级。
// =========================================================================

describe('ExperienceStorage 全文索引查询时自愈', () => {
  it('首次全文查询遇 "no such fulltext schema index" 时重建索引并重试成功', async () => {
    let fulltextCalls = 0;
    const schemaOps: string[] = [];
    const adapter: GraphQueryExecutor = {
      async query(cypher: string): Promise<Record<string, unknown>[]> {
        const c = cypher.trim();
        if (c.startsWith('CALL db.index.fulltext.queryNodes')) {
          fulltextCalls++;
          if (fulltextCalls === 1) {
            throw new Error(
              'Neo4jError: Failed to invoke procedure `db.index.fulltext.queryNodes`: '
              + 'Caused by: java.lang.IllegalArgumentException: '
              + 'There is no such fulltext schema index: experience_summary_idx',
            );
          }
          return [{
            id: 'test-selftest',
            title: 'React perf',
            summary: 'Use memo',
            detail: '',
            context: 'frontend',
            relevanceScore: 0.9,
            createdAt: Date.now(),
            matchCount: 0,
            rawIds: '',
            type: 'bug_fix',
            tags_scenario: '',
            tags_techStack: '',
            tags_severity: '',
            tags_free: '',
            queryMatch: 0.8,
          }];
        }
        // 模拟历史遗留的同名 TEXT 索引（ensureIndexes 应识别并先删除再建 FULLTEXT）
        if (c.startsWith('SHOW INDEXES')) { schemaOps.push('SHOW'); return [{ name: 'experience_summary_idx', type: 'TEXT' } as Record<string, unknown>]; }
        if (c.startsWith('DROP INDEX')) { schemaOps.push('DROP'); return []; }
        if (c.startsWith('CREATE FULLTEXT INDEX')) { schemaOps.push('CREATE'); return []; }
        return [];
      },
    };

    const storage = new ExperienceStorage(adapter);
    const results = await storage.searchByQuery({ query: 'React', minScore: 0.6, limit: 5 });

    // 自愈生效：首次失败 → ensureIndexes（SHOW + DROP 旧 TEXT + CREATE FULLTEXT）→ 重试成功
    expect(fulltextCalls).toBe(2);
    expect(schemaOps).toContain('SHOW');
    expect(schemaOps).toContain('DROP');
    expect(schemaOps).toContain('CREATE');
    expect(results.length).toBe(1);
    expect(results[0].experience.id).toBe('test-selftest');
  });
});
