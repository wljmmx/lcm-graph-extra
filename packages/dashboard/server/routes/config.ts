/**
 * 配置管理路由（模块 v1.1.0-1/2/3 + v1.1.0-5 capability-profile 代理）。
 *
 * - GET  /api/config                    —— 运行时配置查看（脱敏后）
 * - GET  /api/config/schema             —— 配置字段 schema 文档（字段名/类型/默认值/可更新）
 * - PATCH /api/config                   —— 白名单字段热更新（写回 openclaw.json）
 * - GET  /api/capability-profile        —— 能力档次查看（代理到插件 snapshot :7423）
 * - POST /api/capability-profile        —— 能力档次切换（代理到插件 snapshot :7423）
 *
 * 设计原则：
 * - 读取 ~/.openclaw/openclaw.json（dashboard 与 plugin 同机部署）
 * - 敏感字段（password/apiKey/token/secret）脱敏后返回
 * - PATCH 仅允许白名单内的字段更新，防止越权改写安全配置
 * - capability-profile 代理到插件 snapshot server（内存态，非 openclaw.json）
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { redactSensitive } from '../lib/operation-logs';
import { getOutboundAuthHeader } from '../lib/auth';

// ---------------------------------------------------------------------------
// 配置文件路径
// ---------------------------------------------------------------------------

function getConfigPath(): string {
  return resolve(homedir(), '.openclaw', 'openclaw.json');
}

/** 读取 openclaw.json 原始 JSON 对象 */
export function readRawConfig(): Record<string, unknown> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    // openclaw.json 可能将插件配置放在 plugins.entries["lcm-graph-extra"].config 下
    const entriesConfig = parsed?.plugins?.entries?.['lcm-graph-extra']?.config;
    if (entriesConfig && typeof entriesConfig === 'object') {
      return entriesConfig as Record<string, unknown>;
    }
    // 或在顶层
    if (parsed?.neo4j || parsed?.lcmMonitor || parsed?.compaction) {
      return parsed as Record<string, unknown>;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 写回 openclaw.json（保留其他字段，仅更新 lcm-graph-extra 配置段） */
export function writeRawConfig(updates: Record<string, unknown>): void {
  const path = getConfigPath();
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      root = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      root = {};
    }
  }
  // 确保路径结构存在
  if (!root.plugins) root.plugins = {};
  if (!(root.plugins as Record<string, unknown>).entries) {
    (root.plugins as Record<string, unknown>).entries = {};
  }
  const entries = (root.plugins as Record<string, unknown>).entries as Record<string, unknown>;
  if (!entries['lcm-graph-extra']) entries['lcm-graph-extra'] = {};
  const pluginEntry = entries['lcm-graph-extra'] as Record<string, unknown>;
  if (!pluginEntry.config) pluginEntry.config = {};
  const config = pluginEntry.config as Record<string, unknown>;

  // 合并更新
  for (const [key, value] of Object.entries(updates)) {
    config[key] = value;
  }

  writeFileSync(path, JSON.stringify(root, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// v1.1.0-2: 可热更新的白名单字段
// 仅允许调整性能/行为参数，禁止修改安全相关字段（password/apiKey/token/webhook.url 等）
// ---------------------------------------------------------------------------

const UPDATABLE_FIELDS: Record<string, { type: 'number' | 'boolean' | 'string' | 'object'; description: string; path: string }[]> = {
  summaryStrategy: [{ type: 'string', description: '摘要策略：strategy | hybrid | full', path: 'summaryStrategy' }],
  maxGraphDepth: [{ type: 'number', description: '图谱最大遍历深度', path: 'maxGraphDepth' }],
  maxNodeCount: [{ type: 'number', description: '单次检索最大节点数', path: 'maxNodeCount' }],
  maxTokens: [{ type: 'number', description: '上下文 token 预算', path: 'maxTokens' }],
  budgetRatio: [{ type: 'number', description: '上下文预算占比（0-1）', path: 'budgetRatio' }],
  distillationIntervalMs: [{ type: 'number', description: '蒸馏间隔（毫秒）', path: 'distillationIntervalMs' }],
  cliTimeout: [{ type: 'number', description: 'CLI 超时（毫秒）', path: 'cliTimeout' }],
  compaction: [
    { type: 'number', description: '触发压缩的消息阈值', path: 'compaction.triggerThreshold' },
    { type: 'number', description: '软阈值 token 数', path: 'compaction.softThresholdTokens' },
    { type: 'number', description: '保留近期 token 数', path: 'compaction.keepRecentTokens' },
  ],
  experience: [
    { type: 'boolean', description: '是否启用经验提取', path: 'experience.enabled' },
    { type: 'number', description: '经验相关性阈值（0-1）', path: 'experience.relevanceThreshold' },
  ],
  ttl: [
    { type: 'boolean', description: '是否启用 TTL 清理', path: 'ttl.enabled' },
    { type: 'number', description: 'TTL 保留天数', path: 'ttl.retentionDays' },
    { type: 'number', description: '清理间隔（小时）', path: 'ttl.cleanupIntervalHours' },
  ],
  retrieval: [
    { type: 'number', description: 'QMD 检索条数', path: 'retrieval.limits.qmd' },
    { type: 'number', description: '图谱检索条数', path: 'retrieval.limits.graph' },
    { type: 'number', description: '经验检索条数', path: 'retrieval.limits.exp' },
  ],
  lcmMonitor: [
    { type: 'number', description: '上下文窗口大小（tokens）', path: 'lcmMonitor.contextWindow' },
    { type: 'number', description: '高压阈值（0-1）', path: 'lcmMonitor.highPressureThreshold' },
    { type: 'number', description: '中压阈值（0-1）', path: 'lcmMonitor.mediumPressureThreshold' },
    { type: 'number', description: '主动触发阈值（0-1）', path: 'lcmMonitor.proactiveThreshold' },
  ],
};

/** 按点分路径获取嵌套值 */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 按点分路径设置嵌套值（创建中间对象） */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!(p in cur) || typeof cur[p] !== 'object' || cur[p] === null) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** 验证值类型 */
function validateType(value: unknown, expected: 'number' | 'boolean' | 'string' | 'object'): boolean {
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'object') return typeof value === 'object' && value !== null;
  return false;
}

// ---------------------------------------------------------------------------
// v1.1.0-3: 配置 schema 文档
// ---------------------------------------------------------------------------

interface SchemaFieldDoc {
  path: string;
  type: string;
  description: string;
  updatable: boolean;
  defaultValue?: unknown;
}

function buildSchemaDoc(): SchemaFieldDoc[] {
  const docs: SchemaFieldDoc[] = [
    { path: 'summaryStrategy', type: 'string', description: '摘要策略：strategy | hybrid | full', updatable: true, defaultValue: 'strategy' },
    { path: 'maxGraphDepth', type: 'number', description: '图谱最大遍历深度', updatable: true, defaultValue: 10 },
    { path: 'maxNodeCount', type: 'number', description: '单次检索最大节点数', updatable: true, defaultValue: 5000 },
    { path: 'maxTokens', type: 'number', description: '上下文 token 预算', updatable: true, defaultValue: 65536 },
    { path: 'budgetRatio', type: 'number', description: '上下文预算占比（0-1）', updatable: true, defaultValue: 0.3 },
    { path: 'distillationIntervalMs', type: 'number', description: '蒸馏间隔（毫秒）', updatable: true, defaultValue: 7200000 },
    { path: 'cliTimeout', type: 'number', description: 'CLI 超时（毫秒）', updatable: true, defaultValue: 30000 },
    { path: 'compaction.triggerThreshold', type: 'number', description: '触发压缩的消息阈值', updatable: true, defaultValue: 20000 },
    { path: 'compaction.softThresholdTokens', type: 'number', description: '软阈值 token 数', updatable: true, defaultValue: 163840 },
    { path: 'compaction.keepRecentTokens', type: 'number', description: '保留近期 token 数', updatable: true, defaultValue: 131072 },
    { path: 'experience.enabled', type: 'boolean', description: '是否启用经验提取', updatable: true, defaultValue: true },
    { path: 'experience.relevanceThreshold', type: 'number', description: '经验相关性阈值（0-1）', updatable: true, defaultValue: 0.6 },
    { path: 'ttl.enabled', type: 'boolean', description: '是否启用 TTL 清理', updatable: true, defaultValue: true },
    { path: 'ttl.retentionDays', type: 'number', description: 'TTL 保留天数', updatable: true, defaultValue: 90 },
    { path: 'ttl.cleanupIntervalHours', type: 'number', description: '清理间隔（小时）', updatable: true, defaultValue: 24 },
    { path: 'retrieval.limits.qmd', type: 'number', description: 'QMD 检索条数', updatable: true, defaultValue: 5 },
    { path: 'retrieval.limits.graph', type: 'number', description: '图谱检索条数', updatable: true, defaultValue: 5 },
    { path: 'retrieval.limits.exp', type: 'number', description: '经验检索条数', updatable: true, defaultValue: 3 },
    { path: 'lcmMonitor.contextWindow', type: 'number', description: '上下文窗口大小（tokens）', updatable: true, defaultValue: 262144 },
    { path: 'lcmMonitor.highPressureThreshold', type: 'number', description: '高压阈值（0-1）', updatable: true, defaultValue: 0.85 },
    { path: 'lcmMonitor.mediumPressureThreshold', type: 'number', description: '中压阈值（0-1）', updatable: true, defaultValue: 0.70 },
    { path: 'lcmMonitor.proactiveThreshold', type: 'number', description: '主动触发阈值（0-1）', updatable: true, defaultValue: 0.65 },
    // 不可更新字段（仅展示）
    { path: 'neo4j.uri', type: 'string', description: 'Neo4j Bolt 连接地址', updatable: false, defaultValue: 'bolt://localhost:7687' },
    { path: 'neo4j.user', type: 'string', description: 'Neo4j 用户名', updatable: false, defaultValue: 'neo4j' },
    { path: 'neo4j.password', type: 'string', description: 'Neo4j 密码（脱敏）', updatable: false, defaultValue: '***' },
    { path: 'embedding.apiKey', type: 'string', description: 'Embedding API Key（脱敏）', updatable: false, defaultValue: '***' },
    { path: 'embedding.model', type: 'string', description: 'Embedding 模型名', updatable: false, defaultValue: '' },
    { path: 'distillationLlm.model', type: 'string', description: '蒸馏 LLM 模型名', updatable: false, defaultValue: 'ollama/qwen3.6:27b' },
    { path: 'distillationLlm.apiKey', type: 'string', description: '蒸馏 LLM API Key（脱敏）', updatable: false, defaultValue: '***' },
    { path: 'webhook.url', type: 'string', description: 'Webhook URL（SSRF 风险，不支持热更新）', updatable: false, defaultValue: '' },
    { path: 'dashboardSnapshot.port', type: 'number', description: 'Snapshot 服务端口', updatable: false, defaultValue: 7423 },
    { path: 'dashboardSnapshot.host', type: 'string', description: 'Snapshot 服务监听地址', updatable: false, defaultValue: '127.0.0.1' },
  ];
  return docs;
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  // v1.1.0-1: GET /api/config —— 运行时配置查看（脱敏）
  // 安全：不向客户端暴露 configPath（绝对路径会泄漏用户名/部署结构）
  app.get('/api/config', async (req, _reply) => {
    try {
      const raw = readRawConfig();
      const redacted = redactSensitive(raw);
      const configExists = existsSync(getConfigPath());
      return {
        ok: true,
        configExists,
        config: redacted,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, '/api/config 读取失败');
      return { ok: false, error: '配置读取失败，请查看服务端日志', config: {} };
    }
  });

  // v1.1.0-3: GET /api/config/schema —— 配置 schema 文档
  app.get('/api/config/schema', async (_req, _reply) => {
    const fields = buildSchemaDoc();
    return {
      ok: true,
      fields,
      updatablePaths: fields.filter((f) => f.updatable).map((f) => f.path),
    };
  });

  // v1.1.0-2: PATCH /api/config —— 白名单字段热更新
  app.patch('/api/config', async (req, reply) => {
    const body = (req.body as { updates?: Record<string, unknown> }) ?? {};
    const updates = body.updates ?? {};
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      reply.code(400);
      return { ok: false, error: 'body.updates must be an object of { path: value }' };
    }

    // 收集所有允许的点分路径
    const allowedPaths = new Set<string>();
    for (const fields of Object.values(UPDATABLE_FIELDS)) {
      for (const f of fields) allowedPaths.add(f.path);
    }

    const applied: string[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];
    const mergedUpdates: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(updates)) {
      if (!allowedPaths.has(key)) {
        rejected.push({ path: key, reason: 'field not in updatable whitelist' });
        continue;
      }
      // 查找字段定义以验证类型
      let fieldDef: { type: 'number' | 'boolean' | 'string' | 'object'; description: string; path: string } | undefined;
      for (const fields of Object.values(UPDATABLE_FIELDS)) {
        fieldDef = fields.find((f) => f.path === key);
        if (fieldDef) break;
      }
      if (!fieldDef) {
        rejected.push({ path: key, reason: 'field definition not found' });
        continue;
      }
      if (!validateType(value, fieldDef.type)) {
        rejected.push({ path: key, reason: `expected ${fieldDef.type}, got ${typeof value}` });
        continue;
      }
      setByPath(mergedUpdates, key, value);
      applied.push(key);
    }

    if (applied.length === 0) {
      reply.code(400);
      return { ok: false, error: 'no valid updates provided', rejected };
    }

    try {
      writeRawConfig(mergedUpdates);
      // 读回脱敏后的配置返回
      const raw = readRawConfig();
      const redacted = redactSensitive(raw);
      return {
        ok: true,
        applied,
        rejected,
        config: redacted,
        note: '配置已写入 openclaw.json，部分字段需重启插件进程生效',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, '/api/config PATCH 写入失败');
      reply.code(500);
      return { ok: false, error: '配置写入失败，请查看服务端日志', applied, rejected };
    }
  });

  // v1.1.0-5: GET /api/capability-profile —— 能力档次查看（代理到插件 snapshot）
  // A1 修复: 插件 GET 返回 { current, profiles } 不含 ok 字段，前端永远走 else 分支
  //          显示"加载失败"。此处包装 ok:true 后透传，与 POST 行为一致
  app.get('/api/capability-profile', async (req, reply) => {
    const SNAPSHOT_URL = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`${SNAPSHOT_URL}/internal/capability-profile`, {
        headers: getOutboundAuthHeader(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        reply.code(resp.status);
        return { ok: false, error: `snapshot server returned ${resp.status}` };
      }
      const body = await resp.json() as Record<string, unknown>;
      // 包装 ok:true（插件 GET 不返回 ok 字段，前端 CapabilityProfileResponse 依赖它）
      return { ok: true, ...body };
    } catch (err) {
      // 插件 snapshot 不可达是预期降级场景，降为 warn 避免污染 error 日志
      const msg = err instanceof Error ? err.message : String(err);
      req.log.warn({ err: msg }, '/api/capability-profile 代理失败，插件 snapshot 服务不可达');
      return {
        ok: false,
        error: `无法连接插件 snapshot 服务 (${SNAPSHOT_URL}); 请检查插件是否已加载且 :7423 端口在监听`,
        current: null,
        profiles: [],
      };
    }
  });

  // v1.1.0-5: POST /api/capability-profile —— 能力档次切换（代理到插件 snapshot）
  app.post('/api/capability-profile', async (req, reply) => {
    const SNAPSHOT_URL = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';
    const body = (req.body as { id?: string }) ?? {};
    if (!body.id || typeof body.id !== 'string') {
      reply.code(400);
      return { ok: false, error: 'body.id is required' };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`${SNAPSHOT_URL}/internal/capability-profile`, {
        method: 'POST',
        headers: { ...getOutboundAuthHeader(), 'content-type': 'application/json' },
        body: JSON.stringify({ id: body.id }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        reply.code(resp.status);
        return { ok: false, error: `snapshot server returned ${resp.status}` };
      }
      return await resp.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.warn({ err: msg }, '/api/capability-profile POST 代理失败，插件 snapshot 服务不可达');
      reply.code(502);
      return { ok: false, error: `无法连接插件 snapshot 服务 (${SNAPSHOT_URL}); 请检查插件是否已加载且 :7423 端口在监听` };
    }
  });

  // v1.2.0-5: GET /api/capability-profile/recommend —— 硬件资源自动推荐（代理到插件 snapshot）
  app.get('/api/capability-profile/recommend', async (req, reply) => {
    const SNAPSHOT_URL = process.env.PLUGIN_SNAPSHOT_URL ?? 'http://127.0.0.1:7423';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`${SNAPSHOT_URL}/internal/capability-profile/recommend`, {
        headers: getOutboundAuthHeader(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        reply.code(resp.status);
        return { ok: false, error: `snapshot server returned ${resp.status}` };
      }
      return await resp.json();
    } catch (err) {
      // 插件 snapshot 不可达是预期降级场景，降为 warn 避免污染 error 日志
      const msg = err instanceof Error ? err.message : String(err);
      req.log.warn({ err: msg }, '/api/capability-profile/recommend 代理失败，插件 snapshot 服务不可达');
      reply.code(502);
      return {
        ok: false,
        error: `无法连接插件 snapshot 服务 (${SNAPSHOT_URL}); 请检查插件是否已加载且 :7423 端口在监听`,
        recommended: null,
        current: null,
        reasoning: '插件 snapshot 服务不可用，无法采集硬件资源',
        hardware: null,
        alternatives: [],
      };
    }
  });
}
