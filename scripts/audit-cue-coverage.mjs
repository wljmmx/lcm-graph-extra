#!/usr/bin/env node
/**
 * 关联盲区审计（只读）—— 量化"现有检索对无字面重叠查询的可达性"。
 *
 * 背景
 * ────
 * 腾讯 T-Mem（EMNLP 2026，arxiv 2606.15405）指出：现有长期记忆方案的检索被
 * "查询与存储内容的相似度"锁死（reachability-bounded）。相似度只能沿词面/语义距离
 * 收敛，因此"查询与记忆无任何表面重叠、只靠潜在语义弧相连"的一类（它称为
 * associative recall）是结构性盲区。
 *
 * 它给出的解法是把努力从检索时挪到写入时：为每条记忆预生成 trigger 作为桥接。
 *
 * 本脚本不实现 trigger，只回答一个先决问题：
 *   **本项目现在到底有多大的盲区？值不值得投入？**
 *
 * 度量方式（确定性、无需 LLM）
 * ──────────────────────────
 * 对每条 DISTILLED 经验 E，构造三个查询变体，用**与生产完全同口径**的全文检索
 * （db.index.fulltext.queryNodes('experience_search')，同 WHERE/同打分/同 LIMIT）
 * 判断 E 能否被召回：
 *
 *   1) literal  = title + context          —— 描述性基线（用户复述该经验）
 *   2) anchor   = tags_* + relatedConcepts —— 现有"语义锚"层（等价 T-Mem 的 QI）
 *   3) disjoint = anchor 中去掉与 E 自身措辞重叠的片段 —— 模拟"与记忆无表面重叠的查询"
 *
 * 分类（核心产出）
 *   区分"结构性无信号"与"盲区"，这两者修复成本完全不同：
 *
 *   ├─ NO_INDEPENDENT_SIGNAL  3) 去重叠后**没有任何剩余线索**（anchor 为空或全是复述）
 *   │                         → 任何检索机制都无能为力；必须先"补线索"（T-Mem trigger 的用武之地）
 *   ├─ BLIND_SPOT             1) 能召回、3) 召回不到
 *   │                         → 有潜在线索但现有机制接不上（同样是 trigger 的目标人群）
 *   ├─ REACHABLE_BOTH         1) 与 3) 都能召回
 *   │                         → 现有 tag/全文层已覆盖，无需 trigger
 *   └─ UNREACHABLE_LITERAL    连 1) 都召回不到
 *                             → 与关联无关的另一类问题（索引/阈值/质量），不计入盲区
 *
 * 可选 --embed：对每条 E 计算 cosine(embed(E 事实文本), embed(disjoint 查询))，
 * 报出分布与"过 T-Mem 硬门 0.85"的比例 —— 即"若真有字面无关查询进来，
 * 现有向量层能否自己够到"。这一路需要可达的 embedding 端点（不可达则如实跳过）。
 *
 * 安全边界
 * ────────
 *   - 只读：Neo4j 会话声明 READ 访问模式，只发 MATCH/RETURN 与只读存储过程；
 *     无 CREATE/MERGE/SET/DELETE，不改任何配置与文件。
 *   - 不写缓存、不落盘（除非显式 --json 输出到 stdout）。
 *   - 连不上 Neo4j / 无驱动时**明确报错退出**，不静默返回 0（避免"看着像没盲区"）。
 *
 * 用法
 * ────
 *   node scripts/audit-cue-coverage.mjs                 # 真实审计（需 Neo4j 可达）
 *   node scripts/audit-cue-coverage.mjs --limit 300 --topk 5
 *   node scripts/audit-cue-coverage.mjs --embed         # 附加向量层可达性
 *   node scripts/audit-cue-coverage.mjs --json          # 机器可读输出
 *   node scripts/audit-cue-coverage.mjs --selftest      # 逻辑自检（无需数据库，验证分类器正确）
 *   node scripts/audit-cue-coverage.mjs --fixture f.json
 *   node scripts/audit-cue-coverage.mjs --tag-channel   # disjoint 改查 experience_tags_search（Phase 1 模拟）
 *
 * 环境变量：NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD（缺省回退 ~/.openclaw/openclaw.json）
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// 配置解析（镜像 src/config/neo4j-helper.ts 的优先级，避免与生产取到不同库）
// ─────────────────────────────────────────────────────────────────────────────

/** 片段级重叠判定阈值：某片段与事实文本的 token 重叠 ≥ 该值即视为"复述"，从 disjoint 中剔除 */
const RESTATEMENT_OVERLAP = 0.5;
/** T-Mem 的硬门（用于 --embed 的可达性判据） */
const TMEM_GATE = 0.85;
const LABEL = 'EXPERIENCE';

function loadEntriesNeo4j() {
  try {
    const p = `${homedir()}/.openclaw/openclaw.json`;
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const entries = data?.plugins?.entries || data?.entries || {};
    const n = entries['lcm-graph-extra']?.config?.neo4j;
    return n && typeof n === 'object' ? n : null;
  } catch {
    return null; // 解析失败 → 交回 env/默认值
  }
}

function loadEntriesEmbedding() {
  try {
    const p = `${homedir()}/.openclaw/openclaw.json`;
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const entries = data?.plugins?.entries || data?.entries || {};
    const e = entries['lcm-graph-extra']?.config?.embedding;
    return e && typeof e === 'object' ? e : null;
  } catch {
    return null;
  }
}

function resolveNeo4j() {
  const e = loadEntriesNeo4j();
  return {
    uri: process.env.NEO4J_URI || e?.uri || 'bolt://localhost:7687',
    user: process.env.NEO4J_USER || e?.user || 'neo4j',
    password: process.env.NEO4J_PASSWORD || e?.password || '',
  };
}

function resolveEmbedding() {
  const e = loadEntriesEmbedding();
  return {
    baseURL: process.env.GM_EMBED_BASE_URL || e?.baseURL || '',
    model: process.env.GM_EMBED_MODEL || e?.model || '',
    apiKey: process.env.GM_EMBED_API_KEY || e?.apiKey || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数层（可用 --selftest 独立验证，不依赖数据库）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取 token 集合：ASCII 词 + CJK 二元组。
 * 中文无空格，按词切不可靠 → 用 2-gram 近似"字面重叠"，对"是否复述"这一判定足够。
 */
export function tokens(s) {
  const out = new Set();
  const lower = String(s ?? '').toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) out.add(m[0]);
  const cjkOnly = lower.replace(/[^\u4e00-\u9fff\u3400-\u4dbf]+/g, ' ');
  for (const seg of cjkOnly.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) { out.add(seg); continue; }
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

/** 把 tag/concept 串拆成片段（,,，、;；/ 与空白均为分隔符）。
 *
 * 过滤"噪声残留"（v2）：context 被粗切后会产生 `记录:`、`失败:`、`修复通过:`、
 * `"bridgeDispatchS` 这类无意义片段——它们让 disjoint 查询比真实用户查询更"碎"，
 * 会略微高估盲区。过滤规则：
 *   - 长度 < 2
 *   - 以 `:` 或 `：` 结尾（未完的标签/状态词残留）
 *   - 不含任何 CJK / 字母 / 数字（纯标点）
 * 引号类字符也加入分隔符集合（消除 `\"` 转义残留）。 */
export function splitChunks(s) {
  return String(s ?? '')
    .split(/[,，、;；/\\\s"'`]+/)
    .map((x) => x.trim())
    .filter((x) => {
      if (!x) return false;
      if (x.length < 2) return false;
      if (/[:：]$/.test(x)) return false; // 残留片段，如 "记录:" / "失败:"
      if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(x)) return false; // 纯标点
      return true;
    });
}

/** 片段相对事实文本的字面重叠比例（0~1） */
export function overlapRatio(chunk, factTokens) {
  const t = tokens(chunk);
  if (t.size === 0) return 1; // 无有效 token → 视为不携带独立信息
  let hit = 0;
  for (const x of t) if (factTokens.has(x)) hit += 1;
  return hit / t.size;
}

/**
 * 构造查询变体。**纯函数**，是分类结论的唯一来源。
 *
 * @returns {{literal:string, anchor:string, disjoint:string, dropped:string[], kept:string[]}}
 */
export function buildVariants(node) {
  const factText = [node.title, node.summary, node.detail].filter(Boolean).join(' ');
  const factTokens = tokens(factText);

  const literal = [node.title, node.context].filter(Boolean).join(' ').trim();
  const anchor = [
    node.tags_scenario, node.tags_techStack, node.tags_free, node.relatedConcepts,
  ].filter(Boolean).join(',');

  const chunks = splitChunks([anchor, node.context].filter(Boolean).join(','));
  const kept = [];
  const dropped = [];
  for (const c of chunks) {
    if (overlapRatio(c, factTokens) >= RESTATEMENT_OVERLAP) dropped.push(c);
    else kept.push(c);
  }
  return { literal, anchor, disjoint: kept.join(','), dropped, kept };
}

/** 分类：把"能否召回"三态映射到互斥类别 */
export function classify({ inLiteral, inDisjoint, disjointEmpty }) {
  // 结构性无信号优先：没有任何非字面线索可用，谈不上"检索能不能接上"
  if (disjointEmpty) return 'NO_INDEPENDENT_SIGNAL';
  if (!inLiteral) return 'UNREACHABLE_LITERAL';
  return inDisjoint ? 'REACHABLE_BOTH' : 'BLIND_SPOT';
}

/** 汇总统计 */
export function summarize(rows) {
  const order = ['NO_INDEPENDENT_SIGNAL', 'BLIND_SPOT', 'REACHABLE_BOTH', 'UNREACHABLE_LITERAL'];
  const counts = Object.fromEntries(order.map((k) => [k, 0]));
  for (const r of rows) counts[r.category] += 1;
  const n = rows.length;
  return {
    n,
    counts,
    pct: Object.fromEntries(order.map((k) => [k, n ? Number(((counts[k] / n) * 100).toFixed(1)) : 0])),
    // 盲区总量 = 需要"补线索"或"接上线索"的人群
    gap: counts.NO_INDEPENDENT_SIGNAL + counts.BLIND_SPOT,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Neo4j 访问（只读）
// ─────────────────────────────────────────────────────────────────────────────

async function withNeo4jRead(fn) {
  let neo4j;
  try {
    neo4j = require('neo4j-driver');
  } catch {
    throw new Error(
      'neo4j-driver 不可用（未安装）。请在项目根目录执行 npm ci 后重试；'
      + '或先用 --selftest 验证脚本逻辑。',
    );
  }
  const { uri, user, password } = resolveNeo4j();
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  // READ 访问模式：即便脚本被误改，服务端也会拒绝写操作
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  // 注入整数构造器：所有 LIMIT/halfLifeDays 参数经 neo4j.int() 发送，杜绝 FLOAT 类型错误
  _intFn = neo4j.int;
  try {
    await driver.verifyConnectivity();
    return await fn(session, neo4j);
  } finally {
    try { await session.close(); } catch { /* ignore */ }
    try { await driver.close(); } catch { /* ignore */ }
  }
}

/** 取样本节点（只读）。--sample recent 取最近，rand 为确定性抽样之外的随机抽样 */
async function fetchNodes(session, limit, sample) {
  const order = sample === 'recent' ? 'e.createdAt DESC' : 'rand()';
  const res = await session.run(
    `MATCH (e:${LABEL})
     WHERE e.status = 'DISTILLED'
       AND (e.state IS NULL OR e.state <> 'superseded')
       AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
     RETURN e.id AS id, e.title AS title, e.summary AS summary, e.detail AS detail,
            e.context AS context, e.relatedConcepts AS relatedConcepts,
            e.tags_scenario AS tags_scenario, e.tags_techStack AS tags_techStack,
            e.tags_free AS tags_free, e.relevanceScore AS relevanceScore
     ORDER BY ${order} LIMIT $limit`,
    { limit: neo4jInteger(limit) },
  );
  return res.records.map((r) => ({
    id: String(r.get('id') ?? ''),
    title: str(r.get('title')),
    summary: str(r.get('summary')),
    detail: str(r.get('detail')),
    context: str(r.get('context')),
    relatedConcepts: str(r.get('relatedConcepts')),
    tags_scenario: str(r.get('tags_scenario')),
    tags_techStack: str(r.get('tags_techStack')),
    tags_free: str(r.get('tags_free')),
    relevanceScore: num(r.get('relevanceScore')),
  }));
}

/**
 * Lucene 查询转义：转义 queryparser 特殊字符，防止 ParseException。
 *
 * 为什么必要：审计查询是把 title/context/tags 字段**原样**拼接的，天然含
 * `( ) : - "` 等字符——这些在 Lucene 语法里是操作符/语法结构。直接传给
 * `db.index.fulltext.queryNodes` 会抛
 * `ParseException: Encountered "<EOF>" ... Was expecting <BAREOPER> ...`。
 * 生产路径传的是用户自然语言查询，很少踩；审计拼接字段必然踩。
 * 转义后特殊字符按字面处理，空格仍保留为词间分隔（不改变 OR 语义）。
 */
function escapeLucene(s) {
  return String(s).replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
}

/**
 * 用**与生产同口径**的全文检索判断目标节点能否进入 top-K。
 * 打分/过滤/排序表达式逐字对齐 src/experience/storage.ts `_searchByFulltextIndex`。
 * 仅有的差异：queryKeyword 先做 Lucene 转义（上面 escapeLucene），防止字段里的
 * 特殊字符被 queryparser 当语法解析而抛异常。
 *
 * @param indexName 全文索引名。默认 'experience_search'（现状主索引）；
 *   传 'experience_tags_search' 即 Phase 1 的 tag 关联通道（见 --tag-channel）。
 */
async function retrieves(session, query, targetId, topK, indexName = 'experience_search') {
  if (!query || !query.trim()) return false;
  const res = await session.run(
    `CALL db.index.fulltext.queryNodes('${indexName}', $queryKeyword) YIELD node AS e, score AS ftScore
     WHERE e:${LABEL}
       AND e.status = 'DISTILLED'
       AND (e.state IS NULL OR e.state <> 'superseded')
       AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())
     WITH e, ftScore
     WITH e, ftScore,
       CASE WHEN e.lastRecalledAt IS NOT NULL
         THEN coalesce(e.matchCount, 0) * (0.5 ^ ((timestamp() - e.lastRecalledAt) / (1000.0 * 60 * 60 * 24 * $halfLifeDays)))
         ELSE coalesce(e.matchCount, 0) * 0.5
       END AS decayedMatchCount
     RETURN e.id AS id
     ORDER BY (coalesce(e.relevanceScore, 0) * 0.6) + (ftScore * 0.4) + (decayedMatchCount * 0.1) DESC
     LIMIT $limit`,
    { queryKeyword: escapeLucene(query), halfLifeDays: neo4jInteger(30), limit: neo4jInteger(topK) },
  );
  return res.records.some((r) => String(r.get('id') ?? '') === targetId);
}

/** 小工具：避免把 neo4j 类型细节散落到调用点 */
function str(v) { return v == null ? '' : String(v); }
function num(v) { return typeof v === 'number' ? v : Number(v ?? 0) || 0; }

/**
 * 整数参数必须用 `neo4j.int()` 显式构造（Neo4j JS driver 最佳实践）。
 *
 * 为什么：只传普通 JS number 时，driver 在部分版本/编码路径下会把整数值
 * 当作 FLOAT 发送（实测收到 `Invalid input. '200.0' is not a valid value.
 * Must be a non-negative integer.`——Neo4j 对 LIMIT 等参数严格要求整数）。
 * `neo4j.int()` 保证发送的是 Bolt 整数类型，不依赖 driver 的 number 推断。
 */
let _intFn = (n) => n; // withNeo4jRead 里注入 real neo4j.int；fixture/selftest 模式不查库，用恒等
function neo4jInteger(n) {
  return _intFn(Math.max(1, Math.trunc(n)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 可选：向量层可达性（--embed）
// ─────────────────────────────────────────────────────────────────────────────

async function embedText(text) {
  const cfg = resolveEmbedding();
  if (!cfg.baseURL || !cfg.model) return null;
  const base = cfg.baseURL.replace(/\/+$/, '');
  const isOpenAi = /\/v\d+\/?$/.test(base);
  const isOllama = /:(11434)\b/.test(base) || /localhost|127\.0\.0\.1/.test(base);
  const url = isOpenAi ? `${base}/embeddings` : (isOllama ? `${base.replace(/\/v\d+\/?$/, '')}/api/embed` : `${base}/embeddings`);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body = isOpenAi ? { model: cfg.model, input: text } : { model: cfg.model, input: text };
  try {
    const resp = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const v = data?.data?.[0]?.embedding ?? data?.embeddings?.[0] ?? data?.embedding;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─────────────────────────────────────────────────────────────────────────────
// 自检：用合成样本验证分类器与变体构造（无需数据库）
// ─────────────────────────────────────────────────────────────────────────────

function selftest() {
  const cases = [
    {
      name: 'anchor 与事实措辞无重叠 → 有独立线索，字面命中即 REACHABLE_BOTH（模拟 inDisjoint=true）',
      node: {
        title: 'Neo4j 向量索引维度不匹配',
        summary: '写入 embedding 维度与索引声明不一致时报错',
        detail: '报错 dimension mismatch',
        context: '导入向量时',
        tags_scenario: 'database', tags_techStack: 'neo4j,vector', tags_free: 'dimension-mismatch',
        relatedConcepts: 'ann-index',
      },
      expectDisjointNonEmpty: true,
    },
    {
      name: 'anchor 全是事实复述 → disjoint 为空 → NO_INDEPENDENT_SIGNAL',
      node: {
        title: 'Neo4j 向量索引维度不匹配',
        summary: 'dimension mismatch 报错',
        detail: '',
        context: 'Neo4j 向量索引维度不匹配',
        tags_scenario: '', tags_techStack: 'Neo4j,向量索引',
        tags_free: '维度不匹配',
        relatedConcepts: '',
      },
      expectDisjointNonEmpty: false,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const v = buildVariants(c.node);
    const nonEmpty = v.disjoint.trim().length > 0;
    if (nonEmpty !== c.expectDisjointNonEmpty) {
      failed += 1;
      console.error(`✗ ${c.name}\n    disjoint="${v.disjoint}" kept=${JSON.stringify(v.kept)} dropped=${JSON.stringify(v.dropped)}`);
    } else {
      console.log(`✓ ${c.name}\n    kept=${JSON.stringify(v.kept)} dropped=${JSON.stringify(v.dropped)}`);
    }
  }

  // 分类器真值表
  const table = [
    [{ inLiteral: true, inDisjoint: true, disjointEmpty: false }, 'REACHABLE_BOTH'],
    [{ inLiteral: true, inDisjoint: false, disjointEmpty: false }, 'BLIND_SPOT'],
    [{ inLiteral: false, inDisjoint: false, disjointEmpty: false }, 'UNREACHABLE_LITERAL'],
    [{ inLiteral: true, inDisjoint: false, disjointEmpty: true }, 'NO_INDEPENDENT_SIGNAL'],
    [{ inLiteral: false, inDisjoint: true, disjointEmpty: true }, 'NO_INDEPENDENT_SIGNAL'],
  ];
  for (const [input, expected] of table) {
    const got = classify(input);
    if (got !== expected) {
      failed += 1;
      console.error(`✗ classify(${JSON.stringify(input)}) = ${got}，期望 ${expected}`);
    }
  }
  if (failed === 0) console.log('✓ classify 真值表 5/5');

  // Lucene 转义：特殊字符必须被转义；空格/CJK/字母数字保留
  const escCases = [
    ['neo4j (m=16) : vector', 'neo4j \\(m=16\\) \\: vector'],
    ['ann-index', 'ann\\-index'],
    ['导入向量时', '导入向量时'],
    ['a b "c" ~d', 'a b \\"c\\" \\~d'],
  ];
  for (const [inp, expected] of escCases) {
    const got = escapeLucene(inp);
    if (got !== expected) {
      failed += 1;
      console.error(`✗ escapeLucene(${JSON.stringify(inp)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
    }
  }
  if (failed === 0) console.log('✓ escapeLucene 4/4');

  // parseArgs：`-- limit 300` 空格误写应被容错为 --limit 300
  const paCases = [
    [['--', 'limit', '300'], { limit: 300 }],
    [['--limit=300', '--embed'], { limit: 300, embed: true }],
    [['--', 'limit', '300', '--', 'topk', '8'], { limit: 300, topk: 8 }],
  ];
  for (const [argv, expectPart] of paCases) {
    const got = parseArgs(argv);
    for (const [k, v] of Object.entries(expectPart)) {
      if (got[k] !== v) {
        failed += 1;
        console.error(`✗ parseArgs(${JSON.stringify(argv)}).${k} = ${got[k]}，期望 ${v}`);
      }
    }
  }
  if (failed === 0) console.log('✓ parseArgs 容错 3/3');

  // 汇总
  const rows = table.map(([, k]) => ({ category: k }));
  const s = summarize(rows);
  const ok = s.n === 5 && s.counts.NO_INDEPENDENT_SIGNAL === 2 && s.counts.BLIND_SPOT === 1 && s.gap === 3;
  if (!ok) { failed += 1; console.error(`✗ summarize 结果异常：${JSON.stringify(s)}`); }
  else console.log('✓ summarize 计数正确（gap=3）');

  console.log(failed === 0 ? '\nSELFTEST PASS' : `\nSELFTEST FAIL (${failed})`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { limit: 200, topk: 5, sample: 'rand', embed: false, json: false, selftest: false, fixture: null, tagChannel: false };
  // 容错：`-- limit`（连字符与参数名之间多一个空格）会被拆成 ['--','limit'] 两个 token。
  // 把孤立 `--` 之后紧跟的已知参数名合并回 `--limit`，避免用户误写时空跑默认值。
  const KNOWN = new Set(['limit', 'topk', 'sample', 'embed', 'json', 'selftest', 'fixture', 'tag-channel']);
  const normalized = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' && KNOWN.has(argv[i + 1])) {
      normalized.push(`--${argv[i + 1]}`);
      i += 1; // 跳过已被合并的参数名
    } else {
      normalized.push(a);
    }
  }
  for (let i = 0; i < normalized.length; i++) {
    const a = normalized[i];
    if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length)) || 200;
    else if (a === '--limit') out.limit = Number(normalized[++i]) || 200;
    else if (a.startsWith('--topk=')) out.topk = Number(a.slice('--topk='.length)) || 5;
    else if (a === '--topk') out.topk = Number(normalized[++i]) || 5;
    else if (a.startsWith('--sample=')) out.sample = a.slice('--sample='.length) === 'recent' ? 'recent' : 'rand';
    else if (a === '--sample') out.sample = normalized[++i] === 'recent' ? 'recent' : 'rand';
    else if (a === '--embed') out.embed = true;
    else if (a === '--json') out.json = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--tag-channel') out.tagChannel = true;
    else if (a.startsWith('--fixture=')) out.fixture = a.slice('--fixture='.length);
    else if (a === '--fixture') out.fixture = normalized[++i];
    // 其余 token 静默跳过
  }
  return out;
}

async function runAudit(args) {
  if (args.selftest) return selftest();

  // fixture 模式：无数据库也能演示/回归（用于验证脚本本身）
  if (args.fixture) {
    const nodes = JSON.parse(readFileSync(args.fixture, 'utf8'));
    const rows = nodes.map((node) => {
      const v = buildVariants(node);
      return {
        id: node.id, category: 'FIXTURE_MODE', disjoint: v.disjoint,
        kept: v.kept, dropped: v.dropped,
      };
    });
    console.log(JSON.stringify({ mode: 'fixture', rows }, null, 2));
    return;
  }

  if (!args.json) {
    const c = resolveNeo4j();
    console.log('=== 关联盲区审计（只读）===');
    console.log(`Neo4j: ${c.uri}（user=${c.user}，READ 访问模式）`);
    console.log(`样本: ${args.limit} 条 DISTILLED（sample=${args.sample}），topK=${args.topk}`);
    if (args.tagChannel) {
      console.log('tag 通道: 开启 —— disjoint 查询改查 experience_tags_search（Phase 1 模拟）');
    }
    console.log('');
  }

  const rows = await withNeo4jRead(async (session) => {
    const nodes = await fetchNodes(session, args.limit, args.sample);
    const out = [];
    for (const node of nodes) {
      const v = buildVariants(node);
      const disjointEmpty = v.disjoint.trim().length === 0;

      const inLiteral = await retrieves(session, v.literal, node.id, args.topk);
      const inDisjoint = disjointEmpty
        ? false
        : await retrieves(session, v.disjoint, node.id, args.topk, args.tagChannel ? 'experience_tags_search' : 'experience_search');

      let embedCos = null;
      if (args.embed && !disjointEmpty) {
        const [a, b] = [await embedText([node.title, node.summary].filter(Boolean).join(' ')), await embedText(v.disjoint)];
        if (a && b) embedCos = Number(cosine(a, b).toFixed(4));
      }

      out.push({
        id: node.id,
        title: (node.title || '').slice(0, 60),
        category: classify({ inLiteral, inDisjoint, disjointEmpty }),
        inLiteral, inDisjoint, disjointEmpty,
        disjointQuery: v.disjoint.slice(0, 160),
        keptChunks: v.kept.length, droppedChunks: v.dropped.length,
        embedCosine: embedCos,
      });
    }
    return out;
  });

  const s = summarize(rows);

  if (args.json) {
    console.log(JSON.stringify({ summary: s, rows, gate: TMEM_GATE }, null, 2));
    return;
  }

  console.log('=== 分类结果 ===');
  console.log(`样本数: ${s.n}`);
  console.log(`├─ NO_INDEPENDENT_SIGNAL  ${String(s.counts.NO_INDEPENDENT_SIGNAL).padStart(4)}  (${s.pct.NO_INDEPENDENT_SIGNAL}%)  去重叠后无任何线索 → 必须先补线索`);
  console.log(`├─ BLIND_SPOT             ${String(s.counts.BLIND_SPOT).padStart(4)}  (${s.pct.BLIND_SPOT}%)  字面可召回、非字面召回不到`);
  console.log(`├─ REACHABLE_BOTH         ${String(s.counts.REACHABLE_BOTH).padStart(4)}  (${s.pct.REACHABLE_BOTH}%)  现有 tag/全文层已覆盖`);
  console.log(`└─ UNREACHABLE_LITERAL    ${String(s.counts.UNREACHABLE_LITERAL).padStart(4)}  (${s.pct.UNREACHABLE_LITERAL}%)  连字面都召回不到（与关联无关的另一类问题）`);
  console.log('');
  console.log(`盲区总量 (NO_INDEPENDENT_SIGNAL + BLIND_SPOT) = ${s.gap} / ${s.n}（${s.n ? ((s.gap / s.n) * 100).toFixed(1) : 0}%）`);

  const show = (cat, n = 5) => {
    const hit = rows.filter((r) => r.category === cat).slice(0, n);
    if (!hit.length) return;
    console.log(`\n${cat} 样例（前 ${hit.length} 条）:`);
    for (const r of hit) {
      console.log(`  - ${r.id}`);
      console.log(`    title: ${r.title}`);
      console.log(`    disjoint 查询: ${r.disjointQuery || '(空)'}`);
      if (r.embedCosine != null) console.log(`    cosine(fact, disjoint)=${r.embedCosine}（门=${TMEM_GATE}）`);
    }
  };
  show('NO_INDEPENDENT_SIGNAL');
  show('BLIND_SPOT');

  if (args.embed) {
    const cos = rows.map((r) => r.embedCosine).filter((x) => typeof x === 'number');
    if (!cos.length) {
      console.log('\n⚠ --embed：未能取得任何 embedding（端点不可达或未配置）→ 向量层可达性未评估');
    } else {
      const pass = cos.filter((x) => x >= TMEM_GATE).length;
      cos.sort((a, b) => a - b);
      const med = cos[Math.floor(cos.length / 2)];
      console.log(`\n=== 向量层可达性（--embed）===`);
      console.log(`样本 ${cos.length}；cosine 中位数 ${med}；最小 ${cos[0]}；最大 ${cos[cos.length - 1]}`);
      console.log(`过 T-Mem 硬门 ${TMEM_GATE} 的比例: ${((pass / cos.length) * 100).toFixed(1)}%（${pass}/${cos.length}）`);
      console.log('解读：该比例越低，说明"字面无关查询"越无法靠现有向量层够到，越需要写入侧预生成线索。');
    }
  }

  console.log('\n=== 解读与边界 ===');
  console.log('1. 本审计测的是**现有非字面线索存量**，不是语义理解能力：');
  console.log('   NO_INDEPENDENT_SIGNAL 是"必要条件失败"——没有任何可用线索时，任何检索机制都无从下手。');
  console.log('2. 分类为 BLIND_SPOT 的比例是**盲区上界**：其中一部分靠现有向量层仍可能够到（见 --embed）。');
  console.log('3. UNREACHABLE_LITERAL 不计入盲区，属索引/阈值/质量另一类问题。');
  console.log('4. 本脚本只读，未做任何写入。');
}

runAudit(parseArgs(process.argv.slice(2))).catch((e) => {
  console.error(`\n审计失败：${e?.message ?? e}`);
  console.error('（不返回 0 结果——避免"看着像没有盲区"的误判）');
  process.exitCode = 1;
});
