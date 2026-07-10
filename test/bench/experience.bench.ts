import { bench, describe } from 'vitest';
import { ExperienceStorage } from '../../src/experience/storage.js';

// 内存模式 mock adapter
function createMockAdapter() {
  const nodes: Record<string, any>[] = [];
  // 预填充 500 个经验
  for (let i = 0; i < 500; i++) {
    nodes.push({
      id: `exp-${i}`,
      title: `Experience ${i}`,
      summary: `Summary about ${['TypeScript', 'React', 'Node.js', 'Python', 'Docker'][i % 5]} and ${['testing', 'deployment', 'optimization', 'debugging', 'refactoring'][i % 5]}`,
      detail: `Detailed experience ${i} content`,
      context: `Context for experience ${i}`,
      relevanceScore: 0.5 + Math.random() * 0.5,
      createdAt: Date.now() - i * 86400000,
      matchCount: Math.floor(Math.random() * 100),
      rawIds: `raw-${i}`,
      type: 'code',
      tags_scenario: ['bug-fix', 'feature-dev', 'refactor'][i % 3],
      tags_techStack: ['TypeScript', 'React', 'Node.js'][i % 3],
      tags_severity: ['high', 'medium', 'low'][i % 3],
      tags_free: '',
      status: 'DISTILLED',
      state: '',
    });
  }
  return {
    query: async (cypher: string, params?: Record<string, unknown>) => {
      // 简化实现：返回匹配的经验
      const keyword = (params?.queryKeyword as string) || '';
      const minScore = (params?.minScore as number) || 0.6;
      const limit = (params?.limit as number) || 5;
      const scenarioTags = (params?.scenarioTags as string[]) || [];
      return nodes
        .filter(n => n.relevanceScore >= minScore)
        .filter(n => {
          if (scenarioTags.length > 0) {
            return scenarioTags.some(t => (n.tags_scenario || '').includes(t));
          }
          return true;
        })
        .filter(n => !keyword || n.summary.toLowerCase().includes(keyword.toLowerCase()))
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, limit)
        .map(n => ({ ...n }));
    }
  };
}

describe('ExperienceStorage Performance', () => {
  const adapter = createMockAdapter();
  const storage = new ExperienceStorage(adapter as any, 10);

  bench('searchByQuery with keyword', async () => {
    await storage.searchByQuery({ query: 'TypeScript', minScore: 0.6, limit: 5 });
  });

  bench('searchByQuery with tags', async () => {
    await storage.searchByQuery({ scenarioTags: ['bug-fix'], minScore: 0.6, limit: 5 });
  });

  bench('searchRelevant', async () => {
    await storage.searchRelevant(0.6, 10);
  });
});