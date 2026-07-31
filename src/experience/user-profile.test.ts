/**
 * S-7': UserProfileTracker 单元测试。
 *
 * 覆盖：
 * - observe() 偏好信号提取（6 类技术栈、4 类场景、语言偏好）
 * - computeBoost() boost 系数计算 [1.0, 1.3]
 * - decayIfNeeded() 24h 半衰期时间衰减
 * - getTopTechStack / getTopScenario / getLanguage 查询方法
 * - 边界条件：空字符串、无匹配、多次累积、衰减后 < 0.1 删除
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserProfileTracker } from './user-profile.js';
import { normalizeFreeTags } from './storage.js';

describe('UserProfileTracker', () => {
  let tracker: UserProfileTracker;

  beforeEach(() => {
    tracker = new UserProfileTracker();
  });

  describe('observe - 偏好信号提取', () => {
    it('6 类技术栈关键词提取', () => {
      // 每类命中 2 个关键词：min(2,3)*0.5 = 1.0
      // 注意：避免 'mysql'(含 'sql')、'plain'(含 'ai') 等子串串扰
      tracker.observe('react vue python rust docker nginx redis postgres swift ios embedding vector');
      const top = tracker.getTopTechStack(6);
      const names = top.map((t) => t.name);
      expect(names).toContain('frontend');
      expect(names).toContain('backend');
      expect(names).toContain('devops');
      expect(names).toContain('database');
      expect(names).toContain('mobile');
      expect(names).toContain('ai-ml');
      for (const t of top) {
        expect(t.weight).toBeCloseTo(1.0, 5);
      }
    });

    it('4 类场景关键词提取', () => {
      // 每类命中 2 个关键词：min(2,2)*0.3 = 0.6
      tracker.observe('bug error feature implement perf slow config setting');
      const top = tracker.getTopScenario(4);
      const names = top.map((s) => s.name);
      expect(names).toContain('bug-fix');
      expect(names).toContain('feature-dev');
      expect(names).toContain('performance-opt');
      expect(names).toContain('config-debug');
      for (const s of top) {
        expect(s.weight).toBeCloseTo(0.6, 5);
      }
    });

    it('语言偏好 - 中文（zhRatio > 0.6 → zh）', () => {
      tracker.observe('这是一段中文测试内容用于测试语言偏好检测功能');
      expect(tracker.getLanguage()).toBe('zh');
    });

    it('语言偏好 - 英文（zhRatio < 0.3 → en）', () => {
      tracker.observe('this is an english test message for language detection');
      expect(tracker.getLanguage()).toBe('en');
    });

    it('语言偏好 - 混合（0.3 ≤ zhRatio ≤ 0.6 → mixed）', () => {
      // 中文 16 字 + 英文 21 字 = 37，zhRatio ≈ 0.43
      tracker.observe('这是一段中文内容用于测试混合语言 mixed with english words');
      expect(tracker.getLanguage()).toBe('mixed');
    });
  });

  describe('computeBoost - boost 系数计算', () => {
    it('无 tags 参数返回 1.0', () => {
      expect(tracker.computeBoost()).toBe(1.0);
    });

    it('匹配技术栈 boost 增加', () => {
      // frontend: react, vue → min(2,3)*0.5 = 1.0
      tracker.observe('react vue frontend development here');
      const boost = tracker.computeBoost({ techStack: ['frontend'] });
      // matched=1, maxWeight=1.0 → 0.05*1 + 0.02*1.0 = 0.07
      expect(boost).toBeCloseTo(1.07, 5);
    });

    it('匹配场景 boost 增加', () => {
      // bug-fix: bug, error → min(2,2)*0.3 = 0.6
      tracker.observe('there is a bug error in code here');
      const boost = tracker.computeBoost({ scenario: ['bug-fix'] });
      // matched=1 → 0.05*1 = 0.05
      expect(boost).toBeCloseTo(1.05, 5);
    });

    it('同时匹配技术栈和场景 boost 累加', () => {
      // frontend: react, vue → 1.0; bug-fix: bug, error, fix → min(3,2)*0.3 = 0.6
      tracker.observe('react vue bug error frontend fix');
      const boost = tracker.computeBoost({
        techStack: ['frontend'],
        scenario: ['bug-fix'],
      });
      // tech: 0.05*1 + 0.02*1.0 = 0.07; scenario: 0.05*1 = 0.05
      expect(boost).toBeCloseTo(1.12, 5);
    });

    it('boost 不超过上限 1.3', () => {
      // 直接设置高权重触达上限
      const prefs = (tracker as any).prefs;
      prefs.techStack.set('frontend', 5.0);
      prefs.techStack.set('backend', 5.0);
      prefs.techStack.set('devops', 5.0);
      prefs.scenario.set('bug-fix', 3.0);
      prefs.scenario.set('feature-dev', 3.0);
      const boost = tracker.computeBoost({
        techStack: ['frontend', 'backend', 'devops'],
        scenario: ['bug-fix', 'feature-dev'],
      });
      // tech: 0.05*min(3,2) + 0.02*5 = 0.20; scenario: 0.05*min(2,2) = 0.10
      // total = 1.0 + 0.20 + 0.10 = 1.30，上限裁剪
      expect(boost).toBeCloseTo(1.3, 5);
    });

    it('无匹配返回 1.0', () => {
      tracker.observe('react vue frontend development here');
      const boost = tracker.computeBoost({ techStack: ['backend'] });
      expect(boost).toBe(1.0);
    });
  });

  describe('decayIfNeeded - 24h 半衰期时间衰减', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('1h 内不触发衰减', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      tracker.observe('react vue frontend development here'); // frontend: 1.0
      // 推进 30 分钟（< 1h 阈值）
      const t1 = t0 + 30 * 60 * 1000;
      vi.setSystemTime(t1);
      (tracker as any).decayIfNeeded(t1);
      const top = tracker.getTopTechStack(1);
      expect(top[0].weight).toBeCloseTo(1.0, 5);
    });

    it('24h 后权重减半', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      tracker.observe('react vue frontend development here'); // frontend: 1.0
      // 推进 24h（一个半衰期）：decayFactor = 0.5^1 = 0.5
      const t1 = t0 + 24 * 60 * 60 * 1000;
      vi.setSystemTime(t1);
      (tracker as any).decayIfNeeded(t1);
      const top = tracker.getTopTechStack(1);
      expect(top[0].name).toBe('frontend');
      expect(top[0].weight).toBeCloseTo(0.5, 5);
    });

    it('衰减后权重 < 0.1 被删除', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      // bug-fix 1 个关键词：min(1,2)*0.3 = 0.3
      tracker.observe('there is a bug in the code here');
      expect(tracker.getTopScenario()).toHaveLength(1);
      // 推进 48h：decayFactor = 0.5^2 = 0.25，0.3 * 0.25 = 0.075 < 0.1 → 删除
      const t1 = t0 + 48 * 60 * 60 * 1000;
      vi.setSystemTime(t1);
      (tracker as any).decayIfNeeded(t1);
      expect(tracker.getTopScenario()).toHaveLength(0);
    });

    it('衰减不足 5% 跳过（decayFactor >= 0.95）', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      tracker.observe('react vue frontend development here'); // frontend: 1.0
      // 推进 1.5h：decayFactor = 0.5^(1.5/24) ≈ 0.958 > 0.95 → 跳过
      const t1 = t0 + Math.floor(1.5 * 60 * 60 * 1000);
      vi.setSystemTime(t1);
      (tracker as any).decayIfNeeded(t1);
      const top = tracker.getTopTechStack(1);
      expect(top[0].weight).toBeCloseTo(1.0, 5);
    });

    it('多次衰减累积（72h 后 0.3 → 0.0375 < 0.1 → 删除）', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      tracker.observe('there is a bug in the code here'); // bug-fix: 0.3
      // 推进 72h（3 个半衰期）：decayFactor = 0.5^3 = 0.125，0.3 * 0.125 = 0.0375 < 0.1
      const t1 = t0 + 72 * 60 * 60 * 1000;
      vi.setSystemTime(t1);
      (tracker as any).decayIfNeeded(t1);
      expect(tracker.getTopScenario()).toHaveLength(0);
    });
  });

  describe('查询方法', () => {
    it('getTopTechStack 返回 top N 按权重降序', () => {
      tracker.observe('react vue angular typescript here'); // frontend: min(4,3)*0.5 = 1.5
      tracker.observe('python java backend here'); // backend: min(2,3)*0.5 = 1.0
      const top2 = tracker.getTopTechStack(2);
      expect(top2).toHaveLength(2);
      expect(top2[0].name).toBe('frontend');
      expect(top2[0].weight).toBeCloseTo(1.5, 5);
      expect(top2[1].name).toBe('backend');
      expect(top2[1].weight).toBeCloseTo(1.0, 5);
    });

    it('getTopTechStack weight 上限 5', () => {
      // 每次加 1.5，4 次 = 6.0，上限裁剪为 5
      for (let i = 0; i < 4; i++) {
        tracker.observe('react vue angular redux zustand svelte');
      }
      const top = tracker.getTopTechStack(1);
      expect(top[0].weight).toBeLessThanOrEqual(5);
      expect(top[0].weight).toBeCloseTo(5.0, 5);
    });

    it('getTopScenario 返回 top N 按权重降序', () => {
      tracker.observe('bug error fix crash'); // bug-fix: min(4,2)*0.3 = 0.6
      tracker.observe('feature implement add create'); // feature-dev: min(4,2)*0.3 = 0.6
      const top2 = tracker.getTopScenario(2);
      expect(top2).toHaveLength(2);
      const names = top2.map((s) => s.name).sort();
      expect(names).toEqual(['bug-fix', 'feature-dev']);
      for (const s of top2) {
        expect(s.weight).toBeCloseTo(0.6, 5);
      }
    });

    it('getTopScenario weight 上限 3', () => {
      // 每次加 0.6，5 次 = 3.0，上限 3
      for (let i = 0; i < 5; i++) {
        tracker.observe('bug error fix crash here');
      }
      const top = tracker.getTopScenario(1);
      expect(top[0].weight).toBeLessThanOrEqual(3);
      expect(top[0].weight).toBeCloseTo(3.0, 5);
    });

    it('getLanguage 返回语言偏好', () => {
      expect(tracker.getLanguage()).toBe('mixed'); // 初始值
      tracker.observe('这是一段中文测试内容用于测试语言偏好检测功能');
      expect(tracker.getLanguage()).toBe('zh');
    });
  });

  describe('边界条件', () => {
    it('空字符串输入不修改偏好', () => {
      tracker.observe('');
      expect(tracker.getTopTechStack()).toHaveLength(0);
      expect(tracker.getTopScenario()).toHaveLength(0);
      expect(tracker.getLanguage()).toBe('mixed');
    });

    it('仅空白字符输入不修改偏好', () => {
      tracker.observe('   \n\t  ');
      expect(tracker.getTopTechStack()).toHaveLength(0);
      expect(tracker.getTopScenario()).toHaveLength(0);
      expect(tracker.getLanguage()).toBe('mixed');
    });

    it('长度 < 10 的文本不修改偏好', () => {
      tracker.observe('react vue'); // 9 chars < 10
      expect(tracker.getTopTechStack()).toHaveLength(0);
      expect(tracker.getTopScenario()).toHaveLength(0);
    });

    it('无匹配关键词不修改 techStack/scenario', () => {
      // 避免 'plain' 含 'ai' 等子串串扰
      tracker.observe('hello world text content here');
      expect(tracker.getTopTechStack()).toHaveLength(0);
      expect(tracker.getTopScenario()).toHaveLength(0);
    });

    it('多次 observe 累积权重', () => {
      tracker.observe('react vue frontend development here'); // +1.0
      tracker.observe('react vue frontend development here'); // +1.0
      const top = tracker.getTopTechStack(1);
      expect(top[0].name).toBe('frontend');
      expect(top[0].weight).toBeCloseTo(2.0, 5);
    });
  });

  describe('reset', () => {
    it('清空所有偏好', () => {
      tracker.observe('react vue frontend development here');
      expect(tracker.getTopTechStack()).toHaveLength(1);
      tracker.reset();
      expect(tracker.getTopTechStack()).toHaveLength(0);
      expect(tracker.getTopScenario()).toHaveLength(0);
      expect(tracker.getLanguage()).toBe('mixed');
    });
  });
});

// ---------------------------------------------------------------------------
// P3-4: normalizeFreeTags 标签归一化
// ---------------------------------------------------------------------------

describe('normalizeFreeTags', () => {
  it('空数组返回空数组', () => {
    expect(normalizeFreeTags([])).toEqual([]);
  });

  it('lowercase 转换', () => {
    expect(normalizeFreeTags(['React', 'VUE', 'TypeScript'])).toEqual([
      'react',
      'vue',
      'typescript',
    ]);
  });

  it('trim 去除两端空格', () => {
    expect(normalizeFreeTags(['  react  ', ' vue ', 'angular'])).toEqual([
      'react',
      'vue',
      'angular',
    ]);
  });

  it('去重：相同 normalize 后的标签只保留第一个', () => {
    expect(normalizeFreeTags(['React', 'react', '  react  ', 'Vue'])).toEqual([
      'react',
      'vue',
    ]);
  });

  it('过滤空字符串', () => {
    expect(normalizeFreeTags(['react', '', '  ', 'vue'])).toEqual(['react', 'vue']);
  });

  it('混合场景：trim + lowercase + 去重 + 过滤空', () => {
    expect(
      normalizeFreeTags(['  React.js ', 'react.js', '', ' Vue ', 'vue', '  Angular  ']),
    ).toEqual(['react.js', 'vue', 'angular']);
  });

  it('单个标签原样归一化', () => {
    expect(normalizeFreeTags(['  Hello-World  '])).toEqual(['hello-world']);
  });

  it('全部空字符串返回空数组', () => {
    expect(normalizeFreeTags(['', '  ', '\t'])).toEqual([]);
  });
});
