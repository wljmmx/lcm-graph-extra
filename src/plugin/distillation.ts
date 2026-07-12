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
import { cleanBaseURL, withKeepAliveIfOllama } from '../utils/url.js';
// v1.2.0-3: 业务指标 —— 跟踪蒸馏成功率
import { businessMetrics } from '../health-metrics.js';
import { llmTimeout } from '../config/defaults.js';

export function isOllamaModel(model: string): boolean {
  // 判断主会话模型是否为 Ollama 本地模型。
  // 识别依据：
  //   1. 显式 provider 前缀：`ollama/...`、`ollama-256k/...`
  //   2. Ollama 默认 tag 后缀：`:latest`
  // 注意：原逻辑 `!model.includes('/')` 会把 `gpt-4o-mini`、`claude-3-5-sonnet`
  // 等不含 `/` 的远程模型名误判为 Ollama，导致错误地走 Ollama baseURL。
  // 已去除该过宽分支。
  return model.startsWith('ollama/') || model.startsWith('ollama-256k/') || model.endsWith(':latest');
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
  // Session model is local Ollama → reuse it to avoid GPU model swapping
  if (runtimeLlm?.model && isOllamaModel(runtimeLlm.model)) {
    return {
      model: runtimeLlm.model,
      apiKey: runtimeLlm.apiKey || '',
      baseURL: cleanBaseURL(runtimeLlm.baseURL || 'http://127.0.0.1:18789/v1'),
      keepAlive: defaultKeepAlive,
    };
  }
  const dLlm = pluginConfig?.distillationLlm;
  if (dLlm?.provider === 'openclaw_hooks') return {
    model: dLlm.model || 'ollama/qwen3.6:27b',
    apiKey: '',
    baseURL: cleanBaseURL(dLlm.baseURL || 'http://127.0.0.1:18789/v1'),
    keepAlive: dLlm.keepAlive || defaultKeepAlive,
  };
  if (dLlm?.provider && dLlm?.model) {
    return {
      model: dLlm.model,
      apiKey: dLlm.apiKey || '',
      baseURL: cleanBaseURL(dLlm.baseURL || 'http://127.0.0.1:18789/v1'),
      keepAlive: dLlm.keepAlive || defaultKeepAlive,
    };
  }
  return {
    model: process.env.LLM_MODEL || dLlm?.model || 'gpt-4o-mini',
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    baseURL: cleanBaseURL(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    keepAlive: defaultKeepAlive,
  };
}

export async function distillOne(
  raw: { id: string; source: string; context: string; detail: string },
  llm: { model: string; apiKey: string; baseURL: string; keepAlive?: string },
  log?: { warn?: (msg: string, meta?: any) => void; debug?: (msg: string, meta?: any) => void; info?: (msg: string, meta?: any) => void },
): Promise<any | null> {
  // P1-4: prompt 增加 tags 字段，让 LLM 同时产出多维度标签（scenario/techStack/severity/freeTags）。
  // S-11': Zettelkasten 增强 — 增加 relatedConcepts 字段，提取 2-5 个相关概念/关键词，
  // 用于后续在经验网络中建立 RELATED_TO 边，形成知识图谱连接。
  const prompt = 'Summarize the following experience into a concise lesson.' + '\nSource: ' + raw.source + '\nContext: ' + raw.context + '\nDetail: ' + raw.detail
    + '\nReturn a JSON with: title, summary, type (lesson|failure|correction|fix|best_practice), relevanceScore (0-1),'
    + ' scenario (array, subset of: bug-fix|feature-dev|code-review|config-debug|deployment|performance-opt|security-audit|refactor),'
    + ' techStack (array, subset of: frontend|backend|devops|database|mobile|ai-ml|infrastructure|general),'
    + ' severity (one of: critical|major|minor), freeTags (array of short strings),'
    + ' relatedConcepts (array of 2-5 short keywords/phrases representing closely related topics or concepts for cross-linking).'
    + ' Return ONLY JSON.';
  const controller = new AbortController();
  // v2.2.3: 原 15s 硬编码 → 可配置（默认 120s，蒸馏输入较长，本地大模型需更宽容）
  const timer = setTimeout(() => controller.abort(), llmTimeout('distillMs'));
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (llm.apiKey) headers['Authorization'] = 'Bearer ' + llm.apiKey;
    // 仅 Ollama 端点注入 keep_alive，避免模型 5 分钟后卸载导致冷启动延迟
    const body = withKeepAliveIfOllama(
      llm.baseURL,
      { model: llm.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 512 },
      llm.keepAlive,
    );
    const resp = await fetch(llm.baseURL + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '<unreadable>');
      log?.warn?.('distillOne: LLM HTTP error', { status: resp.status, model: llm.model, baseURL: llm.baseURL, rawId: raw.id, errBody: errBody.slice(0, 300) });
      return null;
    }
    const data: any = await resp.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      log?.warn?.('distillOne: LLM returned empty content', { rawId: raw.id, model: llm.model });
      return null;
    }
    // 本地模型常把 JSON 包在 ```json ... ``` 代码块中，直接 JSON.parse 会失败。
    // 提取代码块内的 JSON 内容，或去除前后非 JSON 文本。
    const jsonText = extractJsonFromText(text);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      log?.warn?.('distillOne: LLM returned non-JSON content', { rawId: raw.id, parseErr: String(parseErr), textPreview: text.slice(0, 300) });
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
      log?.warn?.('distillOne: LLM call timeout', { rawId: raw.id, timeoutMs: llmTimeout('distillMs') });
    } else {
      log?.warn?.('distillOne: unexpected error', { rawId: raw.id, err: err instanceof Error ? err.message : String(err) });
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
    const pending = await expStoreRef.fetchPending(fetchLimit);
    result.pending = pending.length;
    if (!pending.length) {
      log?.info?.('distillation: no pending experiences to process', { llmModel: result.llmModel, graphConnected: result.graphConnected });
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
    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = pending.slice(i, i + concurrency);
      await Promise.allSettled(batch.map((raw: any) => (async () => {
        try {
          const distilled = await distillOne(raw, llm, log);
          if (distilled) {
            await expStoreRef.saveDistilled(distilled);
            await expStoreRef.deleteById(raw.id);
            result.succeeded++;
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
            // v1.2.0-3: distillOne 返回 null（LLM 解析失败或超时）→ 记录蒸馏失败
            result.failed++;
            businessMetrics.recordDistill(false);
          }
        } catch (e) {
          result.failed++;
          log?.warn?.("distillation item failed", { err: String(e) });
          // v1.2.0-3: 记录蒸馏失败
          businessMetrics.recordDistill(false);
        }
      })()));
    }
    log?.info?.('distillation: completed', { pending: result.pending, succeeded: result.succeeded, failed: result.failed, linked: result.linked, model: result.llmModel });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.warn?.("distillation batch failed", { err: msg });
    result.error = msg;
  }
  return result;
}
