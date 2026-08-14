/**
 * extract-service.ts — 三级节点（Task/Skill/Event）重建提取服务。
 *
 * 对齐 gm-pro extract-service 契约：
 *   - getSessionMessages 按 sessionKey 读取 :GmMessage 节点（按 seq/createdAt 恢复时序）
 *   - 按 turnIndex > lastProcessedTurn 过滤已处理轮次
 *   - 配对相邻 user/assistant 消息为对话轮次
 *   - 复用 extractTurn（封装 graphAdapter.extractAndUpsertFromTurn）调 LLM 提取，
 *     批量写入 :Task/:Skill/:Event 节点及边。
 *
 * 生成的为生产节点（不带 :Benchmark），与 benchmark 数据隔离。
 * 重建入口为按需触发（lcmg_extract_rebuild 工具 + 导入后自动触发），
 * 通过 lastProcessedTurn / 进度文件避免重复提取。
 *
 * 控制参数（对齐 gm-pro POST /api/extract/rebuild）：
 *   - concurrency   LLM 并发窗口（同时提取的轮次数），1-128，默认 4
 *   - pageSize      读取分页大小，默认 2000（按 turn 窗口分批读取，避免大 session 一次性载入内存）
 *   - writeBatchSize 合并写入批上限，默认 500（透传至 graphAdapter.batchUpsert 分批提交）
 *   - progressPath  断点续传 + 进度落盘路径；传入即启用，同路径再次调用从断点续跑
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import * as neo4jDriver from 'neo4j-driver';
import { getNeo4jDriver } from "../tools/shared.js";
import { getGlobalLogger } from "../utils/logger.js";

/** 单条会话消息（来自 :GmMessage 节点） */
interface GmMessage {
  id: string;
  seq: number;
  turnIndex: number;
  role: string;
  content: string;
  createdAt: number;
}

/** 一轮配对后的 user/assistant 消息 */
export interface SessionTurn {
  sessionKey: string;
  turnIndex: number;
  user: string;
  assistant: string;
}

/** extract-service 外部依赖（由调用方注入） */
export interface ExtractDeps {
  /** 一轮 user/assistant → 提取 Task/Skill/Event。返回新增节点/边数。opts.writeBatchSize 透传合并写入批上限。 */
  extractTurn: (user: string, assistant: string, opts?: { writeBatchSize?: number }) => Promise<{ nodes: number; edges: number }>;
  logger?: any;
  signal?: AbortSignal;
}

/** 重建返回结果 */
export interface RebuildResult {
  sessionKey: string;
  turns: number;
  processed: number;
  nodes: number;
  edges: number;
  skipped: number;
  error?: string;
  /** 本次重建的运行级进度快照 */
  progress?: RunProgress;
}

/** 重建控制参数（对齐 gm-pro POST /api/extract/rebuild） */
export interface RebuildOptions {
  /** 单次最多处理轮次数，默认 50 */
  limit?: number;
  /** 从哪一轮之后开始（默认读取本地进度，force=true 时从 0 开始） */
  lastProcessedTurn?: number;
  /** 强制从头重建该会话（忽略进度），默认 false */
  force?: boolean;
  /** LLM 并发窗口（同时提取的轮次数），1-128，默认 4 */
  concurrency?: number;
  /** 读取分页大小，默认 2000（按 turn 窗口分批读取） */
  pageSize?: number;
  /** 合并写入批上限，默认 500（透传至 graphAdapter.batchUpsert 分批提交） */
  writeBatchSize?: number;
  /** 断点续传 + 进度落盘路径；传入即启用，同路径再次调用从断点续跑 */
  progressPath?: string;
  /** 内部：运行级进度快照（由 rebuildAll 注入；单会话独立调用时自动创建） */
  progress?: RunProgress;
}

// ── 进度记录（避免重复提取 / 断点续传 / Dashboard 进度条）──
const PROGRESS_PATH = join(homedir(), '.openclaw', 'extract-progress.json');

/** 运行级进度快照（供 Dashboard 双进度条展示：批次进度 / 总进度） */
export interface RunProgress {
  done: boolean;
  startedAt?: string;
  updatedAt?: string;
  /** 本次一共处理多少会话 */
  totalSessions: number;
  /** 本次分多少批次（每个会话为一个处理批次） */
  totalBatches: number;
  /** 当前处理第几个批次（1-based，0 = 尚未开始） */
  currentBatch: number;
  /** 当前处理第几个会话（1-based，0 = 尚未开始） */
  currentSession: number;
  /** 已完成的会话数 */
  processedSessions: number;
  /** 本次需处理的总轮次数（按 limit 与已处理进度预估的剩余可提取轮次） */
  totalTurns: number;
  /** 已提取轮次数 */
  processedTurns: number;
  /** 当前正在处理的会话 */
  currentSessionKey?: string;
}

interface ProgressState {
  version?: number;
  /** sessionKey -> 已处理到的最大 turnIndex */
  sessions: Record<string, number>;
  lastRunAt?: string;
  startedAt?: string;
  updatedAt?: string;
  done?: boolean;
  totalSessions?: number;
  totalBatches?: number;
  currentBatch?: number;
  currentSession?: number;
  processedSessions?: number;
  totalTurns?: number;
  processedTurns?: number;
  currentSessionKey?: string;
}

/** 解析进度文件路径：优先使用 progressPath 参数（传入即启用断点续传），否则回退默认路径 */
function resolveProgressPath(progressPath?: string): string {
  const p = (progressPath ?? '').trim();
  return p ? p : PROGRESS_PATH;
}

function readProgress(progressPath?: string): ProgressState {
  const p = resolveProgressPath(progressPath);
  try {
    if (!existsSync(p)) return { sessions: {} };
    return JSON.parse(readFileSync(p, 'utf8')) as ProgressState;
  } catch {
    return { sessions: {} };
  }
}

function writeProgress(state: ProgressState, progressPath?: string): void {
  const p = resolveProgressPath(progressPath);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2));
  } catch { /* 进度持久化失败不阻塞重建 */ }
}

/** 读改写进度文件：读入 -> mutate -> 落盘（统一入口，避免多处写互相覆盖） */
function persistProgress(progressPath: string | undefined, mutate: (s: ProgressState) => void): void {
  const state = readProgress(progressPath);
  mutate(state);
  state.updatedAt = new Date().toISOString();
  writeProgress(state, progressPath);
}

/** 将运行级进度快照写入进度状态（供断点续传 + Dashboard 双进度条） */
function applyRunProgress(state: ProgressState, p: RunProgress): void {
  state.version = 2;
  state.done = p.done;
  state.startedAt = p.startedAt;
  state.totalSessions = p.totalSessions;
  state.totalBatches = p.totalBatches;
  state.currentBatch = p.currentBatch;
  state.currentSession = p.currentSession;
  state.processedSessions = p.processedSessions;
  state.totalTurns = p.totalTurns;
  state.processedTurns = p.processedTurns;
  state.currentSessionKey = p.currentSessionKey;
}

/** 从进度文件读取运行级快照（归一化；缺省为未开始） */
export function readRunProgress(progressPath?: string): RunProgress {
  const s = readProgress(progressPath);
  return {
    done: s.done === true,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    totalSessions: Number(s.totalSessions) || 0,
    totalBatches: Number(s.totalBatches) || 0,
    currentBatch: Number(s.currentBatch) || 0,
    currentSession: Number(s.currentSession) || 0,
    processedSessions: Number(s.processedSessions) || 0,
    totalTurns: Number(s.totalTurns) || 0,
    processedTurns: Number(s.processedTurns) || 0,
    currentSessionKey: s.currentSessionKey,
  };
}

/** 读取某 session 的已处理进度；force 时返回 0（从头重建）。progressPath 传入即从该路径读取断点进度。 */
export function getSessionProgress(sessionKey: string, force = false, progressPath?: string): number {
  if (force) return 0;
  return readProgress(progressPath).sessions[sessionKey] ?? 0;
}

function clampInt(v: number | undefined, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ── 分页读取辅助：按 turn 窗口分批读取，保证轮次不跨页拆分 ──

/** 读取某 session 在 lastTurn 之后的前 size 个 turnIndex（分页游标） */
async function fetchTurnWindow(driver: any, sessionKey: string, lastTurn: number, size: number): Promise<number[]> {
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH (n:GmMessage {sessionId: $sessionKey})
       WHERE n.turnIndex > $lastTurn
       RETURN DISTINCT n.turnIndex AS turnIndex
       ORDER BY turnIndex ASC
       LIMIT $size`,
      {
        sessionKey,
        lastTurn: neo4jDriver.int(Math.trunc(Number(lastTurn) || 0)),
        size: neo4jDriver.int(Math.max(1, Math.floor(size) || 1)),
      },
    );
    return res.records.map((r: any) => Number(r.get('turnIndex') ?? 0)).filter((t: number) => t > lastTurn);
  } finally {
    await session.close().catch(() => {});
  }
}

/** 读取指定 turnIndex 集合内的全部消息（按 seq 恢复时序） */
async function fetchMessagesForTurns(driver: any, sessionKey: string, turns: number[]): Promise<GmMessage[]> {
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH (n:GmMessage {sessionId: $sessionKey})
       WHERE n.turnIndex IN $turns
       RETURN n.id AS id, n.seq AS seq, n.turnIndex AS turnIndex,
              n.role AS role, n.content AS content, n.createdAt AS createdAt
       ORDER BY n.seq ASC`,
      { sessionKey, turns },
    );
    return res.records.map((r: any) => ({
      id: r.get('id') ?? '',
      seq: Number(r.get('seq') ?? 0),
      turnIndex: Number(r.get('turnIndex') ?? 0),
      role: String(r.get('role') ?? ''),
      content: String(r.get('content') ?? ''),
      createdAt: Number(r.get('createdAt') ?? 0),
    }));
  } finally {
    await session.close().catch(() => {});
  }
}

/** 按 turnIndex 分组配对 user/assistant 为对话轮次（无 user 的轮次无法提取，直接跳过） */
function pairTurns(
  sessionKey: string,
  window: number[],
  messages: GmMessage[],
  limit: number,
  signal?: AbortSignal,
): SessionTurn[] {
  const byTurn = new Map<number, GmMessage[]>();
  for (const m of messages) {
    if (!byTurn.has(m.turnIndex)) byTurn.set(m.turnIndex, []);
    byTurn.get(m.turnIndex)!.push(m);
  }
  const turns: SessionTurn[] = [];
  for (const turnIndex of window) {
    if (signal?.aborted) break;
    const msgs = byTurn.get(turnIndex) ?? [];
    const user = msgs.find((m) => m.role === 'user');
    const assistant = msgs.find((m) => m.role === 'assistant');
    if (!user) continue; // 无 user 的轮次无法提取
    turns.push({
      sessionKey,
      turnIndex,
      user: user.content,
      assistant: assistant?.content ?? '',
    });
    if (turns.length >= limit) break;
  }
  return turns;
}

/**
 * 读取某 session 的 :GmMessage 节点，恢复时序并过滤已处理轮次，
 * 配对相邻 user/assistant 消息为对话轮次。
 * pageSize 控制按 turn 窗口分批读取的大小（默认 2000）。
 */
export async function getSessionTurns(
  sessionKey: string,
  lastProcessedTurn: number,
  limit: number,
  pageSize = 2000,
  deps?: { signal?: AbortSignal },
): Promise<SessionTurn[]> {
  const driver = await getNeo4jDriver();
  const window = await fetchTurnWindow(driver, sessionKey, lastProcessedTurn, Math.min(pageSize, limit));
  if (window.length === 0) return [];
  const messages = await fetchMessagesForTurns(driver, sessionKey, window);
  return pairTurns(sessionKey, window, messages, limit, deps?.signal);
}

/** 预估本批会话在各自 startTurn 之后剩余的可提取轮次数（role=user 的 DISTINCT turnIndex，扣除已处理进度，且受 perSessionLimit 封顶） */
async function estimateRemainingTurns(
  driver: any,
  sessionKeys: string[],
  startTurns: Map<string, number>,
  perSessionLimit: number,
): Promise<number> {
  if (sessionKeys.length === 0) return 0;
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH (n:GmMessage) WHERE n.sessionId IN $keys AND n.role = 'user'
       RETURN n.sessionId AS sessionKey, COLLECT(DISTINCT n.turnIndex) AS turns`,
      { keys: sessionKeys },
    );
    let total = 0;
    for (const r of res.records) {
      const sk = String(r.get('sessionKey') ?? '');
      const start = startTurns.get(sk) ?? 0;
      const turns: number[] = (r.get('turns') ?? [])
        .map((t: any) => Number(t))
        .filter((t: number) => Number.isFinite(t) && t > start);
      total += Math.min(perSessionLimit, turns.length);
    }
    return total;
  } finally {
    await session.close().catch(() => {});
  }
}

/** 单会话独立调用时创建运行级进度快照（totalSessions=1，totalTurns 按剩余可提取轮次预估） */
async function createStandaloneProgress(
  driver: any,
  sessionKey: string,
  startTurn: number,
  perSessionLimit: number,
): Promise<RunProgress> {
  const totalTurns = await estimateRemainingTurns(driver, [sessionKey], new Map([[sessionKey, startTurn]]), perSessionLimit);
  return {
    done: false,
    startedAt: new Date().toISOString(),
    totalSessions: 1,
    totalBatches: 1,
    currentBatch: 1,
    currentSession: 1,
    processedSessions: 0,
    totalTurns,
    processedTurns: 0,
    currentSessionKey: sessionKey,
  };
}

// ── 并发池：受 concurrency 控制，同时最多 N 轮调 LLM 提取 ──

interface TurnPoolResult {
  nodes: number;
  edges: number;
  processed: number;
  skipped: number;
  maxTurn: number;
}

async function runTurnPool(
  turns: SessionTurn[],
  concurrency: number,
  deps: ExtractDeps,
  log: any,
  writeBatchSize?: number,
): Promise<TurnPoolResult> {
  let idx = 0;
  let nodes = 0;
  let edges = 0;
  let processed = 0;
  let skipped = 0;
  let maxTurn = 0;
  const workerCount = Math.max(1, Math.min(concurrency, turns.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (idx < turns.length) {
      if (deps.signal?.aborted) return;
      const cur = idx++;
      const turn = turns[cur];
      try {
        const r = await deps.extractTurn(turn.user, turn.assistant, writeBatchSize != null ? { writeBatchSize } : undefined);
        nodes += r.nodes ?? 0;
        edges += r.edges ?? 0;
        processed++;
        if (turn.turnIndex > maxTurn) maxTurn = turn.turnIndex;
        log?.debug?.(`[extract-service] ${turn.sessionKey} turn ${turn.turnIndex}: +${r.nodes ?? 0} nodes, +${r.edges ?? 0} edges`);
      } catch (e) {
        skipped++;
        log?.warn?.(`[extract-service] turn ${turn.sessionKey}#${turn.turnIndex} failed (non-fatal)`, { err: e instanceof Error ? e.message : String(e) });
      }
    }
  });
  await Promise.all(workers);
  return { nodes, edges, processed, skipped, maxTurn };
}

/** 重建单个 session：按 pageSize 分页 + concurrency 并发提取，每页推进进度（断点续传） */
export async function rebuildSession(
  sessionKey: string,
  deps: ExtractDeps,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const log = deps.logger ?? getGlobalLogger();
  const limit = clampInt(opts.limit ?? 50, 1, 100000);
  const concurrency = clampInt(opts.concurrency ?? 4, 1, 128);
  const pageSize = clampInt(opts.pageSize ?? 2000, 1, 20000);
  const writeBatchSize = opts.writeBatchSize != null ? clampInt(opts.writeBatchSize, 1, 50000) : undefined;
  const progressPath = opts.progressPath;
  const force = opts.force === true;
  const startTurn = opts.lastProcessedTurn !== undefined ? Number(opts.lastProcessedTurn) : getSessionProgress(sessionKey, force, progressPath);

  const driver = await getNeo4jDriver();
  // 运行级进度：由 rebuildAll 注入（多会话），否则单会话独立创建
  const standalone = opts.progress === undefined;
  const progress = opts.progress ?? (await createStandaloneProgress(driver, sessionKey, startTurn, limit));
  if (standalone) {
    // 单会话独立调用：首次落盘运行级进度（含 totalTurns 预估），供 Dashboard 展示 0% 起点
    persistProgress(progressPath, (s) => applyRunProgress(s, progress));
  }
  let nodes = 0;
  let edges = 0;
  let processed = 0;
  let skipped = 0;
  let maxTurn = startTurn;
  let cursor = startTurn;
  let remaining = limit;

  while (remaining > 0) {
    if (deps.signal?.aborted) break;
    // 每页取 min(pageSize, remaining) 个 turnIndex，保证轮次不跨页拆分
    const window = await fetchTurnWindow(driver, sessionKey, cursor, Math.min(pageSize, remaining));
    if (window.length === 0) break;
    const messages = await fetchMessagesForTurns(driver, sessionKey, window);
    const turns = pairTurns(sessionKey, window, messages, remaining, deps.signal);
    if (turns.length === 0) {
      // 窗口内无可提取轮次（如全部缺 user），推进游标避免死循环
      cursor = Math.max(cursor, ...window);
      break;
    }
    const pool = await runTurnPool(turns, concurrency, deps, log, writeBatchSize);
    nodes += pool.nodes;
    edges += pool.edges;
    processed += pool.processed;
    skipped += pool.skipped;
    maxTurn = Math.max(maxTurn, pool.maxTurn);
    remaining -= turns.length;
    // 游标推进到本页最大 turnIndex（未处理的轮次下次调用从断点续跑）
    cursor = Math.max(cursor, pool.maxTurn, Math.max(...window));
    // 每页落盘进度：中断后以同一 progressPath 重新调用即可从断点续跑，不重复处理
    if (pool.processed > 0) {
      progress.processedTurns += pool.processed;
      persistProgress(progressPath, (s) => {
        s.sessions[sessionKey] = Math.max(s.sessions[sessionKey] ?? 0, maxTurn);
        s.lastRunAt = new Date().toISOString();
        applyRunProgress(s, progress);
      });
    }
  }

  // 单会话独立调用：运行结束标记 done
  if (standalone) {
    progress.done = true;
    persistProgress(progressPath, (s) => applyRunProgress(s, progress));
  }

  return { sessionKey, turns: processed + skipped, processed, nodes, edges, skipped, progress };
}

/** 枚举全部含 :GmMessage 的 session，逐个重建（每个会话一个处理批次；跨会话顺序执行，会话内由 concurrency 控制并发） */
export async function rebuildAll(
  deps: ExtractDeps,
  opts: RebuildOptions = {},
): Promise<{ sessions: RebuildResult[]; totalNodes: number; totalEdges: number; progress: RunProgress }> {
  const driver = await getNeo4jDriver();
  const session = driver.session();
  let sessionKeys: string[] = [];
  try {
    const res = await session.run('MATCH (n:GmMessage) WHERE n.sessionId IS NOT NULL RETURN DISTINCT n.sessionId AS sessionKey');
    sessionKeys = res.records.map((r: any) => String(r.get('sessionKey') ?? '')).filter(Boolean);
  } finally {
    await session.close().catch(() => {});
  }
  const log = deps.logger ?? getGlobalLogger();
  const limit = clampInt(opts.limit ?? 50, 1, 100000);
  const progressPath = opts.progressPath;
  const force = opts.force === true;

  // 汇总每个会话的起始游标（进度 / lastProcessedTurn），并预估本次需处理的总轮次数
  const startTurns = new Map<string, number>();
  for (const sk of sessionKeys) {
    const st = opts.lastProcessedTurn !== undefined ? Number(opts.lastProcessedTurn) : getSessionProgress(sk, force, progressPath);
    startTurns.set(sk, st);
  }
  const totalTurns = await estimateRemainingTurns(driver, sessionKeys, startTurns, limit);

  const progress: RunProgress = {
    done: false,
    startedAt: new Date().toISOString(),
    totalSessions: sessionKeys.length,
    totalBatches: sessionKeys.length,
    currentBatch: 0,
    currentSession: 0,
    processedSessions: 0,
    totalTurns,
    processedTurns: 0,
  };
  // 运行开始即落盘（含 totalSessions / totalBatches / totalTurns），供 Dashboard 展示 0% 起点
  persistProgress(progressPath, (s) => applyRunProgress(s, progress));

  const sessions: RebuildResult[] = [];
  let totalNodes = 0;
  let totalEdges = 0;
  for (let i = 0; i < sessionKeys.length; i++) {
    if (deps.signal?.aborted) break;
    const sk = sessionKeys[i];
    progress.currentBatch = i + 1;
    progress.currentSession = i + 1;
    progress.currentSessionKey = sk;
    progress.updatedAt = new Date().toISOString();
    persistProgress(progressPath, (s) => applyRunProgress(s, progress));
    const r = await rebuildSession(sk, deps, { ...opts, progress });
    sessions.push(r);
    totalNodes += r.nodes;
    totalEdges += r.edges;
    progress.processedSessions++;
    progress.updatedAt = new Date().toISOString();
    persistProgress(progressPath, (s) => applyRunProgress(s, progress));
    log?.info?.(`[extract-service] rebuilt ${sk}: ${r.processed}/${r.turns} turns, +${r.nodes} nodes, +${r.edges} edges`);
  }
  progress.done = true;
  progress.updatedAt = new Date().toISOString();
  persistProgress(progressPath, (s) => applyRunProgress(s, progress));
  return { sessions, totalNodes, totalEdges, progress };
}
