/**
 * Harnessing 路由（Harness² 吸收：演进历史视图数据源）。
 *
 * 端点：
 * - GET /api/harnessing/summary —— 聚合三路数据：
 *     1. live：插件 /internal/snapshot 的 harnessing 段（信号池 + 最近自动观察步，内存态）
 *     2. history：Neo4j 中带 evidence 的 EXPERIENCE 节点（harnessing 采纳沉淀的教训，持久态）
 *     3. stats：按作用域 / 组件聚合
 *
 * 降级策略：live 与 history 任一失败不互相影响，各自带 error 字段返回。
 */

import type { FastifyInstance } from 'fastify';
import { fetchPluginSnapshot } from '../lib/snapshot';
import { runReadQuery } from '../lib/neo4j';

/** 演进历史条目（Neo4j evidence 经验） */
export interface HarnessingHistoryItem {
  id: string;
  title: string;
  summary: string;
  scope: string;
  component: string;
  evidence: {
    probeId?: string;
    baseline?: number;
    candidate?: number;
    contrast?: number;
    trajectoryRef?: string;
    adoptedAt?: string;
  };
  createdAt: number | null;
}

export interface HarnessingSummaryResponse {
  live: {
    enabled?: boolean;
    autoEnabled?: boolean;
    signals?: { count: number; totalOccurrences: number; byKind: Record<string, number>; bySource: Record<string, number> };
    lastAutoStep?: Record<string, unknown> | null;
  } | null;
  liveError?: string;
  history: HarnessingHistoryItem[];
  stats: { total: number; byScope: Record<string, number>; byComponent: Record<string, number> };
  historyError?: string;
  fetchedAt: number;
}

/** 从 tags_free（'harnessing,<component>,<scope>'）提取组件名 */
function extractComponent(tagsFree: unknown): string {
  if (typeof tagsFree !== 'string') return 'unknown';
  const parts = tagsFree.split(',').map((s) => s.trim()).filter(Boolean);
  return parts[1] ?? 'unknown';
}

function parseEvidence(raw: unknown): HarnessingHistoryItem['evidence'] {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function registerHarnessingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/harnessing/summary', async (): Promise<HarnessingSummaryResponse> => {
    // 1. live：插件 snapshot（内存态；插件未响应时降级为 null）
    let live: HarnessingSummaryResponse['live'] = null;
    let liveError: string | undefined;
    try {
      const snap = await fetchPluginSnapshot();
      if (snap && typeof snap === 'object' && 'harnessing' in snap) {
        live = (snap as any).harnessing ?? null;
      } else {
        liveError = 'plugin snapshot has no harnessing section (plugin version too old?)';
      }
    } catch (e: any) {
      liveError = e?.message ?? String(e);
    }

    // 2. history：带 evidence 的经验（harnessing 采纳沉淀，持久态）
    const history: HarnessingHistoryItem[] = [];
    const stats = { total: 0, byScope: {} as Record<string, number>, byComponent: {} as Record<string, number> };
    let historyError: string | undefined;
    try {
      const result = await runReadQuery(
        `MATCH (e:EXPERIENCE)
         WHERE e.evidence IS NOT NULL AND e.evidence <> ''
         RETURN e.id AS id, e.title AS title, e.summary AS summary, e.scope AS scope,
                e.evidence AS evidence, e.tags_free AS tagsFree, e.createdAt AS createdAt
         ORDER BY e.createdAt DESC LIMIT 100`,
      );
      for (const record of result.records) {
        const row = (record as any).toObject ? (record as any).toObject() : record;
        const createdAtRaw = row.createdAt;
        const createdAt = typeof createdAtRaw?.toNumber === 'function'
          ? createdAtRaw.toNumber()
          : (typeof createdAtRaw === 'number' ? createdAtRaw : null);
        const scope = row.scope === 'domain' ? 'domain' : 'invariant';
        const component = extractComponent(row.tagsFree);
        history.push({
          id: String(row.id ?? ''),
          title: String(row.title ?? ''),
          summary: String(row.summary ?? ''),
          scope,
          component,
          evidence: parseEvidence(row.evidence),
          createdAt,
        });
        stats.total++;
        stats.byScope[scope] = (stats.byScope[scope] ?? 0) + 1;
        stats.byComponent[component] = (stats.byComponent[component] ?? 0) + 1;
      }
    } catch (e: any) {
      historyError = e?.message ?? String(e);
    }

    return { live, liveError, history, stats, historyError, fetchedAt: Date.now() };
  });
}
