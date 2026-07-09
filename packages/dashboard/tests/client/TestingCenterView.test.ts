// @vitest-environment happy-dom
/**
 * 前端组件测试：TestingCenterView（测试中心整合页 v2.3.2）。
 *
 * - mock vue-router 的 useRoute / useRouter
 * - stub BenchmarkView / QmdTestView 子组件（避免它们的复杂网络依赖）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

// happy-dom 缺失 matchMedia（naive-ui 响应式需要）
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

const routeRef = ref<{ query: { tab?: string } }>({ query: {} });
const replaceMock = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => routeRef.value,
  useRouter: () => ({ replace: replaceMock }),
}));

import TestingCenterView from '../../src/views/TestingCenterView.vue';

beforeEach(() => {
  vi.clearAllMocks();
  routeRef.value = { query: {} };
});

describe('TestingCenterView', () => {
  it('无 query 时默认 tab 为 benchmark', () => {
    const wrapper = mount(TestingCenterView, {
      global: {
        stubs: {
          BenchmarkView: { template: '<div class="stub-benchmark" />' },
          QmdTestView: { template: '<div class="stub-qmd" />' },
        },
      },
    });
    expect(wrapper.text()).toContain('测试中心');
    // 默认渲染 benchmark tab 内容
    expect(wrapper.find('.stub-benchmark').exists()).toBe(true);
    expect(wrapper.find('.stub-qmd').exists()).toBe(false);
  });

  it('query.tab=qmd-test 时默认 tab 为 qmd-test', async () => {
    routeRef.value = { query: { tab: 'qmd-test' } };
    const wrapper = mount(TestingCenterView, {
      global: {
        stubs: {
          BenchmarkView: { template: '<div class="stub-benchmark" />' },
          QmdTestView: { template: '<div class="stub-qmd" />' },
        },
      },
    });
    // 等 onMounted 执行
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.stub-qmd').exists()).toBe(true);
    expect(wrapper.find('.stub-benchmark').exists()).toBe(false);
  });

  it('渲染两个 tab 标题（CE 引擎压测 / QMD MCP 测试）', () => {
    const wrapper = mount(TestingCenterView, {
      global: {
        stubs: {
          BenchmarkView: { template: '<div />' },
          QmdTestView: { template: '<div />' },
        },
      },
    });
    const text = wrapper.text();
    expect(text).toContain('CE 引擎压测');
    expect(text).toContain('QMD MCP 测试');
  });
});
