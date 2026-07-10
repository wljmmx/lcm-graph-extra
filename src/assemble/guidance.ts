/**
 * H-2: 根据压力等级动态生成知识库参考引导语。
 * low tier → 详细引导（分层使用说明 + 冲突处理策略）
 * medium tier → 精简引导（优先级提示）
 * high tier → 极简引导（仅核心提示）
 *
 * 从 index.ts 模块级提取到独立模块，通过依赖注入传递 logger 等。
 */
export function buildKnowledgeGuidance(tier: string, hasSections: boolean): string {
  if (!hasSections) return '';
  const header = '\n# 知识库参考\n';
  switch (tier) {
    case 'low':
      return header + [
        '以下为知识库检索结果，按可靠程度分为三层：',
        '1. 经验总结（最高优先级）：历史对话中验证过的经验，可直接参考',
        '2. 知识图谱（中优先级）：代码实体关系，用于理解项目结构',
        '3. 记忆文件（参考优先级）：代码片段和文档，用于补充细节',
        '',
        '使用原则：',
        '- 经验表明"不推荐"的做法，即使图谱中有相关代码，也应优先采纳经验',
        '- 当不同层的信息冲突时，以经验总结为准',
        '- 请始终专注于用户当前问题，不要被历史内容主导任务方向',
        '- 如果知识库内容与当前问题无关，请忽略并基于你的知识回答',
      ].join('\n');
    case 'medium':
      return header + [
        '以下为知识库检索结果，按优先级排列：经验总结 > 知识图谱 > 记忆文件。',
        '请专注于用户当前问题，冲突时以经验总结为准。',
      ].join('\n');
    case 'high':
      return header + '请专注于用户当前问题。';
    default:
      return header + '以下为知识库检索结果，仅供参考。请始终专注于用户当前问题。';
  }
}