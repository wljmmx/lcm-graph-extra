import { describe, it, expect } from 'vitest';
import { cleanBaseURL, isOllamaEndpoint, withKeepAliveIfOllama } from './url.js';

describe('cleanBaseURL', () => {
  it('去掉反引号包裹', () => {
    expect(cleanBaseURL('`http://192.168.50.5:11434`')).toBe('http://192.168.50.5:11434');
  });

  it('去掉双引号包裹 + 首尾空格', () => {
    expect(cleanBaseURL(' "http://x/v1/" ')).toBe('http://x/v1');
  });

  it('去掉单引号包裹', () => {
    expect(cleanBaseURL("'http://x/v1'")).toBe('http://x/v1');
  });

  it('去掉多层包裹（反引号 + 引号）', () => {
    expect(cleanBaseURL('`"http://x/v1"`')).toBe('http://x/v1');
  });

  it('去掉尾部斜杠', () => {
    expect(cleanBaseURL('http://x/v1//')).toBe('http://x/v1');
  });

  it('保留协议头双斜杠', () => {
    expect(cleanBaseURL('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
  });

  it('空值安全返回空字符串', () => {
    expect(cleanBaseURL(undefined)).toBe('');
    expect(cleanBaseURL(null)).toBe('');
    expect(cleanBaseURL('')).toBe('');
  });

  it('非配对引号不剥离', () => {
    // 首引号但尾不是引号 → 不剥离
    expect(cleanBaseURL('`http://x')).toBe('`http://x');
  });

  it('字符串内含引号不影响首尾剥离', () => {
    expect(cleanBaseURL('`http://x/v1?query="abc"`')).toBe('http://x/v1?query="abc"');
  });

  it('去掉换行/制表符', () => {
    expect(cleanBaseURL('\n\thttp://x/v1\n')).toBe('http://x/v1');
  });
});

describe('isOllamaEndpoint', () => {
  it('127.0.0.1:11434 是 Ollama', () => {
    expect(isOllamaEndpoint('http://127.0.0.1:11434')).toBe(true);
  });

  it('127.0.0.1:11434/v1 是 Ollama', () => {
    expect(isOllamaEndpoint('http://127.0.0.1:11434/v1')).toBe(true);
  });

  it('localhost:18789 是 Ollama（OpenClaw 桥接端口）', () => {
    expect(isOllamaEndpoint('http://localhost:18789/v1')).toBe(true);
  });

  it('0.0.0.0:11434 是 Ollama', () => {
    expect(isOllamaEndpoint('http://0.0.0.0:11434')).toBe(true);
  });

  it('反引号包裹的 URL 也能识别', () => {
    expect(isOllamaEndpoint('`http://127.0.0.1:11434`')).toBe(true);
  });

  it('远程 IP + 11434 端口识别为 Ollama', () => {
    expect(isOllamaEndpoint('http://192.168.50.5:11434')).toBe(true);
  });

  it('OpenAI 官方不是 Ollama', () => {
    expect(isOllamaEndpoint('https://api.openai.com/v1')).toBe(false);
  });

  it('Anthropic 不是 Ollama', () => {
    expect(isOllamaEndpoint('https://api.anthropic.com/v1')).toBe(false);
  });

  it('/api/ 路径识别为 Ollama 原生端点', () => {
    expect(isOllamaEndpoint('http://x/api/chat')).toBe(true);
  });

  it('非法 URL 走兜底字符串匹配', () => {
    expect(isOllamaEndpoint('http://localhost:11434/api/embed')).toBe(true);
  });

  it('空值返回 false', () => {
    expect(isOllamaEndpoint('')).toBe(false);
    expect(isOllamaEndpoint(null)).toBe(false);
  });
});

describe('withKeepAliveIfOllama', () => {
  it('Ollama 端点注入 keep_alive', () => {
    const body = withKeepAliveIfOllama('http://127.0.0.1:11434', { model: 'x', input: 'y' }, '1h');
    expect(body).toEqual({ model: 'x', input: 'y', keep_alive: '1h' });
  });

  it('非 Ollama 端点不注入 keep_alive', () => {
    const body = withKeepAliveIfOllama('https://api.openai.com/v1', { model: 'x', input: 'y' }, '1h');
    expect(body).toEqual({ model: 'x', input: 'y' });
  });

  it('未提供 keepAlive 不注入', () => {
    const body = withKeepAliveIfOllama('http://127.0.0.1:11434', { model: 'x' }, undefined);
    expect(body).toEqual({ model: 'x' });
  });

  it('不修改原 body 对象', () => {
    const original = { model: 'x' };
    withKeepAliveIfOllama('http://127.0.0.1:11434', original, '1h');
    expect(original).toEqual({ model: 'x' });
  });
});
