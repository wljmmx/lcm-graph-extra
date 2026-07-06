/**
 * Context Inference 单元测试。
 *
 * 覆盖：
 * - extractProjects: 路径模式 / 明确项目引用 / GitHub URL / 停用词过滤
 * - inferQueryContext: 场景关键词匹配 / 紧急度推断 / projects 填充 / 无 registry 退化
 * - QueryContext 接口字段验证
 * - 边界条件：空字符串 / null/undefined / 纯中文 / 超长查询
 */
import { describe, it, expect } from 'vitest';
import {
  extractProjects,
  inferQueryContext,
  type QueryContext,
} from './context-inference.js';
import { TagRegistry } from './experience/tag-registry.js';

// 构造 mock Neo4j adapter —— 不调用 load()，TagRegistry 的 tags getter 会 fallback 到 DEFAULT_TAGS
const mockAdapter = {
  query: async (_cypher: string, _params: Record<string, unknown>): Promise<any[]> => [],
};
const registry = new TagRegistry(mockAdapter);

describe('extractProjects', () => {
  describe('路径模式匹配', () => {
    it('匹配相对路径并提取第一段为项目名', () => {
      const result = extractProjects('check myapp/src/index.ts for bugs');
      expect(result).toContain('myapp');
    });

    it('多段路径仅取首段', () => {
      const result = extractProjects('see foobar/utils/helpers.js');
      expect(result).toContain('foobar');
      expect(result).not.toContain('utils');
    });

    it('多个路径分别提取', () => {
      const result = extractProjects('compare app1/main.ts and app2/main.ts');
      expect(result).toContain('app1');
      expect(result).toContain('app2');
    });

    it('绝对路径（以 / 开头）不匹配路径模式', () => {
      // 路径正则要求首字符为 [a-zA-Z0-9_-]，前导 / 不匹配
      const result = extractProjects('check /home/user/project');
      expect(result).toEqual([]);
    });
  });

  describe('明确项目引用', () => {
    it('"in foo project" 模式提取项目名', () => {
      const result = extractProjects('found a bug in myapp project');
      expect(result).toContain('myapp');
    });

    it('"project foo" 模式提取项目名', () => {
      const result = extractProjects('project foobar has issues');
      expect(result).toContain('foobar');
    });

    it('"repo baz" 模式提取项目名', () => {
      const result = extractProjects('repo baz is failing');
      expect(result).toContain('baz');
    });

    it('"for bar codebase" 模式提取项目名', () => {
      const result = extractProjects('optimize performance for bar codebase');
      expect(result).toContain('bar');
    });

    it('纯中文 "在myapp项目中" 不匹配英文关键词模式', () => {
      // 实现使用英文关键词 (in/for/project/repo)，中文 "在...项目中" 不触发
      const result = extractProjects('在myapp项目中');
      expect(result).toEqual([]);
    });
  });

  describe('GitHub URL', () => {
    it('从 GitHub URL 提取 org/repo', () => {
      const result = extractProjects('see https://github.com/user/repo for details');
      expect(result).toContain('user/repo');
    });

    it('从 GitLab URL 提取 org/repo', () => {
      const result = extractProjects('check https://gitlab.com/org/name');
      expect(result).toContain('org/name');
    });

    it('GitHub URL 含 .git 后缀也能提取', () => {
      const result = extractProjects('clone https://github.com/team/project.git');
      // [\w.-]+ 会匹配到 project.git
      expect(result.some((p) => p.startsWith('team/'))).toBe(true);
    });
  });

  describe('停用词过滤（STOP_PROJECTS）', () => {
    it('src 前缀被过滤', () => {
      const result = extractProjects('check src/foo/bar.ts');
      expect(result).not.toContain('src');
      expect(result).toEqual([]);
    });

    it('lib 前缀被过滤', () => {
      const result = extractProjects('see lib/utils/index.js');
      expect(result).not.toContain('lib');
    });

    it('config 前缀被过滤', () => {
      const result = extractProjects('edit config/settings.json');
      expect(result).not.toContain('config');
    });

    it('最多返回 5 个项目', () => {
      const query = 'a1/x b1/x c1/x d1/x e1/x f1/x g1/x';
      const result = extractProjects(query);
      expect(result.length).toBeLessThanOrEqual(5);
    });
  });
});

describe('inferQueryContext', () => {
  describe('场景关键词匹配', () => {
    it('bug-fix 场景识别（英文 bug）', () => {
      const ctx = inferQueryContext('help me fix a bug', registry);
      expect(ctx.scenario).toContain('bug-fix');
    });

    it('bug-fix 场景识别（中文 崩溃）', () => {
      const ctx = inferQueryContext('线上服务崩溃了', registry);
      expect(ctx.scenario).toContain('bug-fix');
    });

    it('feature-dev 场景识别', () => {
      const ctx = inferQueryContext('implement new feature for login', registry);
      expect(ctx.scenario).toContain('feature-dev');
    });

    it('code-review 场景识别', () => {
      const ctx = inferQueryContext('please review this PR', registry);
      expect(ctx.scenario).toContain('code-review');
    });

    it('deployment 场景识别', () => {
      const ctx = inferQueryContext('deploy to production server', registry);
      expect(ctx.scenario).toContain('deployment');
    });

    it('performance-opt 场景识别', () => {
      const ctx = inferQueryContext('the query is slow, need optimization', registry);
      expect(ctx.scenario).toContain('performance-opt');
    });

    it('refactor 场景识别', () => {
      const ctx = inferQueryContext('need to refactor this module', registry);
      expect(ctx.scenario).toContain('refactor');
    });

    it('security-audit 场景识别', () => {
      const ctx = inferQueryContext('check for security issues and injection', registry);
      expect(ctx.scenario).toContain('security-audit');
    });

    it('多场景同时匹配', () => {
      // "fix" → bug-fix, "review" → code-review
      const ctx = inferQueryContext('fix the bug then review the code', registry);
      expect(ctx.scenario).toContain('bug-fix');
      expect(ctx.scenario).toContain('code-review');
    });
  });

  describe('技术栈关键词匹配', () => {
    it('frontend 识别（react）', () => {
      const ctx = inferQueryContext('use react for the UI', registry);
      expect(ctx.techStack).toContain('frontend');
    });

    it('backend 识别（python api）', () => {
      const ctx = inferQueryContext('build a python api service', registry);
      expect(ctx.techStack).toContain('backend');
    });

    it('database 识别（postgres/sql）', () => {
      const ctx = inferQueryContext('query postgres with sql', registry);
      expect(ctx.techStack).toContain('database');
    });

    it('devops 识别（docker/k8s）', () => {
      const ctx = inferQueryContext('deploy with docker and k8s', registry);
      expect(ctx.techStack).toContain('devops');
    });

    it('ai-ml 识别（llm/embedding）', () => {
      const ctx = inferQueryContext('use llm embedding for rag', registry);
      expect(ctx.techStack).toContain('ai-ml');
    });
  });

  describe('紧急度推断（urgency / 压力等级）', () => {
    it('critical/panic 等关键词 → urgency 1.0', () => {
      const ctx = inferQueryContext('critical panic in production', registry);
      expect(ctx.urgency).toBe(1.0);
    });

    it('fatal → urgency 1.0', () => {
      const ctx = inferQueryContext('fatal error in the system', registry);
      expect(ctx.urgency).toBe(1.0);
    });

    it('connection refused → urgency 0.8', () => {
      const ctx = inferQueryContext('connection refused on port 5432', registry);
      expect(ctx.urgency).toBe(0.8);
    });

    it('fail/error → urgency 0.5', () => {
      const ctx = inferQueryContext('fail to load module', registry);
      expect(ctx.urgency).toBe(0.5);
    });

    it('普通查询 → urgency 0', () => {
      const ctx = inferQueryContext('how to write a function', registry);
      expect(ctx.urgency).toBe(0);
    });

    it('最高级别优先（break on first match）', () => {
      // 同时含 critical（1.0）和 fail（0.5），应取 1.0
      const ctx = inferQueryContext('critical: fail to start', registry);
      expect(ctx.urgency).toBe(1.0);
    });

    it('error.*error 连续 error 模式 → urgency 1.0', () => {
      const ctx = inferQueryContext('error error everywhere', registry);
      expect(ctx.urgency).toBe(1.0);
    });
  });

  describe('projects 正确填充', () => {
    it('从查询中提取项目名', () => {
      const ctx = inferQueryContext('check myapp/src/index.ts for a bug', registry);
      expect(ctx.projects).toContain('myapp');
    });

    it('从 GitHub URL 提取项目名', () => {
      const ctx = inferQueryContext('see https://github.com/org/repo for the fix', registry);
      expect(ctx.projects).toContain('org/repo');
    });

    it('无项目引用时 projects 为空', () => {
      const ctx = inferQueryContext('how to write a loop', registry);
      expect(ctx.projects).toEqual([]);
    });

    it('STOP_PROJECTS 前缀被过滤', () => {
      const ctx = inferQueryContext('check src/foo/bar.ts', registry);
      expect(ctx.projects).not.toContain('src');
    });
  });

  describe('无 registry 退化', () => {
    it('不传 registry 时 scenario/techStack 为空', () => {
      const ctx = inferQueryContext('fix a bug in react');
      expect(ctx.scenario).toEqual([]);
      expect(ctx.techStack).toEqual([]);
      // 但 freeTags/projects/urgency 仍工作
      expect(ctx.freeTags.length).toBeGreaterThan(0);
    });

    it('传 null registry 时 scenario/techStack 为空', () => {
      const ctx = inferQueryContext('fix a bug', null);
      expect(ctx.scenario).toEqual([]);
      expect(ctx.techStack).toEqual([]);
    });

    it('无 registry 时 projects 仍可提取', () => {
      const ctx = inferQueryContext('check myapp/src/index.ts');
      expect(ctx.projects).toContain('myapp');
    });
  });
});

describe('QueryContext 接口字段验证', () => {
  it('返回对象包含所有必需字段', () => {
    const ctx = inferQueryContext('fix bug in myapp/src', registry);
    expect(ctx).toHaveProperty('scenario');
    expect(ctx).toHaveProperty('techStack');
    expect(ctx).toHaveProperty('freeTags');
    expect(ctx).toHaveProperty('projects');
    expect(ctx).toHaveProperty('urgency');
  });

  it('字段类型正确', () => {
    const ctx = inferQueryContext('fix bug in myapp/src', registry);
    expect(Array.isArray(ctx.scenario)).toBe(true);
    expect(Array.isArray(ctx.techStack)).toBe(true);
    expect(Array.isArray(ctx.freeTags)).toBe(true);
    expect(Array.isArray(ctx.projects)).toBe(true);
    expect(typeof ctx.urgency).toBe('number');
  });

  it('scenario 元素为 ScenarioTag 字符串', () => {
    const ctx = inferQueryContext('fix a bug', registry);
    for (const s of ctx.scenario) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('techStack 元素为 TechStackTag 字符串', () => {
    const ctx = inferQueryContext('use react and python', registry);
    for (const t of ctx.techStack) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it('urgency 在 0-1 范围内', () => {
    const ctx = inferQueryContext('critical error crash', registry);
    expect(ctx.urgency).toBeGreaterThanOrEqual(0);
    expect(ctx.urgency).toBeLessThanOrEqual(1);
  });

  it('freeTags 最多 10 个', () => {
    const longQuery = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi';
    const ctx = inferQueryContext(longQuery, registry);
    expect(ctx.freeTags.length).toBeLessThanOrEqual(10);
  });
});

describe('边界条件', () => {
  describe('extractProjects 边界', () => {
    it('空字符串返回空数组', () => {
      expect(extractProjects('')).toEqual([]);
    });

    it('null 输入返回空数组', () => {
      expect(extractProjects(null as any)).toEqual([]);
    });

    it('undefined 输入返回空数组', () => {
      expect(extractProjects(undefined as any)).toEqual([]);
    });

    it('纯空白返回空数组', () => {
      expect(extractProjects('   \t\n  ')).toEqual([]);
    });

    it('无路径/引用/URL 的纯文本返回空数组', () => {
      expect(extractProjects('how to write a function')).toEqual([]);
    });
  });

  describe('inferQueryContext 边界', () => {
    it('空字符串返回空上下文', () => {
      const ctx = inferQueryContext('');
      expect(ctx.scenario).toEqual([]);
      expect(ctx.techStack).toEqual([]);
      expect(ctx.freeTags).toEqual([]);
      expect(ctx.projects).toEqual([]);
      expect(ctx.urgency).toBe(0);
    });

    it('null 输入返回空上下文', () => {
      const ctx = inferQueryContext(null as any);
      expect(ctx.scenario).toEqual([]);
      expect(ctx.techStack).toEqual([]);
      expect(ctx.freeTags).toEqual([]);
      expect(ctx.projects).toEqual([]);
      expect(ctx.urgency).toBe(0);
    });

    it('undefined 输入返回空上下文', () => {
      const ctx = inferQueryContext(undefined as any);
      expect(ctx.scenario).toEqual([]);
      expect(ctx.techStack).toEqual([]);
      expect(ctx.freeTags).toEqual([]);
      expect(ctx.projects).toEqual([]);
      expect(ctx.urgency).toBe(0);
    });

    it('纯空白返回空上下文', () => {
      const ctx = inferQueryContext('   \t\n  ');
      expect(ctx.scenario).toEqual([]);
      expect(ctx.urgency).toBe(0);
    });

    it('纯中文查询不崩溃且能匹配中文关键词', () => {
      const ctx = inferQueryContext('服务崩溃了，需要修复', registry);
      expect(ctx.scenario).toContain('bug-fix');
      // 紧急度模式为英文，中文 "崩溃" 不触发 urgency 正则
      expect(ctx.urgency).toBe(0);
      // freeTags 简单分词不会拆分中文，整段作为一个 token
      expect(ctx.freeTags.length).toBeGreaterThan(0);
    });

    it('超长查询（10000+ 字符）不崩溃', () => {
      const longQuery = 'fix a bug in myapp/src/index.ts '.repeat(400);
      const ctx = inferQueryContext(longQuery, registry);
      expect(ctx.scenario).toContain('bug-fix');
      expect(ctx.projects).toContain('myapp');
      expect(ctx.freeTags.length).toBeLessThanOrEqual(10);
      expect(ctx.projects.length).toBeLessThanOrEqual(5);
      expect(ctx.urgency).toBeGreaterThanOrEqual(0);
      expect(ctx.urgency).toBeLessThanOrEqual(1);
    });

    it('仅特殊字符不崩溃', () => {
      const ctx = inferQueryContext('!!! ??? ... /// ::: ', registry);
      expect(ctx.scenario).toEqual([]);
      // freeTags 行为取决于分词正则，关键是不崩溃
      expect(ctx.urgency).toBe(0);
    });
  });
});
