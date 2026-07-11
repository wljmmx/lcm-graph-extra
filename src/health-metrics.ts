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

    // v1.2.0-1: 同步写入延迟直方图（用于 Prometheus P50/P90/P95/P99 暴露）
    latencyHistograms.assemble.observe(assembleMs);
    latencyHistograms.l2_qmd.observe(l2Ms);
    latencyHistograms.l3_graph.observe(l3Ms);
    latencyHistograms.l4_experience.observe(l4Ms);

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
          // BUGFIX(P2-6): 与 lcm-bridge 一致的 PRAGMA 设置，避免混用 journal_mode 导致锁竞争
          try {
            this.db.exec('PRAGMA journal_mode = WAL');
            this.db.exec('PRAGMA synchronous = NORMAL');
            this.db.exec('PRAGMA cache_size = -65536');
            this.db.exec('PRAGMA temp_store = MEMORY');
          } catch { /* PRAGMA 失败不阻塞（可能是只读场景） */ }
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

      // v1.2.0-2: 健康历史保留期可配置（默认 30 天）
      const retentionDays = Number(process.env.HEALTH_METRICS_RETENTION_DAYS) || 30;
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
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
    this.close();
  }
}

// 全局单例
export const healthMetrics = new HealthMetricsCollector();

// ---------------------------------------------------------------------------
// v1.2.0-1: 延迟直方图（P50/P90/P95/P99）—— Prometheus histogram 指标
// ---------------------------------------------------------------------------

/**
 * 轻量延迟直方图 —— 滑动窗口保留最近 N 次采样，计算百分位。
 * 不依赖外部库，纯内存计算。
 */
export class LatencyHistogram {
  private samples: number[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 500) {
    this.maxSamples = maxSamples;
  }

  /** 记录一次延迟采样（毫秒） */
  observe(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    this.samples.push(latencyMs);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /** 计算百分位（0-100） */
  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  /** 获取统计摘要 */
  getStats(): { count: number; avg: number; p50: number; p90: number; p95: number; p99: number; min: number; max: number } {
    if (this.samples.length === 0) {
      return { count: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0 };
    }
    const sum = this.samples.reduce((a, b) => a + b, 0);
    return {
      count: this.samples.length,
      avg: sum / this.samples.length,
      p50: this.percentile(50),
      p90: this.percentile(90),
      p95: this.percentile(95),
      p99: this.percentile(99),
      min: Math.min(...this.samples),
      max: Math.max(...this.samples),
    };
  }

  /** 重置（测试用） */
  reset(): void {
    this.samples = [];
  }
}

/** 全局延迟直方图 —— 分别跟踪 assemble / L2 / L3 / L4 */
export const latencyHistograms = {
  assemble: new LatencyHistogram(),
  l2_qmd: new LatencyHistogram(),
  l3_graph: new LatencyHistogram(),
  l4_experience: new LatencyHistogram(),
};

// ---------------------------------------------------------------------------
// v1.2.0-3: 业务指标 —— 经验质量分布 / TTL 命中率
// ---------------------------------------------------------------------------

/**
 * 业务指标收集器 —— 跟踪经验质量分布和 TTL 命中率。
 * 仅内存态，通过 Prometheus /metrics 端点暴露。
 */
export class BusinessMetricsCollector {
  // 经验质量分布：低/中/高三个区间的计数
  private expQualityBuckets = { low: 0, medium: 0, high: 0 };
  // TTL 命中/未命中
  private ttlHits = 0;
  private ttlMisses = 0;
  // 经验蒸馏成功/失败
  private distillSuccess = 0;
  private distillFailure = 0;

  /** 记录经验质量分（0-1） */
  recordExperienceQuality(score: number): void {
    if (!Number.isFinite(score)) return;
    if (score < 0.4) this.expQualityBuckets.low++;
    else if (score < 0.7) this.expQualityBuckets.medium++;
    else this.expQualityBuckets.high++;
  }

  /** 记录 TTL 命中/未命中 */
  recordTtlAccess(hit: boolean): void {
    if (hit) this.ttlHits++;
    else this.ttlMisses++;
  }

  /** 记录蒸馏结果 */
  recordDistill(success: boolean): void {
    if (success) this.distillSuccess++;
    else this.distillFailure++;
  }

  /** 获取经验质量分布 */
  getExpQualityDistribution(): { low: number; medium: number; high: number } {
    return { ...this.expQualityBuckets };
  }

  /** 获取 TTL 命中率 */
  getTtlHitRate(): number {
    const total = this.ttlHits + this.ttlMisses;
    return total === 0 ? 0 : this.ttlHits / total;
  }

  /** 获取蒸馏成功率 */
  getDistillSuccessRate(): number {
    const total = this.distillSuccess + this.distillFailure;
    return total === 0 ? 0 : this.distillSuccess / total;
  }

  /** 获取全部业务指标摘要 */
  getSummary(): {
    expQuality: { low: number; medium: number; high: number };
    ttlHitRate: number;
    ttlHits: number;
    ttlMisses: number;
    distillSuccessRate: number;
    distillSuccess: number;
    distillFailure: number;
  } {
    return {
      expQuality: this.getExpQualityDistribution(),
      ttlHitRate: this.getTtlHitRate(),
      ttlHits: this.ttlHits,
      ttlMisses: this.ttlMisses,
      distillSuccessRate: this.getDistillSuccessRate(),
      distillSuccess: this.distillSuccess,
      distillFailure: this.distillFailure,
    };
  }

  /** 重置（测试用） */
  reset(): void {
    this.expQualityBuckets = { low: 0, medium: 0, high: 0 };
    this.ttlHits = 0;
    this.ttlMisses = 0;
    this.distillSuccess = 0;
    this.distillFailure = 0;
  }
}

/** 全局业务指标单例 */
export const businessMetrics = new BusinessMetricsCollector();
