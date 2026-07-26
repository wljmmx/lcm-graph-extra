import { describe, it, expect, beforeEach, vi } from 'vitest';
import { callLlm, isLocalLlm } from './llm-call.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockJsonResponse(data: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('callLlm', () => {
  describe('OpenAI format', () => {
    it('calls /v1/chat/completions and parses response', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: 'hello world' } }],
      }));
      const result = await callLlm({
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        prompt: 'hi',
      });
      expect(result.text).toBe('hello world');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('uses Bearer token auth', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }));
      await callLlm({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        prompt: 'hi',
      });
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer sk-test');
      expect(headers['x-api-key']).toBeUndefined();
    });

    it('injects system message when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }));
      await callLlm({
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        system: 'You are helpful',
        prompt: 'hi',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('injects keep_alive for Ollama endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }));
      await callLlm({
        baseURL: 'http://127.0.0.1:11434/v1',
        model: 'qwen3.6:27b',
        prompt: 'hi',
        keepAlive: '1h',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.keep_alive).toBe('1h');
    });

    it('does not inject keep_alive for non-Ollama endpoint', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }));
      await callLlm({
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        prompt: 'hi',
        keepAlive: '1h',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.keep_alive).toBeUndefined();
    });

    it('falls back to reasoning_content when content is empty', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: '', reasoning_content: 'thinking result' } }],
      }));
      const result = await callLlm({
        baseURL: 'https://api.openai.com/v1',
        model: 'qwen3',
        prompt: 'hi',
      });
      expect(result.text).toBe('thinking result');
    });

    it('strips <think> tags from content', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: '<think>internal reasoning</think>actual answer' } }],
      }));
      const result = await callLlm({
        baseURL: 'https://api.openai.com/v1',
        model: 'qwen3',
        prompt: 'hi',
      });
      expect(result.text).toBe('actual answer');
    });

    it('throws on HTTP error with status code', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'bad request' }, 400));
      await expect(callLlm({
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        prompt: 'hi',
      })).rejects.toThrow('LLM HTTP 400');
    });
  });

  describe('Anthropic format', () => {
    it('calls /v1/messages and parses response', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        content: [{ type: 'text', text: 'anthropic response' }],
      }));
      const result = await callLlm({
        baseURL: 'https://api.anthropic.com/v1/messages',
        model: 'claude-3-5-sonnet-20240620',
        prompt: 'hi',
      });
      expect(result.text).toBe('anthropic response');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('uses x-api-key and anthropic-version headers', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
      }));
      await callLlm({
        baseURL: 'https://api.anthropic.com/v1/messages',
        apiKey: 'sk-ant-test',
        model: 'claude-3-5-sonnet-20240620',
        prompt: 'hi',
      });
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('passes system as top-level field, not in messages', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
      }));
      await callLlm({
        baseURL: 'https://api.anthropic.com/v1/messages',
        model: 'claude-3-5-sonnet-20240620',
        system: 'You are helpful',
        prompt: 'hi',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.system).toBe('You are helpful');
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('extracts thinking blocks as reasoning', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        content: [
          { type: 'thinking', thinking: 'my internal thought' },
          { type: 'text', text: 'final answer' },
        ],
      }));
      const result = await callLlm({
        baseURL: 'https://api.anthropic.com/v1/messages',
        model: 'claude-3-5-sonnet-20240620',
        prompt: 'hi',
      });
      expect(result.text).toBe('final answer');
      expect(result.reasoning).toBe('my internal thought');
    });

    it('detects Anthropic format from claude- model prefix', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
      }));
      await callLlm({
        baseURL: 'http://127.0.0.1:8000/v1',
        model: 'claude-3-opus',
        prompt: 'hi',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8000/v1/messages',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('supports unsloth local deployment with Anthropic format', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        content: [{ type: 'text', text: 'unsloth response' }],
      }));
      const result = await callLlm({
        baseURL: 'http://192.168.50.10:8000/v1/messages',
        model: 'qwen2.5-72b',
        apiKey: 'local-key',
        prompt: 'hi',
      });
      expect(result.text).toBe('unsloth response');
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['x-api-key']).toBe('local-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });
  });

  describe('endpoint construction', () => {
    it('appends /v1/chat/completions to bare baseURL', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }));
      await callLlm({
        baseURL: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        prompt: 'hi',
      });
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('appends /messages to /v1 baseURL for Anthropic', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
      }));
      await callLlm({
        baseURL: 'http://localhost:8000/v1',
        model: 'claude-3',
        prompt: 'hi',
      });
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:8000/v1/messages');
    });
  });

  describe('extra headers', () => {
    it('merges extraHeaders into request', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }));
      await callLlm({
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        prompt: 'hi',
        extraHeaders: { 'X-Custom-Header': 'custom-value' },
      });
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-Custom-Header']).toBe('custom-value');
    });
  });
});

describe('isLocalLlm', () => {
  it('127.0.0.1 is local', () => {
    expect(isLocalLlm('http://127.0.0.1:8000/v1')).toBe(true);
  });

  it('localhost is local', () => {
    expect(isLocalLlm('http://localhost:8000/v1')).toBe(true);
  });

  it('192.168.x.x is local', () => {
    expect(isLocalLlm('http://192.168.50.10:8000/v1/messages')).toBe(true);
  });

  it('10.x.x.x is local', () => {
    expect(isLocalLlm('http://10.0.0.1:8000/v1')).toBe(true);
  });

  it('public IP is not local', () => {
    expect(isLocalLlm('https://api.openai.com/v1')).toBe(false);
  });

  it('empty value returns false', () => {
    expect(isLocalLlm('')).toBe(false);
    expect(isLocalLlm(null)).toBe(false);
  });

  it('.local domain is local', () => {
    expect(isLocalLlm('http://my-server.local:8000/v1')).toBe(true);
  });
});
