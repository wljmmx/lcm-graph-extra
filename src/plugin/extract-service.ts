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
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /** 一轮 user/assistant → 提取 Task/Skill/Event。返回新增节点/边数。 */
  extractTurn: (user: string, assistant: string) => Promise<{ nodes: number; edges: number }>;
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
}

// ── 进度记录（避免重复提取）──
const PROGRESS_PATH = join(homedir(), '.openclaw', 'extract-progress.json');

interface ProgressState {
  /** sessionKey -> 已处理到的最大 turnIndex */
  sessions: Record<string, number>;
  lastRunAt?: string;
}

function readProgress(): ProgressState {
  try {
    if (!existsSync(PROGRESS_PATH)) return { sessions: {} };
    return JSON.parse(readFileSync(PROGRESS_PATH, 'utf8')) as ProgressState;
  } catch {
    return { sessions: {} };
  }
}

function writeProgress(state: ProgressState): void {
  try {
    writeFileSync(PROGRESS_PATH, JSON.stringify(state, null, 2));
  } catch { /* 进度持久化失败不阻塞重建 */ }
}

/** 读取某 session 的已处理进度；force 时返回 0（从头重建） */
export function getSessionProgress(sessionKey: string, force = false): number {
  if (force) return 0;
  return readProgress().sessions[sessionKey] ?? 0;
}

/**
 * 读取某 session 的 :GmMessage 节点，恢复时序并过滤已处理轮次，
 * 配对相邻 user/assistant 消息为对话轮次。
 */
export async function getSessionTurns(
  sessionKey: string,
  lastProcessedTurn: number,
  limit: number,
  deps?: { signal?: AbortSignal },
): Promise<SessionTurn[]> {
  const driver = await getNeo4jDriver();
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH (n:GmMessage {sessionId: $sessionKey})
       WHERE n.turnIndex > $lastProcessedTurn
       RETURN n.id AS id, n.seq AS seq, n.turnIndex AS turnIndex,
              n.role AS role, n.content AS content, n.createdAt AS createdAt
       ORDER BY n.seq ASC`,
      { sessionKey, lastProcessedTurn: Number(lastProcessedTurn) || 0 },
    );
    const messages: GmMessage[] = res.records.map((r: any) => ({
      id: r.get('id') ?? '',
      seq: Number(r.get('seq') ?? 0),
      turnIndex: Number(r.get('turnIndex') ?? 0),
      role: String(r.get('role') ?? ''),
      content: String(r.get('content') ?? ''),
      createdAt: Number(r.get('createdAt') ?? 0),
    }));

    // 按 turnIndex 分组配对
    const byTurn = new Map<number, GmMessage[]>();
    for (const m of messages) {
      if (!byTurn.has(m.turnIndex)) byTurn.set(m.turnIndex, []);
      byTurn.get(m.turnIndex)!.push(m);
    }
    const turns: SessionTurn[] = [];
    for (const [turnIndex, msgs] of byTurn) {
      if (deps?.signal?.aborted) break;
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
  } finally {
    await session.close().catch(() => {});
  }
}

/** 重建单个 session：逐轮提取 Task/Skill/Event，并推进进度 */
export async function rebuildSession(
  sessionKey: string,
  deps: ExtractDeps,
  limit: number,
  lastProcessedTurn?: number,
  force = false,
): Promise<RebuildResult> {
  const startTurn = lastProcessedTurn !== undefined ? lastProcessedTurn : getSessionProgress(sessionKey, force);
  const turns = await getSessionTurns(sessionKey, startTurn, limit, deps);
  const log = deps.logger ?? getGlobalLogger();
  let nodes = 0;
  let edges = 0;
  let processed = 0;
  let maxTurn = startTurn;
  for (const turn of turns) {
    if (deps.signal?.aborted) break;
    try {
      const r = await deps.extractTurn(turn.user, turn.assistant);
      nodes += r.nodes ?? 0;
      edges += r.edges ?? 0;
      processed++;
      maxTurn = Math.max(maxTurn, turn.turnIndex);
      log?.debug?.(`[extract-service] ${sessionKey} turn ${turn.turnIndex}: +${r.nodes} nodes, +${r.edges} edges`);
    } catch (e) {
      log?.warn?.(`[extract-service] turn ${sessionKey}#${turn.turnIndex} failed (non-fatal)`, { err: e instanceof Error ? e.message : String(e) });
    }
  }
  // 推进进度（仅当本次有实际提取时）
  if (processed > 0) {
    const state = readProgress();
    state.sessions[sessionKey] = Math.max(state.sessions[sessionKey] ?? 0, maxTurn);
    state.lastRunAt = new Date().toISOString();
    writeProgress(state);
  }
  return { sessionKey, turns: turns.length, processed, nodes, edges, skipped: turns.length - processed };
}

/** 枚举全部含 :GmMessage 的 session，逐个重建（分批） */
export async function rebuildAll(
  deps: ExtractDeps,
  limit: number,
  force = false,
): Promise<{ sessions: RebuildResult[]; totalNodes: number; totalEdges: number }> {
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
  const sessions: RebuildResult[] = [];
  let totalNodes = 0;
  let totalEdges = 0;
  for (const sk of sessionKeys) {
    if (deps.signal?.aborted) break;
    const r = await rebuildSession(sk, deps, limit, undefined, force);
    sessions.push(r);
    totalNodes += r.nodes;
    totalEdges += r.edges;
    log?.info?.(`[extract-service] rebuilt ${sk}: ${r.processed}/${r.turns} turns, +${r.nodes} nodes, +${r.edges} edges`);
  }
  return { sessions, totalNodes, totalEdges };
}