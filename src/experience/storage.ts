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
    AND (e.state IS NULL OR e.state <> 'superseded')
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

/** P3-6: SEARCH_BY_QUERY 已删除 —— 死代码常量，定义但从未被引用，
 *  且含未实现的 $HAS_FILTERS 占位符与缺失 tags_free 处理，已被 searchByQuery 内联实现取代。 */

/** 按上下文关键词搜索（原始方法保留） */
const SEARCH_BY_CONTEXT = `
  MATCH (e:${LABEL})
  WHERE e.status = 'DISTILLED'
    AND (e.state IS NULL OR e.state <> 'superseded')
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

// G-8: LLM 异步验证回路 —— 更新 qualityScore + 调整 relevanceScore + 记录历史
const UPDATE_QUALITY_SCORE = `
  MATCH (e:${LABEL} {id: $id})
  SET e.qualityScore = $qualityScore,
      e.relevanceScore = CASE
        WHEN $delta > 0 THEN least(coalesce(e.relevanceScore, 0.5) + $delta, 1.0)
        WHEN $delta < 0 THEN greatest(coalesce(e.relevanceScore, 0.5) + $delta, 0.3)
        ELSE coalesce(e.relevanceScore, 0.5)
      END,
      e.lastValidatedAt = timestamp(),
      e.qualityScoreHistory = coalesce(e.qualityScoreHistory, []) + { ts: timestamp(), score: $qualityScore, delta: $delta, source: $source }
`;

/**
 * P3-6: searchByQuery 的共享尾部（WITH 计算 queryMatch + RETURN + ORDER BY + LIMIT）。
 * 原先 hasFilters / 无过滤两个分支各有一份完全相同的 30 行 Cypher，仅 WHERE 过滤条件不同。
 * 提取为常量消除重复，降低维护成本与拼写漂移风险。
 */
const SEARCH_QUERY_TAIL = `
        WITH e,
          (CASE WHEN toLower(COALESCE(e.summary, '')) CONTAINS toLower($queryKeyword) THEN 1.0 ELSE 0.0 END)
          + (CASE WHEN toLower(COALESCE(e.context, '')) CONTAINS toLower($queryKeyword) THEN 0.5 ELSE 0.0 END)
          + (CASE WHEN toLower(COALESCE(e.title, '')) CONTAINS toLower($queryKeyword) THEN 0.7 ELSE 0.0 END)
          + (CASE WHEN size($queryFreeTags) > 0
            AND coalesce(e.tags_free, '') <> ''
            THEN ANY(f IN split(coalesce(e.tags_free, ''), ',')
               WHERE toLower(f) IN [x IN $queryFreeTags | toLower(x)])
               ? 0.3
               : 0.0
            ELSE 0.0 END) AS queryMatch
        RETURN e.id AS id, e.title AS title, e.summary AS summary, e.detail AS detail,
               e.context AS context, e.relevanceScore AS relevanceScore, e.createdAt AS createdAt,
               e.matchCount AS matchCount, e.rawIds AS rawIds, e.type AS type,
               e.tags_scenario AS tags_scenario,
               e.tags_techStack AS tags_techStack, e.tags_severity AS tags_severity,
               e.tags_free AS tags_free,
               queryMatch AS queryMatch
        ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) DESC, e.matchCount DESC
        LIMIT $limit
`;

/** P3-6: 可选的标签过滤条件（hasFilters 时拼接到 WHERE 子句） */
const SEARCH_QUERY_TAG_FILTER = `AND (
             ANY(s IN COALESCE(e.tags_scenario, []) WHERE s IN $scenarioTags)
             OR ANY(t IN COALESCE(e.tags_techStack, []) WHERE t IN $techStackTags)
           )`;

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

/**
 * N-3: 查询并删除已过期的 EXPERIENCE 节点（expiresAt < 当前时间）。
 * 检索时已按 expiresAt 过滤，但节点本身仍留在图中占用空间。
 * 批量删除（每批最多 batchSize 个），避免单次删除过多导致事务过大。
 */
const CLEANUP_EXPIRED = `
  MATCH (e:${LABEL})
  WHERE e.expiresAt IS NOT NULL AND e.expiresAt < timestamp()
  WITH e LIMIT $batchSize
  DELETE e
  RETURN count(e) AS deleted
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
      relatedConcepts: (d as any).relatedConcepts?.join(',') || '',
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
      projects = [],
      minScore = 0.6,
      limit = 5,
    } = options;

    // 如果没有 query 且没有标签过滤，回退到按 relevanceScore 排序
    if (!query && scenarioTags.length === 0 && techStackTags.length === 0) {
      return this.searchRelevant(minScore, limit);
    }

    const hasFilters = scenarioTags.length > 0 || techStackTags.length > 0 || projects.length > 0;

    // 构建查询参数
    const params: Record<string, unknown> = {
      minScore,
      queryKeyword: query || '',
      scenarioTags: scenarioTags.length > 0 ? scenarioTags : [],
      techStackTags: techStackTags.length > 0 ? techStackTags : [],
      queryFreeTags: queryFreeTags.length > 0 ? queryFreeTags : [],
      projects: projects.length > 0 ? projects : [],
      limit: Math.trunc(limit),
    };

    // S-6': 项目名过滤 —— 软过滤（命中任一项目名即可，无项目名的经验也保留）
    // 因为经验的 projectName 可能为空（跨项目通用经验），所以只在有项目过滤词时
    // 额外增加"项目匹配 OR 无项目名"的条件，避免误过滤掉通用经验。
    const projectFilter = projects.length > 0
      ? `\n           AND (size($projects) = 0 OR (e.projectName IS NOT NULL AND toLower(e.projectName) IN [p IN $projects | toLower(p)]))`
      : '';

    // P3-6: 用常量组合替代原先两份重复的 30 行 Cypher，仅 WHERE 过滤条件按 hasFilters 拼接
    const filterClause = hasFilters ? `\n           ${SEARCH_QUERY_TAG_FILTER}` : '';
    const actualCypher = `MATCH (e:${LABEL})
         WHERE e.status = 'DISTILLED'
           AND (e.state IS NULL OR e.state <> 'superseded')
           AND e.relevanceScore >= $minScore
           AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())${projectFilter}${filterClause}
         ${SEARCH_QUERY_TAIL}`;

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
   * G-8: LLM 异步验证回路 —— 更新经验质量分数并调整相关性。
   *
   * @param id 经验 ID
   * @param qualityScore LLM 判定的质量分数 [0, 1]
   * @param delta relevanceScore 调整量（正值=成功召回+0.05，负值=无效召回-0.05）
   * @param source 来源（gm-pro / local）
   */
  async updateQualityScore(id: string, qualityScore: number, delta: number, source: 'gm-pro' | 'local' = 'local'): Promise<void> {
    await this.adapter.query(UPDATE_QUALITY_SCORE, {
      id,
      qualityScore: Math.max(0, Math.min(1, qualityScore)),
      delta,
      source,
    });
  }

  /**
   * S-11': Zettelkasten evolve — 为新蒸馏的经验建立 RELATED_TO 关联
   *
   * 根据 relatedConcepts 搜索现有 DISTILLED 经验，将概念重叠度高的经验
   * 用 RELATED_TO 边连接起来，形成知识网络。
   *
   * @param experienceId 新经验 ID
   * @param concepts 相关概念关键词列表
   * @param maxLinks 最多建立多少条关联
   * @returns 建立的关联数
   */
  async linkRelated(
    experienceId: string,
    concepts: string[],
    maxLinks: number = 3,
  ): Promise<number> {
    if (!experienceId || !Array.isArray(concepts) || concepts.length === 0) return 0;

    const lowerConcepts = concepts.map((c) => c.toLowerCase());
    const result = await this.adapter.query(
      `
        MATCH (e:${LABEL} { id: $id })
        MATCH (other:${LABEL})
        WHERE other.status = 'DISTILLED'
          AND other.id <> $id
          AND other.relatedConcepts IS NOT NULL
          AND size(other.relatedConcepts) > 0
        WITH e, other,
             [c IN split(toLower(other.relatedConcepts), ',') WHERE c IN $concepts] AS overlap
        WHERE size(overlap) >= 1
        WITH e, other, size(overlap) AS overlapScore
        ORDER BY overlapScore DESC, other.relevanceScore DESC
        LIMIT $maxLinks
        MERGE (e)-[r:RELATED_TO]->(other)
        SET r.overlap = overlapScore,
            r.updatedAt = timestamp()
        RETURN count(r) AS linked
      `,
      {
        id: experienceId,
        concepts: lowerConcepts,
        maxLinks: Math.trunc(maxLinks),
      },
    );

    const row = (result?.[0] as { linked?: number }) || undefined;
    return typeof row?.linked === 'number' ? row.linked : 0;
  }

  /**
   * S-11': 按概念重叠查找关联节点（不建边，供 gm-pro linkNodes 调用）
   *
   * @param experienceId 当前经验 ID（排除自身）
   * @param concepts 相关概念关键词列表
   * @param maxResults 最多返回多少个节点 ID
   * @returns 关联节点 ID 列表
   */
  async findRelatedByConcepts(
    experienceId: string,
    concepts: string[],
    maxResults: number = 3,
  ): Promise<string[]> {
    if (!experienceId || !Array.isArray(concepts) || concepts.length === 0) return [];
    const lowerConcepts = concepts.map((c) => c.toLowerCase());
    const result = await this.adapter.query<{ id: string }>(
      `
        MATCH (other:${LABEL})
        WHERE other.status = 'DISTILLED'
          AND other.id <> $id
          AND other.relatedConcepts IS NOT NULL
          AND size(other.relatedConcepts) > 0
        WITH other,
             [c IN split(toLower(other.relatedConcepts), ',') WHERE c IN $concepts] AS overlap
        WHERE size(overlap) >= 1
        WITH other, size(overlap) AS overlapScore
        ORDER BY overlapScore DESC, other.relevanceScore DESC
        LIMIT $maxResults
        RETURN other.id AS id
      `,
      {
        id: experienceId,
        concepts: lowerConcepts,
        maxResults: Math.trunc(maxResults),
      },
    );
    return (result || []).map((r: any) => r.id).filter(Boolean);
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

  /**
   * N-3: 清理已过期的 EXPERIENCE 节点（expiresAt < 当前时间）。
   * 批量删除，返回本批次删除数量。如果返回值 < batchSize 表示已无更多过期节点。
   *
   * 为什么需要这个方法：
   * - 检索时已按 expiresAt 过滤（过期经验不会被召回），但节点仍在图中
   * - 长期运行会积累大量过期节点，拖慢查询、浪费存储
   * - 与 Neo4j 层的 TTL（ttl.ts）分工：TTL 处理通用节点 weight 衰减，
   *   本方法处理 EXPERIENCE 专属的 expiresAt 字段
   */
  async cleanupExpired(batchSize: number = 100): Promise<number> {
    const rows = await this.adapter.query(CLEANUP_EXPIRED, { batchSize: Math.trunc(batchSize) });
    const row = rows?.[0] as { deleted?: number } | undefined;
    return typeof row?.deleted === 'number' ? row.deleted : 0;
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
