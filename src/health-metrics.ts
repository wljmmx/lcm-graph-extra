/**
 * N-4: 健康指标收集器 —— 收集 heartbeat pressure signals + 检索性能指标。
 *
 * 设计：
 * - 内存环形缓冲区，保留最近 N 次采集的指标快照
 * - 可选写入 lcm.db health_metrics 表供历史查询
 * - lcmg_diagnose 工具读取最新快照展示
 * - 不依赖外部服务，纯本地收集
 */

import { getGlobalLogger } from './utils/logger.js';

/** 单次指标快照 */
export interface HealthSnapshot {
  timestamp: number;
  // Pressure signals
  pendingMessages: number;
  summaryFragments: number;
  maxTokenRatio: number;
  // Circuit breaker states
  cbLcmAvailable: boolean;
  cbQmdAvailable: boolean;
  cbNeo4jAvailable: boolean;
  cbLcmFailures: number;
  cbQmdFailures: number;
  cbNeo4jFailures: number;
  // Retrieval performance (最近一轮 assemble)
  lastAssembleMs: number;
  lastL2Ms: number;
  lastL3Ms: number;
  lastL4Ms: number;
  // Experience stats
  pendingExperienceCount: number;
  distilledExperienceCount: number;
  // Tier distribution
  tierLow: number;
  tierMedium: number;
  tierHigh: number;
  // R-2 cascade judgeRecall（仅内存态，不持久化到 lcm.db 避免 ALTER TABLE 风险）
  cascadeTier1Confidence?: number;
  cascadeJudgeSource?: 'gm-pro' | 'local';
  // v1.1-6: UX 指标 —— 降级频率 / Token 节省率 / 经验命中率
  degradedCount: number;
  totalAssembleCount: number;
  tokenSavedRatio: number;
  experienceHitCount: number;
  experienceQueryCount: number;
  // v1.1-7: 最近一次 assemble 的降级原因（用于 Dashboard 实时展示链路状态）
  lastDegradedReasons?: string[];
}

const MAX_SNAPSHOTS = 144; // ~12h of 5min heartbeats

/**
 * N-4: 健康指标收集器单例。
 * 在 heartbeat 中调用 collect()，在 lcmg_diagnose 中调用 getLatest() / getHistory()。
 */
export class HealthMetricsCollector {
  private snapshots: HealthSnapshot[] = [];
  private db: any = null;
  private dbInitialized = false;
  // 初始化 promise 缓存，防止并发 collect 触发多次 init 导致 DB 连接泄漏
  private initPromise: Promise<void> | null = null;
  // assemble 指标更新后标记 dirty，下次 persist 时连同最新快照一起写入
  private dirtySinceLastPersist = false;

  /** 收集一次指标快照 */
  collect(snapshot: Partial<HealthSnapshot>): void {
    // 不允许调用方覆盖 timestamp（主键语义）
    const { timestamp: _ignored, ...rest } = snapshot as any;
    const full: HealthSnapshot = {
      timestamp: Date.now(),
      pendingMessages: 0,
      summaryFragments: 0,
      maxTokenRatio: 0,
      cbLcmAvailable: true,
      cbQmdAvailable: true,
      cbNeo4jAvailable: true,
      cbLcmFailures: 0,
      cbQmdFailures: 0,
      cbNeo4jFailures: 0,
      lastAssembleMs: 0,
      lastL2Ms: 0,
      lastL3Ms: 0,
      lastL4Ms: 0,
      pendingExperienceCount: 0,
      distilledExperienceCount: 0,
      tierLow: 0,
      tierMedium: 0,
      tierHigh: 0,
      degradedCount: 0,
      totalAssembleCount: 0,
      tokenSavedRatio: 0,
      experienceHitCount: 0,
      experienceQueryCount: 0,
      ...rest,
    };

    this.snapshots.push(full);
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }
    // 新快照已含当前 assemble 指标，清除 dirty 标记
    this.dirtySinceLastPersist = false;

    // 异步写入 lcm.db（非阻塞）
    this.persistToDb(full).catch(() => { /* non-fatal */ });
  }

  /** 获取最新快照（返回副本，防止外部 mutate 内部状态） */
  getLatest(): HealthSnapshot | null {
    if (this.snapshots.length === 0) return null;
    const s = this.snapshots[this.snapshots.length - 1];
    return { ...s };
  }

  /** 获取历史快照（最近 N 条，返回深拷贝） */
  getHistory(n: number = 20): HealthSnapshot[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    const slice = this.snapshots.slice(-Math.min(Math.trunc(n), this.snapshots.length));
    return slice.map((s) => ({ ...s }));
  }

  /**
   * 记录单次 assemble 性能指标。
   * 更新最新快照（若无快照则创建一个），并标记 dirty 以便下次 persist 同步到 DB。
   */
  recordAssemble(tier: 'low' | 'medium' | 'high', assembleMs: number, l2Ms: number, l3Ms: number, l4Ms: number): void {
    // 首次 heartbeat 前调用时 getLatest() 可能为 null —— 创建占位快照
    let latest = this.snapshots[this.snapshots.length - 1];
    if (!latest) {
      latest = {
        timestamp: Date.now(),
        pendingMessages: 0, summaryFragments: 0, maxTokenRatio: 0,
        cbLcmAvailable: true, cbQmdAvailable: true, cbNeo4jAvailable: true,
        cbLcmFailures: 0, cbQmdFailures: 0, cbNeo4jFailures: 0,
        lastAssembleMs: 0, lastL2Ms: 0, lastL3Ms: 0, lastL4Ms: 0,
        pendingExperienceCount: 0, distilledExperienceCount: 0,
        tierLow: 0, tierMedium: 0, tierHigh: 0,
        degradedCount: 0, totalAssembleCount: 0, tokenSavedRatio: 0,
        experienceHitCount: 0, experienceQueryCount: 0,
      };
      this.snapshots.push(latest);
    }
    latest.lastAssembleMs = assembleMs;
    latest.lastL2Ms = l2Ms;
    latest.lastL3Ms = l3Ms;
    latest.lastL4Ms = l4Ms;
    if (tier === 'low') latest.tierLow++;
    else if (tier === 'medium') latest.tierMedium++;
    else if (tier === 'high') latest.tierHigh++;
    // 非法 tier 值忽略（不静默归入 high）
    this.dirtySinceLastPersist = true;

    // 若已有 DB 初始化，立即把更新后的快照写回 DB（保证内存与 DB 一致）
    if (this.dbInitialized && this.db) {
      this.persistToDb({ ...latest }).catch(() => { /* non-fatal */ });
    }
  }

  /**
   * v1.1-6: 记录 UX 指标 —— 降级触发 / Token 节省 / 经验命中。
   * 在 assemble 完成后调用，累积到最新快照。
   */
  recordUxMetrics(opts: {
    degraded: boolean;
    degradedReasons?: string[];
    estimatedTokens: number;
    maxContextChars: number;
    experienceHit: boolean;
    experienceQueried: boolean;
  }): void {
    let latest = this.snapshots[this.snapshots.length - 1];
    if (!latest) {
      latest = {
        timestamp: Date.now(),
        pendingMessages: 0, summaryFragments: 0, maxTokenRatio: 0,
        cbLcmAvailable: true, cbQmdAvailable: true, cbNeo4jAvailable: true,
        cbLcmFailures: 0, cbQmdFailures: 0, cbNeo4jFailures: 0,
        lastAssembleMs: 0, lastL2Ms: 0, lastL3Ms: 0, lastL4Ms: 0,
        pendingExperienceCount: 0, distilledExperienceCount: 0,
        tierLow: 0, tierMedium: 0, tierHigh: 0,
        degradedCount: 0, totalAssembleCount: 0, tokenSavedRatio: 0,
        experienceHitCount: 0, experienceQueryCount: 0,
      };
      this.snapshots.push(latest);
    }
    latest.totalAssembleCount++;
    if (opts.degraded) latest.degradedCount++;
    // v1.1-7: 记录最近一次降级原因（覆盖式，便于 Dashboard 实时展示）
    latest.lastDegradedReasons = opts.degraded && Array.isArray(opts.degradedReasons)
      ? [...opts.degradedReasons]
      : [];
    if (opts.experienceQueried) {
      latest.experienceQueryCount++;
      if (opts.experienceHit) latest.experienceHitCount++;
    }
    // Token 节省率 = (maxContextChars - estimatedTokens) / maxContextChars
    if (opts.maxContextChars > 0 && opts.estimatedTokens >= 0) {
      const saved = Math.max(0, opts.maxContextChars - opts.estimatedTokens) / opts.maxContextChars;
      // 滑动平均：新值占 20%，避免单次抖动
      latest.tokenSavedRatio = latest.tokenSavedRatio === 0
        ? saved
        : latest.tokenSavedRatio * 0.8 + saved * 0.2;
    }
    this.dirtySinceLastPersist = true;
  }

  /**
   * v1.1-6: 计算 UX 指标摘要，供 Dashboard / Prometheus 暴露。
   */
  getUxSummary(): {
    degradationRate: number;
    avgTokenSavedRatio: number;
    experienceHitRate: number;
    totalAssembles: number;
    degradedCount: number;
  } {
    const latest = this.snapshots[this.snapshots.length - 1];
    if (!latest || latest.totalAssembleCount === 0) {
      return { degradationRate: 0, avgTokenSavedRatio: 0, experienceHitRate: 0, totalAssembles: 0, degradedCount: 0 };
    }
    return {
      degradationRate: latest.degradedCount / latest.totalAssembleCount,
      avgTokenSavedRatio: latest.tokenSavedRatio,
      experienceHitRate: latest.experienceQueryCount > 0
        ? latest.experienceHitCount / latest.experienceQueryCount
        : 0,
      totalAssembles: latest.totalAssembleCount,
      degradedCount: latest.degradedCount,
    };
  }

  /**
   * R-2: 记录 cascade Tier 1 置信度评估结果（仅内存态）。
   * - confidence: 0-1 浮点
   * - source: 'gm-pro'（gm-pro judgeRecall 可用）/ 'local'（本地 evaluateTier1）
   * 不持久化到 lcm.db（避免 ALTER TABLE 风险），通过 :7423 snapshot + Prometheus 暴露。
   */
  recordCascadeConfidence(confidence: number, source: 'gm-pro' | 'local'): void {
    let latest = this.snapshots[this.snapshots.length - 1];
    if (!latest) {
      latest = {
        timestamp: Date.now(),
        pendingMessages: 0, summaryFragments: 0, maxTokenRatio: 0,
        cbLcmAvailable: true, cbQmdAvailable: true, cbNeo4jAvailable: true,
        cbLcmFailures: 0, cbQmdFailures: 0, cbNeo4jFailures: 0,
        lastAssembleMs: 0, lastL2Ms: 0, lastL3Ms: 0, lastL4Ms: 0,
        pendingExperienceCount: 0, distilledExperienceCount: 0,
        tierLow: 0, tierMedium: 0, tierHigh: 0,
        degradedCount: 0, totalAssembleCount: 0, tokenSavedRatio: 0,
        experienceHitCount: 0, experienceQueryCount: 0,
      };
      this.snapshots.push(latest);
    }
    latest.cascadeTier1Confidence = confidence;
    latest.cascadeJudgeSource = source;
    // 仅内存态字段，不触发 dirtySinceLastPersist（不持久化）
  }

  /** 确保数据库已初始化（幂等，并发安全） */
  private async ensureDbInitialized(): Promise<void> {
    if (this.dbInitialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const { createRequire } = await import('node:module');
          const req = createRequire(import.meta.url);
          const { DatabaseSync } = req('node:sqlite');
          const { resolve } = await import('node:path');
          const { homedir } = await import('node:os');
          const dbPath = resolve(homedir(), '.openclaw', 'lcm.db');
          this.db = new DatabaseSync(dbPath);
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS health_metrics (
              ts INTEGER PRIMARY KEY,
              pending_msgs INTEGER,
              summary_frags INTEGER,
              token_ratio REAL,
              cb_lcm_ok INTEGER,
              cb_qmd_ok INTEGER,
              cb_neo4j_ok INTEGER,
              cb_lcm_fails INTEGER,
              cb_qmd_fails INTEGER,
              cb_neo4j_fails INTEGER,
              assemble_ms INTEGER,
              l2_ms INTEGER,
              l3_ms INTEGER,
              l4_ms INTEGER,
              pending_exp INTEGER,
              distilled_exp INTEGER,
              tier_low INTEGER,
              tier_med INTEGER,
              tier_high INTEGER
            )
          `);
          this.dbInitialized = true;
        } finally {
          this.initPromise = null; // 清理 promise 引用，失败后允许重试
        }
      })();
    }
    await this.initPromise;
  }

  /** 持久化到 lcm.db */
  private async persistToDb(snapshot: HealthSnapshot): Promise<void> {
    try {
      await this.ensureDbInitialized();
      if (!this.db) return;

      this.db.prepare(`
        INSERT OR REPLACE INTO health_metrics
        (ts, pending_msgs, summary_frags, token_ratio, cb_lcm_ok, cb_qmd_ok, cb_neo4j_ok,
         cb_lcm_fails, cb_qmd_fails, cb_neo4j_fails, assemble_ms, l2_ms, l3_ms, l4_ms,
         pending_exp, distilled_exp, tier_low, tier_med, tier_high)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        snapshot.timestamp,
        snapshot.pendingMessages,
        snapshot.summaryFragments,
        snapshot.maxTokenRatio,
        snapshot.cbLcmAvailable ? 1 : 0,
        snapshot.cbQmdAvailable ? 1 : 0,
        snapshot.cbNeo4jAvailable ? 1 : 0,
        snapshot.cbLcmFailures,
        snapshot.cbQmdFailures,
        snapshot.cbNeo4jFailures,
        snapshot.lastAssembleMs,
        snapshot.lastL2Ms,
        snapshot.lastL3Ms,
        snapshot.lastL4Ms,
        snapshot.pendingExperienceCount,
        snapshot.distilledExperienceCount,
        snapshot.tierLow,
        snapshot.tierMedium,
        snapshot.tierHigh,
      );

      // 清理 7 天前的数据
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      this.db.prepare('DELETE FROM health_metrics WHERE ts < ?').run(cutoff);
    } catch (e) {
      // DB 写入失败不影响主流程
      getGlobalLogger()?.debug?.("health metrics persistToDb failed (non-fatal)", { err: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 从 lcm.db 读取历史指标 */
  async readFromDb(n: number = 20): Promise<any[]> {
    try {
      await this.ensureDbInitialized();
      if (!this.db) return [];
      const limit = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 20;
      const rows = this.db.prepare(
        'SELECT * FROM health_metrics ORDER BY ts DESC LIMIT ?'
      ).all(limit);
      return rows;
    } catch {
      return [];
    }
  }

  /** 关闭 DB 连接（dispose 时调用） */
  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
      this.dbInitialized = false;
      this.initPromise = null;
    }
  }

  /** 重置（测试用）—— 清空内存快照并关闭 DB */
  reset(): void {
    this.snapshots = [];
    this.dirtySinceLastPersist = false;
    this.close();
  }
}

// 全局单例
export const healthMetrics = new HealthMetricsCollector();
