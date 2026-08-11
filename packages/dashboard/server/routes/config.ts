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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
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

/** 确保配置文件目录存在 */
function ensureConfigDir(): void {
  const dir = dirname(getConfigPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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

  ensureConfigDir();
  writeFileSync(path, JSON.stringify(root, null, 2), 'utf-8');
}

/** graph-memory-pro 插件 ID（模块级，供 readGmProRawConfig 复用） */
const GM_PRO_PLUGIN_ID = 'graph-memory-pro';

/**
 * 读取 openclaw.json 中 graph-memory-pro 插件配置段。
 * 模块级导出，供 gm-pro 代理路由等复用（鉴权令牌来源）。
 */
export function readGmProRawConfig(): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// v1.1.0-2: 可热更新的白名单字段
// 仅允许调整性能/行为参数，禁止修改安全相关字段（password/apiKey/token/webhook.url 等）
// ---------------------------------------------------------------------------

const UPDATABLE_FIELDS: Record<string, { type: 'number' | 'boolean' | 'string' | 'object'; description: string; path: string }[]> = {
  // ─── 顶层字段 ───────────────────────────────────────────────────────────
  summaryStrategy: [{ type: 'string', description: '摘要策略：strategy | hybrid | full。strategy=按需生成（快、省 token，推荐默认）；hybrid=策略+关键节点全文（平衡）；full=所有命中节点全文（最准但费 token）。推荐：strategy', path: 'summaryStrategy' }],
  maxGraphDepth: [{ type: 'number', description: '图谱最大遍历深度。小项目 3-5，中大型项目 10-20；过深易引发图谱膨胀。推荐：10', path: 'maxGraphDepth' }],
  maxNodeCount: [{ type: 'number', description: '单次检索最大节点数（防内存爆）。推荐：5000', path: 'maxNodeCount' }],
  maxTokens: [{ type: 'number', description: '上下文 token 预算（给检索结果留出的总上限）。推荐：65536', path: 'maxTokens' }],
  budgetRatio: [{ type: 'number', description: '上下文预算占比（0-1）：检索结果占总上下文窗口的比例。值越大检索越全，留给思考的空间越少。推荐：0.3', path: 'budgetRatio' }],
  enableCrossFileLinkage: [{ type: 'boolean', description: '启用跨文件关联：根据三元组在跨文件之间建边。推荐：true（大型代码库效果显著）', path: 'enableCrossFileLinkage' }],
  crossReferenceRetentionDays: [{ type: 'number', description: '跨引用保留天数。推荐：90', path: 'crossReferenceRetentionDays' }],
  distillationIntervalMs: [{ type: 'number', description: '蒸馏间隔（毫秒）：两次经验蒸馏之间的最小间隔。推荐：7200000（每 2 小时）', path: 'distillationIntervalMs' }],
  cliTimeout: [{ type: 'number', description: 'CLI 超时（毫秒）：QMD CLI fallback 命令执行超时。推荐：30000（30s）', path: 'cliTimeout' }],
  cliFallbackSearchType: [{ type: 'string', description: 'CLI 降级搜索类型：search | hybrid。search=轻量词法（无向量）；hybrid=词法+向量（结果更全，推荐）。推荐：hybrid', path: 'cliFallbackSearchType' }],
  qmdMcpTimeout: [{ type: 'number', description: 'QMD MCP 初始化握手超时（ms）。JSON-RPC 握手通常 <500ms。推荐：3000', path: 'qmdMcpTimeout' }],
  qmdMcpQueryTimeout: [{ type: 'number', description: 'QMD MCP/REST 查询超时（ms）。首次查询需 embedding 冷启动（4-5s），后续 300-400ms。推荐：15000', path: 'qmdMcpQueryTimeout' }],
  tripletTimeoutMs: [{ type: 'number', description: '三元组提取超时（ms）：afterTurn 三元组 LLM 调用超时。本地大模型建议 60s。推荐：60000', path: 'tripletTimeoutMs' }],
  experienceTtlIntervalMs: [{ type: 'number', description: '经验 TTL 清理间隔（ms）。推荐：86400000（每 24 小时）', path: 'experienceTtlIntervalMs' }],
  enableCliFallback: [{ type: 'boolean', description: '启用 QMD CLI 降级。关闭可避免 CLI 卡死；若 MCP+REST 均失败则直接报错。推荐：true', path: 'enableCliFallback' }],
  largeFileThreshold: [{ type: 'number', description: '大文件阈值（字节，简写覆盖 stubLargeToolPayloads.thresholdBytes）。~2K tokens 起步。推荐：8000', path: 'largeFileThreshold' }],
  largeFilesDir: [{ type: 'string', description: '大文件存储目录（简写覆盖 stubLargeToolPayloads.filesDir，空=默认 ~/.openclaw/lcm-files）。推荐：空字符串', path: 'largeFilesDir' }],

  // ─── 压缩 ───────────────────────────────────────────────────────────────
  compaction: [
    { type: 'boolean', description: '是否启用 LCM 上下文压缩。开启可长期保持对话不爆上下文。推荐：true', path: 'compaction.enabled' },
    { type: 'number', description: '触发压缩的消息条数阈值。推荐：20000', path: 'compaction.triggerThreshold' },
    { type: 'number', description: '软阈值 token 数：超过此值开始计划压缩。推荐：163840', path: 'compaction.softThresholdTokens' },
    { type: 'number', description: '保留近期 token 数（不被压缩，保留最近对话上下文）。推荐：131072', path: 'compaction.keepRecentTokens' },
  ],

  // ─── 经验提取 ───────────────────────────────────────────────────────────
  experience: [
    { type: 'boolean', description: '是否启用经验提取（长期知识积累）。推荐：true', path: 'experience.enabled' },
    { type: 'number', description: '经验相关性阈值（0-1）：高于此值的经验才会纳入当前上下文。越大越精准但召回越少。推荐：0.6', path: 'experience.relevanceThreshold' },
    { type: 'string', description: '摘要模式：async | sync。async=后台异步（对话不阻塞，推荐）；sync=写完立刻阻塞式摘要。推荐：async', path: 'experience.summaryMode' },
    { type: 'string', description: 'Dreaming 定时 cron 表达式：夜间做全量经验再整理。推荐：0 3 * * *（凌晨 3 点）', path: 'experience.schedule.dreaming' },
    { type: 'string', description: '增量定时 cron 表达式：半天一次的增量经验抽取。推荐：0 */12 * * *', path: 'experience.schedule.incremental' },
  ],

  // ─── TTL ────────────────────────────────────────────────────────────────
  ttl: [
    { type: 'boolean', description: '是否启用 TTL 节点清理（自动淘汰过期图节点）。推荐：true', path: 'ttl.enabled' },
    { type: 'number', description: 'TTL 保留天数：超过此天数的图节点被清理。推荐：90', path: 'ttl.retentionDays' },
    { type: 'number', description: '清理间隔（小时）。推荐：24', path: 'ttl.cleanupIntervalHours' },
  ],

  // ─── 检索 ───────────────────────────────────────────────────────────────
  retrieval: [
    { type: 'number', description: 'QMD 检索条数。推荐：5', path: 'retrieval.limits.qmd' },
    { type: 'number', description: '图谱检索条数。推荐：5', path: 'retrieval.limits.graph' },
    { type: 'number', description: '经验检索条数。推荐：3', path: 'retrieval.limits.exp' },
    { type: 'string', description: 'QMD MCP 端点地址。推荐：http://127.0.0.1:8081', path: 'retrieval.qmd.mcpEndpoint' },
    { type: 'boolean', description: '启用图谱检索（Neo4j/GraphRAG）。推荐：true', path: 'retrieval.graph.enabled' },
    { type: 'number', description: '图谱检索条数上限（1-20）。推荐：5', path: 'retrieval.graph.searchLimit' },
    // BUG-6: 缓存容量可配置（原硬编码 50）
    { type: 'number', description: '图谱检索缓存大小（>=10）。推荐：50', path: 'retrieval.graph.searchCacheSize' },
    { type: 'number', description: 'L2/L4 查询缓存大小（>=10）。推荐：50', path: 'retrieval.cacheSize' },
    { type: 'number', description: 'QMD vec/hyde 查询文本分片阈值（字符数，>=500）。超过拆分为多个分片独立查询，用 RRF 合并。推荐：8000；若遇到 documents exceed context size 可降到 3000', path: 'retrieval.qmdQueryMaxChars' },
  ],

  // ─── 上下文监控 ─────────────────────────────────────────────────────────
  lcmMonitor: [
    { type: 'boolean', description: '是否启用 LCM 上下文监控与主动压缩。推荐：true', path: 'lcmMonitor.enabled' },
    { type: 'number', description: '上下文窗口大小（tokens，即模型上下文上限）。推荐：262144', path: 'lcmMonitor.contextWindow' },
    { type: 'number', description: '去重轮数（同一轮上下文压缩去重的迭代次数）。推荐：24', path: 'lcmMonitor.dedupRounds' },
    { type: 'number', description: '高压阈值（0-1）：超过此值进入高压压缩，大量削减检索条数。推荐：0.85', path: 'lcmMonitor.highPressureThreshold' },
    { type: 'number', description: '中压阈值（0-1）：超过此值进入中压，适度削减。推荐：0.7', path: 'lcmMonitor.mediumPressureThreshold' },
    { type: 'number', description: '主动触发阈值（0-1）：超过此值后台开始规划压缩。推荐：0.65', path: 'lcmMonitor.proactiveThreshold' },
    { type: 'number', description: '系统提示词开销（tokens，预留的系统提示词空间）。推荐：17000', path: 'lcmMonitor.systemPromptOverheadTokens' },
    { type: 'number', description: '压缩 token 预算：单次压缩后允许的最大摘要 token 数。推荐：114688', path: 'lcmMonitor.compactTokenBudget' },
    { type: 'number', description: '压缩超时（ms）。本地大模型建议 60s。推荐：60000', path: 'lcmMonitor.compactTimeout' },
    { type: 'number', description: '最大摘要 token 占比（0-1）：摘要不超过上下文的此比例。推荐：0.45', path: 'lcmMonitor.maxSummaryTokenRatio' },
    // 检索限额（按压力层级）
    { type: 'number', description: '低压检索 QMD 条数。推荐：5', path: 'lcmMonitor.retrievalLimits.low.qmd' },
    { type: 'number', description: '低压检索 图谱 条数。推荐：5', path: 'lcmMonitor.retrievalLimits.low.graph' },
    { type: 'number', description: '低压检索 经验 条数。推荐：3', path: 'lcmMonitor.retrievalLimits.low.exp' },
    { type: 'number', description: '中压检索 QMD 条数。推荐：3', path: 'lcmMonitor.retrievalLimits.medium.qmd' },
    { type: 'number', description: '中压检索 图谱 条数。推荐：3', path: 'lcmMonitor.retrievalLimits.medium.graph' },
    { type: 'number', description: '中压检索 经验 条数。推荐：1', path: 'lcmMonitor.retrievalLimits.medium.exp' },
    { type: 'number', description: '高压检索 QMD 条数。推荐：1', path: 'lcmMonitor.retrievalLimits.high.qmd' },
    { type: 'number', description: '高压检索 图谱 条数。推荐：1', path: 'lcmMonitor.retrievalLimits.high.graph' },
    { type: 'number', description: '高压检索 经验 条数。推荐：0', path: 'lcmMonitor.retrievalLimits.high.exp' },
    // 上下文字符限制
    { type: 'number', description: '低压上下文字符数。推荐：12000', path: 'lcmMonitor.maxContextChars.low' },
    { type: 'number', description: '中压上下文字符数。推荐：6000', path: 'lcmMonitor.maxContextChars.medium' },
    { type: 'number', description: '高压上下文字符数。推荐：1600', path: 'lcmMonitor.maxContextChars.high' },
  ],

  // ─── LLM 超时 ───────────────────────────────────────────────────────────
  llmTimeouts: [
    { type: 'number', description: 'Rerank 超时（ms）。推荐：30000', path: 'llmTimeouts.rerankTimeoutMs' },
    { type: 'number', description: 'Judge 超时（ms）：Cascade Tier2 判断。推荐：60000', path: 'llmTimeouts.judgeTimeoutMs' },
    { type: 'number', description: 'Validate 超时（ms）：经验相关性校验。推荐：45000', path: 'llmTimeouts.validateTimeoutMs' },
    { type: 'number', description: 'Summarize 超时（ms）：经验回顾摘要。推荐：90000', path: 'llmTimeouts.summarizeTimeoutMs' },
    { type: 'number', description: 'Embed 超时（ms）：Embedding 调用。推荐：60000', path: 'llmTimeouts.embedTimeoutMs' },
    { type: 'number', description: 'Graph LLM 超时（ms）：三元组提取回退。推荐：90000', path: 'llmTimeouts.graphLlmTimeoutMs' },
    { type: 'number', description: 'Cascade Tier2 超时（ms）：Promise.race 回退。推荐：60000', path: 'llmTimeouts.cascadeTier2Ms' },
    { type: 'number', description: 'Cascade Tier3 超时（ms）：工具验证。推荐：90000', path: 'llmTimeouts.cascadeTier3Ms' },
    { type: 'number', description: 'Distill 超时（ms）：单次经验蒸馏。推荐：120000', path: 'llmTimeouts.distillMs' },
  ],

  // ─── 备份 ───────────────────────────────────────────────────────────────
  backupConfig: [
    { type: 'boolean', description: '是否启用图谱+经验自动备份。推荐：true', path: 'backupConfig.enabled' },
    { type: 'number', description: '备份保留天数。推荐：30', path: 'backupConfig.retentionDays' },
    { type: 'number', description: '最大备份数。推荐：10', path: 'backupConfig.maxBackups' },
    { type: 'number', description: '备份间隔（小时）。推荐：24', path: 'backupConfig.intervalHours' },
    { type: 'string', description: '备份目录路径（空=默认 ~/.openclaw/backups）。推荐：空字符串', path: 'backupConfig.backupDir' },
  ],

  // ─── 大文件存根 ─────────────────────────────────────────────────────────
  stubLargeToolPayloads: [
    { type: 'boolean', description: '启用大工具负载外部分片 + 存根替换（兼容 lossless-claw）。小文件可不启用。推荐：false（按需开启）', path: 'stubLargeToolPayloads.enabled' },
    { type: 'number', description: '触发阈值（字节，~2K tokens）。推荐：8000', path: 'stubLargeToolPayloads.thresholdBytes' },
    { type: 'string', description: '外部文件存储目录（空=默认 ~/.openclaw/lcm-files）。推荐：空字符串', path: 'stubLargeToolPayloads.filesDir' },
    { type: 'number', description: '最近 N 条消息不存根（fresh tail 保护，防止最新上下文丢失）。推荐：8', path: 'stubLargeToolPayloads.freshTailCount' },
  ],

  // ─── Webhook ────────────────────────────────────────────────────────────
  webhook: [
    { type: 'boolean', description: '是否启用 Webhook（事件回调到自定义地址）。推荐：false（无外部系统时）', path: 'webhook.enabled' },
  ],

  // ─── 日志 ───────────────────────────────────────────────────────────────
  logging: [
    { type: 'string', description: '日志级别：silent | fatal | error | warn | info | debug | trace。silent=完全静默；fatal/error=仅报错；warn=警告+错误；info=常规运行（推荐）；debug=排查问题；trace=全量追踪。推荐：info', path: 'logging.level' },
    { type: 'string', description: '日志文件路径（空=仅标准输出）。推荐：空字符串', path: 'logging.file' },
  ],

  // ─── LLM Provider ───────────────────────────────────────────────────────
  llmProvider: [
    { type: 'string', description: 'LLM Provider 类型：openclaw_hooks | openai | ollama | deepseek | unsloth | custom。openclaw_hooks=通过 OpenClaw 网关自动路由（推荐默认）；ollama=本地部署；openai/deepseek=云端 API；custom=自定义 BaseURL。推荐：openclaw_hooks', path: 'llmProvider.provider' },
    { type: 'string', description: 'LLM 模型名。推荐：default（随 provider 默认）', path: 'llmProvider.model' },
    { type: 'number', description: 'LLM 最大 token 数：8192 | 16384 | 24576 | 32768。按模型上下文窗口匹配：8k(<32k) / 16k(32k-64k) / 24k(64k-128k) / 32k(>=128k)。推荐：32768', path: 'llmProvider.maxTokens' },
  ],

  // ─── 蒸馏 LLM ───────────────────────────────────────────────────────────
  distillationLlm: [
    { type: 'string', description: '蒸馏 LLM Provider 类型：openclaw_hooks | openai | ollama | deepseek | unsloth | custom。经验蒸馏模型，建议用本地强模型。推荐：openclaw_hooks', path: 'distillationLlm.provider' },
    { type: 'string', description: '蒸馏 LLM 模型名（建议能力>=27B，本地 qwen3.6:27b 起步）。推荐：ollama/qwen3.6:27b', path: 'distillationLlm.model' },
    { type: 'string', description: '蒸馏 LLM Base URL。custom 时必填。推荐：空字符串', path: 'distillationLlm.baseURL' },
    { type: 'string', description: '蒸馏 LLM Keep Alive（模型内存驻留时长，如 1h=保留 1 小时）。注意：不是请求超时，超时看 llmTimeouts.distillMs。推荐：1h', path: 'distillationLlm.keepAlive' },
  ],

  // ─── Embedding ──────────────────────────────────────────────────────────
  embedding: [
    { type: 'string', description: 'Embedding 模型名。空=跟随主 Provider。推荐：空字符串', path: 'embedding.model' },
    { type: 'string', description: 'Embedding Base URL（走独立 embedding 服务时填）。推荐：空字符串', path: 'embedding.baseURL' },
    { type: 'number', description: 'Embedding 维度（0=模型自带默认）。推荐：0', path: 'embedding.dimensions' },
    { type: 'string', description: 'Embedding Keep Alive。推荐：空字符串', path: 'embedding.keepAlive' },
  ],

  // ─── Dashboard Snapshot ─────────────────────────────────────────────────
  dashboardSnapshot: [
    { type: 'boolean', description: '是否启用 Snapshot 能力服务（端口 7423，供设置页切换能力档次）。推荐：true', path: 'dashboardSnapshot.enabled' },
  ],

  // ─── MoA 多模型协作（基础字段，复杂嵌套请用「高级 JSON 编辑」）─────
  moa: [
    { type: 'boolean', description: '是否启用 MoA 多模型分层协作（多模型会诊复杂问题）。推荐：false（算力充分时开启）', path: 'moa.enabled' },
    { type: 'number', description: '任务复杂度阈值（0-1）：超过此值触发 MoA。推荐：0.6', path: 'moa.complexityThreshold' },
    { type: 'string', description: '协作模式：auto | parallel | serial。auto=自动判断（本地串行+远程并行，推荐）；parallel=强制并行（快但费 token）；serial=强制串行（省 token、稳）。推荐：auto', path: 'moa.mode' },
    { type: 'number', description: 'Phase1 参考模型同步阶段总时间预算（ms，>=30000）。超时则 fallback 单模型。推荐：240000（4 分钟）', path: 'moa.syncBudgetMs' },
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
    { path: 'summaryStrategy', type: 'string', description: '摘要策略：strategy | hybrid | full。strategy=按需生成（快、省 token，推荐默认）；hybrid=策略+关键节点全文（平衡）；full=所有命中节点全文（最准但费 token）。推荐：strategy', updatable: true, defaultValue: 'strategy' },
    { path: 'maxGraphDepth', type: 'number', description: '图谱最大遍历深度。小项目 3-5，中大型项目 10-20；过深易引发图谱膨胀。推荐：10', updatable: true, defaultValue: 10 },
    { path: 'maxNodeCount', type: 'number', description: '单次检索最大节点数（防内存爆）。推荐：5000', updatable: true, defaultValue: 5000 },
    { path: 'maxTokens', type: 'number', description: '上下文 token 预算（给检索结果留出的总上限）。推荐：65536', updatable: true, defaultValue: 65536 },
    { path: 'budgetRatio', type: 'number', description: '上下文预算占比（0-1）：检索结果占总上下文窗口的比例。值越大检索越全，留给思考的空间越少。推荐：0.3', updatable: true, defaultValue: 0.3 },
    { path: 'enableCrossFileLinkage', type: 'boolean', description: '启用跨文件关联：根据三元组在跨文件之间建边。推荐：true（大型代码库效果显著）', updatable: true, defaultValue: true },
    { path: 'crossReferenceRetentionDays', type: 'number', description: '跨引用保留天数。推荐：90', updatable: true, defaultValue: 90 },
    { path: 'distillationIntervalMs', type: 'number', description: '蒸馏间隔（毫秒）：两次经验蒸馏之间的最小间隔。推荐：7200000（每 2 小时）', updatable: true, defaultValue: 7200000 },
    { path: 'cliTimeout', type: 'number', description: 'CLI 超时（毫秒）：QMD CLI fallback 命令执行超时。推荐：30000（30s）', updatable: true, defaultValue: 30000 },
    { path: 'cliFallbackSearchType', type: 'string', description: 'CLI 降级搜索类型：search | hybrid。search=轻量词法（无向量）；hybrid=词法+向量（结果更全，推荐）。推荐：hybrid', updatable: true, defaultValue: 'hybrid' },
    { path: 'qmdMcpTimeout', type: 'number', description: 'QMD MCP 初始化握手超时（ms）。JSON-RPC 握手通常 <500ms。推荐：3000', updatable: true, defaultValue: 3000 },
    { path: 'qmdMcpQueryTimeout', type: 'number', description: 'QMD MCP/REST 查询超时（ms）。首次查询需 embedding 冷启动（4-5s），后续 300-400ms。推荐：15000', updatable: true, defaultValue: 15000 },
    { path: 'tripletTimeoutMs', type: 'number', description: '三元组提取超时（ms）：afterTurn 三元组 LLM 调用超时。本地大模型建议 60s。推荐：60000', updatable: true, defaultValue: 60000 },
    { path: 'experienceTtlIntervalMs', type: 'number', description: '经验 TTL 清理间隔（ms）。推荐：86400000（每 24 小时）', updatable: true, defaultValue: 86400000 },
    { path: 'enableCliFallback', type: 'boolean', description: '启用 QMD CLI 降级。关闭可避免 CLI 卡死；若 MCP+REST 均失败则直接报错。推荐：true', updatable: true, defaultValue: true },
    { path: 'largeFileThreshold', type: 'number', description: '大文件阈值（字节，简写覆盖 stubLargeToolPayloads.thresholdBytes）。~2K tokens 起步。推荐：8000', updatable: true, defaultValue: 8000 },
    { path: 'largeFilesDir', type: 'string', description: '大文件存储目录（简写覆盖 stubLargeToolPayloads.filesDir，空=默认 ~/.openclaw/lcm-files）。推荐：空字符串', updatable: true, defaultValue: '' },

    // ─── 压缩 ────────────────────────────────────────────────────────────
    { path: 'compaction.enabled', type: 'boolean', description: '是否启用 LCM 上下文压缩。开启可长期保持对话不爆上下文。推荐：true', updatable: true, defaultValue: true },
    { path: 'compaction.triggerThreshold', type: 'number', description: '触发压缩的消息条数阈值。推荐：20000', updatable: true, defaultValue: 20000 },
    { path: 'compaction.softThresholdTokens', type: 'number', description: '软阈值 token 数：超过此值开始计划压缩。推荐：163840', updatable: true, defaultValue: 163840 },
    { path: 'compaction.keepRecentTokens', type: 'number', description: '保留近期 token 数（不被压缩，保留最近对话上下文）。推荐：131072', updatable: true, defaultValue: 131072 },

    // ─── 经验提取 ────────────────────────────────────────────────────────
    { path: 'experience.enabled', type: 'boolean', description: '是否启用经验提取（长期知识积累）。推荐：true', updatable: true, defaultValue: true },
    { path: 'experience.relevanceThreshold', type: 'number', description: '经验相关性阈值（0-1）：高于此值的经验才会纳入当前上下文。越大越精准但召回越少。推荐：0.6', updatable: true, defaultValue: 0.6 },
    { path: 'experience.summaryMode', type: 'string', description: '摘要模式：async | sync。async=后台异步（对话不阻塞，推荐）；sync=写完立刻阻塞式摘要。推荐：async', updatable: true, defaultValue: 'async' },
    { path: 'experience.schedule.dreaming', type: 'string', description: 'Dreaming 定时 cron 表达式：夜间做全量经验再整理。推荐：0 3 * * *（凌晨 3 点）', updatable: true, defaultValue: '0 3 * * *' },
    { path: 'experience.schedule.incremental', type: 'string', description: '增量定时 cron 表达式：半天一次的增量经验抽取。推荐：0 */12 * * *', updatable: true, defaultValue: '0 */12 * * *' },

    // ─── TTL ─────────────────────────────────────────────────────────────
    { path: 'ttl.enabled', type: 'boolean', description: '是否启用 TTL 节点清理（自动淘汰过期图节点）。推荐：true', updatable: true, defaultValue: true },
    { path: 'ttl.retentionDays', type: 'number', description: 'TTL 保留天数：超过此天数的图节点被清理。推荐：90', updatable: true, defaultValue: 90 },
    { path: 'ttl.cleanupIntervalHours', type: 'number', description: '清理间隔（小时）。推荐：24', updatable: true, defaultValue: 24 },

    // ─── 检索 ────────────────────────────────────────────────────────────
    { path: 'retrieval.limits.qmd', type: 'number', description: 'QMD 检索条数。推荐：5', updatable: true, defaultValue: 5 },
    { path: 'retrieval.limits.graph', type: 'number', description: '图谱检索条数。推荐：5', updatable: true, defaultValue: 5 },
    { path: 'retrieval.limits.exp', type: 'number', description: '经验检索条数。推荐：3', updatable: true, defaultValue: 3 },
    { path: 'retrieval.qmd.mcpEndpoint', type: 'string', description: 'QMD MCP 端点地址。推荐：http://127.0.0.1:8081', updatable: true, defaultValue: 'http://127.0.0.1:8081' },
    { path: 'retrieval.graph.enabled', type: 'boolean', description: '启用图谱检索（Neo4j/GraphRAG）。推荐：true', updatable: true, defaultValue: true },
    { path: 'retrieval.graph.searchLimit', type: 'number', description: '图谱检索条数上限（1-20）。推荐：5', updatable: true, defaultValue: 5 },
    // BUG-6: 缓存容量可配置（原硬编码 50）
    { path: 'retrieval.graph.searchCacheSize', type: 'number', description: '图谱检索缓存大小（>=10）。推荐：50', updatable: true, defaultValue: 50 },
    { path: 'retrieval.cacheSize', type: 'number', description: 'L2/L4 查询缓存大小（>=10）。推荐：50', updatable: true, defaultValue: 50 },
    { path: 'retrieval.qmdQueryMaxChars', type: 'number', description: 'QMD vec/hyde 查询文本分片阈值（字符数，>=500）。超过拆分为多个分片独立查询，用 RRF 合并。推荐：8000；若遇到 documents exceed context size 可降到 3000', updatable: true, defaultValue: 8000 },

    // ─── 上下文监控 ──────────────────────────────────────────────────────
    { path: 'lcmMonitor.enabled', type: 'boolean', description: '是否启用 LCM 上下文监控与主动压缩。推荐：true', updatable: true, defaultValue: true },
    { path: 'lcmMonitor.contextWindow', type: 'number', description: '上下文窗口大小（tokens，即模型上下文上限）。推荐：262144', updatable: true, defaultValue: 262144 },
    { path: 'lcmMonitor.dedupRounds', type: 'number', description: '去重轮数（同一轮上下文压缩去重的迭代次数）。推荐：24', updatable: true, defaultValue: 24 },
    { path: 'lcmMonitor.highPressureThreshold', type: 'number', description: '高压阈值（0-1）：超过此值进入高压压缩，大量削减检索条数。推荐：0.85', updatable: true, defaultValue: 0.85 },
    { path: 'lcmMonitor.mediumPressureThreshold', type: 'number', description: '中压阈值（0-1）：超过此值进入中压，适度削减。推荐：0.7', updatable: true, defaultValue: 0.70 },
    { path: 'lcmMonitor.proactiveThreshold', type: 'number', description: '主动触发阈值（0-1）：超过此值后台开始规划压缩。推荐：0.65', updatable: true, defaultValue: 0.65 },
    { path: 'lcmMonitor.systemPromptOverheadTokens', type: 'number', description: '系统提示词开销（tokens，预留的系统提示词空间）。推荐：17000', updatable: true, defaultValue: 17000 },
    { path: 'lcmMonitor.compactTokenBudget', type: 'number', description: '压缩 token 预算：单次压缩后允许的最大摘要 token 数。推荐：114688', updatable: true, defaultValue: 114688 },
    { path: 'lcmMonitor.compactTimeout', type: 'number', description: '压缩超时（ms）。本地大模型建议 60s。推荐：60000', updatable: true, defaultValue: 60000 },
    { path: 'lcmMonitor.maxSummaryTokenRatio', type: 'number', description: '最大摘要 token 占比（0-1）：摘要不超过上下文的此比例。推荐：0.45', updatable: true, defaultValue: 0.45 },
    { path: 'lcmMonitor.retrievalLimits.low.qmd', type: 'number', description: '低压检索 QMD 条数。推荐：5', updatable: true, defaultValue: 5 },
    { path: 'lcmMonitor.retrievalLimits.low.graph', type: 'number', description: '低压检索 图谱 条数。推荐：5', updatable: true, defaultValue: 5 },
    { path: 'lcmMonitor.retrievalLimits.low.exp', type: 'number', description: '低压检索 经验 条数。推荐：3', updatable: true, defaultValue: 3 },
    { path: 'lcmMonitor.retrievalLimits.medium.qmd', type: 'number', description: '中压检索 QMD 条数。推荐：3', updatable: true, defaultValue: 3 },
    { path: 'lcmMonitor.retrievalLimits.medium.graph', type: 'number', description: '中压检索 图谱 条数。推荐：3', updatable: true, defaultValue: 3 },
    { path: 'lcmMonitor.retrievalLimits.medium.exp', type: 'number', description: '中压检索 经验 条数。推荐：1', updatable: true, defaultValue: 1 },
    { path: 'lcmMonitor.retrievalLimits.high.qmd', type: 'number', description: '高压检索 QMD 条数。推荐：1', updatable: true, defaultValue: 1 },
    { path: 'lcmMonitor.retrievalLimits.high.graph', type: 'number', description: '高压检索 图谱 条数。推荐：1', updatable: true, defaultValue: 1 },
    { path: 'lcmMonitor.retrievalLimits.high.exp', type: 'number', description: '高压检索 经验 条数。推荐：0', updatable: true, defaultValue: 0 },
    { path: 'lcmMonitor.maxContextChars.low', type: 'number', description: '低压上下文字符数。推荐：12000', updatable: true, defaultValue: 12000 },
    { path: 'lcmMonitor.maxContextChars.medium', type: 'number', description: '中压上下文字符数。推荐：6000', updatable: true, defaultValue: 6000 },
    { path: 'lcmMonitor.maxContextChars.high', type: 'number', description: '高压上下文字符数。推荐：1600', updatable: true, defaultValue: 1600 },

    // ─── LLM 超时 ────────────────────────────────────────────────────────
    { path: 'llmTimeouts.rerankTimeoutMs', type: 'number', description: 'Rerank 超时（ms）。推荐：30000', updatable: true, defaultValue: 30000 },
    { path: 'llmTimeouts.judgeTimeoutMs', type: 'number', description: 'Judge 超时（ms）：Cascade Tier2 判断。推荐：60000', updatable: true, defaultValue: 60000 },
    { path: 'llmTimeouts.validateTimeoutMs', type: 'number', description: 'Validate 超时（ms）：经验相关性校验。推荐：45000', updatable: true, defaultValue: 45000 },
    { path: 'llmTimeouts.summarizeTimeoutMs', type: 'number', description: 'Summarize 超时（ms）：经验回顾摘要。推荐：90000', updatable: true, defaultValue: 90000 },
    { path: 'llmTimeouts.embedTimeoutMs', type: 'number', description: 'Embed 超时（ms）：Embedding 调用。推荐：60000', updatable: true, defaultValue: 60000 },
    { path: 'llmTimeouts.graphLlmTimeoutMs', type: 'number', description: 'Graph LLM 超时（ms）：三元组提取回退。推荐：90000', updatable: true, defaultValue: 90000 },
    { path: 'llmTimeouts.cascadeTier2Ms', type: 'number', description: 'Cascade Tier2 超时（ms）：Promise.race 回退。推荐：60000', updatable: true, defaultValue: 60000 },
    { path: 'llmTimeouts.cascadeTier3Ms', type: 'number', description: 'Cascade Tier3 超时（ms）：工具验证。推荐：90000', updatable: true, defaultValue: 90000 },
    { path: 'llmTimeouts.distillMs', type: 'number', description: 'Distill 超时（ms）：单次经验蒸馏。推荐：120000', updatable: true, defaultValue: 120000 },

    // ─── 备份 ────────────────────────────────────────────────────────────
    { path: 'backupConfig.enabled', type: 'boolean', description: '是否启用图谱+经验自动备份。推荐：true', updatable: true, defaultValue: true },
    { path: 'backupConfig.retentionDays', type: 'number', description: '备份保留天数。推荐：30', updatable: true, defaultValue: 30 },
    { path: 'backupConfig.maxBackups', type: 'number', description: '最大备份数。推荐：10', updatable: true, defaultValue: 10 },
    { path: 'backupConfig.intervalHours', type: 'number', description: '备份间隔（小时）。推荐：24', updatable: true, defaultValue: 24 },
    { path: 'backupConfig.backupDir', type: 'string', description: '备份目录路径（空=默认 ~/.openclaw/backups）。推荐：空字符串', updatable: true, defaultValue: '' },

    // ─── 大文件存根 ──────────────────────────────────────────────────────
    { path: 'stubLargeToolPayloads.enabled', type: 'boolean', description: '启用大工具负载外部分片 + 存根替换（兼容 lossless-claw）。小文件可不启用。推荐：false（按需开启）', updatable: true, defaultValue: false },
    { path: 'stubLargeToolPayloads.thresholdBytes', type: 'number', description: '触发阈值（字节，~2K tokens）。推荐：8000', updatable: true, defaultValue: 8000 },
    { path: 'stubLargeToolPayloads.filesDir', type: 'string', description: '外部文件存储目录（空=默认 ~/.openclaw/lcm-files）。推荐：空字符串', updatable: true, defaultValue: '' },
    { path: 'stubLargeToolPayloads.freshTailCount', type: 'number', description: '最近 N 条消息不存根（fresh tail 保护，防止最新上下文丢失）。推荐：8', updatable: true, defaultValue: 8 },

    // ─── Webhook ─────────────────────────────────────────────────────────
    { path: 'webhook.enabled', type: 'boolean', description: '是否启用 Webhook（事件回调到自定义地址）。推荐：false（无外部系统时）', updatable: true, defaultValue: false },
    { path: 'webhook.url', type: 'string', description: 'Webhook URL（SSRF 风险，不支持热更新）', updatable: false, defaultValue: '' },

    // ─── 日志 ────────────────────────────────────────────────────────────
    { path: 'logging.level', type: 'string', description: '日志级别：silent | fatal | error | warn | info | debug | trace。silent=完全静默；fatal/error=仅报错；warn=警告+错误；info=常规运行（推荐）；debug=排查问题；trace=全量追踪。推荐：info', updatable: true, defaultValue: 'info' },
    { path: 'logging.file', type: 'string', description: '日志文件路径（空=仅标准输出）。推荐：空字符串', updatable: true, defaultValue: '' },

    // ─── LLM Provider ────────────────────────────────────────────────────
    { path: 'llmProvider.provider', type: 'string', description: 'LLM Provider 类型：openclaw_hooks | openai | ollama | deepseek | unsloth | custom。openclaw_hooks=通过 OpenClaw 网关自动路由（推荐默认）；ollama=本地部署；openai/deepseek=云端 API；custom=自定义 BaseURL。推荐：openclaw_hooks', updatable: true, defaultValue: 'openclaw_hooks' },
    { path: 'llmProvider.model', type: 'string', description: 'LLM 模型名。推荐：default（随 provider 默认）', updatable: true, defaultValue: 'default' },
    { path: 'llmProvider.maxTokens', type: 'number', description: 'LLM 最大 token 数：8192 | 16384 | 24576 | 32768。按模型上下文窗口匹配：8k(<32k) / 16k(32k-64k) / 24k(64k-128k) / 32k(>=128k)。推荐：32768', updatable: true, defaultValue: 32768 },

    // ─── 蒸馏 LLM ────────────────────────────────────────────────────────
    { path: 'distillationLlm.provider', type: 'string', description: '蒸馏 LLM Provider 类型：openclaw_hooks | openai | ollama | deepseek | unsloth | custom。经验蒸馏模型，建议用本地强模型。推荐：openclaw_hooks', updatable: true, defaultValue: 'openclaw_hooks' },
    { path: 'distillationLlm.model', type: 'string', description: '蒸馏 LLM 模型名（建议能力>=27B，本地 qwen3.6:27b 起步）。推荐：ollama/qwen3.6:27b', updatable: true, defaultValue: 'ollama/qwen3.6:27b' },
    { path: 'distillationLlm.apiKey', type: 'string', description: '蒸馏 LLM API Key（脱敏）', updatable: false, defaultValue: '***' },
    { path: 'distillationLlm.baseURL', type: 'string', description: '蒸馏 LLM Base URL。custom 时必填。推荐：空字符串', updatable: true, defaultValue: '' },
    { path: 'distillationLlm.keepAlive', type: 'string', description: '蒸馏 LLM Keep Alive（模型内存驻留时长，如 1h=保留 1 小时）。注意：不是请求超时，超时看 llmTimeouts.distillMs。推荐：1h', updatable: true, defaultValue: '1h' },

    // ─── Embedding ───────────────────────────────────────────────────────
    { path: 'embedding.model', type: 'string', description: 'Embedding 模型名。空=跟随主 Provider。推荐：空字符串', updatable: true, defaultValue: '' },
    { path: 'embedding.apiKey', type: 'string', description: 'Embedding API Key（脱敏）', updatable: false, defaultValue: '***' },
    { path: 'embedding.baseURL', type: 'string', description: 'Embedding Base URL（走独立 embedding 服务时填）。推荐：空字符串', updatable: true, defaultValue: '' },
    { path: 'embedding.dimensions', type: 'number', description: 'Embedding 维度（0=模型自带默认）。推荐：0', updatable: true, defaultValue: 0 },
    { path: 'embedding.keepAlive', type: 'string', description: 'Embedding Keep Alive。推荐：空字符串', updatable: true, defaultValue: '' },

    // ─── Dashboard Snapshot ──────────────────────────────────────────────
    { path: 'dashboardSnapshot.enabled', type: 'boolean', description: '是否启用 Snapshot 能力服务（端口 7423，供设置页切换能力档次）。推荐：true', updatable: true, defaultValue: true },
    { path: 'dashboardSnapshot.port', type: 'number', description: 'Snapshot 服务端口', updatable: false, defaultValue: 7423 },
    { path: 'dashboardSnapshot.host', type: 'string', description: 'Snapshot 服务监听地址', updatable: false, defaultValue: '127.0.0.1' },

    // ─── MoA 多模型协作（基础字段；复杂嵌套用「高级 JSON 编辑」）────────
    { path: 'moa.enabled', type: 'boolean', description: '是否启用 MoA 多模型分层协作（多模型会诊复杂问题）。推荐：false（算力充分时开启）', updatable: true, defaultValue: false },
    { path: 'moa.complexityThreshold', type: 'number', description: '任务复杂度阈值（0-1）：超过此值触发 MoA。推荐：0.6', updatable: true, defaultValue: 0.6 },
    { path: 'moa.mode', type: 'string', description: '协作模式：auto | parallel | serial。auto=自动判断（本地串行+远程并行，推荐）；parallel=强制并行（快但费 token）；serial=强制串行（省 token、稳）。推荐：auto', updatable: true, defaultValue: 'auto' },
    { path: 'moa.syncBudgetMs', type: 'number', description: 'Phase1 参考模型同步阶段总时间预算（ms，>=30000）。超时则 fallback 单模型。推荐：240000（4 分钟）', updatable: true, defaultValue: 240000 },

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

    ensureConfigDir();
    writeFileSync(path, JSON.stringify(root, null, 2), 'utf-8');
  }

  // graph-memory-pro 配置 schema 文档（缓存，避免每次请求重建）
  let _gmProSchemaDocCache: SchemaFieldDoc[] | null = null;

  /** 尝试定位 graph-memory-pro 插件的 openclaw.plugin.json */
  function resolveGmProPluginJson(): string | null {
    // 1. 环境变量 GM_PRO_PATH
    if (process.env.GM_PRO_PATH) {
      const p = join(process.env.GM_PRO_PATH, 'openclaw.plugin.json');
      if (existsSync(p)) return p;
    }
    // 2. global extensions: ~/.openclaw/extensions/graph-memory-pro
    const globalPath = join(homedir(), '.openclaw', 'extensions', GM_PRO_PLUGIN_ID, 'openclaw.plugin.json');
    if (existsSync(globalPath)) return globalPath;
    // 3. workspace extensions: <cwd>/.openclaw/extensions/graph-memory-pro
    const workspacePath = join(process.cwd(), '.openclaw', 'extensions', GM_PRO_PLUGIN_ID, 'openclaw.plugin.json');
    if (existsSync(workspacePath)) return workspacePath;
    // 4. stock extensions: <openclaw>/dist/extensions/graph-memory-pro
    try {
      const req = createRequire(import.meta.url);
      const openclawPkgRoot = dirname(req.resolve('openclaw/package.json'));
      const stockPath = join(openclawPkgRoot, 'dist', 'extensions', GM_PRO_PLUGIN_ID, 'openclaw.plugin.json');
      if (existsSync(stockPath)) return stockPath;
    } catch { /* openclaw package not found */ }
    return null;
  }

  /** JSON Schema 属性定义 */
  interface GmProSchemaProperty {
    type?: string;
    default?: unknown;
    description?: string;
    minimum?: number;
    maximum?: number;
    enum?: unknown[];
    properties?: Record<string, GmProSchemaProperty>;
    additionalProperties?: boolean;
    required?: string[];
    sensitive?: boolean;
    oneOf?: Array<{ type: string; default?: unknown }>;
  }

  /** 将 JSON Schema type 映射为 dashboard 字段类型 */
  function mapJsonSchemaType(type: string): string {
    if (type === 'integer' || type === 'number') return 'number';
    if (type === 'boolean') return 'boolean';
    return 'string';
  }

  /** 递归展平 configSchema.properties 为 SchemaFieldDoc 列表 */
  function flattenGmProSchema(
    properties: Record<string, GmProSchemaProperty>,
    prefix: string,
    uiHints: Record<string, { label?: string; sensitive?: boolean; help?: string }> | undefined,
    parentContext?: string,
  ): SchemaFieldDoc[] {
    const docs: SchemaFieldDoc[] = [];
    for (const [key, prop] of Object.entries(properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const hint = uiHints?.[path] ?? uiHints?.[key];
      const isSensitive = hint?.sensitive === true || prop.sensitive === true;

      if (prop.properties && typeof prop.properties === 'object') {
        // 嵌套对象 → 递归展平，传递父级描述作为子字段上下文
        const childContext = prop.description ?? parentContext;
        docs.push(...flattenGmProSchema(prop.properties, path, uiHints, childContext));
      } else if (prop.oneOf && Array.isArray(prop.oneOf)) {
        // oneOf → 取第一个选项的类型和默认值
        const first = prop.oneOf[0];
        const type = first?.type ?? 'string';
        const enumOptions = (prop.enum ?? (first as GmProSchemaProperty)?.enum) as unknown[] | undefined;
        docs.push({
          path,
          type: mapJsonSchemaType(type),
          description: buildFieldDescription(key, path, prop.description, parentContext, hint, enumOptions, prop.default ?? first?.default),
          updatable: !isSensitive,
          defaultValue: first?.default ?? prop.default,
        });
      } else {
        const type = prop.type ?? 'string';
        docs.push({
          path,
          type: mapJsonSchemaType(type),
          description: buildFieldDescription(key, path, prop.description, parentContext, hint, prop.enum as unknown[] | undefined, prop.default),
          updatable: !isSensitive,
          defaultValue: prop.default,
        });
      }
    }
    return docs;
  }

  /**
   * 智能生成字段描述，优先级：
   * 1. uiHints.label（用户显式标注）
   * 2. schema 中的 description（插件作者提供） + 附加 enum 列表 + help 推荐
   * 3. 父级上下文 + 路径推断（如 "llm.apiKey" → "LLM API Key"）
   * 4. 字段 key 名兜底
   *
   * 枚举列表采用 "：opt1 | opt2 | opt3" 后缀格式，便于前端 parseEnumOptions 解析为 NSelect 选项。
   */
  function buildFieldDescription(
    key: string,
    path: string,
    schemaDesc: string | undefined,
    parentContext: string | undefined,
    hint: { label?: string; help?: string } | undefined,
    enumOptions: unknown[] | undefined,
    _defaultValue: unknown,
  ): string {
    // 1) 显式 label 直接用（但仍附加 enum/help 让前端解析）
    const base = hint?.label
      ? hint.label
      : schemaDesc
        ? schemaDesc
        : (() => {
            const parts = path.split('.');
            const contextPrefix = parentContext
              ? parentContext.split('。')[0].split('：')[0] + ' - '
              : '';
            const keyLabel = KEY_LABEL_MAP[key] ?? key;
            return contextPrefix + keyLabel;
          })();

    const pieces: string[] = [base];

    // 2) 枚举选项 → 追加 "：a | b | c" 格式（便于 parseEnumOptions 抽取）
    if (enumOptions && enumOptions.length > 0) {
      pieces.push('：' + enumOptions.map((o) => String(o)).join(' | '));
    }

    // 3) help → 作为「建议」追加
    if (hint?.help) {
      pieces.push('。建议：' + hint.help);
    }

    return pieces.join('');
  }

  /** 常见字段名 → 中文描述映射 */
  const KEY_LABEL_MAP: Record<string, string> = {
    apiKey: 'API Key',
    baseURL: 'API 地址',
    model: '模型名',
    dimensions: '向量维度',
    keepAlive: 'Keep Alive（模型内存驻留时间）',
    provider: 'Provider 类型',
    maxTokens: '最大 Token 数',
    enabled: '是否启用',
    uri: '连接地址',
    user: '用户名',
    password: '密码',
    host: '监听地址',
    port: '端口号',
    level: '日志级别',
    file: '日志文件路径',
    url: 'URL 地址',
    events: '触发事件列表',
    mode: '协作模式',
    temperature: '温度参数',
    systemPrompt: 'System Prompt',
    timeoutMs: '超时时间（ms）',
    syncBudgetMs: '同步阶段预算（ms）',
    complexityThreshold: '复杂度阈值',
    referenceModels: '参考模型列表',
    aggregatorModel: '聚合模型配置',
    enabledTiers: '启用层级',
    triggers: '触发条件',
    summaryMode: '摘要模式',
    schedule: '定时调度',
    dreaming: 'Dreaming 定时',
    incremental: '增量定时',
    retentionDays: '保留天数',
    cleanupIntervalHours: '清理间隔（小时）',
    maxBackups: '最大备份数',
    intervalHours: '备份间隔（小时）',
    backupDir: '备份目录',
    triggerThreshold: '触发阈值',
    softThresholdTokens: '软阈值 Token 数',
    keepRecentTokens: '保留近期 Token 数',
    relevanceThreshold: '相关性阈值',
    qmd: 'QMD 检索',
    graph: '图谱检索',
    exp: '经验检索',
    searchLimit: '检索条数上限',
    searchCacheSize: '检索缓存大小',
    cacheSize: '缓存大小',
    mcpEndpoint: 'MCP 端点地址',
    contextWindow: '上下文窗口大小',
    dedupRounds: '去重轮数',
    highPressureThreshold: '高压阈值',
    mediumPressureThreshold: '中压阈值',
    proactiveThreshold: '主动触发阈值',
    systemPromptOverheadTokens: '系统提示词开销（Tokens）',
    compactTokenBudget: '压缩 Token 预算',
    compactTimeout: '压缩超时（ms）',
    maxSummaryTokenRatio: '最大摘要 Token 占比',
    low: '低压',
    medium: '中压',
    high: '高压',
  };

  function buildGmProSchemaDoc(): SchemaFieldDoc[] {
    if (_gmProSchemaDocCache) return _gmProSchemaDocCache;

    const pluginJsonPath = resolveGmProPluginJson();
    if (!pluginJsonPath) {
      _gmProSchemaDocCache = [];
      return _gmProSchemaDocCache;
    }

    try {
      const raw = readFileSync(pluginJsonPath, 'utf-8');
      const manifest = JSON.parse(raw);
      const configSchema = manifest?.configSchema;
      if (!configSchema?.properties) {
        _gmProSchemaDocCache = [];
        return _gmProSchemaDocCache;
      }

      const docs = flattenGmProSchema(
        configSchema.properties as Record<string, GmProSchemaProperty>,
        '',
        manifest?.uiHints as Record<string, { label?: string; sensitive?: boolean; help?: string }> | undefined,
      );
      _gmProSchemaDocCache = docs;
      return docs;
    } catch {
      _gmProSchemaDocCache = [];
      return _gmProSchemaDocCache;
    }
  }

  /** 从 schema 动态生成可更新字段白名单 */
  function getGmProUpdatableFields(): Array<{ type: 'number' | 'boolean' | 'string' | 'object'; description: string; path: string }> {
    const docs = buildGmProSchemaDoc();
    return docs
      .filter((f) => f.updatable)
      .map((f) => ({
        type: (f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : 'string') as 'number' | 'boolean' | 'string',
        description: f.description,
        path: f.path,
      }));
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

    const updatableFields = getGmProUpdatableFields();
    const allowedPaths = new Set<string>();
    for (const f of updatableFields) allowedPaths.add(f.path);

    const applied: string[] = [];
    const rejected: Array<{ path: string; reason: string }> = [];
    const mergedUpdates: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(updates)) {
      if (!allowedPaths.has(key)) {
        rejected.push({ path: key, reason: 'field not in updatable whitelist' });
        continue;
      }
      const fieldDef = updatableFields.find((f) => f.path === key);
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
