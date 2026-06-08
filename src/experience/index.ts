/**
 * Experience Layer (Layer 4) — 统一导出。
 *
 * 经验总结层是独立于消息 DAG / 记忆文件 / 知识图谱的第四层抽象。
 * 特点:
 *   - 异步: 不在主流程组装时运行
 *   - 条件触发: 仅用户纠正/任务失败/修复成功/显式保存
 *   - 批量总结: 由 dreaming 或 cron 定时处理 PENDING 队列
 *   - 瘦召回: assemble 时只查 relevanceScore > threshold 的 DISTILLED 经验
 */

export { ExperienceStorage } from './storage';
export { detectExperienceTrigger, extractRawExperience } from './extractor';
export type {
  ExperienceSource,
  RawExperience,
  DistilledExperience,
  ExperienceNode,
  ExperienceSearchResult,
} from './types';
