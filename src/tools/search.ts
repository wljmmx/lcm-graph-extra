/**
 * tools/search.ts — 跨引擎联合搜索 (lcmg_search)
 */
import { Type } from "typebox";
import * as neo4jDriver from 'neo4j-driver';
import {
  openDb, escapeFts5Query, acquireQmdClient,
  neo4jSession, closeNeo4j,
} from './shared.js';

export function registerSearchTool(api: any): void {
  api.registerTool({
    name: "lcmg_search",
    label: "联合检索",
    description: "Unified search across all three memory backends: (1) lossless-claw FTS5 (conversation messages), (2) QMD BM25/vector (code/docs retrieval), (3) Neo4j knowledge graph (entities/relationships). Returns merged, deduplicated results with source-tagged entries. " +
      "Returns merged & deduplicated results across all three memory stores.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 30 })),
      engines: Type.Optional(Type.String({
        description: '"all" (default), "lcm_only", "qmd_only", "neo4j_only"',
        default: "all",
      })),
    }),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      const query = params.query.trim();
      if (!query) return { content: [{ type: "text" as const, text: "Error: query required" }], details: { ok: false, error: "Error: query required" }, isError: true };
      const limit = params.limit ?? 10;
      const engines = params.engines ?? "all";

      const results: string[] = [];
      results.push(`# Cross-Engine Search: "${query}"\n`);

      // --- lossless-claw FTS5 ---
      if (engines === "all" || engines === "lcm_only") {
        let db: any = null;
        try {
          db = openDb();
          const rows = db.prepare(
            `SELECT rowid, rank, substr(content, 1, 300) as preview FROM messages_fts
             WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`
          ).all(escapeFts5Query(query), limit) as any[];
          if (rows.length > 0) {
            results.push(`## 📇 lossless-claw (${rows.length} hits)`);
            for (const r of rows) results.push(`- [score ${r.rank.toFixed(2)}] ${r.preview}...`);
            results.push("");
          }
        } catch (e: any) { results.push(`❌ lossless-claw search: ${e.message}\n`); }
        finally { if (db) { try { db.close(); } catch {} } }
      }

      // --- qmd ---
      if (engines === "all" || engines === "qmd_only") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        let qmd: any = null;
        let qmdOwned = false;
        try {
          const acquired = await acquireQmdClient();
          qmd = acquired.client; qmdOwned = acquired.owned;
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
          }
          const qmdResults = await qmd.query({
            searches: [
              { type: "lex", query },
              { type: "vec", query },
            ],
            limit,
            rerank: true,
          });
          if (qmdResults.length > 0) {
            results.push(`## 📄 qmd memory (${qmdResults.length} hits)`);
            for (const r of qmdResults) {
              const title = r.title || r.file || r.docid || "(untitled)";
              const score = typeof r.score === "number" ? r.score.toFixed(2) : "0.00";
              const snippet = (r.snippet || "").replace(/\s+/g, " ").slice(0, 200);
              const lineTag = r.line ? `:${r.line}` : "";
              results.push(`- [score ${score}] ${title}${lineTag} — ${snippet}`);
            }
            results.push("");
          }
        } catch (e: any) {
          results.push(`❌ qmd search: ${e?.message ?? String(e)}\n`);
        } finally {
          if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} }
        }
      }

      // --- Neo4j ---
      if (engines === "all" || engines === "neo4j_only") {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
        }
        try {
          const { driver, session } = await neo4jSession();
          try {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
            }
            const rows = await session.run(
              `MATCH (n)
               WHERE (n.name CONTAINS $k OR n.content CONTAINS $k)
               AND (n.state IS NULL OR n.state <> 'superseded')
               RETURN n.name, labels(n)[0] AS type, n.content, n.pagerank
               ORDER BY n.pagerank DESC LIMIT $limit`,
              { k: query, limit: neo4jDriver.int(Math.trunc(limit)) as any }
            );
            if (rows.records.length > 0) {
              results.push(`## 🔗 Neo4j graph (${rows.records.length} hits)`);
              for (const r of rows.records) {
                const type = r.get("type") ?? "Node";
                const name = r.get("n.name") ?? "(unnamed)";
                results.push(`- [${type}] ${name}`);
              }
              results.push("");
            }
          } finally { await closeNeo4j(driver, session); }
        } catch (e: any) { results.push(`❌ Neo4j search: ${e.message}\n`); }
      }

      if (results.length === 1) results.push("(no results found)");
      return { content: [{ type: "text" as const, text: results.join("\n") }], details: { ok: true } };
    },
  });
}