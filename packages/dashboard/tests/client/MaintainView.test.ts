// @vitest-environment happy-dom
/**
 * 前端组件测试：MaintainView（模块 4）。
 *
 * - mock @tanstack/vue-query 的 useMutation，使其同步执行 mutationFn
 *   并触发 onMutate / onSuccess / onError 回调，验证日志记录
 * - mock ../../src/api/experience 的 invokeMcpTool，验证 9 张卡片
 *   调用对应工具
 * - 补 happy-dom 缺失的 matchMedia / ResizeObserver polyfill
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';
import { NMessageProvider, NConfigProvider, zhCN, dateZhCN } from 'naive-ui';

// happy-dom 缺失 matchMedia（naive-ui 响应式 grid 需要）
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// happy-dom 缺失 ResizeObserver（naive-ui / vue-echarts 可能用到）
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// ===== 用 vi.hoisted 提升 mock 引用，避免 vi.mock 工厂 hoisting 后引用未初始化变量 =====
const { invokeMcpToolMock } = vi.hoisted(() => ({
  invokeMcpToolMock: vi.fn(
    async (tool: string, _params: Record<string, unknown>) => ({
      ok: true,
      result: { tool, mock: true },
    }),
  ),
}));

// ===== mock @tanstack/vue-query：useMutation 同步执行 mutationFn =====
// 测试需要 mutate() 实际触发 onMutate → mutationFn → onSuccess 链路，
// 才能验证日志记录与 invokeMcpTool 调用。
vi.mock('@tanstack/vue-query', async () => {
  const { ref } = await import('vue');
  const useMutation = vi.fn((opts: {
    mutationFn?: (vars: unknown) => Promise<unknown>;
    onMutate?: (vars: unknown) => void;
    onSuccess?: (data: unknown, vars: unknown) => void;
    onError?: (err: unknown, vars: unknown) => void;
  }) => {
    return {
      mutate: (vars: unknown) => {
        if (opts.onMutate) opts.onMutate(vars);
        Promise.resolve(opts.mutationFn ? opts.mutationFn(vars) : Promise.resolve())
          .then(
            (data) => { if (opts.onSuccess) opts.onSuccess(data, vars); },
            (err) => { if (opts.onError) opts.onError(err, vars); },
          );
      },
      mutateAsync: vi.fn(),
      isPending: ref(false),
      isError: ref(false),
      error: ref<unknown>(null),
    };
  });
  return { useMutation, VueQueryPlugin: { install: () => {} } };
});

// ===== mock ../../src/api/experience：捕获 invokeMcpTool 调用 =====
vi.mock('../../src/api/experience', () => ({
  invokeMcpTool: invokeMcpToolMock,
}));

import MaintainView from '../../src/views/MaintainView.vue';

/**
 * 用全局 Provider 包裹挂载 MaintainView。
 *
 * CapabilityProfileSwitch 在 setup 中调用 useMessage()，必须在
 * NMessageProvider 后代中挂载，否则抛出 "No provider" 运行时错误。
 * NConfigProvider 提供 locale，避免 naive-ui 控制台告警。
 */
function mountView() {
  const Parent = defineComponent({
    components: { NConfigProvider, NMessageProvider, MaintainView },
    render() {
      return h(NConfigProvider, { locale: zhCN, dateLocale: dateZhCN }, () =>
        h(NMessageProvider, () => h(MaintainView)),
      );
    },
  });
  return mount(Parent);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MaintainView', () => {
  it('挂载并渲染 9 张操作卡片标题', () => {
    const wrapper = mountView();
    const text = wrapper.text();
    // 9 张卡片标题
    expect(text).toContain('图谱维护');
    expect(text).toContain('触发蒸馏');
    expect(text).toContain('触发 compact');
    expect(text).toContain('重置熔断器');
    expect(text).toContain('TTL 清理');
    expect(text).toContain('备份');
    expect(text).toContain('恢复');
    expect(text).toContain('同步修复');
    expect(text).toContain('历史导入');
    // 日志区
    expect(text).toContain('操作日志');
    // 初始空日志
    expect(text).toContain('暂无操作记录');
  });

  it('点击 distill 卡片执行按钮（confirmLevel=0）触发 invokeMcpTool', async () => {
    const wrapper = mountView();
    // distill 卡片：confirmLevel=0，按钮直接触发 execute
    // 通过标题定位卡片，再找其内部"执行"按钮
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const distillCard = cards.find((c) => c.props('title') === '触发蒸馏');
    expect(distillCard).toBeTruthy();
    // 直接 emit execute 事件（绕过按钮点击，因为 naive-ui 按钮事件链复杂）
    distillCard!.vm.$emit('execute');
    await flushPromises();
    // invokeMcpTool 应被调用，参数为 lcmg_distill
    expect(invokeMcpToolMock).toHaveBeenCalledWith('lcmg_distill', expect.objectContaining({ limit: 50 }));
  });

  it('点击 backup 卡片执行按钮触发 invokeMcpTool', async () => {
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const backupCard = cards.find((c) => c.props('title') === '备份');
    expect(backupCard).toBeTruthy();
    backupCard!.vm.$emit('execute');
    await flushPromises();
    expect(invokeMcpToolMock).toHaveBeenCalledWith('lcmg_backup', expect.objectContaining({ outputPath: expect.any(String) }));
  });

  it('点击 maintain 卡片执行按钮触发 lcmg_maintain', async () => {
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const maintainCard = cards.find((c) => c.props('title') === '图谱维护');
    expect(maintainCard).toBeTruthy();
    maintainCard!.vm.$emit('execute');
    await flushPromises();
    expect(invokeMcpToolMock).toHaveBeenCalledWith('lcmg_maintain', {});
  });

  it('点击 ttl_cleanup 卡片也调用 lcmg_maintain（复用工具）', async () => {
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const ttlCard = cards.find((c) => c.props('title') === 'TTL 清理');
    expect(ttlCard).toBeTruthy();
    ttlCard!.vm.$emit('execute');
    await flushPromises();
    expect(invokeMcpToolMock).toHaveBeenCalledWith('lcmg_maintain', {});
  });

  it('点击 restore 卡片执行按钮传递 dryRun=true（默认）+ 三次确认级别', async () => {
    const wrapper = mountView();
    // 设置有效的备份路径（~/.openclaw 之下，通过路径校验）
    const restoreInput = wrapper.find('input[placeholder*="memory-full-backup"]');
    await restoreInput.setValue('~/.openclaw/backup-test.json');
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const restoreCard = cards.find((c) => c.props('title') === '恢复');
    expect(restoreCard).toBeTruthy();
    // 验证 confirmLevel=2 + danger
    expect(restoreCard!.props('confirmLevel')).toBe(2);
    expect(restoreCard!.props('danger')).toBe(true);
    // 触发执行
    restoreCard!.vm.$emit('execute');
    await flushPromises();
    expect(invokeMcpToolMock).toHaveBeenCalledWith(
      'lcmg_restore',
      expect.objectContaining({ dryRun: true, targets: 'all' }),
    );
  });

  it('点击 reset_breaker 卡片传递 name 参数', async () => {
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const card = cards.find((c) => c.props('title') === '重置熔断器');
    expect(card).toBeTruthy();
    expect(card!.props('danger')).toBe(true);
    expect(card!.props('confirmLevel')).toBe(1);
    card!.vm.$emit('execute');
    await flushPromises();
    expect(invokeMcpToolMock).toHaveBeenCalledWith(
      'lcmg_reset_breaker',
      expect.objectContaining({ name: 'lcm' }),
    );
  });

  it('点击 import 卡片传递 source + limit', async () => {
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const card = cards.find((c) => c.props('title') === '历史导入');
    expect(card).toBeTruthy();
    card!.vm.$emit('execute');
    await flushPromises();
    expect(invokeMcpToolMock).toHaveBeenCalledWith(
      'lcmg_import',
      expect.objectContaining({ source: 'all', limit: 100 }),
    );
  });

  it('点击 compact 卡片传递空 params（conversationId 留空）', async () => {
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const card = cards.find((c) => c.props('title') === '触发 compact');
    expect(card).toBeTruthy();
    card!.vm.$emit('execute');
    await flushPromises();
    // conversationId 留空时不传该字段
    expect(invokeMcpToolMock).toHaveBeenCalledWith('lcmg_compact', {});
  });

  it('点击 sync 卡片默认 mode=check 不视为 danger', async () => {
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const card = cards.find((c) => c.props('title') === '同步修复');
    expect(card).toBeTruthy();
    // 默认 mode=check：confirmLevel=0, danger=false
    expect(card!.props('confirmLevel')).toBe(0);
    expect(card!.props('danger')).toBe(false);
    card!.vm.$emit('execute');
    await flushPromises();
    expect(invokeMcpToolMock).toHaveBeenCalledWith(
      'lcmg_sync',
      expect.objectContaining({ mode: 'check', dryRun: true }),
    );
  });

  it('执行后日志区出现成功记录', async () => {
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const distillCard = cards.find((c) => c.props('title') === '触发蒸馏');
    distillCard!.vm.$emit('execute');
    await flushPromises();
    // 日志区出现 lcmg_distill 工具名 + 成功 tag
    const text = wrapper.text();
    expect(text).toContain('lcmg_distill');
    expect(text).toContain('成功');
    // "暂无操作记录" 应消失
    expect(text).not.toContain('暂无操作记录');
  });

  it('invokeMcpTool 返回 ok=false 时日志记录失败', async () => {
    invokeMcpToolMock.mockResolvedValueOnce({ ok: false, error: 'mock 失败' });
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const distillCard = cards.find((c) => c.props('title') === '触发蒸馏');
    distillCard!.vm.$emit('execute');
    await flushPromises();
    // "失败"状态 tag 在日志区直接展示
    expect(wrapper.text()).toContain('失败');
    // 错误详情在 NCollapse 内（默认折叠），检查 HTML 是否包含错误文本
    expect(wrapper.html()).toContain('mock 失败');
  });

  it('invokeMcpTool 抛异常时日志记录 error', async () => {
    invokeMcpToolMock.mockRejectedValueOnce(new Error('网络错误'));
    const wrapper = mountView();
    const cards = wrapper.findAllComponents({ name: 'OperationCard' });
    const distillCard = cards.find((c) => c.props('title') === '触发蒸馏');
    distillCard!.vm.$emit('execute');
    await flushPromises();
    expect(wrapper.text()).toContain('失败');
    expect(wrapper.html()).toContain('网络错误');
  });
});
