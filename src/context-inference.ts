/**
 * Context Inference — 从 query 中推断上下文场景、技术栈、紧急度。
 *
 * 第 1 层：动态 Tag Registry 匹配（替代硬编码常量）
 * 第 1 层：extractFreeTags() 开放词汇提取
 * 零延迟规则匹配，不需要 LLM。
 */

import type { ScenarioTag, TechStackTag } from './experience/types';
import type { TagRegistry } from './experience/tag-registry';

/** 查询上下文结构 */
export interface QueryContext {
  scenario: ScenarioTag[];       // 推断出的场景标签（来自 registry）
  techStack: TechStackTag[];     // 涉及的技术栈标签（来自 registry）
  freeTags: string[];            // 开放标签池（extractFreeTags 提取）
  projects: string[];            // 提及的项目名
  urgency: number;               // 0-1，紧急程度
}

// ---------------------------------------------------------------------------
// 紧急度信号（不需要 registry，固定规则即可）
// ---------------------------------------------------------------------------

const URGENT_PATTERNS: Array<{ pattern: RegExp; level: number }> = [
  { pattern: /(?:error.*error|critical|panic|segfault|core.?dump|fatal)/i, level: 1.0 },
  { pattern: /(?:cannot.start|connection.refused|timeout.*retry|out.of.memory|OOM)/i, level: 0.8 },
  { pattern: /(?:fail|error|exception|throw|raise|not.found)/i, level: 0.5 },
];

// ---------------------------------------------------------------------------
// FreeTags 提取 — 简单分词 + 停用词过滤
// ---------------------------------------------------------------------------

/** 中文/英文混合停用词表 */
const STOP_WORDS = new Set([
  '的','了','在','是','我','有','和','就','不','人','都','一','一个','上',
  '也','很','到','说','要','去','你','会','着','没有','看','好','自己','这',
  '他','她','它','们','那','些','什么','怎么','吗','呢','吧','啊','哦',
  'and','or','the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','can','this','that','these','those','it','its','for',
  'with','from','into','through','during','before','after','by','about',
]);

/**
 * 从 query 中提取自由标签（开放词汇）。
 * 简单实现：分词 → 停用词过滤 → 长度过滤 → 去重。
 * 未来可替换为 TF-IDF / LLM 关键词提取。
 */
export function extractFreeTags(query: string): string[] {
  if (!query || !query.trim()) return [];

  // 中英文混合分词：按非字母数字非汉字分割
  const tokens = query
    .replace(/[\s,;.，；。.、:：!?！？\\/\\[\\](){}|~`@#$%^&*=+<>]+/g, ' ')
    .split(/\s+/)
    .filter((t) => {
      const w = t.toLowerCase();
      return !STOP_WORDS.has(w) && w.length >= 2;
    })
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean);

  // 去重
  const unique = [...new Set(tokens)];

  return unique.slice(0, 10); // 最多 10 个 freeTag
}

// ---------------------------------------------------------------------------
// Project name extraction — 从路径/代码引用中推断项目名
// ---------------------------------------------------------------------------

/**
 * S-6': 从 query 中推断提及的项目名。
 *
 * 匹配规则（按优先级）：
 * 1. 路径模式：例如 "my-project/src/index.ts"、"@org/lib/api.ts"
 * 2. 项目引用模式：例如 "project foo"、"in bar project"、"repo: baz"
 * 3. 仓库 URL：例如 "https://github.com/org/repo"
 *
 * 不新建 sceneId 体系，只用于搜索过滤（soft 模式）。
 */
export function extractProjects(query: string): string[] {
  if (!query || !query.trim()) return [];
  const found = new Set<string>();

  // 1. 路径模式：以 / 或 \ 分隔的路径，第一段非空视为项目名
  // 匹配如 "proj/file.py"、"@scope/pkg/index.ts"、"path/to/file.js"
  const pathPattern = /(?:^|[\s(,.;:!?'"\[])([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9._-]+)+)/g;
  let m: RegExpExecArray | null;
  while ((m = pathPattern.exec(query)) !== null) {
    const fullPath = m[1];
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length >= 2) {
      // 如果第一部分像 @scope 包名，则取前两部分
      if (parts[0].startsWith('@') && parts.length >= 2) {
        found.add(parts[0] + '/' + parts[1]);
      } else {
        found.add(parts[0]);
      }
    }
  }

  // 2. 明确的项目/仓库引用关键词
  const explicitPatterns = [
    /(?:project|repo|repository|package|module|app)\s+(?:name\s*[:=]?\s*)?['"]?([a-zA-Z0-9_@\/-]{2,64})['"]?/gi,
    /(?:in|for|of|from)\s+(?:the\s+)?([a-zA-Z0-9_@\/-]{2,64})\s+(?:project|repo|repository|codebase)/gi,
    /['"]([a-zA-Z0-9_@\/-]{2,64})['"]\s*(?:project|repo)/gi,
  ];
  for (const pat of explicitPatterns) {
    while ((m = pat.exec(query)) !== null) {
      const name = m[1].toLowerCase();
      if (name.length >= 2 && name.length <= 64) {
        found.add(name);
      }
    }
  }

  // 3. GitHub/GitLab 仓库 URL
  const urlPattern = /(?:github\.com|gitlab\.com)\/([\w.-]+)\/([\w.-]+)/gi;
  while ((m = urlPattern.exec(query)) !== null) {
    found.add(m[1] + '/' + m[2]);
  }

  // 过滤掉明显的停用词（常见路径前缀名）
  const STOP_PROJECTS = new Set([
    'src', 'lib', 'dist', 'build', 'test', 'tests', 'node_modules',
    'public', 'assets', 'components', 'pages', 'app', 'apps', 'packages',
    'config', 'scripts', 'utils', 'hooks', 'api', 'docs', 'styles',
  ]);

  const result = [...found]
    .map((p) => p.toLowerCase())
    .filter((p) => !STOP_PROJECTS.has(p) && p.length >= 2 && p.length <= 80)
    .slice(0, 5);

  return result;
}

// ---------------------------------------------------------------------------
// Main inference function — 使用 TagRegistry 动态匹配
// ---------------------------------------------------------------------------

/**
 * 从 query 中推断上下文信息。
 * 使用 TagRegistry 的动态标签规则，支持运行时扩展。
 */
export function inferQueryContext(
  query: string,
  registry?: TagRegistry | null,
): QueryContext {
  const context: QueryContext = {
    scenario: [],
    techStack: [],
    freeTags: [],
    projects: [],
    urgency: 0,
  };

  if (!query || !query.trim()) return context;

  // 1. 场景推断 — 使用 registry 的动态模式
  if (registry) {
    const result = registry.toRegistryResult();

    for (const { pattern, tag } of result.scenarioPatterns) {
      if (pattern.test(query)) {
        context.scenario.push(tag as ScenarioTag);
      }
    }

    for (const { pattern, tag } of result.techStackPatterns) {
      if (pattern.test(query)) {
        context.techStack.push(tag as TechStackTag);
      }
    }
  }

  // 2. 提取自由标签（开放词汇，不依赖 registry）
  context.freeTags = extractFreeTags(query);

  // 3. S-6': 项目名推断 — 从路径、引用、URL 中提取
  context.projects = extractProjects(query);

  // 4. 紧急度推断
  for (const { pattern, level } of URGENT_PATTERNS) {
    if (pattern.test(query)) {
      context.urgency = Math.max(context.urgency, level);
      break;
    }
  }

  return context;
}

/**
 * 根据 QueryContext 生成经验搜索的过滤参数。
 */
export function buildExperienceFilters(context: QueryContext): {
  scenarioTags: ScenarioTag[];
  techStackTags: TechStackTag[];
  freeTags: string[];
  urgencyBoost: number;
} {
  return {
    scenarioTags: context.scenario.length > 0 ? context.scenario : [],
    techStackTags: context.techStack.length > 0 ? context.techStack : [],
    freeTags: context.freeTags,
    urgencyBoost: (context.urgency > 0.5 ? 0.2 : 0),
  };
}

/**
 * 计算经验与上下文的匹配度（用于混合打分）。
 */
export function computeContextMatchScore(
  expTags: { scenario?: string[]; techStack?: string[]; severity?: string; freeTags?: string[] } | undefined,
  context: QueryContext,
): number {
  if (!expTags) return 0.5;

  let score = 0;
  let matchedDims = 0;

  // 场景匹配度
  if (context.scenario.length > 0 && expTags.scenario?.length) {
    const scenarioOverlap = context.scenario.filter(s =>
      expTags.scenario!.includes(s as ScenarioTag),
    ).length;
    score += scenarioOverlap / Math.max(context.scenario.length, expTags.scenario.length);
    matchedDims++;
  }

  // 技术栈匹配度
  if (context.techStack.length > 0 && expTags.techStack?.length) {
    const techOverlap = context.techStack.filter(t =>
      expTags.techStack!.includes(t as TechStackTag),
    ).length;
    score += techOverlap / Math.max(context.techStack.length, expTags.techStack.length);
    matchedDims++;
  }

  // freeTags 匹配度 — 经验上的 freeTag 命中查询上下文中的 freeTag
  if (context.freeTags.length > 0 && expTags.freeTags?.length) {
    const freeOverlap = context.freeTags.filter(f =>
      expTags.freeTags!.includes(f),
    ).length;
    score += freeOverlap / Math.max(context.freeTags.length, expTags.freeTags.length);
    matchedDims++;
  }

  // 紧急度加权
  if (context.urgency > 0.5 && expTags.severity === 'critical') {
    score += 0.3;
  }

  return matchedDims > 0 ? Math.min(score / matchedDims, 1) : 0.5;
}