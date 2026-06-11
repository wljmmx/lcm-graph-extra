// ============================================================
// DAG Lifecycle Management — create, merge, archive, diff
// ============================================================

import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';
import { GraphMemoryManager, GraphNode, GraphEdge } from './graph';

// ---------- types ---------------------------------------------------------

export interface DAGMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  memoryDir: string;
  nodeCount: number;
  edgeCount: number;
  tags?: string[];
}

export interface DAGSnapshot {
  metadata: DAGMetadata;
  graph: GraphMemoryManager;
}

// ---------- internal helpers on GraphMemoryManager ------------------------

function allNodeEntries(g: GraphMemoryManager): [string, GraphNode][] {
  return g._allNodeEntries();
}

function allEdges(g: GraphMemoryManager): GraphEdge[] {
  return g._allEdges();
}

// ---------- parseMemoryFile -----------------------------------------------

/**
 * Parse an OpenClaw .md memory file and extract structured entries.
 * Recognises `<!-- openclaw-memory-promotion:... -->` comment markers,
 * ATX headings (# / ## / ###), or falls back to a whole-file entry.
 *
 * Enhanced: also extracts `score` from promotion blocks and returns
 * a `sourceRef` field pointing to the source file.
 */
export function parseMemoryFile(
  filePath: string,
): Array<{ id: string; title: string; content: string; timestamp: string; score?: number; sourceRef: string }> {
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf-8');
  const entries: Array<{ id: string; title: string; content: string; timestamp: string; score?: number; sourceRef: string }> = [];

  // --- Strategy A: openclaw-memory-promotion comment blocks ------------
  const promotionRe = /<!--\s*openclaw-memory-promotion:([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = promotionRe.exec(raw)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/title:?(.+?)(?:\n|$)/i);
    const tsMatch = block.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/);
    // Enhanced: extract score field
    let score: number | undefined;
    const scoreMatch = block.match(/score:?\s*([\d]+(?:\.[\d]+)?)/i);
    if (scoreMatch) {
      score = parseFloat(scoreMatch[1]);
    }
    entries.push({
      id: `promo-${m.index}`,
      title: titleMatch ? titleMatch[1].trim() : '',
      content: block,
      timestamp: tsMatch ? tsMatch[0] : new Date().toISOString(),
      score,
      sourceRef: filePath,
    });
  }

  // --- Strategy B: ATX headings as natural sections --------------------
  const headingRe = /^(#{1,4})\s+(.+)$/gm;
  const sections: Array<{ level: number; title: string; line: number }> = [];
  let h: RegExpExecArray | null;
  while ((h = headingRe.exec(raw)) !== null) {
    sections.push({
      level: h[1].length,
      title: h[2].trim(),
      line: raw.substring(0, h.index).split('\n').length,
    });
  }

  const lines = raw.split('\n');
  for (let i = 0; i < sections.length; i++) {
    const startLine = sections[i].line;
    const endLine = i + 1 < sections.length ? sections[i + 1].line : lines.length;
    const contentBlock = lines.slice(startLine, endLine).join('\n').trim();

    // Skip if already captured by promotion blocks
    if (contentBlock.includes('openclaw-memory-promotion')) continue;

    const tsMatch = contentBlock.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/);
    entries.push({
      id: `section-${i}`,
      title: sections[i].title,
      content: contentBlock,
      timestamp: tsMatch ? tsMatch[0] : new Date().toISOString(),
      sourceRef: filePath,
    });
  }

  // --- Strategy C: file-level fallback ---------------------------------
  if (entries.length === 0) {
    const baseName = path.basename(filePath, '.md');
    const stat = fs.statSync(filePath);
    entries.push({
      id: `file-${baseName}`,
      title: baseName,
      content: raw.trim(),
      timestamp: stat.mtime.toISOString(),
      sourceRef: filePath,
    });
  }

  return entries;
}

// ---------- createDAG -----------------------------------------------------

/**
 * Scan a memory directory for `.md` files, parse each one,
 * create GraphNodes and auto-wire temporal edges.
 */
export function createDAG(
  memoryDir: string,
  options?: { id?: string; tags?: string[] },
): DAGSnapshot {
  const now = new Date().toISOString();
  const dagId = options?.id ?? `dag-${Date.now()}`;

  const manager = new GraphMemoryManager();

  if (!fs.existsSync(memoryDir)) {
    return {
      metadata: {
        id: dagId,
        createdAt: now,
        updatedAt: now,
        memoryDir,
        nodeCount: 0,
        edgeCount: 0,
        tags: options?.tags,
      },
      graph: manager,
    };
  }

  const mdFiles = fs.readdirSync(memoryDir)
    .filter((f: string) => f.endsWith('.md'))
    .map((f: string) => path.join(memoryDir, f))
    .sort();

  for (const fp of mdFiles) {
    const parsed = parseMemoryFile(fp);
    for (const entry of parsed) {
      const node: GraphNode = {
        id: `${path.basename(fp, '.md')}:${entry.id}`,
        type: 'memory',
        title: entry.title,
        content: entry.content.length > 4096 ? entry.content.slice(0, 4096) : entry.content,
        metadata: { sourceFile: fp },
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
        weight: 1.0,
      };
      manager.addNode(node);
    }
  }

  // --- auto-wire edges by temporal proximity ---------------------------
  const sortedEntries = allNodeEntries(manager).sort(
    (a, b) => new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime(),
  );

  for (let i = 1; i < sortedEntries.length; i++) {
    const prevId = sortedEntries[i - 1][0];
    const currId = sortedEntries[i][0];
    manager.addEdge({
      source: prevId,
      target: currId,
      relationType: 'references',
      weight: 0.5,
      createdAt: now,
    });
  }

  return {
    metadata: {
      id: dagId,
      createdAt: now,
      updatedAt: now,
      memoryDir,
      nodeCount: manager.getNodeCount(),
      edgeCount: manager.getEdgeCount(),
      tags: options?.tags,
    },
    graph: manager,
  };
}

// ---------- mergeDAG ------------------------------------------------------

export function mergeDAG(
  source: DAGSnapshot,
  target: DAGSnapshot,
  strategy: 'prefer_newer' | 'prefer_source' | 'weight_based' = 'prefer_newer',
): DAGSnapshot {
  const mergedGraph = target.graph.clone();
  const now = new Date().toISOString();

  const sourceNodes = allNodeEntries(source.graph);
  for (const [, sNode] of sourceNodes) {
    const existing = mergedGraph.getNode(sNode.id);
    if (!existing) {
      mergedGraph.addNode({ ...sNode });
    } else {
      let keep: GraphNode;
      if (strategy === 'prefer_newer') {
        keep = new Date(sNode.updatedAt) >= new Date(existing.updatedAt) ? sNode : existing;
      } else if (strategy === 'prefer_source') {
        keep = sNode;
      } else {
        // weight_based
        const sw = sNode.weight ?? 0;
        const ew = existing.weight ?? 0;
        keep = sw >= ew ? sNode : existing;
      }
      mergedGraph.updateNode(sNode.id, keep);
    }
  }

  // Merge edges (avoid duplicates unless prefer_source)
  const sourceEdges = allEdges(source.graph);
  const existingEdgeKeys = new Set<string>();
  for (const e of allEdges(mergedGraph)) {
    existingEdgeKeys.add(`${e.source}->${e.target}`);
  }

  for (const e of sourceEdges) {
    const key = `${e.source}->${e.target}`;
    if (strategy === 'prefer_source') {
      // Replace edge from target with source's version
      mergedGraph.removeEdge(e.source, e.target);
      if (mergedGraph.getNode(e.source) && mergedGraph.getNode(e.target)) {
        mergedGraph.addEdge({ ...e });
      }
    } else if (!existingEdgeKeys.has(key)) {
      // Add only if both endpoints exist
      if (mergedGraph.getNode(e.source) && mergedGraph.getNode(e.target)) {
        mergedGraph.addEdge({ ...e });
      }
    }
  }

  return {
    metadata: {
      id: `merged-${now.replace(/[:.]/g, '-')}`,
      createdAt: now,
      updatedAt: now,
      memoryDir: target.metadata.memoryDir,
      nodeCount: mergedGraph.getNodeCount(),
      edgeCount: mergedGraph.getEdgeCount(),
      tags: [...new Set([...(source.metadata.tags ?? []), ...(target.metadata.tags ?? [])])],
    },
    graph: mergedGraph,
  };
}

// ---------- archiveDAG ----------------------------------------------------

export async function archiveDAG(
  dag: DAGSnapshot,
  archiveDir = './archives',
): Promise<{ archivedAt: string; path: string }> {
  const now = new Date().toISOString();

  fs.mkdirSync(archiveDir, { recursive: true });

  const data = {
    metadata: dag.metadata,
    graphData: dag.graph.serialize(),
    archivedAt: now,
  };
  const json = JSON.stringify(data, null, 2);
  const fileName = `dag-${dag.metadata.id}-${now.replace(/[:.]/g, '-')}.json`;

  const tmpPath = path.join(archiveDir, `${fileName}.tmp`);
  fs.writeFileSync(tmpPath, json, 'utf-8');

  try {
    const outPath = path.join(archiveDir, fileName.replace(/\.json$/, '.tar.gz'));
    const gzipData = zlib.gzipSync(Buffer.from(json, "utf-8"));
    fs.writeFileSync(outPath, gzipData);
    return { archivedAt: now, path: outPath };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* already removed by tar */ }
  }
}

// ---------- diffDAGs ------------------------------------------------------

export function diffDAGs(
  old_: DAGSnapshot,
  new_?: DAGSnapshot,
): { added: string[]; removed: string[]; changed: string[] } {
  const oldEntries = allNodeEntries(old_.graph);
  const oldIds = new Set(oldEntries.map(([id]) => id));
  const newNodeEntries = new_ ? allNodeEntries(new_.graph) : [];
  const newIdSet = new Set(newNodeEntries.map(([id]) => id));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const id of oldIds) {
    if (!newIdSet.has(id)) {
      removed.push(id);
    }
  }
  for (const [id] of newNodeEntries) {
    if (!oldIds.has(id)) {
      added.push(id);
    } else if (new_) {
      const oldNode = old_.graph.getNode(id)!;
      const newNode = new_.graph.getNode(id)!;
      if (oldNode.updatedAt !== newNode.updatedAt || oldNode.content !== newNode.content) {
        changed.push(id);
      }
    }
  }

  return { added, removed, changed };
}

// ---------- load / save helpers -------------------------------------------

export function loadDAGFromDir(memoryDir: string): DAGSnapshot {
  return createDAG(memoryDir);
}

export function saveDAGToDisk(dag: DAGSnapshot, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (dir) fs.mkdirSync(dir, { recursive: true });

  const payload = {
    metadata: dag.metadata,
    graphData: dag.graph.serialize(),
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function loadDAGFromDisk(filePath: string): DAGSnapshot {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);

  const graph = new GraphMemoryManager();
  graph.deserialize(parsed.graphData);

  return {
    metadata: parsed.metadata,
    graph,
  };
}

// ============================================================
// New API — buildGraphFromMemoryFiles & incrementalUpdate
// ============================================================

export interface BuildOptions {
  maxDepth?: number;              // limit node depth in the DAG
  autoLinkTemporal?: boolean;     // default true — link adjacent nodes by time
  excludePatterns?: string[];     // glob-like patterns to exclude files
}

/**
 * Scan a memory directory, parse every .md file (respecting exclusions),
 * create GraphNodes and wire temporal `depends_on` edges.
 */
export async function buildGraphFromMemoryFiles(
  memoryDir: string,
  options?: BuildOptions,
): Promise<DAGSnapshot> {
  const now = new Date().toISOString();

  const manager = new GraphMemoryManager();

  if (!fs.existsSync(memoryDir)) {
    return {
      metadata: {
        id: `dag-${Date.now()}`,
        createdAt: now,
        updatedAt: now,
        memoryDir,
        nodeCount: 0,
        edgeCount: 0,
      },
      graph: manager,
    };
  }

  const allFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md'));
  const excludePatterns = options?.excludePatterns ?? [];

  // simple glob-like match: supports '*' and '?' wildcards
  function matchesPattern(fileName: string, pattern: string): boolean {
    const regexSource = '^' + pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$';
    return new RegExp(regexSource).test(fileName);
  }

  const includedFiles = allFiles.filter((f) => {
    return !excludePatterns.some((p) => matchesPattern(f, p));
  });

  // Parse every file and collect (node, timestamp) tuples
  const nodeList: Array<{ node: GraphNode; ts: number }> = [];
  for (const fileName of includedFiles) {
    const fp = path.join(memoryDir, fileName);
    const parsed = parseMemoryFile(fp);
    for (const entry of parsed) {
      const node: GraphNode = {
        id: `${path.basename(fp, '.md')}:${entry.id}`,
        type: 'memory',
        title: entry.title,
        content: entry.content.length > 4096 ? entry.content.slice(0, 4096) : entry.content,
        metadata: { sourceFile: fp },
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
        weight: 1.0,
      };
      manager.addNode(node);
      nodeList.push({ node, ts: new Date(entry.timestamp).getTime() });
    }
  }

  // Auto-link by temporal order (unless disabled)
  if (options?.autoLinkTemporal !== false) {
    nodeList.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < nodeList.length; i++) {
      manager.addEdge({
        source: nodeList[i - 1].node.id,
        target: nodeList[i].node.id,
        relationType: 'depends_on',
        weight: 0.5,
        createdAt: now,
      });
    }
  }

  // maxDepth enforcement: prune nodes whose depth exceeds the limit
  if (typeof options?.maxDepth === 'number') {
    const toRemove: string[] = [];
    for (const [id] of allNodeEntries(manager)) {
      try {
        const depth = manager.getDepth(id);
        if (depth > options.maxDepth) {
          toRemove.push(id);
        }
      } catch {
        // cycle detected or other issue; skip pruning
      }
    }
    for (const id of toRemove) {
      manager.removeNode(id);
    }
  }

  return {
    metadata: {
      id: `dag-${Date.now()}`,
      createdAt: now,
      updatedAt: now,
      memoryDir,
      nodeCount: manager.getNodeCount(),
      edgeCount: manager.getEdgeCount(),
    },
    graph: manager,
  };
}

/**
 * Incrementally update an existing DAG by scanning the file system for
 * new or modified .md files and updating only the affected nodes.
 */
export async function incrementalUpdate(
  dag: DAGSnapshot,
  memoryDir: string,
  options?: BuildOptions,
): Promise<DAGSnapshot> {
  // Clone so we don't mutate the caller's DAG
  const updatedGraph = dag.graph.clone();
  const now = new Date().toISOString();

  if (!fs.existsSync(memoryDir)) {
    return { ...dag, graph: updatedGraph };
  }

  const excludePatterns = options?.excludePatterns ?? [];

  function matchesPattern(fileName: string, pattern: string): boolean {
    const regexSource = '^' + pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$';
    return new RegExp(regexSource).test(fileName);
  }

  // Build map of fileName -> existing nodes from the current DAG
  const existingNodesByFile = new Map<string, { ids: string[]; contentHashes: Set<string> }>();
  for (const [id, node] of allNodeEntries(updatedGraph)) {
    const sf = typeof node.metadata?.sourceFile === 'string' ? node.metadata.sourceFile : '';
    const baseName = path.basename(sf, '.md');
    if (!baseName) continue;
    if (excludePatterns.some((p) => matchesPattern(baseName, p))) continue;

    const existing = existingNodesByFile.get(baseName);
    const h = node.content ? node.content.slice(0, 100) : '';
    if (!existing) {
      existingNodesByFile.set(baseName, { ids: [id], contentHashes: new Set([h]) });
    } else {
      existing.ids.push(id);
      existing.contentHashes.add(h);
    }
  }

  // Scan filesystem for included .md files
  const allFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md'));
  const includedFiles = allFiles.filter((f) => {
    return !excludePatterns.some((p) => matchesPattern(f, p));
  });

  const changedFileNames: Set<string> = new Set();

  for (const fileName of includedFiles) {
    const fp = path.join(memoryDir, fileName);
    const parsed = parseMemoryFile(fp);

    // Compute a content signature from the parsed entries
    const currentHashes = new Set<string>();
    for (const entry of parsed) {
      currentHashes.add(entry.content.slice(0, 100));
    }

    const existing = existingNodesByFile.get(fileName);

    if (!existing) {
      // New file not in DAG
      changedFileNames.add(fileName);
    } else {
      // Check if content changed
      let contentChanged = false;
      for (const h of currentHashes) {
        if (!existing.contentHashes.has(h)) {
          contentChanged = true;
          break;
        }
      }
      for (const h of existing.contentHashes) {
        if (!currentHashes.has(h)) {
          contentChanged = true;
          break;
        }
      }
      if (contentChanged || currentHashes.size !== existing.contentHashes.size) {
        changedFileNames.add(fileName);
      }
    }
  }

  // Remove old nodes for changed files
  const fileToIds = new Map<string, string[]>();
  for (const [id, node] of allNodeEntries(updatedGraph)) {
    const sf = typeof node.metadata?.sourceFile === 'string' ? node.metadata.sourceFile : '';
    const baseName = path.basename(sf, '.md');
    if (!fileToIds.has(baseName)) fileToIds.set(baseName, []);
    fileToIds.get(baseName)!.push(id);
  }

  for (const fileName of changedFileNames) {
    const ids = fileToIds.get(fileName) ?? [];
    for (const id of ids) {
      updatedGraph.removeNode(id);
    }
  }

  // Re-add nodes for changed/new files
  for (const fileName of changedFileNames) {
    const fp = path.join(memoryDir, fileName);
    const parsed = parseMemoryFile(fp);
    for (const entry of parsed) {
      const node: GraphNode = {
        id: `${path.basename(fp, '.md')}:${entry.id}`,
        type: 'memory',
        title: entry.title,
        content: entry.content.length > 4096 ? entry.content.slice(0, 4096) : entry.content,
        metadata: { sourceFile: fp },
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
        weight: 1.0,
      };
      updatedGraph.addNode(node);
    }
  }

  // Re-wire all temporal edges (simple approach — rebuild the full chain)
  if (options?.autoLinkTemporal !== false) {
    const allNodes = allNodeEntries(updatedGraph);
    const sorted = allNodes.sort(
      (a, b) => new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime(),
    );

    // Clear existing edges and rebuild
    const currentEdges = allEdges(updatedGraph);
    for (const e of currentEdges) {
      updatedGraph.removeEdge(e.source, e.target);
    }

    for (let i = 1; i < sorted.length; i++) {
      updatedGraph.addEdge({
        source: sorted[i - 1][0],
        target: sorted[i][0],
        relationType: 'depends_on',
        weight: 0.5,
        createdAt: now,
      });
    }
  }

  return {
    metadata: {
      id: dag.metadata.id,
      createdAt: dag.metadata.createdAt,
      updatedAt: now,
      memoryDir: dag.metadata.memoryDir,
      nodeCount: updatedGraph.getNodeCount(),
      edgeCount: updatedGraph.getEdgeCount(),
      tags: dag.metadata.tags,
    },
    graph: updatedGraph,
  };
}
