/**
 * 轻量正则实体提取器 — Phase 1
 *
 * 从查询中提取关键实体，用于检索结果的主题一致性过滤。
 * 支持：中文/英文混合、技术术语、专有名词、代码标识符
 */

export interface ExtractedEntities {
  /** 提取的关键词列表 */
  terms: string[];
  /** 提取的专有名词（大写字母开头的标识符、路径等） */
  properNouns: string[];
  /** 提取的技术栈/框架名称 */
  techTerms: string[];
  /** 原始查询中所有有意义的分词 */
  tokens: string[];
}

/**
 * 从查询中提取实体
 * 
 * 策略：
 * 1. 提取中文分词（2-4字常见名词短语）
 * 2. 提取英文/驼峰/大写字母开头的标识符
 * 3. 提取技术术语（package.json 风格、npm 包名）
 * 4. 提取路径/文件名模式
 * 5. 提取代码标识符（snake_case, camelCase）
 */
export function extractEntities(query: string): ExtractedEntities {
  if (!query || query.trim().length < 3) {
    return { terms: [], properNouns: [], techTerms: [], tokens: [] };
  }

  const terms: string[] = [];
  const properNouns: string[] = [];
  const techTerms: string[] = [];
  const tokens: string[] = [];

  // 1. 提取中文名词短语（2-4个连续中文字符）
  const chinesePhrases = query.match(/[一-鿿]{2,4}/g);
  if (chinesePhrases) {
    terms.push(...chinesePhrases.filter(t => t.length >= 2));
  }

  // 2. 提取英文/驼峰/大写字母开头的标识符
  const identifiers = query.match(/[A-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*/g);
  if (identifiers) {
    properNouns.push(...identifiers.filter(t => t.length >= 2));
  }

  // 3. 提取 camelCase 和 snake_case 标识符
  const camelCase = query.match(/[a-z]+(?:[A-Z][a-z]*)+/g);
  if (camelCase) {
    properNouns.push(...camelCase);
  }

  const snakeCase = query.match(/[a-z]+_[a-z0-9_]+/g);
  if (snakeCase) {
    properNouns.push(...snakeCase);
  }

  // 4. 提取技术术语（npm 包名、@scope/package 等）
  const techTermsList = query.match(/(?:@[a-z0-9-]+\/)?[a-z0-9-]+/gi);
  if (techTermsList) {
    const knownTech = ['react', 'vue', 'angular', 'node', 'express', 'koa', 'egg', 
                       'typescript', 'javascript', 'webpack', 'vite', 'rollup',
                       'neo4j', 'mongodb', 'mysql', 'postgres', 'redis', 'docker',
                       'git', 'github', 'npm', 'pnpm', 'yarn', 'openclaw',
                       'llm', 'ai', 'api', 'http', 'json', 'yaml', 'html', 'css',
                       'typescript', 'javascript', 'node', 'python', 'java', 'go',
                       'graph', 'memory', 'vector', 'embedding', 'index', 'search',
                       'cache', 'pipeline', 'hook', 'plugin', 'adapter', 'driver',
                       'session', 'context', 'token', 'prompt', 'model', 'provider'];
    for (const term of techTermsList) {
      if (knownTech.includes(term.toLowerCase()) && !techTerms.includes(term)) {
        techTerms.push(term);
      }
    }
  }

  // 5. 提取路径/文件名模式
  const paths = query.match(/(?:src\/|lib\/|app\/|node_modules\/|~\/)[a-zA-Z0-9_/.-]+/g);
  if (paths) {
    for (const p of paths) {
      const basename = p.split('/').pop();
      if (basename) properNouns.push(basename);
    }
  }

  // 6. 提取代码标识符（反引号、引号中的内容）
  const quotedStrings = query.match(/["''][^"'']{3,50}["'']/g);
  if (quotedStrings) {
    for (const s of quotedStrings) {
      const inner = s.slice(1, -1);
      if (inner.length >= 3) {
        terms.push(inner);
      }
    }
  }

  // 7. 提取有意义的 token（英文单词 >= 3 字符，中文 >= 2 字符）
  const englishWords = query.match(/[a-zA-Z]{3,}/g);
  if (englishWords) {
    const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'what', 'when', 
                               'which', 'where', 'would', 'could', 'should', 'there',
                               'their', 'these', 'those', 'being', 'other', 'about',
                               'after', 'before', 'between', 'through', 'during',
                               'because', 'while', 'which', 'whose', 'does', 'done',
                               'also', 'into', 'than', 'then', 'just', 'only', 'very']);
    for (const w of englishWords) {
      if (!stopWords.has(w.toLowerCase()) && !tokens.includes(w)) {
        tokens.push(w);
      }
    }
  }

  // 合并去重
  const allTokens = [...new Set([...terms, ...properNouns, ...techTerms, ...tokens])];
  
  return {
    terms: [...new Set(terms)],
    properNouns: [...new Set(properNouns)],
    techTerms: [...new Set(techTerms)],
    tokens: allTokens,
  };
}

/**
 * 判断检索结果是否与提取的实体匹配
 * 
 * 匹配规则：
 * 1. 结果内容包含任意提取的术语 → 高匹配
 * 2. 结果内容包含任意提取的技术术语 → 中匹配
 * 3. 结果内容包含任意提取的 token → 低匹配
 */
export function matchEntityScore(
  content: string,
  entities: ExtractedEntities
): { match: boolean; score: number; matchedTerms: string[]; maxScore: number } {
  if (!entities || entities.tokens.length === 0) {
    return { match: true, score: 1.0, matchedTerms: [], maxScore: 1.0 };
  }

  const contentLower = content.toLowerCase();
  const matchedTerms: string[] = [];
  let score = 0;

  // maxScore: 当前内容理论上能得到的最高分（用于过滤降级判断）
  let maxScore = 0;
  if (entities.terms.length > 0) maxScore += 0.4;
  if (entities.properNouns.length > 0) maxScore += 0.3;
  if (entities.techTerms.length > 0) maxScore += 0.2;
  if (entities.tokens.length > 0) maxScore += 0.1;
  maxScore = Math.min(1.0, maxScore);

  // 高精度匹配：术语（中文短语 + 专有名词）
  for (const term of entities.terms) {
    if (contentLower.includes(term.toLowerCase())) {
      matchedTerms.push(term);
      score += 0.4;
    }
  }
  for (const noun of entities.properNouns) {
    if (contentLower.includes(noun.toLowerCase())) {
      matchedTerms.push(noun);
      score += 0.3;
    }
  }

  // 中精度匹配：技术术语
  for (const term of entities.techTerms) {
    if (contentLower.includes(term.toLowerCase())) {
      matchedTerms.push(term);
      score += 0.2;
    }
  }

  // 低精度匹配：通用 token
  for (const token of entities.tokens) {
    if (contentLower.includes(token.toLowerCase())) {
      if (!matchedTerms.includes(token)) {
        matchedTerms.push(token);
      }
      score += 0.1;
    }
  }

  // 归一化到 0-1
  score = Math.min(1.0, score);

  // 至少匹配到 0.15 分才认为相关
  const match = score >= 0.15;

  return { match, score, matchedTerms, maxScore };
}
/**
 * Phase 2: 置信度级别
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * 根据实体匹配分数返回置信度级别
 * 
 * 分级标准：
 * - high (>=0.6): 命中术语/专有名词，主题高度相关
 * - medium (>=0.3): 命中技术术语或通用token，主题可能相关
 * - low (<0.3): 仅微弱匹配或完全不匹配，仅供参考
 */
export function getConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

/**
 * 将置信度级别转换为中文标签，用于注入 LLM 提示词
 */
export function confidenceLabel(level: ConfidenceLevel): string {
  const labels = { high: '[高置信度]', medium: '[中置信度]', low: '[低置信度]' };
  return labels[level];
}

/**
 * 将置信度级别转换为英文标签（用于结构化输出场景）
 */
export function confidenceLabelEn(level: ConfidenceLevel): string {
  const labels = { high: '[HIGH_CONFIDENCE]', medium: '[MEDIUM_CONFIDENCE]', low: '[LOW_CONFIDENCE]' };
  return labels[level];
}
