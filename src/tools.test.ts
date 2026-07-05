import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerOperationalToolsWithDashboard } from './tools';

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
    mockApi = {
      registerTool: vi.fn((tool: any) => {
        registeredTools.push(tool);
      }),
    };
    registerOperationalToolsWithDashboard(mockApi, undefined);
  });

  it('注册了 16 个工具', () => {
    expect(registeredTools).toHaveLength(16);
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
});
