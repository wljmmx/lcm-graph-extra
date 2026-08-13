/**
 * lcm-graph-extra — Operational tools
 *
 * 工具注册入口。共享基础设施已拆分到 src/tools/shared.ts。
 * 最大工具实现（lcmg_search/lcmg_diagnose/lcmg_sync）已拆分到子模块。
 */

import { Type } from "typebox";
import * as neo4jDriver from 'neo4j-driver';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join, basename, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { exportMarkdownToPdf, exportMarkdownToFile } from './utils/pdf-export.js';
import { getGlobalLogger } from './utils/logger.js';
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
  mergeEntriesNeo4jConfig,
  // registry
  getRegisteredToolHandler, _resetRegisteredToolHandlers, registerToolHandler,
  createAuditWrapper,
  // types
  type DashboardToolContext,
} from './tools/shared.js';

export { getRegisteredToolHandler, _resetRegisteredToolHandlers, closeSharedDb, closeNeo4jDriver, mergeEntriesNeo4jConfig, parseTimeRange };
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
                const r = await mod.getNodesByTimeRange({
                  from: timeFilter.fromTs ?? 0,
                  to: timeFilter.toTs ?? Date.now(),
                  limit: Math.trunc(limitParam),
                  label: 'EXPERIENCE',
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
        // S-8': 当 gm-pro 已返回时间过滤结果时，Cypher 不再叠加时间条件（避免双过滤）
        if (!gmProNodes) {
          if (timeFilter.fromTs) {
            conditions.push("coalesce(e.createdAt, e.updatedAt, 0) >= $fromTs");
            queryParams.fromTs = neo4jDriver.int(timeFilter.fromTs) as any;
          }
          if (timeFilter.toTs) {
            conditions.push("coalesce(e.createdAt, e.updatedAt, 0) <= $toTs");
            queryParams.toTs = neo4jDriver.int(timeFilter.toTs) as any;
          }
        }

        const whereClause = conditions.length > 0 ? " AND " + conditions.join(" AND ") : "";

        // 优先使用 gm-pro 时间范围结果（已过滤，跳过 Cypher 时间过滤）
        let result: any;
        let usedExperienceNodes = false;

        if (gmProNodes && gmProNodes.length > 0) {
          // gm-pro 返回的节点直接构造 records-like 对象供后续 format 处理
          usedExperienceNodes = true;
          result = {
            records: gmProNodes.map((n: any) => ({
              get: (key: string) => {
                if (key === 'e.id') return n.id;
                if (key === 'e.name') return n.title ?? n.name ?? 'Unknown';
                if (key === 'e.description') return n.summary ?? n.description ?? '';
                if (key === 'e.pagerank') return n.pagerank ?? n.relevanceScore ?? 0;
                if (key === 'e.validatedCount') return n.matchCount ?? 0;
                if (key === 'e.communityId') return n.type ?? '';
                if (key === 'createdAt') return n.createdAt;
                if (key === 'solutions') return [];
                if (key === 'relatedIds') return n.relatedIds ?? [];
                return undefined;
              },
            })),
          };
        } else if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        } else {
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
          let query = `MATCH (e:EVENT)
            OPTIONAL MATCH (e)-[r:SOLVED_BY]->(fix:SKILL)
            WITH e, collect({fix: fix, relation: r}) AS solutions
            WHERE size(solutions) > 0 AND ANY(s IN solutions WHERE s.fix IS NOT NULL)`;
          query += whereClause;
          query += ` RETURN e.id, e.name, e.description, e.pagerank, e.validatedCount, e.communityId, solutions
            ORDER BY e.pagerank DESC, e.validatedCount DESC LIMIT $limit`;
          result = await session.run(query, queryParams);
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
        lcm: { conversations: [] }, files: [],
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
          const msgs = db.prepare("SELECT seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq").all(conv.conversation_id) as any[];
          (backup.lcm as any).conversations.push({
            sessionId: conv.session_id,
            messages: msgs.map((m) => ({ seq: m.seq, role: m.role, content: (m.content ?? "").slice(0, 10000) })),
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

      // BUGFIX(P1-5): writeFileSync → fsp.writeFile（大 JSON 同步写会长时间阻塞事件循环）
      await fsp.writeFile(backupPath, JSON.stringify(backup, null, 2), "utf-8");
      const msgCount = (backup.lcm as any).conversations.reduce((a: number, c: any) => a + (c.messages?.length ?? 0), 0);
      const sizeKB = Math.round(JSON.stringify(backup).length / 1024);
      return {
        content: [{
          type: "text" as const,
          text: [
            `✅ Backup saved to: ${backupPath}`,
            `  Neo4j: ${(backup.neo4j as any).entities.length} entities, ${(backup.neo4j as any).relationships.length} relationships`,
            `  lossless-claw: ${(backup.lcm as any).conversations.length} conversations, ${msgCount} messages`,
            `  Files: ${(backup.files as any[]).length} files`,
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
      const data = JSON.parse(readFileSync(safeBackupPath, "utf-8"));
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
          const { driver, session } = await neo4jSession();
          try {
            let nCount = 0, rCount = 0;
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const ent of (data.neo4j as any)?.entities ?? []) {
              // 对齐 gm-pro batchUpsertNodes：重建/恢复知识节点时补齐时序默认字段
              // （recordedAt/validFrom/source/state/scores）。ON CREATE SET 只在新建时
              // 填充默认值，不覆盖备份中已存在的时序数据。
              await session.run(
                "MERGE (n {id: $id}) " +
                "SET n.name = $name, n.labels = $labels " +
                "ON CREATE SET n.recordedAt = $now, n.validFrom = $now, n.source = $source, n.state = 'active', n.scores = $scores",
                { id: ent.id, name: ent.name ?? "", labels: ent.labels ?? [], now: Date.now(), source: 'lcm-restore', scores: '{}' },
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
          const insertMsg = db.prepare("INSERT OR IGNORE INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?)");
          for (const conv of (data.lcm as any)?.conversations ?? []) {
            let convId = 1;
            const exists = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(conv.sessionId ?? "") as any;
            if (exists) {
              convId = exists.conversation_id;
            } else {
              db.prepare("INSERT INTO conversations (session_id, session_key, active, created_at) VALUES (?, 'restored', 1, datetime('now'))").run(conv.sessionId ?? "unknown");
              convId = Number(db.prepare("SELECT last_insert_rowid() as id").get()?.id ?? 1);
            }
            for (const msg of (conv.messages ?? [])) {
              insertMsg.run(convId, msg.seq ?? 0, msg.role ?? "user", msg.content ?? "", (msg.content?.length ?? 0), Date.now());
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
    description: "One-time import of historical data into Neo4j knowledge graph. source=lcm_messages imports chat history, source=memory_files imports *.md files, source=all does both. Uses LLM entity extraction when configured." +
      " Uses LLM entity extraction when configured.",
    parameters: Type.Object({
      source: Type.String({ description: '"lcm_messages", "memory_files", or "all"' }),
      limit: Type.Optional(Type.Number({ description: "Max items to process (default 50)", minimum: 1, maximum: 500 })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const limit = params.limit ?? 50;
      const lines: string[] = [];
      let total = 0;
      let filesImported = 0;

      // lossless-claw 消息导入
      if (params.source === "lcm_messages" || params.source === "all") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let db: any = null;
        try {
          db = openDb();
          const convs = db.prepare("SELECT conversation_id, session_id FROM conversations WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM messages) ORDER BY conversation_id DESC LIMIT ?").all(limit) as any[];
          const { driver, session } = await neo4jSession();
          try {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const conv of convs) {
              const msgs = db.prepare("SELECT seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 5").all(conv.conversation_id) as any[];
              for (const msg of msgs) {
                // 对齐 gm-pro batchUpsertNodes：导入时补齐时序默认字段（ON CREATE SET 仅在新建时填充）。
                await session.run(
                  "MERGE (n:ConversationMessage {id: $id}) " +
                  "SET n.role = $role, n.content = $content, n.sessionId = $sid, n.tokens = $tokens " +
                  "ON CREATE SET n.recordedAt = $now, n.validFrom = $now, n.source = $source, n.state = 'active', n.scores = $scores",
                  { id: `${conv.session_id}-${msg.seq}`, role: msg.role, content: (msg.content ?? "").slice(0, 5000), sid: conv.session_id, tokens: msg.content?.length ?? 0, now: Date.now(), source: 'lcm-import', scores: '{}' }
                );
                total++;
              }
            }
          } finally { await closeNeo4j(driver, session); }
          lines.push(`✅ Imported ${total} messages from lossless-claw DB`);
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
          const { driver, session } = await neo4jSession();
          try {
            const files = existsSync(memDir) ? readdirSync(memDir).filter((f) => f.endsWith(".md")).slice(0, limit) : [];
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            for (const file of files) {
              const content = readFileSync(join(memDir, file), "utf-8").slice(0, 5000);
              await session.run(
                "MERGE (n:MemoryFile {id: $id}) " +
                "SET n.name = $name, n.content = $content " +
                "ON CREATE SET n.recordedAt = $now, n.validFrom = $now, n.source = $source, n.state = 'active', n.scores = $scores",
                { id: `file-${file}`, name: file, content, now: Date.now(), source: 'lcm-import', scores: '{}' },
              );
              // P1-孤立修复: 建立语义关联边 —— 从文件内容提取关键词，与图中
              // 已有 Task/Skill/Event 节点按 name 匹配，创建 MENTIONS 边，
              // 避免 MemoryFile 节点全部孤立于知识图谱之外。
              const keywords = extractMemoryKeywords(content);
              if (keywords.length > 0) {
                try {
                  await session.run(
                    `MATCH (m:MemoryFile {id: $id})
                     MATCH (n:Task|Skill|Event)
                     WHERE n.name IS NOT NULL AND toLower(trim(n.name)) IN $keywords
                     WITH m, n LIMIT $maxLinks
                     MERGE (m)-[r:MENTIONS]->(n)
                       ON CREATE SET r.createdAt = timestamp()
                     RETURN count(r) AS linked`,
                    { id: `file-${file}`, keywords, maxLinks: 10 },
                  );
                } catch (linkErr: any) {
                  lines.push(`⚠ MemoryFile '${file}' semantic link skipped: ${linkErr?.message ?? String(linkErr)}`);
                }
              }
              fCount++;
              filesImported = fCount;
            }
          } finally { await closeNeo4j(driver, session); }
          lines.push(`✅ Imported ${fCount} memory files into Neo4j`);
        } catch (e: any) { lines.push(`❌ memory files import: ${e.message}`); }
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
                  const r = await mod.evolveNode(nodeId, {
                    state: 'superseded',
                    supersededAt: Date.now(),
                    relevanceScore: 0,
                    pagerank: 0,
                  });
                  return r as EvolveResult;
                },
                async () => null, // fallback 不做（由后续 Cypher 处理）
                { label: 'G-10 evolveNode' },
              );
              if (result?.evolved) gmProEvolvedSet.add(nodeId);
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

      let db: any = null;
      try {
        db = openDb();
        const convs = db.prepare("SELECT DISTINCT conversation_id FROM messages").all() as any[];
        push(`  lossless-claw: ${convs.length} active conversations\n`);
      } catch (e: any) { push(`  ❌ lossless-claw: ${e.message}\n`); }
      finally { if (db) { try { db.close(); } catch {} } }

      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const { driver, session } = await neo4jSession();
        try {
          // Find Neo4j nodes with sessionId property
          const allMsgNodes = await session.run(
            `MATCH (n:ConversationMessage) RETURN n.id AS id, n.sessionId AS sid LIMIT 5000`
          );
          neo4jMsgNodes = allMsgNodes.records.length;
          push(`  Neo4j: ${neo4jMsgNodes} ConversationMessage nodes\n`);

          // BUGFIX(P1-6): 批量 IN 查询替代逐行 COUNT，消除 N 次 SQLite 往返
          // SEC-3 H-6: db2 嵌套在 neo4j session 内，需独立 finally 清理
          let db2: any = null;
          try {
            db2 = openDb();
            const allSids = allMsgNodes.records
              .map((r: any) => r.get("sid"))
              .filter((s: any) => s && String(s).trim())
              .map((s: any) => String(s));
            const existingSids = new Set<string>();
            const BATCH = 500; // SQLite IN 参数分批，避免超 999 限制
            for (let i = 0; i < allSids.length; i += BATCH) {
              const batch = allSids.slice(i, i + BATCH);
              const placeholders = batch.map(() => '?').join(',');
              const rows = db2.prepare(
                `SELECT session_id FROM conversations WHERE session_id IN (${placeholders})`
              ).all(...batch) as any[];
              for (const row of rows) existingSids.add(String(row.session_id));
            }
            for (const rec of allMsgNodes.records) {
              const sid = rec.get("sid") ?? "";
              if (sid && !existingSids.has(String(sid))) {
                orphanNodes++;
                orphanedIds.push(rec.get("id") ?? sid);
              }
            }
          } finally { if (db2) { try { db2.close(); } catch {} } }
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { push(`  ❌ Neo4j: ${e.message}\n`); }

      if (orphanNodes > 0) {
        push(`  ⚠️ ${orphanNodes} orphaned Neo4j nodes (session no longer in lcm.db)\n`);
        if (orphanedIds.length <= 5) {
          for (const id of orphanedIds) push(`    - ${id}\n`);
        } else {
          push(`    First 5: ${orphanedIds.slice(0, 5).join(", ")}...\n`);
        }
      } else {
        push(`  ✅ No orphaned nodes found\n`);
      }

      // --- N-1 Phase 1.5: updatedAt timestamp drift detection ---
      // 跨端时间戳一致性校验：对比 lcm.db messages.created_at 与 Neo4j ConversationMessage.updatedAt。
      // 不一致 → 在 repair 模式下增量 MERGE 更新到 Neo4j（以 lcm.db 为权威源）。
      push("\n## Phase 1.5: updatedAt timestamp drift (N-1)\n");
      let driftCount = 0;
      const driftIds: string[] = [];
      let lcmDb2: any = null;
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        const { driver, session } = await neo4jSession();
        try {
          // 取 Neo4j 中所有 ConversationMessage 的 updatedAt 与 sessionId
          const neo4jTsResult = await session.run(
            `MATCH (n:ConversationMessage)
             WHERE n.sessionId IS NOT NULL AND n.updatedAt IS NOT NULL
             RETURN n.id AS id, n.sessionId AS sid, n.updatedAt AS updatedAt, n.content AS content
             LIMIT 5000`
          );
          const neo4jRows = neo4jTsResult.records.map((r: any) => ({
            id: r.get("id"),
            sid: r.get("sid"),
            updatedAt: typeof r.get("updatedAt")?.toNumber === 'function'
              ? r.get("updatedAt").toNumber()
              : Number(r.get("updatedAt") ?? 0),
            content: r.get("content") ?? '',
          }));

          // BUGFIX(P1-6): 批量 GROUP BY 查询替代逐行 SELECT，消除 N 次 SQLite 往返
          // 一次性查出每个 conversation_id 的最新 created_at，内存中对比检测 drift
          const sidToLatestTs = new Map<string, number>();
          try {
            lcmDb2 = openDb();
            const allSids = neo4jRows.filter((r: any) => r.sid).map((r: any) => String(r.sid));
            const BATCH = 500; // SQLite IN 参数分批，避免超 999 限制
            for (let i = 0; i < allSids.length; i += BATCH) {
              const batch = allSids.slice(i, i + BATCH);
              const placeholders = batch.map(() => '?').join(',');
              const rows = lcmDb2.prepare(
                `SELECT conversation_id, MAX(created_at) AS ca FROM messages WHERE conversation_id IN (${placeholders}) GROUP BY conversation_id`
              ).all(...batch) as any[];
              for (const row of rows) {
                if (!row.ca) continue;
                // lcm.db created_at 是 'YYYY-MM-DD HH:MM:SS' 格式，转毫秒时间戳
                const ts = new Date(String(row.ca).replace(' ', 'T') + 'Z').getTime() || 0;
                if (ts > 0) sidToLatestTs.set(String(row.conversation_id), ts);
              }
            }
          } finally { if (lcmDb2) { try { lcmDb2.close(); } catch {} } }

          // 内存中检测 drift（时间戳差异超过 60s 视为 drift，容忍写延迟）
          const driftRows: Array<{ id: string; ts: number }> = [];
          for (const row of neo4jRows) {
            if (!row.sid) continue;
            const lcmTs = sidToLatestTs.get(String(row.sid));
            if (!lcmTs) continue;
            const diffMs = Math.abs(lcmTs - row.updatedAt);
            if (diffMs > 60_000) {
              driftCount++;
              if (driftIds.length < 10) driftIds.push(row.id);
              driftRows.push({ id: row.id, ts: lcmTs });
            }
          }

          push(`  Neo4j ConversationMessage with updatedAt: ${neo4jRows.length}\n`);
          push(`  Timestamp drift > 60s: ${driftCount}\n`);
          if (driftIds.length > 0) {
            push(`  Sample drift IDs: ${driftIds.join(", ")}\n`);
          }

          // N-1 Phase 1.5 repair: 增量 MERGE updatedAt（以 lcm.db 为权威源）
          // BUGFIX(P1-6): UNWIND 批量 MERGE 替代逐条 session.run，复用 check 阶段的 driftRows 无需再查 SQLite
          if (mode === "repair" && !isDryRun && driftCount > 0) {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            push(`\n  Repairing ${driftCount} drifted nodes via MERGE...\n`);
            let merged = 0;
            try {
              const updates = driftRows.map(d => ({ id: d.id, ts: neo4jDriver.int(d.ts) as any }));
              const BATCH = 500;
              for (let i = 0; i < updates.length; i += BATCH) {
                const batch = updates.slice(i, i + BATCH);
                const result = await session.run(
                  `UNWIND $updates AS u
                   MATCH (n:ConversationMessage {id: u.id})
                   SET n.updatedAt = u.ts, n.syncSource = 'lcm-db-merge', n.syncedAt = timestamp()
                   RETURN count(*) AS c`,
                  { updates: batch }
                );
                merged += result.records[0]?.get("c")?.toNumber?.() ?? batch.length;
              }
            } catch (e: any) { push(`  ⚠️ MERGE error: ${e.message}\n`); }
            push(`  ✅ MERGE'd ${merged} nodes with corrected updatedAt\n`);
          } else if (mode === "repair" && isDryRun && driftCount > 0) {
            push(`  (Dry run) Would MERGE ${driftCount} nodes with corrected updatedAt\n`);
          } else if (driftCount === 0) {
            push(`  ✅ No timestamp drift detected\n`);
          }
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { push(`  ❌ updatedAt drift check error: ${e.message}\n`); }

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
                await session.run("MATCH (n {id: $id}) DETACH DELETE n", { id });
              }
              const deleted = orphanedIds.length;
              // P1-6: 批量清理查询逻辑修复。
              // 原查询 `NOT EXISTS { MATCH (m:ConversationMessage) WHERE m.id = n.id } AND n:ConversationMessage`
              // 中，子查询用同一 label 匹配同 id，节点自身即满足 EXISTS，NOT EXISTS 恒为 false，导致清理永远 0 删除。
              // 正确语义：删除那些 id 在 lossless-claw 会话消息表中已不存在的 ConversationMessage 节点。
              // 此处 orphanedIds 已在上面逐个删除，批量清理作为补充：删除剩余无任何关系的孤立 ConversationMessage。
              if (signal?.aborted) {
                return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
              }
              const relCleanup = await session.run(
                `MATCH (n:ConversationMessage) WHERE NOT (n)--() DELETE n`
              );
              // P1-AUDIT: 批量清理结果从 Neo4j result summary 中提取实际删除数，
              // 修复前硬编码 moreDeleted=0，用户无法知道额外清理了多少节点。
              const moreDeleted = (relCleanup?.summary?.counters?.nodesDeleted?.() ?? 0) as number;
              push(`  ✅ Pruned ${deleted} orphan nodes, ${moreDeleted} additional via batch cleanup\n`);
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
    description: "Fetch a document from QMD index by file path or docid. Returns full content with fuzzy matching.",
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
    description: "Batch fetch documents from QMD index by glob pattern, comma-separated paths, or docid list. Max 50 docs.",
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
    description: "手动触发经验蒸馏。从 PENDING 经验中批量蒸馏为 DISTILLED，调用 LLM 提取结构化经验。limit 控制单次处理数量。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({
        description: "最大蒸馏数量，默认 50",
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
      const limit = params.limit ?? 50;
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
        return {
          content: [{
            type: "text" as const,
            text: ok
              ? `✅ Compact completed for ${target}.`
              : `⚠️ Compact triggered for ${target} but did not produce a summary (may retry).`,
          }],
          details: {
            ok: true,
            metrics: {
              target,
              summaryProduced: ok,
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
        const parsed = JSON.parse(raw);
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