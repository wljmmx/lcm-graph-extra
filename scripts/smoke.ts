/**
 * v1.1-8: onboarding 冒烟脚本 —— 一键验证插件可加载、可注册、可 assemble。
 *
 * 用法：npm run smoke
 *
 * 验证项：
 *   1. TypeScript 编译通过（tsc --noEmit）
 *   2. 插件入口导出 default，包含 id/name/description/configSchema/register
 *   3. register(mockApi) 可被调用，注册 ContextEngine 并返回包含 assemble/dispose/heartbeat 的对象
 *   4. assemble({ messages: [] }) 在无后端依赖时返回有效降级响应（degraded=true 但不抛错）
 *   5. dispose() 可被调用而不抛错
 *
 * 退出码：0=全部通过，1=有失败项
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

interface StepResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: StepResult[] = [];

async function step(name: string, fn: () => void | string | Promise<void | string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : undefined });
    console.log(`  \u2713 ${name}${typeof detail === 'string' ? ` — ${detail}` : ''}`);
  } catch (e: any) {
    results.push({ name, ok: false, detail: e?.message ?? String(e) });
    console.log(`  \u2717 ${name} — ${e?.message ?? String(e)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main(): Promise<void> {
  console.log('===================================');
  console.log(' lcm-graph-extra Smoke Test');
  console.log('===================================');
  console.log(`Node: ${process.version}`);
  console.log(`Repo: ${repoRoot}`);
  console.log('');

  // ── Step 1: typecheck ────────────────────────────────────────────────
  console.log('[1/5] TypeScript 编译检查 (tsc --noEmit)');
  const tsc = spawnSync('npx', ['tsc', '--noEmit'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  await step('tsc --noEmit 退出码 0', () => {
    if (tsc.status !== 0) {
      const stderr = (tsc.stderr || tsc.stdout || '').slice(0, 500);
      throw new Error(`tsc 失败 (exit=${tsc.status}): ${stderr}`);
    }
  });
  console.log('');

  // ── Step 2: 加载插件入口 ─────────────────────────────────────────────
  console.log('[2/5] 加载插件入口 + 验证 API 表面');
  const entryUrl = new URL('../src/index.ts', import.meta.url);
  const mod = await import(entryUrl.href);
  const pluginEntry = mod.default;
  await step('default export 存在', () => {
    assert(pluginEntry, 'default export 为 undefined');
  });
  await step('id === "lcm-graph-extra"', () => {
    assert(pluginEntry?.id === 'lcm-graph-extra', `id=${pluginEntry?.id}`);
  });
  await step('name 为非空字符串', () => {
    assert(typeof pluginEntry?.name === 'string' && pluginEntry.name.length > 0, `name=${pluginEntry?.name}`);
  });
  await step('description 为非空字符串', () => {
    assert(typeof pluginEntry?.description === 'string' && pluginEntry.description.length > 0);
  });
  await step('configSchema 为对象', () => {
    assert(typeof pluginEntry?.configSchema === 'object' && pluginEntry.configSchema !== null);
  });
  await step('register 为函数', () => {
    assert(typeof pluginEntry?.register === 'function');
  });
  console.log('');

  // ── Step 3: 注册 ContextEngine ────────────────────────────────────────
  console.log('[3/5] register(mockApi) 注册 ContextEngine');
  let registeredEngine: any = null;
  const mockApi = {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => mockApi.logger,
    },
    pluginConfig: {
      // 极简配置：禁用所有外部依赖（neo4j/qmd/lcm 都不会被实际访问）
      retrieval: { qmd: { enabled: false }, limits: { qmd: 5 } },
      lcmMonitor: { dedupRounds: 1 },
      dashboardSnapshot: { enabled: false },
      embedding: { enabled: false },
    },
    config: { workspace: repoRoot },
    registerContextEngine: (_id: string, factory: () => any) => {
      registeredEngine = factory();
    },
    registerTool: () => {},
    hooks: {
      on: () => {},
      emit: () => {},
    },
    lifecycle: {
      on: () => {},
    },
  };
  await step('register(mockApi) 不抛错', () => {
    pluginEntry.register(mockApi);
  });
  await step('ContextEngine 已注册', () => {
    assert(registeredEngine, 'registerContextEngine 未被调用或 factory 返回空');
  });
  await step('engine.info.id === "lcm-graph-extra"', () => {
    assert(registeredEngine?.info?.id === 'lcm-graph-extra', `info.id=${registeredEngine?.info?.id}`);
  });
  await step('engine.assemble 为函数', () => {
    assert(typeof registeredEngine?.assemble === 'function');
  });
  await step('engine.dispose 为函数', () => {
    assert(typeof registeredEngine?.dispose === 'function');
  });
  console.log('');

  // ── Step 4: assemble 降级路径 ─────────────────────────────────────────
  console.log('[4/5] assemble({ messages: [] }) 降级响应');
  let assembleResult: any = null;
  await step('assemble 返回有效对象', async () => {
    assembleResult = await registeredEngine.assemble({
      messages: [],
      sessionId: 'smoke-test-session',
      sessionKey: 'smoke',
      sessionFile: '/tmp/smoke.json',
      tools: [],
      operation: 'agent-run',
      runtimeSettings: {},
    });
    assert(assembleResult && typeof assembleResult === 'object', '返回值不是对象');
    assert(Array.isArray(assembleResult.messages), 'messages 不是数组');
  });
  await step('响应包含 degraded 字段', () => {
    assert(typeof assembleResult?.degraded === 'boolean', `degraded=${assembleResult?.degraded}`);
  });
  await step('降级时 degradedReasons 为数组', () => {
    if (assembleResult?.degraded) {
      assert(Array.isArray(assembleResult.degradedReasons), 'degraded=true 但 degradedReasons 不是数组');
    }
  });
  console.log('');

  // ── Step 5: dispose ───────────────────────────────────────────────────
  console.log('[5/5] dispose() 清理');
  await step('dispose() 不抛错（允许 5s 超时）', async () => {
    const disposePromise = Promise.resolve(registeredEngine.dispose());
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('dispose 超时 5s')), 5000));
    await Promise.race([disposePromise, timeout]);
  });
  console.log('');

  // ── 汇总 ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('===================================');
  console.log(` Smoke 结果: ${passed} passed, ${failed} failed`);
  console.log('===================================');
  if (failed > 0) {
    console.log('');
    console.log('失败项详情：');
    results.filter((r) => !r.ok).forEach((r) => {
      console.log(`  - ${r.name}: ${r.detail}`);
    });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Smoke test 抛出未捕获异常：', e);
  process.exit(1);
});
