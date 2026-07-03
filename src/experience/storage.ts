/**
 * Experience Storage — Neo4j EXPERIENCE 节点 CRUD。
 *
 * 原始经验写入 mark PENDING，晚间总结时标记为 DISTILLED。
 * 支持 Query-aware 混合搜索（静态 relevanceScore + 动态 query 匹配 + 标签过滤）。
 */

import { GraphAdapter } from '../adapters/graph-adapter';
import type {
  RawExperience,
  DistilledExperience,
  ExperienceSearchResult,
  ExperienceQueryOptions,
} from './types';

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

/** Legacy: 按 relevanceScore 排序（不查 query，用于通用经验兜底） */
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
         e.matchCount AS matchCount,
         e.rawIds AS rawIds,
         e.type AS type,
         e.tags_scenario AS tags_scenario,
         e.tags_techStack AS tags_techStack,
         e.tags_severity AS tags_severity,
         e.tags_free AS tags_free
  ORDER BY e.relevanceScore DESC, e.matchCount DESC
  LIMIT $limit
`;

/** Query-aware 混合搜索：静态 relevanceScore + 动态 query 关键词匹配 + 标签过滤 */
const SEARCH_BY_QUERY = `
  MATCH (e:${LABEL})
  WHERE e.status = 'DISTILLED'
    AND e.relevanceScore >= $minScore
    AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())

  // 标签过滤：如果提供了 scenario/techStack 标签，经验必须匹配至少一个
  $HAS_FILTERS
  AND (
    ANY(s IN COALESCE(e.tags_scenario, []) WHERE s IN $scenarioTags)
    OR ANY(t IN COALESCE(e.tags_techStack, []) WHERE t IN $techStackTags)
  )

  // query 关键词匹配度（summary + context 字段）
  WITH e,
    CASE WHEN toLower(COALESCE(e.summary, '')) CONTAINS toLower($queryKeyword) THEN 1.0 ELSE 0.0 END
    + CASE WHEN toLower(COALESCE(e.context, '')) CONTAINS toLower($queryKeyword) THEN 0.5 ELSE 0.0 END
    + CASE WHEN toLower(COALESCE(e.title, '')) CONTAINS toLower($queryKeyword) THEN 0.7 ELSE 0.0 END
    AS queryMatch

  RETURN e.id AS id,
         e.title AS title,
         e.summary AS summary,
         e.detail AS detail,
         e.context AS context,
         e.relevanceScore AS relevanceScore,
         e.createdAt AS createdAt,
         e.matchCount AS matchCount,
         e.rawIds AS rawIds,
         e.type AS type,
         e.tags_scenario AS tags_scenario,
         e.tags_techStack AS tags_techStack,
         e.tags_severity AS tags_severity,
         queryMatch AS queryMatch
  ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) DESC,
           e.matchCount DESC
  LIMIT $limit
`;

/** 按上下文关键词搜索（原始方法保留） */
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
         e.matchCount AS matchCount,
         e.rawIds AS rawIds,
         e.type AS type,
         e.tags_scenario AS tags_scenario,
         e.tags_techStack AS tags_techStack,
         e.tags_severity AS tags_severity
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
    // 写入多维标签
    if (d.tags) {
      props.tags_scenario = d.tags.scenario?.join(',') || '';
      props.tags_techStack = d.tags.techStack?.join(',') || '';
      props.tags_severity = d.tags.severity || '';
      if (d.tags.freeTags?.length) {
        props.tags_free = d.tags.freeTags.join(',') || '';
      }
    }
    await this.adapter.query(UPSERT_DISTILLED, { id: d.id, props });
  }

  /**
   * Query-aware 混合搜索（主召回路径）
   * 静态 relevanceScore (60%) + 动态 query 关键词匹配 (40%) + 标签过滤
   */
  async searchByQuery(options: ExperienceQueryOptions): Promise<ExperienceSearchResult[]> {
    const {
      freeTags: queryFreeTags = [],
      query,
      scenarioTags = [],
      techStackTags = [],
      minScore = 0.6,
      limit = 5,
    } = options;

    // 如果没有 query 且没有标签过滤，回退到按 relevanceScore 排序
    if (!query && scenarioTags.length === 0 && techStackTags.length === 0) {
      return this.searchRelevant(minScore, limit);
    }

    const hasFilters = scenarioTags.length > 0 || techStackTags.length > 0;

    // 构建查询参数
    const params: Record<string, unknown> = {
      minScore,
      queryKeyword: query || '',
      scenarioTags: scenarioTags.length > 0 ? scenarioTags : [],
      techStackTags: techStackTags.length > 0 ? techStackTags : [],
      queryFreeTags: queryFreeTags.length > 0 ? queryFreeTags : [],
      limit: Math.trunc(limit),
    };

    const actualCypher = hasFilters
      ? `MATCH (e:${LABEL})
         WHERE e.status = 'DISTILLED'
           AND e.relevanceScore >= $minScore
           AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
           AND (
             ANY(s IN COALESCE(e.tags_scenario, []) WHERE s IN $scenarioTags)
             OR ANY(t IN COALESCE(e.tags_techStack, []) WHERE t IN $techStackTags)
           )
         WITH e,
           CASE WHEN toLower(COALESCE(e.summary, '')) CONTAINS toLower($queryKeyword) THEN 1.0 ELSE 0.0 END
           + CASE WHEN toLower(COALESCE(e.context, '')) CONTAINS toLower($queryKeyword) THEN 0.5 ELSE 0.0 END
           + CASE WHEN toLower(COALESCE(e.title, '')) CONTAINS toLower($queryKeyword) THEN 0.7 ELSE 0.0 END
           + CASE WHEN size($queryFreeTags) > 0
             AND coalesce(e.tags_free, '') <> ''
             THEN ANY(f IN split(coalesce(e.tags_free, ''), ',') 
                WHERE toLower(f) IN [x IN $queryFreeTags | toLower(x)])
                ? 0.3
                : 0.0
             ELSE 0.0 END
         RETURN e.id AS id, e.title AS title, e.summary AS summary, e.detail AS detail,
                e.context AS context, e.relevanceScore AS relevanceScore, e.createdAt AS createdAt,
                e.matchCount AS matchCount, e.rawIds AS rawIds, e.type AS type,
                e.tags_scenario AS tags_scenario,
                e.tags_techStack AS tags_techStack, e.tags_severity AS tags_severity,
                e.tags_free AS tags_free,
                queryMatch AS queryMatch
         ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) DESC, e.matchCount DESC
         LIMIT $limit`
      : `MATCH (e:${LABEL})
         WHERE e.status = 'DISTILLED'
           AND e.relevanceScore >= $minScore
           AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
         WITH e,
           CASE WHEN toLower(COALESCE(e.summary, '')) CONTAINS toLower($queryKeyword) THEN 1.0 ELSE 0.0 END
           + CASE WHEN toLower(COALESCE(e.context, '')) CONTAINS toLower($queryKeyword) THEN 0.5 ELSE 0.0 END
           + CASE WHEN toLower(COALESCE(e.title, '')) CONTAINS toLower($queryKeyword) THEN 0.7 ELSE 0.0 END
           + CASE WHEN size($queryFreeTags) > 0
             AND coalesce(e.tags_free, '') <> ''
             THEN ANY(f IN split(coalesce(e.tags_free, ''), ',')
                WHERE toLower(f) IN [x IN $queryFreeTags | toLower(x)])
                ? 0.3
                : 0.0
             ELSE 0.0 END
         RETURN e.id AS id, e.title AS title, e.summary AS summary, e.detail AS detail,
                e.context AS context, e.relevanceScore AS relevanceScore, e.createdAt AS createdAt,
                e.matchCount AS matchCount, e.rawIds AS rawIds, e.type AS type,
                e.tags_scenario AS tags_scenario,
                e.tags_techStack AS tags_techStack, e.tags_severity AS tags_severity,
                e.tags_free AS tags_free,
                queryMatch AS queryMatch
         ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) DESC, e.matchCount DESC
         LIMIT $limit`;

    const rows = await this.adapter.query<ExperienceSearchRow>(
      actualCypher,
      params,
    );
    return (rows || []).map((r: any) => ({
      experience: rowToDistilled(r),
      score: r.relevanceScore !== undefined
        ? Number(r.relevanceScore) * 0.6 + (Number(r.queryMatch) || 0) * 0.4
        : Number(r.relevanceScore),
    }));
  }

  /**
   * 搜索精炼经验（按 relevanceScore + matchCount 排序，legacy）
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
  // P1-8 BUG-5: 原接口缺少 rawIds 和 type，导致 rowToDistilled 读回时丢失这两个字段
  rawIds?: string;
  type?: string;
  tags_scenario?: string;
  tags_techStack?: string;
  tags_severity?: string;
  tags_free?: string;
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
  // P1-8 BUG-5: 原代码 rawIds:[] 恒空、type:'lesson' 硬编码，
  // 尽管 saveDistilled 写入了 rawIds/type，读回时丢失。修复为从行读取并 split。
  return {
    id: r.id,
    rawIds: r.rawIds ? r.rawIds.split(',').filter(Boolean) : [],
    type: (r.type as DistilledExperience['type']) ?? 'lesson',
    title: r.title,
    summary: r.summary,
    detail: r.detail,
    context: r.context,
    relevanceScore: r.relevanceScore,
    createdAt: new Date(r.createdAt),
    matchCount: r.matchCount ?? 0,
    tags: buildTagsFromRow(r) as any,
  };
}

function buildTagsFromRow(r: ExperienceSearchRow) {
  const tags = {
    scenario: r.tags_scenario ? r.tags_scenario.split(',').filter(Boolean) : [],
    techStack: r.tags_techStack ? r.tags_techStack.split(',').filter(Boolean) : [],
    severity: r.tags_severity || undefined,
    freeTags: r.tags_free ? r.tags_free.split(',').filter(Boolean) : [],
  };
  // 如果所有字段都空，返回 undefined（与类型一致）
  const hasFreeTags = tags.freeTags?.length > 0;
  if (!tags.scenario.length && !tags.techStack.length && !tags.severity && !hasFreeTags) {
    return undefined;
  }
  return tags;
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
