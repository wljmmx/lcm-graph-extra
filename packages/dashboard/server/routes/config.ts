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

/** 读取 openclaw.json 中 lcm-graph-extra 插件配置段 */
export function readRawConfig(): Record<string, unknown> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    // 始终返回 plugins.entries["lcm-graph-extra"].config，
    // 避免回退到根级配置导致 moa 等字段被误写到根级。
    const entriesConfig = parsed?.plugins?.entries?.['lcm-graph-extra']?.config;
    if (entriesConfig && typeof entriesConfig === 'object') {
      return entriesConfig as Record<string, unknown>;
    }
    return {};
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
  // ─── 顶层字段 ───────────────────────────────────────────────────────────
  summaryStrategy: [{ type: 'string', description: '摘要策略：strategy | hybrid | full', path: 'summaryStrategy' }],
  maxGraphDepth: [{ type: 'number', description: '图谱最大遍历深度', path: 'maxGraphDepth' }],
  maxNodeCount: [{ type: 'number', description: '单次检索最大节点数', path: 'maxNodeCount' }],
  maxTokens: [{ type: 'number', description: '上下文 token 预算', path: 'maxTokens' }],
  budgetRatio: [{ type: 'number', description: '上下文预算占比（0-1）', path: 'budgetRatio' }],
  enableCrossFileLinkage: [{ type: 'boolean', description: '启用跨文件关联', path: 'enableCrossFileLinkage' }],
  crossReferenceRetentionDays: [{ type: 'number', description: '跨引用保留天数', path: 'crossReferenceRetentionDays' }],
  distillationIntervalMs: [{ type: 'number', description: '蒸馏间隔（毫秒）', path: 'distillationIntervalMs' }],
  cliTimeout: [{ type: 'number', description: 'CLI 超时（毫秒）', path: 'cliTimeout' }],
  cliFallbackSearchType: [{ type: 'string', description: 'CLI 降级搜索类型：search | hybrid', path: 'cliFallbackSearchType' }],
  qmdMcpTimeout: [{ type: 'number', description: 'QMD MCP 初始化握手超时（ms）', path: 'qmdMcpTimeout' }],
  qmdMcpQueryTimeout: [{ type: 'number', description: 'QMD MCP/REST 查询超时（ms）', path: 'qmdMcpQueryTimeout' }],
  tripletTimeoutMs: [{ type: 'number', description: '三元组提取超时（ms）', path: 'tripletTimeoutMs' }],
  experienceTtlIntervalMs: [{ type: 'number', description: '经验 TTL 清理间隔（ms）', path: 'experienceTtlIntervalMs' }],
  enableCliFallback: [{ type: 'boolean', description: '启用 QMD CLI 降级（关闭可避免 CLI 卡死）', path: 'enableCliFallback' }],
  largeFileThreshold: [{ type: 'number', description: '大文件阈值（字节）', path: 'largeFileThreshold' }],
  largeFilesDir: [{ type: 'string', description: '大文件存储目录', path: 'largeFilesDir' }],

  // ─── 压缩 ───────────────────────────────────────────────────────────────
  compaction: [
    { type: 'boolean', description: '是否启用压缩', path: 'compaction.enabled' },
    { type: 'number', description: '触发压缩的消息阈值', path: 'compaction.triggerThreshold' },
    { type: 'number', description: '软阈值 token 数', path: 'compaction.softThresholdTokens' },
    { type: 'number', description: '保留近期 token 数', path: 'compaction.keepRecentTokens' },
  ],

  // ─── 经验提取 ───────────────────────────────────────────────────────────
  experience: [
    { type: 'boolean', description: '是否启用经验提取', path: 'experience.enabled' },
    { type: 'number', description: '经验相关性阈值（0-1）', path: 'experience.relevanceThreshold' },
    { type: 'string', description: '摘要模式：async | sync', path: 'experience.summaryMode' },
    { type: 'string', description: 'Dreaming 定时 cron 表达式', path: 'experience.schedule.dreaming' },
    { type: 'string', description: '增量定时 cron 表达式', path: 'experience.schedule.incremental' },
  ],

  // ─── TTL ────────────────────────────────────────────────────────────────
  ttl: [
    { type: 'boolean', description: '是否启用 TTL 清理', path: 'ttl.enabled' },
    { type: 'number', description: 'TTL 保留天数', path: 'ttl.retentionDays' },
    { type: 'number', description: '清理间隔（小时）', path: 'ttl.cleanupIntervalHours' },
  ],

  // ─── 检索 ───────────────────────────────────────────────────────────────
  retrieval: [
    { type: 'number', description: 'QMD 检索条数', path: 'retrieval.limits.qmd' },
    { type: 'number', description: '图谱检索条数', path: 'retrieval.limits.graph' },
    { type: 'number', description: '经验检索条数', path: 'retrieval.limits.exp' },
    { type: 'string', description: 'QMD MCP 端点地址', path: 'retrieval.qmd.mcpEndpoint' },
    { type: 'boolean', description: '启用图谱检索', path: 'retrieval.graph.enabled' },
    { type: 'number', description: '图谱检索条数上限', path: 'retrieval.graph.searchLimit' },
    // BUG-6: 缓存容量可配置（原硬编码 50）
    { type: 'number', description: '图谱检索缓存大小', path: 'retrieval.graph.searchCacheSize' },
    { type: 'number', description: 'L2/L4 查询缓存大小', path: 'retrieval.cacheSize' },
  ],

  // ─── 上下文监控 ─────────────────────────────────────────────────────────
  lcmMonitor: [
    { type: 'boolean', description: '是否启用上下文监控', path: 'lcmMonitor.enabled' },
    { type: 'number', description: '上下文窗口大小（tokens）', path: 'lcmMonitor.contextWindow' },
    { type: 'number', description: '去重轮数', path: 'lcmMonitor.dedupRounds' },
    { type: 'number', description: '高压阈值（0-1）', path: 'lcmMonitor.highPressureThreshold' },
    { type: 'number', description: '中压阈值（0-1）', path: 'lcmMonitor.mediumPressureThreshold' },
    { type: 'number', description: '主动触发阈值（0-1）', path: 'lcmMonitor.proactiveThreshold' },
    { type: 'number', description: '系统提示词开销（tokens）', path: 'lcmMonitor.systemPromptOverheadTokens' },
    { type: 'number', description: '压缩 token 预算', path: 'lcmMonitor.compactTokenBudget' },
    { type: 'number', description: '压缩超时（ms）', path: 'lcmMonitor.compactTimeout' },
    { type: 'number', description: '最大摘要 token 占比（0-1）', path: 'lcmMonitor.maxSummaryTokenRatio' },
    // 检索限额（按压力层级）
    { type: 'number', description: '低压检索 QMD 条数', path: 'lcmMonitor.retrievalLimits.low.qmd' },
    { type: 'number', description: '低压检索 图谱 条数', path: 'lcmMonitor.retrievalLimits.low.graph' },
    { type: 'number', description: '低压检索 经验 条数', path: 'lcmMonitor.retrievalLimits.low.exp' },
    { type: 'number', description: '中压检索 QMD 条数', path: 'lcmMonitor.retrievalLimits.medium.qmd' },
    { type: 'number', description: '中压检索 图谱 条数', path: 'lcmMonitor.retrievalLimits.medium.graph' },
    { type: 'number', description: '中压检索 经验 条数', path: 'lcmMonitor.retrievalLimits.medium.exp' },
    { type: 'number', description: '高压检索 QMD 条数', path: 'lcmMonitor.retrievalLimits.high.qmd' },
    { type: 'number', description: '高压检索 图谱 条数', path: 'lcmMonitor.retrievalLimits.high.graph' },
    { type: 'number', description: '高压检索 经验 条数', path: 'lcmMonitor.retrievalLimits.high.exp' },
    // 上下文字符限制
    { type: 'number', description: '低压上下文字符数', path: 'lcmMonitor.maxContextChars.low' },
    { type: 'number', description: '中压上下文字符数', path: 'lcmMonitor.maxContextChars.medium' },
    { type: 'number', description: '高压上下文字符数', path: 'lcmMonitor.maxContextChars.high' },
  ],

  // ─── LLM 超时 ───────────────────────────────────────────────────────────
  llmTimeouts: [
    { type: 'number', description: 'Rerank 超时（ms）', path: 'llmTimeouts.rerankTimeoutMs' },
    { type: 'number', description: 'Judge 超时（ms）', path: 'llmTimeouts.judgeTimeoutMs' },
    { type: 'number', description: 'Validate 超时（ms）', path: 'llmTimeouts.validateTimeoutMs' },
    { type: 'number', description: 'Summarize 超时（ms）', path: 'llmTimeouts.summarizeTimeoutMs' },
    { type: 'number', description: 'Embed 超时（ms）', path: 'llmTimeouts.embedTimeoutMs' },
    { type: 'number', description: 'Graph LLM 超时（ms）', path: 'llmTimeouts.graphLlmTimeoutMs' },
    { type: 'number', description: 'Cascade Tier2 超时（ms）', path: 'llmTimeouts.cascadeTier2Ms' },
    { type: 'number', description: 'Cascade Tier3 超时（ms）', path: 'llmTimeouts.cascadeTier3Ms' },
    { type: 'number', description: 'Distill 超时（ms）', path: 'llmTimeouts.distillMs' },
  ],

  // ─── 备份 ───────────────────────────────────────────────────────────────
  backupConfig: [
    { type: 'boolean', description: '是否启用备份', path: 'backupConfig.enabled' },
    { type: 'number', description: '备份保留天数', path: 'backupConfig.retentionDays' },
    { type: 'number', description: '最大备份数', path: 'backupConfig.maxBackups' },
    { type: 'number', description: '备份间隔（小时）', path: 'backupConfig.intervalHours' },
    { type: 'string', description: '备份目录路径', path: 'backupConfig.backupDir' },
  ],

  // ─── 大文件存根 ─────────────────────────────────────────────────────────
  stubLargeToolPayloads: [
    { type: 'boolean', description: '启用大工具负载外部分片', path: 'stubLargeToolPayloads.enabled' },
    { type: 'number', description: '触发阈值（字节）', path: 'stubLargeToolPayloads.thresholdBytes' },
    { type: 'string', description: '外部文件存储目录', path: 'stubLargeToolPayloads.filesDir' },
    { type: 'number', description: 'Fresh tail 保护条数', path: 'stubLargeToolPayloads.freshTailCount' },
  ],

  // ─── Webhook ────────────────────────────────────────────────────────────
  webhook: [
    { type: 'boolean', description: '是否启用 Webhook', path: 'webhook.enabled' },
  ],

  // ─── 日志 ───────────────────────────────────────────────────────────────
  logging: [
    { type: 'string', description: '日志级别：silent | fatal | error | warn | info | debug | trace', path: 'logging.level' },
    { type: 'string', description: '日志文件路径', path: 'logging.file' },
  ],

  // ─── LLM Provider ───────────────────────────────────────────────────────
  llmProvider: [
    { type: 'string', description: 'LLM Provider 类型', path: 'llmProvider.provider' },
    { type: 'string', description: 'LLM 模型名', path: 'llmProvider.model' },
    { type: 'number', description: 'LLM 最大 token 数', path: 'llmProvider.maxTokens' },
  ],

  // ─── 蒸馏 LLM ───────────────────────────────────────────────────────────
  distillationLlm: [
    { type: 'string', description: '蒸馏 LLM Provider 类型', path: 'distillationLlm.provider' },
    { type: 'string', description: '蒸馏 LLM 模型名', path: 'distillationLlm.model' },
    { type: 'string', description: '蒸馏 LLM Base URL', path: 'distillationLlm.baseURL' },
    { type: 'string', description: '蒸馏 LLM Keep Alive', path: 'distillationLlm.keepAlive' },
  ],

  // ─── Embedding ──────────────────────────────────────────────────────────
  embedding: [
    { type: 'string', description: 'Embedding 模型名', path: 'embedding.model' },
    { type: 'string', description: 'Embedding Base URL', path: 'embedding.baseURL' },
    { type: 'number', description: 'Embedding 维度', path: 'embedding.dimensions' },
    { type: 'string', description: 'Embedding Keep Alive', path: 'embedding.keepAlive' },
  ],

  // ─── Dashboard Snapshot ─────────────────────────────────────────────────
  dashboardSnapshot: [
    { type: 'boolean', description: '是否启用 Snapshot 服务', path: 'dashboardSnapshot.enabled' },
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

// PERF-7: 缓存 schema 文档，避免每次请求重新构建（静态文档不变）
let _schemaDocCache: SchemaFieldDoc[] | null = null;

function buildSchemaDoc(): SchemaFieldDoc[] {
  if (_schemaDocCache) return _schemaDocCache;
  const docs: SchemaFieldDoc[] = [
    // ─── 顶层字段 ─────────────────────────────────────────────────────────
    { path: 'summaryStrategy', type: 'string', description: '摘要策略：strategy | hybrid | full', updatable: true, defaultValue: 'strategy' },
    { path: 'maxGraphDepth', type: 'number', description: '图谱最大遍历深度', updatable: true, defaultValue: 10 },
    { path: 'maxNodeCount', type: 'number', description: '单次检索最大节点数', updatable: true, defaultValue: 5000 },
    { path: 'maxTokens', type: 'number', description: '上下文 token 预算', updatable: true, defaultValue: 65536 },
    { path: 'budgetRatio', type: 'number', description: '上下文预算占比（0-1）', updatable: true, defaultValue: 0.3 },
    { path: 'enableCrossFileLinkage', type: 'boolean', description: '启用跨文件关联', updatable: true, defaultValue: true },
    { path: 'crossReferenceRetentionDays', type: 'number', description: '跨引用保留天数', updatable: true, defaultValue: 90 },
    { path: 'distillationIntervalMs', type: 'number', description: '蒸馏间隔（毫秒）', updatable: true, defaultValue: 7200000 },
    { path: 'cliTimeout', type: 'number', description: 'CLI 超时（毫秒）', updatable: true, defaultValue: 30000 },
    { path: 'cliFallbackSearchType', type: 'string', description: 'CLI 降级搜索类型：search | hybrid', updatable: true, defaultValue: 'hybrid' },
    { path: 'qmdMcpTimeout', type: 'number', description: 'QMD MCP 初始化握手超时（ms）', updatable: true, defaultValue: 3000 },
    { path: 'qmdMcpQueryTimeout', type: 'number', description: 'QMD MCP/REST 查询超时（ms）', updatable: true, defaultValue: 15000 },
    { path: 'tripletTimeoutMs', type: 'number', description: '三元组提取超时（ms）', updatable: true, defaultValue: 60000 },
    { path: 'experienceTtlIntervalMs', type: 'number', description: '经验 TTL 清理间隔（ms）', updatable: true, defaultValue: 86400000 },
    { path: 'enableCliFallback', type: 'boolean', description: '启用 QMD CLI 降级（关闭可避免 CLI 卡死）', updatable: true, defaultValue: true },
    { path: 'largeFileThreshold', type: 'number', description: '大文件阈值（字节）', updatable: true, defaultValue: 8000 },
    { path: 'largeFilesDir', type: 'string', description: '大文件存储目录', updatable: true, defaultValue: '' },

    // ─── 压缩 ────────────────────────────────────────────────────────────
    { path: 'compaction.enabled', type: 'boolean', description: '是否启用压缩', updatable: true, defaultValue: true },
    { path: 'compaction.triggerThreshold', type: 'number', description: '触发压缩的消息阈值', updatable: true, defaultValue: 20000 },
    { path: 'compaction.softThresholdTokens', type: 'number', description: '软阈值 token 数', updatable: true, defaultValue: 163840 },
    { path: 'compaction.keepRecentTokens', type: 'number', description: '保留近期 token 数', updatable: true, defaultValue: 131072 },

    // ─── 经验提取 ────────────────────────────────────────────────────────
    { path: 'experience.enabled', type: 'boolean', description: '是否启用经验提取', updatable: true, defaultValue: true },
    { path: 'experience.relevanceThreshold', type: 'number', description: '经验相关性阈值（0-1）', updatable: true, defaultValue: 0.6 },
    { path: 'experience.summaryMode', type: 'string', description: '摘要模式：async | sync', updatable: true, defaultValue: 'async' },
    { path: 'experience.schedule.dreaming', type: 'string', description: 'Dreaming 定时 cron 表达式', updatable: true, defaultValue: '0 3 * * *' },
    { path: 'experience.schedule.incremental', type: 'string', description: '增量定时 cron 表达式', updatable: true, defaultValue: '0 */12 * * *' },

    // ─── TTL ─────────────────────────────────────────────────────────────
    { path: 'ttl.enabled', type: 'boolean', description: '是否启用 TTL 清理', updatable: true, defaultValue: true },
    { path: 'ttl.retentionDays', type: 'number', description: 'TTL 保留天数', updatable: true, defaultValue: 90 },
    { path: 'ttl.cleanupIntervalHours', type: 'number', description: '清理间隔（小时）', updatable: true, defaultValue: 24 },

    // ─── 检索 ────────────────────────────────────────────────────────────
    { path: 'retrieval.limits.qmd', type: 'number', description: 'QMD 检索条数', updatable: true, defaultValue: 5 },
    { path: 'retrieval.limits.graph', type: 'number', description: '图谱检索条数', updatable: true, defaultValue: 5 },
    { path: 'retrieval.limits.exp', type: 'number', description: '经验检索条数', updatable: true, defaultValue: 3 },
    { path: 'retrieval.qmd.mcpEndpoint', type: 'string', description: 'QMD MCP 端点地址', updatable: true, defaultValue: 'http://127.0.0.1:8081' },
    { path: 'retrieval.graph.enabled', type: 'boolean', description: '启用图谱检索', updatable: true, defaultValue: true },
    { path: 'retrieval.graph.searchLimit', type: 'number', description: '图谱检索条数上限', updatable: true, defaultValue: 5 },
    // BUG-6: 缓存容量可配置（原硬编码 50）
    { path: 'retrieval.graph.searchCacheSize', type: 'number', description: '图谱检索缓存大小', updatable: true, defaultValue: 50 },
    { path: 'retrieval.cacheSize', type: 'number', description: 'L2/L4 查询缓存大小', updatable: true, defaultValue: 50 },

    // ─── 上下文监控 ──────────────────────────────────────────────────────
    { path: 'lcmMonitor.enabled', type: 'boolean', description: '是否启用上下文监控', updatable: true, defaultValue: true },
    { path: 'lcmMonitor.contextWindow', type: 'number', description: '上下文窗口大小（tokens）', updatable: true, defaultValue: 262144 },
    { path: 'lcmMonitor.dedupRounds', type: 'number', description: '去重轮数', updatable: true, defaultValue: 24 },
    { path: 'lcmMonitor.highPressureThreshold', type: 'number', description: '高压阈值（0-1）', updatable: true, defaultValue: 0.85 },
    { path: 'lcmMonitor.mediumPressureThreshold', type: 'number', description: '中压阈值（0-1）', updatable: true, defaultValue: 0.70 },
    { path: 'lcmMonitor.proactiveThreshold', type: 'number', description: '主动触发阈值（0-1）', updatable: true, defaultValue: 0.65 },
    { path: 'lcmMonitor.systemPromptOverheadTokens', type: 'number', description: '系统提示词开销（tokens）', updatable: true, defaultValue: 17000 },
    { path: 'lcmMonitor.compactTokenBudget', type: 'number', description: '压缩 token 预算', updatable: true, defaultValue: 154624 },
    { path: 'lcmMonitor.compactTimeout', type: 'number', description: '压缩超时（ms）', updatable: true, defaultValue: 60000 },
    { path: 'lcmMonitor.maxSummaryTokenRatio', type: 'number', description: '最大摘要 token 占比（0-1）', updatable: true, defaultValue: 0.45 },
    { path: 'lcmMonitor.retrievalLimits.low.qmd', type: 'number', description: '低压检索 QMD 条数', updatable: true, defaultValue: 5 },
    { path: 'lcmMonitor.retrievalLimits.low.graph', type: 'number', description: '低压检索 图谱 条数', updatable: true, defaultValue: 5 },
    { path: 'lcmMonitor.retrievalLimits.low.exp', type: 'number', description: '低压检索 经验 条数', updatable: true, defaultValue: 3 },
    { path: 'lcmMonitor.retrievalLimits.medium.qmd', type: 'number', description: '中压检索 QMD 条数', updatable: true, defaultValue: 3 },
    { path: 'lcmMonitor.retrievalLimits.medium.graph', type: 'number', description: '中压检索 图谱 条数', updatable: true, defaultValue: 3 },
    { path: 'lcmMonitor.retrievalLimits.medium.exp', type: 'number', description: '中压检索 经验 条数', updatable: true, defaultValue: 1 },
    { path: 'lcmMonitor.retrievalLimits.high.qmd', type: 'number', description: '高压检索 QMD 条数', updatable: true, defaultValue: 1 },
    { path: 'lcmMonitor.retrievalLimits.high.graph', type: 'number', description: '高压检索 图谱 条数', updatable: true, defaultValue: 1 },
    { path: 'lcmMonitor.retrievalLimits.high.exp', type: 'number', description: '高压检索 经验 条数', updatable: true, defaultValue: 0 },
    { path: 'lcmMonitor.maxContextChars.low', type: 'number', description: '低压上下文字符数', updatable: true, defaultValue: 12000 },
    { path: 'lcmMonitor.maxContextChars.medium', type: 'number', description: '中压上下文字符数', updatable: true, defaultValue: 6000 },
    { path: 'lcmMonitor.maxContextChars.high', type: 'number', description: '高压上下文字符数', updatable: true, defaultValue: 1600 },

    // ─── LLM 超时 ────────────────────────────────────────────────────────
    { path: 'llmTimeouts.rerankTimeoutMs', type: 'number', description: 'Rerank 超时（ms）', updatable: true, defaultValue: 30000 },
    { path: 'llmTimeouts.judgeTimeoutMs', type: 'number', description: 'Judge 超时（ms）', updatable: true, defaultValue: 60000 },
    { path: 'llmTimeouts.validateTimeoutMs', type: 'number', description: 'Validate 超时（ms）', updatable: true, defaultValue: 45000 },
    { path: 'llmTimeouts.summarizeTimeoutMs', type: 'number', description: 'Summarize 超时（ms）', updatable: true, defaultValue: 90000 },
    { path: 'llmTimeouts.embedTimeoutMs', type: 'number', description: 'Embed 超时（ms）', updatable: true, defaultValue: 60000 },
    { path: 'llmTimeouts.graphLlmTimeoutMs', type: 'number', description: 'Graph LLM 超时（ms）', updatable: true, defaultValue: 90000 },
    { path: 'llmTimeouts.cascadeTier2Ms', type: 'number', description: 'Cascade Tier2 超时（ms）', updatable: true, defaultValue: 60000 },
    { path: 'llmTimeouts.cascadeTier3Ms', type: 'number', description: 'Cascade Tier3 超时（ms）', updatable: true, defaultValue: 90000 },
    { path: 'llmTimeouts.distillMs', type: 'number', description: 'Distill 超时（ms）', updatable: true, defaultValue: 120000 },

    // ─── 备份 ────────────────────────────────────────────────────────────
    { path: 'backupConfig.enabled', type: 'boolean', description: '是否启用备份', updatable: true, defaultValue: true },
    { path: 'backupConfig.retentionDays', type: 'number', description: '备份保留天数', updatable: true, defaultValue: 30 },
    { path: 'backupConfig.maxBackups', type: 'number', description: '最大备份数', updatable: true, defaultValue: 10 },
    { path: 'backupConfig.intervalHours', type: 'number', description: '备份间隔（小时）', updatable: true, defaultValue: 24 },
    { path: 'backupConfig.backupDir', type: 'string', description: '备份目录路径', updatable: true, defaultValue: '' },

    // ─── 大文件存根 ──────────────────────────────────────────────────────
    { path: 'stubLargeToolPayloads.enabled', type: 'boolean', description: '启用大工具负载外部分片', updatable: true, defaultValue: false },
    { path: 'stubLargeToolPayloads.thresholdBytes', type: 'number', description: '触发阈值（字节）', updatable: true, defaultValue: 8000 },
    { path: 'stubLargeToolPayloads.filesDir', type: 'string', description: '外部文件存储目录', updatable: true, defaultValue: '' },
    { path: 'stubLargeToolPayloads.freshTailCount', type: 'number', description: 'Fresh tail 保护条数', updatable: true, defaultValue: 8 },

    // ─── Webhook ─────────────────────────────────────────────────────────
    { path: 'webhook.enabled', type: 'boolean', description: '是否启用 Webhook', updatable: true, defaultValue: false },
    { path: 'webhook.url', type: 'string', description: 'Webhook URL（SSRF 风险，不支持热更新）', updatable: false, defaultValue: '' },

    // ─── 日志 ────────────────────────────────────────────────────────────
    { path: 'logging.level', type: 'string', description: '日志级别：silent | fatal | error | warn | info | debug | trace', updatable: true, defaultValue: 'info' },
    { path: 'logging.file', type: 'string', description: '日志文件路径', updatable: true, defaultValue: '' },

    // ─── LLM Provider ────────────────────────────────────────────────────
    { path: 'llmProvider.provider', type: 'string', description: 'LLM Provider 类型', updatable: true, defaultValue: 'openclaw_hooks' },
    { path: 'llmProvider.model', type: 'string', description: 'LLM 模型名', updatable: true, defaultValue: 'default' },
    { path: 'llmProvider.maxTokens', type: 'number', description: 'LLM 最大 token 数', updatable: true, defaultValue: 4096 },

    // ─── 蒸馏 LLM ────────────────────────────────────────────────────────
    { path: 'distillationLlm.provider', type: 'string', description: '蒸馏 LLM Provider 类型', updatable: true, defaultValue: 'openclaw_hooks' },
    { path: 'distillationLlm.model', type: 'string', description: '蒸馏 LLM 模型名', updatable: true, defaultValue: 'ollama/qwen3.6:27b' },
    { path: 'distillationLlm.apiKey', type: 'string', description: '蒸馏 LLM API Key（脱敏）', updatable: false, defaultValue: '***' },
    { path: 'distillationLlm.baseURL', type: 'string', description: '蒸馏 LLM Base URL', updatable: true, defaultValue: '' },
    { path: 'distillationLlm.keepAlive', type: 'string', description: '蒸馏 LLM Keep Alive', updatable: true, defaultValue: '1h' },

    // ─── Embedding ───────────────────────────────────────────────────────
    { path: 'embedding.model', type: 'string', description: 'Embedding 模型名', updatable: true, defaultValue: '' },
    { path: 'embedding.apiKey', type: 'string', description: 'Embedding API Key（脱敏）', updatable: false, defaultValue: '***' },
    { path: 'embedding.baseURL', type: 'string', description: 'Embedding Base URL', updatable: true, defaultValue: '' },
    { path: 'embedding.dimensions', type: 'number', description: 'Embedding 维度', updatable: true, defaultValue: 0 },
    { path: 'embedding.keepAlive', type: 'string', description: 'Embedding Keep Alive', updatable: true, defaultValue: '' },

    // ─── Dashboard Snapshot ──────────────────────────────────────────────
    { path: 'dashboardSnapshot.enabled', type: 'boolean', description: '是否启用 Snapshot 服务', updatable: true, defaultValue: true },
    { path: 'dashboardSnapshot.port', type: 'number', description: 'Snapshot 服务端口', updatable: false, defaultValue: 7423 },
    { path: 'dashboardSnapshot.host', type: 'string', description: 'Snapshot 服务监听地址', updatable: false, defaultValue: '127.0.0.1' },

    // ─── Neo4j（只读）────────────────────────────────────────────────────
    { path: 'neo4j.uri', type: 'string', description: 'Neo4j Bolt 连接地址', updatable: false, defaultValue: 'bolt://localhost:7687' },
    { path: 'neo4j.user', type: 'string', description: 'Neo4j 用户名', updatable: false, defaultValue: 'neo4j' },
    { path: 'neo4j.password', type: 'string', description: 'Neo4j 密码（脱敏）', updatable: false, defaultValue: '***' },
  ];
  _schemaDocCache = docs;
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

  // P3-3: GET /api/config/raw —— 返回完整 raw JSON（脱敏），供高级用户编辑器使用
  app.get('/api/config/raw', async (_req, _reply) => {
    try {
      const raw = readRawConfig();
      const redacted = redactSensitive(raw);
      return { ok: true, config: redacted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  // P3-3: POST /api/config/validate —— 校验 raw JSON 是否合法（不写入）
  app.post('/api/config/validate', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || !body.config) {
      reply.code(400);
      return { ok: false, error: '请求体缺少 config 字段' };
    }
    const config = body.config;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      reply.code(400);
      return { ok: false, error: 'config 必须是 JSON 对象' };
    }

    const errors: string[] = [];
    // 基本结构校验：检查顶层关键字段类型
    const checks: Array<{ path: string; type: string }> = [
      { path: 'neo4j', type: 'object' },
      { path: 'moa', type: 'object' },
      { path: 'compaction', type: 'object' },
      { path: 'experience', type: 'object' },
      { path: 'ttl', type: 'object' },
    ];
    for (const c of checks) {
      const val = getByPath(config as Record<string, unknown>, c.path);
      if (val !== undefined && (typeof val !== c.type || Array.isArray(val) || val === null)) {
        errors.push(`${c.path}: 期望 ${c.type}，实际 ${typeof val === 'object' && Array.isArray(val) ? 'array' : typeof val}`);
      }
    }

    if (errors.length > 0) {
      reply.code(400);
      return { ok: false, error: '配置校验失败', errors };
    }
    return { ok: true, message: '配置结构校验通过' };
  });

  // P3-3: PUT /api/config/raw —— 写入完整配置（高级用户模式）
  app.put('/api/config/raw', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || !body.config) {
      reply.code(400);
      return { ok: false, error: '请求体缺少 config 字段' };
    }
    const config = body.config;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      reply.code(400);
      return { ok: false, error: 'config 必须是 JSON 对象' };
    }

    try {
      writeRawConfig(config as Record<string, unknown>);
      const raw = readRawConfig();
      const redacted = redactSensitive(raw);
      return { ok: true, config: redacted, note: '配置已写入，需重启插件进程生效' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { ok: false, error: msg };
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

  // =========================================================================
  // v2.1.13: graph-memory-pro 插件配置管理
  // =========================================================================

  const GM_PRO_PLUGIN_ID = 'graph-memory-pro';

  /** 读取 openclaw.json 中 graph-memory-pro 插件配置段 */
  function readGmProRawConfig(): Record<string, unknown> {
    const path = getConfigPath();
    if (!existsSync(path)) return {};
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      const entriesConfig = parsed?.plugins?.entries?.[GM_PRO_PLUGIN_ID]?.config;
      if (entriesConfig && typeof entriesConfig === 'object') {
        return entriesConfig as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** 写回 openclaw.json（保留其他字段，仅更新 graph-memory-pro 配置段） */
  function writeGmProRawConfig(updates: Record<string, unknown>): void {
    const path = getConfigPath();
    let root: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        root = JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        root = {};
      }
    }
    if (!root.plugins) root.plugins = {};
    if (!(root.plugins as Record<string, unknown>).entries) {
      (root.plugins as Record<string, unknown>).entries = {};
    }
    const entries = (root.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    if (!entries[GM_PRO_PLUGIN_ID]) entries[GM_PRO_PLUGIN_ID] = {};
    const pluginEntry = entries[GM_PRO_PLUGIN_ID] as Record<string, unknown>;
    if (!pluginEntry.config) pluginEntry.config = {};
    const config = pluginEntry.config as Record<string, unknown>;

    for (const [key, value] of Object.entries(updates)) {
      config[key] = value;
    }

    writeFileSync(path, JSON.stringify(root, null, 2), 'utf-8');
  }

  // graph-memory-pro 可热更新字段白名单
  const GM_PRO_UPDATABLE_FIELDS: Record<string, { type: 'number' | 'boolean' | 'string' | 'object'; description: string; path: string }[]> = {
    general: [
      { type: 'string', description: 'SQLite 图谱数据库路径', path: 'dbPath' },
      { type: 'number', description: '知识提取触发间隔（轮数）', path: 'compactTurnCount' },
      { type: 'number', description: '跨对话召回最大节点数', path: 'recallMaxNodes' },
      { type: 'number', description: '图遍历深度（跳数）', path: 'recallMaxDepth' },
      { type: 'number', description: '向量去重阈值（0-1）', path: 'dedupThreshold' },
      { type: 'number', description: 'PageRank 阻尼系数', path: 'pagerankDamping' },
      { type: 'number', description: 'PageRank 迭代次数', path: 'pagerankIterations' },
    ],
    embedding: [
      { type: 'string', description: 'Embedding 模型名', path: 'embedding.model' },
      { type: 'string', description: 'Embedding Base URL', path: 'embedding.baseURL' },
      { type: 'number', description: '向量维度', path: 'embedding.dimensions' },
    ],
    llm: [
      { type: 'string', description: 'LLM 模型名', path: 'llm.model' },
      { type: 'string', description: 'LLM Base URL', path: 'llm.baseURL' },
    ],
  };

  // graph-memory-pro 配置 schema 文档（缓存，避免每次请求重建）
  let _gmProSchemaDocCache: SchemaFieldDoc[] | null = null;

  function buildGmProSchemaDoc(): SchemaFieldDoc[] {
    if (_gmProSchemaDocCache) return _gmProSchemaDocCache;
    const docs: SchemaFieldDoc[] = [
      // ─── 通用 ─────────────────────────────────────────────────────────────
      { path: 'dbPath', type: 'string', description: 'SQLite 图谱数据库路径', updatable: true, defaultValue: '~/.openclaw/graph-memory.db' },
      { path: 'compactTurnCount', type: 'number', description: '知识提取触发间隔（轮数）', updatable: true, defaultValue: 7 },
      { path: 'recallMaxNodes', type: 'number', description: '跨对话召回最大节点数', updatable: true, defaultValue: 6 },
      { path: 'recallMaxDepth', type: 'number', description: '图遍历深度（跳数）', updatable: true, defaultValue: 2 },
      { path: 'dedupThreshold', type: 'number', description: '向量去重阈值（0-1）', updatable: true, defaultValue: 0.90 },
      { path: 'pagerankDamping', type: 'number', description: 'PageRank 阻尼系数', updatable: true, defaultValue: 0.85 },
      { path: 'pagerankIterations', type: 'number', description: 'PageRank 迭代次数', updatable: true, defaultValue: 20 },
      // ─── Embedding ─────────────────────────────────────────────────────────
      { path: 'embedding.model', type: 'string', description: 'Embedding 模型名', updatable: true, defaultValue: 'text-embedding-3-small' },
      { path: 'embedding.baseURL', type: 'string', description: 'Embedding Base URL', updatable: true, defaultValue: 'https://api.openai.com/v1' },
      { path: 'embedding.dimensions', type: 'number', description: '向量维度', updatable: true, defaultValue: 512 },
      // ─── LLM ──────────────────────────────────────────────────────────────
      { path: 'llm.model', type: 'string', description: 'LLM 模型名', updatable: true, defaultValue: '' },
      { path: 'llm.baseURL', type: 'string', description: 'LLM Base URL', updatable: true, defaultValue: '' },
    ];
    _gmProSchemaDocCache = docs;
    return docs;
  }

  // GET /api/gm-pro/config —— 读取 graph-memory-pro 运行时配置（脱敏）
  app.get('/api/gm-pro/config', async (req, _reply) => {
    try {
      const raw = readGmProRawConfig();
      const redacted = redactSensitive(raw);
      // 检测 GM Pro 插件配置段是否存在（而非仅检测主配置文件）
      const configExists = Object.keys(raw).length > 0;
      return {
        ok: true,
        configExists,
        config: redacted,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, '/api/gm-pro/config 读取失败');
      return { ok: false, error: '配置读取失败，请查看服务端日志', config: {} };
    }
  });

  // GET /api/gm-pro/config/schema —— graph-memory-pro 配置 schema 文档
  app.get('/api/gm-pro/config/schema', async (_req, _reply) => {
    const fields = buildGmProSchemaDoc();
    return {
      ok: true,
      fields,
      updatablePaths: fields.filter((f) => f.updatable).map((f) => f.path),
    };
  });

  // PATCH /api/gm-pro/config —— 白名单字段热更新
  app.patch('/api/gm-pro/config', async (req, reply) => {
    const body = (req.body as { updates?: Record<string, unknown> }) ?? {};
    const updates = body.updates ?? {};
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      reply.code(400);
      return { ok: false, error: 'body.updates must be an object of { path: value }' };
    }

    const allowedPaths = new Set<string>();
    for (const fields of Object.values(GM_PRO_UPDATABLE_FIELDS)) {
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
      let fieldDef: { type: 'number' | 'boolean' | 'string' | 'object'; description: string; path: string } | undefined;
      for (const fields of Object.values(GM_PRO_UPDATABLE_FIELDS)) {
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
      writeGmProRawConfig(mergedUpdates);
      const raw = readGmProRawConfig();
      const redacted = redactSensitive(raw);
      return {
        ok: true,
        applied,
        rejected,
        config: redacted,
        note: '配置已写入 openclaw.json，需重启 graph-memory-pro 插件进程生效',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg }, '/api/gm-pro/config PATCH 写入失败');
      reply.code(500);
      return { ok: false, error: '配置写入失败，请查看服务端日志', applied, rejected };
    }
  });

  // GET /api/gm-pro/config/raw —— 返回完整 raw JSON（脱敏），供高级用户编辑器使用
  app.get('/api/gm-pro/config/raw', async (_req, _reply) => {
    try {
      const raw = readGmProRawConfig();
      const redacted = redactSensitive(raw);
      return { ok: true, config: redacted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  // POST /api/gm-pro/config/validate —— 校验 raw JSON 是否合法（不写入）
  app.post('/api/gm-pro/config/validate', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || !body.config) {
      reply.code(400);
      return { ok: false, error: '请求体缺少 config 字段' };
    }
    const config = body.config;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      reply.code(400);
      return { ok: false, error: 'config 必须是 JSON 对象' };
    }

    const errors: string[] = [];
    // 基本结构校验：检查嵌套字段类型
    const checks: Array<{ path: string; type: string }> = [
      { path: 'embedding', type: 'object' },
      { path: 'llm', type: 'object' },
    ];
    for (const c of checks) {
      const val = getByPath(config as Record<string, unknown>, c.path);
      if (val !== undefined && (typeof val !== c.type || Array.isArray(val) || val === null)) {
        errors.push(`${c.path}: 期望 ${c.type}，实际 ${typeof val === 'object' && Array.isArray(val) ? 'array' : typeof val}`);
      }
    }

    if (errors.length > 0) {
      reply.code(400);
      return { ok: false, error: '配置校验失败', errors };
    }
    return { ok: true, message: '配置结构校验通过' };
  });

  // PUT /api/gm-pro/config/raw —— 写入完整配置（高级用户模式）
  app.put('/api/gm-pro/config/raw', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || !body.config) {
      reply.code(400);
      return { ok: false, error: '请求体缺少 config 字段' };
    }
    const config = body.config;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      reply.code(400);
      return { ok: false, error: 'config 必须是 JSON 对象' };
    }

    try {
      writeGmProRawConfig(config as Record<string, unknown>);
      const raw = readGmProRawConfig();
      const redacted = redactSensitive(raw);
      return { ok: true, config: redacted, note: '配置已写入，需重启 graph-memory-pro 插件进程生效' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { ok: false, error: msg };
    }
  });
}
