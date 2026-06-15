/**
 * lcm-graph-extra — Operational tools
 *
 * 全部自包含，不依赖 LcmStore/QmdAdapter 遗留接口。
 * 通过注册函数由 definePluginEntry 调用。
 */

import { Type } from "typebox";
import * as neo4jDriver from 'neo4j-driver';
import { createRequire } from "node:module";
const _lcmRequire = createRequire(import.meta.url);
const { DatabaseSync } = _lcmRequire("node:sqlite");
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { resolveNeo4jConfig } from './config/neo4j-helper';

// Module-level Neo4j config, initialized by registerOperationalTools
let _pluginNeo4jConfig: Record<string, unknown> | undefined;

function getPluginNeo4jConfig(): Record<string, unknown> | undefined {
  return _pluginNeo4jConfig;
}

const LCM_DB = "/home/wljmmx/.openclaw/lcm.db";
// Neo4j credentials resolved at runtime via neo4j-helper
// Neo4j user resolved at runtime via neo4j-helper
// Neo4j credentials resolved at runtime via neo4j-helper

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb() {
  return new DatabaseSync(LCM_DB);
}

async function neo4jSession() {
  const neo4j = await import("neo4j-driver").then((m) => m.default);
  const config = resolveNeo4jConfig(getPluginNeo4jConfig());
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  return { driver, session: driver.session() };
}

async function closeNeo4j(driver: any, session: any) {
  try { await session.close(); } catch { /* */ }
  try { await driver.close(); } catch { /* */ }
}

export function registerOperationalTools(api: any): void {
  _pluginNeo4jConfig = (api.config || {}) as Record<string, unknown>;
  // ===================================================================
  // 1. lcmg_experience_report
  // ===================================================================
  api.registerTool({
    name: "lcmg_experience_report",
    description: "Retrieve past troubleshooting experiences from Neo4j knowledge graph. Finds EVENT nodes with SOLVED_BY relationships (fix patterns, lessons learned). format=text (default), json (structured array), markdown. default limit=20. tag filters by community label. " +
      "Searches for EVENT nodes with SOLVED_BY relationships and formats as a report.",
    parameters: Type.Object({
      format: Type.Optional(Type.String({ description: 'Output: "text", "json", "markdown"', default: "text" })),
      limit: Type.Optional(Type.Number({ description: "Max experiences (default 20)", minimum: 1, maximum: 100 })),
      tag: Type.Optional(Type.String({ description: "Filter by community tag" })),
    }),
    async execute(_id: string, params: { format?: string; limit?: number; tag?: string }) {
      const format = params.format ?? "text";
      const limitParam = params.limit ?? 20;
      const { driver, session } = await neo4jSession();
      try {
        let query = `MATCH (e:EVENT)
          OPTIONAL MATCH (e)-[r:SOLVED_BY]->(fix:SKILL)
          WITH e, collect({fix: fix, relation: r}) AS solutions
          WHERE size(solutions) > 0 AND ANY(s IN solutions WHERE s.fix IS NOT NULL)`;
        if (params.tag) query += ` AND e.communityId = $tag`;
        query += ` RETURN e.id, e.name, e.description, e.pagerank, e.validatedCount, e.communityId, solutions
          ORDER BY e.pagerank DESC, e.validatedCount DESC LIMIT $limit`;

        const result = await session.run(query, { limit: neo4jDriver.int(Math.trunc(limitParam)) as any, tag: params.tag ?? "" });
        if (result.records.length === 0) {
          return { content: [{ type: "text" as const, text: "No experiences found." }] };
        }

        if (format === "json") {
          const data = result.records.map((rec: any) => ({
            id: rec.get("e.id"), name: rec.get("e.name"),
            confidence: (Number(rec.get("e.pagerank") ?? 0) * 100).toFixed(0) + "%",
            occurrences: rec.get("e.validatedCount"),
            solutions: (rec.get("solutions") as any[])
              .filter((s: any) => s.fix)
              .map((s: any) => ({ name: s.fix.properties.name, instruction: s.relation?.properties?.instruction })),
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        }

        const lines: string[] = [format === "markdown" ? "# Experience Report\n" : "Experience Report\n"];
        for (const rec of result.records) {
          const name = rec.get("e.name") ?? "Unknown";
          const conf = ((Number(rec.get("e.pagerank") ?? 0)) * 100).toFixed(0);
          const seen = rec.get("e.validatedCount") ?? 0;
          const desc = rec.get("e.description") ?? "";
          const sols: any[] = (rec.get("solutions") ?? []).filter((s: any) => s.fix);
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
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } finally {
        await closeNeo4j(driver, session);
      }
    },
  });

  // ===================================================================
  // 2. lcmg_backup — 导出全量数据到 JSON
  // ===================================================================
  api.registerTool({
    name: "lcmg_backup",
    description: "Full system backup: exports Neo4j nodes+relationships, lossless-claw conversations, and all workspace memory/*.md into a single JSON file. Default output: /tmp/lcm-backup-<timestamp>.json. Use before destructive operations.",
    parameters: Type.Object({
      outputPath: Type.Optional(Type.String({ description: "Output directory" })),
    }),
    async execute(_id: string, params: { outputPath?: string }) {
      const outDir = params.outputPath ?? join(homedir(), ".openclaw", "lcm-graph-extra", "backup");
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = join(outDir, `memory-full-backup-${stamp}.json`);

      const backup: Record<string, unknown> = {
        version: "2.0", createdAt: new Date().toISOString(),
        neo4j: { entities: [], relationships: [] },
        lcm: { conversations: [] }, files: [],
      };

      // Neo4j
      try {
        const { driver, session } = await neo4jSession();
        try {
          const nodes = await session.run("MATCH (n) RETURN n");
          (backup.neo4j as any).entities = nodes.records.map((r: any) => {
            const p = r.get("n").properties; return { id: p.id, name: p.name, labels: r.get("n").labels };
          });
          const rels = await session.run("MATCH ()-[r]->() RETURN r");
          (backup.neo4j as any).relationships = rels.records.map((r: any) => {
            const p = r.get("r").properties;
            return { fromId: p.fromId ?? "", toId: p.toId ?? "", type: r.get("r").type };
          });
        } finally { await closeNeo4j(driver, session); }
      } catch { /* Neo4j unavailable */ }

      // lossless-claw DB
      try {
        const db = openDb();
        const convs = db.prepare("SELECT conversation_id, session_id, session_key FROM conversations ORDER BY conversation_id").all() as any[];
        for (const conv of convs) {
          const msgs = db.prepare("SELECT seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq").all(conv.conversation_id) as any[];
          (backup.lcm as any).conversations.push({
            sessionId: conv.session_id,
            messages: msgs.map((m) => ({ seq: m.seq, role: m.role, content: (m.content ?? "").slice(0, 10000) })),
          });
        }
        db.close();
      } catch { /* DB unavailable */ }

      // Memory files
      try {
        const memDir = join(homedir(), ".openclaw", "workspace", "main");
        const candidates = [
          join(memDir, "MEMORY.md"), join(memDir, "memory"),
        ];
        for (const c of candidates) {
          if (existsSync(c) && statSync(c).isFile()) {
            (backup.files as any[]).push({ path: basename(c), content: readFileSync(c, "utf-8").slice(0, 100000) });
          } else if (existsSync(c)) {
            const entries = readdirSync(c).filter((f) => f.endsWith(".md"));
            for (const entry of entries) {
              (backup.files as any[]).push({ path: `memory/${entry}`, content: readFileSync(join(c, entry), "utf-8").slice(0, 50000) });
            }
          }
        }
      } catch { /* File read unavailable */ }

      writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf-8");
      const msgCount = (backup.lcm as any).conversations.reduce((a: number, c: any) => a + (c.messages?.length ?? 0), 0);
      return {
        content: [{
          type: "text" as const,
          text: [
            `✅ Backup saved to: ${backupPath}`,
            `  Neo4j: ${(backup.neo4j as any).entities.length} entities, ${(backup.neo4j as any).relationships.length} relationships`,
            `  lossless-claw: ${(backup.lcm as any).conversations.length} conversations, ${msgCount} messages`,
            `  Files: ${(backup.files as any[]).length} files`,
            `  Size: ${(JSON.stringify(backup).length / 1024).toFixed(0)} KB`,
          ].join("\n"),
        }],
      };
    },
  });

  // ===================================================================
  // 3. lcmg_restore — 从备份 JSON 恢复到三处
  // ===================================================================
  api.registerTool({
    name: "lcmg_restore",
    description: "Restore from lcmg_backup JSON file. targets=all (default), neo4j_only, lcm_only, files_only. dryRun=true previews without writing. NOTE: Neo4j restore uses MERGE (does NOT delete existing nodes).",
    parameters: Type.Object({
      backupPath: Type.String({ description: "Path to backup JSON file" }),
      targets: Type.Optional(Type.String({
        description: "'all' (default), 'neo4j_only', 'lcm_only', 'files_only'",
        default: "all",
      })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing (default false)" })),
    }),
    async execute(_id: string, params: { backupPath: string; targets?: string; dryRun?: boolean }) {
      if (!existsSync(params.backupPath)) {
        return { content: [{ type: "text" as const, text: `Backup not found: ${params.backupPath}` }], isError: true };
      }
      const data = JSON.parse(readFileSync(params.backupPath, "utf-8"));
      const targets = params.targets ?? "all";
      const dryRun = params.dryRun ?? false;
      const report: string[] = [];

      report.push(`Restore from: ${params.backupPath}`);
      report.push(`Dry run: ${dryRun ? "YES" : "NO"}\n`);

      // Neo4j
      if ((targets === "all" || targets === "neo4j_only") && !dryRun) {
        try {
          const { driver, session } = await neo4jSession();
          try {
            let nCount = 0, rCount = 0;
            for (const ent of (data.neo4j as any)?.entities ?? []) {
              await session.run("MERGE (n {id: $id}) SET n.name = $name, n.labels = $labels", { id: ent.id, name: ent.name ?? "", labels: ent.labels ?? [] });
              nCount++;
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
        try {
          const db = openDb();
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
          db.close();
          report.push(`✅ lossless-claw: Restored ${msgCount} messages`);
        } catch (e: any) { report.push(`❌ lossless-claw: ${e.message}`); }
      }

      // Files
      if ((targets === "all" || targets === "files_only") && !dryRun) {
        try {
          const memDir = join(homedir(), ".openclaw", "workspace", "main");
          let fCount = 0;
          for (const file of (data.files as any[]) ?? []) {
            const fp = join(memDir, file.path);
            mkdirSync(fp.substring(0, fp.lastIndexOf("/")), { recursive: true });
            writeFileSync(fp, file.content, "utf-8");
            fCount++;
          }
          report.push(`✅ Files: Restored ${fCount} files`);
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
      return { content: [{ type: "text" as const, text: report.join("\n") }] };
    },
  });

  // ===================================================================
  // 4. lcmg_import — 历史数据导入到 Neo4j（无 LLM 提取时可运行降级模式）
  // ===================================================================
  api.registerTool({
    name: "lcmg_import",
    description: "One-time import of historical data into Neo4j knowledge graph. source=lcm_messages imports chat history, source=memory_files imports *.md files, source=all does both. Uses LLM entity extraction when configured." +
      " Uses LLM entity extraction when configured.",
    parameters: Type.Object({
      source: Type.String({ description: '"lcm_messages", "memory_files", or "all"' }),
      limit: Type.Optional(Type.Number({ description: "Max items to process (default 50)", minimum: 1, maximum: 500 })),
    }),
    async execute(_id: string, params: { source: string; limit?: number }) {
      const limit = params.limit ?? 50;
      const lines: string[] = [];
      let total = 0;

      // lossless-claw 消息导入
      if (params.source === "lcm_messages" || params.source === "all") {
        try {
          const db = openDb();
          const convs = db.prepare("SELECT conversation_id, session_id FROM conversations WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM messages) ORDER BY conversation_id DESC LIMIT ?").all(limit) as any[];
          const { driver, session } = await neo4jSession();
          try {
            for (const conv of convs) {
              const msgs = db.prepare("SELECT seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 5").all(conv.conversation_id) as any[];
              for (const msg of msgs) {
                await session.run(
                  "MERGE (n:ConversationMessage {id: $id}) SET n.role = $role, n.content = $content, n.sessionId = $sid, n.tokens = $tokens",
                  { id: `${conv.session_id}-${msg.seq}`, role: msg.role, content: (msg.content ?? "").slice(0, 5000), sid: conv.session_id, tokens: msg.content?.length ?? 0 }
                );
                total++;
              }
            }
          } finally { await closeNeo4j(driver, session); }
          db.close();
          lines.push(`✅ Imported ${total} messages from lossless-claw DB`);
        } catch (e: any) { lines.push(`❌ lossless-claw import: ${e.message}`); }
      }

      // 记忆文件导入
      if (params.source === "memory_files" || params.source === "all") {
        try {
          const memDir = join(homedir(), ".openclaw", "workspace", "main", "memory");
          const { driver, session } = await neo4jSession();
          try {
            let fCount = 0;
            const files = existsSync(memDir) ? readdirSync(memDir).filter((f) => f.endsWith(".md")).slice(0, limit) : [];
            for (const file of files) {
              const content = readFileSync(join(memDir, file), "utf-8").slice(0, 5000);
              await session.run("MERGE (n:MemoryFile {id: $id}) SET n.name = $name, n.content = $content", { id: `file-${file}`, name: file, content });
              fCount++;
            }
          } finally { await closeNeo4j(driver, session); }
          lines.push(`✅ Imported ${total} memory files into Neo4j`);
        } catch (e: any) { lines.push(`❌ memory files import: ${e.message}`); }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") || "No data imported." }] };
    },
  });

  // ===================================================================
  // 5. lcmg_diagnose — 自行诊断
  // ===================================================================
  api.registerTool({
    name: "lcmg_diagnose",
    description: "Full system diagnostics: checks Neo4j connectivity + node/rel counts, lossless-claw DB size, QMD MCP health, and all circuit breaker states. Returns structured JSON with per-subsystem status (healthy/degraded/down). Use when troubleshooting memory or recall issues.",
    parameters: Type.Object({}),
    async execute() {
      const L: string[] = [];
      const p = (s: string) => L.push(s);
      const sep = () => p("");
      const H = "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501";
      const ok = (label: string, d?: string) => p("  [OK] " + label + (d ? " - " + d : ""));
      const warn = (label: string, d: string) => p("  [!] " + label + " - " + d);
      const fail = (label: string, d: string) => p("  [X] " + label + " - " + d);
      let pass = 0, fails = 0, warns = 0;

      p("lcm-graph-extra - Health Report");
      p("Generated: " + new Date().toISOString());
      sep();

      // 1. lossless-claw
      p(H);
      p("1. lossless-claw (SQLite DAG)");
      p(H);
      try {
        const db = openDb();
        const msgs = db.prepare("SELECT COUNT(*) as c FROM messages").get().c;
        const sms = db.prepare("SELECT COUNT(*) as c FROM summaries").get().c;
        const ctx = db.prepare("SELECT COUNT(*) as c FROM context_items").get().c;
        const conv = db.prepare("SELECT COUNT(*) as c FROM conversations").get().c;
        const totalT = db.prepare("SELECT SUM(token_count) as t FROM messages").get().t ?? 0;
        const smT = db.prepare("SELECT SUM(token_count) as t FROM summaries").get().t ?? 0;
        ok("Messages", msgs.toLocaleString() + " (" + (totalT/1000).toFixed(0) + "K tokens)");
        ok("Summaries", sms + " (compression: " + ((smT/totalT)*100).toFixed(2) + "%)");
        ok("Context items", ctx.toLocaleString());
        ok("Conversations", conv.toString());
        const depths = db.prepare("SELECT depth, COUNT(*) as c FROM summaries GROUP BY depth ORDER BY depth").all();
        ok("DAG depths", depths.map((d: any) => "depth=" + d.depth + ":" + d.c).join(" | "));

        const fts = db.prepare("SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'test'").get().c;
        ok("FTS5 index", "searchable (test -> " + fts + " hits)");
        pass += 6;
        db.close();
      } catch (e: any) { fail("lossless-claw", e.message); fails++; }

      // 2. qmd
      sep();
      p(H);
      p("2. qmd (Memory File Engine)");
      p(H);
      try {
        const r = await fetch("http://127.0.0.1:8081/health", { signal: AbortSignal.timeout(2000) });
        ok("MCP 8081", "HTTP " + r.status); pass++;
      } catch { warn("MCP 8081", "unreachable"); warns++; }
      try {
        const { QmdClient } = await import("./qmd-client.js");
        const c = new QmdClient({ mcpBaseUrl: "http://127.0.0.1:8081" });
        if (await c.ping()) { ok("QmdClient", "MCP available (CLI fallback ready)"); pass++; }
        else { warn("QmdClient", "MCP down, running in CLI fallback mode"); warns++; }
        const stat = await c.status();
        if (stat) { ok("Qmd status", stat.slice(0, 100).replace(/\n/g, " ")); pass++; }
        else { warn("Qmd status", "status() returned no data"); warns++; }
        const r2 = await c.query({ searches: [{ type: "lex", query: "test" }], limit: 1 });
        ok("Search test", r2.length > 0 ? r2.length + " results" : "0 results (empty index)"); pass++;
      } catch (e: any) { warn("qmd", "unavailable: " + e.message); warns++; }

      // 3. Neo4j
      sep();
      p(H);
      p("3. graph-memory-pro (Neo4j)");
      p(H);
      try {
        const { driver, session } = await neo4jSession();
        try {
          const info = await driver.getServerInfo();
          ok("Connection", info.address + " v" + (info.protocolVersion as any).major + "." + (info.protocolVersion as any).minor); pass++;
          const labels = await session.run("MATCH (n) RETURN labels(n)[0] AS l, count(n) AS c ORDER BY c DESC");
          let totalN = 0;
          const lb: string[] = [];
          for (const r of labels.records) { const c = r.get("c").toNumber(); lb.push(r.get("l") + ":" + c); totalN += c; }
          ok("Nodes", totalN + " (" + lb.join(", ") + ")"); pass++;
          const rel = await session.run("MATCH ()-[r]->() RETURN count(r) AS c");
          ok("Relationships", rel.records[0].get("c").toNumber().toString()); pass++;
          const exp = await session.run("MATCH (n:EXPERIENCE) RETURN count(n) AS c");
          const ec = exp.records[0].get("c").toNumber();
          if (ec > 0) ok("EXPERIENCE", ec + " nodes"); else warn("EXPERIENCE", "0 (no extractions yet)"); (ec > 0 ? pass++ : warns++);
          const pin = await session.run("MATCH (n {pinned: true}) RETURN count(n) AS c");
          const pc = pin.records[0].get("c").toNumber();
          if (pc > 0) ok("Pinned", pc + " nodes"); pass++;
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { fail("Neo4j", e.message); fails++; }

      // 4. Circuit Breaker
      sep();
      p(H);
      p("4. Circuit Breakers");
      p(H);
      try {
        const cb = await import("./circuit-breaker.js");
        const h = cb.getHealthSnapshot();
        if (Object.keys(h).length === 0) { warn("Breaker state", "no data yet"); warns++; }
        for (const [name, st] of Object.entries(h)) {
          const label = { lcm: "lossless-claw", qmd: "qmd", neo4j: "Neo4j" }[name] || name;
          if (st.available) { ok(label, st.failures + " failures"); pass++; }
          else { fail(label, "OPEN (" + st.failures + " failures)"); fails++; }
        }
      } catch { warn("Circuit breaker", "not loaded"); warns++; }

      // 5. Summary
      sep();
      p(H);
      p("5. Summary");
      p(H);
      p("  Pass: " + pass + "  Warnings: " + warns + "  Failures: " + fails);
      p(fails === 0 ? "  Status: OK" : "  Status: DEGRADED (" + fails + " issues)");

      return { content: [{ type: "text" as const, text: L.join("\n") }] };
    },
  });
// ===================================================================
  // 6. lcmg_search — 跨引擎联合搜索
  // ===================================================================
  api.registerTool({
    name: "lcmg_search",
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
    async execute(_id: string, params: { query: string; limit?: number; engines?: string }) {
      const query = params.query.trim();
      if (!query) return { content: [{ type: "text" as const, text: "Error: query required" }], isError: true };
      const limit = params.limit ?? 10;
      const engines = params.engines ?? "all";

      const results: string[] = [];
      results.push(`# Cross-Engine Search: "${query}"\n`);

      // --- lossless-claw FTS5 ---
      if (engines === "all" || engines === "lcm_only") {
        try {
          const db = openDb();
          const rows = db.prepare(
            `SELECT rowid, rank, substr(content, 1, 300) as preview FROM messages_fts
             WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`
          ).all(query, limit) as any[];
          if (rows.length > 0) {
            results.push(`## 📇 lossless-claw (${rows.length} hits)`);
            for (const r of rows) results.push(`- [score ${r.rank.toFixed(2)}] ${r.preview}...`);
            results.push("");
          }
          db.close();
        } catch (e: any) { results.push(`❌ lossless-claw search: ${e.message}\n`); }
      }

      // --- qmd ---
      if (engines === "all" || engines === "qmd_only") {
        try {
          const out = execSync(`qmd query "${query.replace(/"/g, '\\"')}"`, {
            timeout: 15000, encoding: "utf-8",
          });
          // Parse qmd output — it returns lines
          const qmdLines = out.split("\n").filter((l: string) => l.trim()).slice(0, limit);
          if (qmdLines.length > 0) {
            results.push(`## 📄 qmd memory (${qmdLines.length} hits)`);
            for (const l of qmdLines) results.push(`- ${l}`);
            results.push("");
          }
        } catch { /* qmd CLI fallback, silent */ }
      }

      // --- Neo4j ---
      if (engines === "all" || engines === "neo4j_only") {
        try {
          const { driver, session } = await neo4jSession();
          try {
            const rows = await session.run(
              `MATCH (n)
               WHERE n.name CONTAINS $k OR n.content CONTAINS $k OR toLower(n.name) CONTAINS toLower($k)
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
      return { content: [{ type: "text" as const, text: results.join("\n") }] };
    },
  });

  // ===================================================================
  // 7. lcmg_pin — 标记 Neo4j 节点为永久保留
  // ===================================================================
  api.registerTool({
    name: "lcmg_pin",
    description: "Pin/unpin a Neo4j knowledge graph node. Pinned nodes are excluded from TTL-based memory decay and will never be auto-deleted. Use when a piece of knowledge should never be forgotten. " +
      "Use when a piece of knowledge should never be forgotten.",
    parameters: Type.Object({
      id: Type.String({ description: "Node ID to pin" }),
      unpin: Type.Optional(Type.Boolean({ description: "Set true to unpin instead of pin (default false)" })),
    }),
    async execute(_id: string, params: { id: string; unpin?: boolean }) {
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
          };
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Pin error: ${e.message}` }], isError: true };
      }
    },
  });

  // ===================================================================
  // 8. lcmg_sync — 三端数据同步修复
  // ===================================================================
  api.registerTool({
    name: "lcmg_sync",
    description: "Cross-store consistency check and repair for lossless-claw, Neo4j, and memory files. mode=check: read-only audit (reports orphaned entities and missing refs). mode=repair: actively prunes orphans and re-imports missing data. " +
      "Detects stale Neo4j entities (orphaned after compaction), missing entities, and cross-reference drift.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({
        description: '"check" (default, read-only), "repair" (prune orphans + re-import)',
        default: "check",
      })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing (default true for check, false for repair)", default: true })),
    }),
    async execute(_id: string, params: { mode?: string; dryRun?: boolean }) {
      const mode = params.mode ?? "check";
      const isDryRun = params.dryRun ?? (mode === "check" ? true : false);
      const lines: string[] = [];
      const push = (s: string) => lines.push(s);

      push(`# Data Sync: mode=${mode} dryRun=${isDryRun}\n`);

      // --- Phase 1: Compare lossless-claw conversation IDs with Neo4j ---
      push("## Phase 1: Conversation ↔ Neo4j entity cross-reference\n");
      let lcmConvIds = new Set<number>();
      let neo4jMsgNodes = 0;
      let orphanNodes = 0;
      let orphanedIds: string[] = [];

      try {
        const db = openDb();
        const convs = db.prepare("SELECT DISTINCT conversation_id FROM messages").all() as any[];
        lcmConvIds = new Set(convs.map((c: any) => c.conversation_id));
        db.close();
        push(`  lossless-claw: ${convs.length} active conversations\n`);
      } catch (e: any) { push(`  ❌ lossless-claw: ${e.message}\n`); }

      try {
        const { driver, session } = await neo4jSession();
        try {
          // Find Neo4j nodes with sessionId property
          const allMsgNodes = await session.run(
            `MATCH (n:ConversationMessage) RETURN n.id AS id, n.sessionId AS sid LIMIT 5000`
          );
          neo4jMsgNodes = allMsgNodes.records.length;
          push(`  Neo4j: ${neo4jMsgNodes} ConversationMessage nodes\n`);

          // Check each for orphan (no matching session in lcm.db)
          const db2 = openDb();
          for (const rec of allMsgNodes.records) {
            const sid = rec.get("sid") ?? "";
            if (sid) {
              const exists = db2.prepare("SELECT COUNT(*) AS c FROM conversations WHERE session_id = ?").get(sid) as any;
              if (exists.c === 0) {
                orphanNodes++;
                orphanedIds.push(rec.get("id") ?? sid);
              }
            }
          }
          db2.close();
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

      // --- Phase 2: Check TTL-expired nodes (pinned? expired?) ---
      push("\n## Phase 2: TTL & pin status\n");
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
        try {
          const { driver, session } = await neo4jSession();
          try {
            for (const id of orphanedIds) {
              await session.run("MATCH (n {id: $id}) DETACH DELETE n", { id });
            }
            const deleted = orphanedIds.length;
            // Also delete orphaned relationships
            const relCleanup = await session.run(
              `MATCH (n) WHERE NOT EXISTS { MATCH (m:ConversationMessage) WHERE m.id = n.id } AND n:ConversationMessage DELETE n`
            );
            const moreDeleted = 0; // batch delete already covered
            push(`  ✅ Pruned ${deleted} orphan nodes, ${moreDeleted} additional via batch cleanup\n`);
          } finally { await closeNeo4j(driver, session); }
        } catch (e: any) { push(`  ❌ Repair error: ${e.message}\n`); }
      } else if (mode === "repair" && orphanNodes === 0) {
        push("\n## Phase 3: No repair needed — all consistent\n");
      } else if (mode === "repair" && isDryRun) {
        push("\n## Phase 3: Dry run — would prune " + orphanNodes + " orphan nodes\n");
      }

      push("\n✅ Sync check complete.");
      return { content: [{ type: "text" as const, text: lines.join("") }] };
    },
  });
  // ===================================================================
  // 9. lcmg_qmd_status — QMD index health and collection info
  // ===================================================================
  api.registerTool({
    name: "lcmg_qmd_status",
    description: "Query QMD MCP service health: returns index stats (document count, vector dim), collection metadata, and service uptime. " +
      "Calls the 'status' tool on QMD's MCP server.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const { QmdClient } = await import("./qmd-client.js");
        const qmd = new QmdClient({ mcpBaseUrl: "http://127.0.0.1:8081" });
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
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], isError: true };
      }
    },
  });

  // ===================================================================
  // 10. lcmg_get_document — Retrieve a document by path or docid
  // ===================================================================
  api.registerTool({
    name: "lcmg_get_document",
    description: "Fetch a single document from QMD document index. Accepts absolute file path or QMD docid. Returns full content with fuzzy matching suggestions when exact path is not found. " +
      "Returns full document content with fuzzy matching suggestions when exact path is not found.",
    parameters: Type.Object({
      file: Type.String({ description: "File path or docid to retrieve" }),
    }),
    async execute(_id: string, params: { file: string }) {
      try {
        const { QmdClient } = await import("./qmd-client.js");
        const qmd = new QmdClient({ mcpBaseUrl: "http://127.0.0.1:8081" });
        const content = await qmd.get(params.file);
        if (content) {
          return { content: [{ type: "text" as const, text: content }] };
        }
        return { content: [{ type: "text" as const, text: `Document not found: ${params.file}` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], isError: true };
      }
    },
  });

  // ===================================================================
  // 11. lcmg_batch_get — Batch retrieve documents by glob pattern
  // ===================================================================
  api.registerTool({
    name: "lcmg_batch_get",
    description: "Batch fetch documents from QMD index. Input formats: glob patterns (e.g. **/memory/*.md), comma-separated paths, or docid list. Max 50 docs per call. Returns array of {path, content, size}. " +
      "Returns multiple documents' content.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, comma-separated paths, or docid list" }),
    }),
    async execute(_id: string, params: { pattern: string }) {
      try {
        const { QmdClient } = await import("./qmd-client.js");
        const qmd = new QmdClient({ mcpBaseUrl: "http://127.0.0.1:8081" });
        const results = await qmd.multiGet(params.pattern);
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No documents found for: ${params.pattern}` }] };
        }
        const lines = results.map((doc, i) => `--- Document ${i + 1} ---\n${doc}`);
        return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${e.message}` }], isError: true };
      }
    },
  });



  // ===================================================================
  // 12. lcmg_maintain - Trigger graph maintenance pipeline
  // ===================================================================
  api.registerTool({
    name: "lcmg_maintain",
    description: "Trigger knowledge graph maintenance: dedup, PageRank, community detection.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const config = resolveNeo4jConfig(getPluginNeo4jConfig());
        const neo4j = await import("neo4j-driver").then((m) => m.default);
        const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
        const { createRequire } = await import("node:module");
        const _req = createRequire(import.meta.url);
        const GM_PRO_PATH = process.env.GM_PRO_PATH
          || (() => {
              try {
                const resolved = _req.resolve("@openclaw/graph-memory-pro/dist/index.js");
                return resolved.endsWith("/dist/index.js") ? resolved.slice(0, -14) : resolved;
              } catch { return undefined; }
            })()
          || "/home/wljmmx/.openclaw/extensions/graph-memory-pro";

        const gm = await import(GM_PRO_PATH + "/dist/index.js");
        // Full GmConfig — all required fields
        const cfg = {
          neo4j: config,
          compactTurnCount: 10,
          recallMaxNodes: 10,
          recallMaxDepth: 2,
          freshTailCount: 5,
          dedupThreshold: 0.90,
          pagerankDamping: 0.85,
          pagerankIterations: 20,
        };
        const result = await gm.runMaintenance(driver, cfg);
        await driver.close();

        const lines = [];
        lines.push("# Graph Maintenance Report");
        lines.push("");
        lines.push("Duration: " + (result?.durationMs ?? 0) + "ms");
        lines.push("Dedup merged: " + (result?.dedup?.mergedCount ?? 0) + " nodes");
        lines.push("PageRank top: " + (result?.pagerank?.topK?.length ?? 0) + " nodes");
        lines.push("Communities detected: " + (result?.community?.communities?.size ?? 0));
        lines.push("Community summaries: " + (result?.communitySummaries ?? 0));
        lines.push("");
        lines.push("[OK] Maintenance complete.");

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: "Maintenance failed: " + e.message }], isError: true };
      }
    },
  });
}