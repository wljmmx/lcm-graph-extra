/**
 * on_session_created hook — initialize DAG reference, load memory context, and set session config.
 */

import type { PluginInstance } from '../register';
import { GraphMemoryManager } from '../core/graph';

// ---------------------------------------------------------------------------
// Session state attached to the plugin instance at runtime
// ---------------------------------------------------------------------------

export interface SessionState {
  sessionId: string;
  dag: GraphMemoryManager;
  initializedAt: string;
  contextInjections: number;       // how many times before_turn injected context
  lastTurnTokenBudget: number | null;
}

/** Per-session state store keyed by session ID. */
const sessionStore = new Map<string, SessionState>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a session-local DAG reference node. */
function createDagReferenceNode(sessionId: string): { id: string; manager: GraphMemoryManager } {
  const manager = new GraphMemoryManager();
  const nodeId = `session-ref:${sessionId}`;
  manager.addNode({
    id: nodeId,
    type: 'memory',
    title: `Session ${sessionId.slice(0, 12)}`,
    content: '',
    metadata: { kind: 'session-root', sessionId },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    weight: 1.0,
    pinned: true,
  });
  return { id: nodeId, manager };
}

/**
 * Load related memory context for the session by scanning `memoryDir`.
 * Returns an array of relevant node contents (up to `maxNodes`).
 */
async function loadMemoryContext(
  instance: PluginInstance,
  sessionId: string,
): Promise<string> {
  if (!instance.context.memoryDir) return '';

  try {
    const { createDAG } = await import('../core/lifecycle');
    const dag = createDAG(instance.context.memoryDir);
    const nodes = dag.graph._allNodeEntries();

    // Merge into the session DAG so future hooks can navigate from it
    const state = sessionStore.get(sessionId);
    if (state) {
      for (const [, node] of nodes) {
        if (!state.dag.getNode(node.id)) {
          state.dag.addNode({ ...node });
        }
      }
    }

    // Return a compact representation of the most relevant memory
    const maxNodes = Math.min(nodes.length, 20);
    const sorted = nodes.sort((a, b) => ((b[1].weight ?? 0) - (a[1].weight ?? 0)));
    const top = sorted.slice(0, maxNodes);
    return top.map(([, n]) => n.title || n.id).join('\n');

  } catch {
    return '';
  }
}

/** Apply session-level defaults to the instance config. */
function initSessionConfig(instance: PluginInstance): void {
  // Ensure compaction config exists
  if (!instance.config.compaction) {
    instance.config.compaction = {
      enabled: true,
      triggerThreshold: 10_000,
      softThresholdTokens: 81_920,
      keepRecentTokens: 65_536,
    };
  }

  // Ensure TTL config exists
  if (!instance.config.ttl) {
    instance.config.ttl = {
      enabled: true,
      retentionDays: 90,
      cleanupIntervalHours: 24,
    };
  }
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * Called when a new OpenClaw session is created.
 *
 * 1. Creates a DAG reference node for the session.
 * 2. Loads related memory context.
 * 3. Initializes session-level configuration defaults.
 */
export async function onSessionCreated(
  instance: PluginInstance,
  sessionId?: string,
): Promise<SessionState> {
  const logger = instance.logger;

  // Derive session ID from context or caller hint
  const id = sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  logger?.debug?.(`session_created hook: initializing session ${id}`);

  // --- step 1 — create DAG reference -------------------------------------
  const { id: dagRefId, manager } = createDagReferenceNode(id);

  // --- step 3 — init config (before loading context so defaults are set) --
  initSessionConfig(instance);

  // --- step 2 — load memory context --------------------------------------
  const contextSummary = await loadMemoryContext(instance, id);
  logger?.debug?.(
    `session_created hook: loaded memory context for ${id} (${contextSummary.length} chars summary)`,
  );

  // --- create and store session state ------------------------------------
  const state: SessionState = {
    sessionId: id,
    dag: manager,
    initializedAt: new Date().toISOString(),
    contextInjections: 0,
    lastTurnTokenBudget: null,
  };

  sessionStore.set(id, state);

  // Log loaded context into the DAG root node for traceability
  if (contextSummary) {
    manager.updateNode(dagRefId, {
      content: `[Session initialized with memory context]\n${contextSummary}`,
    });
  }

  return state;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test__ = {
  sessionStore,
  createDagReferenceNode,
  initSessionConfig,
};

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

const MAX_INACTIVE_MS = 24 * 60 * 60 * 1000; // 24 小时

/**
 * 清理超过指定时限未活动的会话状态。
 * 在 maintain() 中定期调用，防止 sessionStore 内存泄漏。
 *
 * @param maxAgeMs 最大空闲时间（毫秒），默认 24 小时
 * @returns 已清理的会话数
 */
export function cleanupStaleSessions(maxAgeMs: number = MAX_INACTIVE_MS): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, state] of sessionStore.entries()) {
    // 判断依据：从 DAG 节点的 updatedAt 推断最近活动
    const rootNode = state.dag.getNode(`session-ref:${state.sessionId}`);
    if (!rootNode) {
      // 缺少根节点，说明状态异常，直接清理
      sessionStore.delete(id);
      cleaned++;
      continue;
    }

    const updatedTime = new Date(rootNode.updatedAt ?? rootNode.createdAt).getTime();
    if (now - updatedTime > maxAgeMs) {
      sessionStore.delete(id);
      cleaned++;
    }
  }

  return cleaned;
}
