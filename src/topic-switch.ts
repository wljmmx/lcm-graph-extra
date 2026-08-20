/**
 * 话题切换检测 — 纯函数模块
 *
 * 问题背景（2026-08-18 上下文压缩调度核查）：
 *   检索层缓存与压测统计按 sessionKey 隔离，但 sessionKey 跨轮次恒定时，
 *   话题一旦切换，旧话题的预取结果/压测统计/场景分类仍会被复用，
 *   导致上下文注入的内容与当前话题无关。
 *
 * 本模块提供两个纯函数：
 *   1. detectTopicSwitch() — 判定上一轮查询与本轮查询是否构成话题切换
 *   2. topicOverlapScore() — 计算两个查询的主题重叠度（0~1）
 *
 * 阈值说明：
 *   - OVERLAP_CLEAR_SWITCH  < 0.10：零重叠，明确切换（清零缓存）
 *   - OVERLAP_WEAK_KEEP     < 0.30：弱重叠，保守处理（仅不消费预取）
 */

/** 归一化文本：小写 + 去标点 + 去空白 */
export function normalizeQuery(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 分词：拉丁/空格词 + CJK 二元组 */
function tokenize(s: string): Set<string> {
  const norm = normalizeQuery(s);
  if (!norm) return new Set();
  const out = new Set<string>();
  // 拉丁/空格词
  for (const w of norm.split(' ')) {
    if (/^[a-z0-9_-]+$/.test(w) && w.length >= 2) out.add(w);
  }
  // CJK 二元组（2-4 字中文片段）
  const cjk = norm.match(/[\u4e00-\u9fff]{2,}/g);
  if (cjk) {
    for (const seg of cjk) {
      for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
    }
  }
  return out;
}

/**
 * 主题重叠度（0~1，Jaccard）
 */
export function topicOverlapScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size + B.size - inter, 1);
}

/** 明确话题切换阈值（零重叠） */
export const OVERLAP_CLEAR_SWITCH = 0.10;
/** 弱重叠阈值（保守处理） */
export const OVERLAP_WEAK_KEEP = 0.30;

export interface TopicSwitchResult {
  /** 是否构成话题切换（overlap < OVERLAP_CLEAR_SWITCH） */
  switched: boolean;
  /** 是否弱重叠（OVERLAP_CLEAR_SWITCH <= overlap < OVERLAP_WEAK_KEEP） */
  weak: boolean;
  /** 重叠度 0~1 */
  overlap: number;
  /** 上一轮查询（截断展示用） */
  prevQuery: string;
  /** 当前查询（截断展示用） */
  currentQuery: string;
}

/**
 * 判定是否发生话题切换。
 * @param prevQuery 上一轮检索查询（prefetch cache 或上一轮 qmdQuery）
 * @param currentQuery 本轮检索查询
 */
export function detectTopicSwitch(prevQuery: string, currentQuery: string): TopicSwitchResult {
  const overlap = topicOverlapScore(prevQuery, currentQuery);
  return {
    switched: overlap < OVERLAP_CLEAR_SWITCH,
    weak: overlap >= OVERLAP_CLEAR_SWITCH && overlap < OVERLAP_WEAK_KEEP,
    overlap,
    prevQuery: (prevQuery || '').slice(0, 80),
    currentQuery: (currentQuery || '').slice(0, 80),
  };
}
