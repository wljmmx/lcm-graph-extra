const fs = require('fs');

const QMD_URL = 'http://127.0.0.1:8081';

async function run() {
  const results = [];
  
  async function test(name, fn, iters) {
    const t = [];
    for (let i = 0; i < iters; i++) {
      const s = performance.now();
      try { await fn(); } catch(e) { console.log(name + ' error:', e.message); }
      t.push(performance.now() - s);
    }
    const st = [...t].sort((a,b)=>a-b);
    const sum = t.reduce((a,b)=>a+b,0);
    const r = {name, iterations: iters, avg: sum/iters, min: st[0], max: st[st.length-1]};
    results.push(r);
    console.log(name + ': avg=' + (sum/iters).toFixed(2) + 'ms, min=' + st[0].toFixed(2) + 'ms, max=' + st[st.length-1].toFixed(2) + 'ms');
  }

  console.log('--- QMD MCP Performance Tests ---');
  
  // Health check
  await test('qmd:health', async () => {
    const r = await fetch(QMD_URL + '/health', {signal: AbortSignal.timeout(3000)});
    return r.status;
  }, 5);
  
  // Lexical search
  await test('qmd:lex-search', async () => {
    const r = await fetch(QMD_URL + '/search', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({queries: [{type: 'lex', query: 'graph memory knowledge'}], limit: 3}),
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json();
    return data.results ? data.results.length : 0;
  }, 3);
  
  // Vector search
  await test('qmd:vec-search', async () => {
    const r = await fetch(QMD_URL + '/search', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({queries: [{type: 'vec', query: 'how to configure knowledge graph memory for OpenClaw plugin'}], limit: 3}),
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json();
    return data.results ? data.results.length : 0;
  }, 3);
  
  // Hybrid search with rerank
  await test('qmd:rerank', async () => {
    const r = await fetch(QMD_URL + '/search', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({queries: [{type: 'lex', query: 'neo4j database connection'}], limit: 3, rerank: true}),
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json();
    return data.results ? data.results.length : 0;
  }, 3);
  
  // Warm cache test (same query)
  await test('qmd:warm-cache', async () => {
    const r = await fetch(QMD_URL + '/search', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({queries: [{type: 'lex', query: 'graph memory knowledge'}], limit: 3}),
      signal: AbortSignal.timeout(3000)
    });
    return (await r.json()).results ? (await r.json()).results.length : 0;
  }, 3);
  
  // Status
  await test('qmd:status', async () => {
    const r = await fetch(QMD_URL + '/status', {signal: AbortSignal.timeout(3000)});
    const data = await r.json();
    return data.status || 'ok';
  }, 3);
  
  const rpt = results.map(r => r.name + ': avg=' + r.avg.toFixed(2) + 'ms, min=' + r.min.toFixed(2) + 'ms, max=' + r.max.toFixed(2) + 'ms').join('\n');
  fs.writeFileSync('/home/wljmmx/.openclaw/workspace/main/workfiles/lcm-graph-extra/test/perf/qmd-results.json', JSON.stringify(results, null, 2));
  console.log('Results saved.');
  console.log('\n' + rpt);
}

run().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
