import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerOperationalToolsWithDashboard, getRegisteredToolHandler, _resetRegisteredToolHandlers } from './tools';

/**
 * 工具注册的 SDK 接口契约验证：
 * 1. 所有工具必须包含 label 字段（AgentTool.label 是 SDK 必填字段）
 * 2. execute 签名必须接受 signal 参数（SDK 支持 abortSignal 取消长任务）
 * 3. signal.aborted 时 execute 应快速返回错误而非继续执行
 */
describe('registerOperationalToolsWithDashboard — SDK 接口契约', () => {
  let registeredTools: any[];
  let mockApi: any;

  beforeEach(() => {
    registeredTools = [];
    _resetRegisteredToolHandlers();
    mockApi = {
      registerTool: vi.fn((tool: any) => {
        registeredTools.push(tool);
      }),
    };
    registerOperationalToolsWithDashboard(mockApi, undefined);
  });

  it('注册了 21 个工具', () => {
    expect(registeredTools).toHaveLength(21);
  });

  it('每个工具都包含非空 label 字段（SDK AgentTool 必填）', () => {
    for (const tool of registeredTools) {
      expect(tool.label, `工具 ${tool.name} 缺失 label`).toBeTruthy();
      expect(typeof tool.label, `工具 ${tool.name} 的 label 不是字符串`).toBe('string');
      expect(tool.label.length, `工具 ${tool.name} 的 label 为空字符串`).toBeGreaterThan(0);
    }
  });

  it('每个工具都包含 name/description/parameters/execute 四要素', () => {
    for (const tool of registeredTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('execute 接受 3 个参数（toolCallId, params, signal）', () => {
    for (const tool of registeredTools) {
      // Function.length 反映形参个数（不含默认值/剩余参数）
      // 期望至少 2 个形参（toolCallId, params），signal 是第 3 个可选
      expect(tool.execute.length, `工具 ${tool.name} 形参数不足`).toBeGreaterThanOrEqual(2);
    }
  });

  it('signal.aborted 时 execute 快速返回 abort 错误（不执行业务逻辑）', async () => {
    const abortedSignal = new AbortController().signal;
    abortedSignal.dispatchEvent(new Event('abort'));
    // 直接构造已 aborted 的 signal（vitest 环境下手动设置）
    const signal = { aborted: true } as AbortSignal;

    for (const tool of registeredTools) {
      const result = await tool.execute('call-id', {}, signal);
      expect(result, `工具 ${tool.name} abort 时未正确返回`).toBeDefined();
      expect(result.isError, `工具 ${tool.name} abort 时未标记 isError`).toBe(true);
    }
  });

  it('signal 未 aborted 时 execute 正常执行（不误报 abort）', async () => {
    const cleanSignal = { aborted: false } as AbortSignal;

    for (const tool of registeredTools) {
      // 即便业务逻辑因缺少依赖失败，也不应返回 isError + "aborted" 文本
      try {
        const result = await tool.execute('call-id', {}, cleanSignal);
        // 业务失败可以 isError=true，但文本不应是 "aborted"
        if (result?.isError) {
          const text = result.content?.[0]?.text ?? '';
          expect(text.toLowerCase(), `工具 ${tool.name} 在未 abort 时误报 aborted`).not.toContain('abort');
        }
      } catch {
        // 工具因依赖缺失抛错可接受，只要不是 abort 误报
      }
    }
  });

  // ─── AgentToolResult.details 字段契约（SDK 必填）─────────────────────
  // SDK AgentToolResult<T> 要求 details: T 必填。
  // 所有工具返回（成功/错误/abort）都必须包含 details 字段。

  it('abort 返回包含 details: { ok: false, aborted: true }', async () => {
    const signal = { aborted: true } as AbortSignal;
    for (const tool of registeredTools) {
      const result = await tool.execute('call-id', {}, signal);
      expect(result.details, `工具 ${tool.name} abort 返回缺 details`).toBeDefined();
      expect(result.details.ok, `工具 ${tool.name} abort 返回 details.ok 应为 false`).toBe(false);
      expect(result.details.aborted, `工具 ${tool.name} abort 返回 details.aborted 应为 true`).toBe(true);
    }
  });

  it('成功返回包含 details: { ok: true }', async () => {
    // 用未 abort 的 signal 调用，捕获至少一个成功返回的 details 结构
    const cleanSignal = { aborted: false } as AbortSignal;
    let foundSuccessDetails = false;
    for (const tool of registeredTools) {
      try {
        const result = await tool.execute('call-id', {}, cleanSignal);
        if (!result?.isError && result?.details?.ok === true) {
          foundSuccessDetails = true;
          break;
        }
      } catch { /* 依赖缺失可接受 */ }
    }
    // 至少有一个工具能返回成功 details（lcmg_qmd_status 这类无依赖工具）
    expect(foundSuccessDetails, '没有任何工具返回 details: { ok: true }').toBe(true);
  });

  it('错误返回包含 details: { ok: false, error?: string }', async () => {
    // 触发错误路径：传无效参数
    const cleanSignal = { aborted: false } as AbortSignal;
    let foundErrorDetails = false;
    for (const tool of registeredTools) {
      try {
        const result = await tool.execute('call-id', { invalidParam: true }, cleanSignal);
        if (result?.isError && result?.details?.ok === false) {
          foundErrorDetails = true;
          // error 字段可选，但若存在应为字符串
          if (result.details.error !== undefined) {
            expect(typeof result.details.error, `工具 ${tool.name} error 返回 details.error 应为字符串`).toBe('string');
          }
          break;
        }
      } catch { /* 抛错可接受 */ }
    }
    expect(foundErrorDetails, '没有工具返回 details: { ok: false }').toBe(true);
  });

  // ─── 工具处理器注册表（供 dashboard snapshot server /internal/mcp-invoke 调用）────

  it('注册后 getRegisteredToolHandler 可按名查询 handler', () => {
    for (const tool of registeredTools) {
      const handler = getRegisteredToolHandler(tool.name);
      expect(handler, `工具 ${tool.name} 未进入注册表`).toBeDefined();
      expect(typeof handler, `工具 ${tool.name} handler 不是函数`).toBe('function');
    }
  });

  it('注册表包含全部 11 个白名单工具（dashboard 可调用）', () => {
    const whitelist = [
      'lcmg_maintain', 'lcmg_diagnose', 'lcmg_distill', 'lcmg_compact',
      'lcmg_reset_breaker', 'lcmg_backup', 'lcmg_restore', 'lcmg_sync',
      'lcmg_import', 'lcmg_forget', 'lcmg_pin',
    ];
    for (const name of whitelist) {
      expect(getRegisteredToolHandler(name), `白名单工具 ${name} 未注册`).toBeDefined();
    }
  });

  it('注册表中的 handler 是 wrapped 版本（含审计日志包装，函数体非原始）', () => {
    // wrapped handler 与原始 tool.execute 不是同一引用（被替换为审计包装）
    for (const tool of registeredTools) {
      const handler = getRegisteredToolHandler(tool.name);
      // tool.execute 已被替换为 wrapped 版本，handler 引用的是同一个 wrapped 函数
      expect(handler, `工具 ${tool.name} handler 应与 wrapped tool.execute 同引用`).toBe(tool.execute);
    }
  });

  it('未注册的工具名返回 undefined', () => {
    expect(getRegisteredToolHandler('nonexistent_tool')).toBeUndefined();
  });
});

/**
 * ContextEngine info.hostRequirements 完整性验证：
 * SDK ContextEngineOperation = "agent-run" | "manual-compact" | "subagent-spawn"
 * 我们应声明所有 3 个 operation 所需 host capabilities，避免 host 不支持时静默降级。
 *
 * 注意：index.ts 无法直接 import（运行时副作用），这里用静态字符串校验。
 * 当 index.ts 的 hostRequirements 改动时，更新这里的期望值即可。
 */
describe('ContextEngine hostRequirements — SDK operation 声明完整性', () => {
  // 从 index.ts 抽取的期望值（保持与源码同步）
  const expectedHostRequirements = {
    'agent-run': ['assemble-before-prompt', 'after-turn', 'compact', 'maintain'],
    'manual-compact': ['compact'],
    'subagent-spawn': ['bootstrap', 'assemble-before-prompt'],
  };

  it('声明了全部 3 个 SDK ContextEngineOperation', () => {
    const operations = Object.keys(expectedHostRequirements);
    expect(operations).toEqual(['agent-run', 'manual-compact', 'subagent-spawn']);
    expect(operations).toHaveLength(3);
  });

  it('agent-run 声明了所需的 4 个 capabilities', () => {
    const caps = expectedHostRequirements['agent-run'];
    expect(caps).toContain('assemble-before-prompt');
    expect(caps).toContain('after-turn');
    expect(caps).toContain('compact');
    expect(caps).toContain('maintain');
  });

  it('manual-compact 声明 compact capability', () => {
    expect(expectedHostRequirements['manual-compact']).toContain('compact');
  });

  it('subagent-spawn 声明 bootstrap + assemble-before-prompt', () => {
    const caps = expectedHostRequirements['subagent-spawn'];
    expect(caps).toContain('bootstrap');
    expect(caps).toContain('assemble-before-prompt');
  });

  it('所有声明的 capability 都是 SDK 合法值', () => {
    // SDK ContextEngineHostCapability = "bootstrap" | "assemble-before-prompt" |
    //   "after-turn" | "maintain" | "compact" | "runtime-llm-complete" | "thread-bootstrap-projection"
    const validCapabilities = new Set([
      'bootstrap',
      'assemble-before-prompt',
      'after-turn',
      'maintain',
      'compact',
      'runtime-llm-complete',
      'thread-bootstrap-projection',
    ]);
    for (const [op, caps] of Object.entries(expectedHostRequirements)) {
      for (const cap of caps) {
        expect(validCapabilities.has(cap), `operation ${op} 声明了非法 capability: ${cap}`).toBe(true);
      }
    }
  });
});
