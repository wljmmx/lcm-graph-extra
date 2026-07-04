/**
 * N-4: 健康指标收集器 —— 收集 heartbeat pressure signals + 检索性能指标。
 *
 * 设计：
 * - 内存环形缓冲区，保留最近 N 次采集的指标快照
 * - 可选写入 lcm.db health_metrics 表供历史查询
 * - lcmg_diagnose 工具读取最新快照展示
 * - 不依赖外部服务，纯本地收集
 */

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

  /** 收集一次指标快照 */
  collect(snapshot: Partial<HealthSnapshot>): void {
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
      ...snapshot,
    };

    this.snapshots.push(full);
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }

    // 异步写入 lcm.db（非阻塞）
    this.persistToDb(full).catch(() => { /* non-fatal */ });
  }

  /** 获取最新快照 */
  getLatest(): HealthSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  /** 获取历史快照（最近 N 条） */
  getHistory(n: number = 20): HealthSnapshot[] {
    return this.snapshots.slice(-Math.min(n, this.snapshots.length));
  }

  /** 记录单次 assemble 性能指标 */
  recordAssemble(tier: 'low' | 'medium' | 'high', assembleMs: number, l2Ms: number, l3Ms: number, l4Ms: number): void {
    const latest = this.getLatest();
    if (latest) {
      latest.lastAssembleMs = assembleMs;
      latest.lastL2Ms = l2Ms;
      latest.lastL3Ms = l3Ms;
      latest.lastL4Ms = l4Ms;
      if (tier === 'low') latest.tierLow++;
      else if (tier === 'medium') latest.tierMedium++;
      else latest.tierHigh++;
    }
  }

  /** 持久化到 lcm.db */
  private async persistToDb(snapshot: HealthSnapshot): Promise<void> {
    try {
      if (!this.dbInitialized) {
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
      }

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
    } catch {
      // DB 写入失败不影响主流程
    }
  }

  /** 从 lcm.db 读取历史指标 */
  readFromDb(n: number = 20): any[] {
    try {
      if (!this.dbInitialized) return [];
      const rows = this.db.prepare(
        'SELECT * FROM health_metrics ORDER BY ts DESC LIMIT ?'
      ).all(n);
      return rows;
    } catch {
      return [];
    }
  }

  /** 重置（测试用） */
  reset(): void {
    this.snapshots = [];
  }
}

// 全局单例
export const healthMetrics = new HealthMetricsCollector();
