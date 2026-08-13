/**
 * lcm-graph-extra — Neo4j Graph Search Adapter
 *
 * Bridges lcm-graph-extra with graph-memory-pro's compiled module exports.
 * Dynamically imports from graph-memory-pro/dist/index.js.
 * Uses Recaller.recall(), searchNodes, upsertNode/upsertEdge.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import * as neo4jDriver from 'neo4j-driver';
import type { RetrievalResult, RetrievalSource, RetrievalType } from '../types.js';
import type { Neo4jConfig } from '../types.js';
import { ConflictLogger } from '../async/conflict-logger.js';
import type { EmbeddingConfig } from '../types.js';
import { acquireDriver, releaseDriver } from './connection-pool';
import { createLocalEmbedFn } from './embed-fn';
import type { Logger } from '../utils/logger.js';
import { resolveLogger, getGlobalLogger } from '../utils/logger.js';
import { cleanBaseURL } from '../utils/url.js';
import { callLlm } from '../utils/llm-call.js';
// P2-3 H-16: 接入集中化默认常量（maxRetries / reconnectCooldownMs / searchCache*）
import { DEFAULTS, llmTimeout } from '../config/defaults.js';
// v1.2.0-3: 业务指标 —— 跟踪 searchWithCache 的 TTL 命中率
import { businessMetrics } from '../health-metrics.js';


// ---------------------------------------------------------------------------
// Neo4j Integer / BigInt 安全转换
// ---------------------------------------------------------------------------
// neo4j-driver 6.x 的 Integer 对象 valueOf() 在内部存储为 BigInt 时返回 BigInt，
// 导致 new Date(integer) / Math.trunc(integer) / +integer 抛出
// "Cannot convert a BigInt value to a number"。
// 在 query() 返回边界统一把 Integer 转为原生 number，隔离 driver 内部类型。

/**
 * 递归遍历对象/数组，把所有 Neo4j Integer 转为原生 number。
 * 安全处理嵌套结构和数组。非 Integer 值原样返回。
 */
function convertNeo4jIntegers(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (neo4jDriver.isInt(obj)) {
    return obj.toNumber();
  }
  if (Array.isArray(obj)) {
    return obj.map(convertNeo4jIntegers);
  }
  if (typeof obj === 'object' && obj.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = convertNeo4jIntegers(v);
    }
    return out;
  }
  return obj;
}

/**
 * 清理传给 Neo4j driver 的参数：把 Integer 对象转为原生 number（driver 会重新包装），
 * 避免上层传入的 Integer 对象与 driver 内部类型冲突。
 * 对 LIMIT/batchSize 等整数参数用 neo4jDriver.int() 包装。
 */
function sanitizeNeo4jParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => {
      // Integer 对象 → 原生 number（driver 内部会重新包装）
      if (neo4jDriver.isInt(v)) {
        return [k, v.toNumber()];
      }
      if (typeof v !== 'number') return [k, v];
      // LIMIT/OFFSET/count params must be Neo4j integers
      if (/^(limit|batchSize|max_depth|iterations|timeout)$/.test(k)) {
        return [k, neo4jDriver.int(Math.trunc(v))];
      }
      // Score/threshold params keep float precision
      return [k, v];
    })
  );
}

class LRUCache<K, V> {
  private map = new Map<K, { value: V; expiresAt: number }>();
  constructor(private capacity: number, private ttlMs: number) {}
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const e = this.map.get(key)!;
    if (Date.now() > e.expiresAt) { this.map.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e);
    return e.value;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

export interface GraphAdapterConfig {
  enabled: boolean;
  searchLimit: number;
  embedding?: EmbeddingConfig;
  /** BUG-6: 图谱检索缓存大小可配置（原硬编码 DEFAULTS.graph.searchCacheSize = 50） */
  searchCacheSize?: number;
  /**
   * v2.3.6 在线学习对接：站在 graph-memory-pro 最新 Recaller 能力之上，
   * 让 L3 召回 + 反馈自动采集形成闭环（链路 1/2/3）。
   */
  /** 嵌入维度（关联矩阵 M 需要；缺省则对 embedFn 探测一次） */
  embeddingDimensions?: number;
  /** I-2 LLM/启发式裁判配置（注入 Recaller.setJudgeManager） */
  judge?: {
    enabled?: boolean;
    /** 1=启发式(零 LLM) / 2=LLM 裁判 / 3=自定义 */
    tier?: 1 | 2 | 3;
    /** 冷启动阈值（默认 20，见 gm-pro DEFAULT_JUDGE_CONFIG） */
    judgeWarmupFeedbacks?: number;
    heuristicMatch?: 'id' | 'name' | 'both';
    llmJudgeMaxNodes?: number;
    llmJudgeTimeoutMs?: number;
  };
  /** L-1 关联矩阵 M 在线学习配置（默认关闭，需显式启用） */
  associationMatrix?: {
    enabled?: boolean;
    learningRate?: number;
    warmupFeedbacks?: number;
    /** M 持久化文件路径（缺省用 gm-pro 默认目录） */
    persistPath?: string;
  };
  /** v2.3.5 方案 A: agent_end 自动反馈采集 */
  autoFeedback?: {
    enabled?: boolean;
  };
}

const _gmpRequire = createRequire(import.meta.url);

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(homedir(), '.openclaw');

/** gm-pro 插件 ID（在 extensions 目录中的子目录名） */
const GM_PRO_PLUGIN_ID = 'graph-memory-pro';

/**
 * 解析 graph-memory-pro 模块路径（单一来源，去除 graph-adapter / tools 重复逻辑）。
 *
 * gm-pro 作为 OpenClaw extension 通过 extensions 目录安装管理，
 * 解析优先级与 OpenClaw 框架 `resolvePluginSourceRoots` 一致：
 *
 *   1. 环境变量 GM_PRO_PATH（显式覆盖）
 *   2. global extensions: ${OPENCLAW_DIR}/extensions/graph-memory-pro
 *   3. workspace extensions: ${cwd}/.openclaw/extensions/graph-memory-pro
 *   4. stock extensions: <openclaw-pkg>/dist/extensions/graph-memory-pro
 *   5. require.resolve 降级（兼容旧 npm install 方式）
 *
 * 返回 { path, source } 供调用方记录实际使用的路径与来源。
 */
export function resolveGmProPath(): { path: string; source: 'env' | 'extensions-global' | 'extensions-workspace' | 'extensions-stock' | 'require' } {
  // 1. 环境变量显式覆盖
  if (process.env.GM_PRO_PATH) {
    return { path: process.env.GM_PRO_PATH, source: 'env' };
  }

  // 2. global extensions: ~/.openclaw/extensions/graph-memory-pro
  const globalExtPath = join(OPENCLAW_DIR, 'extensions', GM_PRO_PLUGIN_ID);
  if (existsSync(join(globalExtPath, 'dist', 'index.js'))) {
    return { path: globalExtPath, source: 'extensions-global' };
  }

  // 3. workspace extensions: <cwd>/.openclaw/extensions/graph-memory-pro
  const workspaceExtPath = join(process.cwd(), '.openclaw', 'extensions', GM_PRO_PLUGIN_ID);
  if (existsSync(join(workspaceExtPath, 'dist', 'index.js'))) {
    return { path: workspaceExtPath, source: 'extensions-workspace' };
  }

  // 4. stock extensions: <openclaw-pkg>/dist/extensions/graph-memory-pro
  try {
    const openclawPkgRoot = dirname(_gmpRequire.resolve('openclaw/package.json'));
    const stockExtPath = join(openclawPkgRoot, 'dist', 'extensions', GM_PRO_PLUGIN_ID);
    if (existsSync(join(stockExtPath, 'dist', 'index.js'))) {
      return { path: stockExtPath, source: 'extensions-stock' };
    }
  } catch (e) { /* openclaw package not found */
    getGlobalLogger()?.debug?.('graph-memory-pro stock extensions resolution failed', { err: e instanceof Error ? e.message : String(e) });
  }

  // 5. require.resolve 降级（兼容旧 npm install 方式）
  try {
    const resolved = _gmpRequire.resolve('@openclaw/graph-memory-pro/dist/index.js');
    const dir = resolved.endsWith('/dist/index.js') ? resolved.slice(0, -'/dist/index.js'.length) : resolved;
    return { path: dir, source: 'require' };
  } catch {
    // 所有方式都失败，返回 global extensions 路径作为默认（probeGmPro 会处理不存在的情况）
    return { path: globalExtPath, source: 'extensions-global' };
  }
}

const _GM_PRO_RESOLVED = resolveGmProPath();
const GM_PRO_PATH = _GM_PRO_RESOLVED.path;

/**
 * P2-17: 统一 GmConfig 默认值。原代码在 connect/runMaintenance 等 4 处重复硬编码
 * compactTurnCount/recallMaxNodes/dedupThreshold/pagerankDamping 等参数，
 * 易漂移且用户无法调优。集中到 DEFAULT_GM_CONFIG，buildGmConfig 附加 neo4j。
 */
const DEFAULT_GM_CONFIG = {
  compactTurnCount: 10,
  recallMaxNodes: 8,
  recallMaxDepth: 2,
  freshTailCount: 5,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 12,
};

function buildGmConfig(neo4jConfig: Neo4jConfig, overrides?: Partial<typeof DEFAULT_GM_CONFIG>): Record<string, any> {
  return { neo4j: neo4jConfig, ...DEFAULT_GM_CONFIG, ...overrides };
}

// P2-17: 导出供 tools.ts 等其他模块复用，避免 GmConfig 重复硬编码
export { DEFAULT_GM_CONFIG, buildGmConfig };

/** Map node label to result type */
function inferType(label: string): RetrievalType {
  const u = label.toUpperCase();
  if (['SKILL','CONCEPT','CAPABILITY','METHOD','TOOL'].includes(u)) return 'definition';
  if (['RELATION','EDGE'].includes(u)) return 'relation';
  return 'raw';
}

function mapEntityType(raw: string): string {
  const t = (raw || 'CONCEPT').toUpperCase();
  if (['SKILL','CAPABILITY','METHOD','TOOL','BEST_PRACTICE','CONCEPT','KNOWLEDGE'].includes(t)) return 'SKILL';
  if (['EVENT','BUG','ERROR','ISSUE','PROBLEM'].includes(t)) return 'EVENT';
  return 'TASK';
}

function mapEdgeType(raw: string): string {
  const t = raw.toUpperCase();
  if (['USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH','RELATES_TO'].includes(t)) return t;
  if (['RELATED_TO','REFERENCES','USES'].includes(t)) return 'USED_SKILL';
  if (['RELATES','CROSS_REFERENCE','CONNECTS'].includes(t)) return 'RELATES_TO';
  if (['FIXES','RESOLVES','SOLVES'].includes(t)) return 'SOLVED_BY';
  if (['DEPENDS_ON','NEEDS','PREREQUISITE'].includes(t)) return 'REQUIRES';
  if (['REPLACES','SUPERSEDES','UPDATES'].includes(t)) return 'PATCHES';
  if (['CONFLICTS','INCOMPATIBLE'].includes(t)) return 'CONFLICTS_WITH';
  return 'USED_SKILL';
}

function makeNodeId(name: string, typeName: string): string {
  return `${typeName.toLowerCase()}-${createHash('sha256').update(`${typeName}:${name}`).digest('hex').slice(0, 12)}`;
}

type GmModule = Record<string, any>;

/** SEC-L: 简单字符串 hash（djb2 变体），用于 searchCache key 后缀防碰撞。 */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export class GraphAdapter {
  public conflictLogger = new ConflictLogger();
  private mod: GmModule | null = null;
  private driver: any = null;
  private _connectFailed = false;
  private _connectRetryCount = 0;
  /**
   * 方案 A (2026-08-09): 当前 driver 是否来自 graph-memory-pro 单例（getDriver）。
   * 为 true 时绝不允许 close() 该 driver —— 它由 gm-pro 独占管理，
   * extra 只借用不销毁，否则会误杀 gm-pro 运行中的 driver（无自愈）。
   */
  private _driverFromGmPro = false;
  /** 最近一次连接/健康检查失败的具体错误信息，供 dashboard 诊断展示 */
  private _lastError: string | null = null;
  /** health() 被调用的总次数，用于诊断 heartbeat 是否在运行 */
  private _healthCheckCount = 0;
  /** 并发健康检查防护：防止多个 heartbeat/业务调用同时触发 health() → connect() 竞态 */
  private _healthCheckInProgress = false;
  private _poolRecoveryInProgress = false;
  // P2-3 H-16: 重试次数与冷却期改为引用 DEFAULTS.graph，避免魔术数字散落
  private readonly maxRetries = DEFAULTS.graph.maxRetries;
  // P1-10 GMR-1: 连接失败冷却期。原代码 _connectFailed=true 后无自动恢复路径，
  // 一旦 graph-memory-pro 短暂不可用，L3/L4 永久降级直到插件重载。
  // 加 _lastFailTime + 冷却期（60s），冷却期满后自动重置允许重试。
  private _lastFailTime = 0;
  private readonly reconnectCooldownMs = DEFAULTS.graph.reconnectCooldownMs;
  private config: GraphAdapterConfig;
  private neo4jConfig: Neo4jConfig;
  private logger: Logger;
  private _recaller: any = null;
  /** 是否复用 gm-pro 模块级 Recaller 单例(A)；false 表示回退自建(B) */
  private _recallerFromGmPro = false;
  private _embedFn: any = null;
  private _llm?: (system: string, user: string) => Promise<string>;
  // v2.3.6 在线学习：JudgeManager + AssociationMatrix 注入 Recaller，形成反馈闭环
  private _judgeManager: any = null;
  private _associationMatrix: any = null;

  // P2-3 H-16: searchWithCache 的 LRU 容量与 TTL 改为引用 DEFAULTS.graph
  private searchCache!: LRUCache<string, RetrievalResult[]>;

  constructor(neo4jConfig: Neo4jConfig, config: GraphAdapterConfig, logger?: Logger) {
    this.neo4jConfig = neo4jConfig;
    this.config = config;
    this.logger = resolveLogger(logger);
    // BUG-6: 使用 config.searchCacheSize 替代硬编码 DEFAULTS.graph.searchCacheSize
    this.searchCache = new LRUCache(config.searchCacheSize ?? DEFAULTS.graph.searchCacheSize, DEFAULTS.graph.searchCacheTtlMs);
  }

  get isConnected(): boolean {
    return !!this.driver && !this._connectFailed;
  }

  async connect(): Promise<boolean> {
    // 防止重复 acquire 导致 refCount 失衡
    if (this.driver && this.mod) return true;
    try {
      // P3-3: 记录实际使用的 graph-memory-pro 路径与解析来源
      this.logger?.info?.('[graph-adapter] loading graph-memory-pro', { path: GM_PRO_PATH, source: _GM_PRO_RESOLVED.source });
      const mod = await import(`${GM_PRO_PATH}/dist/index.js`);
      this.mod = mod;
      const gmDriver = mod.getDriver?.() ?? null;
      if (gmDriver) {
        this.driver = gmDriver;
        this._driverFromGmPro = true;
      } else {
        this.logger?.debug?.('[graph-adapter] graph-memory-pro getDriver() returned null, acquiring own driver');
        this.driver = await acquireDriver(this.neo4jConfig);
        this._driverFromGmPro = false;
      }
      if (!this.driver) {
        this._lastError = 'no driver available (gm-pro getDriver null + acquireDriver returned null)';
        this.logger?.warn?.('[graph-adapter] connect: no driver available after all attempts');
        this._connectRetryCount++;
        if (this._connectRetryCount >= this.maxRetries) {
          this._connectFailed = true;
          this._lastFailTime = Date.now();
        }
        return false;
      }

      // v2.5.2: 竞态修复 —— driver 对象存在 ≠ Neo4j 连接池就绪。
      // graph-adapter 拿到 driver 引用时（尤其是 gm-pro getDriver() 在冷启动阶段
      // 返回的引用），底层连接池可能仍在建立，第一个 session:query 就会触发连接错误，
      // 随后 _tryRecoverConnection 恢复成功但第一次 retry 仍失败（日志
      // "session:query: retry after recovery failed"）。这里在返回 true 前用
      // verifyConnectivity() 验证连接真正可用，失败则刷新 driver 引用重试。
      const verified = await this._verifyDriverReady();
      if (!verified) {
        this._connectRetryCount++;
        this._lastError = `connect: driver acquired but connectivity verification failed (Neo4j pool still warming up)`;
        this.logger?.warn?.(`[graph-adapter] ${this._lastError}`);
        if (this._connectRetryCount >= this.maxRetries) {
          this._connectFailed = true;
          this._lastFailTime = Date.now();
        }
        return false;
      }

      // - Initialize / reuse Recaller (gm-pro dual-path recall) -
      try {
        await this._initRecaller();
        this.logger?.info?.('[graph-adapter] Recaller ready (dual-path recall enabled)');
      } catch (initErr) {
        this.logger?.warn?.('[graph-adapter] Recaller init failed, falling back to searchNodes', { err: initErr });
        this._recaller = null;
      }

      // P1-10 GMR-1: 连接成功，重置失败计数与冷却时间
      this._connectRetryCount = 0;
      this._connectFailed = false;
      this._lastFailTime = 0;
      this._lastError = null;
      return true;
    } catch (err) {
      this._connectRetryCount++;
      const errMsg = err instanceof Error ? err.message : String(err);
      this._lastError = `connect attempt ${this._connectRetryCount}/${this.maxRetries} failed: ${errMsg}`;
      this.logger?.warn?.(`[graph-adapter] connect attempt ${this._connectRetryCount}/${this.maxRetries} failed: ${err}`);
      if (this._connectRetryCount >= this.maxRetries) {
        this._connectFailed = true;
        this._lastFailTime = Date.now();
        this.logger?.warn?.(`[graph-adapter] connect failed after ${this.maxRetries} attempts, will retry in ${this.reconnectCooldownMs / 1000}s`);
      }
      return false;
    }
  }

  /** Reset connection failure flag (called on retry / gateway restart) */
  resetConnectFlag(): void {
    this._connectFailed = false;
    this._connectRetryCount = 0;
    this._lastFailTime = 0;
  }

  private async _ensureRecaller(): Promise<void> {
    if (!this.mod || !this.driver) return;
    if (this._recaller) return;
    await this._initRecaller();
    this.logger?.info?.('[graph-adapter] Recaller ready (dual-path recall enabled)');
  }

  /**
   * 初始化/复用 Recaller —— 优先复用 gm-pro 模块级单例(A)，避免自建(B)造成双实例/M 分叉。
   * 仅在 gm-pro 未导出 getRecaller 或 A 未就绪时回退自建，并打降级日志。
   * 随后统一注入/复用 embedding + JudgeManager + AssociationMatrix。
   */
  private async _initRecaller(): Promise<void> {
    const mod = this.mod;
    if (!mod || !this.driver) return;

    // 1) 优先复用 gm-pro 模块级 Recaller(A)
    if (typeof mod.getRecaller === 'function') {
      let shared = mod.getRecaller();
      // A 可能尚未由 gm-pro 自 init 创建，短暂轮询提高复用命中率
      for (let i = 0; i < 5 && !shared; i++) {
        await new Promise((r) => setTimeout(r, 300));
        shared = mod.getRecaller();
      }
      if (shared) {
        this._recaller = shared;
        this._recallerFromGmPro = true;
        this.logger?.info?.('[graph-adapter] reusing gm-pro module-level Recaller (single source of truth)');
      } else {
        this.logger?.warn?.('[graph-adapter] gm-pro getRecaller() returned null, falling back to self-built Recaller');
      }
    } else {
      this.logger?.warn?.('[graph-adapter] gm-pro getRecaller() unavailable (old version), falling back to self-built Recaller');
    }

    // 2) 回退：自建 Recaller(B)——仅当无法复用 A 时（保证 L3 双路径召回与反馈不空）
    if (!this._recaller) {
      this._recaller = new mod.Recaller(this.driver, buildGmConfig(this.neo4jConfig));
      this._recallerFromGmPro = false;
    }

    // 3) 设置 embedding —— 复用 A 时直接沿用 gm-pro 已注入的 embed（含批量能力）。
    //    不要 setEmbedFn 覆盖：lcm 单文本 createLocalEmbedFn 会覆盖 gm-pro 的 embed，
    //    破坏其批量链路。仅当未复用 A（自建 B）时才把 embed 注入到 Recaller。
    //    如需自定义 embed 模型，请配置在 graph-memory-pro 侧（lcm 复用其链路，不重复造轮子）。
    try {
      const ecfg = this.config.embedding;
      const hasExplicitEmbed = !!(ecfg && (ecfg.model || ecfg.apiKey || ecfg.baseURL));
      if (this._recallerFromGmPro) {
        // 复用 A：实际召回沿用 gm-pro 已注入的批量 embed，不 setEmbedFn 覆盖。
        // 但为 lcm 自身的心跳检查/维度探测/维护等代理读取保留一个本地 embed 引用
        // （仅自用，不注入共享 Recaller，故不影响 gm-pro 的批量链路）。
        if (hasExplicitEmbed) {
          try {
            this._embedFn = createLocalEmbedFn(ecfg);
          } catch (e) {
            this._embedFn = mod.createEmbedFn ? mod.createEmbedFn({ ...ecfg }) : undefined;
          }
        }
        this.logger?.info?.('[graph-adapter] reusing graph-memory-pro embedFn (batch-capable); local embedding kept only for lcm proxy reads, not injected into shared Recaller');
      } else if (hasExplicitEmbed) {
        // 自建 B：用 lcm 的 embed（保 keep_alive）
        try {
          this._embedFn = createLocalEmbedFn(ecfg);
          this.logger?.info?.('[graph-adapter] Embedding initialized (local, keep_alive=' + (ecfg.keepAlive || '-1') + ')', { model: ecfg.model });
        } catch (localErr) {
          if (mod.createEmbedFn) {
            this._embedFn = mod.createEmbedFn({ ...ecfg });
            this.logger?.warn?.('[graph-adapter] Local embed fn failed, using graph-memory-pro createEmbedFn (keep_alive not guaranteed)', { err: localErr instanceof Error ? localErr.message : String(localErr) });
          } else {
            throw localErr;
          }
        }
        if (this._embedFn) {
          this._recaller.setEmbedFn(this._embedFn);
        }
      } else {
        this.logger?.warn?.('[graph-adapter] No embedding config provided, community recall disabled');
      }
    } catch (embedErr) {
      this.logger?.warn?.('[graph-adapter] Failed to init embedding for Recaller', { err: embedErr });
    }

    // 4) 复用/补齐 JudgeManager + AssociationMatrix（反馈闭环 + 在线学习）
    await this._configureRecallerOnline(mod);
  }

  /**
   * v2.3.6 在线学习闭环：复用 gm-pro 已注入的 JudgeManager + AssociationMatrix；
   * 仅在缺失时补齐注入到 Recaller（复用其实例，不重复搭建）。
   *
   * 配置来源（v2.5.0 配置复用）：优先使用 gm-pro 的生效配置（getEffectiveConfig，
   * 即 openclaw.json 中 plugins.entries["graph-memory-pro"].config 的值），
   * 仅当 gm-pro 未导出/未就绪时才回退到 lcm 自身配置，避免重复维护一套 Judge /
   * AssociationMatrix 默认值（默认值易漂移）。
   *
   * 对应 gm-pro 链路：
   *   - 链路 1（召回）：Recaller.setEmbedFn → setJudgeManager → setAssociationMatrix → recall()
   *   - 链路 3（M 持久化）：createAssociationMatrixPersisted 启动自动 load 恢复
   *
   * 幂等：_recaller 缺失则跳过；已注入则复用。失败不致命（仅降级为无反馈召回），均输出去降级日志。
   */
  private async _configureRecallerOnline(mod: any): Promise<void> {
    if (!mod || !this._recaller) return;

    // 优先取 gm-pro 的生效配置；未导出/未就绪时为 null（回退 lcm 配置）
    const gmProCfg = typeof mod.getEffectiveConfig === 'function' ? mod.getEffectiveConfig() : null;
    const useGmProConfig = !!gmProCfg;
    const gmJudge = gmProCfg?.judge ?? null;
    const gmAm = gmProCfg?.associationMatrix ?? null;
    const lcmJudge = this.config.judge ?? null;
    const lcmAm = this.config.associationMatrix ?? null;

    // ── 1. JudgeManager（I-2：启发式/LLM 裁判）─────────────────
    try {
      const existingJudge = this._recaller.getJudgeManager?.() ?? null;
      if (existingJudge) {
        this._judgeManager = existingJudge;
        this.logger?.info?.('[graph-adapter] reusing existing JudgeManager from gm-pro (feedback loop enabled)');
      } else if (typeof mod.JudgeManager === 'function' && (gmJudge?.enabled ?? lcmJudge?.enabled ?? true) !== false) {
        // 从 gm-pro 生效配置取值，缺失字段回退 lcm 配置（避免重复维护一套默认值）
        const judgeCfg: Record<string, any> = {
          enabled: gmJudge?.enabled ?? lcmJudge?.enabled ?? true,
          tier: gmJudge?.tier ?? lcmJudge?.tier ?? 1,
          heuristicMatch: gmJudge?.heuristicMatch ?? lcmJudge?.heuristicMatch ?? 'both',
        };
        const jw = gmJudge?.judgeWarmupFeedbacks ?? lcmJudge?.judgeWarmupFeedbacks;
        if (typeof jw === 'number') judgeCfg.judgeWarmupFeedbacks = jw;
        const lmn = gmJudge?.llmJudgeMaxNodes ?? lcmJudge?.llmJudgeMaxNodes;
        if (typeof lmn === 'number') judgeCfg.llmJudgeMaxNodes = lmn;
        const lmt = gmJudge?.llmJudgeTimeoutMs ?? lcmJudge?.llmJudgeTimeoutMs;
        if (typeof lmt === 'number') judgeCfg.llmJudgeTimeoutMs = lmt;
        const jm = new mod.JudgeManager(judgeCfg);
        // 从 Neo4j 恢复累计反馈计数，避免冷启动反复
        if (typeof mod.getFeedbackCount === 'function') {
          try {
            const persistedCount = await mod.getFeedbackCount(this.driver);
            for (let i = 0; i < (persistedCount ?? 0); i++) jm.incrementFeedback();
            this.logger?.debug?.('[graph-adapter] JudgeManager feedback bootstrap', { persistedCount });
          } catch { /* DB 可能为空 */ }
        }
        this._recaller.setJudgeManager(jm);
        this._judgeManager = jm;
        this.logger?.info?.('[graph-adapter] injected JudgeManager into Recaller (feedback loop enabled)', {
          configSource: useGmProConfig ? 'graph-memory-pro' : 'lcm',
        });
      } else if (!existingJudge) {
        this.logger?.warn?.('[graph-adapter] JudgeManager unavailable — feedback loop degraded (no online learning)');
      }
    } catch (judgeErr) {
      this.logger?.warn?.('[graph-adapter] JudgeManager inject failed (feedback loop degraded)', { err: String(judgeErr) });
      this._judgeManager = null;
    }

    // ── 2. AssociationMatrix（L-1：在线学习 M 矩阵，默认关闭）─────
    //    是否启用以 gm-pro 生效配置为准（缺省才参考 lcm 配置）
    const amEnabled = gmAm?.enabled === true || lcmAm?.enabled === true;
    if (amEnabled) {
      try {
        const existingAm = this._recaller.getAssociationMatrix?.() ?? null;
        if (existingAm) {
          this._associationMatrix = existingAm;
          this.logger?.info?.('[graph-adapter] reusing existing AssociationMatrix from gm-pro (online learning on)');
        } else {
          const dim = await this._probeEmbedDimension();
          if (dim > 0 && typeof mod.createAssociationMatrixPersisted === 'function') {
            const gmCfg: Record<string, any> = {
              associationMatrix: { enabled: true },
              warmup: {},
            };
            const lr = gmAm?.learningRate ?? lcmAm?.learningRate;
            if (typeof lr === 'number') gmCfg.associationMatrix.learningRate = lr;
            const wf = gmAm?.warmupFeedbacks ?? lcmAm?.warmupFeedbacks;
            if (typeof wf === 'number') {
              gmCfg.associationMatrix.warmupFeedbacks = wf;
              gmCfg.warmup.warmupFeedbacks = wf;
            }
            const am = await mod.createAssociationMatrixPersisted(dim, gmCfg, {
              path: lcmAm?.persistPath,
            });
            if (am) {
              this._recaller.setAssociationMatrix(am);
              this._associationMatrix = am;
              this.logger?.info?.('[graph-adapter] injected AssociationMatrix into Recaller (online learning on)', {
                dim,
                configSource: useGmProConfig && gmAm?.enabled === true ? 'graph-memory-pro' : 'lcm',
                persistedRestored: (am as any).__persistLoaded ?? false,
              });
            }
          } else {
            this.logger?.warn?.('[graph-adapter] AssociationMatrix skipped: no embed dim or API unavailable');
          }
        }
      } catch (amErr) {
        this.logger?.warn?.('[graph-adapter] AssociationMatrix inject failed (M learning degraded)', { err: String(amErr) });
        this._associationMatrix = null;
      }
    } else {
      this.logger?.debug?.('[graph-adapter] AssociationMatrix disabled (enabled !== true), M learning off');
    }

    // 配置对齐可观测提示（Phase 2 保障）
    this.logger?.debug?.('[graph-adapter] online-learning readiness', {
      sharedRecaller: this._recallerFromGmPro,
      configSource: useGmProConfig ? 'graph-memory-pro' : 'lcm',
      judgeEnabled: (gmJudge?.enabled ?? lcmJudge?.enabled ?? true) !== false,
      judgeReady: !!this._recaller.getJudgeManager?.(),
      matrixEnabled: amEnabled,
      matrixReady: !!this._recaller.getAssociationMatrix?.(),
      embedReady: !!this._embedFn,
    });
  }

  /** 探测嵌入维度（优先用 config.embeddingDimensions，否则对 embedFn 调用一次） */
  private async _probeEmbedDimension(): Promise<number> {
    if (typeof this.config.embeddingDimensions === 'number' && this.config.embeddingDimensions > 0) {
      return this.config.embeddingDimensions;
    }
    if (!this._embedFn) return 0;
    try {
      const vec = await Promise.race([
        this._embedFn('graph-memory-pro dimension probe'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      return Array.isArray(vec) ? vec.length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * P1-10 GMR-1: 检查连接失败冷却期是否已过。如果冷却期满，自动重置失败标记，允许重试。
   * 返回 true 表示当前处于"失败锁定"状态（调用方应跳过），false 表示可以尝试 connect。
   */
  private _checkCooldownAndMaybeReset(): boolean {
    if (!this._connectFailed) return false;
    const elapsed = Date.now() - this._lastFailTime;
    if (elapsed >= this.reconnectCooldownMs) {
      this.logger?.info?.(`[graph-adapter] reconnect cooldown elapsed (${elapsed}ms), resetting failure flag for retry`);
      this._connectFailed = false;
      this._connectRetryCount = 0;
      this._lastFailTime = 0;
      return false;
    }
    return true; // 仍在冷却期，跳过
  }

  private _isConnectionError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lowerMsg = msg.toLowerCase();
    // 先排除已知的非连接错误（语法错误、未知函数、类型错误等），
    // 这些错误重试也不会成功，恢复连接无意义。
    if (lowerMsg.includes('unknown function')
      || lowerMsg.includes('syntax')
      || lowerMsg.includes('variable `')
      || lowerMsg.includes('type mismatch')
      || lowerMsg.includes('cannot be cast')
      || lowerMsg.includes('is not defined')) {
      return false;
    }
    return lowerMsg.includes('pool is closed')
      || lowerMsg.includes('connection closed')
      || lowerMsg.includes('connection refused')
      || lowerMsg.includes('connection reset')
      || lowerMsg.includes('connection timeout')
      || lowerMsg.includes('failed to connect')
      || lowerMsg.includes('session closed')
      || lowerMsg.includes('service is not available');
  }

  /**
   * v2.5.2: 验证 driver 底层连接池是否真正就绪。
   *
   * 竞态修复：connect() 拿到 driver 引用时（尤其是 gm-pro getDriver() 在冷启动阶段
   * 返回的引用），Neo4j 连接池可能仍在建立。driver 对象存在 ≠ 连接可用。
   * 这里强制 verifyConnectivity()，失败则尝试刷新 driver 引用（gm-pro 可能在
   * 后台建立连接池，重新 getDriver() 可能拿到就绪的引用）并短暂等待后重试。
   *
   * @returns 连接验证是否通过
   */
  private async _verifyDriverReady(maxAttempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.driver) {
        try {
          await this.driver.verifyConnectivity();
          return true;
        } catch (err) {
          this.logger?.debug?.(
            `[graph-adapter] verifyDriverReady attempt ${attempt}/${maxAttempts} failed`,
            { err: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      // 刷新 driver 引用：gm-pro 连接池可能仍在冷启动，重新 getDriver() 可能拿到就绪引用。
      // 若当前 driver 来自 acquireDriver 且验证失败，先 releaseDriver 避免 refCount 失衡。
      if (this._driverFromGmPro) {
        if (this.mod && typeof this.mod.getDriver === 'function') {
          try {
            const fresh = this.mod.getDriver();
            if (fresh && fresh !== this.driver) {
              this.driver = fresh;
              this.logger?.info?.('[graph-adapter] verifyDriverReady: re-acquired driver from graph-memory-pro');
            }
          } catch { /* ignore */ }
        }
      } else if (this.driver) {
        try {
          await releaseDriver(this.neo4jConfig);
        } catch { /* ignore */ }
        this.driver = null;
        try {
          this.driver = await acquireDriver(this.neo4jConfig);
        } catch (acquireErr) {
          this.logger?.debug?.('[graph-adapter] verifyDriverReady: re-acquire own driver failed', { err: String(acquireErr) });
        }
      }

      // 给连接池冷启动留出短暂时间后重试
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return false;
  }

  private async _tryRecoverConnection(context: string): Promise<boolean> {
    if (this._poolRecoveryInProgress) {
      this.logger?.debug?.(`[graph-adapter] pool recovery already in progress, skipping (${context})`);
      return false;
    }
    this._poolRecoveryInProgress = true;
    try {
      this.logger?.warn?.(`[graph-adapter] connection error detected (${context}), initiating recovery`);

      if (this.driver) {
        // 方案 A (2026-08-09): gm-pro driver 由 gm-pro 独占管理，
        // 只清引用、绝不开 close()，避免误杀 gm-pro 运行中的 driver（无自愈）。
        // 后续重新 getDriver() 拿到新引用即可。
        if (!this._driverFromGmPro) {
          try {
            await releaseDriver(this.neo4jConfig);
          } catch { /* ignore */ }
        } else {
          this.logger?.info?.('[graph-adapter] recovery: dropping gm-pro driver reference without close (owned by gm-pro)');
        }
        this.driver = null;
      }
      this._driverFromGmPro = false;
      this._recaller = null;
      this._embedFn = null;
      this.searchCache = new LRUCache(this.config.searchCacheSize ?? DEFAULTS.graph.searchCacheSize, DEFAULTS.graph.searchCacheTtlMs);

      if (this.mod && typeof this.mod.getDriver === 'function') {
        try {
          const gmDriver = this.mod.getDriver();
          if (gmDriver) {
            this.driver = gmDriver;
            this.logger?.info?.('[graph-adapter] recovery: re-acquired driver from graph-memory-pro');
            try {
              await this._ensureRecaller();
            } catch { /* non-fatal */ }
            this._connectRetryCount = 0;
            this._connectFailed = false;
            this._lastFailTime = 0;
            this._lastError = null;
            return true;
          }
        } catch (gmErr) {
          this.logger?.debug?.('[graph-adapter] recovery: gm-pro getDriver failed, falling back to own driver', { err: String(gmErr) });
        }
      }

      const reconnected = await this.connect();
      if (reconnected) {
        this.logger?.info?.('[graph-adapter] recovery: reconnected successfully');
      } else {
        this.logger?.warn?.('[graph-adapter] recovery: reconnect failed');
      }
      return reconnected;
    } catch (recoveryErr) {
      this._lastError = `recovery failed: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`;
      this.logger?.warn?.(`[graph-adapter] recovery error: ${this._lastError}`);
      return false;
    } finally {
      this._poolRecoveryInProgress = false;
    }
  }

  /**
   * v2.3.1: 带会话级重试的 session 操作包装器。
   *
   * 修复前：各个方法直接 `this.driver.session()` 后执行操作，若 driver 因
   * maxConnectionLifetime 到期导致 session 已关闭，操作直接失败且无重试。
   *
   * 修复后：先尝试执行操作，若失败且为连接错误，则触发连接恢复 + 新建 session 重试一次。
   * 这解决了"session closed"错误在 driver verifyConnectivity() 通过但 session 已失效的
   * 边界情况（连接在 verify 和 session 创建之间过期）。
   */
  private async _withSession<T>(
    context: string,
    fn: (session: any) => Promise<T>,
  ): Promise<T> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }
    let session: any = null;
    try {
      session = this.driver.session();
      return await fn(session);
    } catch (err) {
      // 仅对连接类错误触发恢复+重试，非连接错误直接抛出
      if (this._isConnectionError(err)) {
        if (session) {
          try { await session.close(); } catch {}
          session = null;
        }
        const recovered = await this._tryRecoverConnection(`session:${context}`);
        if (recovered && this.driver) {
          this.logger?.info?.(`[graph-adapter] session:${context}: retrying after connection recovery`);
          session = this.driver.session();
          try {
            return await fn(session);
          } catch (retryErr) {
            this.logger?.warn?.(`[graph-adapter] session:${context}: retry after recovery failed`, { err: String(retryErr) });
            throw retryErr;
          } finally {
            try { await session.close(); } catch {}
          }
        }
      }
      throw err;
    } finally {
      if (session) {
        try { await session.close(); } catch {}
      }
    }
  }

  async search(query: string, limit?: number): Promise<RetrievalResult[]> {
    if (!this.config.enabled) return [];
    if (!this.mod) {
      if (this._checkCooldownAndMaybeReset()) {
        this.logger?.warn?.(`[lcm-graph-extra] search: in reconnect cooldown, skipping`);
        return [];
      }
      await this.connect();
    }
    if (!this.mod || !this.driver) return [];
    const mod = this.mod;
    const driver = this.driver;
    const rl = limit ?? this.config.searchLimit;
    try {
      return await this._doSearch(mod, driver, query, rl);
    } catch (err) {
      if (this._isConnectionError(err)) {
        const recovered = await this._tryRecoverConnection('search');
        if (recovered && this.mod && this.driver) {
          try {
            this.logger?.info?.('[graph-adapter] search: retrying after connection recovery');
            return await this._doSearch(this.mod, this.driver, query, rl);
          } catch (retryErr) {
            this.logger?.error?.('[graph-adapter] search: retry after recovery failed — L3 graph recall completely broken', { query: query.slice(0, 100), err: String(retryErr) });
          }
        }
      }
      // P2-FIX: 从 warn 升级为 error —— 返回空数组意味着 L3 图谱召回完全失效，
      // 生产日志中必须可见（原 warn 级易被过滤或忽略）。
      this.logger?.error?.(`[lcm-graph-extra] search error (L3 graph recall returning empty): ${err}`, { query: query.slice(0, 100) });
      return [];
    }
  }

  private async _doSearch(mod: any, driver: any, query: string, rl: number): Promise<RetrievalResult[]> {
    let nodes: any[] = [];
    let recallFailed = false;

    if (this._recaller) {
      try {
        const recallResult = await this._recaller.recall(query);
        nodes = recallResult.nodes ?? [];
        this.logger?.debug?.('[graph-adapter] Recaller returned', { nodeCount: nodes.length });
      } catch (recallErr) {
        recallFailed = true;
        this.logger?.warn?.('[graph-adapter] Recaller.recall failed, falling back to searchNodes', { err: recallErr });
      }
    }

    if (nodes.length === 0) {
      nodes = await mod.searchNodes(driver, query, rl);
      // P2-FIX: recall 失败 + fallback 也返回 0 节点 → L3 图谱召回完全失效，
      // 升级为 error 级确保生产日志可见（原仅 recall 失败时 warn，fallback 空 results 无日志）。
      if (recallFailed && nodes.length === 0) {
        this.logger?.error?.('[graph-adapter] L3 graph recall completely empty: Recaller.recall failed AND searchNodes fallback returned 0 nodes', { query: query.slice(0, 100) });
      }
    }
    let reranked = (nodes ?? []).filter((n: any) => {
      const st = n?.state ?? n?.properties?.state;
      return st !== 'superseded';
    });
    if (reranked.length >= 2) {
      const nodeIds = reranked.map((n: any) => n.id).filter(Boolean);
      if (nodeIds.length >= 2) {
        const pprScores = await this.rerankByPageRank(nodeIds);
        if (pprScores.size > 0) {
          reranked.sort((a: any, b: any) => {
            const sa = pprScores.get(a.id) ?? 0.5;
            const sb = pprScores.get(b.id) ?? 0.5;
            return sb - sa;
          });
        }
      }
    }
    return (reranked).map((n: any) => {
      const name = n.name ?? n.properties?.name ?? '';
      const label = n.type ?? n.labels?.[0] ?? 'TASK';
      const desc = n.description ?? n.properties?.description ?? '';
      const content = n.content ?? n.properties?.content ?? '';
      const ppr = n.pagerank ?? n.properties?.pagerank ?? 0.5;
      return {
        id: createHash('sha256').update(`g:${n.id ?? name}`).digest('hex').slice(0, 16),
        content: `[${label}] ${name}${desc ? '\n' + desc : ''}${content ? '\n' + String(content).slice(0, 500) : ''}`,
        source: 'graph' as RetrievalSource,
        type: inferType(label),
        score: (n.score ?? Number(ppr)) as number,
        metadata: { nodeId: n.id, nodeType: label, name, updatedAt: n.updatedAt ?? n.properties?.updatedAt ?? 0 },
      };
    });
  }

  // P1-9: searchWithCache 是 L3 图检索的正式入口（index.ts 唯一调用点），
  // 承载 LRU 缓存 + community enrichment 双重职责，去除误标的 @deprecated。
  async searchWithCache(query: string, limit?: number): Promise<RetrievalResult[]> {
    // SEC-L: 修复前 key 仅截断前 200 字符，超长查询（>200）会碰撞。
    // 加 full-hash 后缀区分，前缀保留便于调试。
    const fullHash = hashString(query.toLowerCase().trim());
    const key = `s:${query.slice(0, 50).toLowerCase().trim()}:${fullHash}`;
    const cached = this.searchCache.get(key);
    if (cached) {
      // v1.2.0-3: 记录 TTL 命中
      businessMetrics.recordTtlAccess(true);
      return cached as RetrievalResult[];
    }
    // v1.2.0-3: 记录 TTL 未命中
    businessMetrics.recordTtlAccess(false);
    let results = await this.search(query, limit);
    if (!Array.isArray(results)) results = [];
    // PERF-M2 M-2: 移除重复 rerank。search() 内部已在 nodes.length >= 2 时执行过 rerankByPageRank，
    // 此处重复调用纯属浪费。search() 未 rerank 的唯一情况是 nodes.length < 2，
    // 此时原 length >= 2 守卫也会跳过，故可安全移除。
    // Community enrichment — batch findById via raw Cypher (avoids N round-trips)
    const nodeIds = results.map(r => r.metadata?.nodeId).filter(Boolean);
    if (nodeIds.length > 0) {
      if (!this.driver) return results;
      try {
        await this._withSession('community-enrichment', async (session) => {
          const batchResult = await session.run(
            `MATCH (n:Task|Skill|Event) WHERE n.id IN $ids RETURN n.id AS id, n.communityId AS communityId`,
            { ids: nodeIds },
          );
          const communityMap = new Map<string, string>();
          for (const record of batchResult.records) {
            const idField = record.get('id');
            const cid = record.get('communityId');
            if (idField && cid) communityMap.set((idField as any).toString(), (cid as any).toString());
          }
          // Apply community info to results
          for (const r of results) {
            const nid = String(r.metadata?.nodeId ?? '');
            if (nid && communityMap.has(nid)) {
              if (r.metadata) { r.metadata.communityId = communityMap.get(nid)!; }
            }
          }
        });
      } catch (err) {
        this.logger?.warn?.('[graph-adapter] community enrichment failed', { err: String(err) });
      }
    }
    this.searchCache.set(key, results);
    return results;
  }

  async searchExperience(
    query: string,
    options?: { context?: any; limit?: number },
  ): Promise<RetrievalResult[]> {
    if (!this.config.enabled) return [];
    if (!this.mod) {
      if (this._checkCooldownAndMaybeReset()) {
        this.logger?.warn(`[lcm-graph-extra] searchExperience: in reconnect cooldown, skipping`);
        return [];
      }
      await this.connect();
    }
    if (!this.mod) return [];
    if (!this.driver) return [];
    const mod = this.mod;
    const rl = options?.limit ?? this.config.searchLimit;
    const ctx = options?.context;
    try {
      return await this._doSearchExperience(mod, query, rl, ctx);
    } catch (err) {
      if (this._isConnectionError(err)) {
        const recovered = await this._tryRecoverConnection('searchExperience');
        if (recovered && this.mod && this.driver) {
          try {
            this.logger?.info?.('[graph-adapter] searchExperience: retrying after connection recovery');
            return await this._doSearchExperience(this.mod, query, rl, ctx);
          } catch (retryErr) {
            this.logger?.warn?.('[graph-adapter] searchExperience: retry after recovery failed', { err: String(retryErr) });
          }
        }
      }
      return [];
    }
  }

  private async _doSearchExperience(mod: any, query: string, rl: number, ctx: any): Promise<RetrievalResult[]> {
    const nodes = await mod.searchNodes(this.driver, query, rl * 3);
    const events = (nodes ?? []).filter((n: any) => {
      if ((n.type ?? n.labels?.[0]) !== 'EVENT') return false;
      const st = n?.state ?? n?.properties?.state;
      return st !== 'superseded';
    });

    const ranked = events.map((evt: any) => {
      let scenarioBonus = 0;
      let techBonus = 0;
      const evtTags = evt.properties?.tags ?? {};

      if (ctx?.scenario) {
        for (const s of ctx.scenario) {
          if ((evtTags.scenario ?? []).includes(s)) scenarioBonus += 0.15;
        }
      }
      if (ctx?.techStack) {
        for (const t of ctx.techStack) {
          if ((evtTags.techStack ?? []).includes(t)) techBonus += 0.1;
        }
      }
      const urgencyBoost = (evtTags.severity === 'critical' && ctx?.urgency > 0.5) ? 0.2 : 0;

      return { ...evt, boostedScore: (Number(evt.properties?.pagerank ?? 0.5)) + scenarioBonus + techBonus + urgencyBoost };
    }).sort((a: any, b: any) => b.boostedScore - a.boostedScore);

    const topEvents = ranked.slice(0, rl);
    const topIds = topEvents.map((evt: any) => evt.id).filter(Boolean);
    let rawEdges: any[] = [];
    if (topIds.length > 0) {
      if (typeof mod.getEdgesForNodes === 'function') {
        rawEdges = await mod.getEdgesForNodes(this.driver, topIds);
      } else {
        try {
          rawEdges = await this._withSession('searchExperience-edges', async (session) => {
            const placeholders = topIds.map((_: string, i: number) => `$id${i}`).join(',');
            const params: Record<string, any> = {};
            topIds.forEach((id: string, i: number) => { params[`id${i}`] = id; });
            const result = await session.run(
              `MATCH (a)-[r]->(b) WHERE a.id IN [${placeholders}] OR b.id IN [${placeholders}]
                 RETURN a.id AS fromId, b.id AS toId, type(r) AS type,
                        coalesce(r.instruction, '') AS instruction,
                        coalesce(r.name, '') AS targetName`,
              params,
            );
            return result.records.map((rec: any) => ({
              fromId: rec.get('fromId'),
              toId: rec.get('toId'),
              type: rec.get('type'),
              instruction: rec.get('instruction'),
              targetName: rec.get('targetName'),
            }));
          });
        } catch (err) {
          rawEdges = [];
          this.logger?.warn?.('[graph-adapter] edges batch query failed', { err: String(err) });
        }
      }
    }
    const allEdges: any[] = rawEdges ?? [];
    const edgesBySource = new Map<string, any[]>();
    for (const e of allEdges) {
      const srcId = e.fromId ?? e.sourceId ?? e.from ?? e.source;
      if (!srcId) continue;
      const list = edgesBySource.get(srcId) ?? [];
      list.push(e);
      edgesBySource.set(srcId, list);
    }

    const out: RetrievalResult[] = [];
    for (const evt of topEvents) {
      const name = evt.name ?? evt.properties?.name ?? '';
      const desc = evt.description ?? evt.properties?.description ?? '';
      const edges = edgesBySource.get(evt.id) ?? [];
      const sols = edges.filter((e: any) => (e.type ?? e.label) === 'SOLVED_BY');
      let expText = `[EVENT] ${name}\n${desc}${sols.length > 0 ? '\nSolutions:' : ''}`;
      for (const s of sols) expText += `\n- ${s.targetName ?? 'Unknown'}`;
      out.push({
        id: createHash('sha256').update(`exp:${evt.id ?? name}`).digest('hex').slice(0, 16),
        content: expText, source: 'graph' as RetrievalSource,
        type: 'definition' as RetrievalType,
        score: Math.min(0.8 + (ranked.indexOf(evt) < rl / 2 ? 0.15 : 0.05), 1),
        metadata: { experience: true, problemName: name, solutionCount: sols.length, updatedAt: evt.updatedAt ?? evt.properties?.updatedAt ?? 0 },
      });
    }
    return out;
  }


  /**
   * Batch upsert: single Cypher UNWIND + MERGE for nodes and edges.
   * Reduces N round-trips to O(1).
   */
  async batchUpsert(
    entities: Array<{ name: string; type: string; description: string; content: string; updatedAt?: number }>,
    relations: Array<{ from: string; to: string; type: string; instruction?: string; updatedAt?: number }>,
  ): Promise<{ upserted: number; conflicts: number }> {
    if (!this.driver) return { upserted: 0, conflicts: 0 };

    const validEntities = entities.filter((e) => e.name?.trim());
    const validRelations = relations.filter((r) => r.from?.trim() && r.to?.trim());

    if (validEntities.length === 0 && validRelations.length === 0) {
      return { upserted: 0, conflicts: 0 };
    }

    try {
      return await this._withSession('batchUpsert', async (session) => {
        let uc = 0;
        let cc = 0;
      // N-1: Sync 算法升级 —— updatedAt 对比 + 增量 MERGE
      // 输入实体可选携带 updatedAt（毫秒时间戳）：
      //   - 若存在且大于现有节点：更新属性并刷新 updatedAt
      //   - 若存在但小于等于现有节点：跳过（保留更新，避免旧数据覆盖新数据）
      //   - 若不存在或节点不存在：插入并设置 createdAt + updatedAt
      // 未携带 updatedAt 时默认 Date.now()（等价于原全量覆盖语义）。
      if (validEntities.length > 0) {
        const now = Date.now();
        const nodeData: Array<{
          id: string; label: string; name: string; description: string; content: string;
          status: string; pagerank: number; updatedAt: number; embedding: number[] | null;
        }> = validEntities.map((e) => {
          const t = mapEntityType(e.type);
          const nid = makeNodeId(e.name, t);
          const ts = typeof e.updatedAt === 'number' && e.updatedAt > 0 ? e.updatedAt : now;
          return {
            id: nid,
            label: t,
            name: e.name.trim(),
            description: (e.description ?? '').slice(0, 500),
            content: (e.content ?? '').slice(0, 2000),
            status: 'active',
            pagerank: 0.5,
            updatedAt: ts,
            embedding: null,
          };
        });

        // 原生 VECTOR 写入（可选增强）：当 embedFn 可用时，为每个实体生成 embedding，
        // 以原生 VECTOR 类型写入 n.embedding（配合 entity_embedding_idx 向量索引）。
        // 记语：embedding 有 HTTP 往返，用受限并发批量生成；任一失败仅降级（该实体无向量），
        // 不阻塞 upsert 主体。embedFn 未配置时整体跳过，保持原行为。
        const embedFn = this._embedFn;
        const embedDim = await this._probeEmbedDimension();
        if (embedFn && embedDim > 0) {
          const CONCURRENCY = 8;
          let idx = 0;
          const worker = async () => {
            while (idx < nodeData.length) {
              const cur = idx++;
              const text = `${nodeData[cur].name} ${nodeData[cur].description}`.trim();
              if (!text) continue;
              try {
                const vec = await embedFn(text);
                if (Array.isArray(vec) && vec.length === embedDim) {
                  nodeData[cur].embedding = vec;
                }
              } catch (e) {
                this.logger?.debug?.('[graph-adapter] embedding gen failed for entity', { name: nodeData[cur].name, err: e instanceof Error ? e.message : String(e) });
              }
            }
          };
          await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
        }

        // P1-2 M-1: 节点存在性检查改为单条 UNWIND（原 per-node N 次 MATCH 查询）
        const existingResult = await session.run(
          `UNWIND $nodes AS node MATCH (n { id: node.id }) RETURN collect(node.id) AS existingIds`,
          { nodes: nodeData.map(({ embedding, ...rest }) => rest) },
        );
        cc += (existingResult.records[0]?.get('existingIds') ?? []).length;

        // N-1: 增量 MERGE —— 按 label 分组 UNWIND MERGE，实现 updatedAt 对比
        // 仅在节点不存在 OR 节点存在但 incoming updatedAt > existing updatedAt 时才更新属性。
        // 这样重放旧数据不会覆盖新数据，支持增量同步。
        //
        // 实现方式：按 label 分组，每组一条 UNWIND MERGE（关系类型不可参数化的同构问题）
        const nodesByLabel = new Map<string, typeof nodeData>();
        for (const n of nodeData) {
          const arr = nodesByLabel.get(n.label) || [];
          arr.push(n);
          nodesByLabel.set(n.label, arr);
        }

        for (const [label, nodes] of nodesByLabel) {
          // 原生 VECTOR 写入：embedding 非空时用 vector(node.embedding, $dim, FLOAT) 写入。
          // vector() 维度参数必须是字面量（不支持参数绑定），故内联 embedDim。
          const embedDimLocal = embedDim;
          const embedSetOnCreate = embedDimLocal > 0
            ? `, n.embedding = CASE WHEN node.embedding IS NOT NULL THEN vector(node.embedding, ${embedDimLocal}, FLOAT) END`
            : '';
          const embedSetOnMatch = embedDimLocal > 0
            ? `, n.embedding = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) AND node.embedding IS NOT NULL THEN vector(node.embedding, ${embedDimLocal}, FLOAT) ELSE n.embedding END`
            : '';
          const cypher = `
            UNWIND $nodes AS node
            MERGE (n:\`${label}\` { id: node.id })
            ON CREATE SET
              n.name = node.name,
              n.description = node.description,
              n.content = node.content,
              n.status = node.status,
              n.pagerank = node.pagerank,
              n.updatedAt = node.updatedAt,
              n.createdAt = node.updatedAt${embedSetOnCreate}
            ON MATCH SET
              n.name = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.name ELSE n.name END,
              n.description = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.description ELSE n.description END,
              n.content = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.content ELSE n.content END,
              n.status = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.status ELSE n.status END,
              n.pagerank = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.pagerank ELSE n.pagerank END,
              n.updatedAt = CASE WHEN node.updatedAt > coalesce(n.updatedAt, 0) THEN node.updatedAt ELSE n.updatedAt END${embedSetOnMatch}
            RETURN count(*) AS cnt
          `;
          const result = await session.run(cypher, { nodes });
          // BUGFIX: neo4j-driver 6.x Integer 的 valueOf() 返回 BigInt，
          // `number += Integer` 会抛 "Cannot mix BigInt and other types"。
          // 必须显式调用 toNumber() 转为原生 number。
          const cntVal = result.records[0]?.get('cnt');
          uc += (typeof cntVal?.toNumber === 'function' ? cntVal.toNumber() : Number(cntVal)) || 0;
        }
      }

      // P1-2 M-1: 边 upsert 改为按 type 分组的 UNWIND MERGE
      // （Cypher 关系类型不可参数化，故按 mapEdgeType 结果分组后逐组单条 UNWIND MERGE）
      // N-1: 边也支持增量 updatedAt 对比
      if (validRelations.length > 0) {
        const now = Date.now();
        const edgesByType = new Map<string, any[]>();
        for (const rel of validRelations) {
          const mt = mapEdgeType(rel.type);
          const ts = typeof rel.updatedAt === 'number' && rel.updatedAt > 0 ? rel.updatedAt : now;
          const entry = {
            fromId: makeNodeId(rel.from, 'TASK'),
            toId: makeNodeId(rel.to, 'TASK'),
            instruction: (rel.instruction ?? '').slice(0, 500),
            weight: 1.0,
            updatedAt: ts,
          };
          const list = edgesByType.get(mt) ?? [];
          list.push(entry);
          edgesByType.set(mt, list);
        }
        for (const [mt, group] of edgesByType) {
          await session.run(
            `UNWIND $edges AS edge MATCH (a { id: edge.fromId }), (b { id: edge.toId }) MERGE (a)-[r:${mt}]->(b) ON CREATE SET r.instruction = edge.instruction, r.weight = edge.weight, r.updatedAt = edge.updatedAt, r.createdAt = edge.updatedAt ON MATCH SET r.instruction = CASE WHEN edge.updatedAt > coalesce(r.updatedAt, 0) THEN edge.instruction ELSE r.instruction END, r.weight = CASE WHEN edge.updatedAt > coalesce(r.updatedAt, 0) THEN edge.weight ELSE r.weight END, r.updatedAt = CASE WHEN edge.updatedAt > coalesce(r.updatedAt, 0) THEN edge.updatedAt ELSE r.updatedAt END`,
            { edges: group },
          );
        }
      }

      // P2-AUDIT: 关系计数不再混入 uc（upserted 节点数），
      // 避免调用方收到虚高的节点数。关系仍正常 upsert。
      // uc += validRelations.length;
        return { upserted: uc, conflicts: cc };
      });
    } catch (err) {
      this.logger?.warn?.(`[lcm-graph-extra] batchUpsert error: ${err}`);
      return { upserted: 0, conflicts: 0 };
    }
  }

  // P1-10: upsertEntities 已移除 —— per-entity N+1 死代码（零调用方），
  // 生产路径走 batchUpsert（由 extractAndUpsertFromTurn 调用）。

  // P3-9 GMR-4: processFeedback 已移除 —— 空实现（恒返回 0）且无任何生产代码调用，属死代码。
  
  /**
   * Run raw Cypher query (for experience storage layer).
   *
   * BUGFIX: 原代码 `if (!this.driver) return []` 静默返回空数组，
   * 导致 ExperienceStorage.saveRaw / fetchPending 等写入/查询操作
   * 在 Neo4j 未连接时"成功"返回但实际无任何数据持久化。
   * 这造成 afterTurn 写入的 PENDING 经验全部丢失，distill 时 pending=0。
   *
   * 现在：driver 为 null 时抛出明确错误，让上层（ExperienceStorage）
   * 能捕获并记录日志，而非静默成功。
   */
  async query<T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized — graphAdapter is not connected. ' +
        'Call connect() first or check Neo4j availability.');
    }
    try {
      return await this._doQuery(cypher, params);
    } catch (err) {
      if (this._isConnectionError(err)) {
        const recovered = await this._tryRecoverConnection('query');
        if (recovered && this.driver) {
          try {
            this.logger?.info?.('[graph-adapter] query: retrying after connection recovery');
            return await this._doQuery(cypher, params);
          } catch (retryErr) {
            this.logger?.warn?.('[graph-adapter] query: retry after recovery failed', { err: String(retryErr) });
            throw retryErr;
          }
        }
      }
      throw err;
    }
  }

  private async _doQuery(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return this._withSession('query', async (session) => {
      const safeParams = params ? sanitizeNeo4jParams(params) : {};
      const result = await session.run(cypher, safeParams);
      return result.records.map((r: any) => convertNeo4jIntegers(r.toObject()) as Record<string, unknown>);
    });
  }


  /**
   * PageRank re-ranking
   *
   * 优先使用 gm-pro 的 personalizedPageRank，失败时回退到本地 Cypher 实现
   * （gm-pro 内部可能因 session 管理问题报 "closed session" 错误）。
   */
  async rerankByPageRank(nodeIds: string[]): Promise<Map<string, number>> {
    if (!this.driver || nodeIds.length < 2) return new Map();

    // 优先尝试 gm-pro PPR
    if (this.mod?.personalizedPageRank) {
      try {
        const cfg = buildGmConfig(this.neo4jConfig);
        const result = await this.mod.personalizedPageRank(this.driver, nodeIds, nodeIds, cfg);
        if (result?.scores && result.scores.size > 0) {
          return result.scores;
        }
      } catch (err) {
        this.logger?.warn?.('[lcm-graph-extra] gm-pro PPR failed, falling back to Cypher PageRank', { err: String(err) });
      }
    }

    // Fallback: 本地 Cypher 实现 — 用 gds.pageRank.stream 或简单关系遍历
    try {
      return await this.fallbackPageRank(nodeIds);
    } catch (fallbackErr) {
      this.logger?.warn?.('[lcm-graph-extra] PPR rerank failed (both gm-pro and fallback)', { err: String(fallbackErr) });
      return new Map();
    }
  }

  /**
   * Fallback PageRank 实现：用 Cypher 投影 + gds.pageRank.stream（如果可用），
   * 不可用时退化为简单的 degree-based 排序。
   */
  private async fallbackPageRank(nodeIds: string[]): Promise<Map<string, number>> {
    if (!this.driver) return new Map();
    return this._withSession('fallbackPageRank', async (session) => {
      // 尝试 GDS PageRank（如果 Neo4j 安装了 GDS 插件）
      const gdsResult = await session.run(
        `
        MATCH (n)
        WHERE n.id IN $ids
        WITH collect(n) AS nodes
        CALL gds.pageRank.stream({
          nodeProjection: nodes,
          relationshipProjection: { REL: { type: '*', orientation: 'NATURAL' } },
          dampingFactor: 0.85,
          maxIterations: 20
        })
        YIELD nodeId, score
        WITH gds.util.asNode(nodeId) AS n, score
        WHERE n.id IN $ids
        RETURN n.id AS id, score
        `,
        { ids: nodeIds },
      ).catch(() => null);

      if (gdsResult && gdsResult.records.length > 0) {
        const scores = new Map<string, number>();
        for (const rec of gdsResult.records) {
          scores.set(rec.get('id'), rec.get('score'));
        }
        return scores;
      }

      // 无 GDS 时退化：用 degree（关系数）作为权重
      const degreeResult = await session.run(
        `
        MATCH (n)-[r]-(m)
        WHERE n.id IN $ids AND m.id IN $ids
        RETURN n.id AS id, count(r) AS degree
        `,
        { ids: nodeIds },
      );
      const scores = new Map<string, number>();
      let maxDegree = 1;
      for (const rec of degreeResult.records) {
        const d = rec.get('degree').toNumber ? rec.get('degree').toNumber() : Number(rec.get('degree'));
        if (d > maxDegree) maxDegree = d;
      }
      for (const rec of degreeResult.records) {
        const d = rec.get('degree').toNumber ? rec.get('degree').toNumber() : Number(rec.get('degree'));
        scores.set(rec.get('id'), d / maxDegree);
      }
      // 没出现在结果中的节点给默认分
      for (const id of nodeIds) {
        if (!scores.has(id)) scores.set(id, 0.1);
      }
      return scores;
    });
  }

  /**
   * Extract triplets from a conversation turn and upsert to Neo4j graph.
   */
  async extractAndUpsertFromTurn(
    llmConfig: { apiKey?: string; baseURL?: string; model?: string; keepAlive?: string; complete?: (p: { messages: any[]; model?: string; maxTokens?: number; temperature?: number; systemPrompt?: string; signal?: AbortSignal; purpose?: string }) => Promise<{ text: string; provider?: string; model?: string }> },
    userContent: string,
    assistantContent: string,
  ): Promise<{ nodes: number; edges: number }> {
    if (!this.mod) return { nodes: 0, edges: 0 };
    try {
      const { extractTriplets } = this.mod as any;
      if (!extractTriplets) return { nodes: 0, edges: 0 };
      const llmFn = this.buildLlmFn(llmConfig);
      if (!llmFn) return { nodes: 0, edges: 0 };
      const result = await extractTriplets(llmFn, userContent, assistantContent);
      if (!result || (!result.nodes?.length && !result.edges?.length)) return { nodes: 0, edges: 0 };
      const entities = (result.nodes ?? []).map((n: any) => ({ name: n.name ?? '', type: n.type ?? 'TASK', description: n.description ?? '', content: n.content ?? '' })).filter((e: any) => e.name?.trim());
      const relations = (result.edges ?? []).map((e: any) => ({ from: e.from ?? e.source ?? '', to: e.to ?? e.target ?? '', type: e.type ?? 'RELATED_TO', instruction: e.instruction ?? e.description ?? '' })).filter((r: any) => r.from?.trim() && r.to?.trim());
      if (entities.length > 0 || relations.length > 0) await this.batchUpsert(entities, relations);
      return { nodes: entities.length, edges: relations.length };
    } catch (err) {
      this.logger?.error?.('[lcm-graph-extra] extractAndUpsertFromTurn error', { err });
      return { nodes: 0, edges: 0 };
    }
  }

  private buildLlmFn(config?: { apiKey?: string; baseURL?: string; model?: string; keepAlive?: string; complete?: (p: { messages: any[]; model?: string; maxTokens?: number; temperature?: number; systemPrompt?: string; signal?: AbortSignal; purpose?: string }) => Promise<{ text: string; provider?: string; model?: string }> }): ((system: string, user: string) => Promise<string>) | null {
    // 优先用 SDK 提供的 runtimeContext.llm.complete（已认证、已配置、跟随主会话模型）
    // 包装成 extractTriplets 期望的 (system, user) => Promise<string> 签名
    if (config?.complete && typeof config.complete === 'function') {
      return async (system, user) => {
        const result = await config.complete!({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          maxTokens: 1024,
          temperature: 0.3,
          purpose: 'lcm-graph-extra:triplet-extraction',
        });
        return result?.text ?? '';
      };
    }
    if (!config?.model && !config?.apiKey) return null;
    // 清洗 baseURL：去掉反引号/引号/首尾空格/尾斜杠
    const baseUrl = cleanBaseURL(config.baseURL || 'https://api.openai.com/v1');
    const model = config.model || 'gpt-4o-mini';
    const keepAlive = config.keepAlive;
    return async (system, user) => {
      const result = await callLlm({
        baseURL: baseUrl,
        apiKey: config.apiKey,
        model,
        system,
        prompt: user,
        temperature: 0.3,
        maxTokens: 1024,
        keepAlive,
        signal: AbortSignal.timeout(llmTimeout('graphLlmTimeoutMs')),
      });
      return result.text ?? '';
    };
  }

  /**
   * Trigger graph maintenance: deduplication, PageRank, community detection.
   * @param llm - Optional LLM function for community summarization
   */
  async runMaintenance(llm?: (system: string, user: string) => Promise<string>): Promise<any> {
    if (!this.mod || !this.driver) return null;
    try {
      // P2-17: 用 buildGmConfig 统一构建
      const cfg: Record<string, any> = buildGmConfig(this.neo4jConfig);
      this.logger?.info?.('[graph-adapter] triggering maintenance pipeline');
      const result = await this.mod.runMaintenance(this.driver, cfg, llm ?? this._llm ?? undefined, this._embedFn ?? undefined);
      this.logger?.info?.('[graph-adapter] maintenance completed', {
        durationMs: result?.durationMs,
        dedupMerged: result?.dedup?.mergedCount,
        communitiesDetected: result?.community?.communities?.size,
        communitySummaries: result?.communitySummaries,
      });
      return result;
    } catch (err) {
      this.logger?.error?.('[graph-adapter] maintenance failed', { err });
      return null;
    }
  }
/**
   * v2.7.0 P1: 轻量级健康检查 —— 仅验证 driver 连通性，不释放/重建资源。
   *
   * 与 health() 的区别：
   *   - health() 失败时会 releaseDriver + reconnect + 重建 Recaller/embedFn + 清空 searchCache，
   *     是重量级恢复操作，每次 heartbeat 都调用会导致不必要的 driver 释放与重建。
   *   - quickHealth() 仅做 verifyConnectivity()，失败时只返回 false，不触发任何资源释放。
   *     用于 heartbeat 常规检查，避免 expensive 重建。
   *
   * 使用策略：
   *   - heartbeat 常规周期：调用 quickHealth()，失败时仅记录日志
   *   - 熔断器 OPEN 或连续 quickHealth 失败：调用 health() 触发完整恢复
   */
  async quickHealth(): Promise<boolean> {
    this._healthCheckCount++;
    if (this._healthCheckInProgress) {
      // v2.7.0 P1-FIX: health() 正在执行恢复，跳过本次检查避免误增失败计数。
      // 修复前：返回 this.isConnected（若 _connectFailed=true 则为 false），
      // 导致 quickHealth 失败计数在 health() 恢复期间继续增长，可能触发重复恢复。
      this.logger?.debug?.('[graph-adapter] quickHealth skipped (health check in progress)');
      return true;
    }
    try {
      if (this.driver) {
        await this.driver.verifyConnectivity();
        return true;
      }
      // P1-FIX: driver 引用为 null 时（初始化窗口期 / health() 恢复后未完成 connect），
      // 尝试从 gm-pro 单例获取 driver，避免误报 "driver unavailable"。
      // 与 health() L1224-1255 的逻辑保持一致。
      if (this.mod && typeof this.mod.getDriver === 'function') {
        const gmDriver = this.mod.getDriver();
        if (gmDriver) {
          try {
            await gmDriver.verifyConnectivity();
            // gm-pro driver 可用，同步到 this.driver 供后续使用
            this.driver = gmDriver;
            this._connectFailed = false;
            this.logger?.info?.('[graph-adapter] quickHealth: acquired driver from graph-memory-pro (was null)');
            return true;
          } catch {
            // gm-pro driver 也不可用，返回 false 触发完整恢复
            return false;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 健康检查 —— 验证 Neo4j 连接可用性。
   *
   * 修复前：verifyConnectivity() 失败时仅返回 false，不清理过期 driver，
   * 导致后续 health() 反复对同一过期 driver 调用 verifyConnectivity()，
   * 永远无法自动恢复。
   *
   * 修复后：失败时清理过期 driver + Recaller + embedFn，然后尝试重连。
   * 重连成功则重建 Recaller/embedFn，恢复完整功能。
   *
   * v2.1.12 稳定性加固：
   * - 并发保护：同一时刻只允许一个 health() 执行，避免竞态导致
   *   connect()/releaseDriver() 交替调用引发 refCount 失衡。
   * - 重连成功后清空 searchCache：旧 driver 下的缓存结果可能已失效，
   *   不清空会导致后续 searchWithCache 命中过期数据。
   *
   * v2.7.0 P1: 新增 quickHealth() 轻量检查，health() 仅用于熔断恢复场景。
   *   调用方（heartbeat）应先用 quickHealth() 做常规检查，仅当熔断器 OPEN
   *   或连续多次 quickHealth 失败时才调用 health() 触发完整恢复。
   */
  async health(): Promise<boolean> {
    this._healthCheckCount++;
    if (this._healthCheckInProgress) {
      this.logger?.debug?.('[graph-adapter] health check already in progress, skipping concurrent call');
      return this.isConnected;
    }
    this._healthCheckInProgress = true;
    try {
      try {
        if (this.driver) {
          await this.driver.verifyConnectivity();
          return true;
        }
        if (this.mod && typeof this.mod.getDriver === 'function') {
          const gmDriver = this.mod.getDriver();
          if (gmDriver) {
            // v2.7.0 P1-FIX: 验证 gm-pro driver 连通性后再返回 true
            // 修复前：直接赋值 this.driver 并返回 true，不验证 driver 是否有效。
            // 若 gm-pro 返回过期/断开的单例 driver，health() 会虚假成功，
            // 导致 quickHealth 下一轮再次失败 → 触发不必要的重复重建。
            let gmDriverOk = false;
            try {
              await gmDriver.verifyConnectivity();
              gmDriverOk = true;
            } catch (verifyErr) {
              this.logger?.warn?.('[graph-adapter] health check: gm-pro driver verifyConnectivity failed, will drop ref and connect fresh (NOT closing gm-pro driver)', { err: verifyErr instanceof Error ? verifyErr.message : String(verifyErr) });
              // 方案 A (2026-08-09): 不 close gm-pro driver —— 它由 gm-pro 独占管理，
              // close 会误杀 gm-pro 运行中的 driver（无自愈）。只让 gmDriverOk=false，
              // 走下方 connect() 拿到 gm-pro 暴露的新引用。
            }
            if (gmDriverOk) {
              this.driver = gmDriver;
              this.logger?.info?.('[graph-adapter] health check: acquired driver from graph-memory-pro (was lazy-init)');
              this._connectRetryCount = 0;
              this._connectFailed = false;
              this._lastFailTime = 0;
              this._lastError = null;
              try {
                await this._ensureRecaller();
              } catch (recallerErr) {
                this.logger?.warn?.('[graph-adapter] health check: Recaller init failed after driver acquired', { err: recallerErr instanceof Error ? recallerErr.message : String(recallerErr) });
              }
              return true;
            }
            // gmDriver 验证失败，driver 已被关闭，继续走 connect() 新建
          }
        }
        return await this.connect();
      } catch {
        const hadExistingDriver = !!this.driver;
        if (this.driver) {
          // 方案 A (2026-08-09): gm-pro driver 由 gm-pro 独占管理，绝不开 close()。
          // 原逻辑对从 gm-pro getDriver() 拿到的共享引用直接 close()，
          // 会误杀 gm-pro 运行中的 driver（无自愈）→ 本次修复核心点。
          if (this._driverFromGmPro) {
            this.logger?.warn?.('[graph-adapter] health: dropping gm-pro driver ref without close (owned by gm-pro)');
          } else {
            try {
              await releaseDriver(this.neo4jConfig);
            } catch { /* ignore release errors */ }
            try {
              await this.driver.close();
            } catch { /* ignore close errors */ }
          }
          this.driver = null;
        }
        this._driverFromGmPro = false;
        this._recaller = null;
        this._embedFn = null;
        if (hadExistingDriver) {
          this._connectRetryCount = 0;
          this._connectFailed = false;
          this._lastFailTime = 0;
        }
        try {
          if (this.mod && typeof this.mod.getDriver === 'function') {
            const gmDriver = this.mod.getDriver();
            if (gmDriver) {
              // v2.7.0 P1-FIX: 验证 gm-pro driver 连通性后再返回 true
              // 修复前：直接赋值返回 true，不验证。若 gm-pro 返回过期单例 driver，
              // health() 虚假成功，quickHealth 下一轮再次失败 → 循环重建。
              let gmDriverOk = false;
              try {
                await gmDriver.verifyConnectivity();
                gmDriverOk = true;
              } catch (verifyErr) {
                this.logger?.warn?.('[graph-adapter] health check: gm-pro driver verifyConnectivity failed in recovery path, will drop ref and connect fresh (NOT closing gm-pro driver)', { err: verifyErr instanceof Error ? verifyErr.message : String(verifyErr) });
                // 方案 A (2026-08-09): 不 close gm-pro driver —— gm-pro 独占管理，close 会误杀。
              }
              if (gmDriverOk) {
                this.driver = gmDriver;
                this.logger?.info?.('[graph-adapter] health check: recovered via graph-memory-pro driver');
                try {
                  await this._ensureRecaller();
                } catch { /* recaller init non-fatal */ }
                this.searchCache = new LRUCache(this.config.searchCacheSize ?? DEFAULTS.graph.searchCacheSize, DEFAULTS.graph.searchCacheTtlMs);
                return true;
              }
              // gmDriver 验证失败，已被关闭，继续走 connect() 新建
            }
          }
          const reconnected = await this.connect();
          if (reconnected) {
            this.searchCache = new LRUCache(this.config.searchCacheSize ?? DEFAULTS.graph.searchCacheSize, DEFAULTS.graph.searchCacheTtlMs);
            this.logger?.info?.('[graph-adapter] health check: reconnected successfully, search cache cleared');
            this._lastError = null;
          } else if (this._lastError) {
            this.logger?.warn?.(`[graph-adapter] health check: still not connected — ${this._lastError}`);
          }
          return reconnected;
        } catch (reconnectErr) {
          this._lastError = `health check reconnect failed: ${reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)}`;
          this.logger?.warn?.(`[graph-adapter] health check: ${this._lastError}`);
          return false;
        }
      }
    } finally {
      this._healthCheckInProgress = false;
    }
  }

  async close(): Promise<void> {
    // 方案 A (2026-08-09): gm-pro driver 由 gm-pro 独占管理，
    // 本对象关停时只清引用、绝不动它（不 release / 不 close）。
    if (!this._driverFromGmPro) {
      // Release driver back to pool instead of closing directly
      try {
        await releaseDriver(this.neo4jConfig);
      } catch (relErr) {
        this.logger?.warn?.(`[graph-adapter] releaseDriver failed: ${relErr}`);
      }
    }
    this.driver = null;
    this._driverFromGmPro = false;
    this.mod = null;
    this._recaller = null;
    this._embedFn = null;
    this._connectFailed = false;
    this._connectRetryCount = 0;
    this._lastFailTime = 0;
  }

  async detectCommunities(maxIter = 50): Promise<{ labels: Map<string, string>; communities: Map<string, string[]>; count: number } | null> {
    if (!this.mod || !this.driver) return null;
    try {
      const result = await this.mod.detectCommunities(this.driver, maxIter);
      this.logger?.info?.('[graph-adapter] community detection completed', { count: result.count });
      return result;
    } catch (err) {
      this.logger?.error?.('[graph-adapter] community detection failed', { err });
      return null;
    }
  }

  async mergeNodes(keepId: string, mergeId: string): Promise<boolean> {
    if (!this.mod || !this.driver) return false;
    try {
      await this.mod.mergeNodes(this.driver, keepId, mergeId);
      this.logger?.info?.('[graph-adapter] nodes merged', { keepId, mergeId });
      return true;
    } catch (err) {
      this.logger?.error?.('[graph-adapter] merge nodes failed', { keepId, mergeId, err });
      return false;
    }
  }

  setLlm(llm: (system: string, user: string) => Promise<string>): void {
    this._llm = llm;
  }

  // ═══════════════════════════════════════════════════════════════
  // v2.3.6 反馈闭环方法（链路 2：agent_end 自动采集 → processFeedback）
  // ═══════════════════════════════════════════════════════════════

  /** JudgeManager 是否已注入（供诊断/健康检查） */
  get judgeInjected(): boolean {
    return !!this._judgeManager && !!this._recaller?.getJudgeManager?.();
  }

  /** 在线学习 M 矩阵是否已启用并在用 */
  get associationMatrixEnabled(): boolean {
    return !!this._associationMatrix?.isEnabled?.();
  }

  /**
   * 记录一次召回节点到 SessionRecallCache（链路 2 采集端）。
   * 由 afterTurn 预取 / assemble 在当前轮实际使用 L3 结果后调用。
   */
  recordRecallToSessionCache(sessionKey: string, query: string, nodeIds: string[]): void {
    if (!sessionKey || !nodeIds?.length) return;
    try {
      const cache = this.mod?.getSessionRecallCache?.();
      cache?.recordRecall?.(sessionKey, query, nodeIds);
    } catch (err) {
      this.logger?.debug?.('[graph-adapter] recordRecallToSessionCache failed (non-fatal)', { err: String(err) });
    }
  }

  /**
   * 消费该 session 的召回记录（链路 2 消费端）。
   * 返回 { query, nodeIds, getNodeIds, recallCount } 或 null。
   */
  consumeSessionRecall(sessionKey: string): { query: string; nodeIds: string[]; getNodeIds?: string[]; recallCount?: number } | null {
    if (!sessionKey) return null;
    try {
      const cache = this.mod?.getSessionRecallCache?.();
      const rec = cache?.consume?.(sessionKey);
      return rec ?? null;
    } catch (err) {
      this.logger?.debug?.('[graph-adapter] consumeSessionRecall failed (non-fatal)', { err: String(err) });
      return null;
    }
  }

  /**
   * 按 ID 加载召回节点（JudgeManager 需要 GmNode[] 做 heuristic 匹配）。
   * 与 gm-pro index.ts agent_end 的 findById 加载逻辑一致。
   */
  async loadNodesByIds(nodeIds: string[]): Promise<any[]> {
    if (!nodeIds?.length || !this.mod?.findById || !this.driver) return [];
    try {
      const nodes = await Promise.all(
        nodeIds.map((id: string) => this.mod!.findById(this.driver, id)),
      );
      return nodes.filter(Boolean);
    } catch (err) {
      this.logger?.debug?.('[graph-adapter] loadNodesByIds failed (non-fatal)', { err: String(err) });
      return [];
    }
  }

  /**
   * 完整反馈闭环（链路 2 一站式）：consume 该 session 召回 → 按 ID 加载节点 →
   * processFeedback（JudgeManager 判定 → upsertFeedback → incrementFeedback → M 更新）。
   * 由 afterTurn 在 agent_end 时机调用，全程 fire-and-forget 不阻塞会话。
   */
  async consumeAndProcessFeedback(
    sessionKey: string,
    assistantReply: string,
    sessionId?: string,
  ): Promise<void> {
    if (!sessionKey || !assistantReply?.trim()) return;
    const rec = this.consumeSessionRecall(sessionKey);
    if (!rec || rec.nodeIds.length === 0) return;
    const recalledNodes = await this.loadNodesByIds(rec.nodeIds);
    if (recalledNodes.length === 0) return;
    const query = rec.query || '';
    await this.processFeedback(query, recalledNodes, assistantReply, sessionId);
  }

  /**
   * 执行一次反馈闭环（链路 2 核心）：JudgeManager 判定 → upsertFeedback →
   * incrementFeedback → updateAssociationMatrix(M 更新)。
   * 若 Recaller 未注入 JudgeManager 则静默跳过（非致命）。
   */
  async processFeedback(
    query: string,
    recalledNodes: any[],
    assistantReply: string,
    sessionId?: string,
  ): Promise<void> {
    if (!this._recaller || typeof this._recaller.processFeedback !== 'function') return;
    try {
      await this._recaller.processFeedback(query, recalledNodes, assistantReply, sessionId);
    } catch (err) {
      this.logger?.debug?.('[graph-adapter] processFeedback failed (non-fatal)', { err: String(err) });
    }
  }

  /**
   * 持久化关联矩阵 M（链路 3）。由 dispose / 维护周期调用。
   * 未启用 M 时返回 null。
   */
  async saveAssociationMatrix(): Promise<{ path?: string; bytes?: number } | null> {
    const mod = this.mod;
    if (!mod || typeof mod.saveRecallerAssociationMatrix !== 'function') return null;
    try {
      const saved = await mod.saveRecallerAssociationMatrix(this._recaller, {
        path: this.config.associationMatrix?.persistPath,
      });
      return saved ? { path: saved.path, bytes: saved.bytes } : null;
    } catch (err) {
      this.logger?.debug?.('[graph-adapter] saveAssociationMatrix failed (non-fatal)', { err: String(err) });
      return null;
    }
  }

  getDiagnostics(): {
    healthCheckCount: number;
    gmProHasModule: boolean;
    gmProGetDriverType: string;
    gmProDriverAvailable: boolean;
    hasOwnDriver: boolean;
    connectRetryCount: number;
    lastError: string | null;
    connectFailed: boolean;
    gmProPath: string;
    gmProSource: string;
  } {
    let gmProDriverAvailable = false;
    try {
      if (this.mod && typeof this.mod.getDriver === 'function') {
        gmProDriverAvailable = !!this.mod.getDriver();
      }
    } catch { /* ignore */ }
    return {
      healthCheckCount: this._healthCheckCount,
      gmProHasModule: !!this.mod,
      gmProGetDriverType: typeof this.mod?.getDriver,
      gmProDriverAvailable,
      hasOwnDriver: !!this.driver,
      connectRetryCount: this._connectRetryCount,
      lastError: this._lastError,
      connectFailed: this._connectFailed,
      gmProPath: GM_PRO_PATH,
      gmProSource: _GM_PRO_RESOLVED.source,
    };
  }
}
