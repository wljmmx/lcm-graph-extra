/**
 * R-2: 成本感知级联 —— 三层级联判断 + Thompson 采样。
 *
 * Tier 1: 启发式规则（零成本）—— 已有 withCircuitBreaker + BM25/pagerank 评分
 * Tier 2: 教师模型 LLM 判断（中等成本）—— Tier 1 置信度 < 阈值时触发
 * Tier 3: 工具验证（高成本）—— 事实性声明用搜索验证
 *
 * 设计原则：
 * - 不阻塞主路径（assemble），Tier 2/3 异步执行
 * - Thompson 采样平衡利用（召回熟悉节点）vs 探索（发现新节点）
 * - 与现有 withCircuitBreaker 解耦，不重复造熔断
 */

/** 检索结果的置信度评估 */
export interface RecallConfidence {
  tier1Score: number;        // [0, 1] 启发式置信度
  needsTier2: boolean;       // 是否需要 Tier 2 LLM 判断
  needsTier3: boolean;       // 是否需要 Tier 3 工具验证
  hasFactualClaim: boolean;  // 是否包含事实性声明
}

/** Thompson 采样的 Beta 分布臂 */
interface BetaArm {
  alpha: number;  // 成功次数
  beta: number;   // 失败次数
}

/**
 * R-2: 成本感知级联管理器。
 *
 * 在 assemble 检索完成后评估结果置信度，低置信度时异步触发 Tier 2/3。
 * Thompson 采样用于在结果排序中引入探索性，避免过度依赖历史热门节点。
 */
export class CascadeManager {
  private confidenceThreshold: number;
  private arms: Map<string, BetaArm> = new Map(); // 按 scenario 维度维护臂

  constructor(confidenceThreshold: number = 0.7) {
    this.confidenceThreshold = confidenceThreshold;
  }

  /**
   * Tier 1: 启发式置信度评估。
   *
   * 综合考虑：
   * - BM25/向量分数（如果可用）
   * - pagerank（图谱节点重要性）
   * - matchCount（历史命中次数）
   * - 结果数量（太少=低置信）
   *
   * 返回 [0, 1] 置信度分数。
   */
  evaluateTier1(results: Array<{
    score?: number;
    pagerank?: number;
    matchCount?: number;
    type?: string;
    content?: string;
  }>): RecallConfidence {
    if (!results || results.length === 0) {
      return { tier1Score: 0, needsTier2: false, needsTier3: false, hasFactualClaim: false };
    }

    // 综合分数 = 平均 score 加权 + 结果数量奖励
    const avgScore = results.reduce((sum, r) => sum + (r.score ?? r.pagerank ?? 0.5), 0) / results.length;
    const countBonus = Math.min(results.length / 10, 0.2); // 10 条结果 = +0.2
    const matchBonus = Math.min(
      results.reduce((sum, r) => sum + (r.matchCount ?? 0), 0) / 50,
      0.15,
    ); // 50 次命中 = +0.15

    let tier1Score = Math.min(avgScore * 0.7 + countBonus + matchBonus, 1.0);

    // 检测事实性声明（API 名称、版本号、配置项等）
    const allContent = results.map((r) => r.content ?? '').join(' ');
    const hasFactualClaim = /\b(API|version|config|setting|parameter|endpoint|function|class|method)\b/i.test(allContent)
      || /版本|配置|参数|接口|函数|方法|端点/.test(allContent);

    const needsTier2 = tier1Score < this.confidenceThreshold;
    const needsTier3 = needsTier2 && hasFactualClaim;

    return { tier1Score, needsTier2, needsTier3, hasFactualClaim };
  }

  /**
   * Thompson 采样：对检索结果重排序，平衡利用 vs 探索。
   *
   * - 高置信度（tier1Score ≥ 阈值）：保持原排序（利用）
   * - 低置信度：用 Thompson 采样引入随机性（探索）
   *
   * 每个"臂"（arm）代表一个结果项，Beta(alpha, beta) 采样决定排序。
   * 历史命中多的节点 alpha 高（更可能被选中），但新节点有先验 beta=1（有机会被探索）。
   */
  thompsonRerank<T extends { id?: string; matchCount?: number; score?: number }>(
    results: T[],
    scenario: string = 'default',
  ): T[] {
    if (results.length <= 1) return results;

    // 只在结果数 > 3 时才应用 Thompson 采样
    if (results.length <= 3) return results;

    // 为每个结果采样
    const sampled = results.map((r) => {
      const armKey = `${scenario}:${r.id ?? 'unknown'}`;
      let arm = this.arms.get(armKey);
      if (!arm) {
        // 先验：alpha=1+matchCount, beta=1（新节点有机会被探索）
        arm = { alpha: 1 + (r.matchCount ?? 0) * 0.1, beta: 1 };
        this.arms.set(armKey, arm);
      }
      // Beta 分布采样（使用近似：Gamma 采样）
      const sample = this.betaSample(arm.alpha, arm.beta);
      // 混合：70% 原始分数 + 30% Thompson 采样
      const mixedScore = (r.score ?? 0.5) * 0.7 + sample * 0.3;
      return { result: r, mixedScore, armKey };
    });

    sampled.sort((a, b) => b.mixedScore - a.mixedScore);
    return sampled.map((s) => s.result);
  }

  /**
   * 记录反馈：某结果项在后续使用中被验证为有效（成功）或无效（失败）。
   * 更新 Beta 分布的 alpha/beta，影响未来的 Thompson 采样。
   */
  recordFeedback(armKey: string, success: boolean): void {
    let arm = this.arms.get(armKey);
    if (!arm) {
      arm = { alpha: 1, beta: 1 };
      this.arms.set(armKey, arm);
    }
    if (success) {
      arm.alpha += 1;
    } else {
      arm.beta += 1;
    }
    // 限制 arm 大小，避免极端值
    if (arm.alpha > 100) arm.alpha = 100;
    if (arm.beta > 100) arm.beta = 100;
  }

  /**
   * Tier 2: 异步 LLM 判断 —— 评估检索结果是否真正回答了用户查询。
   * 不阻塞主路径，结果用于反馈（recordFeedback）。
   */
  async evaluateTier2(
    query: string,
    results: Array<{ content?: string; id?: string }>,
    llmFn: (prompt: string) => Promise<string>,
  ): Promise<Array<{ id: string; relevant: boolean }>> {
    if (!query || results.length === 0) return [];

    const topResults = results.slice(0, 5);
    const resultList = topResults.map((r, i) => `[${i}] ${r.id ?? 'unknown'}: ${(r.content ?? '').slice(0, 200)}`).join('\n');

    const prompt = `Given the user query and the following search results, determine which results are truly relevant to answering the query.\nQuery: "${query.slice(0, 500)}"\nResults:\n${resultList}\n\nReturn a JSON array of objects with "id" and "relevant" (true/false) for each result. Example: [{"id":"result_id","relevant":true}]. Return ONLY JSON.`;

    try {
      const response = await llmFn(prompt);
      const parsed = JSON.parse(response);
      if (Array.isArray(parsed)) {
        return parsed.map((r: any) => ({
          id: String(r.id ?? ''),
          relevant: Boolean(r.relevant),
        }));
      }
    } catch { /* LLM judgment failed, return empty */ }

    return [];
  }

  /**
   * Beta 分布采样（使用 Gamma 分布近似）。
   * Beta(α, β) = Gamma(α) / (Gamma(α) + Gamma(β))
   */
  private betaSample(alpha: number, beta: number): number {
    const x = this.gammaSample(alpha);
    const y = this.gammaSample(beta);
    return x / (x + y);
  }

  /**
   * Gamma 分布采样（Marsaglia-Tsang 方法）。
   */
  private gammaSample(shape: number): number {
    if (shape < 1) {
      // 使用 Boosting 技巧
      const u = Math.random();
      return this.gammaSample(shape + 1) * Math.pow(u, 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    let x: number, v: number;
    for (let i = 0; i < 100; i++) {
      do {
        x = this.normalSample();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return d; // fallback
  }

  /** 标准正态分布采样（Box-Muller） */
  private normalSample(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** 重置（测试用） */
  reset(): void {
    this.arms.clear();
  }
}

// 全局单例
export const cascadeManager = new CascadeManager();
