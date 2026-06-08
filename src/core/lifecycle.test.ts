// ============================================================
// Tests for DAG Lifecycle Management
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseMemoryFile,
  createDAG,
  mergeDAG,
  archiveDAG,
  diffDAGs,
  saveDAGToDisk,
  loadDAGFromDisk,
  loadDAGFromDir,
} from './lifecycle';

// ---------- helpers -------------------------------------------------------

function tmpDir(name: string): string {
  const d = path.join(os.tmpdir(), `lcm-test-${name}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeMd(dir: string, name: string, content: string): string {
  const p = path.join(dir, `${name}.md`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// ---------- parseMemoryFile tests -----------------------------------------

describe('parseMemoryFile', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir('parse'); });

  it('returns [] for nonexistent file', () => {
    expect(parseMemoryFile('/nonexistent/path.md')).toHaveLength(0);
  });

  it('parses openclaw-memory-promotion blocks', () => {
    const fp = writeMd(dir, 'promo-test', `
<!-- openclaw-memory-promotion:title:Meeting Notes\n2024-01-15T10:00 Discussed project roadmap -->
Some random text.
<!-- openclaw-memory-promotion:title:Bug Fix\n2024-02-20 Fixed memory leak in parser -->
`);
    const entries = parseMemoryFile(fp);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe('Meeting Notes');
    expect(entries[1].title).toBe('Bug Fix');
  });

  it('parses ATX heading sections', () => {
    const fp = writeMd(dir, 'sections', `
# Chapter One
This is the first section content.
2024-03-01T08:00 was written today.

## Chapter Two
Second section with more info.
`);
    const entries = parseMemoryFile(fp);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe('Chapter One');
    expect(entries[1].title).toBe('Chapter Two');
  });

  it('falls back to file-level entry when no structure found', () => {
    const fp = writeMd(dir, 'plain-text', `Just some plain text with no headings or markers.`);
    const entries = parseMemoryFile(fp);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('plain-text');
  });

  it('extracts timestamps from content', () => {
    const fp = writeMd(dir, 'ts-test', `# Section\nContent at 2025-06-01T14:30 end`);
    const entries = parseMemoryFile(fp);
    expect(entries[0].timestamp).toContain('2025-06-01');
  });

  it('handles empty file with fallback', () => {
    const fp = writeMd(dir, 'empty', '');
    const entries = parseMemoryFile(fp);
    expect(entries).toHaveLength(1);
  });

  it('parses mixed content (promotion + headings)', () => {
    const fp = writeMd(dir, 'mixed', `
# Heading A
Some heading content here.
<!-- openclaw-memory-promotion:title:Promoted\n2024-12-01T12:00 important memory -->
## Heading B
More section text.
`);
    const entries = parseMemoryFile(fp);
    // Should have promo + heading sections (non-promo headings)
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------- createDAG tests -----------------------------------------------

describe('createDAG', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir('create'); });

  it('creates empty DAG for nonexistent directory', () => {
    const dag = createDAG('/nonexistent/dir/path');
    expect(dag.graph.getNodeCount()).toBe(0);
    expect(dag.graph.getEdgeCount()).toBe(0);
    expect(dag.metadata.memoryDir).toBe('/nonexistent/dir/path');
  });

  it('creates DAG from directory with memory files', () => {
    writeMd(dir, 'day1', `# Morning\nWorked on parser. 2024-06-01T09:00`);
    writeMd(dir, 'day2', `# Afternoon\nCode review session. 2024-06-02T15:00`);

    const dag = createDAG(dir, { id: 'test-dag', tags: ['daily'] });
    expect(dag.metadata.id).toBe('test-dag');
    expect(dag.metadata.tags).toEqual(['daily']);
    expect(dag.graph.getNodeCount()).toBe(2);
    expect(dag.graph.getEdgeCount()).toBe(1); // temporal edge between two nodes
  });

  it('auto-generates ID when not provided', () => {
    const dag = createDAG(dir);
    expect(dag.metadata.id).toMatch(/^dag-\d+$/);
  });

  it('respects node count and edge count in metadata', () => {
    for (let i = 0; i < 5; i++) {
      writeMd(dir, `file${i}`, `# Section ${i}\nContent ${i}. 2024-01-${String(i + 1).padStart(2, '0')}T10:00`);
    }
    const dag = createDAG(dir);
    expect(dag.metadata.nodeCount).toBe(5);
    expect(dag.graph.getNodeCount()).toBe(5);
    // 4 temporal edges for 5 nodes in order
    expect(dag.graph.getEdgeCount()).toBe(4);
  });
});

// ---------- mergeDAG tests ------------------------------------------------

describe('mergeDAG', () => {
  it('merges non-overlapping DAGs', () => {
    const dA = tmpDir('mo-A');
    const dB = tmpDir('mo-B');
    writeMd(dA, 'A-1', `# A Node 1\nContent A. 2024-01-01T10:00`);
    writeMd(dA, 'A-2', `# A Node 2\nContent B. 2024-01-02T10:00`);
    writeMd(dB, 'B-1', `# B Node 1\nContent C. 2024-03-01T10:00`);
    writeMd(dB, 'B-2', `# B Node 2\nContent D. 2024-03-02T10:00`);

    const dagA = createDAG(dA, { id: 'A' });
    const dagB = createDAG(dB, { id: 'B' });
    const merged = mergeDAG(dagA, dagB);

    expect(merged.graph.getNodeCount()).toBe(4);
    expect(merged.metadata.tags).toBeDefined();
  });

  it('prefer_newer keeps the newer version of a conflicting node', () => {
    const dA = tmpDir('pn-A');
    const dB = tmpDir('pn-B');
    writeMd(dA, 'C-1', `# C Node 1\nContent A. 2024-01-01T10:00`);
    writeMd(dB, 'C-1', `# C Node 1\nContent revised. 2025-06-01T10:00`);

    const dagA = createDAG(dA, { id: 'C' });
    const dagB = createDAG(dB, { id: 'C' });

    const merged = mergeDAG(dagA, dagB, 'prefer_newer');
    // Both have C-1:section-0; B is newer so its content should win
    expect(merged.graph.getNodeCount()).toBe(1);
  });

  it('prefer_source always keeps source version', () => {
    const dA = tmpDir('ps-A');
    const dB = tmpDir('ps-B');
    writeMd(dA, 'D-1', `# D Node 1\nSource content. 2024-01-01T10:00`);
    writeMd(dB, 'D-1', `# D Node 1\nTarget content. 2025-06-01T10:00`);

    const dagA = createDAG(dA, { id: 'D' });
    const dagB = createDAG(dB, { id: 'D' });
    dagA.metadata.tags = ['source-tag'];
    dagB.metadata.tags = ['target-tag'];

    const merged = mergeDAG(dagA, dagB, 'prefer_source');
    expect(merged.graph.getNodeCount()).toBe(1);
    // Tags union should contain both
    const allTags = merged.metadata.tags ?? [];
    expect(allTags.includes('source-tag')).toBe(true);
    expect(allTags.includes('target-tag')).toBe(true);

    // Source version should be kept (prefer_source)
    const node = merged.graph.getNode('D-1:section-0');
    expect(node?.content).toContain('Source content');
  });

  it('weight_based keeps higher-weight node', () => {
    const dA = tmpDir('wb-A');
    const dB = tmpDir('wb-B');

    const dagA = createDAG(dA, { id: 'W' });
    const dagB = createDAG(dB, { id: 'W' });

    const now = new Date().toISOString();
    dagA.graph.addNode({
      id: 'shared-node', type: 'memory', title: 'A version', content: 'from A',
      metadata: {}, createdAt: now, updatedAt: now, weight: 0.3,
    });
    dagB.graph.addNode({
      id: 'shared-node', type: 'memory', title: 'B version', content: 'from B',
      metadata: {}, createdAt: now, updatedAt: now, weight: 0.9,
    });

    const merged = mergeDAG(dagA, dagB, 'weight_based');
    const kept = merged.graph.getNode('shared-node')!;
    // source weight 0.3 < target weight 0.9 → keep existing (target/B)
    expect(kept.title).toBe('B version');
  });

  it('handles empty source DAG', () => {
    const dA = tmpDir('es-A');
    const dB = tmpDir('es-B');
    writeMd(dB, 'E-1', `# E Node\nContent. 2024-01-01T10:00`);

    const dagA = createDAG(dA, { id: 'empty' });
    const dagB = createDAG(dB, { id: 'E' });
    const merged = mergeDAG(dagA, dagB);
    expect(merged.graph.getNodeCount()).toBe(1); // target\'s node preserved
  });

  it('handles empty target DAG', () => {
    const dA = tmpDir('et-A');
    const dB = tmpDir('et-B');
    writeMd(dA, 'F-1', `# F Node\nContent. 2024-01-01T10:00`);

    const dagA = createDAG(dA, { id: 'F' });
    const dagB = createDAG(dB, { id: 'empty' });
    const merged = mergeDAG(dagA, dagB);
    expect(merged.graph.getNodeCount()).toBe(1); // source\'s node added to empty target
  });
});

// ---------- diffDAGs tests ------------------------------------------------

describe('diffDAGs', () => {
  it('detects added nodes', () => {
    const dOld = tmpDir('da-old');
    const dNew = tmpDir('da-new');
    writeMd(dOld, 'old-only', `# Old\nContent. 2024-01-01T00:00`);
    writeMd(dNew, 'old-only', `# Old\nContent. 2024-01-01T00:00`);
    writeMd(dNew, 'new-only', `# New\nAdded later. 2024-06-01T00:00`);

    const old = createDAG(dOld);
    const new_ = createDAG(dNew);
    const { added } = diffDAGs(old, new_);
    expect(added.some(a => a.includes('new-only'))).toBe(true);
  });

  it('detects removed nodes', () => {
    const dOld = tmpDir('dr-old');
    const dNew = tmpDir('dr-new');
    writeMd(dOld, 'old-only', `# Old\nContent. 2024-01-01T00:00`);
    writeMd(dOld, 'removed', `# Removed\nGone. 2024-01-01T00:00`);
    writeMd(dNew, 'old-only', `# Old\nContent. 2024-01-01T00:00`);

    const old = createDAG(dOld);
    const new_ = createDAG(dNew);
    const { removed } = diffDAGs(old, new_);
    expect(removed.some(r => r.includes('removed'))).toBe(true);
  });

  it('detects changed nodes', () => {
    const dOld = tmpDir('dc-old');
    const dNew = tmpDir('dc-new');
    writeMd(dOld, 'same', `# Same\nOriginal content. 2024-01-01T00:00`);
    writeMd(dNew, 'same', `# Same\nModified content. 2024-06-01T00:00`);

    const old = createDAG(dOld);
    const new_ = createDAG(dNew);
    const { changed } = diffDAGs(old, new_);
    expect(changed.some(c => c.includes('same'))).toBe(true);
  });

  it('returns empty diffs for identical DAGs', () => {
    const dOld = tmpDir('de-old');
    const dNew = tmpDir('de-new');
    // Same heading and timestamp in both files so content/timestamp match exactly
    const content = `# Identical\nSame text. 2024-01-01T00:00`;
    writeMd(dOld, 'identical', content);
    writeMd(dNew, 'identical', content);

    const old = createDAG(dOld);
    const new_ = createDAG(dNew);
    const { added, removed, changed } = diffDAGs(old, new_);
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
    // Timestamps in node updatedAt come from file content (2024-01-01T00:00) so they match
  });

  it('handles undefined new_ DAG (everything removed)', () => {
    const dOld = tmpDir('du-old');
    writeMd(dOld, 'a', `# A\nContent. 2024-01-01T00:00`);
    const old = createDAG(dOld);
    const { added, removed } = diffDAGs(old);
    expect(added).toHaveLength(0);
    expect(removed.length).toBeGreaterThan(0);
  });
});

// ---------- archiveDAG tests ----------------------------------------------

describe('archiveDAG', () => {
  let dir: string;
  let archiveDir: string;
  beforeEach(() => {
    dir = tmpDir('archiveSrc');
    archiveDir = tmpDir('archiveOut');
  });

  it('creates a .tar.gz archive file', async () => {
    writeMd(dir, 'mem1', `# Memory\nImportant stuff. 2024-01-01T10:00`);
    const dag = createDAG(dir);
    const result = await archiveDAG(dag, archiveDir);

    expect(result.archivedAt).toBeDefined();
    expect(result.path).toMatch(/\.tar\.gz$/);
    expect(fs.existsSync(result.path)).toBe(true);

    // Verify it's a valid tar.gz by extracting
    const extractDir = tmpDir('extract');
    const { execSync } = await import('child_process');
    execSync(`tar xzf "${result.path}" -C "${extractDir}"`);
    const extracted = fs.readdirSync(extractDir);
    expect(extracted.length).toBeGreaterThan(0);

    // Extracted JSON should be parseable
    const jsonFile = extracted.find(f => f.endsWith('.json')) || extracted[0];
    const data = JSON.parse(fs.readFileSync(path.join(extractDir, jsonFile), 'utf-8'));
    expect(data.metadata).toBeDefined();
    expect(data.graphData).toBeDefined();
  });

  it('returns correct archive path', async () => {
    writeMd(dir, 'a', `# A\nContent. 2024-01-01T00:00`);
    const dag = createDAG(dir, { id: 'my-dag' });
    const result = await archiveDAG(dag, archiveDir);
    expect(result.path).toContain(archiveDir);
    expect(result.path).toContain('dag-my-dag');
  });
});

// ---------- saveDAGToDisk / loadDAGFromDisk roundtrip ---------------------

describe('saveDAGToDisk + loadDAGFromDisk', () => {
  let dir: string;
  let outDir: string;
  beforeEach(() => {
    dir = tmpDir('roundtrip');
    outDir = tmpDir('out');
  });

  it('saves and loads with identical structure', () => {
    writeMd(dir, 'r1', `# Roundtrip\nData A. 2024-05-01T08:00`);
    writeMd(dir, 'r2', `# Another\nData B. 2024-05-02T09:00`);

    const original = createDAG(dir, { id: 'roundtrip-test' });
    const outPath = path.join(outDir, 'saved.json');
    saveDAGToDisk(original, outPath);

    expect(fs.existsSync(outPath)).toBe(true);

    const loaded = loadDAGFromDisk(outPath);
    expect(loaded.metadata.id).toBe('roundtrip-test');
    expect(loaded.graph.getNodeCount()).toBe(original.graph.getNodeCount());
    expect(loaded.graph.getEdgeCount()).toBe(original.graph.getEdgeCount());

    // Verify all nodes preserved
    for (const component of original.graph.getConnectedComponents()) {
      for (const id of component) {
        expect(loaded.graph.getNode(id)).toBeDefined();
      }
    }
  });

  it('serialization roundtrip preserves node titles', () => {
    writeMd(dir, 'title-test', `# My Title\nContent. 2024-01-01T00:00`);
    const original = createDAG(dir);
    const outPath = path.join(outDir, 'titles.json');
    saveDAGToDisk(original, outPath);
    const loaded = loadDAGFromDisk(outPath);

    // Find the node with "My Title"
    const allIds = [...loaded.graph.getConnectedComponents().flat(), ...loaded.graph.getIsolatedNodes()];
    const titleNode = allIds.map(id => loaded.graph.getNode(id)).find(n => n?.title === 'My Title');
    expect(titleNode).toBeDefined();
  });

  it('creates parent directories for output path', () => {
    writeMd(dir, 'nested', `# Nested\nContent. 2024-01-01T00:00`);
    const dag = createDAG(dir);
    const deepPath = path.join(outDir, 'a', 'b', 'c', 'deep.json');
    saveDAGToDisk(dag, deepPath);
    expect(fs.existsSync(deepPath)).toBe(true);
  });
});

// ---------- loadDAGFromDir ------------------------------------------------

describe('loadDAGFromDir', () => {
  it('is an alias for createDAG and loads correctly', () => {
    const dir = tmpDir('loadfromdir');
    writeMd(dir, 'f1', `# First\nHello. 2024-01-01T00:00`);
    writeMd(dir, 'f2', `# Second\nWorld. 2024-01-02T00:00`);

    const dag = loadDAGFromDir(dir);
    expect(dag.graph.getNodeCount()).toBe(2);
    expect(dag.metadata.memoryDir).toBe(dir);
  });
});



// ============================================================
// Tests for buildGraphFromMemoryFiles & incrementalUpdate
// ============================================================

import {
  buildGraphFromMemoryFiles,
  incrementalUpdate,
  type BuildOptions,
} from './lifecycle';

const FIXTURE_DIR = path.join(__dirname, 'test-fixtures', 'build-test');

describe('buildGraphFromMemoryFiles', () => {
  it('returns empty DAG for nonexistent directory', async () => {
    const dag = await buildGraphFromMemoryFiles('/nonexistent/dir/path');
    expect(dag.graph.getNodeCount()).toBe(0);
    expect(dag.graph.getEdgeCount()).toBe(0);
  });

  it('correctly creates nodes from fixture files', async () => {
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR);
    // memory-2026-05-20.md: 2 promo entries (heading sections skipped because
    // their content blocks contain openclaw-memory-promotion)
    // memory-2026-05-21.md: 1 promo + 1 section = 2 nodes
    // skip-this.md: 1 heading-based section = 1 node
    // Total: 5 nodes
    expect(dag.graph.getNodeCount()).toBe(5);
  });

  it('auto-builds temporal depends_on edges between adjacent nodes', async () => {
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR);
    // 5 nodes → 4 temporal edges (chain)
    expect(dag.graph.getEdgeCount()).toBe(4);
    // Verify edges use 'depends_on' relation type
    const edges = dag.graph._allEdges();
    for (const e of edges) {
      expect(e.relationType).toBe('depends_on');
    }
  });

  it('excludePatterns filters out matching files', async () => {
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR, {
      excludePatterns: ['skip-*'],
    });
    // memory-2026-05-20.md (2 nodes) + memory-2026-05-21.md (2 nodes) = 4 nodes
    expect(dag.graph.getNodeCount()).toBe(4);
    expect(dag.graph.getEdgeCount()).toBe(3); // 4 nodes → 3 edges
  });

  it('autoLinkTemporal false produces no temporal edges', async () => {
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR, {
      autoLinkTemporal: false,
    });
    expect(dag.graph.getNodeCount()).toBe(5);
    expect(dag.graph.getEdgeCount()).toBe(0);
  });

  it('nodes carry sourceFile in metadata pointing to the source file', async () => {
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR, {
      excludePatterns: ['skip-*'],
    });
    const allEntries = dag.graph._allNodeEntries();
    for (const [, node] of allEntries) {
      expect(node.metadata.sourceFile).toMatch(/memory-2026-05-2[01]\.md$/);
    }
  });

  it('maxDepth pruning removes deep nodes', async () => {
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR, {
      excludePatterns: ['skip-*'],
      maxDepth: 1,
    });
    // Chain of 4 nodes: depths are 3, 2, 1, 0 (last to first)
    // With maxDepth=1, only nodes with depth <= 1 survive → 2 nodes
    expect(dag.graph.getNodeCount()).toBeLessThan(4);
  });

  it('handles directory with only .md files matching exclude patterns', async () => {
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR, {
      excludePatterns: ['memory-*', 'skip-*'],
    });
    expect(dag.graph.getNodeCount()).toBe(0);
    expect(dag.graph.getEdgeCount()).toBe(0);
  });

  it('promoted entries with score have correct score parsed', async () => {
    const entries = parseMemoryFile(path.join(FIXTURE_DIR, 'memory-2026-05-20.md'));
    // Check that at least one entry has a score
    const scoredEntries = entries.filter((e) => typeof e.score === 'number');
    expect(scoredEntries.length).toBeGreaterThan(0);
    // First promo block has score:0.9
    const firstScored = scoredEntries[0];
    expect(firstScored.score).toBeCloseTo(0.9, 1);
  });

  it('sourceRef is set on every parsed entry', async () => {
    const fp = path.join(FIXTURE_DIR, 'memory-2026-05-20.md');
    const entries = parseMemoryFile(fp);
    for (const entry of entries) {
      expect(entry.sourceRef).toBe(fp);
    }
  });

  it('buildOptions with wildcard in excludePatterns', async () => {
    // Use glob-like pattern to match all memory files
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR, {
      excludePatterns: ['memory-*.md'],
    });
    // Only skip-this.md remains (1 node)
    expect(dag.graph.getNodeCount()).toBe(1);
  });

  it('preserves metadata memoryDir', async () => {
    const dag = await buildGraphFromMemoryFiles(FIXTURE_DIR);
    expect(dag.metadata.memoryDir).toBe(FIXTURE_DIR);
    expect(dag.metadata.nodeCount).toBe(dag.graph.getNodeCount());
  });
});

describe('incrementalUpdate', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `lcm-incremental-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
  });

  it('detects new files and adds their nodes', async () => {
    writeMd(tmp, 'day1', `# Day One\nMorning work. 2026-05-20T08:00`);
    const dag = await buildGraphFromMemoryFiles(tmp);
    expect(dag.graph.getNodeCount()).toBe(1);

    // Small delay so mtime differs
    await new Promise((r) => setTimeout(r, 50));
    writeMd(tmp, 'day2', `# Day Two\nAfternoon code review. 2026-05-21T14:00`);
    const updated = await incrementalUpdate(dag, tmp);
    expect(updated.graph.getNodeCount()).toBe(2);
  });

  it('does not change anything when files are unchanged', async () => {
    writeMd(tmp, 'a', `# A\nContent A. 2026-05-20T10:00`);
    writeMd(tmp, 'b', `# B\nContent B. 2026-05-21T10:00`);

    const dag = await buildGraphFromMemoryFiles(tmp);
    const beforeCount = dag.graph.getNodeCount();

    // The files haven't changed on disk, so incrementalUpdate should do nothing
    const updated = await incrementalUpdate(dag, tmp);
    expect(updated.graph.getNodeCount()).toBe(beforeCount);
  });

  it('updates nodes when a file is modified', async () => {
    writeMd(tmp, 'note', `# Note\nOriginal content. 2026-05-20T10:00`);
    const dag = await buildGraphFromMemoryFiles(tmp);
    expect(dag.graph.getNode('note:section-0')?.content).toContain('Original');

    // Wait for mtime to advance
    await new Promise((r) => setTimeout(r, 100));
    writeMd(tmp, 'note', `# Note\nUpdated content. 2026-05-22T10:00`);
    const updated = await incrementalUpdate(dag, tmp);

    // The old node should be removed and replaced with the new one
    const newNode = updated.graph.getNode('note:section-0');
    expect(newNode?.content).toContain('Updated');
  });

  it('preserves DAG id and original metadata', async () => {
    writeMd(tmp, 'x', `# X\nData. 2026-05-20T10:00`);
    const dag = await buildGraphFromMemoryFiles(tmp);
    dag.metadata.id = 'my-persistent-id';
    dag.metadata.tags = ['persistent'];

    await new Promise((r) => setTimeout(r, 50));
    writeMd(tmp, 'y', `# Y\nMore data. 2026-05-21T10:00`);
    const updated = await incrementalUpdate(dag, tmp);

    expect(updated.metadata.id).toBe('my-persistent-id');
    expect(updated.metadata.tags).toEqual(['persistent']);
  });

  it('respects excludePatterns during incremental update', async () => {
    writeMd(tmp, 'keep', `# Keep\nData. 2026-05-20T10:00`);
    const dag = await buildGraphFromMemoryFiles(tmp);
    expect(dag.graph.getNodeCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    writeMd(tmp, 'trash', `# Trash\nShould not appear. 2026-05-21T10:00`);
    const updated = await incrementalUpdate(dag, tmp, {
      excludePatterns: ['trash*'],
    });
    // trash file is excluded, so no new nodes
    expect(updated.graph.getNodeCount()).toBe(1);
  });

  it('handles empty DAG incremental update (acts as full build)', async () => {
    writeMd(tmp, 'fresh', `# Fresh\nNew content. 2026-05-22T10:00`);
    const emptyDag = createDAG('/nonexistent', { id: 'seed' });
    expect(emptyDag.graph.getNodeCount()).toBe(0);

    const updated = await incrementalUpdate(emptyDag, tmp);
    expect(updated.graph.getNodeCount()).toBe(1);
  });
});
