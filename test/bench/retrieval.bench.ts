import { bench, describe } from 'vitest';

// 模拟检索网关的并行检索逻辑
async function mockParallelSearch() {
  const results = await Promise.all([
    // L2 QMD
    new Promise<any[]>(r => setTimeout(() => r([{ id: 'qmd-1', score: 0.9 }]), 10)),
    // L3 Neo4j
    new Promise<any[]>(r => setTimeout(() => r([{ id: 'graph-1', score: 0.8 }]), 20)),
    // L4 Experience
    new Promise<any[]>(r => setTimeout(() => r([{ id: 'exp-1', score: 0.7 }]), 30)),
  ]);
  return results.flat();
}

describe('Retrieval Gateway Performance', () => {
  // 并行检索（模拟 3 路并行）
  bench('parallel 3-layer search', async () => {
    await mockParallelSearch();
  });

  // 单路检索（基线）
  bench('single layer search', async () => {
    await new Promise<any[]>(r => setTimeout(() => r([{ id: 'qmd-1', score: 0.9 }]), 30));
  });
});