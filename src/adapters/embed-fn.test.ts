/**
 * createLocalEmbedFn 单元测试。
 *
 * 覆盖：
 * - keep_alive 字段被正确写入请求 body
 * - OpenAI 兼容格式 (/v1/embeddings) 响应解析
 * - Ollama 原生格式 (/api/embed) 响应解析
 * - apiKey 鉴权头
 * - HTTP 错误处理
 * - 默认值（keepAlive=-1, model, baseURL）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLocalEmbedFn, createLocalEmbedFns, createLocalBatchEmbedFn, clearEmbedConcurrencyState } from './embed-fn.js';
import type { EmbeddingConfig } from '../types.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('createLocalEmbedFn', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('默认 keep_alive=-1 (永不过期) 被写入请求 body', async () => {
    // BUGFIX(P0-5): Ollama 端点即使 baseURL 带 /v1，也走原生 /api/embed（支持 keep_alive）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    });

    const embed = createLocalEmbedFn({ model: 'test-model', baseURL: 'http://localhost:11434/v1' });
    await embed('hello');

    const [url, opts] = mockFetch.mock.calls[0];
    // /v1 后缀被剥离，走原生 /api/embed 而非 /v1/embeddings
    expect(url).toBe('http://localhost:11434/api/embed');
    const body = JSON.parse(opts.body);
    expect(body.keep_alive).toBe(-1);
    expect(body.model).toBe('test-model');
    expect(body.input).toEqual(['hello']);
  });

  it('自定义 keep_alive 值被传递', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });

    const embed = createLocalEmbedFn({
      model: 'm',
      baseURL: 'http://localhost:11434/v1',
      keepAlive: '24h',
    });
    await embed('test');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.keep_alive).toBe('24h');
  });

  it('OpenAI 兼容格式：baseURL 以 /v1 结尾', async () => {
    // P0-5: 非 Ollama 端点 + /v1 才走 OpenAI 兼容 /v1/embeddings
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://host:8080/v1' });
    const result = await embed('text');

    expect(mockFetch.mock.calls[0][0]).toBe('http://host:8080/v1/embeddings');
    expect(result).toEqual([1, 2, 3]);
  });

  it('Ollama 原生格式：baseURL 不以 /v1 结尾', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [4, 5, 6] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://host:11434' });
    const result = await embed('text');

    expect(mockFetch.mock.calls[0][0]).toBe('http://host:11434/api/embed');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.keep_alive).toBe(-1);
    expect(result).toEqual([4, 5, 6]);
  });

  it('apiKey 设置 Authorization 头', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h/v1', apiKey: 'sk-test' });
    await embed('text');

    const opts = mockFetch.mock.calls[0][1];
    expect(opts.headers['Authorization']).toBe('Bearer sk-test');
  });

  it('无 apiKey 时不设置 Authorization 头', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h/v1' });
    await embed('text');

    const opts = mockFetch.mock.calls[0][1];
    expect(opts.headers['Authorization']).toBeUndefined();
  });

  it('HTTP 错误抛出异常含状态码', async () => {
    // 用 400（不可重试）验证错误消息携带状态码；5xx 重试语义见下方"并发/节流"用例
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h/v1' });
    await expect(embed('text')).rejects.toThrow('400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('OpenAI 格式响应缺少 embedding 字段时抛错', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h/v1' });
    await expect(embed('text')).rejects.toThrow('missing embedding');
  });

  it('Ollama 格式响应缺少 embedding 字段时抛错', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:11434' });
    await expect(embed('text')).rejects.toThrow('missing embedding');
  });

  it('options 字段被透传到 body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });

    const embed = createLocalEmbedFn({
      model: 'm',
      baseURL: 'http://h/v1',
      options: { seed: 42, temperature: 0.5 },
    });
    await embed('text');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.seed).toBe(42);
    expect(body.temperature).toBe(0.5);
  });

  it('baseURL 末尾带斜杠时正确拼接', async () => {
    // P0-5: 非 Ollama 端点 + /v1/ 才走 OpenAI 兼容路径
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:8080/v1/' });
    await embed('text');

    expect(mockFetch.mock.calls[0][0]).toBe('http://h:8080/v1/embeddings');
  });

  it('返回的函数可多次复用', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [2] }] }) });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h/v1' });
    const r1 = await embed('a');
    const r2 = await embed('b');

    expect(r1).toEqual([1]);
    expect(r2).toEqual([2]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ─── Ollama 新旧版本端点回退 ───────────────────────────────────────────

  it('新版 Ollama: /api/embed + input 字段（默认）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:11434' });
    const result = await embed('text');

    expect(mockFetch.mock.calls[0][0]).toBe('http://h:11434/api/embed');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(['text']);
    expect(body.prompt).toBeUndefined();
    expect(body.keep_alive).toBe(-1);
    expect(result).toEqual([0.1, 0.2]);
  });

  it('旧版 Ollama 回退: /api/embed 404 → /api/embeddings + prompt 字段', async () => {
    // 第一次请求 /api/embed 返回 404（旧版 Ollama 无此端点）
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });
    // 回退到 /api/embeddings 成功
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.3, 0.4] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:11434' });
    const result = await embed('text');

    // 第一次: 新版端点
    expect(mockFetch.mock.calls[0][0]).toBe('http://h:11434/api/embed');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).input).toEqual(['text']);
    // 第二次: 旧版端点 + prompt 字段
    expect(mockFetch.mock.calls[1][0]).toBe('http://h:11434/api/embeddings');
    const legacyBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(legacyBody.prompt).toBe('text');
    expect(legacyBody.input).toBeUndefined();
    expect(legacyBody.keep_alive).toBe(-1);
    expect(result).toEqual([0.3, 0.4]);
  });

  it('旧版回退后缓存状态：后续请求直接用旧版端点', async () => {
    // 首次: 404 → 回退成功
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [1] }) });
    // 第二次请求: 应直接走旧版（不再次探测）
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [2] }) });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:11434' });
    await embed('first');
    await embed('second');

    // 总共 3 次 fetch（首次探测 1 + 回退 1 + 第二次直接旧版 1）
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // 第二次请求的端点应为旧版
    expect(mockFetch.mock.calls[2][0]).toBe('http://h:11434/api/embeddings');
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).prompt).toBe('second');
  });

  it('v1 路径不触发旧版回退（即使 404）', async () => {
    // P0-5: 非 Ollama + /v1 走 OpenAI 兼容路径，404 不回退 Ollama 旧版端点。
    // 但对 OpenAI 兼容端点，404 属瞬时资源问题（OVMS Mediapipe graph 未就绪），
    // 按 gm-pro 实测只额外重试 1 次，之后仍抛错。
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:8080/v1' });
    await expect(embed('text')).rejects.toThrow('404');
    // 始终打 /v1/embeddings，从未切到 /api/embeddings
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([
      'http://h:8080/v1/embeddings',
      'http://h:8080/v1/embeddings',
    ]);
  });

  it('新版端点 500 错误不触发旧版回退（仅 404 回退），退避后重试成功', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Error' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embeddings: [[1]] }) });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:11434' });
    const v = await embed('text');

    expect(v).toEqual([1]);
    // 两次都打新版 /api/embed，从未切到旧版 /api/embeddings（只有 404 才回退）
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([
      'http://h:11434/api/embed',
      'http://h:11434/api/embed',
    ]);
  });

  // ─── options 字段在不同端点的合并策略 ─────────────────────────────────

  it('Ollama 新版端点: options 嵌套为 body.options 子对象', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2] }),
    });

    const embed = createLocalEmbedFn({
      model: 'm',
      baseURL: 'http://h:11434',
      options: { num_ctx: 4096, seed: 42, temperature: 0.8 },
    });
    await embed('text');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // options 必须嵌套为子对象，不能平铺到顶层
    expect(body.options).toEqual({ num_ctx: 4096, seed: 42, temperature: 0.8 });
    // 顶层不应出现运行时参数（Ollama 会忽略顶层不认识的字段）
    expect(body.num_ctx).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    // 核心字段保持不变
    expect(body.model).toBe('m');
    expect(body.input).toEqual(['text']);
    expect(body.keep_alive).toBe(-1);
  });

  it('Ollama 旧版端点回退: options 同样嵌套为 body.options', async () => {
    // 首次 /api/embed 404 触发回退
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.3] }),
    });

    const embed = createLocalEmbedFn({
      model: 'm',
      baseURL: 'http://h:11434',
      options: { num_ctx: 8192, top_k: 40 },
    });
    await embed('text');

    // 第二次调用是旧版端点
    const legacyBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(mockFetch.mock.calls[1][0]).toBe('http://h:11434/api/embeddings');
    expect(legacyBody.options).toEqual({ num_ctx: 8192, top_k: 40 });
    expect(legacyBody.num_ctx).toBeUndefined();
    expect(legacyBody.top_k).toBeUndefined();
    expect(legacyBody.prompt).toBe('text');
    expect(legacyBody.keep_alive).toBe(-1);
  });

  it('OpenAI 兼容端点: options 平铺到 body 顶层（不嵌套）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });

    const embed = createLocalEmbedFn({
      model: 'm',
      baseURL: 'http://h:8080/v1',
      // OpenAI 标准扩展字段：dimensions / encoding_format 本就在顶层
      options: { dimensions: 1024, encoding_format: 'float' },
    });
    await embed('text');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // OpenAI 兼容端点：平铺到顶层（不嵌套）
    expect(body.dimensions).toBe(1024);
    expect(body.encoding_format).toBe('float');
    // 不应出现 options 子对象
    expect(body.options).toBeUndefined();
  });

  it('Ollama 原生端点: 无 options 时不添加空 options 字段', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.1] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:11434' });
    await embed('text');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.options).toBeUndefined();
  });
});

describe('OVMS /v3 端点', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('单文本走 OpenAI 兼容 /v3/embeddings，且不发送 keep_alive', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    });

    const embed = createLocalEmbedFn({ model: 'bge-m3', baseURL: 'http://192.168.1.10:8000/v3' });
    const result = await embed('text');

    expect(mockFetch.mock.calls[0][0]).toBe('http://192.168.1.10:8000/v3/embeddings');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('bge-m3');
    expect(body.input).toEqual(['text']);
    // OVMS 严格校验未知字段，keep_alive 不得出现
    expect(body.keep_alive).toBeUndefined();
    expect(result).toEqual([1, 2, 3]);
  });

  it('批量走 /v3/embeddings，按 data[].index 对齐（不依赖返回顺序）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [20, 21] },
          { index: 0, embedding: [10, 11] },
        ],
      }),
    });

    const { embedBatch } = createLocalEmbedFns({ model: 'bge-m3', baseURL: 'http://192.168.1.10:8000/v3' });
    const out = await embedBatch(['a', 'b']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://192.168.1.10:8000/v3/embeddings');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(['a', 'b']);
    expect(out).toEqual([[10, 11], [20, 21]]);
  });

  it('OVMS 端点 404 不回退 Ollama 旧版（按瞬时资源问题重试 1 次后抛错）', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Mediapipe graph definition with requested name is not found',
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://192.168.1.10:8000/v3' });
    await expect(embed('text')).rejects.toThrow('404');
    // 首发 + 1 次重试；两次都是 OVMS 的 /v3/embeddings，绝不回退 Ollama 原生端点
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([
      'http://192.168.1.10:8000/v3/embeddings',
      'http://192.168.1.10:8000/v3/embeddings',
    ]);
  });
});

describe('embedBatch（批量嵌入）', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('OpenAI 兼容端点：一次请求承载多条文本', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] }),
    });

    const { embedBatch } = createLocalEmbedFns({ model: 'm', baseURL: 'http://h:8080/v1' });
    const out = await embedBatch(['a', 'b']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://h:8080/v1/embeddings');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).input).toEqual(['a', 'b']);
    expect(out).toEqual([[1], [2]]);
  });

  it('Ollama 原生端点：input 数组 + keep_alive 顶层', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1], [2], [3]] }),
    });

    const { embedBatch } = createLocalEmbedFns({ model: 'm', baseURL: 'http://h:11434' });
    const out = await embedBatch(['a', 'b', 'c']);

    expect(mockFetch.mock.calls[0][0]).toBe('http://h:11434/api/embed');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(['a', 'b', 'c']);
    expect(body.keep_alive).toBe(-1);
    expect(out).toEqual([[1], [2], [3]]);
  });

  it('按 batchSize 切分子批（串行发送）', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [3] }] }) });

    const { embedBatch } = createLocalEmbedFns({ model: 'm', baseURL: 'http://h:8080/v1', batchSize: 2 });
    const out = await embedBatch(['a', 'b', 'c']);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).input).toEqual(['a', 'b']);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).input).toEqual(['c']);
    expect(out).toEqual([[1], [2], [3]]);
  });

  it('非法 batchSize 回退默认（不切分死循环）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1] }] }),
    });

    const { embedBatch } = createLocalEmbedFns({ model: 'm', baseURL: 'http://h:8080/v1', batchSize: 0 });
    const out = await embedBatch(['a']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(out).toEqual([[1]]);
  });

  it('批量与单文本共享 LRU 缓存：已缓存文本不发请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [9] }] }),
    });

    const { embed, embedBatch } = createLocalEmbedFns({ model: 'm', baseURL: 'http://h:8080/v1' });
    await embed('same');
    const out = await embedBatch(['same']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(out).toEqual([[9]]);
  });

  it('空数组不请求', async () => {
    const { embedBatch } = createLocalEmbedFns({ model: 'm', baseURL: 'http://h:8080/v1' });
    expect(await embedBatch([])).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('空文本跳过：位置保持 null，不发出空输入请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] }),
    });

    const { embedBatch } = createLocalEmbedFns({ model: 'm', baseURL: 'http://h:8080/v1' });
    const out = await embedBatch(['a', '', 'b']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).input).toEqual(['a', 'b']);
    expect(out).toEqual([[1], null, [2]]);
  });

  it('子批失败 → 逐条降级，失败的条目返回 null（不阻塞整批）', async () => {
    // 1) 子批请求整体失败（400：不可重试，立即进入降级路径）
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'boom' });
    // 2) 逐条降级：a 成功
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1] }] }) });
    // 3) 逐条降级：b 失败
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad input' });

    const { embedBatch } = createLocalEmbedFns({ model: 'm', baseURL: 'http://h:8080/v1', batchSize: 2 });
    const out = await embedBatch(['a', 'b']);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(out).toEqual([[1], null]);
  });

  it('createLocalBatchEmbedFn 返回可用的批量函数', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [7] }] }),
    });

    const embedBatch = createLocalBatchEmbedFn({ model: 'm', baseURL: 'http://h:8080/v1' } as EmbeddingConfig);
    expect(await embedBatch(['x'])).toEqual([[7]]);
  });
});

/**
 * 并发闸门 + 发送节流（对齐 graph-memory-pro v2.8.x src/engine/embed.ts）。
 *
 * 每个用例使用**独立的 baseURL|model**，避免模块级共享信号量/游标跨用例串扰。
 */
describe('并发闸门与发送节流（对齐 gm-pro）', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    clearEmbedConcurrencyState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('非私网/公网端点同样受每端点信号量约束：并发峰值 = maxConcurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    mockFetch.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { ok: true, json: async () => ({ embedding: [0.1, 0.2] }) };
    });

    // 公网域名：withOllamaSlot 判定为"非 Ollama"→ 直接放行；
    // 但每端点信号量必须仍然生效（这正是本次要闭掉的开口）
    const { embedBatch } = createLocalEmbedFns({
      model: 'sig-model',
      baseURL: 'https://emb.example.com/v3',
      maxConcurrency: 2,
      batchSize: 1,
    });
    const out = await embedBatch(Array.from({ length: 6 }, (_, i) => `sig-${i}`));

    expect(out.every((v) => v !== null)).toBe(true);
    // 峰值必须等于上限：既证明「不超限」，也证明「子批次确实并发发送」
    expect(peak).toBe(2);
  });

  it('maxConcurrency=1 时子批次串行（峰值 1）', async () => {
    let inFlight = 0;
    let peak = 0;
    mockFetch.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return { ok: true, json: async () => ({ embedding: [1] }) };
    });

    const { embedBatch } = createLocalEmbedFns({
      model: 'serial-model',
      baseURL: 'https://serial.example.com/v3',
      maxConcurrency: 1,
      batchSize: 1,
    });
    await embedBatch(['a', 'b', 'c']);

    expect(peak).toBe(1);
  });

  it('requestIntervalMs 强制相邻两次发送的最小间隔', async () => {
    const sendAt: number[] = [];
    mockFetch.mockImplementation(async () => {
      sendAt.push(Date.now());
      return { ok: true, json: async () => ({ embedding: [1] }) };
    });

    const { embedBatch } = createLocalEmbedFns({
      model: 'pace-model',
      baseURL: 'https://pace.example.com/v3',
      requestIntervalMs: 120,
      maxConcurrency: 4,
      batchSize: 1,
    });
    await embedBatch(['a', 'b', 'c']);

    expect(sendAt).toHaveLength(3);
    for (let i = 1; i < sendAt.length; i++) {
      // 留 10ms 调度误差；关键是"不再零间隔背靠背"
      expect(sendAt[i] - sendAt[i - 1]).toBeGreaterThanOrEqual(110);
    }
  });

  it('requestIntervalMs 默认关闭（0）时不引入额外延迟', async () => {
    const sendAt: number[] = [];
    mockFetch.mockImplementation(async () => {
      sendAt.push(Date.now());
      return { ok: true, json: async () => ({ embedding: [1] }) };
    });

    const { embedBatch } = createLocalEmbedFns({
      model: 'nopacing-model',
      baseURL: 'https://nopacing.example.com/v3',
      maxConcurrency: 4,
      batchSize: 1,
    });
    await embedBatch(['a', 'b', 'c']);

    expect(sendAt).toHaveLength(3);
    // 关闭节流 → 三次发送几乎同时（远小于 120ms）
    expect(sendAt[sendAt.length - 1] - sendAt[0]).toBeLessThan(100);
  });

  it('maxBatchChars 触发长度感知装箱（按总字符预算切分，而非仅按条数）', async () => {
    const inputCounts: number[] = [];
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      inputCounts.push(body.input.length);
      return {
        ok: true,
        json: async () => ({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: [1] })) }),
      };
    });

    const { embedBatch } = createLocalEmbedFns({
      model: 'chars-model',
      baseURL: 'https://chars.example.com/v3',
      batchSize: 100, // 条数上限很宽
      maxBatchChars: 10, // 但每条 6 字符 → 6+6=12 > 10，每批只能装 1 条
      maxConcurrency: 1, // 串行化，使断言顺序确定
    });
    await embedBatch(['aaaaaa', 'bbbbbb', 'cccccc']);

    expect(inputCounts).toEqual([1, 1, 1]);
  });

  it('maxBatchChars 关闭（默认 0）时退化为纯按条数装箱', async () => {
    const inputCounts: number[] = [];
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      inputCounts.push(body.input.length);
      return {
        ok: true,
        json: async () => ({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: [1] })) }),
      };
    });

    const { embedBatch } = createLocalEmbedFns({
      model: 'nochars-model',
      baseURL: 'https://nochars.example.com/v3',
      batchSize: 2,
      maxConcurrency: 1,
    });
    // 长文本不影响装箱（预算关闭）→ 2 + 1
    await embedBatch(['a'.repeat(500), 'b'.repeat(500), 'c'.repeat(500)]);

    expect(inputCounts).toEqual([2, 1]);
  });

  it('批量失败后的逐条降级受"连续失败短路"限制（防请求风暴）', async () => {
    // 全部请求失败（400：不可重试，快速进入降级路径，便于计数）
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => 'boom',
    }));

    const { embedBatch } = createLocalEmbedFns({
      model: 'storm-model',
      baseURL: 'https://storm.example.com/v3',
      batchSize: 8,
      maxConcurrency: 1,
    });
    const out = await embedBatch(Array.from({ length: 8 }, (_, i) => `storm-${i}`));

    expect(out).toEqual(new Array(8).fill(null));
    // 1 次批量 + 2 次单条（连续失败达阈值即短路），而不是 1 + 8 = 9 次
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('5xx 退避重试成功（可重试状态码）', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'server busy' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.5] }) });

    const embed = createLocalEmbedFn({
      model: 'retry-model',
      baseURL: 'https://retry.example.com/v3',
    });

    expect(await embed('x')).toEqual([0.5]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);
});
