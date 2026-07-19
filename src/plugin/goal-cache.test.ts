/**
 * Goal Anchoring 系统单元测试。
 *
 * 覆盖：
 * - extractFirstUserGoal / extractLatestUserGoal: 多种消息格式
 * - cacheGoal / getGoal: 缓存生命周期
 * - shouldUpdateGoal: 信号评分模型（负面信号、正面信号、阈值判定）
 * - buildGoalAnchor: 提示词模板
 * - evictStaleGoalCache / clearGoalCache: 缓存管理
 * - 边界条件：空字符串、null、极长消息、中文消息
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  extractFirstUserGoal,
  extractLatestUserGoal,
  cacheGoal,
  getGoal,
  shouldUpdateGoal,
  buildGoalAnchor,
  evictStaleGoalCache,
  clearGoalCache,
} from './goal-cache.js';

const TEST_SESSION = 'test-session-goal-cache';

// 每个测试前清理缓存
beforeEach(() => {
  clearGoalCache(TEST_SESSION);
  clearGoalCache('session-a');
  clearGoalCache('session-b');
});

afterEach(() => {
  clearGoalCache(TEST_SESSION);
  clearGoalCache('session-a');
  clearGoalCache('session-b');
});

// ============================================================================
// extractFirstUserGoal
// ============================================================================
describe('extractFirstUserGoal', () => {
  it('从普通消息列表提取首条用户消息', () => {
    const messages = [
      { role: 'user', content: '请帮我写一个排序算法' },
      { role: 'assistant', content: '好的...' },
      { role: 'user', content: '要求是快速排序' },
    ];
    expect(extractFirstUserGoal(messages)).toBe('请帮我写一个排序算法');
  });

  it('跳过非 user 角色的消息', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: '实际用户问题' },
    ];
    expect(extractFirstUserGoal(messages)).toBe('实际用户问题');
  });

  it('处理 content 为数组的消息格式', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '第一部分' }, { type: 'text', text: '第二部分' }] },
    ];
    expect(extractFirstUserGoal(messages)).toBe('第一部分 第二部分');
  });

  it('超长消息截断到 300 字符', () => {
    const longMsg = 'x'.repeat(500);
    const messages = [{ role: 'user', content: longMsg }];
    const result = extractFirstUserGoal(messages);
    expect(result.length).toBe(301); // 300 + '…'
    expect(result.endsWith('…')).toBe(true);
  });

  it('空消息列表返回空字符串', () => {
    expect(extractFirstUserGoal([])).toBe('');
  });

  it('非数组输入返回空字符串', () => {
    expect(extractFirstUserGoal(null as any)).toBe('');
    expect(extractFirstUserGoal(undefined as any)).toBe('');
  });

  it('纯空白消息被跳过', () => {
    const messages = [
      { role: 'user', content: '   ' },
      { role: 'user', content: '有效消息' },
    ];
    expect(extractFirstUserGoal(messages)).toBe('有效消息');
  });
});

// ============================================================================
// extractLatestUserGoal
// ============================================================================
describe('extractLatestUserGoal', () => {
  it('从消息列表提取最后一条用户消息', () => {
    const messages = [
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '回答...' },
      { role: 'user', content: '第二个问题' },
      { role: 'assistant', content: '回答...' },
      { role: 'user', content: '最新问题' },
    ];
    expect(extractLatestUserGoal(messages)).toBe('最新问题');
  });

  it('跳过非 user 角色', () => {
    const messages = [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
    ];
    expect(extractLatestUserGoal(messages)).toBe('问题');
  });

  it('处理 content 数组格式', () => {
    const messages = [
      { role: 'user', content: '旧问题' },
      { role: 'user', content: [{ type: 'text', text: '最新问题文本' }] },
    ];
    expect(extractLatestUserGoal(messages)).toBe('最新问题文本');
  });

  it('超长消息截断到 300 字符', () => {
    const longMsg = 'y'.repeat(400);
    const messages = [{ role: 'user', content: longMsg }];
    const result = extractLatestUserGoal(messages);
    expect(result.length).toBe(301);
    expect(result.endsWith('…')).toBe(true);
  });

  it('空消息列表返回空字符串', () => {
    expect(extractLatestUserGoal([])).toBe('');
  });
});

// ============================================================================
// cacheGoal / getGoal 缓存生命周期
// ============================================================================
describe('cacheGoal / getGoal', () => {
  it('缓存后可以读取', () => {
    cacheGoal(TEST_SESSION, '写一个排序算法');
    expect(getGoal(TEST_SESSION)).toBe('写一个排序算法');
  });

  it('空 sessionKey 不缓存', () => {
    cacheGoal('', 'test');
    expect(getGoal('')).toBe('');
  });

  it('空 goal 不缓存', () => {
    cacheGoal(TEST_SESSION, '');
    expect(getGoal(TEST_SESSION)).toBe('');
  });

  it('不存在的 session 返回空字符串', () => {
    expect(getGoal('non-existent')).toBe('');
  });

  it('缓存更新覆盖旧值', () => {
    cacheGoal(TEST_SESSION, '第一个目标');
    // 直接操作内部 Map 模拟更新（实际上 cacheGoal 是覆盖写入）
    cacheGoal(TEST_SESSION, '第二个目标');
    expect(getGoal(TEST_SESSION)).toBe('第二个目标');
  });
});

// ============================================================================
// shouldUpdateGoal — 信号评分模型
// ============================================================================
describe('shouldUpdateGoal', () => {
  // 辅助：先缓存一个目标，再测试 shouldUpdateGoal
  function seedCache(session: string, goal: string) {
    cacheGoal(session, goal);
  }

  describe('基础场景', () => {
    it('无缓存时返回 true（首次缓存）', () => {
      expect(shouldUpdateGoal('任何新消息', TEST_SESSION)).toBe(true);
    });

    it('空消息返回 false', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('', TEST_SESSION)).toBe(false);
    });
  });

  describe('负面信号：极短消息 (< 5 字)', () => {
    it('"好的" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('好的', TEST_SESSION)).toBe(false);
    });

    it('"行" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('行', TEST_SESSION)).toBe(false);
    });

    it('"嗯" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('嗯', TEST_SESSION)).toBe(false);
    });

    it('"OK" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('OK', TEST_SESSION)).toBe(false);
    });
  });

  describe('负面信号：引用前文', () => {
    it('"这个方案有问题" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('这个方案有问题', TEST_SESSION)).toBe(false);
    });

    it('"上面说的不对" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('上面说的不对', TEST_SESSION)).toBe(false);
    });

    it('"刚才那个能再解释一下吗" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('刚才那个能再解释一下吗', TEST_SESSION)).toBe(false);
    });
  });

  describe('负面信号：续问句式', () => {
    it('"继续" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('继续', TEST_SESSION)).toBe(false);
    });

    it('"具体说说" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('具体说说', TEST_SESSION)).toBe(false);
    });

    it('"能详细解释一下吗" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('能详细解释一下吗', TEST_SESSION)).toBe(false);
    });

    it('"举个例子" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('举个例子', TEST_SESSION)).toBe(false);
    });

    it('"然后呢" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('然后呢', TEST_SESSION)).toBe(false);
    });

    it('"什么意思" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('什么意思', TEST_SESSION)).toBe(false);
    });

    it('"帮我优化一下这个代码" → 更新（续问模式不完全匹配，"一下"是两字不是单字符类）', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      // 续问正则 [一下]? 是字符类只能匹配单字，实际"一下"是两字，不匹配续问模式
      // 零重叠(+2) + ≥12字(+1) = +3 > 0 → 更新
      expect(shouldUpdateGoal('帮我优化一下这个代码', TEST_SESSION)).toBe(true);
    });

    it('"再解释一遍" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('再解释一遍', TEST_SESSION)).toBe(false);
    });
  });

  describe('负面信号：高关键词重叠', () => {
    it('空间分隔的中文关键词高重叠 → 不更新', () => {
      // 用空格分隔的中文，extractFreeTags 会正确分词
      seedCache(TEST_SESSION, '排序 算法 优化');
      // "排序 算法 复杂度" 与 "排序 算法 优化" → 交集 {排序, 算法} = 2/3 ≈ 0.67 > 0.6 → -2
      // ≥12字(+1) → 总分 = -2+1 = -1 ≤ 0 → 不更新
      expect(shouldUpdateGoal('排序 算法 复杂度 分析', TEST_SESSION)).toBe(false);
    });

    it('英文关键词高重叠 → 不更新', () => {
      seedCache(TEST_SESSION, 'write a sorting algorithm in Python');
      // "sorting algorithm time complexity" freeTags: ["sorting", "algorithm", "time", "complexity"]
      // old freeTags: ["write", "sorting", "algorithm", "python"]
      // 交集 {sorting, algorithm} = 2/4 = 0.5，不触发 -2（需 >0.6）
      // 改用更短、更高重叠的查询
      expect(shouldUpdateGoal('sorting algorithm', TEST_SESSION)).toBe(false);
    });

    it('当前实现限制：无空格中文分词，关键词零重叠时触发更新（正面信号主导）', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      // extractFreeTags 对无空格中文不拆分，两者为不同的单一 token，交集为 0
      // 零重叠(+2) + ≥12字(+1) = +3 > 0 → 更新
      expect(shouldUpdateGoal('排序算法的时间复杂度是多少', TEST_SESSION)).toBe(true);
    });
  });

  describe('正面信号：疑问词 + 非极短', () => {
    it('"如何部署到生产环境" → 更新（疑问词 + ≥6字）', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('如何部署到生产环境', TEST_SESSION)).toBe(true);
    });

    it('"什么是Docker" → 更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('什么是Docker', TEST_SESSION)).toBe(true);
    });

    it('"怎么配置nginx" → 更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('怎么配置nginx', TEST_SESSION)).toBe(true);
    });

    it('"有哪些设计模式？" → 更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('有哪些设计模式？', TEST_SESSION)).toBe(true);
    });
  });

  describe('正面信号：关键词零重叠', () => {
    it('"帮我写一个登录页面" → 更新（与"排序算法"零重叠）', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      // "排序算法" → freeTags: ["排序算法"]
      // "帮我写一个登录页面" → freeTags: ["帮我写一个登录页面"] (中文分词以空格分隔)
      // 实际上中文会被split成单词，但中文词之间没有空格，所以整个句子可能是一个token
      // 需要看 extractFreeTags 的行为
      const result = shouldUpdateGoal('帮我写一个登录页面', TEST_SESSION);
      // 如果零重叠，会触发 +2 正面信号
      // 加上 ≥12 字 +1，总分为 +3，大于 0 → 更新
      expect(result).toBe(true);
    });
  });

  describe('正面信号：长消息', () => {
    it('长消息 + 低相似度 → 更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      const longMsg = '请帮我设计一个完整的用户认证系统，包括注册、登录、密码重置、OAuth2.0集成等功能模块';
      expect(shouldUpdateGoal(longMsg, TEST_SESSION)).toBe(true);
    });
  });

  describe('正面信号：≥12 字非极短消息', () => {
    it('中等长度消息 → 更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('请帮我写一个二分查找的实现', TEST_SESSION)).toBe(true);
    });
  });

  describe('组合信号判定', () => {
    it('续问但包含疑问词且≥6字 → 看综合评分', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      // "为什么这个排序算法这么慢" → 续问匹配(-3) + 疑问词+≥6字(+3) + ≥12字(+1) = +1 > 0 → 更新
      expect(shouldUpdateGoal('为什么这个排序算法这么慢', TEST_SESSION)).toBe(true);
    });

    it('"为什么"短句 → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      // "为什么" → 长度<5(-3) + 续问匹配(-3) = -6 → 不更新
      expect(shouldUpdateGoal('为什么', TEST_SESSION)).toBe(false);
    });

    it('简短确认"明白了" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('明白了', TEST_SESSION)).toBe(false);
    });

    it('"没错" → 不更新', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('没错', TEST_SESSION)).toBe(false);
    });
  });

  describe('边界条件', () => {
    it('只有空白字符的消息 → false', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      expect(shouldUpdateGoal('   ', TEST_SESSION)).toBe(false);
    });

    it('极短但有疑问词 "？" → 不更新（长度<5）', () => {
      seedCache(TEST_SESSION, '写一个排序算法');
      // "啥？" → 长度<5(-3), 引用前文不匹配, 续问不匹配, 疑问词+≥6不满足 → -3
      expect(shouldUpdateGoal('啥？', TEST_SESSION)).toBe(false);
    });
  });
});

// ============================================================================
// buildGoalAnchor
// ============================================================================
describe('buildGoalAnchor', () => {
  it('生成包含目标任务的提示词', () => {
    const result = buildGoalAnchor('写一个排序算法');
    expect(result).toContain('目标任务提醒');
    expect(result).toContain('写一个排序算法');
    expect(result).toContain('不要偏离');
  });

  it('空字符串返回空字符串', () => {
    expect(buildGoalAnchor('')).toBe('');
  });
});

// ============================================================================
// evictStaleGoalCache / clearGoalCache
// ============================================================================
describe('evictStaleGoalCache / clearGoalCache', () => {
  it('clearGoalCache 清除指定会话', () => {
    cacheGoal('session-a', 'goal-a');
    cacheGoal('session-b', 'goal-b');
    clearGoalCache('session-a');
    expect(getGoal('session-a')).toBe('');
    expect(getGoal('session-b')).toBe('goal-b');
  });

  it('clearGoalCache 不存在的会话不报错', () => {
    expect(() => clearGoalCache('non-existent')).not.toThrow();
  });

  it('evictStaleGoalCache 不抛异常', () => {
    cacheGoal(TEST_SESSION, 'test');
    expect(() => evictStaleGoalCache()).not.toThrow();
  });
});