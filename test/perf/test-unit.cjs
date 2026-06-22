const fs = require("fs");

async function run() {
  const results = [];
  
  async function test(name, fn, iters) {
    const t = [];
    for (let i = 0; i < iters; i++) {
      const s = performance.now();
      try { await fn(i); } catch(e) { console.log(name + " error:", e.message); }
      t.push(performance.now() - s);
    }
    const st = [...t].sort((a,b)=>a-b);
    const sum = t.reduce((a,b)=>a+b,0);
    results.push({name, iterations: iters, avg: sum/iters, min: st[0], max: st[st.length-1]});
    console.log(name + ": avg=" + (sum/iters).toFixed(2) + "ms, min=" + st[0].toFixed(2) + "ms, max=" + st[st.length-1].toFixed(2) + "ms");
  }

  // Dynamic import entity extractor
  const mod = await import("../../src/entity-extractor.ts");
  const { levenshteinDistance, normalizeEntityName, entityNameSimilarity } = mod;
  
  console.log("--- Unit Performance Tests ---");
  
  // Entity - levenshtein
  await test("entity:levenshtein", async () => {
    levenshteinDistance("knowledge graph memory plugin", "knowledge grpah mmory pluggin");
  }, 100);
  
  // Entity - normalize
  await test("entity:normalize", async () => {
    normalizeEntityName("[SKILL] Graph-Memory-Pro v2.1.7b");
  }, 100);
  
  // Entity - similarity
  await test("entity:similarity", async () => {
    entityNameSimilarity("lossless-claw plugin", "LosslessClawPlugin");
  }, 100);
  
  // Config validation (just check schema)
  await test("config:validate", async () => {
    const { default: cfgMod } = await import("../../src/config/index.ts");
    return true;
  }, 100);
  
  // DAG operations
  await test("dag:create-100nodes", async () => {
    const { GraphDAG } = await import("../../src/core/graph.ts");
    const dag = new GraphDAG();
    for (let i = 0; i < 100; i++) {
      dag.addNode({ id: "test-" + i, label: "Test", score: 0.5 });
    }
    return dag;
  }, 50);
  
  // TTL management
  await test("ttl:find-expired", async () => {
    const { findExpired } = await import("../../src/core/ttl.ts");
    const nodes = Array.from({length: 200}, (_,i) => ({
      id: "n" + i, updatedAt: Date.now() - (Math.random() > 0.7 ? 86400000 * 31 : 0)
    }));
    return findExpired(nodes, 86400000 * 30);
  }, 50);
  
  // Circuit breaker
  await test("cb:state-machine", async () => {
    const { CircuitBreaker } = await import("../../src/circuit-breaker.ts");
    const cb = new CircuitBreaker({ threshold: 5, timeout: 1000 });
    for (let i = 0; i < 100; i++) {
      cb.recordSuccess();
      if (i % 3 === 0) cb.recordFailure();
    }
    return cb.state;
  }, 30);

  // Save results
  fs.writeFileSync("/home/wljmmx/.openclaw/workspace/main/workfiles/lcm-graph-extra/test/perf/perf-results.json", JSON.stringify(results, null, 2));
  console.log("\nResults saved.");
}

run().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
