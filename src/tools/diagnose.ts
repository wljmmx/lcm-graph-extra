/**
 * tools/diagnose.ts — 系统诊断 (lcmg_diagnose)
 */
import { Type } from "typebox";
import {
  openDb, getQmdBaseUrl, acquireQmdClient, neo4jSession, closeNeo4j,
} from './shared.js';

export function registerDiagnoseTool(api: any): void {
  api.registerTool({
    name: "lcmg_diagnose",
    label: "系统诊断",
    description: "System diagnostics: Neo4j, lossless-claw DB, QMD MCP health, circuit breaker states. Returns per-subsystem status.",
    parameters: Type.Object({}),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
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
      p(H); p("1. lossless-claw (SQLite DAG)"); p(H);
      let db: any = null;
      try {
        db = openDb();
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
        const ftsRow = db.prepare("SELECT COUNT(*) as c FROM messages_fts WHERE messages_fts MATCH 'test'").get();
        const fts = ftsRow?.c ?? 0;
        ok("FTS5 index", "searchable (test -> " + fts + " hits)");
        pass += 6;
      } catch (e: any) { fail("lossless-claw", e.message); fails++; }
      finally { if (db) { try { db.close(); } catch {} } }

      // 2. qmd
      sep(); p(H); p("2. qmd (Memory File Engine)"); p(H);
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const r = await fetch(getQmdBaseUrl() + "/health", { signal: AbortSignal.timeout(2000) });
        ok("MCP 8081", "HTTP " + r.status); pass++;
      } catch { warn("MCP 8081", "unreachable"); warns++; }
      let qmd: any = null; let qmdOwned = false;
      try {
        const acquired = await acquireQmdClient();
        qmd = acquired.client; qmdOwned = acquired.owned;
        if (await qmd.ping()) { ok("QmdClient", "MCP available (CLI fallback ready)"); pass++; }
        else { warn("QmdClient", "MCP down, running in CLI fallback mode"); warns++; }
        const stat = await qmd.status();
        if (stat) { ok("Qmd status", stat.slice(0, 100).replace(/\n/g, " ")); pass++; }
        else { warn("Qmd status", "status() returned no data"); warns++; }
        const r2 = await qmd.query({ searches: [{ type: "lex", query: "test" }], limit: 1 });
        ok("Search test", r2.length > 0 ? r2.length + " results" : "0 results (empty index)"); pass++;
      } catch (e: any) { warn("qmd", "unavailable: " + e.message); warns++; }
      finally { if (qmd && qmdOwned) { try { qmd.dispose(); } catch {} } }

      // 3. Neo4j
      sep(); p(H); p("3. graph-memory-pro (Neo4j)"); p(H);
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const { driver, session } = await neo4jSession();
        try {
          const info = await driver.getServerInfo();
          ok("Connection", info.address + " v" + (info.protocolVersion as any).major + "." + (info.protocolVersion as any).minor); pass++;
          const labels = await session.run("MATCH (n) RETURN labels(n)[0] AS l, count(n) AS c ORDER BY c DESC");
          let totalN = 0; const lb: string[] = [];
          for (const r of labels.records) { const c = r.get("c").toNumber(); lb.push(r.get("l") + ":" + c); totalN += c; }
          ok("Nodes", totalN + " (" + lb.join(", ") + ")"); pass++;
          const rel = await session.run("MATCH ()-[r]->() RETURN count(r) AS c");
          ok("Relationships", rel.records[0].get("c").toNumber().toString()); pass++;
          const exp = await session.run("MATCH (n:EXPERIENCE) RETURN count(n) AS c");
          const ec = exp.records[0].get("c").toNumber();
          if (ec > 0) ok("EXPERIENCE", ec + " nodes"); else warn("EXPERIENCE", "0 (no extractions yet)"); (ec > 0 ? pass++ : warns++);
          const pin = await session.run("MATCH (n {pinned: true}) RETURN count(n) AS c");
          const pc = pin.records[0].get("c").toNumber();
          if (pc > 0) { ok("Pinned", pc + " nodes"); pass++; }
        } finally { await closeNeo4j(driver, session); }
      } catch (e: any) { fail("Neo4j", e.message); fails++; }

      // 4. Circuit Breaker
      sep(); p(H); p("4. Circuit Breakers"); p(H);
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const cb = await import("../circuit-breaker.js");
        const h = cb.getHealthSnapshot();
        if (Object.keys(h).length === 0) { warn("Breaker state", "no data yet"); warns++; }
        for (const [name, st] of Object.entries(h)) {
          const label = { lcm: "lossless-claw", qmd: "qmd", neo4j: "Neo4j" }[name] || name;
          if (st.available) { ok(label, st.failures + " failures"); pass++; }
          else { fail(label, "OPEN (" + st.failures + " failures)"); fails++; }
        }
      } catch { warn("Circuit breaker", "not loaded"); warns++; }

      // 5. Health Metrics (N-4)
      sep(); p(H); p("5. Health Metrics (N-4)"); p(H);
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Operation aborted" }], details: { ok: false, aborted: true }, isError: true };
      }
      try {
        const { healthMetrics } = await import('../health-metrics.js');
        const latest = healthMetrics.getLatest();
        if (latest) {
          const ago = Math.round((Date.now() - latest.timestamp) / 60000);
          ok("Last snapshot", ago + " min ago");
          ok("Pending msgs", String(latest.pendingMessages));
          ok("Summary frags", String(latest.summaryFragments));
          ok("Token ratio", latest.maxTokenRatio.toFixed(3));
          if (latest.lastAssembleMs > 0) {
            ok("Last assemble", latest.lastAssembleMs + "ms (L2:" + latest.lastL2Ms + "ms L3:" + latest.lastL3Ms + "ms L4:" + latest.lastL4Ms + "ms)");
          }
          if (latest.tierLow + latest.tierMedium + latest.tierHigh > 0) {
            ok("Tier distribution", "low:" + latest.tierLow + " med:" + latest.tierMedium + " high:" + latest.tierHigh);
          }
          pass++;
        } else { warn("Health metrics", "no snapshots yet (heartbeat may not have run)"); warns++; }
        const dbRows = await healthMetrics.readFromDb(5);
        if (dbRows.length > 0) {
          p("  Recent history:");
          for (const r of dbRows.slice(0, 5)) {
            const ts = new Date(r.ts).toLocaleTimeString();
            p("    " + ts + " | msgs:" + r.pending_msgs + " frags:" + r.summary_frags + " ratio:" + (typeof r.token_ratio === 'number' ? r.token_ratio.toFixed(3) : '0.000') +
              " | cb:" + (r.cb_lcm_ok ? "✓" : "✗") + (r.cb_qmd_ok ? "✓" : "✗") + (r.cb_neo4j_ok ? "✓" : "✗"));
          }
        }
      } catch (e: any) { warn("Health metrics", "collection failed: " + e.message); warns++; }

      // 6. Summary
      sep(); p(H); p("6. Summary"); p(H);
      p("  Pass: " + pass + "  Warnings: " + warns + "  Failures: " + fails);
      p(fails === 0 ? "  Status: OK" : "  Status: DEGRADED (" + fails + " issues)");

      return {
        content: [{ type: "text" as const, text: L.join("\n") }],
        details: { ok: true, metrics: { pass, warnings: warns, failures: fails, status: fails === 0 ? 'OK' : 'DEGRADED' } },
      };
    },
  }, { optional: true });
}