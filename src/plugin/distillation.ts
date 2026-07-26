/**
 * Distillation helpers
 *
 * LLM-based experience distillation:
 * - isOllamaModel: detect Ollama local models
 * - resolveDistillationLlm: pick the right LLM config for distillation
 * - distillOne: LLM prompt + parse → distilled experience object
 * - runDistillation: batch process pending experiences
 */
import { randomUUID } from 'node:crypto';
import { ensureOllamaV1Path, ensureAnthropicMessagesPath } from '../utils/url.js';
import { callLlm, isLocalLlm } from '../utils/llm-call.js';
import { businessMetrics } from '../health-metrics.js';
import { llmTimeout } from '../config/defaults.js';

export function isOllamaModel(model: string): boolean {
  // 判断主会话模型是否为 Ollama 本地模型。
  // 识别依据：
  //   1. 显式 provider 前缀：`ollama/...`、`ollama-256k/...`
  //   2. Ollama 默认 tag 后缀：`:latest`
  //   3. Ollama model:tag 命名格式：`qwen3.6:27b`、`llama3:8b` 等
  //      （OpenAI/Anthropic/Gemini 模型名不含冒号，冒号是 Ollama 的 tag 分隔符）
  // 注意：原逻辑 `!model.includes('/')` 会把 `gpt-4o-mini`、`claude-3-5-sonnet`
  // 等不含 `/` 的远程模型名误判为 Ollama，导致错误地走 Ollama baseURL。
  // 已去除该过宽分支。
  if (model.startsWith('ollama/') || model.startsWith('ollama-256k/') || model.endsWith(':latest')) {
    return true;
  }
  // model:tag 格式检测：不含 / 但含 :（排除 litellm provider/model:tag 格式，
  // 那些已被上面的 ollama/ 前缀分支覆盖）
  // 例：qwen3.6:27b, llama3:8b, mistral:7b-instruct
  // 排除 OpenAI fine-tune 格式 ft:gpt-4o:xxx（含多个冒号）
  if (!model.includes('/') && /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/.test(model)) {
    return true;
  }
  return false;
}

export function resolveDistillationLlm(apiRef: any) {
  // 优先从 runtimeContext.llm 读取（SDK 注入的运行时会话模型）
  const runtimeLlm = apiRef?.runtimeContext?.llm;
  // 插件配置：openclaw.json 中 plugins.entries.lcm-graph-extra.config
  // 注意：属性名是 pluginConfig，不是 config（api.config 是 workspace 配置）
  const pluginConfig = apiRef?.pluginConfig ?? apiRef?.config ?? {};
  // 默认 keepAlive（可被 distillationLlm.keepAlive 覆盖）
  const defaultKeepAlive = pluginConfig?.distillationLlm?.keepAlive
    || pluginConfig?.embedding?.keepAlive
    || '1h';
  // Session model is local (Ollama, vLLM/unsloth, etc.) → reuse it to avoid GPU model swapping
  if (runtimeLlm?.model && runtimeLlm?.baseURL && isLocalLlm(runtimeLlm.baseURL, runtimeLlm.model)) {
    return {
      model: runtimeLlm.model,
      apiKey: runtimeLlm.apiKey || '',
      baseURL: runtimeLlm.baseURL,
      keepAlive: defaultKeepAlive,
    };
  }
  if (runtimeLlm?.model && isOllamaModel(runtimeLlm.model)) {
    return {
      model: runtimeLlm.model,
      apiKey: runtimeLlm.apiKey || '',
      baseURL: ensureOllamaV1Path(runtimeLlm.baseURL || 'http://127.0.0.1:18789/v1'),
      keepAlive: defaultKeepAlive,
    };
  }
  const dLlm = pluginConfig?.distillationLlm;
  if (dLlm?.provider === 'openclaw_hooks') return {
    model: dLlm.model || 'ollama/qwen3.6:27b',
    apiKey: '',
    baseURL: ensureOllamaV1Path(dLlm.baseURL || 'http://127.0.0.1:18789/v1'),
    keepAlive: dLlm.keepAlive || defaultKeepAlive,
  };
  // unsloth 本地部署：使用 Anthropic /v1/messages 格式
  // 用户填写的地址类似 http://192.168.50.5:8888，自动拼接 /v1/messages
  if (dLlm?.provider === 'unsloth') return {
    model: dLlm.model || 'qwen2.5-72b',
    apiKey: dLlm.apiKey || '',
    baseURL: ensureAnthropicMessagesPath(dLlm.baseURL || 'http://127.0.0.1:8000'),
    keepAlive: dLlm.keepAlive || defaultKeepAlive,
  };
  if (dLlm?.provider && dLlm?.model) {
    return {
      model: dLlm.model,
      apiKey: dLlm.apiKey || '',
      baseURL: ensureOllamaV1Path(dLlm.baseURL || 'http://127.0.0.1:18789/v1'),
      keepAlive: dLlm.keepAlive || defaultKeepAlive,
    };
  }
  return {
    model: process.env.LLM_MODEL || dLlm?.model || 'gpt-4o-mini',
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    baseURL: ensureOllamaV1Path(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    keepAlive: defaultKeepAlive,
  };
}

export async function distillOne(
  raw: { id: string; source: string; context: string; detail: string },
  llm: { model: string; apiKey: string; baseURL: string; keepAlive?: string },
  log?: { warn?: (msg: string, meta?: any) => void; debug?: (msg: string, meta?: any) => void; info?: (msg: string, meta?: any) => void },
  errorSink?: string[],
): Promise<any | null> {
  // P1-4: prompt 增加 tags 字段，让 LLM 同时产出多维度标签（scenario/techStack/severity/freeTags）。
  // S-11': Zettelkasten 增强 — 增加 relatedConcepts 字段，提取 2-5 个相关概念/关键词，
  // 用于后续在经验网络中建立 RELATED_TO 边，形成知识图谱连接。
  //
  // BUGFIX: qwen3 系列模型默认开启思考模式，思考内容会消耗全部 max_tokens 导致
  // content 为空（finish_reason: length）。通过 /no_think 软开关关闭思考模式。
  // 注意：Ollama 的 think 参数仅适用于原生 API (/api/chat)，OpenAI 兼容端点
  // (/v1/chat/completions) 不支持，必须用 /no_think prompt 软开关。
  const prompt = '/no_think\nSummarize the following experience into a concise lesson.' + '\nSource: ' + raw.source + '\nContext: ' + raw.context + '\nDetail: ' + raw.detail
    + '\nReturn a JSON with: title, summary, type (lesson|failure|correction|fix|best_practice), relevanceScore (0-1),'
    + ' scenario (array, subset of: bug-fix|feature-dev|code-review|config-debug|deployment|performance-opt|security-audit|refactor),'
    + ' techStack (array, subset of: frontend|backend|devops|database|mobile|ai-ml|infrastructure|general),'
    + ' severity (one of: critical|major|minor), freeTags (array of short strings),'
    + ' relatedConcepts (array of 2-5 short keywords/phrases representing closely related topics or concepts for cross-linking).'
    + ' Return ONLY JSON without any thinking process.';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), llmTimeout('distillMs'));
  try {
    const result = await callLlm({
      baseURL: llm.baseURL,
      apiKey: llm.apiKey,
      model: llm.model,
      prompt,
      temperature: 0.3,
      maxTokens: 4096,
      keepAlive: llm.keepAlive,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = result.text;
    if (!text) {
      const errMsg = `LLM returned empty content (model: ${llm.model}, endpoint: ${llm.baseURL})`;
      log?.warn?.('distillOne: LLM returned empty content', { rawId: raw.id, model: llm.model });
      errorSink?.push(errMsg);
      return null;
    }
    // 本地模型常把 JSON 包在 ```json ... ``` 代码块中，直接 JSON.parse 会失败。
    // 提取代码块内的 JSON 内容，或去除前后非 JSON 文本。
    const jsonText = extractJsonFromText(text);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      const errMsg = `LLM returned non-JSON content (parse error: ${parseErr})`;
      log?.warn?.('distillOne: LLM returned non-JSON content', { rawId: raw.id, parseErr: String(parseErr), textPreview: text.slice(0, 300) });
      errorSink?.push(errMsg);
      return null;
    }
    // P1-4: 校验并收敛 tags，防止 LLM 返回非法值写入 Neo4j。
    const SCENARIO_SET = new Set(['bug-fix', 'feature-dev', 'code-review', 'config-debug', 'deployment', 'performance-opt', 'security-audit', 'refactor']);
    const TECH_SET = new Set(['frontend', 'backend', 'devops', 'database', 'mobile', 'ai-ml', 'infrastructure', 'general']);
    const SEVERITY_SET = new Set(['critical', 'major', 'minor']);
    const filterArr = (v: any, allowed: Set<string>): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v.map(String).filter((x) => allowed.has(x));
      return out.length > 0 ? out : undefined;
    };
    let severity = filterArr(parsed.severity, SEVERITY_SET)?.[0] as any;
    let freeTags: string[] | undefined;
    if (Array.isArray(parsed.freeTags)) {
      const ft = parsed.freeTags.map(String).filter((s: string) => s.trim().length > 0 && s.length <= 30).slice(0, 8);
      freeTags = ft.length > 0 ? ft : undefined;
    }
    const tags = (parsed.scenario || parsed.techStack || severity || freeTags)
      ? {
          scenario: filterArr(parsed.scenario, SCENARIO_SET) as any,
          techStack: filterArr(parsed.techStack, TECH_SET) as any,
          severity,
          freeTags,
        }
      : undefined;
    // S-11': 提取 relatedConcepts（Zettelkasten 关联概念）
    let relatedConcepts: string[] | undefined;
    if (Array.isArray(parsed.relatedConcepts)) {
      const rc = parsed.relatedConcepts
        .map(String)
        .filter((s: string) => s.trim().length > 0 && s.length <= 50)
        .slice(0, 5);
      relatedConcepts = rc.length > 0 ? rc : undefined;
    }

    // 校验 relevanceScore 范围 [0,1]，越界回退 0.5
    let rs = typeof parsed.relevanceScore === 'number' ? parsed.relevanceScore : 0.5;
    if (!isFinite(rs) || rs < 0) rs = 0; else if (rs > 1) rs = 1;
    return { id: 'exp_dist_' + randomUUID(), rawIds: [raw.id], type: parsed.type || 'lesson', title: parsed.title || raw.source, summary: parsed.summary || '(no summary)', detail: (raw.detail || '').slice(0, 2000), context: raw.context || '', relevanceScore: rs, createdAt: new Date(), matchCount: 0, tags, relatedConcepts };
  } catch (err) {
    clearTimeout(timer);
    const errName = err instanceof Error ? err.name : '';
    if (errName === 'AbortError') {
      const errMsg = `LLM call timeout after ${llmTimeout('distillMs')}ms (model: ${llm.model}, endpoint: ${llm.baseURL})`;
      log?.warn?.('distillOne: LLM call timeout', { rawId: raw.id, timeoutMs: llmTimeout('distillMs') });
      errorSink?.push(errMsg);
    } else {
      const errMsg = `Unexpected error: ${err instanceof Error ? err.message : String(err)} (endpoint: ${llm.baseURL})`;
      log?.warn?.('distillOne: unexpected error', { rawId: raw.id, err: err instanceof Error ? err.message : String(err) });
      errorSink?.push(errMsg);
    }
    return null;
  }
}

/**
 * 从 LLM 返回的文本中提取 JSON 内容。
 *
 * 本地模型（如 qwen）常把 JSON 包在 ```json ... ``` 代码块中，
 * 或在 JSON 前后添加解释性文字。此函数尝试：
 *   1. 提取 ```json ... ``` 或 ``` ... ``` 代码块内容
 *   2. 若无代码块，寻找第一个 { 到最后一个 } 的子串
 *   3. 都失败则返回原文（让 JSON.parse 报错）
 */
function extractJsonFromText(text: string): string {
  // 1. 匹配 ```json ... ``` 或 ``` ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }
  // 2. 匹配第一个 { 到最后一个 }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  // 3. 返回原文
  return text.trim();
}

/**
 * 剥离 qwen3 思考模式产生的 <think>...</think> 标签块。
 *
 * 即使使用了 /no_think 软开关，某些情况下模型仍可能输出思考内容。
 * 思考内容包裹在 <think>...</think> 标签中，需要移除后再提取 JSON。
 *
 * 同时处理未闭合的 <think> 标签（max_tokens 截断时可能只有开标签）。
 */
function stripThinkTags(text: string): string {
  // 移除完整的 <think>...</think> 块
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 处理未闭合的 <think> 标签（截断时只有开标签，后面全是思考内容）
  // 这种情况下 <think> 之后的内容都是思考，JSON 可能在 <think> 之前
  const openTagIdx = result.indexOf('<think>');
  if (openTagIdx !== -1 && result.toLowerCase().indexOf('</think>') === -1) {
    result = result.slice(0, openTagIdx);
  }
  return result.trim();
}

/** 蒸馏结果汇总 */
export interface DistillationResult {
  pending: number;
  succeeded: number;
  failed: number;
  linked: number;
  llmModel: string;
  llmBaseURL: string;
  /** Neo4j/graphAdapter 连接状态：connected / disconnected / unknown */
  graphConnected?: string;
  /** 初始化或查询错误信息（fetchPending 失败等） */
  error?: string;
  /** 第一条 distillOne 失败的具体原因（HTTP 状态码/超时/JSON 解析失败等） */
  firstDistillError?: string;
  /** 本次处理中来自 FAILED 重试的经验数量（retryCount > 0） */
  retriedFailed?: number;
  /** 已耗尽重试次数（retryCount >= maxRetries）的 FAILED 节点数量，需手动重置 */
  skippedFailed?: number;
  /** 最大自动重试次数（用于展示） */
  maxRetries?: number;
}

export async function runDistillation(expStoreRef: any, apiRef: any, log: any, limit?: number): Promise<DistillationResult> {
  const result: DistillationResult = {
    pending: 0,
    succeeded: 0,
    failed: 0,
    linked: 0,
    llmModel: '',
    llmBaseURL: '',
  };

  // 1. 先解析 LLM 配置（即使 pending=0 也返回，方便用户确认配置是否正确）
  try {
    const llm = resolveDistillationLlm(apiRef);
    result.llmModel = llm.model;
    result.llmBaseURL = llm.baseURL;
  } catch (llmErr) {
    log?.warn?.('distillation: resolveDistillationLlm failed', { err: String(llmErr) });
    result.llmModel = '(config resolve failed)';
    result.llmBaseURL = '';
  }

  // 2. 检查 graphAdapter 连接状态
  // graphAdapter.query 在 driver 为 null 时静默返回 []，需要显式检查连接状态
  // ExperienceStorage 暴露 isConnected getter，委托给 graphAdapter.isConnected
  const storeConnected = typeof expStoreRef?.isConnected === 'boolean'
    ? expStoreRef.isConnected
    : typeof expStoreRef?.isConnected === 'function'
      ? (() => { try { return Boolean(expStoreRef.isConnected()); } catch { return false; } })()
      : null;

  if (storeConnected !== null) {
    result.graphConnected = storeConnected ? 'connected' : 'disconnected';
    if (!storeConnected) {
      // graphAdapter 在插件初始化时可能连接失败，但 Neo4j 现在可能已恢复。
      // 尝试重新连接 graphAdapter（connect() 内部有防重复逻辑，安全重试）。
      log?.info?.('distillation: graphAdapter not connected, attempting reconnect...');
      try {
        const adapter = (expStoreRef as any)?.adapter;
        if (adapter && typeof adapter.connect === 'function') {
          const reconnected = await adapter.connect();
          if (reconnected) {
            // BUGFIX: connect() 可能返回 true 但 driver 实际为 null
            // （gm-pro getDriver 返回 null + acquireDriver 异常被 catch）。
            // 必须重新检查 isConnected 确认 driver 确实已建立。
            const nowConnected = typeof expStoreRef.isConnected === 'boolean'
              ? expStoreRef.isConnected
              : false;
            if (nowConnected) {
              result.graphConnected = 'connected';
              log?.info?.('distillation: graphAdapter reconnected successfully');
            } else {
              result.graphConnected = 'disconnected';
              result.error = 'graphAdapter.connect() returned true but driver is still null. ' +
                'This indicates graph-memory-pro module loaded but Neo4j driver creation failed. ' +
                'Check Neo4j is running and config is correct in openclaw.json.';
              log?.warn?.('distillation: connect() returned true but isConnected is false');
              return result;
            }
          } else {
            result.error = 'Neo4j not connected — graphAdapter.connect() returned false. ' +
              'Check Neo4j is running and config (neo4j.url / neo4j.auth) is correct in openclaw.json. ' +
              'Note: lcmg_maintain/diagnose use a separate driver (getNeo4jDriver) and may connect ' +
              'even when graphAdapter failed during plugin init.';
            log?.warn?.('distillation: graphAdapter reconnect failed');
            return result;
          }
        } else {
          result.error = 'Neo4j not connected and graphAdapter has no connect() method. ' +
            'Plugin initialization may have failed — check logs for "Neo4j unavailable" warnings.';
          log?.warn?.('distillation: graphAdapter has no connect() method');
          return result;
        }
      } catch (reconnectErr) {
        result.error = 'Neo4j reconnect failed: ' + (reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr));
        log?.warn?.('distillation: graphAdapter reconnect threw', { err: result.error });
        return result;
      }
    }
  } else {
    result.graphConnected = 'unknown';
    log?.warn?.('distillation: cannot determine Neo4j connection status (isConnected not available)');
  }

  try {
    // limit 控制单批拉取数量，默认 5（与历史行为一致），dashboard lcmg_distill 可传入更大值
    const fetchLimit = limit && limit > 0 ? limit : 5;

    // 诊断：fetchPending 前先统计 Neo4j 中的节点状态分布
    let diagTotal = -1;
    let diagByStatus: Record<string, number> = {};
    try {
      if (typeof expStoreRef.countAll === 'function') {
        diagTotal = await expStoreRef.countAll();
      }
      if (typeof expStoreRef.countByStatus === 'function') {
        diagByStatus = await expStoreRef.countByStatus();
      }
      log?.info?.('distillation: Neo4j EXPERIENCE node status', { total: diagTotal, byStatus: diagByStatus });
    } catch (diagErr) {
      log?.warn?.('distillation: diagnostic count query failed', { err: String(diagErr) });
    }

    const pending = await expStoreRef.fetchPending(fetchLimit);
    result.pending = pending.length;
    if (!pending.length) {
      log?.info?.('distillation: no pending experiences to process', {
        llmModel: result.llmModel,
        graphConnected: result.graphConnected,
        neo4jTotal: diagTotal,
        neo4jByStatus: diagByStatus,
      });
      // 诊断信息附加到 result 供工具 handler 展示
      (result as any).neo4jTotal = diagTotal;
      (result as any).neo4jByStatus = diagByStatus;
      return result;
    }
    log?.info?.('distillation: processing ' + String(pending.length) + ' pending', { llmModel: result.llmModel });
    // 重新解析 LLM 配置用于实际调用（前面已解析过一次用于结果展示，此处复用）
    const llm = resolveDistillationLlm(apiRef);
    // BUGFIX(P2-2/3): 原为串行 for-await，每条 distillOne 是一次 LLM 调用（含 15s 超时），
    // 5 条串行最坏 75s。改为分批并发处理，每批 concurrency 条用 Promise.allSettled 并发执行。
    // 每条蒸馏按 raw.id 隔离、无跨条数据依赖，并发安全；单条失败不影响其他条。
    // 默认并发上限 3，可通过环境变量 LCMG_DISTILL_CONCURRENCY 覆盖（上限 10，防止瞬时压力过大）。
    const concurrency = (() => {
      const raw = process.env.LCMG_DISTILL_CONCURRENCY;
      if (raw) { const n = Number(raw); if (Number.isFinite(n) && n > 0) return Math.min(n, 10); }
      return 3;
    })();
    // 收集 distillOne 的错误详情，取第一条供结果展示（避免用户只看到 "see logs"）
    const distillErrors: string[] = [];
    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = pending.slice(i, i + concurrency);
      await Promise.allSettled(batch.map((raw: any) => (async () => {
        // 记录 errorSink 长度，用于提取本条经验的失败原因
        const errIdxBefore = distillErrors.length;
        try {
          const distilled = await distillOne(raw, llm, log, distillErrors);
          if (distilled) {
            await expStoreRef.saveDistilled(distilled);
            await expStoreRef.deleteById(raw.id);
            result.succeeded++;
            // 统计重试成功的经验数量
            if ((raw.retryCount ?? 0) > 0) {
              result.retriedFailed = (result.retriedFailed ?? 0) + 1;
            }
            // v1.2.0-3: 记录蒸馏成功
            businessMetrics.recordDistill(true);
            // v1.2.0-3: 记录经验质量分（基于 relevanceScore）
            businessMetrics.recordExperienceQuality(distilled.relevanceScore);

            // S-11': Zettelkasten evolve — 建立 RELATED_TO 关联
            // 优先调用 gm-pro linkNodes API 创建语义链接，失败降级到 Cypher MERGE。
            // 用 LLM 提取的 relatedConcepts 搜索已有经验并建立关联，
            // 让经验网络自组织生长（类似卡片盒笔记法）。
            const concepts: string[] | undefined = distilled.relatedConcepts;
            if (concepts?.length && typeof expStoreRef.linkRelated === 'function') {
              try {
                // 优先尝试 gm-pro linkNodes API（与 S-11 对接）
                let gmProLinked = 0;
                try {
                  const { withGmProFallback } = await import("../adapters/gm-pro-fallback.js");
                  // 先用 Cypher 查找概念重叠的节点（linkRelated 的搜索逻辑），再用 linkNodes 建边
                  const relatedNodes = await expStoreRef.findRelatedByConcepts?.(distilled.id, concepts, 3);
                  if (Array.isArray(relatedNodes) && relatedNodes.length > 0) {
                    for (const targetId of relatedNodes) {
                      const linkResult = await withGmProFallback<{ created: boolean } | null>(
                        'linkNodes',
                        async (mod) => {
                          const r = await mod.linkNodes(distilled.id, targetId, 'RELATED_TO');
                          return r as { created: boolean } | null;
                        },
                        async () => null, // fallback 到后续 Cypher linkRelated
                        { label: 'S-11 linkNodes' },
                      );
                      if (linkResult?.created) gmProLinked++;
                    }
                  }
                } catch (gmProErr) {
                  log?.debug?.("distillation: gm-pro linkNodes skipped", { err: String(gmProErr) });
                }

                // Fallback: 如果 gm-pro 未处理任何关联，用 Cypher MERGE 兜底
                if (gmProLinked === 0) {
                  const linked = await expStoreRef.linkRelated(distilled.id, concepts, 3);
                  if (linked > 0) {
                    result.linked += linked;
                    log?.debug?.("distillation: zettelkasten evolve linked (cypher fallback)", { id: distilled.id, linked, concepts: concepts.slice(0, 3) });
                  }
                } else {
                  result.linked += gmProLinked;
                  log?.debug?.("distillation: zettelkasten evolve linked (gm-pro)", { id: distilled.id, linked: gmProLinked, concepts: concepts.slice(0, 3) });
                }
              } catch (linkErr) {
                log?.debug?.("distillation: zettelkasten evolve skipped", { err: String(linkErr) });
              }
            }
          } else {
            // v1.2.0-3: distillOne 返回 null（LLM 解析失败或超时）→ 标记 FAILED + retryCount+1
            result.failed++;
            businessMetrics.recordDistill(false);
            // 提取本条经验的失败原因（errorSink 中新增的最后一条）
            const itemError = distillErrors.length > errIdxBefore
              ? distillErrors[distillErrors.length - 1]
              : 'LLM returned null (unknown reason)';
            if (typeof expStoreRef.markFailed === 'function') {
              await expStoreRef.markFailed(raw.id, itemError);
              log?.debug?.('distillation: marked FAILED', { rawId: raw.id, retryCount: (raw.retryCount ?? 0) + 1, error: itemError.slice(0, 100) });
            }
          }
        } catch (e) {
          result.failed++;
          log?.warn?.("distillation item failed", { err: String(e) });
          // v1.2.0-3: 记录蒸馏失败
          businessMetrics.recordDistill(false);
          // 异常也标记 FAILED，让失败经验可被重试
          const itemError = distillErrors.length > errIdxBefore
            ? distillErrors[distillErrors.length - 1]
            : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
          if (typeof expStoreRef.markFailed === 'function') {
            await expStoreRef.markFailed(raw.id, itemError);
          }
        }
      })()));
    }
    log?.info?.('distillation: completed', {
      pending: result.pending, succeeded: result.succeeded, failed: result.failed,
      linked: result.linked, retriedFailed: result.retriedFailed ?? 0, model: result.llmModel,
    });
    // 将第一条蒸馏错误附到结果上，让用户在报告中看到具体原因
    if (distillErrors.length > 0) {
      result.firstDistillError = distillErrors[0];
    }
    // 统计已耗尽重试次数的 FAILED 节点数量（需手动重置才能再次蒸馏）
    try {
      if (typeof expStoreRef.countFailedExhausted === 'function') {
        result.maxRetries = Number(process.env.LCMG_DISTILL_MAX_RETRIES) > 0
          ? Math.min(Number(process.env.LCMG_DISTILL_MAX_RETRIES), 10)
          : 3;
        result.skippedFailed = await expStoreRef.countFailedExhausted(result.maxRetries);
      }
    } catch {
      // 非致命，忽略
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.warn?.("distillation batch failed", { err: msg });
    result.error = msg;
  }
  return result;
}
