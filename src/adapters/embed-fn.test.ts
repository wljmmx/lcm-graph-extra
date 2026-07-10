/**
 * createLocalEmbedFn 单元测试。
 *
 * 覆盖：
 * - keep_alive 字段被正确写入请求 body
 * - OpenAI 兼容格式 (/v1/embeddings) 响应解析
 * - Ollama 原生格式 (/api/embed) 响应解析
 * - apiKey 鉴权头
 * - HTTP 错误处理
 * - 默认值（keepAlive=1h, model, baseURL）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLocalEmbedFn } from './embed-fn.js';
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

  it('默认 keep_alive=1h 被写入请求 body', async () => {
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
    expect(body.keep_alive).toBe('1h');
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
    expect(body.keep_alive).toBe('1h');
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
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h/v1' });
    await expect(embed('text')).rejects.toThrow('500');
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
    expect(body.keep_alive).toBe('1h');
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
    expect(legacyBody.keep_alive).toBe('1h');
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
    // P0-5: 非 Ollama + /v1 走 OpenAI 兼容路径，404 应直接抛错，不回退
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:8080/v1' });
    await expect(embed('text')).rejects.toThrow('404');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('新版端点 500 错误不触发回退（仅 404 回退）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Error',
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:11434' });
    await expect(embed('text')).rejects.toThrow('500');
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
    expect(body.keep_alive).toBe('1h');
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
    expect(legacyBody.keep_alive).toBe('1h');
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
