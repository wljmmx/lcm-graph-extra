// @vitest-environment happy-dom
/**
 * 前端组件测试：ExperienceView 挂载不报错 + 列表展示数据。
 *
 * - mock @tanstack/vue-query 的 useQuery / useMutation / useQueryClient
 * - stub EChart（避免 echarts canvas 渲染）
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
  const useMutation = vi.fn(() => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: ref(false),
  }));
  const useQueryClient = vi.fn(() => ({
    invalidateQueries: vi.fn(),
  }));
  return { useQuery, useMutation, useQueryClient, VueQueryPlugin: { install: () => {} } };
});

import { useQuery } from '@tanstack/vue-query';
import ExperienceView from '../../src/views/ExperienceView.vue';

const mockedUseQuery = vi.mocked(useQuery);

/** 构造一条 ExperienceItem 样例 */
function sampleItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    title: '测试经验标题',
    summary: '这是一条测试经验摘要',
    type: 'lesson',
    status: 'DISTILLED',
    state: null,
    relevanceScore: 0.85,
    qualityScore: 0.72,
    matchCount: 3,
    createdAt: 1700000000000,
    lastValidatedAt: 1700000001000,
    tags: {
      scenario: ['bug-fix'],
      techStack: ['frontend'],
      severity: 'major',
      free: ['tag1'],
    },
    projectName: 'demo',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认：所有 query 返回空数据（触发降级渲染）
  mockedUseQuery.mockReturnValue({
    data: ref(null),
    isLoading: ref(false),
    isError: ref(false),
  } as ReturnType<typeof useQuery>);
});

describe('ExperienceView', () => {
  it('空数据下能挂载并渲染标题（不报错）', () => {
    const wrapper = mount(ExperienceView, {
      global: { stubs: { EChart: true, QualityChart: true } },
    });
    expect(wrapper.text()).toContain('经验管理');
    // 默认无数据时显示提示
    expect(wrapper.text()).toContain('共 0 条');
  });

  it('列表查询返回数据时渲染表格内容', () => {
    // 按 queryKey 区分返回：list / detail / relations / history
    // ExperienceView 用 ComputedRef 作为 queryKey，需要先 unref
    mockedUseQuery.mockImplementation((opts: { queryKey?: unknown }) => {
      const rawKey = opts?.queryKey;
      const keyArr = isRef(rawKey) ? unref(rawKey as Ref<unknown>) : rawKey;
      const key = Array.isArray(keyArr) ? keyArr[0] : keyArr;
      if (key === 'experience-list') {
        return {
          data: ref({
            total: 1,
            items: [sampleItem()],
          }),
          isLoading: ref(false),
          isError: ref(false),
        } as ReturnType<typeof useQuery>;
      }
      if (key === 'experience-detail') {
        return {
          data: ref(null),
          isLoading: ref(false),
          isError: ref(false),
        } as ReturnType<typeof useQuery>;
      }
      if (key === 'experience-relations') {
        return {
          data: ref({ nodes: [], edges: [] }),
          isLoading: ref(false),
          isError: ref(false),
        } as ReturnType<typeof useQuery>;
      }
      if (key === 'quality-history') {
        return {
          data: ref({ points: [] }),
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

    const wrapper = mount(ExperienceView, {
      global: { stubs: { EChart: true, QualityChart: true } },
    });
    // 总数显示
    expect(wrapper.text()).toContain('共 1 条');
    // 表格内出现样例标题
    expect(wrapper.text()).toContain('测试经验标题');
  });

  it('渲染过滤侧栏（状态/类型/项目名等表单项）', () => {
    const wrapper = mount(ExperienceView, {
      global: { stubs: { EChart: true, QualityChart: true } },
    });
    // NForm 标签
    expect(wrapper.text()).toContain('状态');
    expect(wrapper.text()).toContain('类型');
    expect(wrapper.text()).toContain('项目名');
    expect(wrapper.text()).toContain('应用');
    expect(wrapper.text()).toContain('重置');
  });
});
