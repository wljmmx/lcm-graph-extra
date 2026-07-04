/**
 * S-7': 用户画像轻量版 —— 从用户消息中提取偏好，用于个性化搜索加权。
 *
 * 设计原则：
 * - 零延迟：纯规则提取，不调用 LLM
 * - 轻量级：内存存储，带时间衰减，不持久化（重启重置）
 * - 只用于搜索加权（boost），不影响核心召回
 *
 * 偏好维度：
 * - techStack: 技术栈偏好（从代码片段、关键词提取）
 * - scenario: 场景偏好（从高频问题类型推断）
 * - language: 语言偏好（中文/英文）
 */

const TECH_KEYWORDS: Record<string, string[]> = {
  'frontend': ['react', 'vue', 'angular', 'typescript', 'javascript', 'css', 'html', 'webpack', 'vite', 'next.js', 'nuxt', 'svelte', 'tailwind', 'redux', 'zustand', '前端', '组件', '样式'],
  'backend': ['node', 'python', 'java', 'go', 'golang', 'rust', 'spring', 'django', 'flask', 'express', 'fastapi', '后端', '接口', 'api', 'server', '数据库'],
  'devops': ['docker', 'kubernetes', 'k8s', 'ci', 'cd', 'pipeline', 'jenkins', 'terraform', 'ansible', 'nginx', '部署', '运维', '容器', '镜像'],
  'database': ['mysql', 'postgres', 'mongodb', 'redis', 'sqlite', 'elasticsearch', 'sql', 'nosql', '数据库', '缓存', '查询优化'],
  'mobile': ['react-native', 'flutter', 'swift', 'kotlin', 'ios', 'android', '移动端', 'app'],
  'ai-ml': ['llm', 'ai', 'ml', '机器学习', '深度学习', '神经网络', 'embedding', 'vector', 'rag', 'prompt', '模型', '训练'],
};

const SCENARIO_KEYWORDS: Record<string, string[]> = {
  'bug-fix': ['bug', 'error', 'fail', 'fix', 'crash', 'exception', '修复', '错误', '报错', '崩溃', '异常', 'debug'],
  'feature-dev': ['feature', 'implement', 'add', 'create', 'build', '新功能', '实现', '添加', '开发'],
  'performance-opt': ['perf', 'slow', 'optim', 'latency', '性能', '优化', '提速', '慢'],
  'config-debug': ['config', 'setting', '配置', '设置', 'env', '环境'],
};

export interface UserPreferences {
  techStack: Map<string, number>;
  scenario: Map<string, number>;
  language: 'zh' | 'en' | 'mixed';
  lastUpdate: number;
}

/**
 * S-7': 用户画像追踪器（轻量版）
 *
 * 从用户消息中累积偏好信号，带指数衰减（半衰期约 24h）。
 * 用于经验搜索时的个性化加权，不参与核心召回逻辑。
 */
export class UserProfileTracker {
  private prefs: UserPreferences = {
    techStack: new Map(),
    scenario: new Map(),
    language: 'mixed',
    lastUpdate: 0,
  };

  private decayHalfLifeMs = 24 * 60 * 60 * 1000;

  /** 从用户文本中提取偏好信号并累积 */
  observe(text: string): void {
    if (!text || text.trim().length < 10) return;

    const now = Date.now();
    const lower = text.toLowerCase();

    this.decayIfNeeded(now);

    // 技术栈偏好
    for (const [tech, keywords] of Object.entries(TECH_KEYWORDS)) {
      let count = 0;
      for (const kw of keywords) {
        const idx = lower.indexOf(kw);
        if (idx >= 0) {
          count++;
        }
      }
      if (count > 0) {
        const current = this.prefs.techStack.get(tech) || 0;
        this.prefs.techStack.set(tech, current + Math.min(count, 3) * 0.5);
      }
    }

    // 场景偏好
    for (const [scenario, keywords] of Object.entries(SCENARIO_KEYWORDS)) {
      let count = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) count++;
      }
      if (count > 0) {
        const current = this.prefs.scenario.get(scenario) || 0;
        this.prefs.scenario.set(scenario, current + Math.min(count, 2) * 0.3);
      }
    }

    // 语言偏好：简单统计中英文比例
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
    const total = chineseChars + englishChars;
    if (total > 10) {
      const zhRatio = chineseChars / total;
      if (zhRatio > 0.6) this.prefs.language = 'zh';
      else if (zhRatio < 0.3) this.prefs.language = 'en';
      else this.prefs.language = 'mixed';
    }

    this.prefs.lastUpdate = now;
  }

  /**
   * 获取 top N 偏好技术栈。
   * 返回 [{ name, weight }]，weight 范围约 0-5。
   */
  getTopTechStack(n: number = 3): Array<{ name: string; weight: number }> {
    return [...this.prefs.techStack.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, weight]) => ({ name, weight: Math.min(weight, 5) }));
  }

  /** 获取 top N 偏好场景 */
  getTopScenario(n: number = 2): Array<{ name: string; weight: number }> {
    return [...this.prefs.scenario.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, weight]) => ({ name, weight: Math.min(weight, 3) }));
  }

  /** 获取语言偏好 */
  getLanguage(): 'zh' | 'en' | 'mixed' {
    return this.prefs.language;
  }

  /**
   * 计算偏好对搜索结果的 boost 系数 [1.0, 1.3]。
   * 匹配到偏好的经验会获得小幅加权，避免过度偏置。
   */
  computeBoost(expTags?: { scenario?: string[]; techStack?: string[] }): number {
    if (!expTags) return 1.0;

    let boost = 1.0;
    const topTech = this.getTopTechStack(3);
    const topScenario = this.getTopScenario(2);

    // 技术栈匹配 boost（最多 +0.15）
    if (expTags.techStack?.length && topTech.length > 0) {
      const matched = expTags.techStack.filter((t) =>
        topTech.some((pt) => pt.name === t),
      ).length;
      if (matched > 0) {
        const maxWeight = Math.max(
          ...topTech.filter((pt) => expTags.techStack!.includes(pt.name)).map((pt) => pt.weight),
          0,
        );
        boost += 0.05 * Math.min(matched, 2) + 0.02 * maxWeight;
      }
    }

    // 场景匹配 boost（最多 +0.10）
    if (expTags.scenario?.length && topScenario.length > 0) {
      const matched = expTags.scenario.filter((s) =>
        topScenario.some((ps) => ps.name === s),
      ).length;
      if (matched > 0) {
        boost += 0.05 * Math.min(matched, 2);
      }
    }

    return Math.min(boost, 1.3);
  }

  /** 应用时间衰减 */
  private decayIfNeeded(now: number): void {
    const elapsed = now - this.prefs.lastUpdate;
    if (elapsed < 60 * 60 * 1000) return; // 至少 1h 才衰减一次

    const decayFactor = Math.pow(0.5, elapsed / this.decayHalfLifeMs);
    if (decayFactor >= 0.95) return; // 衰减不足 5% 跳过

    for (const [key, val] of this.prefs.techStack) {
      const decayed = val * decayFactor;
      if (decayed < 0.1) {
        this.prefs.techStack.delete(key);
      } else {
        this.prefs.techStack.set(key, decayed);
      }
    }

    for (const [key, val] of this.prefs.scenario) {
      const decayed = val * decayFactor;
      if (decayed < 0.1) {
        this.prefs.scenario.delete(key);
      } else {
        this.prefs.scenario.set(key, decayed);
      }
    }

    this.prefs.lastUpdate = now;
  }

  /** 重置（用于测试） */
  reset(): void {
    this.prefs = {
      techStack: new Map(),
      scenario: new Map(),
      language: 'mixed',
      lastUpdate: 0,
    };
  }
}
