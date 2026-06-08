/**
 * lcm-graph-extra — Neo4j Graph Search Adapter
 *
 * Bridges lcm-graph-extra with graph-memory-pro's compiled module exports.
 * Dynamically imports from graph-memory-pro/dist/index.js.
 * Uses Recaller.recall(), searchNodes, upsertNode/upsertEdge.
 */
import { createHash } from 'node:crypto';
import { ConflictLogger } from '../async/conflict-logger.js';
const GM_PRO_PATH = process.env.GM_PRO_PATH || '/home/wljmmx/.openclaw/extensions/graph-memory-pro';
/** Map node label to result type */
function inferType(label) {
    const u = label.toUpperCase();
    if (['SKILL', 'CONCEPT', 'CAPABILITY', 'METHOD', 'TOOL'].includes(u))
        return 'definition';
    if (['RELATION', 'EDGE'].includes(u))
        return 'relation';
    return 'raw';
}
function mapEntityType(raw) {
    const t = (raw || 'CONCEPT').toUpperCase();
    if (['SKILL', 'CAPABILITY', 'METHOD', 'TOOL', 'BEST_PRACTICE', 'CONCEPT', 'KNOWLEDGE'].includes(t))
        return 'SKILL';
    if (['EVENT', 'BUG', 'ERROR', 'ISSUE', 'PROBLEM'].includes(t))
        return 'EVENT';
    return 'TASK';
}
function mapEdgeType(raw) {
    const t = raw.toUpperCase();
    if (['USED_SKILL', 'SOLVED_BY', 'REQUIRES', 'PATCHES', 'CONFLICTS_WITH'].includes(t))
        return t;
    if (['RELATED_TO', 'REFERENCES', 'USES'].includes(t))
        return 'USED_SKILL';
    if (['FIXES', 'RESOLVES', 'SOLVES'].includes(t))
        return 'SOLVED_BY';
    if (['DEPENDS_ON', 'NEEDS', 'PREREQUISITE'].includes(t))
        return 'REQUIRES';
    if (['REPLACES', 'SUPERSEDES', 'UPDATES'].includes(t))
        return 'PATCHES';
    if (['CONFLICTS', 'INCOMPATIBLE'].includes(t))
        return 'CONFLICTS_WITH';
    return 'USED_SKILL';
}
function makeNodeId(name, typeName) {
    return `${typeName.toLowerCase()}-${createHash('sha256').update(`${typeName}:${name}`).digest('hex').slice(0, 12)}`;
}
export class GraphAdapter {
    conflictLogger = new ConflictLogger();
    mod = null;
    driver = null;
    config;
    neo4jConfig;
    constructor(neo4jConfig, config) {
        this.neo4jConfig = neo4jConfig;
        this.config = config;
    }
    async connect() {
        try {
            const mod = await import(`${GM_PRO_PATH}/dist/index.js`);
            this.mod = mod;
            this.driver = mod.getDriver?.() ?? null;
            if (!this.driver) {
                // graph-memory-pro 尚未初始化驱动 → 自己建一个
                const neo4j = await import('neo4j-driver');
                this.driver = neo4j.default.driver(this.neo4jConfig.uri, neo4j.default.auth.basic(this.neo4jConfig.user, this.neo4jConfig.password), { maxConnectionLifetime: 30 * 60 * 1000, connectionAcquisitionTimeout: 5000 });
                await this.driver.verifyConnectivity();
            }
            return true;
        }
        catch (err) {
            console.error(`[lcm-graph-extra] connect error: ${err}`);
            return false;
        }
    }
    async search(query, limit) {
        if (!this.config.enabled)
            return [];
        const m = this.mod ?? await this.connect().then(() => this.mod);
        if (!m)
            return [];
        const rl = limit ?? this.config.searchLimit;
        try {
            const nodes = await m.searchNodes(this.driver, query, rl);
            return (nodes ?? []).map((n) => {
                const name = n.name ?? n.properties?.name ?? '';
                const label = n.type ?? n.labels?.[0] ?? 'TASK';
                const desc = n.description ?? n.properties?.description ?? '';
                const content = n.content ?? n.properties?.content ?? '';
                const ppr = n.pagerank ?? n.properties?.pagerank ?? 0.5;
                return {
                    id: createHash('sha256').update(`g:${n.id ?? name}`).digest('hex').slice(0, 16),
                    content: `[${label}] ${name}${desc ? '\n' + desc : ''}${content ? '\n' + String(content).slice(0, 500) : ''}`,
                    source: 'graph',
                    type: inferType(label),
                    score: (n.score ?? Number(ppr)),
                    metadata: { nodeId: n.id, nodeType: label, name, updatedAt: n.updatedAt ?? n.properties?.updatedAt ?? 0 },
                };
            });
        }
        catch (err) {
            console.error(`[lcm-graph-extra] search error: ${err}`);
            return [];
        }
    }
    async searchExperience(query, limit) {
        if (!this.config.enabled)
            return [];
        const m2 = this.mod ?? await this.connect().then(() => this.mod);
        if (!m2)
            return [];
        const rl = limit ?? this.config.searchLimit;
        try {
            const nodes = await m2.searchNodes(this.driver, query, rl * 3);
            const events = (nodes ?? []).filter((n) => (n.type ?? n.labels?.[0]) === 'EVENT');
            const out = [];
            for (const evt of events.slice(0, rl)) {
                const name = evt.name ?? evt.properties?.name ?? '';
                const desc = evt.description ?? evt.properties?.description ?? '';
                const edges = await this.mod.getEdgesForNodes(this.driver, [evt.id]);
                const sols = (edges ?? []).filter((e) => e.type === 'SOLVED_BY');
                let text = `[EVENT] ${name}\n${desc}${sols.length > 0 ? '\nSolutions:' : ''}`;
                for (const s of sols)
                    text += `\n- ${s.targetName ?? 'Unknown'}`;
                out.push({
                    id: createHash('sha256').update(`exp:${evt.id ?? name}`).digest('hex').slice(0, 16),
                    content: text, source: 'graph',
                    type: 'definition',
                    score: 0.8 + Math.random() * 0.15,
                    metadata: { experience: true, problemName: name, solutionCount: sols.length, updatedAt: evt.updatedAt ?? evt.properties?.updatedAt ?? 0 },
                });
            }
            return out;
        }
        catch {
            return [];
        }
    }
    async upsertEntities(entities, relations) {
        const m3 = this.mod ?? await this.connect().then(() => this.mod);
        if (!m3)
            return { upserted: 0, conflicts: 0 };
        let cc = 0, uc = 0;
        const now = Date.now();
        try {
            for (const e of entities) {
                if (!e.name?.trim())
                    continue;
                const t = mapEntityType(e.type), nid = makeNodeId(e.name, t);
                const existing = await this.mod.findById(this.driver, nid);
                if (existing) {
                    const ec = existing.properties?.content ?? '';
                    if (ec.trim() !== (e.content ?? '').trim()) {
                        this.conflictLogger.resolve(e.name.trim(), t, { updatedAt: existing.properties?.updatedAt ?? 0, validatedCount: existing.properties?.validatedCount ?? 0, content: ec }, { updatedAt: now, validatedCount: 1, content: e.content ?? '' });
                        cc++;
                    }
                }
                await this.mod.upsertNode(this.driver, {
                    id: nid, type: t, name: e.name.trim(),
                    description: (e.description ?? '').slice(0, 500),
                    content: (e.content ?? '').slice(0, 2000),
                    status: 'active', pagerank: 0.5,
                    validatedCount: existing ? (existing.properties?.validatedCount ?? 0) + 1 : 1,
                    createdAt: existing ? (existing.properties?.createdAt ?? now) : now, updatedAt: now,
                });
                uc++;
            }
            for (const rel of relations) {
                if (!rel.from?.trim() || !rel.to?.trim())
                    continue;
                const mt = mapEdgeType(rel.type);
                await this.mod.upsertEdge(this.driver, {
                    id: makeNodeId(rel.from + '-' + rel.to, mt), type: mt,
                    fromId: makeNodeId(rel.from, 'TASK'), toId: makeNodeId(rel.to, 'TASK'),
                    instruction: (rel.instruction ?? '').slice(0, 500),
                    condition: '', weight: 1.0, createdAt: now, updatedAt: now,
                });
            }
        }
        catch (err) {
            console.error(`[lcm-graph-extra] upsert error: ${err}`);
        }
        return { upserted: uc, conflicts: cc };
    }
    async processFeedback() {
        return { processed: 0, updatedNodes: 0 };
    }
    async health() {
        try {
            if (this.driver) {
                await this.driver.verifyConnectivity();
                return true;
            }
            return await this.connect();
        }
        catch {
            return false;
        }
    }
    async close() {
        // 不关闭 driver — 由 graph-memory-pro 管理生命周期
        this.driver = null;
        this.mod = null;
    }
}
//# sourceMappingURL=graph-adapter.js.map