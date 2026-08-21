/**
 * entity-extract.ts 单测。
 *
 * 覆盖 BUG-AUDIT 2026-08-21：
 * 旧中文分词用 `[一-鿿]{2,4}` 取非重叠 2-4 字窗口，把"实体过滤规则"切成
 * "一下实体 / 过滤规则 / 是否完善"等无效片段，检索内容几乎不含这些字面串，
 * 导致中文检索结果在 Phase 1 实体过滤时被全部清空 → P0-7 频繁回退到原始候选。
 * 改为滑动 2 字 bigram 后，保留"实体/过滤/规则"等真实子词，可正确命中。
 */
import { describe, it, expect } from 'vitest';
import { extractEntities, matchEntityScore } from './entity-extract.js';

describe('extractEntities — 中文分词', () => {
  it('用滑动 bigram 保留可匹配的子词，而非任意非重叠窗口', () => {
    const e = extractEntities('帮我核实一下实体过滤规则是否完善');
    // 关键：包含真正可命中的子词
    expect(e.terms).toContain('实体');
    expect(e.terms).toContain('过滤');
    expect(e.terms).toContain('规则');
    expect(e.terms).toContain('完善');
  });

  it('过滤掉常见虚词/助词 gram，避免噪音', () => {
    const e = extractEntities('请帮我核实一下实体过滤规则');
    expect(e.terms).not.toContain('帮我');
    expect(e.terms).not.toContain('一下');
  });

  it('英文查询提取技术术语与 token', () => {
    const e = extractEntities('how to configure neo4j cache pipeline');
    expect(e.techTerms).toContain('neo4j');
    expect(e.tokens.length).toBeGreaterThan(0);
  });

  it('过短查询返回空实体', () => {
    const e = extractEntities('ab');
    expect(e.tokens).toHaveLength(0);
    expect(e.terms).toHaveLength(0);
  });
});

describe('matchEntityScore — 中文匹配', () => {
  // 回归：旧实现下该内容分数为 0（被过滤），新实现应命中
  it('内容含查询真实子词（实体/过滤）时匹配通过（旧实现误判为不匹配）', () => {
    const e = extractEntities('帮我核实一下实体过滤规则是否完善');
    const { match, score } = matchEntityScore('实体过滤层会根据实体匹配度过滤无关的检索结果', e);
    expect(match).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0.15);
  });

  it('主题无关的中文内容不误匹配', () => {
    const e = extractEntities('实体过滤规则是否完善');
    const { match } = matchEntityScore('今天天气很好，适合出门散步', e);
    expect(match).toBe(false);
  });

  it('英文技术术语命中即匹配', () => {
    const e = extractEntities('neo4j cache pipeline');
    const { match } = matchEntityScore('Optimizing neo4j cache pipeline throughput', e);
    expect(match).toBe(true);
  });

  it('实体为空时始终匹配（不设门禁）', () => {
    const empty = { terms: [], properNouns: [], techTerms: [], tokens: [] };
    const { match } = matchEntityScore('任意内容', empty);
    expect(match).toBe(true);
  });
});

describe('matchEntityScore — 复用去重相似度的实体名模糊判断', () => {
  // query 的术语子串在正文中打不中，但结果的结构化实体名与 query 术语近似时，
  // 复用 entityNameSimilarity 应能命中（如"实体筛选" vs "实体过滤"）
  it('传入近似实体名时，字面不一致也能命中（复用模糊相似度）', () => {
    const e = extractEntities('实体过滤');
    const content = '一段与字面完全不一致的正文叙述';
    // 不传 entityName：子串匹配不到 → 不匹配
    expect(matchEntityScore(content, e).match).toBe(false);
    // 传近似实体名 '实体筛选'：相似度 0.5 过阈值 → 命中
    const r = matchEntityScore(content, e, '实体筛选');
    expect(r.match).toBe(true);
    expect(r.matchedTerms).toContain('实体');
  });

  it('不相关实体名不触发模糊命中', () => {
    const e = extractEntities('实体过滤');
    const { match } = matchEntityScore('无关的正文叙述', e, '天气与出行');
    expect(match).toBe(false);
  });

  it('完全相同的实体名必然命中', () => {
    const e = extractEntities('实体过滤');
    const { match } = matchEntityScore('正文完全不包含查询词', e, '实体过滤');
    expect(match).toBe(true);
  });
});