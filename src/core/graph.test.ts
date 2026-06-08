import { describe, it, expect, beforeEach } from 'vitest';
import { GraphMemoryManager, type GraphNode, type GraphEdge } from './graph';

const now = () => new Date().toISOString();

function makeNode(
  id: string,
  type: GraphNode['type'] = 'summary',
  metadata: Record<string, any> = {},
): GraphNode {
  return { id, type, metadata, createdAt: now(), updatedAt: now() };
}

function makeEdge(
  source: string,
  target: string,
  relationType: GraphEdge['relationType'] = 'depends_on',
): GraphEdge {
  return { source, target, relationType, createdAt: now() };
}

// ---------------------------------------------------------------
describe('GraphMemoryManager — CRUD', () => {
  let g: GraphMemoryManager;
  beforeEach(() => { g = new GraphMemoryManager(); });

  it('add and get node', () => {
    const n = makeNode('sum_1', 'summary');
    g.addNode(n);
    expect(g.getNode('sum_1')).toEqual(n);
    expect(g.getNode('nope')).toBeUndefined();
  });

  it('update node', () => {
    g.addNode(makeNode('a'));
    expect(g.updateNode('a', { title: 'updated' })).toBe(true);
    const updated = g.getNode('a');
    expect(updated!.title).toBe('updated');
    expect(g.updateNode('nonexistent', { title: 'x' })).toBe(false);
  });

  it('remove node also removes edges', () => {
    g.addNode(makeNode('a'));
    g.addNode(makeNode('b'));
    g.addEdge(makeEdge('a', 'b'));
    expect(g.getNodeCount()).toBe(2);
    expect(g.getEdgeCount()).toBe(1);

    g.removeNode('a');
    expect(g.getNodeCount()).toBe(1);
    expect(g.getEdgeCount()).toBe(0);
    expect(g.getNode('a')).toBeUndefined();
    expect(g.getNode('b')).toBeDefined();
  });

  it('remove nonexistent node returns false', () => {
    expect(g.removeNode('ghost')).toBe(false);
  });
});

// ---------------------------------------------------------------
describe('Edge Operations', () => {
  let g: GraphMemoryManager;
  beforeEach(() => { g = new GraphMemoryManager(); });

  it('add and get edge', () => {
    const e = makeEdge('a', 'b');
    g.addEdge(e);
    expect(g.getEdge('a', 'b')).toEqual(e);
  });

  it('remove edge returns true / false', () => {
    g.addEdge(makeEdge('a', 'b'));
    expect(g.removeEdge('a', 'b')).toBe(true);
    expect(g.removeEdge('a', 'b')).toBe(false);
  });

  it('getEdgesForNode', () => {
    g.addNode(makeNode('x'));
    g.addNode(makeNode('y'));
    g.addNode(makeNode('z'));
    g.addEdge(makeEdge('x', 'y'));
    g.addEdge(makeEdge('z', 'y'));
    const edges = g.getEdgesForNode('y');
    expect(edges.incoming.length).toBe(2);
    expect(edges.outgoing.length).toBe(0);
    const edgesX = g.getEdgesForNode('x');
    expect(edgesX.outgoing.length).toBe(1);
  });

  it('getNeighbors', () => {
    g.addNode(makeNode('a'));
    g.addNode(makeNode('b'));
    g.addNode(makeNode('c'));
    g.addEdge(makeEdge('a', 'b'));
    g.addEdge(makeEdge('c', 'b'));
    const neighbors = g.getNeighbors('b');
    expect(neighbors).toContain('a');
    expect(neighbors).toContain('c');
    expect(neighbors.length).toBe(2);
  });

  it('getDepth on linear chain', () => {
    for (const id of ['A', 'B', 'C', 'D']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('A', 'B'));
    g.addEdge(makeEdge('B', 'C'));
    g.addEdge(makeEdge('C', 'D'));
    expect(g.getDepth('A')).toBe(3);
    expect(g.getDepth('C')).toBe(1);
    expect(g.getDepth('D')).toBe(0);
  });

  it('getDepth returns -1 on cycle', () => {
    g.addNode(makeNode('X'));
    g.addNode(makeNode('Y'));
    g.addEdge(makeEdge('X', 'Y'));
    g.addEdge(makeEdge('Y', 'X'));
    expect(g.getDepth('X')).toBe(-1);
  });
});

// ---------------------------------------------------------------
describe('Cycle Detection', () => {
  let g: GraphMemoryManager;
  beforeEach(() => { g = new GraphMemoryManager(); });

  it('DAG has no cycle', () => {
    for (const id of ['a', 'b', 'c']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('a', 'b'));
    g.addEdge(makeEdge('b', 'c'));
    expect(g.hasCycle()).toBe(false);
  });

  it('simple cycle detected', () => {
    g.addNode(makeNode('a'));
    g.addNode(makeNode('b'));
    g.addEdge(makeEdge('a', 'b'));
    g.addEdge(makeEdge('b', 'a'));
    expect(g.hasCycle()).toBe(true);
  });

  it('getCycles returns cycle paths', () => {
    g.addNode(makeNode('a'));
    g.addNode(makeNode('b'));
    g.addNode(makeNode('c'));
    g.addEdge(makeEdge('a', 'b'));
    g.addEdge(makeEdge('b', 'c'));
    g.addEdge(makeEdge('c', 'a'));
    const cycles = g.getCycles();
    expect(cycles.length).toBeGreaterThan(0);
    // The cycle should involve a, b, c
    expect(cycles[0]).toContain('a');
  });

  it('no cycles on empty graph', () => {
    expect(g.hasCycle()).toBe(false);
    expect(g.getCycles().length).toBe(0);
  });

  it('three-node cycle', () => {
    for (const id of ['X', 'Y', 'Z']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('X', 'Y'));
    g.addEdge(makeEdge('Y', 'Z'));
    g.addEdge(makeEdge('Z', 'X'));
    expect(g.hasCycle()).toBe(true);
  });
});

// ---------------------------------------------------------------
describe('Topological Sort (Kahn)', () => {
  let g: GraphMemoryManager;
  beforeEach(() => { g = new GraphMemoryManager(); });

  it('linear DAG: A→B→C', () => {
    for (const id of ['A', 'B', 'C']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('A', 'B'));
    g.addEdge(makeEdge('B', 'C'));
    const order = g.topologicalSort();
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('branching DAG: A→B, A→C, B→D, C→D', () => {
    for (const id of ['A', 'B', 'C', 'D']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('A', 'B'));
    g.addEdge(makeEdge('A', 'C'));
    g.addEdge(makeEdge('B', 'D'));
    g.addEdge(makeEdge('C', 'D'));
    const order = g.topologicalSort();
    // A before B and C; B and C before D
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
  });

  it('multiple roots', () => {
    g.addNode(makeNode('R1'));
    g.addNode(makeNode('R2'));
    g.addNode(makeNode('Leaf'));
    g.addEdge(makeEdge('R1', 'Leaf'));
    g.addEdge(makeEdge('R2', 'Leaf'));
    const order = g.topologicalSort();
    expect(order.length).toBe(3);
    // roots must come before Leaf
    expect(order.indexOf('R1')).toBeLessThan(order.indexOf('Leaf'));
    expect(order.indexOf('R2')).toBeLessThan(order.indexOf('Leaf'));
  });

  it('incomplete sort on cycle', () => {
    g.addNode(makeNode('a'));
    g.addNode(makeNode('b'));
    g.addNode(makeNode('c'));
    g.addEdge(makeEdge('a', 'b'));
    g.addEdge(makeEdge('b', 'a'));
    // c is isolated, should be in result
    const order = g.topologicalSort();
    expect(order).toContain('c');
    expect(order.length).toBeLessThan(3); // a and b stuck in cycle
  });

  it('empty graph returns empty array', () => {
    expect(g.topologicalSort()).toEqual([]);
  });
});

// ---------------------------------------------------------------
describe('Ancestors & Descendants', () => {
  let g: GraphMemoryManager;
  beforeEach(() => { g = new GraphMemoryManager(); });

  it('ancestors of leaf in chain', () => {
    for (const id of ['A', 'B', 'C']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('A', 'B'));
    g.addEdge(makeEdge('B', 'C'));
    expect(g.ancestors('C')).toEqual(expect.arrayContaining(['A', 'B']));
    expect(g.ancestors('A').length).toBe(0);
  });

  it('descendants of root in chain', () => {
    for (const id of ['A', 'B', 'C']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('A', 'B'));
    g.addEdge(makeEdge('B', 'C'));
    expect(g.descendants('A')).toEqual(expect.arrayContaining(['B', 'C']));
    expect(g.descendants('C').length).toBe(0);
  });

  it('returns empty for nonexistent node', () => {
    expect(g.ancestors('ghost')).toEqual([]);
    expect(g.descendants('ghost')).toEqual([]);
  });
});

// ---------------------------------------------------------------
describe('Isolated Nodes & Connected Components', () => {
  let g: GraphMemoryManager;
  beforeEach(() => { g = new GraphMemoryManager(); });

  it('isolated nodes', () => {
    g.addNode(makeNode('a'));
    g.addNode(makeNode('b'));
    g.addNode(makeNode('c'));
    g.addEdge(makeEdge('a', 'b'));
    // c has no edges
    expect(g.getIsolatedNodes()).toEqual(['c']);
  });

  it('connected components — two separate groups', () => {
    for (const id of ['A', 'B', 'C', 'D']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('A', 'B'));
    g.addEdge(makeEdge('C', 'D'));
    const comps = g.getConnectedComponents();
    expect(comps.length).toBe(2);
    // One component has {A,B}, the other has {C,D}
    const comp1 = comps.find(c => c.includes('A'))!;
    expect(comp1).toContain('B');
    expect(comp1).not.toContain('C');
  });

  it('all isolated', () => {
    g.addNode(makeNode('x'));
    g.addNode(makeNode('y'));
    const comps = g.getConnectedComponents();
    expect(comps.length).toBe(2);
    expect(g.getIsolatedNodes().length).toBe(2);
  });

  it('single fully connected component', () => {
    for (const id of ['a', 'b', 'c']) g.addNode(makeNode(id));
    g.addEdge(makeEdge('a', 'b'));
    g.addEdge(makeEdge('b', 'c'));
    expect(g.getConnectedComponents()).toEqual([['a', 'b', 'c']]);
  });
});

// ---------------------------------------------------------------
describe('Serialize / Deserialize / Clone', () => {
  let g: GraphMemoryManager;
  beforeEach(() => { g = new GraphMemoryManager(); });

  it('round-trip serialization preserves data', () => {
    g.addNode(makeNode('a'));
    g.addNode(makeNode('b'));
    g.addEdge(makeEdge('a', 'b'));
    const json = g.serialize();
    const g2 = new GraphMemoryManager();
    g2.deserialize(json);
    expect(g2.getNodeCount()).toBe(2);
    expect(g2.getEdgeCount()).toBe(1);
    expect(g2.getNode('a')).toBeDefined();
    expect(g2.getEdge('a', 'b')).toBeDefined();
  });

  it('clone produces independent copy', () => {
    g.addNode(makeNode('x'));
    g.addEdge(makeEdge('x', 'x')); // self-loop for testing independence
    const cloned = g.clone();
    expect(cloned.getNodeCount()).toBe(1);
    cloned.removeNode('x');
    expect(g.getNodeCount()).toBe(1); // original unchanged
  });

  it('clone does not share mutable state', () => {
    g.addNode(makeNode('p', 'memory', { tag: 'test' }));
    const c = g.clone();
    c.updateNode('p', { weight: 99 });
    expect(g.getNode('p')!.weight).toBeUndefined();
    expect(c.getNode('p')!.weight).toBe(99);
  });
});

// ---------------------------------------------------------------
describe('Statistics', () => {
  let g: GraphMemoryManager;
  beforeEach(() => { g = new GraphMemoryManager(); });

  it('node and edge counts', () => {
    expect(g.getNodeCount()).toBe(0);
    expect(g.getEdgeCount()).toBe(0);
    g.addNode(makeNode('a'));
    g.addNode(makeNode('b'));
    g.addEdge(makeEdge('a', 'b'));
    expect(g.getNodeCount()).toBe(2);
    expect(g.getEdgeCount()).toBe(1);
  });
});
