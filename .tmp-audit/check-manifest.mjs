import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('/workspace/node_modules/openclaw/dist/manifest-DHkEL08H.mjs');
const loadPluginManifest = mod.r;

const res = await loadPluginManifest('/workspace', false);
if (!res.ok) { console.log('FAIL', res.error); process.exit(1); }
const m = res.manifest;
console.log('=== manifest loaded ===');
console.log('id:', m.id);
console.log('kind:', m.kind);
console.log('name:', m.name);
console.log('version:', m.version);
console.log('requiresPlugins:', JSON.stringify(m.requiresPlugins));
console.log('activation:', JSON.stringify(m.activation));
console.log('contracts:', JSON.stringify(m.contracts));
console.log('toolMetadata keys:', m.toolMetadata ? Object.keys(m.toolMetadata) : 'undefined');
console.log('toolMetadata sample:', JSON.stringify(m.toolMetadata && m.toolMetadata.lcmg_search));
console.log('has configSchema:', !!m.configSchema);
console.log('uiHints keys:', m.uiHints ? Object.keys(m.uiHints) : 'undefined');
console.log('diagnostics:', JSON.stringify(res.diagnostics ?? []));