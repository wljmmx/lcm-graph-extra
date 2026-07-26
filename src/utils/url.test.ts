import { describe, it, expect } from 'vitest';
import { cleanBaseURL, isOllamaEndpoint, withKeepAliveIfOllama, isLocalEndpoint, detectApiFormat, ensureAnthropicMessagesPath } from './url.js';

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

describe('isLocalEndpoint', () => {
  it('127.0.0.1 是本地', () => {
    expect(isLocalEndpoint('http://127.0.0.1:8000/v1')).toBe(true);
  });

  it('localhost 是本地', () => {
    expect(isLocalEndpoint('http://localhost:8000/v1')).toBe(true);
  });

  it('0.0.0.0 是本地', () => {
    expect(isLocalEndpoint('http://0.0.0.0:8000/v1')).toBe(true);
  });

  it('192.168.x.x 私有网段是本地', () => {
    expect(isLocalEndpoint('http://192.168.1.100:8000/v1')).toBe(true);
    expect(isLocalEndpoint('http://192.168.50.5:11434')).toBe(true);
  });

  it('10.x.x.x 私有网段是本地', () => {
    expect(isLocalEndpoint('http://10.0.0.1:8000/v1')).toBe(true);
  });

  it('172.16-31.x.x 私有网段是本地', () => {
    expect(isLocalEndpoint('http://172.16.0.1:8000/v1')).toBe(true);
    expect(isLocalEndpoint('http://172.31.255.254:8000/v1')).toBe(true);
    expect(isLocalEndpoint('http://172.15.0.1:8000/v1')).toBe(false);
    expect(isLocalEndpoint('http://172.32.0.1:8000/v1')).toBe(false);
  });

  it('.local 域名是本地', () => {
    expect(isLocalEndpoint('http://my-mac.local:8000/v1')).toBe(true);
  });

  it('公网 IP 不是本地', () => {
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false);
    expect(isLocalEndpoint('https://8.8.8.8:8000/v1')).toBe(false);
  });

  it('unsloth 本地部署 Anthropic 格式是本地', () => {
    expect(isLocalEndpoint('http://127.0.0.1:8000/v1/messages')).toBe(true);
    expect(isLocalEndpoint('http://192.168.50.10:8000/v1/messages')).toBe(true);
  });

  it('空值返回 false', () => {
    expect(isLocalEndpoint('')).toBe(false);
    expect(isLocalEndpoint(null)).toBe(false);
  });
});

describe('detectApiFormat', () => {
  it('默认 OpenAI 格式', () => {
    expect(detectApiFormat('https://api.openai.com/v1')).toBe('openai');
    expect(detectApiFormat('http://127.0.0.1:11434/v1')).toBe('openai');
  });

  it('/v1/messages 路径识别为 Anthropic 格式', () => {
    expect(detectApiFormat('https://api.anthropic.com/v1/messages')).toBe('anthropic');
    expect(detectApiFormat('http://127.0.0.1:8000/v1/messages')).toBe('anthropic');
  });

  it('/messages 路径识别为 Anthropic 格式', () => {
    expect(detectApiFormat('http://localhost:8000/messages')).toBe('anthropic');
  });

  it('claude- 前缀模型识别为 Anthropic 格式', () => {
    expect(detectApiFormat('', 'claude-3-5-sonnet-20240620')).toBe('anthropic');
    expect(detectApiFormat('http://127.0.0.1:8000/v1', 'claude-3-opus')).toBe('anthropic');
  });

  it('unsloth 本地部署 Anthropic 格式识别正确', () => {
    expect(detectApiFormat('http://127.0.0.1:8000/v1/messages', 'qwen2.5-72b')).toBe('anthropic');
    expect(detectApiFormat('http://192.168.50.10:8000/v1/messages')).toBe('anthropic');
  });
});

describe('ensureAnthropicMessagesPath', () => {
  it('裸 baseURL 自动拼接 /v1/messages', () => {
    expect(ensureAnthropicMessagesPath('http://192.168.50.5:8888')).toBe('http://192.168.50.5:8888/v1/messages');
    expect(ensureAnthropicMessagesPath('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/v1/messages');
  });

  it('已有 /v1 后缀则补全 /messages', () => {
    expect(ensureAnthropicMessagesPath('http://192.168.50.5:8888/v1')).toBe('http://192.168.50.5:8888/v1/messages');
    expect(ensureAnthropicMessagesPath('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1/messages');
  });

  it('已有 /v1/messages 则不变', () => {
    expect(ensureAnthropicMessagesPath('http://192.168.50.5:8888/v1/messages')).toBe('http://192.168.50.5:8888/v1/messages');
  });

  it('已有 /messages 后缀则不变', () => {
    expect(ensureAnthropicMessagesPath('http://localhost:8000/messages')).toBe('http://localhost:8000/messages');
  });

  it('清洗包裹字符后拼接', () => {
    expect(ensureAnthropicMessagesPath('`http://192.168.50.5:8888`')).toBe('http://192.168.50.5:8888/v1/messages');
    expect(ensureAnthropicMessagesPath(' "http://192.168.50.5:8888/v1" ')).toBe('http://192.168.50.5:8888/v1/messages');
  });

  it('空值返回空字符串', () => {
    expect(ensureAnthropicMessagesPath('')).toBe('');
    expect(ensureAnthropicMessagesPath(null)).toBe('');
    expect(ensureAnthropicMessagesPath(undefined)).toBe('');
  });
});
