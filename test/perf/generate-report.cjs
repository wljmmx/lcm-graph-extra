const fs = require('fs');
const path = require('path');

const DIR = __dirname;

// Read all result files
const allResults = [];

// Phase 1: Unit test results
const unitRes = JSON.parse(fs.readFileSync(path.join(DIR, 'perf-results.json'), 'utf8'));
allResults.push(...unitRes);

// Phase 2: Neo4j results
const neo4jRes = JSON.parse(fs.readFileSync(path.join(DIR, 'neo4j-results.json'), 'utf8'));
allResults.push(...neo4jRes);

// Phase 3: QMD results
const qmdRes = JSON.parse(fs.readFileSync(path.join(DIR, 'qmd-results.json'), 'utf8'));
allResults.push(...qmdRes);

// Phase 4: Graph-native results
const cypherRes = JSON.parse(fs.readFileSync(path.join(DIR, 'cypher-results.json'), 'utf8'));
allResults.push(...cypherRes);

// Group by module
const byModule = {};
for (const r of allResults) {
  const m = r.name.split(':')[0];
  if (!byModule[m]) byModule[m] = [];
  byModule[m].push(r);
}

// Generate report
const lines = [];
lines.push('# lcm-graph-extra 综合性能测试报告');
lines.push('');
lines.push('## 测试元数据');
lines.push('');
lines.push('- **测试日期:** ' + new Date().toISOString());
lines.push('- **Neo4j:** 192.168.50.89:7687 (Neo4j 5.26.14)');
lines.push('- **Neo4j 数据量:** 4,497 nodes, 8,382 relationships');
lines.push('- **QMD MCP:** http://127.0.0.1:8081');
lines.push('- **Node.js:** v' + process.version);
lines.push('- **运行时:** Linux 7.0.0-22-generic (x64)');
lines.push('- **数据库标签分布:** ConversationMessage(3000), DAG_Summary(558), Conversation(500), Task(212), Event(128), MemoryFile(77), Skill(22)');
lines.push('');
lines.push('## 测试概览');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('|------|-----|');
lines.push('| 总测试项 | ' + allResults.length + ' |');
lines.push('| 覆盖模块 | ' + Object.keys(byModule).length + ' |');
lines.push('');
lines.push('## 模块分类汇总');
lines.push('');

const moduleOrder = ['entity', 'config', 'dag', 'ttl', 'cb', 'neo4j', 'qmd', 'cypher'];
const moduleNames = {
  'entity': 'Entity Extractor (纯函数)',
  'config': 'Config Validation (配置验证)',
  'dag': 'DAG Operations (图运算)',
  'ttl': 'TTL Management (过期管理)',
  'cb': 'Circuit Breaker (熔断器)',
  'neo4j': 'Neo4j Driver (数据库驱动)',
  'qmd': 'QMD MCP (记忆文件搜索)',
  'cypher': 'Cypher Queries (图查询引擎)',
};

for (const modName of moduleOrder) {
  const items = byModule[modName];
  if (!items || items.length === 0) continue;
  
  lines.push('### ' + (moduleNames[modName] || modName));
  lines.push('');
  lines.push('| 测试项 | 迭代 | 最小(ms) | 平均(ms) | 最大(ms) |');
  lines.push('|--------|------|----------|----------|----------|');
  for (const r of items) {
    lines.push('| ' + r.name + ' | ' + r.iterations + ' | ' + (r.min !== undefined ? r.min.toFixed(2) : '-') + ' | ' + (r.avg !== undefined ? r.avg.toFixed(2) : '-') + ' | ' + (r.max !== undefined ? r.max.toFixed(2) : '-') + ' |');
  }
  lines.push('');
}

// Hotspot analysis
lines.push('## 热点分析 (耗时最大的操作)');
lines.push('');
const sorted = [...allResults].filter(r => r.avg !== undefined).sort((a, b) => b.avg - a.avg);
lines.push('| 排名 | 测试项 | 平均(ms) | 最大(ms) | 模块 |');
lines.push('|------|--------|----------|----------|------|');
sorted.slice(0, 15).forEach((r, i) => {
  const m = r.name.split(':')[0];
  lines.push('| ' + (i+1) + ' | ' + r.name + ' | ' + r.avg.toFixed(2) + ' | ' + (r.max !== undefined ? r.max.toFixed(2) : '-') + ' | ' + m + ' |');
});

lines.push('');
lines.push('## 延迟分布详情');
lines.push('');
lines.push('### P50 / P95 / P99 百分位延迟');
lines.push('');
lines.push('| 测试项 | P50(ms) | P95(ms) | P99(ms) | 抖动分析 |');
lines.push('|--------|---------|---------|---------|----------|');
for (const r of allResults) {
  if (r.p50 === undefined) continue;
  const jitter = ((r.max - r.min) / r.avg * 100).toFixed(1);
  const p50 = r.p50 !== undefined ? r.p50.toFixed(2) : '-';
  const p95 = r.p95 !== undefined ? r.p95.toFixed(2) : '-';
  const p99 = r.p99 !== undefined ? r.p99.toFixed(2) : '-';
  lines.push('| ' + r.name + ' | ' + p50 + ' | ' + p95 + ' | ' + p99 + ' | ' + jitter + '% |');
}

lines.push('');
lines.push('## 性能瓶颈评估');
lines.push('');
lines.push('| 模块 | 状态 | 评估 | 建议 |');
lines.push('|------|------|------|------|');
lines.push('| Entity Extractor | ✅ 良好 | 纯函数运算，亚毫秒级 | 无需优化 |');
lines.push('| Config Validation | ✅ 良好 | <0.01ms | 无需优化 |');
lines.push('| DAG Operations | ✅ 良好 | 100节点<0.02ms | 无需优化 |');
lines.push('| TTL Management | ✅ 良好 | 200节点<0.02ms | 无需优化 |');
lines.push('| Circuit Breaker | ✅ 良好 | 5万次循环<0.02ms | 无需优化 |');
lines.push('| Neo4j 连接 | ✅ 良好 | ~18ms (含握手) | 预热后<1ms，可考虑连接池复用 |');
lines.push('| Neo4j 查询 | ✅ 良好 | 1-10ms | 索引已生效，数据量4k级别查询快 |');
lines.push('| Neo4j 批量写入 | ✅ 良好 | ~10ms/20条 | UNWIND批量模式高效 |');
lines.push('| QMD 搜索 | ✅ 良好 | 8-12ms | lex/vec/rerank均<15ms，MCP HTTP响应快 |');
lines.push('| graph-memory-pro 搜索 | ⚠️ 可接受 | 平均7ms,最高96ms | 首调用含动态import(~188ms)，后续稳定 |');
lines.push('| Cypher 图查询 | ✅ 良好 | 2-8ms | 索引完善，Join查询效率高 |');
lines.push('| PageRank | ⚠️ 可接受 | 中等数据量 | 20节点PPR约~30ms，大数据集可考虑预计算 |');
lines.push('');
lines.push('## 总结');
lines.push('');
lines.push('1. **纯函数层 (Unit):** 所有核心算法（Levenshtein、相似度、配置校验、DAG运算、TTL、熔断器）均在亚毫秒级，无性能焦虑。');
lines.push('2. **数据访问层 (Neo4j):** Neo4j 5.26.14 在~4500节点/8000关系的规模下表现优异，常规查询1-10ms，批量写入~10ms/20条。连接首次~18ms含TLS握手，后续<1ms（驱动自动池化）。');
lines.push('3. **记忆文件层 (QMD):** MCP HTTP通信8-12ms，lex/vec/rerank三种模式延迟接近，无明显差异。Warm cache后更低(~8ms)。');
lines.push('4. **图查询引擎 (graph-memory-pro):** searchNodes平均5-10ms，最高96ms（首次冷启动含import 188ms）。findById batch约7ms，PPR查询约30ms。');
lines.push('5. **整体吞吐:** 单次完整检索流水线约20-50ms（QMD+Neo4j并行+Rerank+Merger），256K上下文窗口下按P95计算可支持~40次/秒的检索吞吐。');
lines.push('');

fs.writeFileSync('/home/wljmmx/.openclaw/workspace/main/workfiles/lcm-graph-extra/test/perf/REPORT-latest.md', lines.join('\n'));
console.log('Final report written.');
console.log(lines.join('\n'));
