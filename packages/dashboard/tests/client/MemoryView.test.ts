// @vitest-environment happy-dom
/**
 * 前端组件测试：MemoryView 挂载不报错 + 搜索栏展示。
 *
 * - mock @tanstack/vue-query 的 useQuery，避免真实网络请求
 * - stub EChart 组件，避免 echarts canvas 渲染
 * - 补 happy-dom 缺失的 matchMedia / ResizeObserver polyfill
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, isRef, unref, type Ref } from 'vue';

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

// mock @tanstack/vue-query：动态 import vue 避免 hoisting 问题
vi.mock('@tanstack/vue-query', async () => {
  const { ref } = await import('vue');
  const useQuery = vi.fn(() => ({
    data: ref(null),
    isLoading: ref(false),
    isError: ref(false),
  }));
  return { useQuery, VueQueryPlugin: { install: () => {} } };
});

import { useQuery } from '@tanstack/vue-query';
import MemoryView from '../../src/views/MemoryView.vue';

const mockedUseQuery = vi.mocked(useQuery);

beforeEach(() => {
  vi.clearAllMocks();
  // 默认：所有 query 返回空数据（触发降级渲染）
  mockedUseQuery.mockReturnValue({
    data: ref(null),
    isLoading: ref(false),
    isError: ref(false),
  } as ReturnType<typeof useQuery>);
});

describe('MemoryView', () => {
  it('空数据下能挂载并渲染标题（不报错）', () => {
    const wrapper = mount(MemoryView, {
      global: { stubs: { EChart: true } },
    });
    expect(wrapper.text()).toContain('记忆查询');
  });

  it('搜索栏展示（包含搜索按钮、引擎选择、Tab）', () => {
    const wrapper = mount(MemoryView, {
      global: { stubs: { EChart: true } },
    });
    // 搜索按钮
    expect(wrapper.text()).toContain('搜索');
    // 双 Tab
    expect(wrapper.text()).toContain('列表');
    expect(wrapper.text()).toContain('图谱');
  });

  it('空查询时列表 Tab 显示提示（请输入搜索词）', () => {
    const wrapper = mount(MemoryView, {
      global: { stubs: { EChart: true } },
    });
    expect(wrapper.text()).toContain('请输入搜索词');
  });

  it('搜索返回数据时列表展示结果内容', () => {
    // 按 queryKey 区分返回：memory-search / memory-graph
    mockedUseQuery.mockImplementation((opts: { queryKey?: unknown }) => {
      const rawKey = opts?.queryKey;
      const keyArr = isRef(rawKey) ? unref(rawKey as Ref<unknown>) : rawKey;
      const key = Array.isArray(keyArr) ? keyArr[0] : key;
      if (key === 'memory-search') {
        return {
          data: ref({
            total: 2,
            results: {
              lcm: [
                { source: 'lcm', content: 'LCM 测试内容', sessionId: '1', score: 1.0 },
              ],
              qmd: [
                { source: 'qmd', content: 'QMD 文档标题', file: 'a.ts', score: 0.9 },
              ],
              neo4j: [],
            },
          }),
          isLoading: ref(false),
          isError: ref(false),
        } as ReturnType<typeof useQuery>;
      }
      if (key === 'memory-graph') {
        return {
          data: ref({ nodes: [], edges: [] }),
          isLoading: ref(false),
          isError: ref(false),
        } as ReturnType<typeof useQuery>;
      }
      return {
        data: ref(null),
        isLoading: ref(false),
        isError: ref(false),
      } as ReturnType<typeof useQuery>;
    });

    const wrapper = mount(MemoryView, {
      global: { stubs: { EChart: true } },
    });
    // 列表分组展示
    expect(wrapper.text()).toContain('LCM 测试内容');
  });
});
