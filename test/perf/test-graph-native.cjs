const path = require('path');
const fs = require('fs');
const EXT = '/home/wljmmx/.openclaw/extensions/lcm-graph-extra';

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

  console.log('--- Native Cypher Performance Tests ---');
  
  const neo4j = require('neo4j-driver');
  const OPENCLAW_DIR = process.env.OPENCLAW_DIR || (process.env.HOME ? `${process.env.HOME}/.openclaw` : './.openclaw');
  const GM_PRO_PATH = process.env.GM_PRO_PATH || `${OPENCLAW_DIR}/extensions/graph-memory-pro`;
  const DRIVER = neo4j.driver('bolt://192.168.50.89:7687', neo4j.auth.basic('neo4j', 'pro-gm-2.1.0'));
  
  // Test Cypher query against real graph-memory-pro data
  await test('cypher:import-gm-mod', async () => {
    const gm = await import(path.join(GM_PRO_PATH, 'dist/index.js'));
    return typeof gm.searchNodes;
  }, 1);
  
  // Use graph-memory-pro searchNodes directly
  let gmMod;
  try { gmMod = await import(path.join(GM_PRO_PATH, 'dist/index.js')); } catch(e) { console.log('GM import error:', e.message); }
  
  if (gmMod && gmMod.searchNodes) {
    await test('cypher:searchNodes-graph', async () => {
      const r = await gmMod.searchNodes(DRIVER, 'memory', 5);
      return r ? r.length : 0;
    }, 5);
    
    await test('cypher:searchNodes-lcm', async () => {
      const r = await gmMod.searchNodes(DRIVER, 'lcm graph', 5);
      return r ? r.length : 0;
    }, 5);
    
    await test('cypher:searchNodes-error', async () => {
      const r = await gmMod.searchNodes(DRIVER, 'error fix bug', 5);
      return r ? r.length : 0;
    }, 5);
  }
  
  // Deep queries
  const s = DRIVER.session();
  await test('cypher:findById-batch', async () => {
    const ids = ['skill-typescript', 'task-setup-neo4j', 'event-build-fail'].map(id => '\\"' + id + '\\"');
    const r = await s.run('MATCH (n) WHERE n.id IN $ids RETURN n.id, n.name, n.description LIMIT 10', {ids: ['skill-typescript', 'task-setup-neo4j']});
    return r.records.length;
  }, 5);
  
  // Community query
  await test('cypher:community-graph', async () => {
    const r = await s.run('MATCH (n:Task) WHERE n.communityId IS NOT NULL RETURN n.communityId, count(*) AS c ORDER BY c DESC LIMIT 10');
    return r.records.length;
  }, 5);
  
  // Edge query
  await test('cypher:edges-for-nodes', async () => {
    const r = await s.run('MATCH (a)-[e]->(b) WHERE a.name CONTAINS $q RETURN a.name, type(e), b.name LIMIT 20', {q: 'skill'});
    return r.records.length;
  }, 5);
  
  await s.close();
  
  if (gmMod && gmMod.personalizedPageRank) {
    await test('cypher:ppr-full', async () => {
      const seeds = await gmMod.searchNodes(DRIVER, 'knowledge', 3);
      if (seeds && seeds.length > 0) {
        const neighbors = seeds.slice(0, 5).map(n => n.id).filter(Boolean);
        if (neighbors.length >= 2) {
          const ppr = await gmMod.personalizedPageRank(DRIVER, neighbors[0], neighbors, {damping: 0.85, iterations: 20});
          return ppr ? ppr.length : 0;
        }
      }
      return 0;
    }, 3);
  }
  
  await DRIVER.close();
  
  const rpt = results.map(r => r.name + ': avg=' + r.avg.toFixed(2) + 'ms, min=' + r.min.toFixed(2) + 'ms, max=' + r.max.toFixed(2) + 'ms').join('\n');
  fs.writeFileSync('/home/wljmmx/.openclaw/workspace/main/workfiles/lcm-graph-extra/test/perf/cypher-results.json', JSON.stringify(results, null, 2));
  console.log('Results saved.');
  console.log('\n' + rpt);
}

run().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
