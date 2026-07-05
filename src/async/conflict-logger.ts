/**
 * lcm-graph-extra — P5-5: Conflict Resolution Logger
 *
 * Detects and logs entity conflicts during upsert operations.
 * When two entities share the same name but have different content,
 * the conflict resolver compares timestamps and confidence scores,
 * logs the conflict for traceability, and determines which version to keep.
 */

import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULTS } from '../config/defaults.js';
import { getGlobalLogger } from '../utils/logger.js';

export interface ConflictRecord {
  /** Entity name that conflicted */
  entityName: string;
  /** Entity type (TASK/SKILL/EVENT) */
  entityType: string;
  /** Timestamp of the existing version */
  existingUpdatedAt: number;
  /** Timestamp of the new version */
  newUpdatedAt: number;
  /** Validated count */
  existingConfidence: number;
  newConfidence: number;
  /** Decision: which version was kept */
  resolution: 'keep_existing' | 'replace_with_new' | 'merge_both';
  /** Reason for the decision */
  reason: string;
  /** When the conflict was resolved */
  resolvedAt: string;
  /** Existing content snippet */
  existingContent?: string;
  /** New content snippet */
  newContent?: string;
}

export class ConflictLogger {
  /** P3-2: 内存中保留的最大冲突记录数，超出后丢弃最旧的（防止长生命周期内存泄漏） */
  // P2-3 H-16: 集中到 DEFAULTS.conflict
  private static readonly MAX_IN_MEMORY = DEFAULTS.conflict.maxInMemory;
  /** P3-2: 单个日志文件大小上限（10MB），超出后轮转 */
  private static readonly MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

  private logPath: string;
  private rotatedPath: string;
  private conflicts: ConflictRecord[] = [];

  constructor(basePath?: string) {
    const dir = basePath ?? join(homedir(), '.openclaw', 'lcm-graph-extra', 'logs');
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, 'conflicts.log');
    this.rotatedPath = join(dir, 'conflicts.log.1');
  }

  /**
   * Resolve a conflict between existing and new entity data.
   * Logs the conflict and returns the resolution decision.
   */
  resolve(
    entityName: string,
    entityType: string,
    existing: { updatedAt: number; validatedCount: number; content: string },
    newData: { updatedAt: number; validatedCount: number; content: string },
  ): 'keep_existing' | 'replace_with_new' | 'merge_both' {
    const now = new Date().toISOString();
    let resolution: 'keep_existing' | 'replace_with_new' | 'merge_both' = 'keep_existing';
    let reason = '';

    // Compare content similarity (simple equality check)
    const contentDiffers = existing.content.trim() !== newData.content.trim();

    if (!contentDiffers) {
      // Same content, no conflict - keep existing with updated count
      resolution = 'merge_both';
      reason = `相同内容，合并 validatedCount (${existing.validatedCount} + ${newData.validatedCount})`;
    } else if (newData.updatedAt > existing.updatedAt && newData.validatedCount > existing.validatedCount) {
      // New data is both newer and has higher confidence
      resolution = 'replace_with_new';
      reason = `新版本更新 (${new Date(newData.updatedAt).toISOString()} > ${new Date(existing.updatedAt).toISOString()}) 且置信度更高 (${newData.validatedCount} > ${existing.validatedCount})`;
    } else if (newData.updatedAt > existing.updatedAt) {
      // Newer but lower confidence - keep existing, but log
      resolution = 'keep_existing';
      reason = `新版本更新但仍保留现有版本，因现有置信度更高 (${existing.validatedCount} > ${newData.validatedCount})`;
    } else if (newData.validatedCount > existing.validatedCount) {
      // Higher confidence but older - keep existing with note
      resolution = 'keep_existing';
      reason = `新版本置信度更高但更旧，保留现有版本。考虑手动审核`;
    } else {
      // Older and lower confidence
      resolution = 'keep_existing';
      reason = `现有版本更新且置信度更高`;
    }

    const record: ConflictRecord = {
      entityName,
      entityType,
      existingUpdatedAt: existing.updatedAt,
      newUpdatedAt: newData.updatedAt,
      existingConfidence: existing.validatedCount,
      newConfidence: newData.validatedCount,
      resolution,
      reason,
      resolvedAt: now,
      existingContent: existing.content.slice(0, 200),
      newContent: newData.content.slice(0, 200),
    };

    this.conflicts.push(record);
    // P3-2: 内存上限，超出后丢弃最旧的记录（环形缓冲语义）
    if (this.conflicts.length > ConflictLogger.MAX_IN_MEMORY) {
      this.conflicts.shift();
    }
    this.writeLog(record);

    return resolution;
  }

  /**
   * Write a conflict record to the log file.
   * P3-2: 文件超过 MAX_FILE_SIZE_BYTES 时轮转（conflicts.log → conflicts.log.1），
   * 防止长生命周期下日志文件无限增长占满磁盘。
   */
  private writeLog(record: ConflictRecord): void {
    try {
      this.maybeRotate();
      const line = JSON.stringify(record) + '\n';
      appendFileSync(this.logPath, line, 'utf-8');
    } catch (e) {
      // Non-critical
      getGlobalLogger()?.debug?.("conflict log write failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * P3-2: 若当前日志文件超过大小上限，将其重命名为 .1（覆盖旧备份），
   * 后续写入会创建新的 conflicts.log。保留最近 1 份轮转备份。
   */
  private maybeRotate(): void {
    try {
      if (!existsSync(this.logPath)) return;
      const stats = statSync(this.logPath);
      if (stats.size >= ConflictLogger.MAX_FILE_SIZE_BYTES) {
        renameSync(this.logPath, this.rotatedPath);
      }
    } catch (e) {
      // 轮转失败不影响主流程
      getGlobalLogger()?.debug?.("conflict log rotation failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Get all conflicts (in-memory, current session).
   */
  getConflicts(): ConflictRecord[] {
    return this.conflicts;
  }

  /**
   * Get recent conflicts for a specific entity.
   */
  getConflictsFor(entityName: string): ConflictRecord[] {
    return this.conflicts.filter((c) => c.entityName === entityName);
  }
}
