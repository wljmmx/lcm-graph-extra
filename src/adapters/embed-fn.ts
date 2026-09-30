/**
 * 本地 Embedding 函数工厂 —— 确保 keep_alive 参数被正确传递，并支持批量嵌入。
 *
 * 问题背景：graph-memory-pro 的 createEmbedFn 是外部模块，无法保证它读取
 * EmbeddingConfig.keepAlive 并写入 HTTP 请求 body 的 keep_alive 字段。
 * Ollama 默认 keep_alive=5m，模型在 5 分钟无请求后自动卸载，下次请求需重新加载，
 * 导致首次召回延迟显著（GGUF 模型加载可能数秒到数十秒）。
 *
 * 本模块实现自带的 embed 函数，明确在请求 body 中包含 keep_alive 字段，
 * 绕过 graph-memory-pro 的不确定性。支持三种端点格式：
 *
 *   - OpenAI 兼容 (/v1、OVMS /v3): POST {base}/embeddings
 *       body { model, input, ...options }（OpenAI 标准，字段始终用 input；
 *       扩展 options 平铺到顶层。keep_alive 为 Ollama 专有字段，此路径不发送，
 *       避免 OVMS 等严格校验服务端拒绝未知字段）
 *   - Ollama 新版原生: POST /api/embed       → body { model, input, keep_alive, options: {...} }
 *       （Ollama 0.3+，字段为 input；运行时参数 num_ctx/seed 等嵌套在 options 内）
 *   - Ollama 旧版原生: POST /api/embeddings   → body { model, prompt, keep_alive, options: {...} }
 *       （Ollama 0.1.x，字段为 prompt，端点带 s；options 同样嵌套）
 *
 * 非新版端点首次 404 时自动回退到旧版并缓存，避免每次探测。
 * Ollama 原生端点的 options 嵌套：Ollama 会忽略顶层不认识的字段，运行时参数
 * （num_ctx、seed、temperature、top_k 等）必须放在 options 子对象内才会生效。
 *
 * OVMS（OpenVINO Model Server）内网服务说明：
 *   OVMS 的 OpenAI 兼容接口在 /v3 前缀下（/v3/embeddings、/v3/chat/completions），
 *   必须以版本段结尾的 baseURL（如 http://192.168.1.10:8000/v3）配置。
 *   本模块通过 isOpenAiCompatibleEndpoint 识别版本段，走 OpenAI 兼容路径，
 *   不会把 /v3 改写成 Ollama 原生 /v3/api/embed。
 *
 * 批量嵌入（BatchEmbedFn）：
 *   一次 HTTP 请求携带多个文本（OpenAI 兼容端点与 Ollama /api/embed 均支持
 *   input 数组），显著减少请求数，缓解本地 Ollama 队列压力与 OVMS 单请求开销。
 *   语义对齐上游 graph-memory-pro createBatchEmbedFn：先查缓存，未命中的按
 *   batchSize 切分子批发送；子批失败降级为逐条请求，单条失败返回 null（不阻塞整批）。
 */

import type { EmbeddingConfig } from '../types.js';
import { cleanBaseURL, isOllamaEndpoint, isOpenAiCompatibleEndpoint } from '../utils/url.js';
import { withOllamaSlot } from '../async/ollama-slot.js';
import { getGlobalLogger } from '../utils/logger.js';
// P2-9: 接入集中化 LLM 超时常量
import { llmTimeout } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// LRU 缓存：相同 query 文本的 embedding 结果缓存，避免重复请求 Ollama
// （assemble 中相似/重复 query 可命中缓存，vec_embed 2.5s → ~0ms）
// 对齐 graph-memory-pro v2.8.x `src/engine/embed.ts`：
//   - 缓存键用 FNV-1a 64-bit hash（而非原始文本）——长文本/高频写入下避免
//     原始文本占额外内存；hash 键固定 16 位十六进制，256 条目碰撞概率 ≈ 4e-15
//   - 容量/TTL 可配（embedding.cacheSize / embedding.cacheTtlMs，默认 256 / 10min）
//   - 按 `${baseURL}|${model}` **模块级共享**：单文本 embed 与批量 batchEmbed
//     复用同一缓存；不同端点隔离
//   - cacheSize <= 0 或 cacheTtlMs <= 0 → 关闭缓存（返回 null）
// ---------------------------------------------------------------------------
const DEFAULT_EMBED_CACHE_SIZE = 256;
const DEFAULT_EMBED_CACHE_TTL_MS = 10 * 60 * 1000; // 10min（短于 QueryCache 30min，保证嵌入新鲜度）

/** FNV-1a 64-bit（JS 用 BigInt 实现）——缓存键，对齐 gm-pro */
function embedCacheKey(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

interface EmbedCacheEntry {
  vec: number[];
  ts: number;
}

interface EmbedLruCache {
  get(key: string): number[] | null;
  set(key: string, vec: number[]): void;
}

/** 简易 LRU（基于 Map 插入顺序），语义与 gm-pro createLruCache 逐项一致 */
function createLruCache(capacity: number, ttlMs: number): EmbedLruCache {
  const map = new Map<string, EmbedCacheEntry>();
  return {
    get(key: string): number[] | null {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() - entry.ts > ttlMs) {
        map.delete(key);
        return null;
      }
      // 命中：移到末尾（Map 末尾为最近使用）
      map.delete(key);
      map.set(key, entry);
      return entry.vec;
    },
    set(key: string, vec: number[]): void {
      if (map.size >= capacity) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) map.delete(oldestKey);
      }
      map.set(key, { vec, ts: Date.now() });
    },
  };
}

/** 模块级共享缓存句柄：键 `baseURL|model`，单文本/批量复用（gm-pro getSharedEmbedCache 语义） */
const _embedCacheHandles = new Map<string, EmbedLruCache>();

function getSharedEmbedCache(key: string, cacheSize: number, cacheTtlMs: number): EmbedLruCache | null {
  if (cacheSize <= 0 || cacheTtlMs <= 0) return null;
  let handle = _embedCacheHandles.get(key);
  if (!handle) {
    handle = createLruCache(cacheSize, cacheTtlMs);
    _embedCacheHandles.set(key, handle);
  }
  return handle;
}

/**
 * 清空模块级 embed 状态（LRU 缓存 + 共享信号量 + pacing 游标）。
 * 用途：测试隔离（避免跨用例共享缓存导致断言失真）+ 运行期配置变更后重置。
 */
export function clearEmbedConcurrencyState(): void {
  _embedCacheHandles.clear();
  _semaphores.clear();
  _pacingGates.clear();
}

// ---------------------------------------------------------------------------
// 并发闸门 + 发送节流
// 对齐 graph-memory-pro v2.8.x `src/engine/embed.ts` 的实现（信号量 + pacing 游标）：
//   - 信号量：管"同时在飞 ≤ maxConcurrency"（默认 2）
//   - pacing 游标：管"相邻两次发送间隔 ≥ requestIntervalMs"（默认 0 = 关闭）
// 两者叠加，才是完整的下游保护；单靠并发上限挡不住**零间隔连续请求流**。
//
// 为什么要 pacing（gm-pro 的现场证据，直接适用本插件）：
//   信号量只限制同时在飞的数量，释放许可后下一个请求**立即补位**（正常路径零间隔）。
//   实测 OVMS 在背靠背连续请求流下会间歇返回
//   `404 Mediapipe graph definition with requested name is not found`，而
//   并发仅 2 却失败、用户手动 8~16 并发全部 200、增加间隔后不再报错
//   ⇒ 触发点是**持续速率/无间隔**，不是并发上限。
//
// 与 withOllamaSlot 的分工（两者都要保留，不可互相替代）：
//   - 本信号量：**端点无关**（含公网 OVMS —— withOllamaSlot 对非私网端点直接放行），
//     按 `${baseURL}|${model}` 限并发，闭掉"判定外的端点完全无限制"这个开口。
//   - withOllamaSlot：只覆盖本机/私网 Ollama，额外提供**跨模型串行**（防模型互踢换载），
//     且与插件的 LLM 调用共用同一队列。
//   叠加顺序：信号量（外）→ pacing → withOllamaSlot（内）→ fetch。
//   不会死锁：内层槽位必然最终释放（LLM 请求即使正占用，也会结束）。
// ---------------------------------------------------------------------------

/** 每端点 embed 并发上限（默认 2）。与对话共存的安全值，可用 embedding.maxConcurrency 调整 */
const DEFAULT_EMBED_MAX_CONCURRENCY = 2;

/** 重试退避（对齐 gm-pro v2.8.x RETRY_DELAYS） */
const RETRY_DELAYS_MS = [1000, 3000, 5000];
/** 重试退避的 jitter 上限——防止并发失败时重试波峰对齐，加剧下游过载 */
const RETRY_JITTER_MAX_MS = 500;
/** 可重试状态码（服务端过载/瞬时故障） */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
/** 批量路径超时（对齐 gm-pro：批量输入多，弱 CPU 下用单文本超时易误超时 → 触发重试风暴） */
const BATCH_TIMEOUT_MS = 120_000;
/** 子批次失败后逐条重发的连续失败短路阈值（判定为系统性故障，立即停止，防请求风暴） */
const FALLBACK_CONSECUTIVE_FAIL_LIMIT = 2;

interface Semaphore {
  acquire(): Promise<() => void>;
}

function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<() => void> {
      if (active >= max) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        const next = waiters.shift();
        if (next) next();
      };
    },
  };
}

/** 模块级共享信号量：同 `baseURL|model` 的所有调用方（单文本/批量/graph 实体）共用同一限制器 */
const _semaphores = new Map<string, Semaphore>();

function getSemaphore(baseURL: string, model: string, maxConcurrency: number): Semaphore {
  const key = `${baseURL}|${model}`;
  let sem = _semaphores.get(key);
  if (!sem) {
    sem = createSemaphore(maxConcurrency);
    _semaphores.set(key, sem);
  }
  return sem;
}

/** 每端点"下一次允许发送"的时间游标（pacing） */
const _pacingGates = new Map<string, { nextAt: number }>();

/**
 * 等待到该端点允许发送的时刻。
 *
 * 竞态说明：游标在 await 之前同步推进（JS 单线程，await 前不会被打断）→ 天然无竞态，
 * 多个并发调用会各拿到互不重叠的时间片。
 */
async function waitForPacing(key: string, intervalMs: number): Promise<void> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  let gate = _pacingGates.get(key);
  if (!gate) {
    gate = { nextAt: 0 };
    _pacingGates.set(key, gate);
  }
  const now = Date.now();
  const at = Math.max(now, gate.nextAt);
  // 同步推进游标（await 之前，不会被其它调用插入）
  gate.nextAt = at + intervalMs;
  const wait = at - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// ---------------------------------------------------------------------------
// 端点解析：单文本与批量共用，保证两条链路判定一致
// ---------------------------------------------------------------------------

interface ResolvedEmbedTarget {
  /** 原始 baseURL（用于 withOllamaSlot 判定） */
  baseURL: string;
  /** 清洗后的 baseURL（拼接 OpenAI 兼容路径） */
  baseClean: string;
  /** Ollama 原生端点基址（剥离 /vN 后缀，避免 /v1/api/embed 非法路径） */
  baseForOllama: string;
  model: string;
  isOllama: boolean;
  isOpenAiCompatible: boolean;
  headers: Record<string, string>;
  keepAliveNorm: string | number;
  options?: Record<string, number | boolean | string>;
  /** 相邻两次发送的最小间隔（ms，0 = 关闭节流） */
  requestIntervalMs: number;
  /** 期望向量维度（有则校验每个返回值，不匹配即抛错；无则跳过） */
  expectedDim?: number;
}

/** 端点判定闭包状态：Ollama 旧版回退标记（闭包持久化，避免每次探测） */
interface EmbedRuntimeState {
  /** false = 新版 /api/embed + input；true = 旧版 /api/embeddings + prompt */
  useLegacyOllama: boolean;
}

/** 解析端点形态：OpenAI 兼容 / Ollama 原生（新版 or 旧版回退） */
function resolveEmbedTarget(ecfg: EmbeddingConfig): ResolvedEmbedTarget {
  const {
    model = 'Qwen3.5-Embedding-0.6B-GGUF',
    // P2-B2: 默认改为 Ollama 原生端点（不带 /v1），走 /api/embed 而非 /v1/embeddings。
    // 原因：Ollama 的 OpenAI 兼容层 (/v1/*) 是实验性支持，keep_alive 参数可能被忽略，
    // 导致模型反复卸载加载（5m 默认 keep_alive）。原生 /api/embed 端点完整支持 keep_alive。
    baseURL = 'http://127.0.0.1:11434',
    apiKey,
    keepAlive = '-1',
    options,
  } = ecfg;

  const baseClean = cleanBaseURL(baseURL);
  const isOllama = isOllamaEndpoint(baseClean);
  // OpenAI 兼容端点：/v1（OpenAI/vLLM/LM Studio）与 /v3（OVMS 内网服务）。
  // 注意：Ollama 端点即使带 /v1 也优先走原生 /api/embed（keep_alive 生效）。
  const isOpenAiCompatible = isOpenAiCompatibleEndpoint(baseClean);
  // Ollama 端点剥离版本段后缀（避免 /v1/api/embed 非法路径）
  const baseForOllama = isOllama ? baseClean.replace(/\/v\d+\/?$/, '') : baseClean;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  // Ollama 的 keep_alive 字段：数字 -1 表示永不过期，duration 字符串如 "1h" 也可接受。
  // 但字符串 "-1" 会被 Ollama 解析为 duration 失败 → 回退到默认 5m。
  // 因此需要将 "-1" 字符串转换为数字 -1。
  const keepAliveNorm: string | number = keepAlive === '-1' ? -1 : keepAlive;
  const dim = ecfg.dimensions;
  const expectedDim = typeof dim === 'number' && Number.isFinite(dim) && dim > 0 ? Math.floor(dim) : undefined;

  return {
    baseURL, baseClean, baseForOllama, model, isOllama, isOpenAiCompatible, headers, keepAliveNorm, options,
    requestIntervalMs: resolveRequestIntervalMs(ecfg.requestIntervalMs),
    expectedDim,
  };
}

/**
 * 解析 embedding 响应为与输入等长的 (number[] | null)[]。
 * - OpenAI 兼容：{ data: [{ embedding, index }] }，按 index 对齐（OVMS 明确返回 index）
 * - Ollama 新版：{ embeddings: number[][] }，按位置对齐
 * 缺失的位置保持 null（批量路径不阻塞整批）。
 *
 * 对齐 gm-pro v2.8.x 的后处理：
 *   - `expectedDim` 存在时逐条校验维度，不匹配即抛错（防维度漂移静默污染图）
 *   - 过滤含 NaN/Infinity 的向量（v2.5.2：防下游污染关联矩阵）
 */
function parseEmbedResponse(
  data: any,
  count: number,
  isOpenAiCompatible: boolean,
  expectedDim?: number,
): (number[] | null)[] {
  const raw: (number[] | null)[] = new Array(count).fill(null);
  if (isOpenAiCompatible) {
    const arr = Array.isArray(data?.data) ? data.data : null;
    if (arr) {
      for (const item of arr) {
        const emb = item?.embedding;
        if (!Array.isArray(emb)) continue;
        const rawIdx = item?.index;
        const idx = typeof rawIdx === 'number' && rawIdx >= 0 && rawIdx < count ? rawIdx : raw.indexOf(null);
        if (idx >= 0) raw[idx] = emb;
      }
    } else if (Array.isArray(data?.embedding) && count >= 1) {
      // 兼容部分 OpenAI 兼容端点返回的扁平格式: { embedding: number[] }
      raw[0] = data.embedding;
    }
  } else {
    // Ollama 原生
    if (Array.isArray(data?.embeddings)) {
      for (let i = 0; i < Math.min(count, data.embeddings.length); i++) {
        if (Array.isArray(data.embeddings[i])) raw[i] = data.embeddings[i];
      }
    }
    // 兼容旧版/部分版本: { embedding: number[] }
    if (Array.isArray(data?.embedding) && count >= 1) raw[0] = data.embedding;
    // 兼容部分 Ollama 版本返回嵌套格式: { data: [{ embedding: number[] }] }
    if (Array.isArray(data?.data?.[0]?.embedding) && count >= 1) raw[0] = data.data[0].embedding;
  }

  // 后处理：维度校验 + NaN/Infinity 过滤
  const out: (number[] | null)[] = new Array(count).fill(null);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (!v) continue;
    if (expectedDim != null && v.length !== expectedDim) {
      throw new Error(
        `Embedding dimension mismatch: expected ${expectedDim}, got ${v.length}. ` +
        `Check embedding.model or embedding.dimensions in config.`,
      );
    }
    // 过滤含 NaN/Infinity 的向量（保持 null → 调用方降级），而非污染下游
    let hasBad = false;
    for (let j = 0; j < v.length; j++) {
      if (!Number.isFinite(v[j])) { hasBad = true; break; }
    }
    if (hasBad) {
      getGlobalLogger()?.warn?.('[embed] vector contains NaN/Infinity, dropped', { inputIndex: i });
      continue;
    }
    out[i] = v;
  }
  return out;
}

/**
 * 发送一次 embedding 请求（支持单文本与多文本数组）。
 *
 * - OpenAI 兼容（/v1、OVMS /v3）：{base}/embeddings + input 数组，不发送 keep_alive
 * - Ollama 新版：/api/embed + input 数组 + keep_alive
 * - Ollama 旧版回退：/api/embeddings + prompt（仅单文本）
 *
 * 发送前先过 pacing 游标（`waitForPacing`）——放在**最底层发送点**而不是调用方，
 * 这样重试、旧版端点回退等所有出网路径都无法绕过节流（gm-pro 是在调用侧等，
 * 这里是更严的不变式：任何一次 fetch 之前都已被节流）。
 *
 * 重试（对齐 gm-pro v2.8.x）：429/5xx 退避重试，退避带 jitter 防止并发重试波峰对齐；
 * OpenAI 兼容端点的 404 属**瞬时资源问题**（OVMS Mediapipe graph 未就绪），只额外重试 1 次。
 * 404 回退：旧版 Ollama 端点不存在且为单文本时，切旧版重试（端点形态切换，不消耗重试预算）。
 */
async function requestEmbed(
  target: ResolvedEmbedTarget,
  inputs: string[],
  state: EmbedRuntimeState,
  timeoutMs: number = llmTimeout('embedTimeoutMs'),
): Promise<{ vecs: (number[] | null)[]; raw: any }> {
  const pacingKey = `${target.baseURL}|${target.model}`;
  let lastError: Error | null = null;

  // 最多 1 次首发 + RETRY_DELAYS_MS.length 次重试
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let ep: string;
    let body: Record<string, unknown>;
    if (target.isOpenAiCompatible) {
      ep = target.baseClean + '/embeddings';
      body = { model: target.model, input: inputs };
    } else if (state.useLegacyOllama) {
      // 旧版 Ollama: /api/embeddings + prompt
      ep = target.baseForOllama + '/api/embeddings';
      body = { model: target.model, prompt: inputs[0], keep_alive: target.keepAliveNorm };
    } else {
      // 新版 Ollama: /api/embed + input (数组格式)
      ep = target.baseForOllama + '/api/embed';
      body = { model: target.model, input: inputs, keep_alive: target.keepAliveNorm };
    }
    // 透传额外 options：
    // - OpenAI 兼容端点：平铺到 body 顶层（dimensions/encoding_format 等标准字段本就在顶层）
    // - Ollama 原生端点：嵌套为 body.options（num_ctx/seed/temperature 等运行时参数必须嵌套）
    if (target.options) {
      if (target.isOpenAiCompatible) {
        for (const [k, v] of Object.entries(target.options)) {
          if (!(k in body)) body[k] = v;
        }
      } else {
        body.options = { ...(body.options as Record<string, unknown> | undefined), ...target.options };
      }
    }

    // 发送节流：相邻两次出网至少间隔 requestIntervalMs（默认 0 = 关闭，保持原行为）
    await waitForPacing(pacingKey, target.requestIntervalMs);

    // 本地 Ollama 全局并发闸门（与 LLM 请求共用，OLLAMA_MAX_CONCURRENCY 默认 2）：
    // embedding 与 LLM 摘要/主生成共用同一 Ollama 队列，不加闸会叠加打爆服务端。
    const resp = await withOllamaSlot(target.baseURL, target.model, () => fetch(ep, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));

    // 新版端点不存在（旧版 Ollama）→ 切换旧版并重试（仅单文本可回退）
    // 这是端点形态切换，不消耗重试预算（continue 不推进退避）。
    if (resp.status === 404 && !target.isOpenAiCompatible && !state.useLegacyOllama) {
      if (inputs.length === 1) {
        state.useLegacyOllama = true;
        attempt -= 1;
        continue;
      }
      throw new Error(`Embedding API 404: ${ep}`);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let hint = '';
      if (resp.status === 400 && errText.includes('invalid input type')) {
        hint = '. 提示：请检查 embedding.model 配置是否为支持 embedding 的模型（如 nomic-embed-text、bge-large-zh），聊天模型（如 qwen3.6）不支持 embedding';
      }
      const err = new Error(`Embedding API ${resp.status}: ${errText.slice(0, 200)}${hint}`);

      // 可重试判定：
      //   - 429/5xx：服务端过载或瞬时故障（gm-pro 的可重试集合）
      //   - OpenAI 兼容端点的 404：OVMS 的 Mediapipe graph 瞬时未就绪，只额外重试 1 次
      const isRetryableStatus = RETRYABLE_STATUS.has(resp.status);
      const isRetryable404 = resp.status === 404 && target.isOpenAiCompatible;
      const canRetry = (isRetryableStatus || isRetryable404) && attempt < RETRY_DELAYS_MS.length;
      if (!canRetry || (isRetryable404 && attempt >= 1)) throw err;

      lastError = err;
      // 退避 + jitter：防止并发失败时重试波峰对齐，反而加剧下游过载
      const jitter = Math.random() * RETRY_JITTER_MAX_MS;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] + jitter));
      continue;
    }

    const data: any = await resp.json();
    return { vecs: parseEmbedResponse(data, inputs.length, target.isOpenAiCompatible, target.expectedDim), raw: data };
  }
  throw lastError ?? new Error('Embedding API: exhausted retries');
}

// ---------------------------------------------------------------------------
// 工厂：单文本 + 批量（共享端点解析、缓存与旧版回退状态）
// ---------------------------------------------------------------------------

/** 批量嵌入函数签名（与上游 graph-memory-pro BatchEmbedFn 对齐） */
export type BatchEmbedFn = (texts: string[]) => Promise<(number[] | null)[]>;

/** v2.8.x 对齐上游：单请求最大文本数默认 32，可经 embedding.batchSize 调整 */
const DEFAULT_BATCH_SIZE = 32;

/** 归一化批次大小：非法/非正值回退默认，避免 0 导致切分死循环 */
function resolveBatchSize(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_BATCH_SIZE;
}

/**
 * 归一化并发上限：非法/非正值回退默认 2。
 *
 * 硬上限 32 与 withOllamaSlot 的 OLLAMA_MAX_CONCURRENCY 校验一致，防止误配成超大值
 * 把下游一次打爆（并发上限是保护，不是性能旋钮的唯一来源）。
 */
function resolveMaxConcurrency(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
    return Math.min(32, Math.floor(raw));
  }
  return DEFAULT_EMBED_MAX_CONCURRENCY;
}

/** 归一化发送间隔：非法/负值视为关闭（0），保持"默认零额外延迟"的原有行为 */
function resolveRequestIntervalMs(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** 归一化批量总长度预算：非法/非正值视为关闭（0）。 */
function resolveMaxBatchChars(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * 归一化缓存容量：undefined → 默认 256；显式 ≤0/非法 → 关闭（0，getSharedEmbedCache 返回 null）。
 * 对齐 gm-pro：`config.cacheSize ?? DEFAULT_EMBED_CACHE_SIZE`，但允许显式 0 关闭。
 */
function resolveCacheSize(raw: unknown): number {
  if (raw === undefined) return DEFAULT_EMBED_CACHE_SIZE;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * 归一化缓存 TTL（ms）：undefined → 默认 10min；显式 ≤0/非法 → 关闭（0）。
 */
function resolveCacheTtlMs(raw: unknown): number {
  if (raw === undefined) return DEFAULT_EMBED_CACHE_TTL_MS;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * 子批次切分：条数上限 + 可选总长度预算（对齐 gm-pro v2.8.x splitSubBatches）。
 *
 * 保证：
 *   - 每个子批次条数 ≤ batchSize，字符数 ≤ maxBatchChars（单条自身超预算时除外）
 *   - 单条自身超预算时独占一个子批次 → 严格前进，不会死循环/饿死
 *   - maxBatchChars <= 0 时退化为纯按条数切分，与旧实现逐字节等价
 *   - 不改变输入顺序（子批次内保序，配合并发限流不影响结果回填）
 */
function splitSubBatches(
  toEmbed: number[],
  textLen: (index: number) => number,
  batchSize: number,
  maxBatchChars: number,
): number[][] {
  const useCharBudget = maxBatchChars > 0;
  const out: number[][] = [];
  let cur: number[] = [];
  let curChars = 0;
  for (const i of toEmbed) {
    const len = textLen(i);
    const countFull = cur.length >= batchSize;
    // cur.length > 0 条件：单条超预算时不无限等待，让它独占一个子批次
    const charsFull = useCharBudget && cur.length > 0 && curChars + len > maxBatchChars;
    if ((countFull || charsFull) && cur.length > 0) {
      out.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(i);
    curChars += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export interface LocalEmbedFns {
  embed: (text: string) => Promise<number[]>;
  embedBatch: BatchEmbedFn;
}

/**
 * 创建单文本 + 批量 embedding 函数（共享端点解析 / LRU 缓存 / 旧版回退状态 / 并发闸门）
 *
 * 每次调用都会向 embedding 端点发送 HTTP 请求，body 中包含 keep_alive（仅 Ollama），
 * 确保 Ollama 保持模型驻留内存。
 *
 * 并发与节流（对齐 gm-pro v2.8.x）：
 *   - 单文本与批量**都**先取信号量（同 `baseURL|model` 共享，上限 embedding.maxConcurrency，默认 2）；
 *     重试在持锁期间复用同一槽位，不额外占用。
 *   - 批量子批次**并发发送**（`Promise.all`），并发度由信号量自然收敛——旧实现是串行
 *     for 循环，等于放弃了 maxConcurrency（gm-pro 已改为并发）。
 *   - 相邻发送间隔由 `embedding.requestIntervalMs` 控制（默认 0 = 关闭）。
 */
export function createLocalEmbedFns(ecfg: EmbeddingConfig): LocalEmbedFns {
  const target = resolveEmbedTarget(ecfg);
  const cacheKey = `${target.baseURL}|${target.model}`;
  // 可配缓存：容量/TTL 默认 256/10min；任一 ≤0 → 关闭（与 gm-pro getSharedEmbedCache 一致）
  const cacheSize = resolveCacheSize(ecfg.cacheSize);
  const cacheTtlMs = resolveCacheTtlMs(ecfg.cacheTtlMs);
  const cache = getSharedEmbedCache(cacheKey, cacheSize, cacheTtlMs);
  const state: EmbedRuntimeState = { useLegacyOllama: false };
  const batchSize = resolveBatchSize(ecfg.batchSize);
  const maxBatchChars = resolveMaxBatchChars(ecfg.maxBatchChars);
  const semaphore = getSemaphore(target.baseURL, target.model, resolveMaxConcurrency(ecfg.maxConcurrency));
  const semaphoreLabel = `${target.baseURL}|${target.model}`;

  async function embed(text: string): Promise<number[]> {
    if (text == null || text === '') {
      throw new Error('Embedding API: input text cannot be null, undefined, or empty');
    }
    // 缓存命中：相同 query 文本的 embedding 是确定性的
    const cacheKeyText = embedCacheKey(text);
    const cached = cache?.get(cacheKeyText);
    if (cached) return cached;

    // 缓存未命中才占并发槽位（命中不消耗下游配额）
    const release = await semaphore.acquire();
    try {
      const { vecs, raw } = await requestEmbed(target, [text], state);
      const result = vecs[0];
      if (result) {
        cache?.set(cacheKeyText, result);
        return result;
      }
      throw new Error(`Embedding API: missing embedding in response (keys: ${Object.keys(raw || {}).join(',')})`);
    } finally {
      release();
    }
  }

  async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    if (!texts.length) return out;

    // 先查缓存，剩下未命中的才发请求（与单文本共享同一缓存）
    const pending: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (t == null || t === '') continue;
      const cached = cache?.get(embedCacheKey(t));
      if (cached) { out[i] = cached; continue; }
      pending.push(i);
    }
    if (!pending.length) return out;

    // 装箱：条数上限 + 可选总长度预算（长度感知，避免单请求工作量方差过大被超时击穿）
    const subBatches = splitSubBatches(pending, (i) => texts[i]?.length ?? 0, batchSize, maxBatchChars);

    // 子批次并发发送：并发度由信号量收敛到 ≤ maxConcurrency，发送间隔由 pacing 保证。
    // 这样既提高吞吐（旧实现串行浪费了并发额度），又不会形成零间隔请求流。
    await Promise.all(subBatches.map(async (idxs) => {
      const inputs = idxs.map((i) => texts[i]);
      const release = await semaphore.acquire();
      try {
        const { vecs } = await requestEmbed(target, inputs, state, BATCH_TIMEOUT_MS);
        for (let k = 0; k < idxs.length; k++) {
          const v = vecs[k];
          if (v) {
            out[idxs[k]] = v;
            cache?.set(embedCacheKey(inputs[k]), v);
          }
        }
      } catch (err) {
        // 子批整体失败 → 逐条降级（避免一条坏输入/超长文本拖垮整批）。
        // 注意：逐条重发同样受 pacing 与信号量约束（都在 requestEmbed 内部/外层），
        // 且连续失败达到阈值即短路 —— 否则"批量失败后的逐条重发"会在后端
        // 已经吃紧时再打出一串请求，把一次失败放大成请求风暴（gm-pro 的实测教训）。
        getGlobalLogger()?.warn?.('[embed] batch sub-batch failed, degrading to single-item requests', {
          endpoint: semaphoreLabel,
          inputCount: idxs.length,
          err: err instanceof Error ? err.message : String(err),
        });
        if (idxs.length > 1) {
          let consecutiveFails = 0;
          let recovered = 0;
          for (const i of idxs) {
            if (consecutiveFails >= FALLBACK_CONSECUTIVE_FAIL_LIMIT) {
              getGlobalLogger()?.warn?.('[embed] single-item fallback aborted (systematic failure)', {
                endpoint: semaphoreLabel, recovered, attempted: idxs.length,
              });
              break;
            }
            try {
              const { vecs } = await requestEmbed(target, [texts[i]], state, BATCH_TIMEOUT_MS);
              const v = vecs[0];
              if (v) {
                out[i] = v;
                cache?.set(embedCacheKey(texts[i]), v);
                recovered += 1;
                consecutiveFails = 0;
              } else {
                consecutiveFails += 1;
              }
            } catch { consecutiveFails += 1; /* 单条失败 → 保持 null，由调用方降级 */ }
          }
        }
      } finally {
        release();
      }
    }));
    return out;
  }

  return { embed, embedBatch };
}

/**
 * 创建一个 embed 函数：(text: string) => Promise<number[]>
 *
 * 每次调用都会向 embedding 端点发送 HTTP 请求，body 中包含 keep_alive 字段（仅 Ollama），
 * 确保 Ollama 保持模型驻留内存。
 */
export function createLocalEmbedFn(ecfg: EmbeddingConfig): (text: string) => Promise<number[]> {
  return createLocalEmbedFns(ecfg).embed;
}

/**
 * 创建一个批量 embed 函数：(texts: string[]) => Promise<(number[] | null)[]>
 *
 * 一次 HTTP 请求携带多个文本（OpenAI 兼容 /v1、OVMS /v3 与 Ollama /api/embed 均支持
 * input 数组），显著减少请求数。返回与输入等长的数组，单条失败为 null（不阻塞整批）。
 */
export function createLocalBatchEmbedFn(ecfg: EmbeddingConfig): BatchEmbedFn {
  return createLocalEmbedFns(ecfg).embedBatch;
}

/**
 * 轻量级 Embedding API 健康探测（heartbeat 中调用）。
 * 不消耗 token，仅验证服务可达且端点正常响应。
 * - OpenAI 兼容 (baseURL 以 /v1 或 OVMS /v3 结尾): 探测 {base}/models
 * - Ollama 原生: 探测 /api/tags
 *
 * 返回 { ok: true } 或 { ok: false, detail: "具体错误信息" }。
 */
export interface EmbeddingProbeResult {
  ok: boolean;
  detail?: string;
}

export async function probeEmbeddingHealth(cfg: EmbeddingConfig): Promise<boolean> {
  return (await probeEmbeddingHealthDetailed(cfg)).ok;
}

export async function probeEmbeddingHealthDetailed(cfg: EmbeddingConfig): Promise<EmbeddingProbeResult> {
  if (!cfg?.baseURL) return { ok: false, detail: 'embedding.baseURL not configured' };
  const baseClean = cleanBaseURL(cfg.baseURL);
  // BUGFIX(P0-5): 使用 isOllamaEndpoint 判断，与 createLocalEmbedFn 保持一致
  // OVMS /v3 属于 OpenAI 兼容端点（探测 /v3/models），不得回退到 Ollama /api/tags
  const isOpenAiCompatible = isOpenAiCompatibleEndpoint(baseClean);
  const timeoutMs = 5000;

  const probePaths: string[] = isOpenAiCompatible
    ? ['/models', '/health']
    : ['/api/tags', '/health'];

  const errors: string[] = [];
  for (const path of probePaths) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`${baseClean}${path}`, {
          method: 'GET',
          signal: controller.signal,
          headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined,
        });
        if (resp.ok) return { ok: true };
        if (resp.status === 401 || resp.status === 403) return { ok: true };
        errors.push(`${path} → HTTP ${resp.status}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${path} → ${msg}`);
    }
  }
  return { ok: false, detail: errors.join('; ') };
}