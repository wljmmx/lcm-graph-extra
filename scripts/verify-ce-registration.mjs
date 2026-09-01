/**
 * 模拟 OpenClaw 2026.8.1 加载器对 lcm-graph-extra 插件的 context-engine 注册检查。
 *
 * 复现 loader-DLF0KUIe.js registerContextEngine(record, id, factory, registrationMode) 的关键逻辑：
 * 1. id 非空校验
 * 2. factory 为函数校验
 * 3. reserved id（legacy）拒绝
 * 4. lifecycle 判定（full → runtime, 其他 → readOnlyDiscovery）
 * 5. contextEngineIds 记录
 *
 * 目的：验证插件的注册是否会被 OpenClaw 接受，以及产生什么 lifecycle。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('/workspace/dist/index.js');
const entry = mod.default ?? mod;

console.log('=== 插件入口 surface ===');
console.log('id:', entry.id);
console.log('kind (export):', entry.kind);
console.log('has register fn:', typeof entry.register === 'function');

// ── 从 openclaw.plugin.json 读取 manifest ──
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('/workspace/openclaw.plugin.json', 'utf8'));
console.log('\n=== manifest surface ===');
console.log('manifest.id:', manifest.id);
console.log('manifest.kind:', manifest.kind);
console.log('manifest requiresPlugins:', JSON.stringify(manifest.requiresPlugins));
console.log('manifest activation:', JSON.stringify(manifest.activation));
console.log('activation.onStartup:', manifest.activation?.onStartup);

// ── 模拟 loader 的 kind 合并逻辑 (loader-DLF0KUIe.js:1306-1314) ──
const manifestKind = manifest.kind;
const exportKind = entry.kind;
const recordKind = exportKind ?? manifestKind;
console.log('\n=== kind 合并 ===');
console.log('manifestKind:', manifestKind, '| exportKind:', exportKind, '| record.kind(resolved):', recordKind);
if (manifestKind && exportKind && JSON.stringify(manifestKind) !== JSON.stringify(exportKind)) {
  console.log('⚠ kind mismatch diagnostic 会触发');
} else {
  console.log('kind 一致（或 export 缺省由 manifest 补齐）');
}
const kindIncludesContextEngine = recordKind === 'context-engine' || (Array.isArray(recordKind) && recordKind.includes('context-engine'));
console.log('hasKind(record.kind, "context-engine"):', kindIncludesContextEngine);

// ── 模拟 defaultSlotIdForKey("contextEngine") = "legacy" ──
const DEFAULT_CE_SLOT = 'legacy';
console.log('\n=== context-engine 注册检查 (loader registerContextEngine) ===');
const registeredId = entry.id; // index.ts 里 registerContextEngine("lcm-graph-extra", ...)
console.log('注册 id:', registeredId);
if (!registeredId) console.log('✗ 缺失 id');
if (registeredId === DEFAULT_CE_SLOT) console.log('✗ reserved by core (legacy) — 会被拒绝');
else console.log('✓ 非保留 id，可注册');

// ── 模拟 runPluginRegisterSyncInRegistry 调用 register ──
console.log('\n=== 模拟 register(api) ===');
let registeredEngineCount = 0;
const registeredEngines = [];
const mockApi = {
  logger: { debug(){}, info(){}, warn(){}, error(){}, trace(){}, fatal(){}, child(){ return this; } },
  pluginConfig: {},
  config: { workspace: '/workspace' },
  registerContextEngine: (id, factory) => {
    registeredEngineCount++;
    registeredEngines.push(id);
  },
  registerTool: () => {},
  registerCommand: () => {},
  hooks: { on(){}, emit(){} },
  lifecycle: { on(){} },
  on: () => {},
};
entry.register(mockApi);
console.log('registerContextEngine 调用次数:', registeredEngineCount);
console.log('注册的引擎 id:', JSON.stringify(registeredEngines));

// ── registrationMode 假设 ──
console.log('\n=== lifecycle 假设 ===');
const startTime = Date.now();
console.log('如果 registrationMode === "full" → lifecycle = "runtime"（可被 adopt + resolve）');
console.log('如果 registrationMode === 其他(cli-metadata/discovery) → lifecycle = "readOnlyDiscovery"（resolve 时 fallback legacy）');