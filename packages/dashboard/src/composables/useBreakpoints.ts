/**
 * useBreakpoints —— 轻量响应式断点 composable。
 *
 * naive-ui 未导出 useBreakpoints，@vueuse/core 未安装，故本地实现。
 * 仅实现 .smaller(key)：返回 Ref<boolean>，true 表示视口宽度 < 该断点 minWidth。
 *
 * 基于 window.matchMedia(max-width: Npx) 监听，卸载时自动清理监听器。
 * SSR / 无 matchMedia 环境下回退到 false（按桌面布局渲染），保证可用性。
 */
import { ref, onBeforeUnmount, type Ref } from 'vue';

type Breakpoints = Record<string, number>;

export function useBreakpoints(breakpoints: Breakpoints): {
  smaller: (key: string) => Ref<boolean>;
} {
  function smaller(key: string): Ref<boolean> {
    const target = breakpoints[key];
    const isSmaller = ref(false);

    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      typeof target !== 'number'
    ) {
      // 无 matchMedia 环境（SSR / 旧测试环境）：默认非窄屏
      return isSmaller;
    }

    const mql = window.matchMedia(`(max-width: ${target - 1}px)`);
    const update = (): void => {
      isSmaller.value = mql.matches;
    };
    update();

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
      onBeforeUnmount(() => mql.removeEventListener('change', update));
    } else if (typeof mql.addListener === 'function') {
      // Safari < 14 兼容
      mql.addListener(update);
      onBeforeUnmount(() => mql.removeListener(update));
    }

    return isSmaller;
  }

  return { smaller };
}
