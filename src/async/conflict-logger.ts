/**
 * lcm-graph-extra — P5-5: Conflict Resolution Logger
 *
 * Detects and logs entity conflicts during upsert operations.
 * When two entities share the same name but have different content,
 * the conflict resolver compares timestamps and confidence scores,
 * logs the conflict for traceability, and determines which version to keep.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  private logPath: string;
  private conflicts: ConflictRecord[] = [];

  constructor(basePath?: string) {
    const dir = basePath ?? join(homedir(), '.openclaw', 'lcm-graph-extra', 'logs');
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, 'conflicts.log');
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
    this.writeLog(record);

    return resolution;
  }

  /**
   * Write a conflict record to the log file.
   */
  private writeLog(record: ConflictRecord): void {
    try {
      const line = JSON.stringify(record) + '\n';
      appendFileSync(this.logPath, line, 'utf-8');
    } catch {
      // Non-critical
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
