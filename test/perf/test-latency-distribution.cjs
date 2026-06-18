/**
 * CE Engine + graph-memory-pro Latency Distribution Test
 *
 * Tests:
 *   - L3 Neo4j modules (FTS, graph_walk, community, PPR)
 *   - L2 QMD MCP modules (lex_search, vec_search, warm_cache)
 *   - GMP recall phases (total, fts, graph_walk, ppr, projection cold/warm)
 *   - Assemble E2E (warm)
 *
 * Usage:
 *   cd test/perf && node test-latency-distribution.cjs
 */

const fs = require('fs');
const path = require('path');
const neo4j = require('neo4j-driver');

const DIR = __dirname;
const RESULTS_FILE = path.join(DIR, 'latency-distribution-results.json');

// Config (match existing test conventions)
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://192.168.50.89:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASS = process.env.NEO4J_PASSWORD || 'pro-gm-2.1.0';
const QMD_URL = process.env.QMD_URL || 'http://127.0.0.1:8081';
const GMP_PATH = process.env.GM_PRO_PATH
  ? process.env.GM_PRO_PATH + '/dist/index.js'
  : '/home/wljmmx/.openclaw/extensions/graph-memory-pro/dist/index.js';
const GDS_GRAPH_NAME = process.env.GDS_GRAPH_NAME || 'gm-ppr-timestamp';

async function test(name, fn, iters) {
  const times = [];
  for (let i = 0; i < iters; i++) {
    const s = performance.now();
    try { await fn(i); } catch (e) { console.log(name + ' error: ' + e.message); }
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    name,
    iterations: iters,
    avg: sum / iters,
    min: times[0],
    max: times[times.length - 1],
    p50: times[Math.floor(times.length * 0.5)],
    p90: times[Math.min(Math.floor(times.length * 0.9), times.length - 1)],
    p95: times[Math.min(Math.floor(times.length * 0.95), times.length - 1)],
    p99: times[Math.min(Math.floor(times.length * 0.99), times.length - 1)],
    stddev: Math.sqrt(times.reduce((s, t) => s + Math.pow(t - sum / iters, 2), 0) / iters),
  };
}

// --- L3 Neo4j Graph Modules ---
async function testL3Phases() {
  const results = [];
  console.log('--- L3 Neo4j Graph Modules ---');

  let driver;
  try {
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS), { disableLosslessIntegers: true });
  } catch (e) {
    console.log('Neo4j connect failed, skipping L3 tests: ' + e.message);
    return results;
  }

  // FTS search
  results.push(await test('L3:fts_search', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      await session.run(
        'CALL db.index.fulltext.queryNodes("task_search", "lcm-graph-extra") YIELD node, score RETURN node.id LIMIT 5'
      ).catch(async () => {
        return session.run('MATCH (n) WHERE n.label = $label RETURN n.id LIMIT 5', { label: 'Task' });
      });
    } finally { await session.close(); }
  }, 20));

  // graph_walk
  results.push(await test('L3:graph_walk', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      const r = await session.run(
        'MATCH (n) WHERE n.label IN [$labels] RETURN n.id LIMIT 3',
        { labels: ['Task', 'Event'] }
      );
      const ids = r.records.map(rec => rec.get('n.id').toString());
      if (ids.length) {
        await session.run(
          'UNWIND $ids AS id MATCH (n {id: id}) OPTIONAL MATCH (n)-[r]-(m) RETURN count(r)',
          { ids }
        );
      }
    } finally { await session.close(); }
  }, 15));

  // community detection
  results.push(await test('L3:community_detection', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      await session.run(
        'MATCH (n) RETURN n.communityId, count(*) AS cnt ORDER BY cnt DESC LIMIT 10'
      );
    } finally { await session.close(); }
  }, 15));

  // PageRank via GDS
  results.push(await test('L3:pagerank', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      const seed = await session.run(
        'MATCH (n) WHERE n.label = $label RETURN n.id LIMIT 1',
        { label: 'Task' }
      );
      if (seed.records.length) {
        await session.run(
          'CALL gds.pageRank.stream($graphName) YIELD nodeId, score ORDER BY score DESC LIMIT 10',
          { graphName: GDS_GRAPH_NAME }
        ).catch(() => {});
      }
    } finally { await session.close(); }
  }, 10));

  await driver.close();
  return results;
}

// --- L2 QMD MCP Modules ---
async function testL2Phases() {
  const results = [];
  console.log('--- L2 QMD MCP Modules ---');

  // lex-search via fetch (Node 24 global)
  results.push(await test('L2:lex_search', async () => {
    const res = await fetch(QMD_URL + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'lcm-graph-extra plugin', mode: 'lex' }),
    });
    await res.json().catch(() => {});
  }, 10));

  // vec-search
  results.push(await test('L2:vec_search', async () => {
    const res = await fetch(QMD_URL + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'graph memory plugin latency optimization', mode: 'vec' }),
    });
    await res.json().catch(() => {});
  }, 10));

  // warm cache
  results.push(await test('L2:warm_cache', async () => {
    const res = await fetch(QMD_URL + '/warm-cache', { method: 'POST' }).catch(() => null);
    if (res) await res.json().catch(() => {});
  }, 10));

  return results;
}

// --- graph-memory-pro Recall Modules ---
async function testGMPPhases() {
  const results = [];
  console.log('--- graph-memory-pro Recall Modules ---');

  let gmPro;
  try {
    gmPro = await import(GMP_PATH);
  } catch (e) {
    console.log('graph-memory-pro not available, skipping GMP tests: ' + e.message);
    return results;
  }

  let driver;
  try {
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS), { disableLosslessIntegers: true });
  } catch (e) {
    console.log('Neo4j connect failed, skipping GMP tests: ' + e.message);
    return results;
  }

  const cfg = {
    recallMaxNodes: 8,
    recallMaxDepth: 2,
    pagerankIterations: 15,
    gdsProjectionName: GDS_GRAPH_NAME,
  };

  // GMP full recall
  results.push(await test('GMP:recall_total', async () => {
    const Recaller = gmPro.Recaller;
    if (!Recaller) throw new Error('No Recaller export');

    let embedFn = null;
    try {
      const createEmbedFn = gmPro.createEmbedFn;
      if (createEmbedFn && process.env.OPENAI_API_KEY) {
        embedFn = await createEmbedFn({
          apiKey: process.env.OPENAI_API_KEY,
          base_url: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
          model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
        });
      }
    } catch (e) {
      console.log('Embed function not available, recall without vectors');
    }

    const recaller = new Recaller(driver, cfg);
    if (embedFn) recaller.setEmbedFn(embedFn);
    return recaller.recall('lcm-graph-extra latency optimization');
  }, 20));

  // GMP FTS only
  results.push(await test('GMP:fts_search', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      await session.run(
        'CALL db.index.fulltext.queryNodes("task_search", "lcm-graph-extra") YIELD node, score RETURN node.id LIMIT 8'
      ).catch(async () => {
        return session.run('MATCH (n) WHERE n.name CONTAINS $q RETURN n.id LIMIT 8', { q: 'graph' });
      });
    } finally { await session.close(); }
  }, 20));

  // GMP graph_walk
  results.push(await test('GMP:graph_walk', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      const r = await session.run(
        'MATCH (n) WHERE n.label IN ["Task","Event"] RETURN n.id LIMIT 3'
      );
      const ids = r.records.map(rec => rec.get('n.id').toString());
      if (ids.length) {
        await session.run(
          'UNWIND $ids AS id MATCH (n {id: id})-[*1..2]-(m) RETURN DISTINCT m.id LIMIT 20',
          { ids }
        );
      }
    } finally { await session.close(); }
  }, 15));

  // GMP PPR compute (GDS)
  results.push(await test('GMP:ppr_compute', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      await session.run(
        'CALL gds.pageRank.stream($graphName, { dampingFactor: 0.85, maxIterations: $iters }) YIELD nodeId, score ORDER BY score DESC LIMIT 20',
        { graphName: GDS_GRAPH_NAME, iters: 15 }
      ).catch(() => {});
    } finally { await session.close(); }
  }, 10));

  // GMP community detection
  results.push(await test('GMP:community_detection', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      await session.run(
        'MATCH (n) RETURN n.communityId, count(*) AS cnt ORDER BY cnt DESC LIMIT 10'
      );
    } finally { await session.close(); }
  }, 15));

  // GMP ensure_projection cold start
  results.push(await test('GMP:ensure_projection_cold', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      await session.run(
        'CALL gds.graph.drop($name) YIELD graphName',
        { name: GDS_GRAPH_NAME }
      ).catch(() => {});
      // Re-create
      await session.run(
        'CALL gds.graph.project($graphName, { nodeQuery: $nodeQ, nodeProperties: ["name","content","label"] }, { relationshipQuery: $relQ })',
        {
          graphName: GDS_GRAPH_NAME,
          nodeQ: 'MATCH (n) WHERE n.id IS NOT NULL RETURN id(n) AS id',
          relQ: 'MATCH (a)-[r]->(b) WHERE a.id IS NOT NULL AND b.id IS NOT NULL RETURN id(a) AS source, id(b) AS target',
        }
      ).catch(() => {});
    } finally { await session.close(); }
  }, 3));

  // GMP ensure_projection warm (cached)
  results.push(await test('GMP:ensure_projection_warm', async () => {
    const session = driver.session({ database: 'neo4j' });
    try {
      await session.run(
        'CALL gds.graph.exists($name) YIELD graphName',
        { name: GDS_GRAPH_NAME }
      );
    } finally { await session.close(); }
  }, 15));

  // GMP merge_results (in-memory benchmark)
  results.push(await test('GMP:merge_results', async () => {
    const aNodes = Array.from({length: 50}, (_,i) => ({id: 'a'+i, label: 'Task'}));
    const bNodes = Array.from({length: 50}, (_,i) => ({id: i < 20 ? 'a'+i : 'b'+(i-20), label: 'Event'}));
    const seen = new Set();
    const merged = [];
    for (const n of [...aNodes, ...bNodes]) {
      if (!seen.has(n.id)) { seen.add(n.id); merged.push(n); }
    }
    return merged.length;
  }, 50));

  await driver.close();
  return results;
}

// --- Assemble E2E ---
async function testAssembleE2E() {
  const results = [];
  console.log('--- CE Assemble E2E ---');

  try {
    const { default: mod } = await import(path.join(DIR, '..', '..', 'dist', 'index.js'));
    const plugin = mod.default || mod;

    if (plugin.onLoad) {
      await plugin.onLoad({
        log: { debug: () => {}, info: () => {} },
        config: {},
        neo4j_driver: null,
        windowSize: 256 * 1024,
      });
    }

    if (plugin.assemble) {
      // warm call
      await plugin.assemble({
        conversationId: 'perf-test',
        turnId: 'warmup',
        userMessage: { content: '' },
        window: { messages: [], tokens: 0, size: 256 * 1024 },
        log: { debug: () => {} },
      }).catch(() => {});
    }

    // measured calls
    results.push(await test('assemble:e2e_warm', async () => {
      return plugin.assemble({
        conversationId: 'perf-test',
        turnId: 'measured-' + Math.random(),
        userMessage: { content: 'lcm-graph-extra latency' },
        window: { messages: [], tokens: 0, size: 256 * 1024 },
        log: { debug: () => {} },
      });
    }, 20));
  } catch (e) {
    console.log('Assemble E2E failed: ' + e.message);
  }

  return results;
}

// --- Main ---
async function run() {
  const allResults = [];

  console.log('\n=== CE + graph-memory-pro Latency Distribution Test ===');
  console.log('Date: ' + new Date().toISOString());
  console.log('Node: ' + process.version);
  console.log('Platform: ' + process.platform + ' ' + process.arch);
  console.log('NEO4J_URI: ' + NEO4J_URI);
  console.log('GMP_PATH: ' + GMP_PATH);
  console.log('QMD_URL: ' + QMD_URL);
  console.log('');

  const phases = [
    { name: 'L3 Neo4j', fn: testL3Phases },
    { name: 'L2 QMD MCP', fn: testL2Phases },
    { name: 'GMP Recall', fn: testGMPPhases },
    { name: 'Assemble E2E', fn: testAssembleE2E },
  ];

  for (const phase of phases) {
    try {
      console.log('\n--- ' + phase.name + ' ---');
      const r = await phase.fn();
      allResults.push(...r);
    } catch (e) {
      console.log(phase.name + ' phase failed: ' + e.message);
    }
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
  console.log('\n=== Results saved to latency-distribution-results.json ===');
  console.log('Total test items: ' + allResults.length);

  console.log('\n--- Summary ---');
  console.log('| Test | Iters | Avg(ms) | P50(ms) | P90(ms) | P95(ms) | StdDev |');
  console.log('|------|-------|---------|---------|---------|---------|--------|');
  for (const r of allResults) {
    console.log(
      '| ' + r.name + ' | ' + r.iterations + ' | '
      + (r.avg !== undefined ? r.avg.toFixed(2) : '-') + ' | '
      + (r.p50 !== undefined ? r.p50.toFixed(2) : '-') + ' | '
      + (r.p90 !== undefined ? r.p90.toFixed(2) : '-') + ' | '
      + (r.p95 !== undefined ? r.p95.toFixed(2) : '-') + ' | '
      + (r.stddev !== undefined ? r.stddev.toFixed(2) : '-')
      + ' |'
    );
  }

  console.log('\nNext: node generate-report.cjs');
}

run().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
