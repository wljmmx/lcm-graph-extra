const neo4j = require('neo4j-driver');
const fs = require('fs');

const URI = 'bolt://192.168.50.89:7687';
const USER = 'neo4j';
const PASS = 'pro-gm-2.1.0';

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

  console.log('--- Neo4j Performance Tests ---');
  
  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASS));
  
  await test('neo4j:connect', () => driver.verifyConnectivity(), 3);
  
  const s1 = driver.session();
  await test('neo4j:count-nodes', async () => {
    const r = await s1.run('MATCH (n) RETURN count(n) AS cnt');
    return r.records[0].get('cnt').toNumber();
  }, 5);
  
  const s2 = driver.session();
  await test('neo4j:count-rels', async () => {
    const r = await s2.run('MATCH ()-[e]->() RETURN count(e) AS cnt');
    return r.records[0].get('cnt').toNumber();
  }, 5);
  
  const s3 = driver.session();
  await test('neo4j:labels', async () => {
    const r = await s3.run('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS cnt ORDER BY cnt DESC');
    return r.records.length;
  }, 5);
  
  const s4 = driver.session();
  await test('neo4j:search-name', async () => {
    const r = await s4.run('MATCH (n:Task) WHERE n.name CONTAINS $q RETURN n LIMIT 5', {q: 'graph'});
    return r.records.length;
  }, 5);
  
  const s5 = driver.session();
  await test('neo4j:neighbors', async () => {
    const r = await s5.run('MATCH (a:Task)-[e]-(b) WHERE a.name CONTAINS $q RETURN a.name, type(e), b.name LIMIT 10', {q: 'lcm'});
    return r.records.length;
  }, 5);
  
  const s6 = driver.session();
  await test('neo4j:degree-centrality', async () => {
    const r = await s6.run('MATCH (n) OPTIONAL MATCH (n)-[e]-() WITH n, count(e) AS deg ORDER BY deg DESC LIMIT 20 RETURN n.id, deg');
    return r.records.length;
  }, 5);
  
  const s7 = driver.session();
  await test('neo4j:communities', async () => {
    const r = await s7.run('MATCH (n) WHERE n.communityId IS NOT NULL RETURN n.communityId AS cid, count(*) AS cnt ORDER BY cnt DESC LIMIT 10');
    return r.records.length;
  }, 5);
  
  // Write
  const s8 = driver.session();
  const testId = 'perf-' + Date.now();
  await test('neo4j:batch-upsert-20', async () => {
    const batch = Array.from({length: 20}, (_,i) => ({
      id: testId + '-' + i,
      name: 'Perf Test ' + i,
      ts: Date.now()
    }));
    await s8.run('UNWIND $b AS row MERGE (n:Task {id: row.id}) ON CREATE SET n.name = row.name, n.createdAt = row.ts', {b: batch});
  }, 3);
  
  // Cleanup
  const s9 = driver.session();
  await test('neo4j:cleanup-test', async () => {
    await s9.run('MATCH (n:Task) WHERE n.id STARTS WITH $p DETACH DELETE n', {p: testId});
  }, 1);
  
  await driver.close();
  
  // Save results
  const rpt = results.map(r => r.name + ': avg=' + r.avg.toFixed(2) + 'ms, min=' + r.min.toFixed(2) + 'ms, max=' + r.max.toFixed(2) + 'ms').join('\n');
  fs.writeFileSync('/home/wljmmx/.openclaw/workspace/main/workfiles/lcm-graph-extra/test/perf/neo4j-results.json', JSON.stringify(results, null, 2));
  console.log('Results saved.');
  console.log('\n' + rpt);
}

run().catch(e => { console.log('FATAL:', e.message, e.stack); process.exit(1); });
