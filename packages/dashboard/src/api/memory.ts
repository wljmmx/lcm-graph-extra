/**
 * 记忆查询 API 封装 + 类型定义。
 *
 * 与后端 server/routes/memory.ts 的响应契约对齐。
 * 三引擎并行 + 独立降级：单引擎失败返回空数组 + error 字段，不阻塞其他引擎。
 */
import { apiGet } from './client';

export interface MemorySearchResult {
  source: 'lcm' | 'qmd' | 'neo4j';
  content: string;
  file?: string;
  sessionId?: string;
  type?: string;
  score?: number;
  pagerank?: number;
  timestamp?: number | string;
}

export interface MemorySearchResponse {
  results: {
    lcm: MemorySearchResult[];
    qmd: MemorySearchResult[];
    neo4j: MemorySearchResult[];
  };
  total: number;
  errors?: { lcm?: string; qmd?: string; neo4j?: string };
}

export interface MemoryGraphNode {
  id: string;
  name: string;
  type: string;
  pagerank: number;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface MemoryGraphResponse {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

/** 搜索引擎选择 */
export type MemoryEngine = 'all' | 'lcm_only' | 'qmd_only' | 'neo4j_only';

/** 跨引擎联合搜索 */
export function fetchMemorySearch(
  q: string,
  engines: string,
  limit: number,
): Promise<MemorySearchResponse> {
  const sp = new URLSearchParams();
  sp.set('q', q);
  sp.set('engines', engines);
  sp.set('limit', String(limit));
  return apiGet<MemorySearchResponse>(`/api/memory/search?${sp.toString()}`);
}

/** 图谱节点子集（供 ECharts Graph 浏览） */
export function fetchMemoryGraph(
  q: string,
  limit: number,
): Promise<MemoryGraphResponse> {
  const sp = new URLSearchParams();
  if (q) sp.set('q', q);
  sp.set('limit', String(limit));
  return apiGet<MemoryGraphResponse>(`/api/memory/graph?${sp.toString()}`);
}
