/**
 * Neo4j helper 配置解析测试
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveNeo4jConfig, resolveNeo4jSearchConfig } from './neo4j-helper';

describe('neo4j-helper', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  describe('resolveNeo4jConfig', () => {
    it('should use config values when present', () => {
      const cfg = resolveNeo4jConfig({ neo4j: { uri: 'bolt://custom:7687', user: 'admin', password: 'secret' } });
      expect(cfg.uri).toBe('bolt://custom:7687');
      expect(cfg.user).toBe('admin');
      expect(cfg.password).toBe('secret');
    });

    it('should fallback to env vars when config missing', () => {
      process.env.NEO4J_URI = 'bolt://env:7687';
      process.env.NEO4J_USER = 'envuser';
      process.env.NEO4J_PASSWORD = 'envpass';
      const cfg = resolveNeo4jConfig({});
      expect(cfg.uri).toBe('bolt://env:7687');
      expect(cfg.user).toBe('envuser');
      expect(cfg.password).toBe('envpass');
    });

    it('should use defaults when nothing provided', () => {
      const cfg = resolveNeo4jConfig({});
      expect(cfg.uri).toBe('bolt://localhost:7687');
      expect(cfg.user).toBe('neo4j');
      expect(cfg.password).toBe('');
    });

    it('should prefer config over env vars', () => {
      process.env.NEO4J_URI = 'bolt://env:7687';
      const cfg = resolveNeo4jConfig({ neo4j: { uri: 'bolt://config:7687', user: 'cfg', password: 'xyz' } });
      expect(cfg.uri).toBe('bolt://config:7687');
    });
  });

  describe('resolveNeo4jSearchConfig', () => {
    it('should return defaults when config empty', () => {
      const cfg = resolveNeo4jSearchConfig({});
      expect(cfg.enabled).toBe(true);
      expect(cfg.searchLimit).toBe(5);
    });

    it('should read from retrieval.graph config', () => {
      const cfg = resolveNeo4jSearchConfig({ retrieval: { graph: { enabled: false, searchLimit: 10 } } });
      expect(cfg.enabled).toBe(false);
      expect(cfg.searchLimit).toBe(10);
    });
  });
});
