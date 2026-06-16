/**
 * Tag Registry — 动态标签注册表。
 *
 * 将硬编码的场景/技术栈标签改为从 Neo4j TAG_REGISTRY 节点加载。
 * 支持：
 * - 内置默认标签（首次使用或 registry 为空时的 fallback）
 * - 运行时新增标签（dreaming/cron 时自动写入）
 * - freeTags 计数追踪（用于升格判断）
 */

import type { DynamicTag, TagRegistryResult } from './types';

// ---------------------------------------------------------------------------
// 内置默认标签集（作为 registry 的初始值 / fallback）
// ---------------------------------------------------------------------------

const DEFAULT_TAGS: Omit<DynamicTag, 'createdAt'>[] = [
  // --- 场景类 ---
  { id: 'bug-fix', label: 'Bug修复', category: 'scenario', keywords: ['bug','fix','error','fail','崩溃','报错','异常','crash','segfault','panic'], confidence: 1.0, freeTagCount: 0 },
  { id: 'feature-dev', label: '功能开发', category: 'scenario', keywords: ['implement','feature','需求','实现','开发','新建','添加功能','新功能','新增'], confidence: 1.0, freeTagCount: 0 },
  { id: 'code-review', label: '代码审查', category: 'scenario', keywords: ['review','审查','评审','code review','pull request','PR'], confidence: 1.0, freeTagCount: 0 },
  { id: 'config-debug', label: '配置调试', category: 'scenario', keywords: ['config','配置','environment','env','环境变量','setting','setup','初始化','install'], confidence: 1.0, freeTagCount: 0 },
  { id: 'deployment', label: '部署发布', category: 'scenario', keywords: ['deploy','部署','publish','发布','上线','release','build server'], confidence: 1.0, freeTagCount: 0 },
  { id: 'performance-opt', label: '性能优化', category: 'scenario', keywords: ['slow','性能','latency','optimi','慢','卡顿','瓶颈','提速','优化','memory leak','cpu'], confidence: 1.0, freeTagCount: 0 },
  { id: 'security-audit', label: '安全审计', category: 'scenario', keywords: ['security','漏洞','权限','permission','auth','鉴权','安全','audit','injection'], confidence: 1.0, freeTagCount: 0 },
  { id: 'refactor', label: '代码重构', category: 'scenario', keywords: ['refactor','重构','清理','整理','代码质量','lint','format','dead code'], confidence: 1.0, freeTagCount: 0 },
  // --- 技术栈类 ---
  { id: 'frontend', label: '前端', category: 'techStack', keywords: ['react','vue','angular','frontend','前端','css','html','tailwind','sass','webpack','vite','umi','svelte'], confidence: 1.0, freeTagCount: 0 },
  { id: 'backend', label: '后端', category: 'techStack', keywords: ['node.js','python','java','backend','后端','api','service','express','fastify','django','spring','graphql','rest','go','rust'], confidence: 1.0, freeTagCount: 0 },
  { id: 'devops', label: '运维/DevOps', category: 'techStack', keywords: ['docker','k8s','kubernetes','nginx','ci-cd','pipeline','jenkins','github action','terraform','ansible','shell','bash','makefile','systemd'], confidence: 1.0, freeTagCount: 0 },
  { id: 'database', label: '数据库', category: 'techStack', keywords: ['sql','database','redis','mongo','mysql','postgres','pg','orm','prisma','sequelize','sqlite'], confidence: 1.0, freeTagCount: 0 },
  { id: 'mobile', label: '移动端', category: 'techStack', keywords: ['flutter','react native','swift','kotlin','ios','android','移动端','小程序'], confidence: 1.0, freeTagCount: 0 },
  { id: 'ai-ml', label: 'AI/ML', category: 'techStack', keywords: ['ai','ml','llm','embedding','transformer','模型','训练','推理','openai','ollama','rag'], confidence: 1.0, freeTagCount: 0 },
  { id: 'infrastructure', label: '基础设施', category: 'techStack', keywords: ['linux','server','network','ssl','dns','firewall','vm','cloud','aws','aliyun','tcp','udp'], confidence: 1.0, freeTagCount: 0 },
];

// ---------------------------------------------------------------------------
// Neo4j Cypher queries for TAG_REGISTRY
// ---------------------------------------------------------------------------

const LABEL = 'TAG_REGISTRY';

/** Upsert a single tag entry */
const UPSERT_TAG = `
  MERGE (t:${LABEL} {id: $tagId})
  SET t += $props,
      t.updatedAt = timestamp()
`;

/** Delete a tag entry */
const DELETE_TAG = `
  MATCH (t:${LABEL} {id: $tagId})
  DELETE t
`;

/** Load all tags from registry */
const LOAD_ALL_TAGS = `
  MATCH (t:${LABEL})
  RETURN t.id AS id,
         t.label AS label,
         t.category AS category,
         t.keywords AS keywords,
         t.confidence AS confidence,
         t.freeTagCount AS freeTagCount,
         t.createdAt AS createdAt
  ORDER BY t.category ASC, t.confidence DESC, t.id ASC
`;

/** Increment freeTagCount for a tag */
const INCREMENT_FREE_COUNT = `
  MERGE (t:${LABEL} {id: $tagId})
  ON CREATE SET t += $props, t.createdAt = timestamp(), t.updatedAt = timestamp()
  ON MATCH SET t.freeTagCount = coalesce(t.freeTagCount, 0) + 1, t.updatedAt = timestamp()
`;

// ---------------------------------------------------------------------------
// Tag Registry class
// ---------------------------------------------------------------------------

interface Neo4jAdapter {
  query<T = any>(cypher: string, params: Record<string, unknown>): Promise<T[]>;
}

export class TagRegistry {
  private adapter: Neo4jAdapter;
  private _cache: DynamicTag[] | null = null;
  private _patternsCache: Array<{ pattern: RegExp; tagId: string; tagLabel: string }> | null = null;

  constructor(adapter: Neo4jAdapter) {
    this.adapter = adapter;
  }

  /**
   * 从 Neo4j 加载所有标签。如果为空，使用内置默认集初始化。
   */
  async load(): Promise<DynamicTag[]> {
    try {
      const rows = await this.adapter.query<{
        id: string; label: string; category: string; keywords: string;
        confidence: number; freeTagCount: number; createdAt: number;
      }>(LOAD_ALL_TAGS, {});

      if (rows && rows.length > 0) {
        this._cache = rows.map((r) => ({
          id: r.id,
          label: r.label,
          category: r.category as 'scenario' | 'techStack',
          keywords: (r.keywords || '').split(',').filter(Boolean),
          confidence: r.confidence ?? 0.5,
          freeTagCount: r.freeTagCount ?? 0,
          createdAt: new Date(r.createdAt),
        }));
      } else {
        await this.seedDefaults();
        this._cache = DEFAULT_TAGS.map((t) => ({ ...t, createdAt: new Date() }));
      }

      this._patternsCache = null;
      return this._cache!;
    } catch {
      this._cache = DEFAULT_TAGS.map((t) => ({ ...t, createdAt: new Date() }));
      this._patternsCache = null;
      return this._cache!;
    }
  }

  /** 用内置默认集初始化 registry */
  private async seedDefaults(): Promise<void> {
    for (const tag of DEFAULT_TAGS) {
      const props: Record<string, unknown> = {
        label: tag.label,
        category: tag.category,
        keywords: tag.keywords.join(','),
        confidence: tag.confidence,
        freeTagCount: 0,
      };
      await this.adapter.query(UPSERT_TAG, { tagId: tag.id, props }).catch(() => {});
    }
  }

  async upsertTag(tag: Omit<DynamicTag, 'createdAt'>): Promise<void> {
    const props: Record<string, unknown> = {
      label: tag.label,
      category: tag.category,
      keywords: tag.keywords.join(','),
      confidence: tag.confidence,
      freeTagCount: tag.freeTagCount || 0,
    };
    await this.adapter.query(UPSERT_TAG, { tagId: tag.id, props });
    this._cache = null;
    this._patternsCache = null;
  }

  async deleteTag(id: string): Promise<void> {
    await this.adapter.query(DELETE_TAG, { tagId: id });
    this._cache = null;
    this._patternsCache = null;
  }

  async incrementFreeCount(tagId: string): Promise<void> {
    const existing = this._cache?.find((t) => t.id === tagId);
    const props: Record<string, unknown> = {};
    if (!existing) {
      props.label = tagId;
      props.category = 'scenario';
      props.keywords = tagId;
      props.confidence = 0.3;
    }
    await this.adapter.query(INCREMENT_FREE_COUNT, { tagId, props });
  }

  get tags(): DynamicTag[] {
    return this._cache ?? DEFAULT_TAGS.map((t) => ({ ...t, createdAt: new Date() }));
  }

  buildPatterns(): Array<{ pattern: RegExp; tagId: string; tagLabel: string }> {
    if (this._patternsCache) return this._patternsCache;

    const patterns: Array<{ pattern: RegExp; tagId: string; tagLabel: string }> = [];
    for (const tag of this.tags) {
      if (!tag.keywords.length) continue;
      const escaped = tag.keywords.map((k) =>
        k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'),
      );
      const regexStr = escaped.join('|');
      try {
        patterns.push({
          pattern: new RegExp(regexStr, 'i'),
          tagId: tag.id,
          tagLabel: tag.label,
        });
      } catch { /* Invalid regex, skip */ }
    }

    this._patternsCache = patterns;
    return patterns;
  }

  filterByCategory(category: 'scenario' | 'techStack'): DynamicTag[] {
    return this.tags.filter((t) => t.category === category);
  }

  toRegistryResult(): TagRegistryResult {
    const scenarioTags = this.filterByCategory('scenario');
    const techStackTags = this.filterByCategory('techStack');

    return {
      tags: this.tags,
      scenarioPatterns: this.buildPatterns().filter((p) =>
        scenarioTags.some((t) => t.id === p.tagId),
      ).map((p) => ({ pattern: p.pattern, tag: p.tagId })),
      techStackPatterns: this.buildPatterns().filter((p) =>
        techStackTags.some((t) => t.id === p.tagId),
      ).map((p) => ({ pattern: p.pattern, tag: p.tagId })),
    };
  }
}