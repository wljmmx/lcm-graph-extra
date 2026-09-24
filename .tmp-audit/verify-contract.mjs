/**
 * Contract verification for lcm-graph-extra against OpenClaw SDK 2026.9.6.
 * Loads the built dist entry, mocks the plugin API, then validates:
 *  - ContextEngine.info fields against ContextEngineInfo
 *  - required/optional ContextEngine methods
 *  - acceptedHostParams subset of CONTEXT_ENGINE_HOST_PARAMS
 *  - hostRequirements capabilities subset of ContextEngineHostCapability
 *  - registered tools against ToolDefinition shape
 *  - manifest contracts.tools vs runtime-registered tool names
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ALLOWED_HOST_PARAMS = new Set(['sessionKey', 'prompt', 'runtimeSettings', 'sessionTarget', 'runtimeContext', 'abortSignal']);
const ALLOWED_CAPABILITY = new Set(['bootstrap', 'assemble-before-prompt', 'after-turn', 'maintain', 'compact', 'runtime-llm-complete', 'thread-bootstrap-projection']);
const ALLOWED_OPS = new Set(['agent-run', 'manual-compact', 'subagent-spawn']);
const profiles = new Set(['minimal', 'coding', 'messaging', 'full']);

const problems = [];
const notes = [];
function check(cond, msg) { if (cond) notes.push('PASS ' + msg); else problems.push('FAIL ' + msg); }

async function main() {
  const mod = require('/workspace/dist/index.js');
  const entry = mod.default ?? mod;
  check(entry && typeof entry === 'object', 'entry exported');
  check(typeof entry.id === 'string' && entry.id.length > 0, 'entry.id present: ' + entry.id);
  check(typeof entry.register === 'function', 'entry.register is function');
  check(entry.kind === 'context-engine' || (Array.isArray(entry.kind) && entry.kind.includes('context-engine')), 'entry.kind=context-engine');

  let engine = null;
  let engineId = null;
  const tools = [];
  const hooks = [];
  const api = {
    id: 'lcm-graph-extra', name: 'LCM Graph Extra', version: '2.1.13', source: 'test',
    registrationMode: 'full',
    config: {},
    pluginConfig: {},
    runtime: {},
    logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {}, child() { return this; } },
    registerContextEngine: (id, factory) => { engineId = id; engine = factory({}); },
    registerTool: (tool) => { tools.push(tool); },
    registerHook: () => {}, registerHttpRoute: () => {}, registerGatewayMethod: () => {},
    registerCommand: () => {}, registerChannel: () => {}, registerProvider: () => {},
    on: (...a) => { hooks.push(a); }, emit: () => {},
    hooks: { on() {}, emit() {} },
    lifecycle: { on() {} },
    session: {}, agent: {}, runContext: {}, registerToolMetadata: () => {},
  };

  entry.register(api);

  // ---- ContextEngine ----
  check(engineId === 'lcm-graph-extra', 'registerContextEngine id = lcm-graph-extra (got ' + engineId + ')');
  check(engine != null, 'engine factory returned engine');
  if (!engine) return finish();
  const info = engine.info;
  check(info && typeof info === 'object', 'engine.info present');
  check(info.id === 'lcm-graph-extra', 'info.id = lcm-graph-extra');
  check(typeof info.name === 'string' && info.name.length, 'info.name present');
  check(info.version === '2.1.13', 'info.version = 2.1.13 (got ' + info.version + ')');
  check(info.ownsCompaction === true, 'info.ownsCompaction boolean');
  check(info.turnMaintenanceMode === undefined || info.turnMaintenanceMode === 'foreground' || info.turnMaintenanceMode === 'background', 'turnMaintenanceMode valid: ' + info.turnMaintenanceMode);

  if (Array.isArray(info.acceptedHostParams)) {
    const bad = info.acceptedHostParams.filter((p) => !ALLOWED_HOST_PARAMS.has(p));
    check(bad.length === 0, 'acceptedHostParams all valid keys (bad=' + JSON.stringify(bad) + ')');
  } else {
    check(false, 'acceptedHostParams is array');
  }

  const ts = info.transcriptSemantics || {};
  check(ts.currentTurnFence === undefined || ts.currentTurnFence === 'before-current-turn-entry-v1', 'currentTurnFence value valid');
  check(ts.turnAdvancementIdempotency === undefined || ts.turnAdvancementIdempotency === 'atomic-idempotent-v1', 'turnAdvancementIdempotency value valid');

  if (info.hostRequirements) {
    for (const [op, req] of Object.entries(info.hostRequirements)) {
      check(ALLOWED_OPS.has(op), 'hostRequirements op valid: ' + op);
      const bad = (req.requiredCapabilities || []).filter((c) => !ALLOWED_CAPABILITY.has(c));
      check(bad.length === 0, 'hostRequirements[' + op + '] capabilities valid (bad=' + JSON.stringify(bad) + ')');
    }
  }

  // required methods
  for (const m of ['ingest', 'assemble', 'compact']) {
    check(typeof engine[m] === 'function', 'required method present: ' + m);
  }
  // optional methods present (informational)
  const optionalPresent = ['bootstrap', 'maintain', 'ingestBatch', 'afterTurn', 'commitTurn', 'dispose'].filter((m) => typeof engine[m] === 'function');
  notes.push('INFO optional methods implemented: ' + optionalPresent.join(', '));
  const optionalAbsent = ['prepareSubagentSpawn', 'onSubagentEnded'].filter((m) => typeof engine[m] !== 'function');
  notes.push('INFO optional methods not implemented: ' + optionalAbsent.join(', '));

  // ---- tools ----
  check(tools.length > 0, 'tools registered count=' + tools.length);
  for (const t of tools) {
    const ok = typeof t.name === 'string' && t.name.length
      && typeof t.label === 'string' && t.label.length
      && typeof t.description === 'string' && t.description.length
      && t.parameters && typeof t.parameters === 'object'
      && typeof t.execute === 'function';
    check(ok, 'tool shape ok: ' + (t.name || '<noname>'));
  }
  const toolNames = tools.map((t) => t.name).sort();
  notes.push('INFO registered tools (' + toolNames.length + '): ' + toolNames.join(', '));

  // manifest contracts.tools vs runtime
  const manifest = JSON.parse(readFileSync('/workspace/openclaw.plugin.json', 'utf8'));
  const declared = new Set((manifest.contracts?.tools) || []);
  const registered = new Set(toolNames);
  const declaredNotRegistered = [...declared].filter((n) => !registered.has(n));
  const registeredNotDeclared = [...registered].filter((n) => !declared.has(n));
  check(declaredNotRegistered.length === 0, 'all manifest contracts.tools registered at runtime (missing=' + JSON.stringify(declaredNotRegistered) + ')');
  check(registeredNotDeclared.length === 0, 'all runtime tools declared in manifest (extra=' + JSON.stringify(registeredNotDeclared) + ')');

  // version consistency
  const pkg = JSON.parse(readFileSync('/workspace/package.json', 'utf8'));
  check(pkg.version === manifest.version, 'package.json version == manifest version (' + pkg.version + ' vs ' + manifest.version + ')');
  check(mod.VERSION === pkg.version, 'exported VERSION == package.json version (' + mod.VERSION + ' vs ' + pkg.version + ')');

  // hooks
  notes.push('INFO hooks registered via api.on: ' + JSON.stringify(hooks.map((h) => h[0])));

  return finish();
}

function finish() {
  console.log('\n===== NOTES =====');
  for (const n of notes) console.log(n);
  console.log('\n===== PROBLEMS =====');
  if (problems.length === 0) console.log('(none)');
  for (const p of problems) console.log(p);
  console.log('\nTOTAL: ' + notes.filter((n) => n.startsWith('PASS')).length + ' pass, ' + problems.length + ' fail');
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(2); });