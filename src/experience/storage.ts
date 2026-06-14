/**
 * Experience Storage — Neo4j EXPERIENCE 节点 CRUD。
 *
 * 原始经验写入 mark PENDING，晚间总结时标记为 DISTILLED。
 */

import { GraphAdapter } from '../adapters/graph-adapter';
import type { RawExperience, DistilledExperience, ExperienceSearchResult } from './types';

// ---------------------------------------------------------------------------
// Cypher queries
// ---------------------------------------------------------------------------

/** Neo4j label for experience nodes */
const LABEL = 'EXPERIENCE';

const UPSERT_RAW = `
  MERGE (e:${LABEL} {id: $id})
  ON CREATE SET
    e += $props,
    e.status = 'PENDING',
    e.createdAt = timestamp()
  ON MATCH SET
    e += $props
`;

const UPSERT_DISTILLED = `
  MERGE (e:${LABEL} {id: $id})
  ON CREATE SET
    e += $props,
    e.status = 'DISTILLED',
    e.createdAt = timestamp()
  ON MATCH SET
    e += $props,
    e.status = 'DISTILLED'
`;

const SEARCH_RELEVANT = `
  MATCH (e:${LABEL})
  WHERE e.status = 'DISTILLED'
    AND e.relevanceScore >= $minScore
    AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
  RETURN e.id AS id,
         e.title AS title,
         e.summary AS summary,
         e.detail AS detail,
         e.context AS context,
         e.relevanceScore AS relevanceScore,
         e.createdAt AS createdAt,
         e.matchCount AS matchCount
  ORDER BY e.relevanceScore DESC, e.matchCount DESC
  LIMIT $limit
`;

const SEARCH_BY_CONTEXT = `
  MATCH (e:${LABEL})
  WHERE e.status = 'DISTILLED'
    AND toLower(e.context) CONTAINS toLower($keyword)
    AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
  RETURN e.id AS id,
         e.title AS title,
         e.summary AS summary,
         e.detail AS detail,
         e.context AS context,
         e.relevanceScore AS relevanceScore,
         e.createdAt AS createdAt,
         e.matchCount AS matchCount
  ORDER BY e.relevanceScore DESC
  LIMIT $limit
`;

const INCREMENT_MATCH_COUNT = `
  MATCH (e:${LABEL} {id: $id})
  SET e.matchCount = coalesce(e.matchCount, 0) + 1
`;

const FETCH_PENDING = `
  MATCH (e:${LABEL})
  WHERE e.status = 'PENDING'
  RETURN e.id AS id,
         e.source AS source,
         e.context AS context,
         e.detail AS detail,
         e.projectName AS projectName,
         e.taskId AS taskId,
         e.createdAt AS createdAt
  ORDER BY e.createdAt ASC
  LIMIT $limit
`;

const DELETE_BY_ID = `
  MATCH (e:${LABEL} {id: $id})
  DELETE e
`;

// ---------------------------------------------------------------------------
// Storage class
// ---------------------------------------------------------------------------

export class ExperienceStorage {
  private adapter: GraphAdapter;
  private defaultLimit: number;

  constructor(adapter: GraphAdapter, defaultLimit: number = 10) {
    this.adapter = adapter;
    this.defaultLimit = defaultLimit;
  }

  /**
   * 写入原始经验（标记 PENDING）
   */
  async saveRaw(raw: RawExperience): Promise<void> {
    const props: Record<string, unknown> = {
      source: raw.source,
      context: raw.context,
      detail: raw.detail,
      sessionId: raw.sessionId,
      projectName: raw.projectName || '',
      taskId: raw.taskId || '',
      type: mapSourceToType(raw.source),
    };
    await this.adapter.query(UPSERT_RAW, { id: raw.id, props });
  }

  /**
   * 写入精炼经验（标记 DISTILLED）
   */
  async saveDistilled(d: DistilledExperience): Promise<void> {
    const props: Record<string, unknown> = {
      title: d.title,
      summary: d.summary,
      detail: d.detail,
      context: d.context,
      projectName: d.projectName || '',
      relevanceScore: d.relevanceScore,
      matchCount: d.matchCount,
      rawIds: d.rawIds.join(','),
      type: d.type,
    };
    if (d.expiresAt) {
      props.expiresAt = d.expiresAt.getTime();
    }
    await this.adapter.query(UPSERT_DISTILLED, { id: d.id, props });
  }

  /**
   * 搜索精炼经验（按 relevanceScore + matchCount 排序）
   */
  async searchRelevant(
    minScore: number = 0.6,
    limit: number = 5,
  ): Promise<ExperienceSearchResult[]> {
    const rows = await this.adapter.query<ExperienceSearchRow>(
      SEARCH_RELEVANT,
      { minScore, limit: Math.trunc(limit) },
    );
    return (rows || []).map((r: any) => ({
      experience: rowToDistilled(r),
      score: r.relevanceScore,
    }));
  }

  /**
   * 按上下文关键词搜索经验
   */
  async searchByContext(
    keyword: string,
    limit: number = 5,
  ): Promise<ExperienceSearchResult[]> {
    const rows = await this.adapter.query<ExperienceSearchRow>(
      SEARCH_BY_CONTEXT,
      { keyword, limit: Math.trunc(limit) },
    );
    return (rows || []).map((r: any) => ({
      experience: rowToDistilled(r),
      score: r.relevanceScore,
    }));
  }

  /**
   * 增加经验被命中的次数
   */
  async incrementMatchCount(id: string): Promise<void> {
    await this.adapter.query(INCREMENT_MATCH_COUNT, { id });
  }

  /**
   * 获取所有 PENDING 经验的原始记录（供 dreaming/cron 批量总结）
   */
  async fetchPending(limit: number = 200): Promise<PendingRow[]> {
    const rows = await this.adapter.query<PendingRow>(
      FETCH_PENDING,
      { limit: Math.trunc(limit) },
    );
    return (rows || []).map((r: any) => ({
      ...r,
      createdAt: new Date(r.createdAt),
    }));
  }

  /**
   * 删除经验（TTL 清理用）
   */
  async deleteById(id: string): Promise<void> {
    await this.adapter.query(DELETE_BY_ID, { id });
  }
}

// ---------------------------------------------------------------------------
// Internal types & helpers
// ---------------------------------------------------------------------------

interface ExperienceSearchRow {
  id: string;
  title: string;
  summary: string;
  detail: string;
  context: string;
  relevanceScore: number;
  createdAt: number;
  matchCount: number;
}

interface PendingRow {
  id: string;
  source: string;
  context: string;
  detail: string;
  projectName: string | null;
  taskId: string | null;
  createdAt: Date;
}

function rowToDistilled(r: ExperienceSearchRow): DistilledExperience {
  return {
    id: r.id,
    rawIds: [],
    type: 'lesson',
    title: r.title,
    summary: r.summary,
    detail: r.detail,
    context: r.context,
    relevanceScore: r.relevanceScore,
    createdAt: new Date(r.createdAt),
    matchCount: r.matchCount ?? 0,
  };
}

function mapSourceToType(source: string): string {
  switch (source) {
    case 'correction':   return 'correction';
    case 'failure':      return 'failure';
    case 'fix_success':  return 'fix';
    case 'explicit_save':return 'lesson';
    default:             return 'lesson';
  }
}
