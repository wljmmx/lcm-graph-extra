/**
 * useTheme —— 主题切换 composable。
 *
 * - 三态：light（默认）/ dark / auto（跟随系统 prefers-color-scheme）
 * - 持久化到 localStorage（key: lcm-dashboard.theme）
 * - 同步 document.documentElement[data-theme] 属性（tokens.css 暗色覆盖依赖此）
 * - 通过 matchMedia 监听系统主题变化（仅 auto 模式生效）
 *
 * 状态为模块级单例：多个组件共享同一份 mode / isDark，
 * DOM 监听器只注册一次。
 */
import { ref, computed, watch, onMounted } from 'vue';
import {
  darkTheme,
  type GlobalTheme,
  type GlobalThemeOverrides,
} from 'naive-ui';
import { lightThemeOverrides, darkThemeOverrides } from '../styles/theme';

export type ThemeMode = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'lcm-dashboard.theme';
const THEME_ATTR = 'data-theme';

// ===== 模块级单例状态（跨组件共享） =====
const mode = ref<ThemeMode>('light');
const systemDark = ref<boolean>(false);
const isDark = ref<boolean>(false);
let mql: MediaQueryList | null = null;
let mqlHandler: ((e: MediaQueryListEvent) => void) | null = null;
let initialized = false;

function applyDomTheme(dark: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(THEME_ATTR, dark ? 'dark' : 'light');
}

function readStoredMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'light';
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'auto') return v;
  return 'light';
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;

  mode.value = readStoredMode();

  if (typeof window !== 'undefined' && 'matchMedia' in window) {
    mql = window.matchMedia('(prefers-color-scheme: dark)');
    systemDark.value = mql.matches;
    mqlHandler = (e: MediaQueryListEvent) => {
      systemDark.value = e.matches;
    };
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', mqlHandler);
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(mqlHandler);
    }
  }

  // 内部同步：mode + systemDark → isDark
  watch(
    [mode, systemDark],
    ([m, sys]) => {
      isDark.value = m === 'dark' || (m === 'auto' && sys);
    },
    { immediate: true },
  );

  // isDark → DOM 属性
  watch(isDark, (v) => applyDomTheme(v), { immediate: true });

  // mode → 持久化
  watch(mode, (m) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, m);
    }
  });
}

export function useTheme() {
  // 在 setup 中触发初始化（onMounted 保证只在客户端执行，避免 SSR 时匹配 media）
  onMounted(ensureInit);
  // 兜底：非 setup 调用或测试环境也能初始化
  ensureInit();

  // naive-ui theme 对象（dark → darkTheme，light → null）
  const theme = computed<GlobalTheme | null>(() => (isDark.value ? darkTheme : null));

  // themeOverrides：light 与 dark 深度合并
  const themeOverrides = computed<GlobalThemeOverrides>(() =>
    isDark.value
      ? { ...lightThemeOverrides, ...darkThemeOverrides }
      : lightThemeOverrides,
  );

  function setMode(m: ThemeMode): void {
    mode.value = m;
  }
  function toggle(): void {
    mode.value = isDark.value ? 'light' : 'dark';
  }

  return {
    mode,
    isDark,
    theme,
    themeOverrides,
    setMode,
    toggle,
  };
}

// 测试钩子：重置单例（仅供 vitest beforeEach 使用）
export function _resetThemeSingleton(): void {
  initialized = false;
  mode.value = 'light';
  systemDark.value = false;
  isDark.value = false;
  if (mql && mqlHandler) {
    if (typeof mql.removeEventListener === 'function') {
      mql.removeEventListener('change', mqlHandler);
    } else if (typeof mql.removeListener === 'function') {
      mql.removeListener(mqlHandler);
    }
  }
  mql = null;
  mqlHandler = null;
}
