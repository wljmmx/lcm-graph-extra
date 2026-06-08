// ============================================================
// GraphMemoryManager — DAG-based memory graph for LCM recall
// ============================================================

export type NodeType = 'summary' | 'memory' | 'reference' | 'cross-session';

export interface GraphNode {
  id: string;
  type: NodeType;
  title?: string;
  content?: string;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  weight?: number;
  pinned?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationType: 'depends_on' | 'references' | 'summarizes' | 'cross_links' | 'merged_from';
  weight?: number;
  createdAt: string;
}

// ---------- implementation ------------------------------------------------

export class GraphMemoryManager {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];

  // ===================== CRUD ============================================

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  updateNode(id: string, updates: Partial<GraphNode>): boolean {
    const existing = this.nodes.get(id);
    if (!existing) return false;
    this.nodes.set(id, { ...existing, ...updates, updatedAt: new Date().toISOString() });
    return true;
  }

  removeNode(id: string): boolean {
    if (!this.nodes.has(id)) return false;
    this.nodes.delete(id);
    this.edges = this.edges.filter(e => e.source !== id && e.target !== id);
    return true;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getEdge(source: string, target: string): GraphEdge | undefined {
    return this.edges.find(e => e.source === source && e.target === target);
  }

  // ===================== Edge Operations =================================

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
  }

  removeEdge(source: string, target: string): boolean {
    const idx = this.edges.findIndex(e => e.source === source && e.target === target);
    if (idx === -1) return false;
    this.edges.splice(idx, 1);
    return true;
  }

  getEdgesForNode(nodeId: string): { incoming: GraphEdge[]; outgoing: GraphEdge[] } {
    return {
      incoming: this.edges.filter(e => e.target === nodeId),
      outgoing: this.edges.filter(e => e.source === nodeId),
    };
  }

  // ===================== Graph Query =====================================

  getNeighbors(nodeId: string): string[] {
    const set = new Set<string>();
    for (const e of this.edges) {
      if (e.source === nodeId) set.add(e.target);
      if (e.target === nodeId) set.add(e.source);
    }
    return [...set];
  }

  getDepth(nodeId: string): number {
    const adj = new Map<string, string[]>();
    for (const [id] of this.nodes) adj.set(id, []);
    for (const e of this.edges) {
      if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
    }

    const memo = new Map<string, number>();
    let hasCycleFlag = false;
    const visiting = new Set<string>();

    function dfs(n: string): number {
      if (memo.has(n)) return memo.get(n)!;
      if (visiting.has(n)) { hasCycleFlag = true; return 0; }
      visiting.add(n);
      const children = adj.get(n) ?? [];
      let max = 0;
      for (const c of children) {
        if (this.nodes.has(c)) {
          max = Math.max(max, 1 + dfs.call(this, c));
        }
      }
      visiting.delete(n);
      memo.set(n, max);
      return max;
    }

    const depth = dfs.call(this, nodeId);
    return hasCycleFlag ? -1 : depth;
  }

  hasCycle(): boolean {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const [id] of this.nodes) color.set(id, WHITE);

    const adj = new Map<string, string[]>();
    for (const [id] of this.nodes) adj.set(id, []);
    for (const e of this.edges) {
      if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
    }

    let found = false;

    const dfs = (u: string): void => {
      if (found) return;
      color.set(u, GRAY);
      for (const v of (adj.get(u) ?? [])) {
        if (!color.has(v)) continue;
        if (color.get(v) === GRAY) { found = true; return; }
        if (color.get(v) === WHITE) dfs(v);
      }
      color.set(u, BLACK);
    };

    for (const [id] of this.nodes) {
      if (found) return true;
      if (color.get(id) === WHITE) dfs(id);
    }
    return found;
  }

  getCycles(): string[][] {
    const adj = new Map<string, string[]>();
    for (const [id] of this.nodes) adj.set(id, []);
    for (const e of this.edges) {
      if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
    }

    const cycles: string[][] = [];
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const [id] of this.nodes) color.set(id, WHITE);
    const path: string[] = [];
    const pathSet = new Set<string>();

    const dfs = (u: string): void => {
      color.set(u, GRAY);
      path.push(u);
      pathSet.add(u);
      for (const v of (adj.get(u) ?? [])) {
        if (!color.has(v)) continue;
        if (pathSet.has(v)) {
          const idx = path.indexOf(v);
          if (idx !== -1) {
            cycles.push([...path.slice(idx), v]);
          }
        } else if (color.get(v) === WHITE) {
          dfs(v);
        }
      }
      path.pop();
      pathSet.delete(u);
      color.set(u, BLACK);
    };

    for (const [id] of this.nodes) {
      if (color.get(id) === WHITE) dfs(id);
    }
    return cycles;
  }

  // ===================== Topological Operations ==========================

  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    for (const [id] of this.nodes) inDegree.set(id, 0);
    for (const e of this.edges) {
      if (inDegree.has(e.target)) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const adj = new Map<string, string[]>();
    for (const [id] of this.nodes) adj.set(id, []);
    for (const e of this.edges) {
      if (adj.has(e.source)) adj.get(e.source)!.push(e.target);
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      result.push(u);
      for (const v of (adj.get(u) ?? [])) {
        if (!inDegree.has(v)) continue;
        inDegree.set(v, inDegree.get(v)! - 1);
        if (inDegree.get(v) === 0) queue.push(v);
      }
    }
    return result;
  }

  ancestors(nodeId: string): string[] {
    if (!this.nodes.has(nodeId)) return [];
    const parents = new Map<string, Set<string>>();
    for (const [id] of this.nodes) parents.set(id, new Set());
    for (const e of this.edges) {
      if (parents.has(e.target)) parents.get(e.target)!.add(e.source);
    }

    const visited = new Set<string>();
    const stack: string[] = [nodeId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const p of (parents.get(cur) ?? [])) {
        if (!visited.has(p)) {
          visited.add(p);
          stack.push(p);
        }
      }
    }
    return [...visited];
  }

  descendants(nodeId: string): string[] {
    if (!this.nodes.has(nodeId)) return [];
    const adj = new Map<string, Set<string>>();
    for (const [id] of this.nodes) adj.set(id, new Set());
    for (const e of this.edges) {
      if (adj.has(e.source)) adj.get(e.source)!.add(e.target);
    }

    const visited = new Set<string>();
    const stack: string[] = [nodeId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const c of (adj.get(cur) ?? [])) {
        if (!visited.has(c)) {
          visited.add(c);
          stack.push(c);
        }
      }
    }
    return [...visited];
  }

  // ===================== Statistics ======================================

  getNodeCount(): number {
    return this.nodes.size;
  }

  getEdgeCount(): number {
    return this.edges.length;
  }

  getConnectedComponents(): string[][] {
    const idList = [...this.nodes.keys()];
    const adj = new Map<string, Set<string>>();
    for (const id of idList) adj.set(id, new Set());
    for (const e of this.edges) {
      if (adj.has(e.source) && adj.has(e.target)) {
        adj.get(e.source)!.add(e.target);
        adj.get(e.target)!.add(e.source);
      }
    }

    const visited = new Set<string>();
    const components: string[][] = [];

    for (const start of idList) {
      if (visited.has(start)) continue;
      const component: string[] = [];
      const queue: string[] = [start];
      visited.add(start);
      while (queue.length > 0) {
        const u = queue.shift()!;
        component.push(u);
        for (const v of (adj.get(u) ?? [])) {
          if (!visited.has(v)) {
            visited.add(v);
            queue.push(v);
          }
        }
      }
      components.push(component);
    }

    return components;
  }

  getIsolatedNodes(): string[] {
    const connected = new Set<string>();
    for (const e of this.edges) {
      if (this.nodes.has(e.source)) connected.add(e.source);
      if (this.nodes.has(e.target)) connected.add(e.target);
    }
    return [...this.nodes.keys()].filter(id => !connected.has(id));
  }

  // ===================== Utility =========================================

  serialize(): string {
    return JSON.stringify({
      nodes: [...this.nodes.entries()],
      edges: this.edges,
    });
  }

  deserialize(data: string): void {
    const parsed = JSON.parse(data);
    this.nodes = new Map(parsed.nodes as [string, GraphNode][]);
    this.edges = parsed.edges as GraphEdge[];
  }

  clone(): GraphMemoryManager {
    const copy = new GraphMemoryManager();
    for (const [id, node] of this.nodes) {
      copy.addNode({ ...node });
    }
    for (const edge of this.edges) {
      copy.addEdge({ ...edge });
    }
    return copy;
  }

  // ===================== Iteration Accessors ============================

  _allNodeEntries(): [string, GraphNode][] {
    return [...this.nodes.entries()];
  }

  _allEdges(): GraphEdge[] {
    return [...this.edges];
  }
}
