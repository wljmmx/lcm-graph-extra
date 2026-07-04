// @vitest-environment happy-dom
/**
 * 前端组件测试：MonitorView 挂载不报错（MVP 阶段保证渲染）。
 *
 * - mock @tanstack/vue-query 的 useQuery，避免真实网络请求
 * - stub EChart 组件，避免 echarts canvas 渲染
 * - 补 happy-dom 缺失的 matchMedia / ResizeObserver polyfill
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

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
import MonitorView from '../../src/views/MonitorView.vue';

const mockedUseQuery = vi.mocked(useQuery);

/** 完整 HealthSnapshot 样例 */
function sampleDb() {
  return {
    timestamp: Date.now(),
    pendingMessages: 5,
    summaryFragments: 2,
    maxTokenRatio: 0.3,
    cbLcmAvailable: true,
    cbQmdAvailable: true,
    cbNeo4jAvailable: false,
    cbLcmFailures: 0,
    cbQmdFailures: 0,
    cbNeo4jFailures: 3,
    lastAssembleMs: 100,
    lastL2Ms: 10,
    lastL3Ms: 20,
    lastL4Ms: 30,
    pendingExperienceCount: 1,
    distilledExperienceCount: 2,
    tierLow: 5,
    tierMedium: 3,
    tierHigh: 1,
  };
}

/** 完整 DashboardSnapshot 样例 */
function sampleMemory() {
  return {
    cascade: {
      armsCount: 3,
      topArms: [
        { armKey: 'arm-1', alpha: 2, beta: 5, sample: 7 },
      ],
      confidenceThreshold: 0.5,
    },
    userProfile: {
      techStack: [{ name: 'vue', weight: 0.8 }],
      scenario: [{ name: 'debug', weight: 0.4 }],
      language: 'zh' as const,
    },
    graphAdapter: { connected: true, connectFailed: false },
    debt: { running: 1, pendingCount: 2, pollIntervalMs: 1000, maxConcurrent: 4 },
    retrieval: { lastQuery: 'q', perfSummary: 'fast' },
    health: { latest: null },
    timestamp: Date.now(),
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

describe('MonitorView', () => {
  it('空数据下能挂载并渲染标题与降级提示（不报错）', () => {
    const wrapper = mount(MonitorView, {
      global: { stubs: { EChart: true } },
    });
    expect(wrapper.text()).toContain('性能监控');
    // memory 为 null → 显示"插件未响应"
    expect(wrapper.text()).toContain('插件未响应');
  });

  it('有数据时渲染 KPI 标签与熔断状态', () => {
    // 按 queryKey 区分返回：latest / history / agent
    mockedUseQuery.mockImplementation((opts: { queryKey?: string[] }) => {
      const key = opts?.queryKey?.[0];
      if (key === 'health-latest') {
        return {
          data: ref({ db: sampleDb(), memory: sampleMemory() }),
          isLoading: ref(false),
          isError: ref(false),
        } as ReturnType<typeof useQuery>;
      }
      if (key === 'health-history') {
        return {
          data: ref({ snapshots: [sampleDb()] }),
          isLoading: ref(false),
          isError: ref(false),
        } as ReturnType<typeof useQuery>;
      }
      if (key === 'agent-status') {
        return {
          data: ref({ online: true }),
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

    const wrapper = mount(MonitorView, {
      global: { stubs: { EChart: true } },
    });
    // KPI 标签
    expect(wrapper.text()).toContain('待处理消息');
    expect(wrapper.text()).toContain('熔断状态');
    // 熔断面板标题
    expect(wrapper.text()).toContain('Cascade');
  });
});
