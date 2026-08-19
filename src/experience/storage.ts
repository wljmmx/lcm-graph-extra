/**
 * Experience Storage — Neo4j EXPERIENCE 节点 CRUD。
 *
 * 原始经验写入 mark PENDING，晚间总结时标记为 DISTILLED。
 * 支持 Query-aware 混合搜索（静态 relevanceScore + 动态 query 匹配 + 标签过滤）。
 */

import type { GraphQueryExecutor } from '../types.js';
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

/** Legacy: 按 relevanceScore 排序（不查 query，用于通用经验兜底）
 *  C-1: matchCount 引入时间衰减排序，防止正反馈循环。
 */
const SEARCH_RELEVANT = `
  MATCH (e:${LABEL})
  WHERE e.status = 'DISTILLED'
    AND (e.state IS NULL OR e.state <> 'superseded')
    AND e.relevanceScore >= $minScore
    AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
  WITH e,
    CASE WHEN e.lastRecalledAt IS NOT NULL
      THEN coalesce(e.matchCount, 0) * (0.5 ^ ((timestamp() - e.lastRecalledAt) / (1000.0 * 60 * 60 * 24 * $halfLifeDays)))
      ELSE coalesce(e.matchCount, 0) * 0.5
    END AS decayedMatchCount
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
  ORDER BY e.relevanceScore DESC, decayedMatchCount DESC
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
  SET e.matchCount = coalesce(e.matchCount, 0) + 1,
      e.lastRecalledAt = timestamp()
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
            AND ANY(f IN split(coalesce(e.tags_free, ''), ',')
               WHERE toLower(f) IN [x IN $queryFreeTags | toLower(x)])
            THEN 0.3
            ELSE 0.0 END) AS queryMatch
        WITH e, queryMatch,
          CASE WHEN e.lastRecalledAt IS NOT NULL
            THEN coalesce(e.matchCount, 0) * (0.5 ^ ((timestamp() - e.lastRecalledAt) / (1000.0 * 60 * 60 * 24 * $halfLifeDays)))
            ELSE coalesce(e.matchCount, 0) * 0.5
          END AS decayedMatchCount
        RETURN e.id AS id, e.title AS title, e.summary AS summary, e.detail AS detail,
               e.context AS context, e.relevanceScore AS relevanceScore, e.createdAt AS createdAt,
               e.matchCount AS matchCount, e.rawIds AS rawIds, e.type AS type,
               e.tags_scenario AS tags_scenario,
               e.tags_techStack AS tags_techStack, e.tags_severity AS tags_severity,
               e.tags_free AS tags_free,
               queryMatch AS queryMatch
        ORDER BY (e.relevanceScore * 0.6) + (queryMatch * 0.4) + (decayedMatchCount * 0.1) DESC
        LIMIT $limit
`;

/** P3-6: 可选的标签过滤条件（hasFilters 时拼接到 WHERE 子句）
 *
 * BUGFIX(P0-4): tags_scenario / tags_techStack 存储为逗号分隔字符串（见 upsertDistilled
 * 的 .join(',')），此前用 ANY(s IN COALESCE(e.tags_scenario, [])) 把字符串当数组迭代，
 * Cypher 会逐字符拆分，导致 s IN $scenarioTags 几乎永不匹配，标签过滤完全失效。
 * 改为 split(coalesce(...), ',')（与 tags_free 查询 L126 + 读取路径 buildTagsFromRow 一致）。
 * 无需数据迁移：现有逗号字符串数据直接被 split 正确还原为数组。
 */
const SEARCH_QUERY_TAG_FILTER = `AND (
             ANY(s IN split(coalesce(e.tags_scenario, ''), ',') WHERE s <> '' AND s IN $scenarioTags)
             OR ANY(t IN split(coalesce(e.tags_techStack, ''), ',') WHERE t <> '' AND t IN $techStackTags)
           )`;

/**
 * 拉取待蒸馏经验。
 *
 * 重试机制：除 PENDING 节点外，也拉取 FAILED 且 retryCount < $maxRetries 的节点，
 * 让失败的经验在后续蒸馏中自动重试。超过 maxRetries 的节点不再自动拉取，
 * 需通过 resetFailedToPending() 手动重置后才会重新进入队列。
 */
const FETCH_PENDING = `
  MATCH (e:${LABEL})
  WHERE e.status = 'PENDING'
     OR (e.status = 'FAILED' AND coalesce(e.retryCount, 0) < $maxRetries)
  RETURN e.id AS id,
         e.source AS source,
         e.context AS context,
         e.detail AS detail,
         e.projectName AS projectName,
         e.taskId AS taskId,
         e.createdAt AS createdAt,
         e.retryCount AS retryCount,
         e.status AS status
  ORDER BY e.createdAt ASC
  LIMIT $limit
`;

const DELETE_BY_ID = `
  MATCH (e:${LABEL} {id: $id})
  DELETE e
`;

/**
 * 标记蒸馏失败：status → FAILED，retryCount + 1，记录错误信息与失败时间。
 * 下次 fetchPending 会在 retryCount < maxRetries 时自动重新拉取该节点。
 */
const MARK_FAILED = `
  MATCH (e:${LABEL} {id: $id})
  SET e.status = 'FAILED',
      e.retryCount = coalesce(e.retryCount, 0) + 1,
      e.lastError = $error,
      e.lastFailedAt = timestamp()
`;

/**
 * 重置已耗尽重试次数的 FAILED 节点回 PENDING，清零 retryCount。
 * 用于手动触发"重试失败经验"：resetFailedToPending(all) 重置全部 FAILED，
 * resetFailedToPending(exhausted, maxRetries) 仅重置 retryCount >= maxRetries 的节点。
 */
const RESET_FAILED_TO_PENDING = `
  MATCH (e:${LABEL})
  WHERE e.status = 'FAILED'
    AND ($mode = 'all' OR coalesce(e.retryCount, 0) >= $maxRetries)
  SET e.status = 'PENDING',
      e.retryCount = 0,
      e.lastError = null,
      e.resetAt = timestamp()
  RETURN count(e) AS reset
`;

/** 统计 FAILED 节点中已耗尽重试次数（retryCount >= maxRetries）的数量 */
const COUNT_FAILED_EXHAUSTED = `
  MATCH (e:${LABEL})
  WHERE e.status = 'FAILED' AND coalesce(e.retryCount, 0) >= $maxRetries
  RETURN count(e) AS cnt
`;

/**
 * 诊断：统计各 status 的 EXPERIENCE 节点数量。
 * 用于 backfill 写入后验证、distill 排查 pending=0 问题。
 */
const COUNT_BY_STATUS = `
  MATCH (e:${LABEL})
  RETURN e.status AS status, count(e) AS cnt
`;

/** 诊断：统计 EXPERIENCE 节点总数 */
const COUNT_ALL = `
  MATCH (e:${LABEL})
  RETURN count(e) AS total
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
  private adapter: GraphQueryExecutor;
  /**
   * 全文索引查询自愈节流：遇到"无全文索引/索引损坏"错误时，强制 DROP+重建并重试。
   * 用一个时间戳代替旧的布尔标记，避免第一次重建失败后永久不再重试
   * （旧逻辑 _ftSelfHealAttempted=true 置位后永不复位 → 损坏的 FULLTEXT 索引
   * 一直修不好）。改为节流：同一进程内每次失败后至少间隔 THROTTLE 才再次重建，
   * 既能恢复瞬时问题，又不会在每次查询都狂打重建。
   */
  private _lastFtHealAt = 0;
  private static FT_HEAL_THROTTLE_MS = 120_000;

  constructor(adapter: GraphQueryExecutor) {
    this.adapter = adapter;
  }

  /**
   * 检查底层 graphAdapter 是否已连接 Neo4j。
   *
   * graphAdapter.query() 在 driver 为 null 时静默返回 []，
   * 调用方需要通过此方法判断连接状态，避免误以为"无数据"。
   */
  get isConnected(): boolean {
    const a = this.adapter as any;
    // GraphAdapter 有 isConnected getter（返回 !!this.driver）
    if (a && typeof a.isConnected === 'boolean') return a.isConnected;
    // 兜底：尝试调用 isConnected 方法（某些适配器可能是方法而非 getter）
    if (a && typeof a.isConnected === 'function') {
      try { return Boolean(a.isConnected()); } catch { return false; }
    }
    return false;
  }

  /**
   * R-8: 确保 EXPERIENCE 节点的全文索引存在。
   *
   * P1-3 全文检索路径 `_searchByFulltextIndex` 调用
   * `db.index.fulltext.queryNodes('experience_search', ...)`，该过程
   * 只接受 FULLTEXT 索引。历史版本在此误建 TEXT INDEX，导致运行时抛
   * "There is no such fulltext schema index: experience_search"，
   * 全文检索路径永远不可用（静默降级到 CONTAINS）。
   *
   * 单 label 单索引，多字段合并（与 task_search / event_search 一致）。
   * 先按名字检查已存在索引的类型，若非 FULLTEXT 则先删除再重建（幂等迁移
   * 历史 TEXT 索引），随后创建/确认 FULLTEXT 索引（cjk 分析器，中文友好）。
   * 失败记录真实错误，不阻塞调用方。
   */
  async ensureIndexes(force = false): Promise<boolean> {
    const INDEX_NAME = 'experience_search';
    const INDEX_FIELDS = ['summary', 'context', 'title', 'detail'];
    try {
      // 已存在非 FULLTEXT 索引或 force 重建时 → 先删除再重建
      // 索引不存在时也创建（IF NOT EXISTS 幂等，但需要显式创建）
      let needRecreate = force;
      if (!force) {
        const rows = await this.adapter.query('SHOW INDEXES YIELD name, type');
        const existing = (rows ?? []).find((r: any) => (r as any).name === INDEX_NAME);
        if (!existing) {
          // 索引不存在 → 需要创建
          needRecreate = true;
        } else if (String((existing as any).type).toUpperCase() !== 'FULLTEXT') {
          // 存在但不是 FULLTEXT 类型 → 重建
          needRecreate = true;
        }
      }
      if (needRecreate) {
        try {
          await this.adapter.query(`DROP INDEX ${INDEX_NAME} IF EXISTS`);
        } catch { /* 删除失败不阻塞（可能已不存在/被占用） */ }
        await this.adapter.query(
          `CREATE FULLTEXT INDEX ${INDEX_NAME} IF NOT EXISTS FOR (e:${LABEL}) ON EACH [e.${INDEX_FIELDS.join(', e.')} ] OPTIONS { indexConfig: { "fulltext.analyzer": "cjk" } }`,
        );
      }
    } catch (idxErr) {
      const errMsg = idxErr instanceof Error ? idxErr.message : String(idxErr);
      if (!/already exists|IF NOT EXISTS/i.test(errMsg)) {
        (this.adapter as any)?.logger?.warn?.(
          '[ExperienceStorage] CREATE FULLTEXT INDEX failed',
          { index: INDEX_NAME, fields: INDEX_FIELDS, err: errMsg },
        );
      }
      return false;
    }
    return true;
  }

  /**
   * 探测全文索引是否真正可用。
   * 用一次最小的 queryNodes 调用验证每个索引：
   * - 索引缺失/损坏（queryNodes 报 "no such fulltext schema index"）→ 该请求抛错 → 判定不可用
   * - 索引健康 → 返回 0 行（无匹配），不抛错 → 判定可用
   * 这样心跳可以"只在真正坏了才重建"，避免每次连接都无条件 DROP+重建健康索引。
   * @returns 所有全文索引均可用
   */
  async checkFulltextIndexes(): Promise<boolean> {
    const names = ['experience_search'];
    for (const name of names) {
      try {
        // BUGFIX: Neo4j 的 db.index.fulltext.queryNodes 索引名必须是编译期「字符串字面量」。
        // 1) 不能用参数 $idx —— 传参一律抛 "Parameter ... not allowed for an index name"
        //    → 探测恒失败 → 心跳无限强制重建。
        // 2) 也不能用反引号 `name` —— 反引号是转义标识符（变量引用），此处会抛
        //    "Variable `xxx` not defined"，同样探测恒失败。
        // 正确写法是单引号字符串字面量 'xxx'。索引名是本模块内常量（无注入风险）。
        await this.adapter.query(
          `CALL db.index.fulltext.queryNodes('${name}', 'probe') YIELD node RETURN node LIMIT 1`,
        );
      } catch {
        return false; // 任一索引缺失/损坏 → 需要重建
      }
    }
    return true;
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
        // P3-4: 归一化 freeTags（去重 + trim + lowercase），防止碎片化
        props.tags_free = normalizeFreeTags(d.tags.freeTags).join(',') || '';
      }
    }
    await this.adapter.query(UPSERT_DISTILLED, { id: d.id, props });
  }

  /**
   * Query-aware 混合搜索（主召回路径）
   * 静态 relevanceScore (60%) + 动态 query 关键词匹配 (40%) + 标签过滤
   *
   * P1-3: 优先使用 Neo4j 全文索引查询（db.index.fulltext.queryNodes），
   * 若失败则降级到原 CONTAINS 全扫描路径。
   */
  async searchByQuery(options: ExperienceQueryOptions): Promise<ExperienceSearchResult[]> {
    const {
      query,
      scenarioTags = [],
      techStackTags = [],
      minScore = 0.6,
      limit = 5,
      halfLifeDays = 30,
    } = options;

    // 如果没有 query 且没有标签过滤，回退到按 relevanceScore 排序
    if (!query && scenarioTags.length === 0 && techStackTags.length === 0) {
      return this.searchRelevant(minScore, limit, halfLifeDays);
    }

    // P1-3: 有 query 关键词时，优先尝试全文索引查询路径
    if (query && query.trim().length > 0) {
      try {
        const ftResults = await this._searchByFulltextIndex(options, halfLifeDays);
        if (ftResults !== null) return ftResults;
      } catch {
        // 全文索引不可用（Neo4j 版本不支持或索引未创建），降级到 CONTAINS
      }
    }

    return this._searchByContains(options, halfLifeDays);
  }

  /**
   * P1-3: 使用 Neo4j 全文索引查询的搜索路径（O(log n)）。
   * 失败时返回 null，由调用方降级到 CONTAINS。
   */
  private async _searchByFulltextIndex(
    options: ExperienceQueryOptions,
    halfLifeDays: number,
  ): Promise<ExperienceSearchResult[] | null> {
    const {
      freeTags: queryFreeTags = [],
      query,
      scenarioTags = [],
      techStackTags = [],
      projects = [],
      minScore = 0.6,
      limit = 5,
    } = options;

    if (!query) return null;

    const hasFilters = scenarioTags.length > 0 || techStackTags.length > 0 || projects.length > 0;
    const projectFilter = projects.length > 0
      ? `\n           AND (size($projects) = 0 OR (e.projectName IS NOT NULL AND toLower(e.projectName) IN [p IN $projects | toLower(p)]))`
      : '';
    const filterClause = hasFilters ? `\n           ${SEARCH_QUERY_TAG_FILTER}` : '';

    // 使用全文索引查询节点，再应用过滤和排序
    const cypher = `CALL db.index.fulltext.queryNodes('experience_search', $queryKeyword) YIELD node AS e, score AS ftScore
         WHERE e:${LABEL}
           AND e.status = 'DISTILLED'
           AND (e.state IS NULL OR e.state <> 'superseded')
           AND e.relevanceScore >= $minScore
           AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())${projectFilter}${filterClause}
         WITH e, ftScore,
           (CASE WHEN size($queryFreeTags) > 0
             AND coalesce(e.tags_free, '') <> ''
             AND ANY(f IN split(coalesce(e.tags_free, ''), ',')
                WHERE toLower(f) IN [x IN $queryFreeTags | toLower(x)])
             THEN 0.3
             ELSE 0.0 END) AS tagMatch
         WITH e, ftScore, tagMatch,
           CASE WHEN e.lastRecalledAt IS NOT NULL
             THEN coalesce(e.matchCount, 0) * (0.5 ^ ((timestamp() - e.lastRecalledAt) / (1000.0 * 60 * 60 * 24 * $halfLifeDays)))
             ELSE coalesce(e.matchCount, 0) * 0.5
           END AS decayedMatchCount
         RETURN e.id AS id, e.title AS title, e.summary AS summary, e.detail AS detail,
                e.context AS context, e.relevanceScore AS relevanceScore, e.createdAt AS createdAt,
                e.matchCount AS matchCount, e.rawIds AS rawIds, e.type AS type,
                e.tags_scenario AS tags_scenario,
                e.tags_techStack AS tags_techStack, e.tags_severity AS tags_severity,
                e.tags_free AS tags_free,
                (ftScore + tagMatch) AS queryMatch
         ORDER BY (e.relevanceScore * 0.6) + ((ftScore + tagMatch) * 0.4) + (decayedMatchCount * 0.1) DESC
         LIMIT $limit`;

    const params: Record<string, unknown> = {
      minScore,
      queryKeyword: query,
      scenarioTags: scenarioTags.length > 0 ? scenarioTags : [],
      techStackTags: techStackTags.length > 0 ? techStackTags : [],
      queryFreeTags: queryFreeTags.length > 0 ? queryFreeTags : [],
      projects: projects.length > 0 ? projects : [],
      limit: Math.trunc(limit),
      halfLifeDays,
    };

    const runOnce = async (): Promise<ExperienceSearchResult[]> => {
      const rows = await this.adapter.query<ExperienceSearchRow>(cypher, params);
      return this._mapFulltextRows(rows);
    };

    try {
      return await runOnce();
    } catch (err) {
      // 查询时自愈：全文索引缺失/损坏（历史误建 TEXT 索引、初始化时 Neo4j 未就绪被吞、
      // FULLTEXT 索引损坏导致 queryNodes 报 "no such fulltext schema index"）。
      // 旧逻辑第一次失败后永久不再重试，损坏的 FULLTEXT 索引（SHOW 报 FULLTEXT 但
      // 实际不可用，IF NOT EXISTS 是空操作）一直修不好。现改为：按节流间隔强制
      // DROP+重建（force=true 保证按规范重建），再重试一次；成功立即恢复全文检索，
      // 失败则交回 searchByQuery 降级到 CONTAINS，下次查询在节流后可再次自愈。
      const now = Date.now();
      if (now - this._lastFtHealAt >= ExperienceStorage.FT_HEAL_THROTTLE_MS) {
        this._lastFtHealAt = now;
        try {
          await this.ensureIndexes(true);
          return await runOnce();
        } catch {
          // 索引确实无法创建（权限/版本），留待节流后再试；心跳也会持续补齐
          throw err;
        }
      }
      throw err;
    }
  }

  private _mapFulltextRows(rows: Record<string, unknown>[] | null | undefined): ExperienceSearchResult[] {
    return (rows || []).map((r: any) => ({
      experience: rowToDistilled(r),
      score: r.relevanceScore !== undefined
        ? Number(r.relevanceScore) * 0.6 + (Number(r.queryMatch) || 0) * 0.4
        : Number(r.relevanceScore),
    }));
  }

  /**
   * P1-3: 原 CONTAINS 全扫描搜索路径（降级方案）。
   */
  private async _searchByContains(
    options: ExperienceQueryOptions,
    halfLifeDays: number,
  ): Promise<ExperienceSearchResult[]> {
    const {
      freeTags: queryFreeTags = [],
      query,
      scenarioTags = [],
      techStackTags = [],
      projects = [],
      minScore = 0.6,
      limit = 5,
    } = options;

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
      halfLifeDays,
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
   * 搜索精炼经验（按 relevanceScore + decayedMatchCount 排序，legacy）
   * C-1: matchCount 引入时间衰减，防止正反馈循环。
   */
  async searchRelevant(
    minScore: number = 0.6,
    limit: number = 5,
    halfLifeDays: number = 30,
  ): Promise<ExperienceSearchResult[]> {
    const rows = await this.adapter.query<ExperienceSearchRow>(
      SEARCH_RELEVANT,
      { minScore, limit: Math.trunc(limit), halfLifeDays },
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
    // BUGFIX(P2-5): 先 LIMIT 取 top 候选再做 MERGE，避免大图中间结果集巨大
    // 候选池放大到 maxLinks*5，保证 ORDER BY 后仍有足够重叠项
    const candidateLimit = Math.max(maxLinks * 5, 15);
    const result = await this.adapter.query(
      `
        MATCH (e:${LABEL} { id: $id })
        MATCH (other:${LABEL})
        WHERE other.status = 'DISTILLED'
          AND other.id <> $id
          AND other.relatedConcepts IS NOT NULL
          AND size(other.relatedConcepts) > 0
        WITH e, other,
             [c IN [x IN split(toLower(other.relatedConcepts), ',') | trim(x)] WHERE c IN $concepts] AS overlap
        WHERE size(overlap) >= 1
        WITH e, other, size(overlap) AS overlapScore
        ORDER BY overlapScore DESC, other.relevanceScore DESC
        LIMIT $candidateLimit
        WITH e, other, overlapScore
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
        candidateLimit: Math.trunc(candidateLimit),
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
    // BUGFIX(P2-5): 先 LIMIT 候选池再 ORDER BY+LIMIT 最终结果，避免大图中间结果集巨大
    const candidateLimit = Math.max(maxResults * 5, 15);
    const result = await this.adapter.query<{ id: string }>(
      `
        MATCH (other:${LABEL})
        WHERE other.status = 'DISTILLED'
          AND other.id <> $id
          AND other.relatedConcepts IS NOT NULL
          AND size(other.relatedConcepts) > 0
        WITH other,
             [c IN [x IN split(toLower(other.relatedConcepts), ',') | trim(x)] WHERE c IN $concepts] AS overlap
        WHERE size(overlap) >= 1
        WITH other, size(overlap) AS overlapScore
        ORDER BY overlapScore DESC, other.relevanceScore DESC
        LIMIT $candidateLimit
        WITH other, overlapScore
        ORDER BY overlapScore DESC, other.relevanceScore DESC
        LIMIT $maxResults
        RETURN other.id AS id
      `,
      {
        id: experienceId,
        concepts: lowerConcepts,
        maxResults: Math.trunc(maxResults),
        candidateLimit: Math.trunc(candidateLimit),
      },
    );
    return (result || []).map((r: any) => r.id).filter(Boolean);
  }

  /**
   * 获取所有待蒸馏经验的原始记录（供 dreaming/cron 批量总结）。
   *
   * 重试机制：除 PENDING 节点外，也返回 FAILED 且 retryCount < maxRetries 的节点，
   * 让失败经验在后续蒸馏中自动重试。超过 maxRetries 的节点需手动 resetFailedToPending。
   *
   * @param maxRetries 最大自动重试次数（默认 3，可通过 LCMG_DISTILL_MAX_RETRIES 配置）
   */
  async fetchPending(limit: number = 200, maxRetries?: number): Promise<PendingRow[]> {
    const maxR = maxRetries ?? getDistillMaxRetries();
    const rows = await this.adapter.query<PendingRow>(
      FETCH_PENDING,
      { limit: Math.trunc(limit), maxRetries: Math.trunc(maxR) },
    );
    return (rows || []).map((r: any) => ({
      ...r,
      retryCount: typeof r.retryCount === 'number' ? r.retryCount : 0,
      status: r.status || 'PENDING',
      createdAt: new Date(r.createdAt),
    }));
  }

  /**
   * 诊断：统计各 status 的 EXPERIENCE 节点数量。
   * 返回如 { PENDING: 5, DISTILLED: 10, null: 3 }
   */
  async countByStatus(): Promise<Record<string, number>> {
    try {
      const rows = await this.adapter.query(COUNT_BY_STATUS, {});
      const result: Record<string, number> = {};
      for (const r of rows || []) {
        const statusVal = (r as any).status;
        const key: string = typeof statusVal === 'string' ? statusVal : '(null)';
        const cnt = (r as any).cnt as any;
        result[key] = typeof cnt?.toNumber === 'function' ? cnt.toNumber() : Number(cnt) || 0;
      }
      return result;
    } catch {
      return {};
    }
  }

  /** 诊断：统计 EXPERIENCE 节点总数 */
  async countAll(): Promise<number> {
    try {
      const rows = await this.adapter.query(COUNT_ALL, {});
      const total = (rows?.[0] as any)?.total as any;
      return typeof total?.toNumber === 'function' ? total.toNumber() : Number(total) || 0;
    } catch {
      return -1;
    }
  }

  /**
   * 删除经验（TTL 清理用，蒸馏成功后删除原 PENDING/FAILED 节点）
   */
  async deleteById(id: string): Promise<void> {
    await this.adapter.query(DELETE_BY_ID, { id });
  }

  /**
   * 标记蒸馏失败：status → FAILED，retryCount + 1，记录错误信息。
   * 节点不会被删除，下次 fetchPending 在 retryCount < maxRetries 时会自动重新拉取。
   *
   * @param id 经验节点 ID
   * @param error 失败原因（HTTP 错误 / 超时 / JSON 解析失败等）
   */
  async markFailed(id: string, error: string): Promise<void> {
    try {
      await this.adapter.query(MARK_FAILED, { id, error: String(error).slice(0, 500) });
    } catch {
      // markFailed 失败不应阻断蒸馏主流程，静默忽略
    }
  }

  /**
   * 重置 FAILED 节点回 PENDING，清零 retryCount，让其重新进入蒸馏队列。
   *
   * @param mode 'all' = 重置所有 FAILED 节点；'exhausted' = 仅重置 retryCount >= maxRetries 的节点
   * @param maxRetries 仅 mode='exhausted' 时使用
   * @returns 重置的节点数量
   */
  async resetFailedToPending(mode: 'all' | 'exhausted' = 'all', maxRetries?: number): Promise<number> {
    const maxR = maxRetries ?? getDistillMaxRetries();
    try {
      const rows = await this.adapter.query(
        RESET_FAILED_TO_PENDING,
        { mode, maxRetries: Math.trunc(maxR) },
      );
      const cnt = (rows?.[0] as any)?.reset;
      return typeof cnt?.toNumber === 'function' ? cnt.toNumber() : Number(cnt) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * 统计已耗尽重试次数的 FAILED 节点数量（retryCount >= maxRetries）。
   * 用于蒸馏报告展示"待手动重试"的数量。
   */
  async countFailedExhausted(maxRetries?: number): Promise<number> {
    const maxR = maxRetries ?? getDistillMaxRetries();
    try {
      const rows = await this.adapter.query(COUNT_FAILED_EXHAUSTED, { maxRetries: Math.trunc(maxR) });
      const cnt = (rows?.[0] as any)?.cnt;
      return typeof cnt?.toNumber === 'function' ? cnt.toNumber() : Number(cnt) || 0;
    } catch {
      return 0;
    }
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

  /**
   * H-6: 获取全局高频经验（用于会话启动预热）。
   * 按 matchCount 降序，不依赖 query 关键词。
   */
  async getTopExperiences(limit: number = 3): Promise<ExperienceSearchResult[]> {
    const rows = await this.adapter.query<ExperienceSearchRow>(`
      MATCH (e:${LABEL})
      WHERE e.status = 'DISTILLED'
        AND (e.state IS NULL OR e.state <> 'superseded')
        AND e.relevanceScore >= 0.6
        AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
      RETURN e.id AS id, e.title AS title, e.summary AS summary,
             e.detail AS detail, e.context AS context,
             e.relevanceScore AS relevanceScore, e.createdAt AS createdAt,
             e.matchCount AS matchCount, e.rawIds AS rawIds, e.type AS type,
             e.tags_scenario AS tags_scenario, e.tags_techStack AS tags_techStack,
             e.tags_severity AS tags_severity, e.tags_free AS tags_free
      ORDER BY e.matchCount DESC, e.relevanceScore DESC
      LIMIT ${Math.trunc(limit)}
    `);
    return (rows || []).map((r: any) => ({
      experience: rowToDistilled(r),
      score: r.relevanceScore,
    }));
  }

  /**
   * C-1: 批量衰减长期未被召回的 matchCount。
   * 对 lastRecalledAt 超过 staleThresholdDays 的经验，matchCount 衰减 50%。
   * 由 dreaming/cron 定期调用，避免 matchCount 无限累积。
   *
   * @param staleThresholdDays 超过此天数未召回，触发衰减
   * @param batchSize 每批处理数量
   * @returns 本批次衰减的节点数
   */
  async decayMatchCount(
    staleThresholdDays: number = 14,
    batchSize: number = 100,
  ): Promise<number> {
    const staleMs = staleThresholdDays * 24 * 60 * 60 * 1000;
    const result = await this.adapter.query(`
      MATCH (e:${LABEL})
      WHERE e.status = 'DISTILLED'
        AND e.lastRecalledAt IS NOT NULL
        AND e.lastRecalledAt < timestamp() - ${staleMs}
        AND e.matchCount > 0
      WITH e LIMIT ${Math.trunc(batchSize)}
      SET e.matchCount = round(e.matchCount * 0.5)
      RETURN count(e) AS decayed
    `);
    const row = result?.[0] as { decayed?: number } | undefined;
    return typeof row?.decayed === 'number' ? row.decayed : 0;
  }

  /**
   * P3-4: 获取所有去重后的 freeTags 及其出现次数。
   * 用于在 Dashboard 中展示标签碎片化情况，辅助用户进行标签合并决策。
   */
  async getAllFreeTags(): Promise<Array<{ tag: string; count: number }>> {
    const result = await this.adapter.query<{ tags_free: string }>(`
      MATCH (e:${LABEL})
      WHERE e.status = 'DISTILLED'
        AND e.tags_free IS NOT NULL
        AND e.tags_free <> ''
      RETURN e.tags_free AS tags_free
    `);
    if (!result || result.length === 0) return [];

    const countMap = new Map<string, number>();
    for (const r of result) {
      const tagsFree = (r as any).tags_free as string | undefined;
      const tags = (tagsFree || '').split(',').filter(Boolean);
      for (const t of tags) {
        const normalized = t.trim().toLowerCase();
        if (normalized) {
          countMap.set(normalized, (countMap.get(normalized) ?? 0) + 1);
        }
      }
    }
    return Array.from(countMap.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * P3-4: 合并 freeTags —— 将所有 EXPERIENCE 节点中的 fromTag 替换为 toTag。
   * 用于治理标签碎片化（如 "react"、"react.js"、"reactjs" 统一为 "react"）。
   *
   * @returns 受影响的节点数
   */
  async mergeFreeTags(fromTag: string, toTag: string): Promise<number> {
    const fromNorm = fromTag.trim().toLowerCase();
    const toNorm = toTag.trim().toLowerCase();
    if (!fromNorm || !toNorm || fromNorm === toNorm) return 0;

    const result = await this.adapter.query<{ affected: number }>(`
      MATCH (e:${LABEL})
      WHERE e.status = 'DISTILLED'
        AND e.tags_free IS NOT NULL
        AND e.tags_free <> ''
      WITH e,
           [t IN split(e.tags_free, ',') WHERE trim(toLower(t)) = $from] AS matched,
           [t IN split(e.tags_free, ',') WHERE trim(toLower(t)) <> $from] AS others
      WHERE size(matched) > 0
      SET e.tags_free = reduce(
        s = '', t IN (others + [$to]) | CASE WHEN s = '' THEN t ELSE s + ',' + t END
      )
      RETURN count(e) AS affected
    `, { from: fromNorm, to: toNorm });
    const row = (result?.[0] as { affected?: unknown } | undefined);
    const affected = typeof row?.affected === 'number' ? row.affected : 0;
    return affected;
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
  /** 重试次数（FAILED 节点被重新拉取时 > 0，PENDING 新节点为 0） */
  retryCount?: number;
  /** 节点当前状态（PENDING 或 FAILED） */
  status?: string;
}

/**
 * P3-4: 归一化 freeTags —— lowercase + trim + 去重，防止同义标签碎片化。
 * 如 ["React", "react", " React.js "] → ["react", "react.js"]
 */
export function normalizeFreeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const normalized = raw.trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * 获取蒸馏最大自动重试次数。
 * 默认 3 次，可通过环境变量 LCMG_DISTILL_MAX_RETRIES 配置（最小 1，最大 10）。
 */
function getDistillMaxRetries(): number {
  const raw = process.env.LCMG_DISTILL_MAX_RETRIES;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.min(Math.trunc(n), 10);
  }
  return 3;
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
