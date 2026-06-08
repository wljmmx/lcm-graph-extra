/**
 * Experience abstraction types — Layer 4 knowledge layer.
 *
 * 经验是独立于消息 DAG、记忆文件、知识图谱的第四层抽象。
 * 仅在特定场景（用户纠正/任务失败/修复成功）触发提取，
 * 并在 dreaming / cron 批次总结。
 */

/** 经验原始来源 */
export type ExperienceSource = 'correction' | 'failure' | 'fix_success' | 'explicit_save';

/** 经验原始记录（afterTurn 提取后写入） */
export interface RawExperience {
  id: string;                    // uuid
  source: ExperienceSource;
  sessionId: string;
  timestamp: Date;
  context: string;               // 触发时的简短上下文描述
  detail: string;                // 原始消息内容片段
  projectName?: string;          // 归属项目
  taskId?: string;               // 归属任务
}

/** 精炼后的经验（dreaming/cron 总结后） */
export interface DistilledExperience {
  id: string;
  rawIds: string[];              // 关联的原始经验 ID
  type: 'correction' | 'failure' | 'fix' | 'lesson' | 'best_practice';
  title: string;                 // 精炼摘要标题
  summary: string;               // 精炼摘要（200-500 字）
  detail: string;                // 完整经验描述
  context: string;               // 适用场景
  projectName?: string;
  relevanceScore: number;        // 0.0 ~ 1.0
  createdAt: Date;
  expiresAt?: Date;              // TTL
  matchCount: number;            // 被命中间接召回次数
}

/** Neo4j 存储格式 */
export interface ExperienceNode {
  id: string;
  labels: string[];              // ['EXPERIENCE', 'Correction'] etc
  properties: Record<string, unknown>;
}

export interface ExperienceSearchResult {
  experience: DistilledExperience;
  score: number;
}
