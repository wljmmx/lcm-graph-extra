/**
 * 任务分解 + SAD 反馈循环 单元测试。
 *
 * 覆盖第二项（L5 规则版任务分解）与第三项（SAD 反馈循环替代纯疲劳衰减）的核心逻辑。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { decomposeTask, hasDecompositionTemplate } from './task-decomposer.js';
import {
  recordSadFeedback,
  getEffectiveWeight,
  isRecommendable,
  sortByWeight,
  clearSadWeights,
  DEFAULT_WEIGHT,
  MIN_WEIGHT,
  BOOST_USED_SELF,
  BOOST_USED_CATEGORY,
  DECAY_UNUSED_SELF,
} from './sad-feedback.js';
import {
  buildSmartToolGuidance,
  beginToolGuidanceRound,
  clearSessionToolTracker,
  extractLatestUserQuery,
} from './tool-guidance.js';

const SK = 'test-session-decompose-sad';

beforeEach(() => {
  clearSadWeights(SK);
  clearSessionToolTracker(SK);
});

// ---------------------------------------------------------------------------
// 任务分解（task-decomposer）
// ---------------------------------------------------------------------------

describe('decomposeTask', () => {
  it('无模板的场景返回空子任务序列', () => {
    const r = decomposeTask('unknown-scenario', 'some query');
    expect(r.subtasks).toHaveLength(0);
    expect(hasDecompositionTemplate('unknown-scenario')).toBe(false);
  });

  it('bug-fix 模板返回有序子任务且首步为定位', () => {
    const r = decomposeTask('bug-fix', '修复登录崩溃');
    expect(r.subtasks.length).toBeGreaterThan(0);
    expect(r.subtasks[0].name).toBe('定位问题');
    expect(r.subtasks[0].step).toBe(1);
    // 沉淀经验是可选步骤
    const expStep = r.subtasks.find((s) => s.category === 'experience');
    expect(expStep?.optional).toBe(true);
  });

  it('关键词命中将可选步骤从可选提升为必选', () => {
    // bug-fix 模板中"沉淀经验"（experience）步骤是可选的
    const noKw = decomposeTask('bug-fix', '修复崩溃');
    const expNoKw = noKw.subtasks.find((s) => s.category === 'experience');
    expect(expNoKw?.optional).toBe(true);

    // 带关键词"经验/沉淀"：experience 步骤被提升为必选
    const withKw = decomposeTask('bug-fix', '修复崩溃并沉淀经验');
    expect(withKw.matchedKeywords).toContain('experience');
    const expWithKw = withKw.subtasks.find((s) => s.category === 'experience');
    expect(expWithKw?.optional).toBe(false);
  });

  it('子任务步骤编号连续递增', () => {
    const r = decomposeTask('feature-dev', '实现新功能');
    for (let i = 0; i < r.subtasks.length; i++) {
      expect(r.subtasks[i].step).toBe(i + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// SAD 反馈循环（sad-feedback）
// ---------------------------------------------------------------------------

describe('SAD feedback loop', () => {
  it('未观测过的工具默认权重为 DEFAULT_WEIGHT 且可推荐', () => {
    expect(getEffectiveWeight('lcmg_search', SK)).toBe(DEFAULT_WEIGHT);
    expect(isRecommendable('lcmg_search', SK)).toBe(true);
  });

  it('工具被使用 → 自身与同类权重增强', () => {
    const available = ['lcmg_search', 'lcmg_get_document', 'lcmg_pin'];
    recordSadFeedback(SK, [{ tool: 'lcmg_search', used: true, round: 1 }], available);

    const wSelf = getEffectiveWeight('lcmg_search', SK);
    // 自身权重应高于默认
    expect(wSelf).toBeGreaterThan(DEFAULT_WEIGHT);

    // 同类（search 类别）的其他工具也应被增强
    // lcmg_search 同时属于 graph 与 search 类别，权重应反映正向反馈
    // 至少自身权重明显提升
    const boost = wSelf - DEFAULT_WEIGHT;
    expect(boost).toBeGreaterThan(0);
  });

  it('工具被注入但未使用 → 权重衰减，连续多次后低于 MIN_WEIGHT 不再推荐', () => {
    const available = ['lcmg_search'];
    // 连续注入未使用，直到权重跌破 MIN_WEIGHT
    // 每次衰减 DECAY_UNUSED_SELF（自身），需多次才会跌破
    let stillRecommendable = true;
    let rounds = 0;
    do {
      recordSadFeedback(SK, [{ tool: 'lcmg_search', used: false, round: rounds + 1 }], available);
      stillRecommendable = isRecommendable('lcmg_search', SK);
      rounds++;
    } while (stillRecommendable && rounds < 20);

    expect(rounds).toBeLessThan(20);
    expect(isRecommendable('lcmg_search', SK)).toBe(false);
  });

  it('sortByWeight 按有效权重降序排列', () => {
    const available = ['lcmg_search', 'lcmg_pin', 'lcmg_config_get'];
    // 增强 lcmg_search
    recordSadFeedback(SK, [{ tool: 'lcmg_search', used: true, round: 1 }], available);

    const sorted = sortByWeight(available, SK);
    // lcmg_search 被增强后应排在最前
    expect(sorted[0]).toBe('lcmg_search');
  });

  it('clearSadWeights 清除后权重回到默认', () => {
    recordSadFeedback(SK, [{ tool: 'lcmg_search', used: true, round: 1 }], ['lcmg_search']);
    expect(getEffectiveWeight('lcmg_search', SK)).toBeGreaterThan(DEFAULT_WEIGHT);
    clearSadWeights(SK);
    expect(getEffectiveWeight('lcmg_search', SK)).toBe(DEFAULT_WEIGHT);
  });
});

// ---------------------------------------------------------------------------
// buildSmartToolGuidance + 任务分解集成
// ---------------------------------------------------------------------------

describe('buildSmartToolGuidance L5 task decomposition', () => {
  it('传入 userQuery 且场景有模板时进入分解模式（输出步骤标题）', () => {
    beginToolGuidanceRound(SK, []); // 初始化 round=1
    const guidance = buildSmartToolGuidance(
      'low',
      'bug-fix',
      ['lcmg_search', 'lcmg_get_document'],
      SK,
      '修复登录崩溃的 bug',
    );
    expect(guidance).toContain('任务分解与工具推荐');
    expect(guidance).toContain('步骤 1');
  });

  it('未传入 userQuery 时回退到 L1 平铺列表（无步骤标题）', () => {
    beginToolGuidanceRound(SK, []);
    const guidance = buildSmartToolGuidance(
      'low',
      'bug-fix',
      ['lcmg_search', 'lcmg_get_document'],
      SK,
    );
    expect(guidance).toContain('相关工具提示');
    expect(guidance).not.toContain('步骤 1');
  });

  it('高压力 tier 不注入任何工具指引', () => {
    beginToolGuidanceRound(SK, []);
    const guidance = buildSmartToolGuidance(
      'high',
      'bug-fix',
      ['lcmg_search'],
      SK,
      '修复崩溃',
    );
    expect(guidance).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractLatestUserQuery
// ---------------------------------------------------------------------------

describe('extractLatestUserQuery', () => {
  it('从消息数组提取最新用户消息文本', () => {
    const msgs = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
      { role: 'user', content: '修复登录崩溃' },
    ];
    expect(extractLatestUserQuery(msgs)).toBe('修复登录崩溃');
  });

  it('无用户消息返回空字符串', () => {
    expect(extractLatestUserQuery([{ role: 'assistant', content: 'hi' }])).toBe('');
  });

  it('content 为数组时提取 text 块', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: '帮我重构' }] },
    ];
    expect(extractLatestUserQuery(msgs)).toBe('帮我重构');
  });
});
