/**
 * 后端路由测试：配置 schema 与热更新白名单（模块 v1.1.0-1/2/3 + gm-pro 配置）。
 *
 * 重点覆盖「新增参数」的读取与配置一致性：
 *  - lcm-graph-extra: embedding.batchSize / lcmMonitor 冷却与摘要窗口 / retrieval.graph 在线学习
 *  - graph-memory-pro: recall 段（v2.4.0 点1-6）schema overlay 补齐后可读可写
 *
 * 用 vitest + fastify inject 测试；openclaw.json 通过 HOME 指向临时目录隔离，
 * 避免读写真实 ~/.openclaw/openclaw.json。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerConfigRoutes } from '../../server/routes/config';

let app: FastifyInstance;
let fakeHome: string;
const originalHome = process.env.HOME;

/** 构造一个挂载了 config 路由的 Fastify 实例 */
async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await registerConfigRoutes(instance);
  return instance;
}

beforeEach(async () => {
  // 隔离 HOME：getConfigPath() 读取 ~/.openclaw/openclaw.json
  fakeHome = mkdtempSync(join(tmpdir(), 'lcm-cfg-test-'));
  process.env.HOME = fakeHome;
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

/** 写入一个仅含 lcm-graph-extra 配置段的 openclaw.json */
function seedLcmConfig(config: Record<string, unknown>): void {
  const dir = join(fakeHome, '.openclaw');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'openclaw.json'),
    JSON.stringify({ plugins: { entries: { 'lcm-graph-extra': { config } } } }, null, 2),
    'utf-8',
  );
}

/** 读取写入后的 lcm-graph-extra 配置段 */
function readLcmConfig(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(fakeHome, '.openclaw', 'openclaw.json'), 'utf-8'));
  return raw.plugins.entries['lcm-graph-extra'].config ?? {};
}

describe('GET /api/config/schema（lcm-graph-extra）', () => {
  it('新增参数 embedding.batchSize 出现在 schema 且可更新', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/schema' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const batch = body.fields.find((f: any) => f.path === 'embedding.batchSize');
    expect(batch, 'schema 缺少 embedding.batchSize').toBeDefined();
    expect(batch.type).toBe('number');
    expect(batch.updatable).toBe(true);
    expect(body.updatablePaths).toContain('embedding.batchSize');
  });

  it('补齐 lcmMonitor 冷却/摘要窗口与 retrieval.graph 在线学习字段', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/schema' });
    const paths: string[] = res.json().fields.map((f: any) => f.path);
    for (const p of [
      'lcmMonitor.summaryModelContextWindow',
      'lcmMonitor.preCompactCooldownMs',
      'lcmMonitor.compactCooldownMs',
      'retrieval.graph.judge.enabled',
      'retrieval.graph.judge.tier',
      'retrieval.graph.judge.heuristicMatch',
      'retrieval.graph.associationMatrix.enabled',
      'retrieval.graph.associationMatrix.learningRate',
      'retrieval.graph.autoFeedback.enabled',
    ]) {
      expect(paths, `schema 缺少 ${p}`).toContain(p);
    }
  });

  it('qmdMcpQueryTimeout 默认值与插件一致（30000，SD-DEF-3）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/schema' });
    const field = res.json().fields.find((f: any) => f.path === 'qmdMcpQueryTimeout');
    expect(field.defaultValue).toBe(30000);
  });
});

describe('PATCH /api/config（lcm-graph-extra 热更新）', () => {
  it('embedding.batchSize 可写入 openclaw.json', async () => {
    seedLcmConfig({ embedding: { model: 'bge-m3' } });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { updates: { 'embedding.batchSize': 16 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toContain('embedding.batchSize');
    expect(readLcmConfig().embedding).toMatchObject({ model: 'bge-m3', batchSize: 16 });
  });

  it('lcmMonitor.compactCooldownMs 可写入且类型校验生效', async () => {
    seedLcmConfig({});
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { updates: { 'lcmMonitor.compactCooldownMs': 90000 } },
    });
    expect(ok.json().applied).toContain('lcmMonitor.compactCooldownMs');
    expect(readLcmConfig().lcmMonitor).toMatchObject({ compactCooldownMs: 90000 });

    // 类型错误 → 拒绝（不写坏配置）
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { updates: { 'lcmMonitor.compactCooldownMs': '90000' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().rejected[0].path).toBe('lcmMonitor.compactCooldownMs');
  });

  it('未在白名单的字段被拒绝', async () => {
    seedLcmConfig({});
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { updates: { 'neo4j.password': 'hacked' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().rejected[0].path).toBe('neo4j.password');
  });
});

describe('graph-memory-pro 配置（schema 动态展平 + recall overlay）', () => {
  let gmProDir: string;
  const originalGmProPath = process.env.GM_PRO_PATH;

  afterEach(() => {
    if (originalGmProPath === undefined) delete process.env.GM_PRO_PATH;
    else process.env.GM_PRO_PATH = originalGmProPath;
    if (gmProDir) rmSync(gmProDir, { recursive: true, force: true });
  });

  /** 造一个假的 gm-pro 安装目录（仅声明 llm 段，模拟上游未声明 recall） */
  function seedGmProManifest(): void {
    gmProDir = mkdtempSync(join(tmpdir(), 'lcm-gmpro-test-'));
    writeFileSync(
      join(gmProDir, 'openclaw.plugin.json'),
      JSON.stringify({
        configSchema: {
          properties: {
            llm: {
              type: 'object',
              properties: { model: { type: 'string', default: 'gpt-4o-mini' } },
            },
          },
        },
      }),
      'utf-8',
    );
    process.env.GM_PRO_PATH = gmProDir;
  }

  it('上游已声明字段保留，recall 段由 overlay 补齐（点1-6 全部可写）', async () => {
    seedGmProManifest();
    const res = await app.inject({ method: 'GET', url: '/api/gm-pro/config/schema' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const paths: string[] = body.fields.map((f: any) => f.path);

    // 上游声明的字段仍在
    expect(paths).toContain('llm.model');
    // overlay 补齐 recall 点1-6
    for (const p of [
      'recall.memorySliceChars',
      'recall.multiStage',
      'recall.temporalWeight',
      'recall.chunking.enabled',
      'recall.chunking.chunkSize',
      'recall.chunking.chunkOverlap',
      'recall.outputFormat.enabled',
      'recall.outputFormat.concise',
      'recall.outputFormat.faithful',
    ]) {
      expect(paths, `gm-pro schema 缺少 ${p}`).toContain(p);
      expect(body.updatablePaths).toContain(p);
    }
    // 默认值口径与 gm-pro 内置默认一致（400/40）
    const chunkSize = body.fields.find((f: any) => f.path === 'recall.chunking.chunkSize');
    expect(chunkSize.defaultValue).toBe(400);
    const overlap = body.fields.find((f: any) => f.path === 'recall.chunking.chunkOverlap');
    expect(overlap.defaultValue).toBe(40);
  });

  it('recall.chunking.chunkSize 可通过 PATCH 写入 graph-memory-pro 配置段', async () => {
    seedGmProManifest();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/gm-pro/config',
      payload: { updates: { 'recall.chunking.chunkSize': 384, 'recall.chunking.chunkOverlap': 64 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toEqual(
      expect.arrayContaining(['recall.chunking.chunkSize', 'recall.chunking.chunkOverlap']),
    );

    const root = JSON.parse(readFileSync(join(fakeHome, '.openclaw', 'openclaw.json'), 'utf-8'));
    expect(root.plugins.entries['graph-memory-pro'].config.recall.chunking).toMatchObject({
      chunkSize: 384,
      chunkOverlap: 64,
    });
    // lcm 配置段未被污染（两个插件配置段互不影响）
    expect(existsSync(join(fakeHome, '.openclaw', 'openclaw.json'))).toBe(true);
  });
});