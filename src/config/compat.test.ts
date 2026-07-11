import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  DEFAULT_CONFIG,
  isConfigValid,
  PluginConfigSchema,
  loadConfig,
} from '../config';

describe('Config Schema Compatibility — real-world config', () => {
  // A realistic subset of fields that an openclaw.json plugin section might contain
  const realisticConfig = {
    summaryStrategy: 'hybrid',
    maxGraphDepth: 20,
    maxNodeCount: 10000,
    enableCrossFileLinkage: true,
    crossReferenceRetentionDays: 120,
    maxTokens: 65536,
    budgetRatio: 0.4,
    compaction: {
      enabled: true,
      triggerThreshold: 8000,
      softThresholdTokens: 90000,
      keepRecentTokens: 70000,
    },
    backupConfig: {
      enabled: true,
      retentionDays: 45,
      maxBackups: 15,
      intervalHours: 12,
    },
    ttl: {
      enabled: true,
      retentionDays: 60,
      cleanupIntervalHours: 48,
    },
    logging: {
      level: 'debug',
      file: '/tmp/lcm-graph.log',
    },
    webhook: {
      enabled: false,
      events: ['dag_update', 'compaction'] as const,
    },
    llmProvider: {
      provider: 'ollama' as const,
      model: 'qwen2.5:7b',
      maxTokens: 8192,
    },
  };

  it('should accept a fully-populated realistic config through TypeBox validation', () => {
    const parsed = validateConfig(realisticConfig);
    expect(parsed.summaryStrategy).toBe('hybrid');
    expect(parsed.maxGraphDepth).toBe(20);
    expect(parsed.maxNodeCount).toBe(10000);
    expect(parsed.compaction?.triggerThreshold).toBe(8000);
    expect(parsed.backupConfig?.intervalHours).toBe(12);
    expect(parsed.ttl?.cleanupIntervalHours).toBe(48);
    expect(parsed.logging?.file).toBe('/tmp/lcm-graph.log');
    expect(parsed.webhook?.events).toEqual(['dag_update', 'compaction']);
    expect(parsed.llmProvider?.model).toBe('qwen2.5:7b');
  });

  it('should fill in all defaults when given empty object', () => {
    const parsed = validateConfig({});
    expect(parsed.summaryStrategy).toBe('strategy');
    expect(parsed.maxGraphDepth).toBe(10);
    expect(parsed.maxNodeCount).toBe(5000);
    expect(parsed.enableCrossFileLinkage).toBe(true);
    expect(parsed.crossReferenceRetentionDays).toBe(90);
    expect(parsed.maxTokens).toBe(65536);
    expect(parsed.budgetRatio).toBe(0.3);
    expect(parsed.cliTimeout).toBe(30000);
    expect(parsed.cliFallbackSearchType).toBe('search');
    expect(parsed.distillationIntervalMs).toBe(2 * 60 * 60 * 1000);
    expect(parsed.tripletTimeoutMs).toBe(60_000);
  });

  it('should passthrough extra fields without rejecting them', () => {
    const config = validateConfig({
      ...realisticConfig,
      experimentalFeature: true,
      pluginVersion: '0.1.0',
      _metadata: { source: 'user-config' },
    });
    expect((config as any).experimentalFeature).toBe(true);
    expect((config as any).pluginVersion).toBe('0.1.0');
    expect((config as any)._metadata.source).toBe('user-config');
    // core fields still valid
    expect(config.maxGraphDepth).toBe(20);
  });

  it('should reject illegal types for required scalar fields', () => {
    // maxGraphDepth must be a positive int, not a string
    expect(() => validateConfig({ maxGraphDepth: 'ten' })).toThrow();
    // budgetRatio must be a number, not a boolean
    expect(() => validateConfig({ budgetRatio: true })).toThrow();
    // enableCrossFileLinkage must be boolean, not a number
    expect(() => validateConfig({ enableCrossFileLinkage: 1 })).toThrow();
    // summaryStrategy enum — no random strings
    expect(() => validateConfig({ summaryStrategy: 'quantum' })).toThrow();
  });

  it('should reject zero / negative values for positive-number fields', () => {
    expect(() => validateConfig({ maxGraphDepth: 0 })).toThrow();
    expect(() => validateConfig({ maxTokens: -100 })).toThrow();
    expect(() => validateConfig({ crossReferenceRetentionDays: -1 })).toThrow();
  });

  it('should reject nested schemas with wrong types', () => {
    // compaction.enabled must be boolean
    expect(() =>
      validateConfig({ compaction: { enabled: 'yes' } })
    ).toThrow();
    // logging.level must be valid enum
    expect(() =>
      validateConfig({ logging: { level: 'chatty' } })
    ).toThrow();
    // webhook.events must be array of known enums
    expect(() =>
      validateConfig({ webhook: { events: ['screenshot'] } })
    ).toThrow();
    // llmProvider.provider must be valid enum
    expect(() =>
      validateConfig({ llmProvider: { provider: 'claude' } })
    ).toThrow();
  });

  it('should accept partial optional sections with defaults filled in', () => {
    const parsed = validateConfig({
      compaction: { enabled: false }, // omit triggerThreshold etc.
      webhook: {}, // all defaults
    });
    expect(parsed.compaction?.enabled).toBe(false);
    expect(parsed.compaction?.triggerThreshold).toBe(20000); // default
    expect(parsed.webhook?.enabled).toBe(false); // default
    expect(parsed.webhook?.events).toEqual([]); // default
  });

  it('should handle webhook.url as optional (undefined is fine, valid url accepted)', () => {
    const withUrl = validateConfig({
      webhook: { enabled: true, url: 'https://example.com/hook' },
    });
    expect(withUrl.webhook?.url).toBe('https://example.com/hook');

    const withoutUrl = validateConfig({ webhook: { enabled: true } });
    expect(withoutUrl.webhook?.url).toBeUndefined();
  });

  it('should correctly parse backupConfig with all fields', () => {
    const parsed = validateConfig({
      backupConfig: {
        enabled: false,
        retentionDays: 7,
        maxBackups: 3,
        intervalHours: 6,
        backupDir: '/custom/backups',
      },
    });
    expect(parsed.backupConfig?.enabled).toBe(false);
    expect(parsed.backupConfig?.retentionDays).toBe(7);
    expect(parsed.backupConfig?.backupDir).toBe('/custom/backups');
  });

  it('should accept llmProvider with all three provider enum values', () => {
    for (const prov of ['openclaw_hooks', 'openai', 'ollama'] as const) {
      const parsed = validateConfig({ llmProvider: { provider: prov } });
      expect(parsed.llmProvider?.provider).toBe(prov);
    }
  });
});

describe('Config Schema — loadConfig with file', () => {
  it('returns default config when given no path', async () => {
    const config = await loadConfig();
    expect(config.summaryStrategy).toBe(DEFAULT_CONFIG.summaryStrategy);
  });

  it('returns default config when file does not exist', async () => {
    const config = await loadConfig('/tmp/lcm-graph-extra/no-such-file.json');
    expect(config.maxGraphDepth).toBe(10);
  });

  it('should parse a valid JSON file and return merged config', async () => {
    const fs = await import('fs/promises');
    const tmpFile = '/tmp/lcm-graph-extra-test-config.json';
    await fs.mkdir('/tmp/lcm-graph-extra-test-config-dir', { recursive: true });
    await fs.writeFile(
      tmpFile,
      JSON.stringify({ summaryStrategy: 'full', maxGraphDepth: 50 })
    );
    try {
      const config = await loadConfig(tmpFile);
      expect(config.summaryStrategy).toBe('full');
      expect(config.maxGraphDepth).toBe(50);
      // defaults still merged for missing fields
      expect(config.maxNodeCount).toBe(5000);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  it('returns defaults when file contains invalid JSON', async () => {
    const fs = await import('fs/promises');
    const tmpFile = '/tmp/lcm-graph-extra-invalid.json';
    await fs.writeFile(tmpFile, '{ bad json };');
    try {
      const config = await loadConfig(tmpFile);
      expect(config.summaryStrategy).toBe(DEFAULT_CONFIG.summaryStrategy);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });
});
