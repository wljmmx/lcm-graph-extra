/**
 * MoA 任务复杂度评估模块
 *
 * 基于 context-inference.ts 的场景推断基础设施，
 * 综合多维度判断当前任务是否需要启用 MoA。
 *
 * 简单任务（如单行命令、简单问答）无需 MoA，节省成本；
 * 复杂任务（多步骤、代码生成、架构设计）触发 MoA 以提升质量。
 */

import type { ComplexityScore } from './types.js';

/** 复杂场景标签集合 */
const COMPLEX_SCENARIOS = new Set([
  'bug-fix',
  'refactor',
  'feature-dev',
  'security-audit',
  'performance-opt',
  'architecture',
  'deployment',
]);

/** 简单场景标签集合（必定不触发 MoA） */
const SIMPLE_SCENARIOS = new Set([
  'simple-query',
  'greeting',
  'translation',
]);

/** 多步骤指令关键词 */
const MULTI_STEP_KEYWORDS = [
  /首先.*然后|首先.*接着|首先.*最后/,
  /第一步.*第二步|step\s*1.*step\s*2/i,
  /first.*then.*finally|first.*next.*last/i,
  /先.*再.*最后|先.*然后.*接着/,
];

/** 代码生成动词 */
const CODE_GEN_VERBS = [
  /写|创建|实现|重构|构建|生成|开发|编写|添加|新增|补充/,
  /build|create|implement|refactor|generate|develop|write|add|construct/i,
];

/** 架构设计关键词 */
const ARCHITECTURE_KEYWORDS = [
  /架构|设计模式|系统设计|方案设计|技术选型|重构方案/,
  /architecture|design pattern|system design|tech stack|refactor plan/i,
];

/** 多文件/跨模块关键词 */
const CROSS_MODULE_KEYWORDS = [
  /跨模块|多文件|多个文件|整个项目|全局|全项目/,
  /cross.module|multi.file|across|project.wide|global/i,
];

/**
 * 计算任务复杂度分数。
 *
 * 综合以下维度：
 * - 查询长度（长查询通常更复杂）
 * - 多步骤指令检测
 * - 代码生成动词
 * - 架构设计关键词
 * - 跨模块操作
 * - 场景标签加权
 * - 多轮对话深度
 * - 压力层级（high 压力时跳过）
 *
 * @param query 用户查询文本
 * @param messages 当前消息列表
 * @param scenario 场景标签（来自 context-inference）
 * @param tier 当前压力层级
 * @returns 复杂度评估结果
 */
export function computeTaskComplexity(
  query: string,
  messages: any[],
  scenario: string | null,
  tier: string,
): ComplexityScore {
  const reasons: string[] = [];
  let score = 0;

  // =========================================================================
  // 0. 快速排除：简单场景直接返回
  // =========================================================================
  if (scenario && SIMPLE_SCENARIOS.has(scenario)) {
    return { score: 0, reasons: ['简单场景: ' + scenario] };
  }

  // =========================================================================
  // 1. 压力层级控制：high 压力时跳过 MoA
  // =========================================================================
  if (tier === 'high') {
    return { score: 0, reasons: ['高压模式跳过 MoA'] };
  }
  // medium 压力时降低阈值（提高触发门槛）
  const tierMultiplier = tier === 'medium' ? 0.5 : 1.0;

  // =========================================================================
  // 2. 查询长度分析
  // =========================================================================
  const queryLen = (query || '').length;
  if (queryLen > 500) {
    score += 0.2 * tierMultiplier;
    reasons.push('长查询(>500字符)');
  } else if (queryLen > 200) {
    score += 0.1 * tierMultiplier;
    reasons.push('中长查询(200-500字符)');
  }

  // =========================================================================
  // 3. 多步骤指令检测
  // =========================================================================
  for (const pattern of MULTI_STEP_KEYWORDS) {
    if (pattern.test(query)) {
      score += 0.2 * tierMultiplier;
      reasons.push('多步骤指令');
      break;
    }
  }

  // =========================================================================
  // 4. 代码生成动词检测
  // =========================================================================
  for (const pattern of CODE_GEN_VERBS) {
    if (pattern.test(query)) {
      score += 0.15 * tierMultiplier;
      reasons.push('代码生成任务');
      break;
    }
  }

  // =========================================================================
  // 5. 架构设计关键词
  // =========================================================================
  for (const pattern of ARCHITECTURE_KEYWORDS) {
    if (pattern.test(query)) {
      score += 0.2 * tierMultiplier;
      reasons.push('架构设计/技术选型');
      break;
    }
  }

  // =========================================================================
  // 6. 跨模块/多文件操作
  // =========================================================================
  for (const pattern of CROSS_MODULE_KEYWORDS) {
    if (pattern.test(query)) {
      score += 0.15 * tierMultiplier;
      reasons.push('跨模块/多文件操作');
      break;
    }
  }

  // =========================================================================
  // 7. 场景标签加权
  // =========================================================================
  if (scenario && COMPLEX_SCENARIOS.has(scenario)) {
    score += 0.2 * tierMultiplier;
    reasons.push('复杂场景: ' + scenario);
  }

  // =========================================================================
  // 8. 多轮对话深度
  // =========================================================================
  const msgCount = Array.isArray(messages) ? messages.length : 0;
  if (msgCount > 20) {
    score += 0.15 * tierMultiplier;
    reasons.push('深度多轮对话(>20条)');
  } else if (msgCount > 10) {
    score += 0.1 * tierMultiplier;
    reasons.push('多轮对话(10-20条)');
  }

  // =========================================================================
  // 9. 上限约束
  // =========================================================================
  return {
    score: Math.min(score, 1.0),
    reasons,
  };
}