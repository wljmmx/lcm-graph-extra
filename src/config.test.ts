import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  DEFAULT_CONFIG,
  isConfigValid,
  PluginConfigSchema,
  loadConfig,
} from './config';

describe('validateConfig', () => {
  it('should accept empty object and fill defaults', () => {
    const config = validateConfig({});
    expect(config.summaryStrategy).toBe('strategy');
    expect(config.maxGraphDepth).toBe(10);
    expect(config.maxNodeCount).toBe(5000);
    expect(config.enableCrossFileLinkage).toBe(true);
    expect(config.crossReferenceRetentionDays).toBe(90);
    expect(config.maxTokens).toBe(32768);
    expect(config.budgetRatio).toBe(0.3);
  });

  it('should accept valid partial config and merge defaults', () => {
    const config = validateConfig({
      summaryStrategy: 'hybrid',
      maxGraphDepth: 15,
      maxTokens: 65536,
    });
    expect(config.summaryStrategy).toBe('hybrid');
    expect(config.maxGraphDepth).toBe(15);
    expect(config.maxTokens).toBe(65536);
    // defaults preserved
    expect(config.maxNodeCount).toBe(5000);
    expect(config.budgetRatio).toBe(0.3);
  });

  it('should accept full optional sections', () => {
    const config = validateConfig({
      compaction: { enabled: false, triggerThreshold: 5000 },
      backupConfig: { enabled: true, retentionDays: 60, maxBackups: 20 },
      ttl: { enabled: true, retentionDays: 180 },
      logging: { level: 'debug' },
      webhook: { enabled: false },
      llmProvider: { provider: 'ollama', model: 'llama3' },
    });
    expect(config.compaction?.enabled).toBe(false);
    expect(config.backupConfig?.retentionDays).toBe(60);
    expect(config.ttl?.retentionDays).toBe(180);
    expect(config.logging?.level).toBe('debug');
    expect(config.llmProvider?.provider).toBe('ollama');
  });

  it('should reject negative maxGraphDepth', () => {
    expect(() => validateConfig({ maxGraphDepth: -1 })).toThrow(/Invalid plugin config/);
  });

  it('should reject non-integer retentionDays', () => {
    expect(() => validateConfig({ crossReferenceRetentionDays: 3.5 })).toThrow(/Invalid plugin config/);
  });

  it('should reject budgetRatio out of range', () => {
    expect(() => validateConfig({ budgetRatio: 1.5 })).toThrow(/Invalid plugin config/);
    expect(() => validateConfig({ budgetRatio: -0.1 })).toThrow(/Invalid plugin config/);
  });

  it('should reject invalid summaryStrategy value', () => {
    expect(() => validateConfig({ summaryStrategy: 'invalid' })).toThrow(/Invalid plugin config/);
  });

  it('should reject invalid log level', () => {
    expect(() => validateConfig({ logging: { level: 'verbose' } })).toThrow(/Invalid plugin config/);
  });

  it('should reject invalid webhook event names', () => {
    expect(() =>
      validateConfig({ webhook: { events: ['invalid_event'] as any } })
    ).toThrow(/Invalid plugin config/);
  });

  it('should reject non-url webhook url', () => {
    expect(() =>
      validateConfig({ webhook: { enabled: true, url: 'not-a-url' } })
    ).toThrow(/Invalid plugin config/);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('should have correct default values for all required fields', () => {
    expect(DEFAULT_CONFIG.summaryStrategy).toBe('strategy');
    expect(DEFAULT_CONFIG.maxGraphDepth).toBe(10);
    expect(DEFAULT_CONFIG.maxNodeCount).toBe(5000);
    expect(DEFAULT_CONFIG.enableCrossFileLinkage).toBe(true);
    expect(DEFAULT_CONFIG.crossReferenceRetentionDays).toBe(90);
    expect(DEFAULT_CONFIG.maxTokens).toBe(32768);
    expect(DEFAULT_CONFIG.budgetRatio).toBe(0.3);
  });

  it('should pass schema validation', () => {
    expect(isConfigValid(DEFAULT_CONFIG)).toBe(true);
  });
});

describe('isConfigValid', () => {
  it('returns true for valid config', () => {
    expect(isConfigValid({})).toBe(true);
    expect(isConfigValid({ summaryStrategy: 'full', maxGraphDepth: 5 })).toBe(true);
  });

  it('returns false for invalid types', () => {
    expect(isConfigValid(null)).toBe(false);
    expect(isConfigValid(undefined)).toBe(false);
    expect(isConfigValid('string')).toBe(false);
    expect(isConfigValid(42)).toBe(false);
    expect(isConfigValid([1, 2, 3])).toBe(false);
  });

  it('returns false for invalid field values', () => {
    expect(isConfigValid({ summaryStrategy: 'invalid' })).toBe(false);
    expect(isConfigValid({ maxGraphDepth: -5 })).toBe(false);
    expect(isConfigValid({ budgetRatio: 2.0 })).toBe(false);
  });
});

describe('PluginConfigSchema passthrough', () => {
  it('should not reject extra fields', () => {
    const config = validateConfig({
      customField: 'hello',
      anotherExtra: 42,
      nestedObject: { foo: true },
    });
    expect(config.summaryStrategy).toBe('strategy'); // default preserved
    // passthrough means extra fields survive
    expect((config as any).customField).toBe('hello');
    expect((config as any).anotherExtra).toBe(42);
  });
});

describe('loadConfig', () => {
  it('returns defaults when no file path given', async () => {
    const config = await loadConfig();
    expect(config.summaryStrategy).toBe('strategy');
    expect(config.maxGraphDepth).toBe(10);
  });

  it('returns defaults when file does not exist', async () => {
    const config = await loadConfig('/nonexistent/path/to/config.json');
    expect(config.summaryStrategy).toBe('strategy');
  });
});
