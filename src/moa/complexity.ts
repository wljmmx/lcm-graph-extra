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
  // 1. 压力层级控制：high 压力时跳过 MoA（资源保护）
  // =========================================================================
  if (tier === 'high') {
    return { score: 0, reasons: ['高压模式跳过 MoA'] };
  }

  // =========================================================================
  // 2. 查询长度分析
  // =========================================================================
  const queryLen = (query || '').length;
  if (queryLen > 500) {
    score += 0.2;
    reasons.push('长查询(>500字符)');
  } else if (queryLen > 200) {
    score += 0.1;
    reasons.push('中长查询(200-500字符)');
  }

  // =========================================================================
  // 3. 多步骤指令检测
  // =========================================================================
  for (const pattern of MULTI_STEP_KEYWORDS) {
    if (pattern.test(query)) {
      score += 0.2;
      reasons.push('多步骤指令');
      break;
    }
  }

  // =========================================================================
  // 4. 代码生成动词检测
  // =========================================================================
  for (const pattern of CODE_GEN_VERBS) {
    if (pattern.test(query)) {
      score += 0.15;
      reasons.push('代码生成任务');
      break;
    }
  }

  // =========================================================================
  // 5. 架构设计关键词
  // =========================================================================
  for (const pattern of ARCHITECTURE_KEYWORDS) {
    if (pattern.test(query)) {
      score += 0.2;
      reasons.push('架构设计/技术选型');
      break;
    }
  }

  // =========================================================================
  // 6. 跨模块/多文件操作
  // =========================================================================
  for (const pattern of CROSS_MODULE_KEYWORDS) {
    if (pattern.test(query)) {
      score += 0.15;
      reasons.push('跨模块/多文件操作');
      break;
    }
  }

  // =========================================================================
  // 7. 场景标签加权
  // =========================================================================
  if (scenario && COMPLEX_SCENARIOS.has(scenario)) {
    score += 0.2;
    reasons.push('复杂场景: ' + scenario);
  }

  // =========================================================================
  // 8. 多轮对话深度
  // =========================================================================
  const msgCount = Array.isArray(messages) ? messages.length : 0;
  if (msgCount > 20) {
    score += 0.15;
    reasons.push('深度多轮对话(>20条)');
  } else if (msgCount > 10) {
    score += 0.1;
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

// ============================================================================
// MoA 触发决策 —— 收益基准 + 主模型能力感知
// ============================================================================
//
// 目标：只有当 MoA 相较"直接用主模型单次回答"能带来真实、可衡量的质量增益时
// 才触发，避免 MoA 的模型消耗与时间开销反而超过非 MoA 场景。
//
// 三个关键洞察：
//   1. 主模型能力越强，MoA「多视角聚合」的边际提升越小（强模型自己就能答好）。
//   2. 复杂度越高，多视角分工的价值越大（不同角色的参考模型能补足盲区）。
//   3. 参考模型数量越多，token 与时间成本越高，净收益会被稀释。
//
// 决策公式：
//   weakness           = 1 - mainModelStrength        // 主模型越弱，MoA 提升空间越大
//   rawUplift          = score * (0.35 + 0.65 * weakness)   // 期望质量提升（0-1）
//   costPenalty        = 1 / (1 + 0.3 * (refCount - 1))     // 模型越多成本越高
//   netValue           = rawUplift * costPenalty            // 成本摊薄后的净收益
//   effectiveThreshold = clamp(threshold + (strength - 0.55) * 0.4, 0.2, 0.9)
//   trigger            = score >= effectiveThreshold && netValue >= benefitThreshold
// ============================================================================

/** 默认最低净收益门槛：期望提升不足 15% 不触发 MoA */
export const DEFAULT_BENEFIT_THRESHOLD = 0.15;

/** MoA 触发决策结果 */
export interface MoaDecision {
  /** 是否触发 MoA */
  trigger: boolean;
  /** 原始复杂度分数（0-1） */
  complexity: number;
  /** 主模型能力评估（0-1，越大越强） */
  mainModelStrength: number;
  /** 经主模型能力调整后的有效触发阈值 */
  effectiveThreshold: number;
  /** 期望质量提升（0-1） */
  expectedUplift: number;
  /** 聚合后能力评估（0-1） */
  aggregateStrength: number;
  /** 聚合后能力 − 主模型能力（0-1，越大代表 MoA 提升空间越大） */
  capabilityGap: number;
  /** 成本摊薄系数（0-1，参考模型越多越小） */
  costPenalty: number;
  /** 成本摊薄后的净收益（0-1） */
  netValue: number;
  /** 决策原因 */
  reasons: string[];
}

/**
 * 估算主模型能力强度（0=极弱，1=极强）。
 *
 * 基于模型名与本地/远程做启发式分档：
 * - 远程旗舰（gpt-4o/claude-sonnet/gemini-pro/deepseek-r1 等）→ 0.85
 * - 远程中端（*-mini/*-haiku/*-flash/deepseek-v3 等）→ 0.7
 * - 本地大参数（72b/32b/27b/14b 等）→ 0.5
 * - 本地小参数（8b/7b/4b 等）→ 0.35
 * - 无法判断 → 0.5（中性）
 */
export function estimateMainModelStrength(model: string, baseURL?: string): number {
  const m = (model || '').toLowerCase();
  const isLocal = baseURL && /localhost|127\.0\.0\.1|:11434|:8080|:8000|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\./i.test(baseURL);
  // 远程中端模型 —— 必须在旗舰前判断（避免 gpt-4o-mini 前缀命中 gpt-4o）
  if (!isLocal && /(gpt-4o-mini|gpt-4\.1-mini|claude-3-5-haiku|claude-haiku|gemini-1\.5-flash|gemini-2\.0-flash|deepseek-v3|deepseek-chat|qwen-coder|doubao-lite)/.test(m)) {
    return 0.7;
  }
  // 本地/开源大参数模型
  if (/(72b|70b|67b|55b|32b|27b|30b|14b|13b|20b|21b)/.test(m)) {
    return 0.5;
  }
  // 本地/开源小参数模型
  if (/(8b|7b|6b|4b|3b|1\.5b|0\.5b|1b)/.test(m)) {
    return 0.35;
  }
  // 远程旗舰模型 —— 强主模型，MoA 边际提升小
  if (/(^|[/:._-])(gpt-4o|gpt-4\.1|gpt-5|claude-3-5-sonnet|claude-3-7|claude-4|claude-sonnet|claude-opus|gemini-2|gemini-1\.5-pro|o1|o3|deepseek-r1|deepseek-reasoner|kimi-k2|qwen3-max|glm-4\.5|doubao-seed)/.test(m)) {
    return 0.85;
  }
  // 兜底：无法判断（中性，不偏袒触发或不触发）
  return 0.5;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 参与 MoA 的模型能力描述（用于评估聚合后能力） */
export interface MoaModelProfile {
  /** 模型标识 */
  model: string;
  /** baseURL（可选，用于本地/远程判断） */
  baseURL?: string;
}

export interface DecideMoaParams {
  /** 复杂度评估结果 */
  complexity: ComplexityScore;
  /** 主模型标识（如 'gpt-4o'、'qwen3.6:27b'） */
  mainModel: string;
  /** 主模型 baseURL（可选） */
  mainModelBaseURL?: string;
  /** 参考模型列表（用于评估聚合后能力，可选） */
  referenceModels?: MoaModelProfile[];
  /** 聚合模型（用于评估聚合后能力，可选） */
  aggregatorModel?: MoaModelProfile | null;
  /** 配置的复杂度阈值（moa.complexityThreshold，默认 0.6） */
  configThreshold: number;
  /** 参考模型数量（≥2 才可能触发；缺省时取 referenceModels 长度） */
  referenceModelCount?: number;
  /** 最低净收益门槛（默认 0.15，即期望提升 ≥15%） */
  benefitThreshold?: number;
}

/**
 * 估算 MoA 聚合后的整体能力强度（0-1）。
 *
 * 思路：MoA 通过多个模型的视角分工 + 聚合模型收敛裁决，能逼近"最强参与模型"，
 * 但受限于参与模型的天花板。聚合后能力取：
 *    主模型能力 × 0.4 + max(参考模型均值, 聚合模型能力) × 0.6
 * 即：参与模型越强，聚合后越好；主模型再强，也受参考层上限影响。
 */
export function estimateAggregateStrength(
  mainStrength: number,
  refModels: MoaModelProfile[],
  aggregatorModel?: MoaModelProfile | null,
): number {
  // 参考模型平均能力（缺省时按中性 0.5 计）
  const refs = Array.isArray(refModels) && refModels.length > 0 ? refModels : [];
  const refStrength = refs.length > 0
    ? refs.reduce((sum, r) => sum + estimateMainModelStrength(r.model, r.baseURL), 0) / refs.length
    : 0.5;

  // 聚合模型能力（缺省时退化为参考均值）
  const aggStrength = aggregatorModel?.model
    ? estimateMainModelStrength(aggregatorModel.model, aggregatorModel.baseURL)
    : refStrength;

  // 聚合后能力 = 主模型(0.4) + 参考/聚合上限(0.6)
  const upper = Math.max(refStrength, aggStrength);
  return clamp(mainStrength * 0.4 + upper * 0.6, 0, 1);
}

/**
 * 收益基准 + 主模型/聚合后能力感知的 MoA 触发决策。
 *
 * 相比旧的"复杂度 ≥ 固定阈值"逻辑，本函数额外考虑：
 * - 主模型能力：强主模型提高有效阈值并压低期望提升，避免为可轻易解决的任务浪费多模型成本；
 * - 聚合后能力：MoA 的收益本质 = 聚合后能力 − 主模型能力。若参与模型都不强，聚合提升有限，
 *   即使复杂度高也不值得触发；
 * - 成本摊薄：参考模型越多，token/时间成本越高，净收益越低，避免"多模型消耗反而比不上非 MoA"。
 *
 * @returns 触发决策（含可解释的指标与原因）
 */
export function decideMoa(params: DecideMoaParams): MoaDecision {
  const {
    complexity,
    mainModel,
    mainModelBaseURL,
    referenceModels,
    aggregatorModel,
    configThreshold,
    referenceModelCount,
    benefitThreshold = DEFAULT_BENEFIT_THRESHOLD,
  } = params;

  const reasons = [...(complexity.reasons ?? [])];
  const score = complexity.score;
  const strength = estimateMainModelStrength(mainModel, mainModelBaseURL);

  // 参考模型数量（缺省取列表长度）
  const refCount = Math.max(2, referenceModelCount ?? referenceModels?.length ?? 2);

  // 聚合后能力评估：收益 = 聚合后能力 − 主模型能力
  const aggStrength = estimateAggregateStrength(strength, referenceModels ?? [], aggregatorModel);
  const capabilityGap = clamp(aggStrength - strength, -0.05, 0.5);

  // 基准门槛：复杂度过低时，任何配置下 MoA 都不值得
  const COMPLEXITY_FLOOR = 0.3;
  if (score < COMPLEXITY_FLOOR) {
    reasons.push(`基准门槛: 复杂度 ${score.toFixed(2)} < ${COMPLEXITY_FLOOR}，MoA 收益无法覆盖成本`);
    return {
      trigger: false,
      complexity: score,
      mainModelStrength: strength,
      aggregateStrength: aggStrength,
      capabilityGap: capabilityGap,
      effectiveThreshold: configThreshold,
      expectedUplift: 0,
      costPenalty: 1,
      netValue: 0,
      reasons,
    };
  }

  // 期望提升 = 复杂度驱动（多视角分工对复杂任务的价值）× 能力差距驱动（聚合赶上主模型盲区）
  // 能力差距越大 → MoA 提升越明显；主模型已很强且参与模型不强时，capabilityGap≈0，收益仅剩复杂度成分
  const complexityUplift = score * 0.4;
  const rawUplift = clamp(complexityUplift + capabilityGap, 0, 1);

  // 成本摊薄：参考模型越多，token/时间成本越高
  const costPenalty = 1 / (1 + 0.3 * (refCount - 1));

  const netValue = rawUplift * costPenalty;

  // 强主模型 → 提高有效阈值（更保守）；弱主模型 → 降低有效阈值（更积极）
  const effectiveThreshold = clamp(configThreshold + (strength - 0.55) * 0.4, 0.2, 0.9);

  const complexityOk = score >= effectiveThreshold;
  const benefitOk = netValue >= benefitThreshold;

  if (complexityOk) {
    reasons.push(`复杂度达标: ${score.toFixed(2)} >= 有效阈值 ${effectiveThreshold.toFixed(2)}`);
  } else {
    reasons.push(`复杂度不足: ${score.toFixed(2)} < 有效阈值 ${effectiveThreshold.toFixed(2)}（主模型能力 ${strength.toFixed(2)} 已调整阈值）`);
  }
  if (strength >= 0.7) {
    reasons.push(`主模型较强(${strength.toFixed(2)})，MoA 边际提升有限`);
  } else if (strength <= 0.4) {
    reasons.push(`主模型较弱(${strength.toFixed(2)})，MoA 多视角协作价值较高`);
  }
  reasons.push(`聚合后能力 ${aggStrength.toFixed(2)}，能力差距 ${capabilityGap >= 0 ? '+' : ''}${capabilityGap.toFixed(2)}`);

  if (benefitOk) {
    reasons.push(`净收益达标: ${netValue.toFixed(3)} >= ${benefitThreshold}（期望提升 ${(rawUplift * 100).toFixed(1)}% × 成本系数 ${costPenalty.toFixed(2)}）`);
  } else {
    reasons.push(`净收益不足: ${netValue.toFixed(3)} < ${benefitThreshold}，MoA 成本无法换取 ≥${(benefitThreshold * 100).toFixed(0)}% 质量提升`);
  }

  return {
    trigger: complexityOk && benefitOk,
    complexity: score,
    mainModelStrength: strength,
    aggregateStrength: aggStrength,
    capabilityGap,
    effectiveThreshold,
    expectedUplift: rawUplift,
    costPenalty,
    netValue,
    reasons,
  };
}