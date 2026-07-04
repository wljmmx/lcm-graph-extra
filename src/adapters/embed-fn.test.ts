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
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });

    const embed = createLocalEmbedFn({ model: 'test-model', baseURL: 'http://localhost:11434/v1' });
    await embed('hello');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/embeddings');
    const body = JSON.parse(opts.body);
    expect(body.keep_alive).toBe('1h');
    expect(body.model).toBe('test-model');
    expect(body.input).toBe('hello');
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
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://host:11434/v1' });
    const result = await embed('text');

    expect(mockFetch.mock.calls[0][0]).toBe('http://host:11434/v1/embeddings');
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
    await expect(embed('text')).rejects.toThrow('missing data[0].embedding');
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
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });

    const embed = createLocalEmbedFn({ model: 'm', baseURL: 'http://h:11434/v1/' });
    await embed('text');

    expect(mockFetch.mock.calls[0][0]).toBe('http://h:11434/v1/embeddings');
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
});
