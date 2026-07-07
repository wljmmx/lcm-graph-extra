/**
 * graph-memory-pro 能力档次配置系统。
 *
 * 提供 4 个预设档次，平衡功能需求与系统性能：
 * - minimal: 基础模式，仅本地检索，关闭所有 gm-pro 扩展能力
 * - balanced: 均衡模式，启用低开销 gm-pro 能力（judgeRecall/getGraphHealth）
 * - performance: 性能优先，启用增量维护 + 级联评估，关闭高延迟操作
 * - full: 完整模式，所有 gm-pro 能力全开
 *
 * 档次切换通过 Dashboard /api/capability-profile 端点实现热更新。
 */

/** gm-pro 扩展 API 名称 */
export type GmProApiName =
  | 'judgeRecall'
  | 'upsertFeedback'
  | 'getNodesByTimeRange'
  | 'evolveNode'
  | 'getGraphHealth'
  | 'consolidateBuffer'
  | 'linkNodes'
  | 'markDirty'
  | 'incrementalMaintain';

/** 能力档次 ID */
export type CapabilityProfileId = 'minimal' | 'balanced' | 'performance' | 'full';

/** 能力档次配置 */
export interface CapabilityProfile {
  id: CapabilityProfileId;
  label: string;
  description: string;
  /** 启用的 gm-pro API 列表 */
  enabledApis: GmProApiName[];
  /** 检索限制 */
  retrievalLimits: {
    low: { qmd: number; graph: number; exp: number };
    medium: { qmd: number; graph: number; exp: number };
    high: { qmd: number; graph: number; exp: number };
  };
  /** 功能开关 */
  features: {
    r2CascadeTier2: boolean;      // R-2 Tier 2 LLM 判断
    r2CascadeTier3: boolean;      // R-2 Tier 3 工具验证
    s9TopicShift: boolean;        // S-9' 话题漂移检测
    s11Zettelkasten: boolean;     // S-11' Zettelkasten 关联
    s7UserProfile: boolean;       // S-7' 用户画像
    r5DynamicMix: boolean;        // R-5' 动态混合
    n2LlmRerank: boolean;         // N-2 LLM 重排
    g8Validation: boolean;        // G-8 验证回路
    incrementalMaintain: boolean; // 增量维护
  };
  /** 预估性能开销（相对值，1-10） */
  estimatedOverhead: number;
}

/** 4 个预设档次 */
export const CAPABILITY_PROFILES: Record<CapabilityProfileId, CapabilityProfile> = {
  minimal: {
    id: 'minimal',
    label: '基础模式',
    description: '仅本地检索，关闭所有 gm-pro 扩展能力。适合资源受限或 gm-pro 未安装环境。',
    enabledApis: [],
    retrievalLimits: {
      low: { qmd: 5, graph: 3, exp: 2 },
      medium: { qmd: 3, graph: 2, exp: 1 },
      high: { qmd: 1, graph: 1, exp: 0 },
    },
    features: {
      r2CascadeTier2: false,
      r2CascadeTier3: false,
      s9TopicShift: true,
      s11Zettelkasten: true,
      s7UserProfile: true,
      r5DynamicMix: true,
      n2LlmRerank: false,
      g8Validation: false,
      incrementalMaintain: false,
    },
    estimatedOverhead: 1,
  },

  balanced: {
    id: 'balanced',
    label: '均衡模式',
    description: '启用低开销 gm-pro 能力（judgeRecall/getGraphHealth），平衡功能与性能。推荐默认模式。',
    enabledApis: ['judgeRecall', 'getGraphHealth'],
    retrievalLimits: {
      low: { qmd: 10, graph: 8, exp: 5 },
      medium: { qmd: 6, graph: 4, exp: 3 },
      high: { qmd: 3, graph: 2, exp: 1 },
    },
    features: {
      r2CascadeTier2: true,
      r2CascadeTier3: false,
      s9TopicShift: true,
      s11Zettelkasten: true,
      s7UserProfile: true,
      r5DynamicMix: true,
      n2LlmRerank: false,
      g8Validation: true,
      incrementalMaintain: false,
    },
    estimatedOverhead: 4,
  },

  performance: {
    id: 'performance',
    label: '性能优先',
    description: '启用增量维护 + 级联评估 + LLM 重排，关闭高延迟工具验证。适合高吞吐场景。',
    enabledApis: ['judgeRecall', 'getGraphHealth', 'incrementalMaintain', 'markDirty'],
    retrievalLimits: {
      low: { qmd: 15, graph: 10, exp: 8 },
      medium: { qmd: 8, graph: 6, exp: 4 },
      high: { qmd: 4, graph: 3, exp: 2 },
    },
    features: {
      r2CascadeTier2: true,
      r2CascadeTier3: false,
      s9TopicShift: true,
      s11Zettelkasten: true,
      s7UserProfile: true,
      r5DynamicMix: true,
      n2LlmRerank: true,
      g8Validation: true,
      incrementalMaintain: true,
    },
    estimatedOverhead: 7,
  },

  full: {
    id: 'full',
    label: '完整模式',
    description: '所有 gm-pro 能力全开，包括工具验证和图谱整合。适合开发调试或高性能服务器。',
    enabledApis: [
      'judgeRecall', 'upsertFeedback', 'getNodesByTimeRange',
      'evolveNode', 'getGraphHealth', 'consolidateBuffer',
      'linkNodes', 'markDirty', 'incrementalMaintain',
    ],
    retrievalLimits: {
      low: { qmd: 20, graph: 15, exp: 10 },
      medium: { qmd: 10, graph: 8, exp: 5 },
      high: { qmd: 5, graph: 4, exp: 3 },
    },
    features: {
      r2CascadeTier2: true,
      r2CascadeTier3: true,
      s9TopicShift: true,
      s11Zettelkasten: true,
      s7UserProfile: true,
      r5DynamicMix: true,
      n2LlmRerank: true,
      g8Validation: true,
      incrementalMaintain: true,
    },
    estimatedOverhead: 10,
  },
};

/** 默认档次 */
export const DEFAULT_PROFILE: CapabilityProfileId = 'balanced';

/** 当前生效的档次 ID */
let _currentProfileId: CapabilityProfileId = DEFAULT_PROFILE;

/** 档次变更回调 */
type ProfileChangeCallback = (profile: CapabilityProfile) => void;
const _callbacks: Set<ProfileChangeCallback> = new Set();

/** 获取当前档次 ID */
export function getCurrentProfileId(): CapabilityProfileId {
  return _currentProfileId;
}

/** 获取当前档次配置 */
export function getCurrentProfile(): CapabilityProfile {
  return CAPABILITY_PROFILES[_currentProfileId];
}

/** 设置当前档次（热更新） */
export function setCurrentProfile(id: CapabilityProfileId): CapabilityProfile {
  if (!CAPABILITY_PROFILES[id]) {
    throw new Error(`Unknown capability profile: ${id}`);
  }
  const oldId = _currentProfileId;
  _currentProfileId = id;
  const profile = CAPABILITY_PROFILES[id];
  // 通知所有回调
  for (const cb of _callbacks) {
    try { cb(profile); } catch { /* non-fatal */ }
  }
  return profile;
}

/** 注册档次变更回调 */
export function onProfileChange(cb: ProfileChangeCallback): () => void {
  _callbacks.add(cb);
  return () => _callbacks.delete(cb);
}

/** 检查指定 API 是否在当前档次中启用 */
export function isApiEnabled(apiName: GmProApiName): boolean {
  return getCurrentProfile().enabledApis.includes(apiName);
}

/** 检查指定功能是否在当前档次中启用 */
export function isFeatureEnabled(feature: keyof CapabilityProfile['features']): boolean {
  return getCurrentProfile().features[feature];
}

/** 获取所有档次列表（供 Dashboard 展示） */
export function listProfiles(): Array<{ id: CapabilityProfileId; label: string; description: string; estimatedOverhead: number; apiCount: number }> {
  return (Object.keys(CAPABILITY_PROFILES) as CapabilityProfileId[]).map((id) => {
    const p = CAPABILITY_PROFILES[id];
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      estimatedOverhead: p.estimatedOverhead,
      apiCount: p.enabledApis.length,
    };
  });
}

// ---------------------------------------------------------------------------
// v1.2.0-5: 基于硬件资源的能力档次自动推荐
// ---------------------------------------------------------------------------

import { cpus, totalmem, freemem } from 'node:os';

/** 硬件资源快照（用于推荐 + 审计） */
export interface HardwareSnapshot {
  cpuCores: number;
  cpuModel: string;
  totalMemoryMB: number;
  freeMemoryMB: number;
  usedMemoryRatio: number;
  availableMemoryMB: number;
  nodeVersion: string;
  platform: string;
}

/** 推荐结果（含推荐理由，便于 Dashboard 展示 + 用户决策） */
export interface ProfileRecommendation {
  recommended: CapabilityProfileId;
  current: CapabilityProfileId;
  reasoning: string;
  hardware: HardwareSnapshot;
  /** 建议的备选档次（更高 / 更低），供用户参考 */
  alternatives: Array<{ id: CapabilityProfileId; reason: string }>;
}

/** 采集硬件资源快照 */
export function getHardwareSnapshot(): HardwareSnapshot {
  const cpuList = cpus();
  const totalMB = Math.round(totalmem() / 1024 / 1024);
  const freeMB = Math.round(freemem() / 1024 / 1024);
  return {
    cpuCores: cpuList.length,
    cpuModel: cpuList[0]?.model ?? 'unknown',
    totalMemoryMB: totalMB,
    freeMemoryMB: freeMB,
    usedMemoryRatio: totalMB > 0 ? (totalMB - freeMB) / totalMB : 0,
    availableMemoryMB: freeMB,
    nodeVersion: process.version,
    platform: process.platform,
  };
}

/**
 * v1.2.0-5: 基于硬件资源推荐能力档次。
 *
 * 推荐策略（保守偏向，优先保证系统稳定）：
 * - minimal:  CPU < 2 核 或 可用内存 < 512MB（资源严重受限，如树莓派/CI 容器）
 * - balanced: CPU 2-3 核 且 可用内存 512MB-2GB（典型开发机/小服务器）
 * - performance: CPU 4-7 核 且 可用内存 2GB-6GB（中型服务器/工作站）
 * - full: CPU >= 8 核 且 可用内存 >= 6GB（高性能服务器）
 *
 * 注意：可用内存而非总内存 —— 已被其他进程占用的内存不能用于 LLM 推理。
 * 当 CPU/内存档位不一致时，取较低档（短板效应）。
 */
export function recommendProfileByHardware(): ProfileRecommendation {
  const hw = getHardwareSnapshot();
  const current = getCurrentProfileId();

  // 评分：根据 CPU 核数和可用内存分别打分（0-3），取较低值为最终档位
  let cpuScore: 0 | 1 | 2 | 3;
  if (hw.cpuCores < 2) cpuScore = 0;
  else if (hw.cpuCores < 4) cpuScore = 1;
  else if (hw.cpuCores < 8) cpuScore = 2;
  else cpuScore = 3;

  let memScore: 0 | 1 | 2 | 3;
  const availMB = hw.availableMemoryMB;
  if (availMB < 512) memScore = 0;
  else if (availMB < 2048) memScore = 1;
  else if (availMB < 6144) memScore = 2;
  else memScore = 3;

  // 取较低分（短板效应），但内存充裕时允许 CPU 不达标的升一档
  const finalScore = Math.min(cpuScore, memScore);
  const recommendedMap: Record<number, CapabilityProfileId> = {
    0: 'minimal',
    1: 'balanced',
    2: 'performance',
    3: 'full',
  };
  const recommended = recommendedMap[finalScore];

  // 生成推荐理由
  const reasons: string[] = [];
  reasons.push(`CPU ${hw.cpuCores} 核（${hw.cpuModel.slice(0, 40)}）`);
  reasons.push(`可用内存 ${hw.availableMemoryMB}MB / 总 ${hw.totalMemoryMB}MB`);
  if (hw.usedMemoryRatio > 0.7) {
    reasons.push(`系统内存使用率 ${(hw.usedMemoryRatio * 100).toFixed(0)}% 偏高，已考虑安全余量`);
  }

  // 备选方案
  const alternatives: Array<{ id: CapabilityProfileId; reason: string }> = [];
  const scoreToId: Array<{ score: number; id: CapabilityProfileId }> = [
    { score: 0, id: 'minimal' },
    { score: 1, id: 'balanced' },
    { score: 2, id: 'performance' },
    { score: 3, id: 'full' },
  ];
  for (const alt of scoreToId) {
    if (alt.id === recommended) continue;
    if (alt.score > finalScore) {
      alternatives.push({
        id: alt.id,
        reason: `更高开销档（若需更多 gm-pro 能力且接受额外延迟），当前 CPU/内存尚有余量`,
      });
      break; // 只推荐一个更高档
    }
  }
  for (const alt of scoreToId) {
    if (alt.id === recommended) continue;
    if (alt.score < finalScore) {
      alternatives.push({
        id: alt.id,
        reason: `更低开销档（若遇性能问题或部署到更弱机器），保证系统稳定运行`,
      });
      break; // 只推荐一个更抵挡
    }
  }

  return {
    recommended,
    current,
    reasoning: reasons.join('；') + '。',
    hardware: hw,
    alternatives,
  };
}
