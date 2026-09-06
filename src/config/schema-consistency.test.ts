import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PluginConfigSchema } from '../config';

// 从文件系统读取 openclaw.plugin.json（项目根目录），保证测试与发布产物同源
const pluginJsonPath = resolve(__dirname, '../../openclaw.plugin.json');
const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));

// plugin.json 中的 configSchema 顶层 properties
const jsonSchemaProps = pluginJson.configSchema.properties;
// TypeBox PluginConfigSchema 顶层 properties
const tsSchemaProps = PluginConfigSchema.properties;

/**
 * 沿点分路径解析嵌套 schema。
 * - 普通字段：通过 `properties[name]` 下钻
 * - 数组元素：路径中使用 'items' 关键字，取 `cur.items`
 * 适用于 TypeBox 生成的 schema 与 plugin.json 中的 JSON Schema（两者结构一致）。
 */
function resolveSchemaPath(root: any, path: string): any {
  const parts = path.split('.');
  let cur: any = root;
  for (const p of parts) {
    if (!cur) return undefined;
    if (p === 'items') {
      cur = cur.items;
    } else if (cur.properties && p in cur.properties) {
      cur = cur.properties[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * 从 TypeBox 的 Type.Union([Type.Literal(...)]) 结构中提取 enum 值数组。
 * TypeBox 会将其编译为 `{ anyOf: [{ type: 'string', const: value }, ...] }`。
 */
function extractTsEnum(schema: any): any[] | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((s: any) => s.const);
  }
  return undefined;
}

describe('openclaw.plugin.json ↔ src/config.ts Schema 一致性', () => {
  describe('1. 字段覆盖一致性', () => {
    // config.ts PluginConfigSchema 中定义的所有顶层字段名
    const tsTopLevelFields = Object.keys(tsSchemaProps);

    it('config.ts 中定义的每个顶层字段都应在 plugin.json configSchema 中有对应定义', () => {
      const missing = tsTopLevelFields.filter((f) => !(f in jsonSchemaProps));
      expect(missing, `plugin.json 缺少以下字段: ${missing.join(', ')}`).toEqual([]);
    });

    it('关键模块字段在两侧均存在', () => {
      // 覆盖任务要求的关键模块（注意 backupConfig 而非 backup，无 lcmStub 字段）
      const keyFields = [
        'neo4j',
        'embedding',
        'moa',
        'compaction',
        'experience',
        'ttl',
        'backupConfig',
        'webhook',
        'logging',
        'lcmMonitor',
        'llmProvider',
        'distillationLlm',
        'dashboardSnapshot',
        'retrieval',
        'llmTimeouts',
        'stubLargeToolPayloads',
      ];
      for (const f of keyFields) {
        expect(tsSchemaProps[f], `config.ts 缺少字段 ${f}`).toBeDefined();
        expect(jsonSchemaProps[f], `plugin.json 缺少字段 ${f}`).toBeDefined();
      }
    });
  });

  describe('2. 默认值一致性', () => {
    // config.ts 中带 { default: X } 的关键字段，两侧默认值必须相等
    const cases: Array<{ name: string; path: string; expected: any }> = [
      { name: 'moa.mode', path: 'moa.mode', expected: 'auto' },
      { name: 'moa.complexityThreshold', path: 'moa.complexityThreshold', expected: 0.6 },
      { name: 'moa.enabled', path: 'moa.enabled', expected: false },
      { name: 'compaction.triggerThreshold', path: 'compaction.triggerThreshold', expected: 20000 },
      { name: 'experience.enabled', path: 'experience.enabled', expected: true },
      { name: 'ttl.enabled', path: 'ttl.enabled', expected: true },
      { name: 'backupConfig.enabled', path: 'backupConfig.enabled', expected: true },
      { name: 'qmdMcpQueryTimeout', path: 'qmdMcpQueryTimeout', expected: 30000 },
      { name: 'qmdMcpTimeout', path: 'qmdMcpTimeout', expected: 3000 },
    ];

    for (const c of cases) {
      it(`${c.name} 默认值在两侧均为 ${JSON.stringify(c.expected)}`, () => {
        const tsSchema = resolveSchemaPath(PluginConfigSchema, c.path);
        const jsonSchema = resolveSchemaPath(pluginJson.configSchema, c.path);

        expect(tsSchema, `config.ts 中 ${c.path} 不存在`).toBeDefined();
        expect(jsonSchema, `plugin.json 中 ${c.path} 不存在`).toBeDefined();
        expect(tsSchema.default).toBe(c.expected);
        expect(jsonSchema.default).toBe(c.expected);
      });
    }
  });

  describe('3. enum 一致性', () => {
    // config.ts 中用 Type.Union([Type.Literal(...)]) 定义的 enum 字段
    const enumCases: Array<{ name: string; path: string; expected: any[] }> = [
      { name: 'moa.mode', path: 'moa.mode', expected: ['auto', 'parallel', 'serial'] },
      { name: 'summaryStrategy', path: 'summaryStrategy', expected: ['strategy', 'hybrid', 'full'] },
      { name: 'experience.summaryMode', path: 'experience.summaryMode', expected: ['async', 'sync'] },
      { name: 'moa.enabledTiers', path: 'moa.enabledTiers.items', expected: ['low', 'medium', 'high'] },
    ];

    for (const c of enumCases) {
      it(`${c.name} 的 enum 值在两侧一致（顺序无关）`, () => {
        const tsSchema = resolveSchemaPath(PluginConfigSchema, c.path);
        const jsonSchema = resolveSchemaPath(pluginJson.configSchema, c.path);

        // config.ts 侧：从 anyOf 提取 const
        const tsEnum = extractTsEnum(tsSchema);
        expect(tsEnum, `config.ts 中 ${c.path} 不是 enum（无 anyOf）`).toBeDefined();

        // plugin.json 侧：直接读取 enum 数组
        const jsonEnum = jsonSchema.enum;
        expect(jsonEnum, `plugin.json 中 ${c.path} 缺少 enum`).toBeDefined();

        // 排序后比较，顺序无关
        expect([...tsEnum].sort()).toEqual([...c.expected].sort());
        expect([...jsonEnum].sort()).toEqual([...c.expected].sort());
      });
    }
  });

  describe('4. provider 枚举一致性', () => {
    it('moa.referenceModels.items.provider 的 enum 值在两侧一致（顺序无关）', () => {
      const tsProvider = resolveSchemaPath(
        PluginConfigSchema,
        'moa.referenceModels.items.provider',
      );
      const jsonProvider = resolveSchemaPath(
        pluginJson.configSchema,
        'moa.referenceModels.items.provider',
      );

      expect(tsProvider, 'config.ts 中 moa.referenceModels.items.provider 不存在').toBeDefined();
      expect(jsonProvider, 'plugin.json 中 moa.referenceModels.items.provider 不存在').toBeDefined();

      const tsEnum = extractTsEnum(tsProvider);
      const jsonEnum = jsonProvider.enum;

      expect(tsEnum, 'config.ts 中 provider 不是 enum（无 anyOf）').toBeDefined();
      expect(jsonEnum, 'plugin.json 中 provider 缺少 enum').toBeDefined();

      // 两侧 enum 集合应一致（顺序无关）
      expect([...tsEnum].sort()).toEqual([...jsonEnum].sort());

      // 应包含全部预期 provider
      const expectedProviders = [
        'openai',
        'ollama',
        'deepseek',
        'unsloth',
        'custom',
        'openclaw_hooks',
      ];
      expect([...tsEnum].sort()).toEqual([...expectedProviders].sort());
      expect([...jsonEnum].sort()).toEqual([...expectedProviders].sort());
    });
  });
});
