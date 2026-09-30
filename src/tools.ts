/**
 * lcm-graph-extra — Operational tools
 *
 * 工具注册入口。共享基础设施已拆分到 src/tools/shared.ts。
 * 最大工具实现（lcmg_search/lcmg_diagnose/lcmg_sync）已拆分到子模块。
 */

import { Type } from "typebox";
import * as neo4jDriver from 'neo4j-driver';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join, basename, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { exportMarkdownToPdf, exportMarkdownToFile } from './utils/pdf-export.js';
import { getGlobalLogger } from './utils/logger.js';
import {
  planGmMessageRows,
  resolveGmSessionKey,
} from './utils/gm-message-contract.js';
import { estimateTokensFromText } from './lcm-bridge.js';
import { resolveNeo4jConfig } from './config/neo4j-helper';
import { registerSearchTool } from './tools/search.js';
import { registerDiagnoseTool } from './tools/diagnose.js';

import {
  // state management
  setPluginNeo4jConfig, getPluginNeo4jConfig, setSharedQmdClient, setPluginApiRef,
  // shared utilities
  acquireQmdClient, validateBackupPath, escapeFts5Query, parseTimeRange,
  generateExperienceSummary, openDb, closeSharedDb, getQmdBaseUrl, LCM_DB,
  // Neo4j
  neo4jToNumber, getNeo4jDriver, neo4jSession, closeNeo4j, closeNeo4jDriver,
  mergeEntriesNeo4jConfig, ensureNeo4jSchema,
  // registry
  getRegisteredToolHandler, getRegisteredToolSchema, _resetRegisteredToolHandlers, registerToolHandler,
  createAuditWrapper,
  // types
  type DashboardToolContext,
} from './tools/shared.js';

export { getRegisteredToolHandler, getRegisteredToolSchema, _resetRegisteredToolHandlers, closeSharedDb, closeNeo4jDriver, mergeEntriesNeo4jConfig, parseTimeRange, ensureNeo4jSchema };
export type { DashboardToolContext };

export function registerOperationalTools(api: any): void {
  setPluginNeo4jConfig(mergeEntriesNeo4jConfig(api) as Record<string, unknown>);
  setPluginApiRef(api);
  _registerOperationalToolsImpl(api, undefined);
}

export function registerOperationalToolsWithDashboard(api: any, dashboardContext?: DashboardToolContext): void {
  setPluginNeo4jConfig(mergeEntriesNeo4jConfig(api) as Record<string, unknown>);
  setPluginApiRef(api);
  _registerOperationalToolsImpl(api, dashboardContext);
}

/** 英文停用词集合（用于 MemoryFile 语义关键词提取） */
const MEMORY_STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','for','with','from','this','that','these',
  'those','is','are','was','were','be','been','being','to','of','in','on','at','by','as','it',
  'its','not','no','we','you','your','our','their','they','he','she','i','me','my','him','her',
  'us','them','can','could','will','would','should','may','might','must','do','does','did','have',
  'has','had','what','which','when','where','why','how','all','any','each','more','most','some',
  'such','only','own','same','so','than','too','very','just','about','into','over','after','before',
]);

/**
 * P1-孤立修复: 从 MemoryFile 内容提取用于建边的关键词。
 * 拆分非单词字符 → 过滤停用词/过短词 → 去重 → 小写，上限 20 个。
 * 仅英文分词（中文需外部提取，仍能匹配英文 name 的节点）。
 */
function extractMemoryKeywords(content: string): string[] {
  const tokens = content
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && t.length <= 40 && !MEMORY_STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 将会话/文件时间转换为毫秒时间戳。
 * 兼容：数字（视为 ms，若 <1e12 则视为秒）、ISO 字符串（Date.parse）、
 * Date 对象。解析失败回退 Date.now()。
 */
function toRealTs(v: unknown): number {
  if (v == null) return Date.now();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') {
    if (!isFinite(v) || v <= 0) return Date.now();
    return v < 1e12 ? v * 1000 : v; // 秒 → 毫秒
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() !== '' && isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const parsed = Date.parse(v);
    if (!isNaN(parsed)) return parsed;
  }
  return Date.now();
}

/**
 * 解析 memory 文件真实时间：优先 frontmatter 的 date/createdAt/updatedAt，
 * 否则回退文件系统 mtime。用于 MemoryFile 节点时序字段。
 */
function parseMemoryFileTime(content: string, filePath: string): number {
  try {
    const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (m) {
      for (const key of ['date', 'createdAt', 'updatedAt', 'created_at']) {
        const kv = m[1].match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
        if (kv?.[1]) {
          const t = toRealTs(kv[1].trim().replace(/^["']|["']$/g, ''));
          if (t > 0) return t;
        }
      }
    }
  } catch { /* 解析失败走回退 */ }
  try {
    const st = statSync(filePath);
    return st.mtimeMs || Date.now();
  } catch {
    return Date.now();
  }
}

// ---------------------------------------------------------------------------
// 会话消息来源加载（官方权威源优先，lcm.db 回退）—— 导入与同步共用
// ---------------------------------------------------------------------------

interface MessageSourceSession {
  sessionKey: string;
  sessionId: string;
  msgs: { role: unknown; content: unknown; createdAt: number }[];
}

interface MessageSourceLoad {
  sessions: MessageSourceSession[];
  /** 人类可读的来源描述（写进工具输出，便于判断读到的是哪个库） */
  source: string;
  /** 解压失败/无 zstd 支持而跳过的官方转录行数 */
  compressed: number;
  /** 成功按官方语义解压的官方转录行数 */
  decodedCompressed: number;
  /** 非 message entry 数（session 头 / compaction / label 等） */
  nonMessage: number;
  parseErrors: number;
  /** 因无可用会话键（session_key 与 session_id 皆空）被跳过的消息数 */
  skippedNoKey: number;
  errors: string[];
}

/**
 * 加载会话消息（按官方 SDK 逻辑排序来源）：
 *
 *  1. **官方 per-agent SQLite `transcript_events`** —— openclaw 2.0+ 的权威转录存储。
 *     官方存储教义（`src/state/openclaw-agent-schema.sql`）：
 *       "session_windows and their children own transcript generations"
 *     消息原文以 canonical entry JSON 存于 `event_json`（`{type:'message', message:{role, content}}`），
 *     content 可为字符串或块数组。JSONL / sessionFile 已标记为 legacy
 *     （sessionFile 现为进程内路由 token，不再是文件路径）。
 *     压缩行（冷转录）按官方 `openclaw_transcript_payload_decode` 语义解压后读取。
 *  2. **lossless-claw 的 lcm.db `conversations`/`messages`** —— 回退。
 *     仅在官方库不存在或尚无转录（未迁移环境）时使用：它是 lossless-claw 的镜像，
 *     可能滞后或被过滤，而官方转录是宿主写入的原文。
 *
 * 两条来源产出的行统一交给 gm-message-contract 的 planGmMessageRows 处理，
 * 故 role 过滤 / 内容扁平化 / id 生成只有一份实现。
 *
 * @param opts.sessionsOnly 只要会话清单（不读消息体）——孤儿检测等场景用，
 *        可避免 O(消息量) 的事件读取与 zstd 解压开销
 */
async function loadMessageSourceSessions(
  opts: { sessionsOnly?: boolean } = {},
): Promise<MessageSourceLoad> {
  const out: MessageSourceLoad = {
    sessions: [], source: 'none', compressed: 0, decodedCompressed: 0, nonMessage: 0, parseErrors: 0, skippedNoKey: 0, errors: [],
  };

  // 优先级 1：官方转录
  try {
    const mod = await import('./adapters/openclaw-agent-db.js');
    if (opts.sessionsOnly) {
      // 轻量路径：只读 session_windows（不读 transcript_events，不解压）
      const sessions = mod.readAgentTranscriptSessions();
      if (sessions.length > 0) {
        const byKey = new Map<string, MessageSourceSession>();
        for (const s of sessions) {
          const key = resolveGmSessionKey(s.sessionKey, s.sessionId);
          if (!key) { out.skippedNoKey += 1; continue; }
          if (!byKey.has(key)) byKey.set(key, { sessionKey: key, sessionId: s.sessionId, msgs: [] });
        }
        out.sessions = [...byKey.values()];
        out.source = `openclaw-agent.sqlite session_windows (agents, sessions-only)`;
        return out;
      }
    } else {
      const tr = mod.readAgentTranscriptMessages();
      out.compressed = tr.skippedCompressed;
      out.decodedCompressed = tr.decodedCompressed;
      out.nonMessage = tr.skippedNonMessage;
      out.parseErrors = tr.parseErrors;
      if (tr.messages.length > 0) {
        // 按稳定 sessionKey 归组：跨 /new 轮换的多个 session_window 属同一逻辑会话，
        // 上游 gm-pro 也正是按 sessionKey 枚举会话。
        const byKey = new Map<string, MessageSourceSession>();
        for (const m of tr.messages) {
          const key = resolveGmSessionKey(m.sessionKey, m.sessionId);
          if (!key) { out.skippedNoKey += 1; continue; }
          let g = byKey.get(key);
          if (!g) { g = { sessionKey: key, sessionId: m.sessionId, msgs: [] }; byKey.set(key, g); }
          g.msgs.push({ role: m.role, content: m.content, createdAt: m.createdAt });
        }
        out.sessions = [...byKey.values()];
        out.source = `openclaw-agent.sqlite transcript_events (agents=${tr.agentsScanned})`;
        return out;
      }
    }
  } catch (e: any) {
    out.errors.push(`官方转录读取失败：${e?.message ?? String(e)}`);
  }

  // 优先级 2：lcm.db 回退
  let db: any = null;
  try {
    db = openDb();
    if (opts.sessionsOnly) {
      // 轻量路径：只读 conversations（不读 messages）
      const convs = db.prepare("SELECT conversation_id, session_id, session_key FROM conversations").all() as any[];
      for (const conv of convs) {
        const key = resolveGmSessionKey(conv.session_key, conv.session_id);
        if (!key) { out.skippedNoKey += 1; continue; }
        out.sessions.push({
          sessionKey: key,
          sessionId: conv.session_id != null ? String(conv.session_id) : '',
          msgs: [],
        });
      }
      out.source = 'lcm.db conversations (fallback, sessions-only)';
      return out;
    }
    const convs = db.prepare(
      "SELECT conversation_id, session_id, session_key FROM conversations " +
      "WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM messages) " +
      "ORDER BY conversation_id DESC"
    ).all() as any[];
    for (const conv of convs) {
      const key = resolveGmSessionKey(conv.session_key, conv.session_id);
      const rows = db.prepare("SELECT seq, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY seq ASC").all(conv.conversation_id) as any[];
      if (!key) { out.skippedNoKey += rows.length; continue; }
      out.sessions.push({
        sessionKey: key,
        sessionId: conv.session_id != null ? String(conv.session_id) : '',
        msgs: rows.map((m: any) => ({ role: m.role, content: m.content, createdAt: toRealTs(m.created_at) })),
      });
    }
    out.source = 'lcm.db conversations/messages (fallback: official transcript empty)';
  } catch (e: any) {
    out.errors.push(`lcm.db 读取失败：${e.message}`);
  } finally { if (db) { try { db.close(); } catch {} } }

  return out;
}

/**
 * P2-孤立修复: 重连孤立的 DAG_Summary 节点。
 *
 * DAG_Summary 由外部 gm-pro 生成，部分节点未建立 HAS_SUMMARY 边而孤立。
 * 由于无法改动 gm-pro，本插件提供自发现重连：对每个无 HAS_SUMMARY 边的
 * DAG_Summary，用其自身字符串属性值与图中候选父节点
 * （Conversation/ConversationMessage/Task/Event/Skill/EXPERIENCE/GmFeedback）
 * 的 id/name/title 做匹配，命中则创建 `(parent)-[:HAS_SUMMARY]->(summary)` 边。
 *
 * @returns 重连的 DAG_Summary 数量
 */
async function reconnectOrphanedDagSummaries(): Promise<number> {
  const { driver, session } = await neo4jSession();
  try {
    // 1. 找出所有孤立的 DAG_Summary（无任何 HAS_SUMMARY 边），并收集其字符串属性作为候选匹配值
    const orphanRows = await session.run(
      `MATCH (s:DAG_Summary)
       WHERE NOT EXISTS { (s)-[:HAS_SUMMARY]-() }
       RETURN s.id AS id, [k IN keys(s) WHERE type(s[k]) = 'string' | trim(s[k])] AS props`,
    );
    let reconnected = 0;
    for (const rec of orphanRows.records) {
      const id = rec.get('id')?.toString();
      const props: string[] = (rec.get('props') ?? [])
        .map(String)
        .filter((v: string) => v && v.trim().length > 0 && v.length <= 100)
        .map((v: string) => v.trim());
      if (!id || props.length === 0) continue;
      // 2. 为该 DAG_Summary 寻找候选父节点并建 HAS_SUMMARY 边
      const res = await session.run(
        `MATCH (p)
         WHERE (p:Conversation OR p:ConversationMessage OR p:Task OR p:Event OR p:Skill OR p:EXPERIENCE OR p:GmFeedback)
           AND NOT p:DAG_Summary
           AND NOT EXISTS { (p)-[:HAS_SUMMARY]->(:DAG_Summary {id: $id}) }
         WITH p,
              [v IN $props WHERE v <> '' AND (
                 toLower(toString(coalesce(p.id, ''))) = toLower(v)
                 OR toLower(toString(coalesce(p.name, ''))) = toLower(v)
                 OR toLower(toString(coalesce(p.title, ''))) = toLower(v)
              )] AS hits
         WHERE size(hits) > 0
         WITH p LIMIT 1
         MERGE (p)-[r:HAS_SUMMARY]->(:DAG_Summary {id: $id})
           ON CREATE SET r.reconnectedAt = timestamp()
         RETURN count(r) AS n`,
        { id, props },
      );
      const n = res.records[0]?.get('n');
      reconnected += (typeof n?.toNumber === 'function') ? n.toNumber() : Number(n ?? 0);
    }
    return reconnected;
  } finally {
    await closeNeo4j(driver, session);
  }
}

function _registerOperationalToolsImpl(api: any, dashboardContext: DashboardToolContext | undefined): void {
  setSharedQmdClient(dashboardContext?.qmdClient ?? null);
  const originalRegisterTool = api.registerTool.bind(api);
  api.registerTool = createAuditWrapper(originalRegisterTool);
  // ===================================================================
  // 1. lcmg_experience_report
  // ===================================================================
  api.registerTool({
    name: "lcmg_experience_report",
    label: "经验报告",
    description: "Retrieve past troubleshooting experiences. Supports time range, tag, and type filtering. Output formats: text, json, markdown, summary, markdown-file, pdf-file.",
    parameters: Type.Object({
      format: Type.Optional(Type.String({ description: 'Output format: text, json, markdown, summary, markdown-file, pdf-file', default: "text" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)", minimum: 1, maximum: 100 })),
      tag: Type.Optional(Type.String({ description: "Filter by tag" })),
      from: Type.Optional(Type.String({ description: "Start time (ISO 8601 or relative like '7d', '24h')" })),
      to: Type.Optional(Type.String({ description: "End time (ISO 8601 or relative, default now)" })),
      type: Type.Optional(Type.String({ description: "Experience type: lesson|failure|correction|fix|best_practice" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const format = params.format ?? "text";
      const limitParam = params.limit ?? 20;
      const { driver, session } = await neo4jSession();
      try {
        // S-8': 解析时间范围参数
        const timeFilter = parseTimeRange(params.from, params.to);
        const typeFilter = params.type?.trim();

        // S-8': 优先调用 graph-memory-pro getNodesByTimeRange API（按时间范围高效检索）
        // 失败/不可用时降级到原 Cypher 查询
        let gmProNodes: any[] | null = null;
        if (timeFilter.fromTs || timeFilter.toTs) {
          try {
            const { withGmProFallback } = await import("./adapters/gm-pro-fallback.js");
            gmProNodes = await withGmProFallback<any[] | null>(
              'getNodesByTimeRange',
              async (mod) => {
                // 上游签名：getNodesByTimeRange({ start, end, timeField, type?, limit? })
                // timeField 取 updatedAt（最近活跃）；experiences 不在上游 NodeType(TASK/SKILL/EVENT) 内，故不传 type
                const r = await mod.getNodesByTimeRange({
                  start: timeFilter.fromTs ?? 0,
                  end: timeFilter.toTs ?? Date.now(),
                  timeField: 'updatedAt',
                  limit: Math.trunc(limitParam),
                });
                return Array.isArray(r) ? r : (r?.nodes ?? null);
              },
              async () => null, // fallback 走 Cypher
              { label: 'S-8 getNodesByTimeRange' },
            );
          } catch {
            gmProNodes = null;
          }
        }

        // 构建查询 —— 支持 EVENT 和 EXPERIENCE 双类型
        // EVENT: 图谱事件节点（原逻辑），EXPERIENCE: 经验层节点（S-8' 新增）
        const conditions: string[] = [];
        const queryParams: Record<string, any> = {
          limit: neo4jDriver.int(Math.trunc(limitParam)) as any,
          tag: params.tag ?? "",
        };

        if (params.tag) conditions.push("e.communityId = $tag");
        if (typeFilter) {
          conditions.push("e.type = $expType");
          queryParams.expType = typeFilter;
        }
        // S-8': Cypher 始终叠加时间条件（与 gm-pro 同一区间，等价幂等）。
        //        两侧都限定在同一时间范围内，合并时不会引入越界节点。
        if (timeFilter.fromTs) {
          conditions.push("coalesce(e.createdAt, e.updatedAt, 0) >= $fromTs");
          queryParams.fromTs = neo4jDriver.int(timeFilter.fromTs) as any;
        }
        if (timeFilter.toTs) {
          conditions.push("coalesce(e.createdAt, e.updatedAt, 0) <= $toTs");
          queryParams.toTs = neo4jDriver.int(timeFilter.toTs) as any;
        }

        const whereClause = conditions.length > 0 ? " AND " + conditions.join(" AND ") : "";

        // S-8': Cypher 结果与 gm-pro 结果【合并】（而非替换）。
        //        gm-pro getNodesByTimeRange 仅覆盖 Task|Skill|Event 节点，经验层
        //        EXPERIENCE/ENTITY 不在其节点模型内；若替换会静默丢弃经验层结果。
        let result: any;
        let usedExperienceNodes = false;

        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        {
        // 优先查 EXPERIENCE 节点（经验层），无结果时回退到 EVENT 节点
        try {
          const expQuery = `MATCH (e:EXPERIENCE)
            WHERE e.status = 'DISTILLED'
            AND (e.expiresAt IS NULL OR e.expiresAt > timestamp())${whereClause}
            OPTIONAL MATCH (e)-[r:RELATED_TO]->(related:EXPERIENCE)
            WITH e, collect(DISTINCT related.id) AS relatedIds
            RETURN e.id AS \`e.id\`, e.title AS \`e.name\`, e.summary AS \`e.description\`,
                   e.relevanceScore AS \`e.pagerank\`, e.matchCount AS \`e.validatedCount\`,
                   e.type AS \`e.communityId\`, e.createdAt AS createdAt,
                   [ {fix: null, relation: null} ] AS solutions,
                   relatedIds AS relatedIds
            ORDER BY e.relevanceScore DESC, e.matchCount DESC LIMIT $limit`;
          result = await session.run(expQuery, queryParams);
          if (result.records.length > 0) usedExperienceNodes = true;
        } catch (e) { /* EXPERIENCE label may not exist, fall through to EVENT */
          getGlobalLogger()?.debug?.("EXPERIENCE label query failed, falling back to EVENT (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
        }

        if (!usedExperienceNodes) {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          let query = `MATCH (e:Event)
            OPTIONAL MATCH (e)-[r:SOLVED_BY]->(fix:Skill)
            WITH e, collect({fix: fix, relation: r}) AS solutions
            WHERE size(solutions) > 0 AND ANY(s IN solutions WHERE s.fix IS NOT NULL)`;
          query += whereClause;
          query += ` RETURN e.id, e.name, e.description, e.pagerank, e.validatedCount, e.communityId, solutions
            ORDER BY e.pagerank DESC, e.validatedCount DESC LIMIT $limit`;
          result = await session.run(query, queryParams);
        }
        }

        // S-8': 合并 gm-pro 时间范围结果（去重键 e.id；同 id 以 Cypher 形态为准）。
        //        gm-pro 节点使用 importanceScore/validatedCount（非 relevanceScore/matchCount）。
        if (Array.isArray(gmProNodes) && gmProNodes.length > 0 && result) {
          const seenIds = new Set<string>();
          for (const rec of result.records ?? []) {
            const id = rec?.get?.('e.id');
            if (id != null) seenIds.add(String(id));
          }
          const gmProRecords = gmProNodes
            .filter((n: any) => n?.id != null && !seenIds.has(String(n.id)))
            .map((n: any) => ({
              get: (key: string) => {
                if (key === 'e.id') return n.id;
                if (key === 'e.name') return n.title ?? n.name ?? 'Unknown';
                if (key === 'e.description') return n.summary ?? n.description ?? '';
                if (key === 'e.pagerank') return n.pagerank ?? n.importanceScore ?? 0;
                if (key === 'e.validatedCount') return n.validatedCount ?? n.matchCount ?? 0;
                if (key === 'e.communityId') return n.type ?? '';
                if (key === 'createdAt') return n.createdAt;
                if (key === 'solutions') return [];
                if (key === 'relatedIds') return n.relatedIds ?? [];
                return undefined;
              },
            }));
          if (gmProRecords.length > 0) {
            usedExperienceNodes = true;
            result = {
              records: [...(result.records ?? []), ...gmProRecords].slice(0, Math.trunc(limitParam)),
            };
          }
        }

        if (!result || result.records.length === 0) {
          return { content: [{ type: "text" as const, text: "No experiences found." }], details: { ok: true } };
        }

        // S-8': summary 格式 —— LLM 生成自然语言摘要
        if (format === "summary") {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const summaryText = await generateExperienceSummary(result.records, usedExperienceNodes, timeFilter);
          return { content: [{ type: "text" as const, text: summaryText }], details: { ok: true } };
        }

        if (format === "json") {
          const data = result.records.map((rec: any) => ({
            id: rec.get("e.id"), name: rec.get("e.name"),
            confidence: (Number(rec.get("e.pagerank") ?? 0) * 100).toFixed(0) + "%",
            occurrences: neo4jToNumber(rec.get("e.validatedCount")),
            solutions: usedExperienceNodes ? [] : (rec.get("solutions") as any[])
              .filter((s: any) => s.fix)
              .map((s: any) => ({ name: s.fix.properties.name, instruction: s.relation?.properties?.instruction })),
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: { ok: true } };
        }

        const lines: string[] = [format === "markdown" ? "# Experience Report\n" : "Experience Report\n"];
        // S-8': 时间范围标签
        if (timeFilter.fromTs || timeFilter.toTs) {
          const fromStr = timeFilter.fromTs ? new Date(timeFilter.fromTs).toLocaleDateString() : "beginning";
          const toStr = timeFilter.toTs ? new Date(timeFilter.toTs).toLocaleDateString() : "now";
          lines.push(`Time range: ${fromStr} → ${toStr}\n`);
        }
        for (const rec of result.records) {
          const name = rec.get("e.name") ?? "Unknown";
          const conf = ((Number(rec.get("e.pagerank") ?? 0)) * 100).toFixed(0);
          const seen = neo4jToNumber(rec.get("e.validatedCount"));
          const desc = rec.get("e.description") ?? "";
          const sols: any[] = usedExperienceNodes ? [] : (rec.get("solutions") ?? []).filter((s: any) => s.fix);
          if (format === "markdown") {
            lines.push(`## ${name}`);
            lines.push(`- Confidence: ${conf}% | Occurrences: ${seen}`);
            if (desc) lines.push(`\n${desc}\n`);
            if (sols.length) {
              lines.push("### Solutions");
              for (const s of sols) {
                const sn = s.fix.properties.name ?? "Unknown";
                lines.push(`- **${sn}**${s.relation?.properties?.instruction ? " (" + s.relation.properties.instruction + ")" : ""}`);
              }
            }
          } else {
            lines.push(`[${name}]  ${conf}% (seen ${seen})`);
            if (desc) lines.push(`  ${desc}`);
            if (sols.length) {
              lines.push("  Solutions:");
              for (const s of sols) lines.push(`    - ${s.fix.properties.name ?? "Unknown"}`);
            }
          }
          lines.push("");
        }
        lines.push(`---\nTotal: ${result.records.length} experiences`);
        const finalText = lines.join("\n");

        // 阶段 3-2: 报告导出 — markdown-file / pdf-file 格式落盘到 ~/.openclaw/reports/
        if (format === "markdown-file" || format === "pdf-file") {
          try {
            if (format === "pdf-file") {
              const result = await exportMarkdownToPdf(finalText, 'experience-report');
              const methodInfo = result.method === 'pandoc' ? '' : ' (fallback: 内置 PDF 生成器，无外部依赖)';
              const msg = result.ok
                ? `PDF 报告已保存到 ${result.path}${methodInfo}`
                : `PDF 生成失败: ${result.error}，已保存为 markdown`;
              if (!result.ok) {
                const mdResult = exportMarkdownToFile(finalText, 'experience-report');
                return { content: [{ type: "text" as const, text: `${msg}\nMarkdown 路径: ${mdResult.path}` }], details: { ok: false, error: result.error, markdownPath: mdResult.path } };
              }
              return { content: [{ type: "text" as const, text: msg }], details: { ok: true, path: result.path, format: 'pdf', method: result.method } };
            } else {
              const result = exportMarkdownToFile(finalText, 'experience-report');
              return { content: [{ type: "text" as const, text: `报告已保存到 ${result.path}` }], details: { ok: true, path: result.path, format: 'markdown' } };
            }
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Failed to save report: ${String(err)}` }], details: { ok: false, error: String(err) } };
          }
        }

        return { content: [{ type: "text" as const, text: finalText }], details: { ok: true } };
      } finally {
        await closeNeo4j(driver, session);
      }
    },
  }, { optional: true });

  // ===================================================================
  // 2. lcmg_backup — 导出全量数据到 JSON
  // ===================================================================
  api.registerTool({
    name: "lcmg_backup",
    label: "全量备份",
    description: "Full system backup: exports Neo4j nodes+relationships, lossless-claw conversations, and all workspace memory/*.md into a single JSON file. Default output: /tmp/lcm-backup-<timestamp>.json. Use before destructive operations.",
    parameters: Type.Object({
      outputPath: Type.Optional(Type.String({ description: "Output directory" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const outDir = params.outputPath ?? join(homedir(), ".openclaw", "lcm-graph-extra", "backup");
      // SEC-5 M-11: 校验输出路径必须在 ~/.openclaw 之下，防止路径穿越
      let safeOutDir: string;
      try {
        safeOutDir = validateBackupPath(outDir);
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { ok: false, error: `Error: ${e.message}` }, isError: true };
      }
      // BUGFIX(P1-5): 异步 I/O 替代同步 fs 调用，避免阻塞事件循环
      await fsp.mkdir(safeOutDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = join(safeOutDir, `memory-full-backup-${stamp}.json`);

      const backup: Record<string, unknown> = {
        version: "2.0", createdAt: new Date().toISOString(),
        neo4j: { entities: [], relationships: [] },
        lcm: { conversations: [] }, files: [], openclaw: { agents: [] },
      };

      // Neo4j — BUGFIX(P1-5): 全表扫描加 LIMIT 防止超大图库 OOM
      try {
        const { driver, session } = await neo4jSession();
        try {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const nodes = await session.run("MATCH (n) RETURN n LIMIT 50000");
          (backup.neo4j as any).entities = nodes.records.map((r: any) => {
            const p = r.get("n").properties; return { id: p.id, name: p.name, labels: r.get("n").labels };
          });
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const rels = await session.run("MATCH ()-[r]->() RETURN r LIMIT 100000");
          (backup.neo4j as any).relationships = rels.records.map((r: any) => {
            const p = r.get("r").properties;
            return { fromId: p.fromId ?? "", toId: p.toId ?? "", type: r.get("r").type };
          });
        } finally { await closeNeo4j(driver, session); }
      } catch (e) { /* Neo4j unavailable */
        getGlobalLogger()?.debug?.("backup: Neo4j unavailable (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }

      // lossless-claw DB
      let db: any = null;
      try {
        db = openDb();
        const convs = db.prepare("SELECT conversation_id, session_id, session_key FROM conversations ORDER BY conversation_id").all() as any[];
        for (const conv of convs) {
          // 导出 created_at 原始值（lcm.db 存的是 'YYYY-MM-DD HH:MM:SS' 文本，见 sync 的解析约定）
          // 与 session_key 原始值：二者都是「恢复后无法再凭空重建」的事实，
          // 此前备份丢失它们 → 恢复只能写 Date.now() + 合成键 'restored'，真实时序永久丢失。
          const msgs = db.prepare("SELECT seq, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY seq").all(conv.conversation_id) as any[];
          (backup.lcm as any).conversations.push({
            sessionId: conv.session_id,
            sessionKey: conv.session_key ?? null,
            // 不截断 content：内容指纹是消息身份（gm:<sessionKey>:<role>:<fnv1a64(全文)>:<occ>）的输入，
            // 截断会同时改变指纹与 id，导致恢复后既丢数据又与上游节点对不上。
            messages: msgs.map((m) => ({
              seq: m.seq,
              role: m.role,
              content: m.content ?? "",
              createdAt: m.created_at ?? null,
            })),
          });
        }
      } catch (e) { /* DB unavailable */
        getGlobalLogger()?.debug?.("backup: lossless-claw DB unavailable (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }
      finally { if (db) { try { db.close(); } catch {} } }

      // Memory files — BUGFIX(P1-5): readFileSync/readdirSync/statSync → fsp 异步
      try {
        const memDir = join(homedir(), ".openclaw", "workspace", "main");
        const candidates = [
          join(memDir, "MEMORY.md"), join(memDir, "memory"),
        ];
        for (const c of candidates) {
          if (existsSync(c) && (await fsp.stat(c)).isFile()) {
            (backup.files as any[]).push({ path: basename(c), content: (await fsp.readFile(c, "utf-8")).slice(0, 100000) });
          } else if (existsSync(c)) {
            const entries = (await fsp.readdir(c)).filter((f) => f.endsWith(".md"));
            for (const entry of entries) {
              (backup.files as any[]).push({ path: `memory/${entry}`, content: (await fsp.readFile(join(c, entry), "utf-8")).slice(0, 50000) });
            }
          }
        }
      } catch (e) { /* File read unavailable */
        getGlobalLogger()?.debug?.("backup: memory files read unavailable (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }

      // OpenClaw 官方记忆（per-agent sqlite，openclaw >= 2026.8）—— 只读导出
      // memory_index_chunks/text 从 ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite 读取，
      // 与 openclaw 2.0 的 SQLite 存储规范保持一致（文件布局已在 2.0 迁移为 sqlite 权威）。
      try {
        const { agentMemoryHealth, recentAgentMemory } = await import('./adapters/openclaw-agent-db.js');
        const health = agentMemoryHealth();
        const recent = recentAgentMemory(3);
        (backup.openclaw as any).agents = health.map((h) => ({
          agentId: h.agentId,
          dbPath: h.dbPath,
          schemaVersion: h.schemaVersion,
          chunkCount: h.chunkCount,
          sourceCount: h.sourceCount,
          error: h.error,
          recentChunks: recent
            .filter((r) => r.agentId === h.agentId)
            .map((r) => ({
              chunkId: r.chunkId,
              path: r.path,
              importance: r.importance,
              updatedAt: r.updatedAt,
              text: r.text.slice(0, 5000),
            })),
        }));
      } catch (e) {
        getGlobalLogger()?.debug?.("backup: OpenClaw agent sqlite unavailable (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
      }

      // BUGFIX(P1-5): writeFileSync → fsp.writeFile（大 JSON 同步写会长时间阻塞事件循环）
      await fsp.writeFile(backupPath, JSON.stringify(backup, null, 2), "utf-8");
      const msgCount = (backup.lcm as any).conversations.reduce((a: number, c: any) => a + (c.messages?.length ?? 0), 0);
      const ocAgents = (backup.openclaw as any)?.agents ?? [];
      const ocChunks = ocAgents.reduce((a: number, g: any) => a + (g.chunkCount ?? 0), 0);
      const sizeKB = Math.round(JSON.stringify(backup).length / 1024);
      return {
        content: [{
          type: "text" as const,
          text: [
            `✅ Backup saved to: ${backupPath}`,
            `  Neo4j: ${(backup.neo4j as any).entities.length} entities, ${(backup.neo4j as any).relationships.length} relationships`,
            `  lossless-claw: ${(backup.lcm as any).conversations.length} conversations, ${msgCount} messages`,
            `  Files: ${(backup.files as any[]).length} files`,
            `  OpenClaw 官方记忆: ${ocAgents.length} agents, ${ocChunks} chunks`,
            `  Size: ${sizeKB} KB`,
          ].join("\n"),
        }],
        details: {
          ok: true,
          metrics: {
            path: backupPath,
            neo4jEntities: (backup.neo4j as any).entities.length,
            neo4jRelationships: (backup.neo4j as any).relationships.length,
            lcmConversations: (backup.lcm as any).conversations.length,
            lcmMessages: msgCount,
            files: (backup.files as any[]).length,
            openclawAgents: ocAgents.length,
            openclawChunks: ocChunks,
            sizeKB,
          },
        },
      };
    },
  }, { optional: true });

  // ===================================================================
  // 3. lcmg_restore — 从备份 JSON 恢复到三处
  // ===================================================================
  api.registerTool({
    name: "lcmg_restore",
    label: "数据恢复",
    description: "Restore from lcmg_backup JSON file. targets=all (default), neo4j_only, lcm_only, files_only. dryRun=true previews without writing. NOTE: Neo4j restore uses MERGE (does NOT delete existing nodes).",
    parameters: Type.Object({
      backupPath: Type.String({ description: "Path to backup JSON file" }),
      targets: Type.Optional(Type.String({
        description: "'all' (default), 'neo4j_only', 'lcm_only', 'files_only'",
        default: "all",
      })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing (default false)" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // SEC-5 M-12: 校验备份路径必须在 ~/.openclaw 之下，防止路径穿越
      let safeBackupPath: string;
      try {
        safeBackupPath = validateBackupPath(params.backupPath);
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { ok: false, error: `Error: ${e.message}` }, isError: true };
      }
      if (!existsSync(safeBackupPath)) {
        return { content: [{ type: "text" as const, text: `Backup not found: ${safeBackupPath}` }], details: { ok: false, error: `Backup not found: ${safeBackupPath}` }, isError: true };
      }
      // FIX-CR02: 备份文件可能被手工编辑为非合法 JSON，解析失败时返回明确错误而非抛出未捕获异常
      let data: any;
      try {
        data = JSON.parse(readFileSync(safeBackupPath, "utf-8"));
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: Backup file is not valid JSON: ${e?.message ?? String(e)}` }], details: { ok: false, error: `Invalid JSON: ${e?.message ?? String(e)}` }, isError: true };
      }
      const targets = params.targets ?? "all";
      const dryRun = params.dryRun ?? false;
      const report: string[] = [];

      report.push(`Restore from: ${safeBackupPath}`);
      report.push(`Dry run: ${dryRun ? "YES" : "NO"}\n`);

      // Neo4j
      if ((targets === "all" || targets === "neo4j_only") && !dryRun) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        try {
          // 恢复 Neo4j 前先自动建索引与约束（幂等，含版别适配），确保 MERGE 走索引
          await ensureNeo4jSchema();
          const { driver, session } = await neo4jSession();
          try {
            let nCount = 0, rCount = 0;
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const ent of (data.neo4j as any)?.entities ?? []) {
              // 对齐 gm-pro batchUpsertNodes 的时序/来源字段命名：
              // recordedAt / validFrom / source / status。ON CREATE SET 只在新建时填充，
              // 不覆盖已存在的时序数据（同上游「createdAt 只在新节点写」的语义）。
              // 不写 state/scores：上游 state 枚举为 current/superseded/transitional，
              // 'active' 属 status 取值域；scores 不是上游属性。
              await session.run(
                // Neo4j 语法：ON CREATE SET 必须紧跟 MERGE pattern，再跟 SET 子句
                "MERGE (n {id: $id}) " +
                "ON CREATE SET n.recordedAt = $now, n.validFrom = $now, n.source = 'imported', n.status = 'active', n.createdAt = $now " +
                "SET n.name = $name, n.labels = $labels",
                { id: ent.id, name: ent.name ?? "", labels: ent.labels ?? [], now: Date.now() },
              );
              nCount++;
            }
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const rel of (data.neo4j as any)?.relationships ?? []) {
              await session.run("MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:SOLVED_BY]->(b)", { from: rel.fromId, to: rel.toId });
              rCount++;
            }
            report.push(`✅ Neo4j: Restored ${nCount} entities, ${rCount} relationships`);
          } finally { await closeNeo4j(driver, session); }
        } catch (e: any) { report.push(`❌ Neo4j: ${e.message}`); }
      }

      // lossless-claw DB
      if ((targets === "all" || targets === "lcm_only") && !dryRun) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let db: any = null;
        try {
          db = openDb();
          let msgCount = 0;
          // created_at / session_key 按备份原值回写：
          //  - created_at 必须是 lcm.db 的 'YYYY-MM-DD HH:MM:SS' 文本（回退 datetime('now')），
          //    此前硬写 Date.now()（毫秒整数）→ 时间戳被写成非约定格式且全部塌成恢复时刻；
          //  - session_key 缺失时写 NULL（不合成 'restored'）：导入侧的 resolveGmSessionKey
          //    会回退到 session_id，使消息仍能落到上游认可的会话键上；
          //    而 'restored' 这种合成键会让同一会话在 Neo4j 里分裂成两个 sessionKey。
          const insertMsg = db.prepare(
            "INSERT OR IGNORE INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?)");
          for (const conv of (data.lcm as any)?.conversations ?? []) {
            let convId = 1;
            const exists = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(conv.sessionId ?? "") as any;
            if (exists) {
              convId = exists.conversation_id;
            } else {
              db.prepare("INSERT INTO conversations (session_id, session_key, active, created_at) VALUES (?, ?, 1, datetime('now'))")
                .run(conv.sessionId ?? "unknown", conv.sessionKey ?? null);
              convId = Number(db.prepare("SELECT last_insert_rowid() as id").get()?.id ?? 1);
            }
            for (const msg of (conv.messages ?? [])) {
              const content = msg.content ?? "";
              // 旧备份无 createdAt 时用当前 UTC 时间兜底（保持 'YYYY-MM-DD HH:MM:SS' 约定格式，不写 NULL）
              const createdAt = msg.createdAt
                ?? new Date().toISOString().slice(0, 19).replace('T', ' ');
              insertMsg.run(
                convId, msg.seq ?? 0, msg.role ?? "user", content,
                estimateTokensFromText(content),
                createdAt,
              );
              msgCount++;
            }
          }
          report.push(`✅ lossless-claw: Restored ${msgCount} messages`);
        } catch (e: any) { report.push(`❌ lossless-claw: ${e.message}`); }
        finally { if (db) { try { db.close(); } catch {} } }
      }

      // Files
      if ((targets === "all" || targets === "files_only") && !dryRun) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        try {
          const memDir = resolve(join(homedir(), ".openclaw", "workspace", "main"));
          let fCount = 0;
          let skipped = 0;
          for (const file of (data.files as any[]) ?? []) {
            // P0-5 SEC-4: 路径穿越防护。备份 JSON 中的 file.path 不可信，
            // 必须是相对路径且不含 ..，realpath 必须仍在 memDir 之下。
            const relPath = file.path;
            if (typeof relPath !== 'string' || relPath === '' || relPath.startsWith('/')) {
              skipped++; continue;
            }
            if (relPath.includes('..') || relPath.includes('\0')) {
              skipped++; continue;
            }
            const fp = resolve(join(memDir, relPath));
            // 二次校验：resolve 后的绝对路径必须以 memDir 为前缀
            if (fp !== memDir && !fp.startsWith(memDir + sep)) {
              skipped++; continue;
            }
            mkdirSync(fp.substring(0, fp.lastIndexOf(sep)), { recursive: true });
            writeFileSync(fp, file.content, "utf-8");
            fCount++;
          }
          report.push(`✅ Files: Restored ${fCount} files${skipped > 0 ? ` (skipped ${skipped} unsafe paths)` : ''}`);
        } catch (e: any) { report.push(`❌ Files: ${e.message}`); }
      }

      if (dryRun) {
        const n = (data.neo4j as any)?.entities?.length ?? 0;
        const r = (data.neo4j as any)?.relationships?.length ?? 0;
        const m = (data.lcm as any)?.conversations?.reduce((a: number, c: any) => a + (c.messages?.length ?? 0), 0) ?? 0;
        const f = (data.files as any[])?.length ?? 0;
        report.push(`📋 Would restore: Neo4j ${n}e/${r}r, lossless-claw ${m}msgs, ${f} files`);
      }

      report.push("\n✅ Restore complete.");
      // 从 report 中提取结构化指标
      const neo4jLine = report.find(l => l.includes("Neo4j:") && l.includes("Restored"));
      const lcmLine = report.find(l => l.includes("lossless-claw:") && l.includes("Restored"));
      const filesLine = report.find(l => l.includes("Files:") && l.includes("Restored"));
      return {
        content: [{ type: "text" as const, text: report.join("\n") }],
        details: {
          ok: true,
          metrics: {
            dryRun,
            path: safeBackupPath,
            targets,
            neo4jEntities: neo4jLine ? parseInt((neo4jLine.match(/Restored (\d+) entities/) || [])[1] || '0', 10) : (dryRun ? (data.neo4j as any)?.entities?.length ?? 0 : 0),
            neo4jRelationships: neo4jLine ? parseInt((neo4jLine.match(/(\d+) relationships/) || [])[1] || '0', 10) : (dryRun ? (data.neo4j as any)?.relationships?.length ?? 0 : 0),
            lcmMessages: lcmLine ? parseInt((lcmLine.match(/Restored (\d+) messages/) || [])[1] || '0', 10) : (dryRun ? (data.lcm as any)?.conversations?.reduce((a: number, c: any) => a + (c.messages?.length ?? 0), 0) ?? 0 : 0),
            files: filesLine ? parseInt((filesLine.match(/Restored (\d+) files/) || [])[1] || '0', 10) : (dryRun ? (data.files as any[])?.length ?? 0 : 0),
            skipped: filesLine ? parseInt((filesLine.match(/skipped (\d+) unsafe/) || [])[1] || '0', 10) : 0,
          },
        },
      };
    },
  }, { optional: true });

  // ===================================================================
  // 4. lcmg_import — 历史数据导入到 Neo4j（无 LLM 提取时可运行降级模式）
  // ===================================================================
  api.registerTool({
    name: "lcmg_import",
    label: "历史导入",
    description: "One-time import of historical data into Neo4j knowledge graph. source=lcm_messages imports chat history, source=memory_files imports *.md files, source=all does both." +
      " Writes :GmMessage / :ConversationMessage / :MemoryFile strictly to the graph-memory-pro contract (message id = gm:<sessionKey>:<role>:<fnv1a64(full text)>:<occurrence>, sessionKey = session_key ?? session_id, user/assistant with non-empty text only, createdAt on create only), so imported rows merge with upstream's own writes instead of duplicating them." +
      " After import it triggers graph-memory-pro's batch three-level rebuild (POST /api/extract/rebuild-all, async 202 + jobId) and reports the jobId." +
      " limit 为每批记录数上限，工具会自动分多批循环直到全部记录导入完成（清理后重建图库时用于完整恢复；因 id 与上游一致，在已有图库上重复导入亦幂等）。",
    parameters: Type.Object({
      source: Type.String({ description: '"lcm_messages", "memory_files", or "all"' }),
      limit: Type.Optional(Type.Number({ description: "每批处理的记录数上限（默认 100），自动多批直到全部导入", minimum: 1, maximum: 500 })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const limit = params.limit ?? 100;
      const lines: string[] = [];
      let total = 0;
      let filesImported = 0;
      let ocChunksImported = 0;

      // 关键性能修复：为 id 字段建立唯一约束（自动创建索引）。
      // 22 万文件毫秒级不复现的根因：MERGE/MATCH (n:MemoryFile {id}) 无索引时全图扫描，
      // 复杂度 O(N²)。唯一约束让 Neo4j 为 id 建索引 → MERGE/MATCH 走索引 O(1) 查找。
      // 由 ensureNeo4jSchema 统一在建约束（幂等，含版别适配的企业/社区版向量索引），
      // 重复运行、清理后重建均安全。
      await ensureNeo4jSchema();

      // lossless-claw 消息导入
      if (params.source === "lcm_messages" || params.source === "all") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let db: any = null;
        try {
          db = openDb();
          const batchSize = Math.max(1, limit);

          // 1) 加载会话消息来源：官方 SQLite 转录优先、lcm.db 回退。
          //    来源选择与理由集中在 loadMessageSourceSessions（与 lcmg_sync 共用同一实现）。
          const src = await loadMessageSourceSessions();
          const sessions = src.sessions;
          let msgSkippedNoKey = src.skippedNoKey;
          let msgSkippedNonConv = 0;
          let msgSkippedEmpty = 0;
          for (const err of src.errors) lines.push(`⚠ ${err}`);

          if (src.source === 'none' || sessions.length === 0) {
            lines.push('⚠ 未找到会话消息来源（官方 transcript_events 与 lcm.db 均无数据）');
          } else {
            lines.push(`ℹ 消息来源：${src.source}，会话数 ${sessions.length}`);
          }
          if (src.compressed > 0) {
            lines.push(`⚠ 官方转录有 ${src.compressed} 行 zstd 载荷解压失败（已跳过）：`
              + `可能是载荷损坏/长度不符，或运行时缺少 zstd 支持（需 Node 22.15+/23.8+ 的 zlib.zstdDecompressSync）`);
          }
          if (src.decodedCompressed > 0) {
            lines.push(`ℹ 已按官方 openclaw_transcript_payload_decode 语义解压 ${src.decodedCompressed} 行 zstd 转录载荷`);
          }
          if (src.nonMessage > 0) {
            lines.push(`ℹ 跳过 ${src.nonMessage} 条非消息 entry（session 头/compaction/label/model_change 等）`
              + (src.parseErrors > 0 ? `，解析失败 ${src.parseErrors} 行` : ''));
          }

          // 2) 逐会话构建两类行：
          //    convRows —— :ConversationMessage（上游全文索引 conversation_search 的语料标签）
          //    gmRows   —— :GmMessage（上游 rebuild 读取配对三级节点的唯一来源）
          //
          // 契约来源：graph-memory-pro v2.4.7 `src/store/messages.ts`
          //   - 身份：`gm:<sessionKey>:<role>:<fnv1a64(全文)>:<同内容出现序号>`
          //   - 字段：id / sessionKey / turnIndex / role / content / createdAt(仅 ON CREATE)
          //   - 过滤：仅 user/assistant 且文本非空（system/tool 上游同样不持久化）
          //   - sessionKey 回退链：session_key ?? session_id（对齐上游 ctx.sessionKey ?? ctx.sessionId）
          // 本地镜像实现与单测见 src/utils/gm-message-contract.ts。
          //
          // 对齐动因：上游每轮 agent_end 会**全量重放**整段会话。id 若与上游不同，
          // 重放算出的 id 命不中导入的节点 → MERGE 退化为插入 → 历史被复制一份。
          const convRows: {
            id: string; role: string; content: string; sessionKey: string; sessionId: string;
            tokens: number; ts: number;
          }[] = [];
          const gmRows: {
            id: string; sessionKey: string; role: string; content: string;
            turnIndex: number; createdAt: number;
          }[] = [];

          for (const sess of sessions) {
            const plan = planGmMessageRows(sess.msgs, sess.sessionKey);
            msgSkippedNonConv += plan.skippedNonConversational;
            msgSkippedEmpty += plan.skippedEmpty;
            for (const row of plan.rows) {
              gmRows.push({
                id: row.id,
                sessionKey: row.sessionKey,
                role: row.role,
                content: row.content,
                turnIndex: row.turnIndex,
                createdAt: row.createdAt,
              });
              // :ConversationMessage 与 :GmMessage 复用同一 id（同节点双标签）：
              // 上游读取面按 :GmMessage 枚举会话，全文检索面按 :ConversationMessage 命中语料，
              // 双标签让导入的历史对两条读取路径都可见。
              convRows.push({
                id: row.id,
                role: row.role,
                content: row.content,
                sessionKey: row.sessionKey,
                sessionId: sess.sessionId,
                tokens: estimateTokensFromText(row.content),
                ts: row.createdAt,
              });
            }
          }

          const { driver, session } = await neo4jSession();
          try {
            // 3) 按批次写入，直到队列耗尽。
            // 性能优化：UNWIND 批量 MERGE（每批仅一次往返），避免逐条 session.run
            // 造成数百上千次往返而拖慢全量导入（清理后完整重建场景数据量大）。
            //
            // 时序字段一律 ON CREATE：上游 saveMessage 明确「createdAt 只在新建时写」，
            // 否则每次重放都会把整段历史的时间戳刷成本轮时间（真实时间不可恢复）。
            for (let i = 0; i < gmRows.length; i += batchSize) {
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              const chunk = gmRows.slice(i, i + batchSize);
              await session.run(
                "UNWIND $rows AS m " +
                "MERGE (n:GmMessage {id: m.id}) " +
                "ON CREATE SET n.createdAt = m.createdAt " +
                "SET n.sessionKey = m.sessionKey, n.turnIndex = toInteger(m.turnIndex), n.role = m.role, n.content = m.content",
                { rows: chunk.map((m) => ({ ...m, createdAt: neo4jDriver.int(m.createdAt), turnIndex: neo4jDriver.int(m.turnIndex) })) },
              );
              total += chunk.length;
            }

            // 4) :ConversationMessage 同 id 双标签（上游全文索引 conversation_search 的语料）。
            //    字段按上游契约：status（上游 searchNodes 过滤字段，取值 'active'）+ 时序四件套。
            //    不写 state/scores：上游无 scores 属性，state 枚举为 current/superseded/transitional，
            //    与 'active' 冲突；'active' 是 status 的取值域。
            for (let i = 0; i < convRows.length; i += batchSize) {
              if (signal?.aborted) break;
              const chunk = convRows.slice(i, i + batchSize);
              await session.run(
                "UNWIND $rows AS m " +
                "MERGE (n:ConversationMessage {id: m.id}) " +
                "ON CREATE SET n.recordedAt = m.ts, n.validFrom = m.ts, n.source = 'imported', n.status = 'active', n.createdAt = m.ts " +
                "SET n.role = m.role, n.content = m.content, n.sessionKey = m.sessionKey, n.sessionId = m.sessionId, n.tokens = m.tokens",
                { rows: chunk.map((m) => ({ ...m, ts: neo4jDriver.int(m.ts) })) },
              );
            }
          } finally { await closeNeo4j(driver, session); }
          lines.push(`✅ Imported ${total} :GmMessage / ${convRows.length} :ConversationMessage rows (batch=${batchSize}, batches=${Math.ceil(gmRows.length / batchSize)})`);
          if (msgSkippedNoKey > 0) {
            lines.push(`⚠ Skipped ${msgSkippedNoKey} messages: conversation has neither session_key nor session_id (matches upstream "no sessionKey → skip turn")`);
          }
          if (msgSkippedNonConv > 0 || msgSkippedEmpty > 0) {
            lines.push(`ℹ Skipped ${msgSkippedNonConv} non-conversational (system/tool) + ${msgSkippedEmpty} empty messages (upstream persists user/assistant with non-empty text only)`);
          }
        } catch (e: any) { lines.push(`❌ lossless-claw import: ${e.message}`); }
        finally { if (db) { try { db.close(); } catch {} } }
      }

      // 记忆文件导入
      if (params.source === "memory_files" || params.source === "all") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let fCount = 0;
        try {
          const memDir = join(homedir(), ".openclaw", "workspace", "main", "memory");
          // limit = 每批文件数上限；自动分多批直到全部导入（清理 Neo4j 后完整重建）
          const batchSize = Math.max(1, limit);
          const allFiles = existsSync(memDir) ? readdirSync(memDir).filter((f) => f.endsWith(".md")) : [];
          const { driver, session } = await neo4jSession();
          try {
            // 1) 一次性读取全部文件内容（仅读一次），构建节点写入行 + 关键词缓存。
            //    性能优化：避免节点写入与语义匹配各读一遍文件（2 万文件 → 少 1 万次读盘）。
            //    时序使用每个文件真实时间（frontmatter date 优先，回退文件系统 mtime）。
            const rows: { id: string; name: string; content: string; ts: number }[] = [];
            const fileKeywords = new Map<string, string[]>();
            for (const file of allFiles) {
              const content = readFileSync(join(memDir, file), "utf-8").slice(0, 5000);
              const ts = parseMemoryFileTime(content, join(memDir, file));
              rows.push({ id: `file-${file}`, name: file, content, ts });
              fileKeywords.set(file, extractMemoryKeywords(content));
            }

            // 2) 批量写入 MemoryFile 节点（UNWIND，每批仅一次往返）。
            //    字段按上游规范：status='active'（上游 searchNodes 过滤字段）、
            //    source='imported'（上游 NodeSource 枚举 experience|knowledge|imported）。
            //    不写 state/scores：上游 state 枚举为 current/superseded/transitional，
            //    'active' 属 status 取值域；scores 不是上游属性。
            //    时序字段仅 ON CREATE（node:MemoryFile 亦被上游 timestamp-backfill 按
            //    COALESCE 补时序，重复导入不应刷掉真实时间）。
            for (let i = 0; i < rows.length; i += batchSize) {
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              const chunk = rows.slice(i, i + batchSize);
              await session.run(
                "UNWIND $rows AS m " +
                "MERGE (n:MemoryFile {id: m.id}) " +
                "ON CREATE SET n.recordedAt = m.ts, n.validFrom = m.ts, n.source = 'imported', n.status = 'active', n.createdAt = m.ts " +
                "SET n.name = m.name, n.content = m.content",
                { rows: chunk.map((m) => ({ ...m, ts: neo4jDriver.int(m.ts) })) },
              );
              fCount = Math.min(rows.length, i + batchSize);
              filesImported = fCount;
            }

            // 3) 语义关联边（P1-孤立修复）—— 性能优化：内存预加载候选节点 + UNWIND 批量建边，
            //    替代原先每个文件一次 Cypher 往返。文件多时（100MB 可上万文件）该往返是超时主因：
            //    原 O(文件数) 次往返 → 1 次候选查询 + O(边数/批) 次批量建边。
            const candRes = await session.run(
              `MATCH (n)
               WHERE (n:Task OR n:Skill OR n:Event) AND n.name IS NOT NULL
               RETURN n.id AS id, toLower(trim(n.name)) AS lname`,
            );
            const nameToId = new Map<string, string>();
            for (const rec of candRes.records) {
              const id = rec.get('id')?.toString();
              const lname = rec.get('lname') as string | undefined;
              if (id && lname) nameToId.set(lname, id);
            }
            // 候选节点过多时跳过语义关联，只完成节点导入（保住 10 分钟性能目标）
            const CAND_LIMIT = 100_000;
            if (nameToId.size > 0 && nameToId.size <= CAND_LIMIT) {
              const edgeRows: { from: string; to: string }[] = [];
              for (const file of allFiles) {
                const keywords = fileKeywords.get(file) ?? [];
                let linked = 0;
                for (const kw of keywords) {
                  const target = nameToId.get(kw);
                  if (!target) continue;
                  edgeRows.push({ from: `file-${file}`, to: target });
                  if (++linked >= 10) break;
                }
              }
              for (let i = 0; i < edgeRows.length; i += batchSize) {
                await session.run(
                  // 目标节点 id 来自内存 nameToId（已保证为 Task/Skill/Event），
                  // 直接按 id 匹配以走 lcm_task/skill/event 唯一约束索引，避免标签并集全扫描
                  `UNWIND $rows AS e
                   MATCH (m:MemoryFile {id: e.from})
                   MATCH (n) WHERE n.id = e.to AND (n:Task OR n:Skill OR n:Event)
                   MERGE (m)-[r:MENTIONS]->(n)
                     ON CREATE SET r.createdAt = timestamp()`,
                  { rows: edgeRows.slice(i, i + batchSize) },
                );
              }
            } else if (nameToId.size > CAND_LIMIT) {
              lines.push(`⚠ MemoryFile semantic links skipped: ${nameToId.size} candidate nodes exceed limit ${CAND_LIMIT}`);
            }
          } finally { await closeNeo4j(driver, session); }
          lines.push(`✅ Imported ${fCount}/${allFiles.length} memory files into Neo4j (batch=${batchSize}, batches=${Math.ceil(allFiles.length / batchSize)})`);
        } catch (e: any) { lines.push(`❌ memory files import: ${e.message}`); }
      }

      // OpenClaw 官方记忆索引（per-agent sqlite）→ MemoryFile 节点。
      // openclaw 2.0 起记忆正文以 sqlite 为权威存储，这里把官方索引 chunk（memory_index_chunks.text）
      // 也纳入图谱，与文件导入互补，避免 2.0 迁移后文件布局缺数据。
      if (params.source === "memory_files" || params.source === "all") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        try {
          const { recentAgentMemory } = await import('./adapters/openclaw-agent-db.js');
          const recent = recentAgentMemory(Math.max(1, limit)); // 每 agent 最新 limit 条
          if (recent.length > 0) {
            const { driver, session } = await neo4jSession();
            try {
              const rows = recent.map((r) => ({
                id: `openclaw-${r.agentId}-${r.chunkId}`,
                name: `${r.agentId}:${r.path}`,
                content: (r.text ?? "").slice(0, 5000),
                ts: r.updatedAt ?? Date.now(),
              }));
              const batchSize = Math.max(1, limit);
              for (let i = 0; i < rows.length; i += batchSize) {
                if (signal?.aborted) {
                  return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
                }
                await session.run(
                  "UNWIND $rows AS m " +
                  "MERGE (n:MemoryFile {id: m.id}) " +
                  "ON CREATE SET n.recordedAt = m.ts, n.validFrom = m.ts, n.source = 'imported', n.status = 'active', n.createdAt = m.ts " +
                  "SET n.name = m.name, n.content = m.content",
                  { rows: rows.slice(i, i + batchSize).map((m) => ({ ...m, ts: neo4jDriver.int(m.ts) })) },
                );
                ocChunksImported = Math.min(rows.length, i + batchSize);
              }
            } finally { await closeNeo4j(driver, session); }
            lines.push(`✅ Imported ${ocChunksImported} OpenClaw official memory chunks into Neo4j (:MemoryFile, source='imported')`);
          }
        } catch (e: any) { lines.push(`❌ OpenClaw memory import: ${e.message}`); }
      }

      // 4) 导入完成后自动触发三级节点重建（Task/Skill/Event）。
      //    完全复用 graph-memory-pro 的批量重建 API（POST /api/extract/rebuild-all）。
      //    默认开启；openclaw.json → lcm-graph-extra.config.buildThreeLevel.onImport=false 可关闭。
      //    提取模式默认 heuristic（规则快速提取，零 LLM、毫秒级）；onImportMode="llm" 可切回 LLM 精炼。
      //
      //    覆盖范围对齐上游语义：上游 `limitSessions` 默认 0 = **全部会话**。
      //    此前固定传 batchLimit(默认 50) 会导致"完整恢复"只重建前 50 个会话。
      //    这里默认不下传 limitSessions（=上游全量），仅当用户显式配置 batchLimit>0 时才限制。
      //
      //    上游响应是**立即 202 + jobId**（长任务后台跑），故此处 await 只花一次往返：
      //    换取「失败可见」（不再只写 logger.warn）+ jobId 回显供用户轮询进度。
      const buildCfg = api?.pluginConfig?.buildThreeLevel ?? {};
      const enabled = buildCfg.enabled !== false;
      const onImport = buildCfg.onImport !== false;
      if (enabled && onImport && (params.source === "all" || params.source === "lcm_messages")) {
        // 未配置 → 不限制（上游全量）；显式配置正数才透传（上游上限 100000）
        const bLimit = Number(buildCfg.batchLimit);
        const limitSessions = Number.isFinite(bLimit) && bLimit > 0
          ? Math.max(1, Math.min(100_000, Math.floor(bLimit)))
          : undefined;
        // 批量导入后默认按规则快速提取（heuristic），避免导入即触发 LLM 批量开销；
        // 重点会话再用 mode=llm + thinking:false 精炼补全。
        const importMode: 'llm' | 'heuristic' = buildCfg.onImportMode === 'llm' ? 'llm' : 'heuristic';
        try {
          const { triggerGmProRebuildAll } = await import('./tools/shared.js');
          const r = await triggerGmProRebuildAll({
            mode: importMode,
            limitSessions,
            progressPath: buildCfg.progressPath,
            signal,
          });
          if (!r.ok) {
            // 失败要让用户看见（原先只写 logger.warn，工具返回值里看不到）
            lines.push(`⚠ 三级节点重建未触发：${r.error ?? 'unknown error'}`);
          } else if (r.jobId) {
            lines.push(`⏳ 三级节点重建已启动（graph-memory-pro 批量重建，mode=${importMode}，`
              + `${limitSessions ? `limitSessions=${limitSessions}` : '全部会话'}）`);
            lines.push(`   进度查询：GET /api/extract/rebuild-all/job/${r.jobId}`);
          } else {
            lines.push(`⏳ 三级节点重建已启动（mode=${importMode}）`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lines.push(`⚠ 三级节点重建未触发：${msg}`);
          getGlobalLogger().warn?.('[lcmg_import] 三级节点自动重建失败', { err: msg });
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "No data imported." }],
        details: {
          ok: true,
          metrics: {
            source: params.source,
            limit,
            messagesImported: total,
            filesImported,
            openclawChunksImported: ocChunksImported,
          },
        },
      };
    },
  }, { optional: true });

  // ===================================================================
  // 5. lcmg_diagnose — 系统诊断 → src/tools/diagnose.ts
  registerDiagnoseTool(api);
// ===================================================================
  // 6. lcmg_search — 跨引擎联合搜索 → src/tools/search.ts
  registerSearchTool(api);

  // ===================================================================
  // 7. lcmg_pin — 标记 Neo4j 节点为永久保留
  // ===================================================================
  api.registerTool({
    name: "lcmg_pin",
    label: "节点置顶",
    description: "Pin/unpin a knowledge graph node. Pinned nodes are excluded from TTL cleanup and auto-deletion.",
    parameters: Type.Object({
      id: Type.String({ description: "Node ID to pin" }),
      unpin: Type.Optional(Type.Boolean({ description: "Set true to unpin instead of pin (default false)" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const { driver, session } = await neo4jSession();
        try {
          const pinned = params.unpin !== true;
          await session.run("MATCH (n {id: $id}) SET n.pinned = $pinned", { id: params.id, pinned });
          return {
            content: [{
              type: "text" as const,
              text: `✅ Node "${params.id}" ${pinned ? "pinned" : "unpinned"}`,
            }],
            details: { ok: true },
          };
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Pin error: ${e.message}` }], details: { ok: false, error: `❌ Pin error: ${e.message}` }, isError: true };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 7.5 lcmg_forget — G-10: 主动遗忘命令（与 lcmg_pin 反向）
  // ===================================================================
  api.registerTool({
    name: "lcmg_forget",
    label: "主动遗忘",
    description: "Forget or deprecate a knowledge graph node. mode=soft: reduce weight (still searchable). mode=hard: mark superseded (excluded from search).",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Node ID to forget" })),
      query: Type.Optional(Type.String({ description: "Query to find nodes to forget (if id not provided)" })),
      mode: Type.Optional(Type.String({ description: "'soft' (default): reduce weight. 'hard': mark as superseded", default: "soft" })),
      confirm: Type.Optional(Type.Boolean({ description: "Required true for hard mode (safety check)", default: false })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const mode = params.mode ?? "soft";
      const isHard = mode === "hard";

      // Safety: hard mode requires explicit confirmation
      if (isHard && params.confirm !== true) {
        return {
          content: [{
            type: "text" as const,
            text: "❌ Hard forget requires confirm=true. This is a safety check to prevent accidental data loss.",
          }],
          details: { ok: true },
        };
      }

      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const { driver, session } = await neo4jSession();
        try {
          let nodeIds: string[] = [];

          if (params.id) {
            // Single node by ID
            nodeIds = [params.id];
          } else if (params.query) {
            // Search for nodes by query
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            const searchResult = await session.run(
              `MATCH (n) WHERE (n.name CONTAINS $q OR n.description CONTAINS $q OR n.title CONTAINS $q OR n.summary CONTAINS $q)
               AND NOT n.pinned = true
               RETURN n.id AS id LIMIT 10`,
              { q: params.query },
            );
            nodeIds = searchResult.records.map((r: any) => r.get("id")).filter(Boolean);
            if (nodeIds.length === 0) {
              return { content: [{ type: "text" as const, text: "No matching nodes found (pinned nodes are protected)." }], details: { ok: true } };
            }
          } else {
            return { content: [{ type: "text" as const, text: "Provide either id or query parameter." }], details: { ok: false, error: "Provide either id or query parameter." }, isError: true };
          }

          let affected = 0;
          if (isHard) {
            // G-10: 优先调用 graph-memory-pro evolveNode API（与 S-2 软替换 + G-3 重要性评分协同）
            // 失败降级到原 Cypher 直接 SET（保留原行为）
            const { withGmProFallback } = await import("./adapters/gm-pro-fallback.js");
            type EvolveResult = { evolved: boolean; previousState?: string; newState?: string; reason?: string } | null;
            const gmProEvolvedSet = new Set<string>(); // 已成功 evolve 的节点 ID（去重）
            for (const nodeId of nodeIds) {
              const result = await withGmProFallback<EvolveResult>(
                'evolveNode',
                async (mod) => {
                  // gm-pro GmNode 使用 validTo/importanceScore（无 supersededAt/relevanceScore）；
                  // 其 upsertNode 为固定属性白名单，未知键会被静默丢弃，故必须用 gm-pro 字段名。
                  const r = await mod.evolveNode(nodeId, {
                    state: 'superseded',
                    validTo: Date.now(),
                    importanceScore: 0,
                    pagerank: 0,
                  });
                  return r as EvolveResult;
                },
                async () => null, // fallback 不做（由后续 Cypher 处理）
                { label: 'G-10 evolveNode' },
              );
              // 上游 evolveNode 返回 Promise<void>（成功返回 void/undefined，失败或降级返回 null）
              if (result !== null) gmProEvolvedSet.add(nodeId);
            }

            // 增量维护协同（上游 markDirty(driver, nodeIds)）：把刚置为 superseded 的节点
            // 标记为脏，让 heartbeat 的 incrementalMaintain() 下一轮对它们执行陈旧性/边权重衰减。
            // 非致命：失败时后续 Cypher 兜底已正确置位，仅跳过脏标记。
            if (gmProEvolvedSet.size > 0) {
              try {
                const { withGmProFallback } = await import("./adapters/gm-pro-fallback.js");
                await withGmProFallback(
                  'markDirty',
                  async (mod) => mod.markDirty(driver, [...gmProEvolvedSet]),
                  async () => undefined, // fallback 不做（脏标记非致命）
                  { label: 'G-10 markDirty' },
                );
              } catch { /* non-fatal */ }
            }

            // Fallback: Cypher 直接 SET（仅处理 gm-pro 未成功的节点，避免双重处理）
            const remainingIds = nodeIds.filter((id: string) => !gmProEvolvedSet.has(id));
            if (remainingIds.length > 0) {
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              const result = await session.run(
                `UNWIND $ids AS nodeId
                 MATCH (n {id: nodeId})
                 WHERE NOT n.pinned = true
                 SET n.state = 'superseded',
                     n.supersededAt = timestamp(),
                     n.relevanceScore = 0,
                     n.pagerank = 0
                 RETURN count(n) AS cnt`,
                { ids: remainingIds },
              );
              const cypherAffected = result.records[0]?.get("cnt")?.toNumber() ?? 0;
              affected = gmProEvolvedSet.size + cypherAffected; // 精确求和，不重复计数
            } else {
              affected = gmProEvolvedSet.size;
            }
          } else {
            // Soft: reduce weight (relevanceScore * 0.3, pagerank * 0.3)
            // G10-P2 修复: 加 0.05 下限，避免多次软遗忘后权重无限趋近 0（隐式硬遗忘）
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            const result = await session.run(
              `UNWIND $ids AS nodeId
               MATCH (n {id: nodeId})
               WHERE NOT n.pinned = true
               SET n.relevanceScore = greatest(coalesce(n.relevanceScore, 0.5) * 0.3, 0.05),
                   n.pagerank = greatest(coalesce(n.pagerank, 0.5) * 0.3, 0.05),
                   n.forgottenAt = timestamp()
               RETURN count(n) AS cnt`,
              { ids: nodeIds },
            );
            affected = result.records[0]?.get("cnt")?.toNumber() ?? 0;
          }

          const modeText = isHard ? "hard-forgotten (superseded)" : "soft-forgotten (weight reduced)";
          return {
            content: [{
              type: "text" as const,
              text: affected > 0
                ? `✅ ${affected} node(s) ${modeText}.\nIDs: ${nodeIds.slice(0, 5).join(", ")}${nodeIds.length > 5 ? ` ... (+${nodeIds.length - 5})` : ""}\n${isHard ? "Nodes are retained for audit but excluded from search." : "Nodes remain searchable but deprioritized."}`
                : `⚠️ No nodes affected (they may be pinned or not found).`,
            }],
            details: { ok: true },
          };
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Forget error: ${e.message}` }], details: { ok: false, error: `❌ Forget error: ${e.message}` }, isError: true };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 8. lcmg_sync — 三端数据同步修复
  // ===================================================================
  api.registerTool({
    name: "lcmg_sync",
    label: "数据同步",
    description: "Cross-store consistency check and repair for lossless-claw, Neo4j, and memory files. mode=check: read-only audit (reports orphaned entities and missing refs). mode=repair: actively prunes orphans and re-imports missing data. " +
      "Detects stale Neo4j entities (orphaned after compaction), missing entities, and cross-reference drift.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({
        description: '"check" (default, read-only), "repair" (prune orphans + re-import)',
        default: "check",
      })),
      // P0-5 SEC-4: dryRun 默认 true。原代码 repair 模式默认 false，用户不显式传 dryRun 时
      // 直接执行 DETACH DELETE 批量删除。改为默认 true，强制用户显式 dryRun:false 才执行删除。
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing (default true). Set to false only after reviewing the dry-run report.", default: true })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const mode = params.mode ?? "check";
      const isDryRun = params.dryRun ?? true;
      const lines: string[] = [];
      const push = (s: string) => lines.push(s);

      push(`# Data Sync: mode=${mode} dryRun=${isDryRun}\n`);

      // --- Phase 1: Compare lossless-claw conversation IDs with Neo4j ---
      push("## Phase 1: Conversation ↔ Neo4j entity cross-reference\n");
      let neo4jMsgNodes = 0;
      let orphanNodes = 0;
      let orphanedIds: string[] = [];

      // 会话存在性判定必须以**消息源**为准，且取两个来源的并集：
      //   lcmg_import 以官方 transcript_events 为权威源，其 session_id 未必出现在 lcm.db 的
      //   conversations 表里；若只查 lcm.db，这些会话会被误判为孤儿，进而在 repair 下被删除。
      // 轻量读取（sessionsOnly）：只查 session_windows / conversations，不读消息体、不解压。
      const existingSids = new Set<string>();
      let sourceSessions = 0;
      try {
        const sessLoad = await loadMessageSourceSessions({ sessionsOnly: true });
        sourceSessions = sessLoad.sessions.length;
        for (const s of sessLoad.sessions) {
          if (s.sessionId) existingSids.add(String(s.sessionId));
          if (s.sessionKey) existingSids.add(String(s.sessionKey));
        }
        push(`  message source: ${sessLoad.source}; sessions: ${sourceSessions}\n`);
        for (const err of sessLoad.errors) push(`  ⚠ ${err}\n`);
      } catch (e: any) { push(`  ❌ message source: ${e.message}\n`); }

      // 并集补充 lcm.db（官方源与 lcm.db 并存时，任一登记过该会话即视为存在）
      let db: any = null;
      try {
        db = openDb();
        const convs = db.prepare("SELECT DISTINCT session_id, session_key FROM conversations").all() as any[];
        for (const c of convs) {
          if (c.session_id) existingSids.add(String(c.session_id));
          if (c.session_key) existingSids.add(String(c.session_key));
        }
        push(`  known sessions (official ∪ lcm.db): ${existingSids.size}\n`);
      } catch (e: any) { push(`  ❌ lcm.db: ${e.message}\n`); }
      finally { if (db) { try { db.close(); } catch {} } }

      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const { driver, session } = await neo4jSession();
        try {
          // Find Neo4j nodes with sessionId property
          const allMsgNodes = await session.run(
            `MATCH (n:ConversationMessage) RETURN n.id AS id, n.sessionId AS sid, n.sessionKey AS skey LIMIT 5000`
          );
          neo4jMsgNodes = allMsgNodes.records.length;
          push(`  Neo4j: ${neo4jMsgNodes} ConversationMessage nodes\n`);

          if (existingSids.size === 0) {
            // 安全护栏：两个来源都没读到会话清单时，绝不能把全图消息判为孤儿
            // （否则一次 repair 会清空消息节点）。宁可跳过并如实说明。
            push(`  ⚠️ No session catalog available from any source → orphan detection SKIPPED (refusing to treat all nodes as orphans)\n`);
          } else {
            for (const rec of allMsgNodes.records) {
              const sid = rec.get("sid") ? String(rec.get("sid")) : "";
              const skey = rec.get("skey") ? String(rec.get("skey")) : "";
              if (!sid && !skey) continue; // 无任何会话标识 → 不参与孤儿判定
              const known = (sid && existingSids.has(sid)) || (skey && existingSids.has(skey));
              if (!known) {
                orphanNodes++;
                orphanedIds.push(rec.get("id") ?? sid ?? skey);
              }
            }
          }
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { push(`  ❌ Neo4j: ${e.message}\n`); }

      if (orphanNodes > 0) {
        push(`  ⚠️ ${orphanNodes} orphaned Neo4j nodes (session absent from message source: official transcript ∪ lcm.db)\n`);
        if (orphanedIds.length <= 5) {
          for (const id of orphanedIds) push(`    - ${id}\n`);
        } else {
          push(`    First 5: ${orphanedIds.slice(0, 5).join(", ")}...\n`);
        }
      } else {
        push(`  ✅ No orphaned nodes found\n`);
      }

      // --- N-1 Phase 1.5: 消息 createdAt 逐条校验（按契约 id 映射） ---
      // 官方逻辑：会话消息的权威源是官方 SQLite 转录（其次 lcm.db 镜像）；
      // Neo4j 侧只由 lcmg_import 写契约字段 createdAt。
      // 旧实现的两个错误：
      //   1) 比对 `updatedAt` —— 没有任何写者写该字段，匹配恒为 0 行、repair 永不执行；
      //   2) 用「每会话 MAX(created_at)」对「每节点 updatedAt」，属跨粒度比较
      //      （即便字段存在，除最新一条外每条都会"漂移"）。
      // 现改为：对源消息复用 gm-message-contract 的 plan 规则算出契约 id，
      // 再按 id **逐条**比对 createdAt。
      push("\n## Phase 1.5: message createdAt drift (per-message, contract id)\n");
      const DRIFT_TOLERANCE_MS = 60_000; // 容忍写入延迟
      let driftCount = 0;
      const driftIds: string[] = [];
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const src = await loadMessageSourceSessions();
        if (src.sessions.length === 0) {
          push("  ⚠️ No message source available（官方 transcript_events 与 lcm.db 均无数据）；skip drift check\n");
        } else {
          // 源消息 → 契约 id + createdAt（与导入完全同一套 plan 规则，故 id 可直接对齐）
          const expected: Array<{ id: string; ts: number }> = [];
          for (const sess of src.sessions) {
            for (const row of planGmMessageRows(sess.msgs, sess.sessionKey).rows) {
              expected.push({ id: row.id, ts: row.createdAt });
            }
          }
          push(`  Source: ${src.source}; mapped messages: ${expected.length}\n`);

          const { driver, session } = await neo4jSession();
          try {
            // 索引化单遍扫描（性能修复）。
            // 旧实现是 `UNWIND $ids AS id MATCH (n {id: id})`：**不带 label 的属性匹配无法命中
            // 任何索引** —— 本库的 id 唯一约束建在 :ConversationMessage(id) / :GmMessage(id) 上，
            // 于是 Neo4j 退化为 AllNodesScan：每 500 个 id 就全图扫一遍，
            // 消息量为 M 时总代价 ≈ O(全图节点数 × M/500) → 表现为工具"永不返回"。
            // 现改为按 :ConversationMessage(id) 唯一索引做 keyset 分页：
            // 全图只走一遍、每页都命中索引，并在页间让出事件循环（长任务不再饿死宿主）。
            const expectedMap = new Map<string, number>();
            for (const b of expected) expectedMap.set(b.id, b.ts);
            const PAGE = 1000;
            const driftRows: Array<{ id: string; ts: number }> = [];
            let matched = 0;
            let scanned = 0;
            let lastId = '';
            let pages = 0;
            const scanStartedAt = Date.now();
            for (;;) {
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              const res = await session.run(
                `MATCH (n:ConversationMessage) WHERE n.id > $last
                 RETURN n.id AS id, n.createdAt AS createdAt
                 ORDER BY n.id LIMIT $page`,
                { last: lastId, page: neo4jDriver.int(PAGE) },
              );
              if (res.records.length === 0) break;
              for (const r of res.records) {
                const id = String(r.get("id") ?? '');
                if (!id) continue;
                lastId = id;
                scanned += 1;
                const expTs = expectedMap.get(id);
                if (expTs == null) continue; // 图中有、消息源中无 → 不在本次比对范围
                const cv = r.get("createdAt");
                const actual = typeof cv?.toNumber === 'function' ? cv.toNumber() : Number(cv ?? 0);
                matched += 1;
                if (Math.abs(actual - expTs) > DRIFT_TOLERANCE_MS) {
                  driftCount += 1;
                  if (driftIds.length < 10) driftIds.push(id);
                  driftRows.push({ id, ts: expTs });
                }
              }
              pages += 1;
              // 每 20 页输出一次进度：工具返回值是单次聚合文本，运行中无法回报，
              // 只能走宿主日志，便于判断"是慢还是卡死"。
              if (pages % 20 === 0) {
                getGlobalLogger().info?.(
                  `[lcmg_sync] Phase 1.5 scanning :ConversationMessage … scanned=${scanned} matched=${matched} drift=${driftCount}`,
                );
              }
              // 页间让出事件循环：宿主仍可处理其它请求，abort 也能及时生效
              await new Promise((resolve) => setImmediate(resolve));
            }
            const notPresent = Math.max(0, expected.length - matched);
            push(`  Neo4j scanned: ${scanned} :ConversationMessage via indexed keyset scan (${Date.now() - scanStartedAt}ms, ${pages} pages)\n`);
            push(`  Neo4j matched: ${matched}; not present in graph: ${notPresent}\n`);
            push(`  createdAt drift > ${DRIFT_TOLERANCE_MS / 1000}s: ${driftCount}\n`);
            if (driftIds.length > 0) {
              push(`  Sample drift IDs: ${driftIds.join(", ")}\n`);
            }

            // Repair：以消息源为权威，纠正逐个节点的 createdAt（不再写 updatedAt）。
            // label 必须写死为 :ConversationMessage —— 带 label 才能命中 id 唯一索引。
            if (mode === "repair" && !isDryRun && driftCount > 0) {
              push(`\n  Repairing ${driftCount} drifted nodes (SET createdAt from message source)...\n`);
              let merged = 0;
              try {
                const updates = driftRows.map((d) => ({ id: d.id, ts: neo4jDriver.int(d.ts) }));
                const RB = 500;
                for (let i = 0; i < updates.length; i += RB) {
                  if (signal?.aborted) {
                    return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
                  }
                  const batch = updates.slice(i, i + RB);
                  const result = await session.run(
                    `UNWIND $updates AS u
                     MATCH (n:ConversationMessage {id: u.id})
                     SET n.createdAt = u.ts, n.syncSource = 'message-source', n.syncedAt = timestamp()
                     RETURN count(*) AS c`,
                    { updates: batch },
                  );
                  merged += result.records[0]?.get("c")?.toNumber?.() ?? batch.length;
                  await new Promise((resolve) => setImmediate(resolve));
                }
              } catch (e: any) { push(`  ⚠️ createdAt repair error: ${e.message}\n`); }
              push(`  ✅ Corrected createdAt on ${merged} nodes\n`);
            } else if (mode === "repair" && isDryRun && driftCount > 0) {
              push(`  (Dry run) Would correct createdAt on ${driftCount} nodes\n`);
            } else if (driftCount === 0) {
              push(`  ✅ No message createdAt drift detected\n`);
            }
          } finally { await closeNeo4j(driver, session); }
        }
      } catch (e: any) { push(`  ❌ message createdAt drift check error: ${e.message}\n`); }

      // --- Phase 2: Check TTL-expired nodes (pinned? expired?) ---
      push("\n## Phase 2: TTL & pin status\n");
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const { driver, session } = await neo4jSession();
        try {
          const pinned = await session.run("MATCH (n {pinned: true}) RETURN count(n) AS c");
          push(`  Pinned nodes: ${pinned.records[0].get("c").toNumber()}\n`);
          const expiring = await session.run("MATCH (n) WHERE n.pinned IS NULL OR n.pinned = false RETURN count(n) AS c");
          push(`  Non-pinned (eligible for cleanup): ${expiring.records[0].get("c").toNumber()}\n`);
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { push(`  ❌ Neo4j: ${e.message}\n`); }

      // --- Phase 3: Repair if requested ---
      if (mode === "repair" && !isDryRun && orphanNodes > 0) {
        push("\n## Phase 3: Repairing\n");
        // P0-5 SEC-4: 删除数量上限保护，防止误删大量数据
        const MAX_DELETE = 1000;
        if (orphanNodes > MAX_DELETE) {
          push(`  ❌ Aborted: ${orphanNodes} orphan nodes exceed safety limit (${MAX_DELETE}). Re-run with explicit smaller scope or contact admin.\n`);
        } else {
          try {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            const { driver, session } = await neo4jSession();
            try {
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              for (const id of orphanedIds) {
                // label 必须写死（:ConversationMessage）才能走 id 唯一索引；
                // 无 label 的 `MATCH (n {id: $id})` 会全图扫描。
                await session.run("MATCH (n:ConversationMessage {id: $id}) DETACH DELETE n", { id });
              }
              const deleted = orphanedIds.length;
              // BUGFIX(S1-数据丢失): 原实现额外执行 `MATCH (n:ConversationMessage) WHERE NOT (n)--() DELETE n`
              // —— 语义是"删除所有无关系的 ConversationMessage"，**不限于孤儿**，且 MAX_DELETE 只约束
              // orphanedIds、对该批量删除无任何上限。而 lcmg_import 产出的消息节点在设计上就是无边孤立节点
              // （MENTIONS 边从 :MemoryFile 出发，不从消息出发），且与 :GmMessage 是同一节点
              // → 一次 repair 可清空全部导入语料并连带删掉 rebuild 的源数据。
              // 官方语义（graph-memory-pro）：消息节点是 rebuild 的输入，其生命周期由 GmMessage 会话决定，
              // 与"是否有关系边"无关。故此处**移除**该批量清理：孤儿判定唯一依据是
              // "sessionId 已不在 lcm.db / 官方转录源中"（即上面的 orphanedIds，已受 MAX_DELETE 保护）。
              push(`  ✅ Pruned ${deleted} orphan nodes (scope = sessionId missing from message source; no relationship-based cleanup)\n`);
            } finally { await closeNeo4j(driver, session); }
          } catch (e: any) { push(`  ❌ Repair error: ${e.message}\n`); }
        }
      } else if (mode === "repair" && orphanNodes === 0) {
        push("\n## Phase 3: No repair needed — all consistent\n");
      } else if (mode === "repair" && isDryRun) {
        push("\n## Phase 3: Dry run — would prune " + orphanNodes + " orphan nodes\n");
      }

      push("\n✅ Sync check complete.");
      return {
        content: [{ type: "text" as const, text: lines.join("") }],
        details: {
          ok: true,
          metrics: {
            mode,
            dryRun: isDryRun,
            activeConversations: (() => {
              const m = lines.find(l => l.includes("active conversations"));
              return m ? parseInt((m.match(/(\d+) active conversations/) || [])[1] || '0', 10) : 0;
            })(),
            neo4jMsgNodes,
            orphanedNodes: orphanNodes,
            driftCount,
            pinnedNodes: (() => {
              const m = lines.find(l => l.includes("Pinned nodes:"));
              return m ? parseInt((m.match(/Pinned nodes: (\d+)/) || [])[1] || '0', 10) : 0;
            })(),
          },
        },
      };
    },
  }, { optional: true });
  // ===================================================================
  // 9. lcmg_qmd_status — QMD index health and collection info
  // ===================================================================
  api.registerTool({
    name: "lcmg_qmd_status",
    label: "QMD 状态",
    description: "Query QMD MCP service health: index stats, collection metadata, and uptime.",
    parameters: Type.Object({}),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // SEC-2 H-8: QmdClient 使用 try/finally 确保 dispose 释放 recoveryTimer
      // BUGFIX(P1-4): 复用注入的单例
      let qmd: any = null;
      let qmdOwned = false;
      try {
        const acquired = await acquireQmdClient();
        qmd = acquired.client; qmdOwned = acquired.owned;
        const [pingOk, statusText] = await Promise.all([
          qmd.ping().catch(() => false),
          qmd.status().catch(() => null),
        ]);
        const lines: string[] = [];
        lines.push("# QMD MCP Status\n");
        lines.push(`Health: ${pingOk ? "✅ OK" : "❌ Down"}`);
        if (statusText) {
          lines.push(`\nStatus output:\n${statusText}`);
        } else {
          lines.push("\nStatus: unavailable");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], details: { ok: false, error: `❌ Error: ${e.message}` }, isError: true };
      } finally {
        if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} }
      }
    },
  }, { optional: true });

  // ===================================================================
  // 10. lcmg_get_document — Retrieve a document by path or docid
  // ===================================================================
  api.registerTool({
    name: "lcmg_get_document",
    label: "文档获取",
    description: "Fetch a document from QMD index by file path or docid. Returns full content with fuzzy matching. Use for a SINGLE document. If multiple documents are needed (e.g. several search hits), prefer lcmg_batch_get for one batch call instead of repeated get_document calls.",
    parameters: Type.Object({
      file: Type.String({ description: "File path or docid to retrieve" }),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // SEC-2 H-8: QmdClient 使用 try/finally 确保 dispose 释放 recoveryTimer
      // BUGFIX(P1-4): 复用注入的单例
      let qmd: any = null;
      let qmdOwned = false;
      try {
        const acquired = await acquireQmdClient();
        qmd = acquired.client; qmdOwned = acquired.owned;
        const content = await qmd.get(params.file);
        if (content) {
          return { content: [{ type: "text" as const, text: content }], details: { ok: true } };
        }
        return { content: [{ type: "text" as const, text: `Document not found: ${params.file}` }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], details: { ok: false, error: `❌ Error: ${e.message}` }, isError: true };
      } finally {
        if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} }
      }
    },
  }, { optional: true });

  // ===================================================================
  // 11. lcmg_batch_get — Batch retrieve documents by glob pattern
  // ===================================================================
  api.registerTool({
    name: "lcmg_batch_get",
    label: "批量获取",
    description: "Batch fetch documents from QMD index by glob pattern, comma-separated paths, or docid list. Max 50 docs. PREFER this over repeated lcmg_get_document when fetching several search hits or gathering context across multiple pages — one multi-get call instead of N single calls.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, comma-separated paths, or docid list" }),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // SEC-2 H-8: QmdClient 使用 try/finally 确保 dispose 释放 recoveryTimer
      // BUGFIX(P1-4): 复用注入的单例
      let qmd: any = null;
      let qmdOwned = false;
      try {
        const acquired = await acquireQmdClient();
        qmd = acquired.client; qmdOwned = acquired.owned;
        const results = await qmd.multiGet(params.pattern);
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No documents found for: ${params.pattern}` }], details: { ok: true } };
        }
        const lines = results.map((doc: string, i: number) => `--- Document ${i + 1} ---\n${doc}`);
        return { content: [{ type: "text" as const, text: lines.join("\n\n") }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], details: { ok: false, error: `❌ Error: ${e.message}` }, isError: true };
      } finally {
        if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} }
      }
    },
  }, { optional: true });



  // ===================================================================
  // 12. lcmg_maintain - Trigger graph maintenance pipeline
  // ===================================================================
  api.registerTool({
    name: "lcmg_maintain",
    label: "图谱维护",
    description: "Trigger knowledge graph maintenance: dedup, PageRank, community detection. Also reconciles the compaction debt table (deletes orphaned debts for deleted conversations and tombstones older than 7 days).",
    parameters: Type.Object({}),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const driver = await getNeo4jDriver();
        // P3-3: 复用 graph-adapter 的统一路径解析（去除重复逻辑），并记录实际路径
        const { resolveGmProPath } = await import("./adapters/graph-adapter.js");
        const _resolved = resolveGmProPath();
        getGlobalLogger().info('[lcm-graph-extra] lcmg_maintain loading graph-memory-pro', { path: _resolved.path, source: _resolved.source });
        const GM_PRO_PATH = _resolved.path;

        const gm = await import(GM_PRO_PATH + "/dist/index.js");
        // P2-17: 用 buildGmConfig 统一构建，保留工具的特殊 override
        // (recallMaxNodes:10, pagerankIterations:20 与 GraphAdapter 默认不同)
        const { buildGmConfig } = await import("./adapters/graph-adapter.js");
        const cfg = buildGmConfig(
          resolveNeo4jConfig(getPluginNeo4jConfig()),
          { recallMaxNodes: 10, pagerankIterations: 20 },
        );
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const result = await gm.runMaintenance(driver, cfg);
        const lines = [];
        lines.push("# Graph Maintenance Report");
        lines.push("");
        lines.push("Duration: " + (result?.durationMs ?? 0) + "ms");
        lines.push("Dedup merged: " + (result?.dedup?.mergedCount ?? 0) + " nodes");
        lines.push("PageRank top: " + (result?.pagerank?.topK?.length ?? 0) + " nodes");
        lines.push("Communities detected: " + (result?.community?.communities?.size ?? 0));
        lines.push("Community summaries: " + (result?.communitySummaries ?? 0));

        // P2-孤立修复: 重连孤立的 DAG_Summary 节点（自发现匹配父节点建 HAS_SUMMARY 边）。
        // DAG_Summary 由 gm-pro 生成，部分未建边导致孤立，此处兜底重连。
        let reconnectCount = 0;
        try {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          reconnectCount = await reconnectOrphanedDagSummaries();
          lines.push("DAG_Summary reconnected: " + reconnectCount);
        } catch (reconnectErr) {
          lines.push("DAG_Summary reconnect skipped: " + (reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)));
        }

        // P0-3: 顺带对账债务表 —— 删除孤儿债务与过期墓碑，避免表无限增长。
        // lcmg_maintain 是手动维护入口，应覆盖债务表清理而不仅是图分析。
        try {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const { reconcileDebtTable } = await import("./core/debt-manager.js");
          const r = reconcileDebtTable();
          lines.push("");
          lines.push("Debt table reconciled:");
          lines.push("  Orphans deleted: " + r.orphaned);
          lines.push("  Tombstones deleted: " + r.tombstones);
        } catch (debtErr) {
          lines.push("");
          lines.push("Debt reconcile skipped: " + (debtErr instanceof Error ? debtErr.message : String(debtErr)));
        }

        lines.push("");
        lines.push("[OK] Maintenance complete.");

        const debtReconciled = lines.find(l => l.includes("Orphans deleted"));
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            ok: true,
            metrics: {
              durationMs: result?.durationMs ?? 0,
              dedupMerged: result?.dedup?.mergedCount ?? 0,
              pagerankTopK: result?.pagerank?.topK?.length ?? 0,
              communitiesDetected: result?.community?.communities?.size ?? 0,
              communitySummaries: result?.communitySummaries ?? 0,
              dagSummaryReconnected: reconnectCount,
              orphansDeleted: debtReconciled ? parseInt((debtReconciled.match(/Orphans deleted: (\d+)/) || [])[1] || '0', 10) : 0,
              tombstonesDeleted: debtReconciled ? parseInt((lines.find(l => l.includes("Tombstones deleted"))?.match(/Tombstones deleted: (\d+)/) || [])[1] || '0', 10) : 0,
            },
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: "Maintenance failed: " + msg }], details: { ok: false, error: "Maintenance failed: " + msg }, isError: true };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 13. lcmg_distill —— 手动触发经验蒸馏（PENDING → DISTILLED）
  // ===================================================================
  api.registerTool({
    name: "lcmg_distill",
    label: "经验蒸馏",
    description: "手动触发经验蒸馏。从 PENDING 经验中批量蒸馏为 DISTILLED，调用 LLM 提取结构化经验。limit 控制单次处理数量（工具执行期间主模型会等待结果，建议小批量多次调用，默认 10）。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({
        description: "最大蒸馏数量，默认 10（并发限制下本地 LLM 约 1-3 分钟，避免主模型长时间等待）。最多 200",
        minimum: 1,
        maximum: 200,
      })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      if (!dashboardContext?.runDistillation) {
        return {
          content: [{ type: "text" as const, text: "Error: dashboard context not available" }],
          details: { ok: false, error: "Error: dashboard context not available" },
          isError: true,
        };
      }
      const limit = params.limit ?? 10;
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const result = await dashboardContext.runDistillation(limit);
        // runDistillation 返回 { pending, succeeded, failed, linked, llmModel, llmBaseURL, graphConnected, error, neo4jTotal, neo4jByStatus }
        const r = result as {
          pending?: number; succeeded?: number; failed?: number; linked?: number;
          llmModel?: string; llmBaseURL?: string; graphConnected?: string; error?: string;
          neo4jTotal?: number; neo4jByStatus?: Record<string, number>;
          firstDistillError?: string;
          retriedFailed?: number; skippedFailed?: number; maxRetries?: number;
        } | undefined;
        const pending = r?.pending ?? 0;
        const succeeded = r?.succeeded ?? 0;
        const failed = r?.failed ?? 0;
        const linked = r?.linked ?? 0;
        const llmModel = r?.llmModel ?? 'unknown';
        const graphConnected = r?.graphConnected ?? 'unknown';
        const distillError = r?.error;
        const firstDistillError = r?.firstDistillError;
        const neo4jTotal = r?.neo4jTotal;
        const neo4jByStatus = r?.neo4jByStatus;
        const retriedFailed = r?.retriedFailed ?? 0;
        const skippedFailed = r?.skippedFailed ?? 0;
        const maxRetries = r?.maxRetries ?? 3;

        // 构建结果摘要文本
        const lines: string[] = [];
        lines.push('# Distillation Report');
        lines.push('');
        lines.push(`LLM Model: ${llmModel}`);
        lines.push(`LLM Endpoint: ${r?.llmBaseURL ?? 'unknown'}`);
        lines.push(`Neo4j: ${graphConnected}`);
        lines.push(`Pending experiences: ${pending}`);
        lines.push(`Successfully distilled: ${succeeded}`);
        if (failed > 0) {
          lines.push(`Failed: ${failed} (marked FAILED, will auto-retry up to ${maxRetries} times)`);
        }
        if (retriedFailed > 0) {
          lines.push(`Retried from previous failures: ${retriedFailed} (included in pending)`);
        }
        if (linked > 0) {
          lines.push(`Related links created: ${linked}`);
        }
        // 诊断信息：Neo4j 中的实际节点统计
        if (neo4jTotal !== undefined && neo4jTotal >= 0) {
          lines.push(`Neo4j EXPERIENCE 总数: ${neo4jTotal}`);
          if (neo4jByStatus && Object.keys(neo4jByStatus).length > 0) {
            lines.push(`状态分布: ${JSON.stringify(neo4jByStatus)}`);
          }
        }
        lines.push('');

        // 根据状态给出诊断信息
        if (distillError) {
          // 有明确错误（如 Neo4j 未连接）
          lines.push(`[ERROR] ${distillError}`);
        } else if (graphConnected === 'disconnected') {
          lines.push('[ERROR] Neo4j is not connected. Distillation cannot proceed.');
          lines.push('Check:');
          lines.push('  - Neo4j server is running');
          lines.push('  - openclaw.json neo4j config (url / username / password) is correct');
          lines.push('  - Plugin logs for "Neo4j unavailable" warnings during init');
        } else if (pending === 0) {
          lines.push('[INFO] No pending experiences to distill.');
          lines.push('Pending experiences are created automatically during conversations when');
          lines.push('corrections, failures, or explicit save triggers are detected.');
          lines.push('');
          lines.push('If you have been chatting but see 0 pending, possible causes:');
          lines.push('  - afterTurn hook did not detect experience triggers');
          lines.push('  - expStore was not initialized when afterTurn ran');
          lines.push('  - Neo4j write failed silently (check logs for "saveRaw failed")');
          if (neo4jTotal !== undefined && neo4jTotal > 0) {
            lines.push('');
            lines.push(`[DIAG] Neo4j 有 ${neo4jTotal} 个 EXPERIENCE 节点，但 pending=0。`);
            lines.push('说明节点存在但 status 不是 PENDING。可能是：');
            lines.push('  - 节点已被蒸馏（status=DISTILLED）');
            lines.push('  - 节点 status 为 null（saveRaw 写入异常）');
          } else if (neo4jTotal === 0) {
            lines.push('');
            lines.push('[DIAG] Neo4j 中没有任何 EXPERIENCE 节点。');
            lines.push('说明 backfill 的 saveRaw 写入未生效，或 graphAdapter 连接的数据库不正确。');
          }
        } else if (succeeded === 0 && failed > 0) {
          lines.push('[WARNING] All distillation attempts failed.');
          if (firstDistillError) {
            lines.push('');
            lines.push(`First error: ${firstDistillError}`);
          }
          lines.push('');
          lines.push('Check:');
          lines.push(`  - LLM endpoint is reachable (${r?.llmBaseURL ?? 'unknown'})`);
          lines.push(`  - LLM model name is correct (${llmModel})`);
          lines.push('  - LLM returns valid JSON (not markdown-wrapped)');
          lines.push('  - Plugin logs for detailed error messages');
          lines.push('');
          lines.push(`Failed experiences are marked FAILED and will auto-retry (up to ${maxRetries} times) in subsequent distill runs.`);
          if (skippedFailed > 0) {
            lines.push(`[NOTE] ${skippedFailed} experience(s) have exhausted all ${maxRetries} retries.`);
            lines.push('Run lcmg_distill_retry to reset them back to PENDING for another attempt.');
          }
        } else {
          lines.push(`[OK] Distillation complete: ${succeeded}/${pending} succeeded.`);
          if (failed > 0 && firstDistillError) {
            lines.push(`(${failed} failed, first error: ${firstDistillError})`);
          }
          if (skippedFailed > 0) {
            lines.push('');
            lines.push(`[NOTE] ${skippedFailed} experience(s) have exhausted all ${maxRetries} auto-retries.`);
            lines.push('Run lcmg_distill_retry to reset them for another attempt.');
          }
          // SD-DEF-4: 蒸馏为同步工具，主模型会等待结果。若仍有未处理经验，
          // 提示分批继续，避免用户误以为一次 50/200 条全量处理。
          const _pendingTotal = neo4jByStatus && typeof neo4jByStatus.PENDING === 'number'
            ? neo4jByStatus.PENDING
            : undefined;
          if (_pendingTotal !== undefined && _pendingTotal > pending) {
            lines.push('');
            lines.push(`[INFO] 仍有约 ${_pendingTotal - pending} 条 PENDING 经验未处理（本次仅处理 ${limit} 条）。`);
            lines.push('可再次调用 lcmg_distill（保持小批量），或调整 limit 参数按需加大。');
          }
        }

        // 如果 Neo4j 未连接或存在错误，标记为 isError 让用户在 UI 上看到红色状态
        const hasError = graphConnected === 'disconnected' || !!distillError;

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            ok: !hasError,
            error: hasError ? (distillError || 'Neo4j not connected') : undefined,
            metrics: {
              limit,
              pending,
              succeeded,
              failed,
              linked,
              llmModel,
              graphConnected,
              neo4jTotal: neo4jTotal ?? -1,
              firstDistillError: firstDistillError || '',
              retriedFailed,
              skippedFailed,
              maxRetries,
            },
          },
          isError: hasError,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ Distillation failed: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ Distillation failed: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 13.5 lcmg_distill_retry — 重置 FAILED 经验回 PENDING，允许重新蒸馏
  // ===================================================================
  api.registerTool({
    name: "lcmg_distill_retry",
    label: "重试失败经验",
    description: "重置蒸馏失败的 FAILED 经验回 PENDING 状态，清零重试次数，使其可被 lcmg_distill 重新处理。mode=all 重置所有 FAILED 节点；mode=exhausted 仅重置已耗尽自动重试次数的节点（默认）。",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({
        description: "重置模式：exhausted（默认，仅重置 retryCount >= maxRetries 的节点）或 all（重置所有 FAILED 节点）",
      })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const expStore = dashboardContext?.expStore;
      if (!expStore) {
        return {
          content: [{ type: "text" as const, text: "Error: expStore not available" }],
          details: { ok: false, error: "expStore not available" },
          isError: true,
        };
      }
      const mode = params.mode === 'all' ? 'all' : 'exhausted';
      try {
        // 先统计当前 FAILED 节点情况
        let failedExhausted = 0;
        let failedTotal = 0;
        try {
          if (typeof expStore.countFailedExhausted === 'function') {
            failedExhausted = await expStore.countFailedExhausted();
          }
          if (typeof expStore.countByStatus === 'function') {
            const byStatus = await expStore.countByStatus();
            failedTotal = byStatus?.FAILED ?? 0;
          }
        } catch {
          // 非致命
        }

        const resetCount = typeof expStore.resetFailedToPending === 'function'
          ? await expStore.resetFailedToPending(mode)
          : 0;

        const lines: string[] = [];
        lines.push('# Retry Failed Experiences');
        lines.push('');
        lines.push(`Mode: ${mode}`);
        if (failedTotal > 0 || failedExhausted > 0) {
          lines.push(`FAILED nodes before reset: ${failedTotal} (exhausted: ${failedExhausted})`);
        }
        lines.push(`Reset to PENDING: ${resetCount}`);
        lines.push('');
        if (resetCount > 0) {
          lines.push('[OK] Reset complete. Run lcmg_distill to re-process these experiences.');
        } else {
          lines.push('[INFO] No FAILED nodes were reset.');
          if (mode === 'exhausted' && failedTotal > 0) {
            lines.push(`There are ${failedTotal} FAILED node(s), but none have exhausted retries yet.`);
            lines.push('They will auto-retry in the next lcmg_distill run.');
            lines.push('Use mode=all to reset all FAILED nodes regardless of retry count.');
          } else if (failedTotal === 0) {
            lines.push('There are no FAILED experience nodes to reset.');
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            ok: true,
            metrics: { mode, resetCount, failedTotal, failedExhausted },
          },
          isError: false,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ Reset failed: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ Reset failed: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 13.6 lcmg_backfill — 回溯已有对话记录提取经验
  // ===================================================================
  api.registerTool({
    name: "lcmg_backfill",
    label: "经验回溯",
    description: "从历史对话记录中重新提取经验写入 PENDING 队列。用于修复 graphAdapter 连接问题后补录丢失的经验。处理完成后请运行 lcmg_distill 进行蒸馏。默认跳过已处理过的会话，设置 force=true 可强制重新处理。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({
        description: "最多处理的会话数，默认 20",
        minimum: 1,
        maximum: 500,
      })),
      force: Type.Optional(Type.Boolean({
        description: "是否强制重新处理已处理过的会话（默认 false，跳过已处理）",
      })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      if (!dashboardContext?.backfillExperiences) {
        return {
          content: [{ type: "text" as const, text: "Error: dashboard context not available" }],
          details: { ok: false, error: "Error: dashboard context not available" },
          isError: true,
        };
      }
      const limit = params.limit ?? 20;
      const force = params.force === true;
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const result = await dashboardContext.backfillExperiences(limit, force);
        const lines: string[] = [];
        lines.push('# 经验回溯报告');
        lines.push('');
        lines.push(`处理会话数: ${result.processed}`);
        lines.push(`跳过已处理: ${result.skipped}`);
        lines.push(`提取经验数: ${result.extracted}`);
        // 诊断信息：Neo4j 中的实际节点数
        if (result.neo4jTotal !== undefined) {
          lines.push(`Neo4j 经验总数: ${result.neo4jTotal}`);
          lines.push(`Neo4j PENDING 数: ${result.neo4jPending ?? 0}`);
          if (result.neo4jByStatus && Object.keys(result.neo4jByStatus).length > 0) {
            lines.push(`状态分布: ${JSON.stringify(result.neo4jByStatus)}`);
          }
        }
        if (result.errors.length > 0) {
          lines.push(`错误数: ${result.errors.length}`);
          lines.push('');
          lines.push('## 错误详情');
          for (const err of result.errors.slice(0, 10)) {
            lines.push(`- ${err}`);
          }
          if (result.errors.length > 10) {
            lines.push(`- ... 及其他 ${result.errors.length - 10} 条`);
          }
        }
        lines.push('');
        if (result.extracted > 0 && (result.neo4jPending ?? 0) === 0) {
          lines.push('[WARNING] 提取了经验但 Neo4j PENDING 数为 0！');
          lines.push('这说明 saveRaw 写入失败或写入了错误的数据库。');
          lines.push('请检查日志中的 [backfill] verify 信息。');
        } else if (result.extracted > 0) {
          lines.push('[INFO] 经验已写入 PENDING 队列，请运行 **lcmg_distill** 进行蒸馏。');
        } else if (result.processed === 0 && result.skipped > 0) {
          lines.push('[INFO] 所有会话均已处理过，无新数据。');
          lines.push('如需重新处理，请设置 force=true 强制回溯。');
        } else {
          lines.push('[INFO] 未检测到任何经验触发条件。');
          lines.push('可能原因：');
          lines.push('  - 对话中没有触发纠正/失败/修复/显式保存等关键词');
          lines.push('  - 会话消息数过少（至少需要 2 条消息）');
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            ok: result.errors.length === 0,
            metrics: {
              limit,
              force,
              processed: result.processed,
              skipped: result.skipped,
              extracted: result.extracted,
              errorCount: result.errors.length,
              neo4jTotal: result.neo4jTotal ?? -1,
              neo4jPending: result.neo4jPending ?? 0,
            },
          },
          isError: result.errors.length > 0,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ 回溯失败: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ 回溯失败: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 14. lcmg_compact —— 手动触发指定会话的 compact
  // ===================================================================
  api.registerTool({
    name: "lcmg_compact",
    label: "上下文压缩",
    description: "Trigger context compaction for a session. Without conversationId, processes the most urgent debt.",
    parameters: Type.Object({
      conversationId: Type.Optional(Type.Number({
        description: "目标会话 ID，省略则处理最紧急债务",
      })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      if (!dashboardContext?.triggerCompact) {
        return {
          content: [{ type: "text" as const, text: "Error: dashboard context not available" }],
          details: { ok: false, error: "Error: dashboard context not available" },
          isError: true,
        };
      }
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const ok = await dashboardContext.triggerCompact(params.conversationId);
        const target = params.conversationId != null
          ? `conversation ${params.conversationId}`
          : 'most urgent debt';
        // SD-DEF-4: 语义修正 —— 前台工具调用时主轮门控必然持住，债务调度器会
        // defer（下一轮有余量再后台压缩）。原文案"✅ completed"是假象，误导用户。
        // 检测主轮状态给出诚实反馈：主轮内 → "已排队后台执行"；否则沿用完成语义。
        let _compactDeferred = false;
        try {
          const { isMainTurnActive } = await import('./async/main-turn-gate.js');
          _compactDeferred = isMainTurnActive();
        } catch { /* gate 不可用时维持原行为 */ }
        return {
          content: [{
            type: "text" as const,
            text: ok
              ? (_compactDeferred
                ? `✅ Compact 已排队（后台执行）：当前对话轮进行中，调度器将在轮次间隙完成 ${target} 的压缩。`
                : `✅ Compact completed for ${target}.`)
              : `⚠️ Compact triggered for ${target} but did not produce a summary (may retry).`,
          }],
          details: {
            ok: true,
            metrics: {
              target,
              summaryProduced: ok,
              deferred: _compactDeferred,
              conversationId: params.conversationId ?? null,
            },
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ Compact failed: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ Compact failed: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 15. lcmg_reset_breaker —— 重置指定子系统的熔断器状态
  // ===================================================================
  api.registerTool({
    name: "lcmg_reset_breaker",
    label: "熔断重置",
    description: "重置指定子系统的熔断器状态。name: lcm/qmd/neo4j。neo4j 还会重置 GraphAdapter 连接失败标志，允许立即重试连接。",
    parameters: Type.Object({
      name: Type.String({ description: "子系统名: lcm | qmd | neo4j" }),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const name = params.name;
      if (!['lcm', 'qmd', 'neo4j'].includes(name)) {
        return {
          content: [{ type: "text" as const, text: `Error: 无效的子系统名: ${name}（支持 lcm/qmd/neo4j）` }],
          details: { ok: false, error: `Error: 无效的子系统名: ${name}（支持 lcm/qmd/neo4j）` },
          isError: true,
        };
      }
      try {
        // resetCircuitBreaker 是模块级函数，动态导入避免循环依赖
        const { resetCircuitBreaker } = await import('./circuit-breaker.js');
        const reset = resetCircuitBreaker(name);
        // neo4j 额外重置 graphAdapter 连接标志（通过注入的回调，graphAdapter 在 index.ts 闭包内）
        let adapterReset = false;
        if (name === 'neo4j' && dashboardContext?.resetBreaker) {
          adapterReset = dashboardContext.resetBreaker(name);
        }
        return {
          content: [{
            type: "text" as const,
            text: reset
              ? `✅ Circuit breaker reset for "${name}"${name === 'neo4j' ? (adapterReset ? ' + GraphAdapter connect flag reset' : '') : ''}.`
              : `❌ Failed to reset circuit breaker for "${name}".`,
          }],
          details: {
            ok: reset,
            metrics: {
              name,
              adapterReset,
            },
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ Reset breaker failed: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ Reset breaker failed: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 16. lcmg_config_get —— 查看运行时配置（脱敏）
  // v1.1.0-6: 提供 MCP 工具读取 openclaw.json 配置
  // ===================================================================
  api.registerTool({
    name: "lcmg_config_get",
    label: "配置查看",
    description: "查看 lcm-graph-extra 运行时配置（从 ~/.openclaw/openclaw.json 读取，敏感字段已脱敏）。可选指定 path 参数获取特定字段，例如 'neo4j' 或 'lcmMonitor.contextWindow'。",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "点分路径，例如 'neo4j' 或 'lcmMonitor.contextWindow'。省略则返回全部配置" })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const configPath = join(homedir(), '.openclaw', 'openclaw.json');
        if (!existsSync(configPath)) {
          return {
            content: [{ type: "text" as const, text: `⚠️ 配置文件不存在: ${configPath}` }],
            details: { ok: false, error: 'config file not found' },
          };
        }
        const raw = readFileSync(configPath, 'utf-8');
        // FIX-CR02: 配置文件可能被手工编辑为非合法 JSON，解析失败时返回明确错误
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `⚠️ 配置文件解析失败（非合法 JSON）: ${e?.message ?? String(e)}` }],
            details: { ok: false, error: `JSON parse error: ${e?.message ?? String(e)}` },
            isError: true,
          };
        }
        // 提取 lcm-graph-extra 配置段
        let config: Record<string, unknown>;
        const entriesConfig = parsed?.plugins?.entries?.['lcm-graph-extra']?.config;
        if (entriesConfig && typeof entriesConfig === 'object') {
          config = entriesConfig as Record<string, unknown>;
        } else {
          config = parsed as Record<string, unknown>;
        }

        // 脱敏敏感字段
        const redacted = redactConfigSecrets(config) as Record<string, unknown>;

        // 按路径提取子字段
        let result: unknown = redacted;
        if (params.path) {
          result = getByPathConfig(redacted, params.path);
          if (result === undefined) {
            return {
              content: [{ type: "text" as const, text: `❌ 字段不存在: ${params.path}` }],
              details: { ok: false, error: `field not found: ${params.path}` },
              isError: true,
            };
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: `📋 运行时配置${params.path ? ` (${params.path})` : ''}:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
          }],
          details: { ok: true, config: result, configPath },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ 读取配置失败: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ 读取配置失败: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 17. lcmg_config_set —— 更新配置字段（白名单）
  // v1.1.0-6: 提供 MCP 工具热更新 openclaw.json 中的白名单字段
  // ===================================================================
  api.registerTool({
    name: "lcmg_config_set",
    label: "配置更新",
    description: "更新 lcm-graph-extra 运行时配置（写入 ~/.openclaw/openclaw.json）。仅允许白名单内的性能/行为参数，禁止修改安全相关字段。path 用点分路径如 'lcmMonitor.contextWindow'，value 为新值。部分字段需重启插件进程生效。",
    parameters: Type.Object({
      path: Type.String({ description: "点分路径，如 'maxTokens'、'lcmMonitor.contextWindow'、'compaction.triggerThreshold'、'experience.enabled'" }),
      value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], { description: "新值（number/boolean/string）" }),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const { path: fieldPath, value } = params;
      if (!fieldPath || typeof fieldPath !== 'string') {
        return {
          content: [{ type: "text" as const, text: '❌ path 参数必填' }],
          details: { ok: false, error: 'path is required' },
          isError: true,
        };
      }

      // 白名单校验
      const allowed = CONFIG_UPDATABLE_WHITELIST[fieldPath];
      if (!allowed) {
        const available = Object.keys(CONFIG_UPDATABLE_WHITELIST).sort();
        return {
          content: [{
            type: "text" as const,
            text: `❌ 字段 "${fieldPath}" 不在可更新白名单中。\n\n可更新字段:\n${available.map((p) => `  - ${p}: ${CONFIG_UPDATABLE_WHITELIST[p].description}`).join('\n')}`,
          }],
          details: { ok: false, error: `field not updatable: ${fieldPath}`, allowed: available },
          isError: true,
        };
      }

      // 类型校验
      if (!validateConfigValue(value, allowed.type)) {
        return {
          content: [{ type: "text" as const, text: `❌ 值类型错误: 期望 ${allowed.type}, 实际 ${typeof value}` }],
          details: { ok: false, error: `type mismatch: expected ${allowed.type}, got ${typeof value}` },
          isError: true,
        };
      }

      try {
        const configPath = join(homedir(), '.openclaw', 'openclaw.json');
        // 读取现有配置
        let root: Record<string, unknown> = {};
        if (existsSync(configPath)) {
          root = JSON.parse(readFileSync(configPath, 'utf-8'));
        }
        // 确保路径结构
        if (!root.plugins) root.plugins = {};
        if (!(root.plugins as Record<string, unknown>).entries) {
          (root.plugins as Record<string, unknown>).entries = {};
        }
        const entries = (root.plugins as Record<string, unknown>).entries as Record<string, unknown>;
        if (!entries['lcm-graph-extra']) entries['lcm-graph-extra'] = {};
        const pluginEntry = entries['lcm-graph-extra'] as Record<string, unknown>;
        if (!pluginEntry.config) pluginEntry.config = {};
        const config = pluginEntry.config as Record<string, unknown>;

        // 设置嵌套值
        setByPathConfig(config, fieldPath, value);
        writeFileSync(configPath, JSON.stringify(root, null, 2), 'utf-8');

        return {
          content: [{
            type: "text" as const,
            text: `✅ 配置已更新: ${fieldPath} = ${JSON.stringify(value)}\n\n⚠️ 部分字段需重启插件进程才能生效。`,
          }],
          details: { ok: true, path: fieldPath, value, configPath },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `❌ 更新配置失败: ${e?.message ?? String(e)}` }],
          details: { ok: false, error: `❌ 更新配置失败: ${e?.message ?? String(e)}` },
          isError: true,
        };
      }
    },
  }, { optional: true });

  // ===================================================================
  // 19. lcmg_moa_reply —— MoA 聚合回复透传
  // v2.2.0: MoA (Mixture of Agents) 预计算回复透传工具。
  // 参考模型层（并行发散）+ 聚合模型层（收敛裁决）的结果通过此工具返回。
  // 主模型调用此工具后，工具结果直接作为最终回复返回用户。
  // v2.3.0: 支持 pending 状态——聚合模型异步执行时返回 pending 提示。
  // ===================================================================
  api.registerTool({
    name: "lcmg_moa_reply",
    label: "MoA 聚合回复",
    description: "Get the pre-computed MoA (Mixture of Agents) response synthesized by multiple models. Returns pending status if aggregation is in progress.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      // 延迟导入避免循环依赖
      const { getMoaResultCache, isMoaAggregatorPending } = await import('./moa/orchestrator.js');
      const result = getMoaResultCache();
      if (result) {
        return {
          content: [{ type: "text" as const, text: result }],
          details: { ok: true },
        };
      }
      // 聚合模型仍在后台执行
      if (isMoaAggregatorPending()) {
        return {
          content: [{ type: "text" as const, text: "MoA aggregation is still in progress. The reference models have completed their analysis, and the aggregator model is synthesizing the final response. Please ask the user to continue the conversation in a moment to receive the complete multi-model analysis." }],
          details: { ok: false, status: 'pending', error: 'moa_aggregation_pending' },
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: "No MoA result available. The MoA pipeline may not have been triggered for this request, or the pre-computed response has already been consumed." }],
        details: { ok: false, error: 'no_moa_result' },
        isError: true,
      };
    },
  }, { optional: true });
}

// ---------------------------------------------------------------------------
// v1.1.0-6: 配置工具辅助函数
// ---------------------------------------------------------------------------

/** 敏感字段 key 模式（与 operation-logs.ts redactSensitive 保持一致） */
const CONFIG_SENSITIVE_KEYS = [
  'password', 'passwd', 'pwd',
  'apikey', 'api_key', 'api-key',
  'token', 'secret',
  'credential', 'auth',
];

/** 递归脱敏配置中的敏感字段 */
function redactConfigSecrets(value: unknown, depth: number = 0): unknown {
  if (depth > 10) return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactConfigSecrets(v, depth + 1));
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = CONFIG_SENSITIVE_KEYS.some((p) => lowerKey.includes(p));
    if (isSensitive) {
      result[key] = '***REDACTED***';
    } else {
      result[key] = redactConfigSecrets(obj[key], depth + 1);
    }
  }
  return result;
}

/** 按点分路径获取嵌套值 */
function getByPathConfig(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 按点分路径设置嵌套值 */
function setByPathConfig(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!(p in cur) || typeof cur[p] !== 'object' || cur[p] === null) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** 验证值类型 */
function validateConfigValue(value: unknown, expected: 'number' | 'boolean' | 'string'): boolean {
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'string') return typeof value === 'string';
  return false;
}

/** v1.1.0-6: 可热更新字段白名单 */
const CONFIG_UPDATABLE_WHITELIST: Record<string, { type: 'number' | 'boolean' | 'string'; description: string }> = {
  'summaryStrategy': { type: 'string', description: '摘要策略：strategy | hybrid | full' },
  'maxGraphDepth': { type: 'number', description: '图谱最大遍历深度' },
  'maxNodeCount': { type: 'number', description: '单次检索最大节点数' },
  'maxTokens': { type: 'number', description: '上下文 token 预算' },
  'budgetRatio': { type: 'number', description: '上下文预算占比（0-1）' },
  'distillationIntervalMs': { type: 'number', description: '蒸馏间隔（毫秒）' },
  'cliTimeout': { type: 'number', description: 'CLI 超时（毫秒）' },
  'compaction.triggerThreshold': { type: 'number', description: '触发压缩的消息阈值' },
  'compaction.softThresholdTokens': { type: 'number', description: '软阈值 token 数' },
  'compaction.keepRecentTokens': { type: 'number', description: '保留近期 token 数' },
  'experience.enabled': { type: 'boolean', description: '是否启用经验提取' },
  'experience.relevanceThreshold': { type: 'number', description: '经验相关性阈值（0-1）' },
  'ttl.enabled': { type: 'boolean', description: '是否启用 TTL 清理' },
  'ttl.retentionDays': { type: 'number', description: 'TTL 保留天数' },
  'ttl.cleanupIntervalHours': { type: 'number', description: '清理间隔（小时）' },
  'retrieval.limits.qmd': { type: 'number', description: 'QMD 检索条数' },
  'retrieval.limits.graph': { type: 'number', description: '图谱检索条数' },
  'retrieval.limits.exp': { type: 'number', description: '经验检索条数' },
  'lcmMonitor.contextWindow': { type: 'number', description: '上下文窗口大小（tokens）' },
  'lcmMonitor.highPressureThreshold': { type: 'number', description: '高压阈值（0-1）' },
  'lcmMonitor.mediumPressureThreshold': { type: 'number', description: '中压阈值（0-1）' },
  'lcmMonitor.proactiveThreshold': { type: 'number', description: '主动触发阈值（0-1）' },
};