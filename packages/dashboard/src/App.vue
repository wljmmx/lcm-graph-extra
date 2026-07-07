<script setup lang="ts">
// 根组件：NConfigProvider（含主题覆盖 + 暗色切换）+ 全局 Provider 包裹 + NLayout 导航 + router-view 内容区
//
// 全局 Provider 说明（P0 修复）：
//   NMessageProvider / NDialogProvider / NNotificationProvider 必须包裹
//   router-view 内容，否则子组件调用 useMessage()/useDialog()/useNotification()
//   会抛出 "No provider" 运行时错误。
//
// 暗色模式（S3-1）：
//   useTheme 管理 light/dark/auto 三态，同步 document[data-theme] 属性，
//   tokens.css 的 [data-theme="dark"] 覆盖块据此生效；同时驱动 naive-ui
//   NConfigProvider 的 :theme（darkTheme / null）与 :theme-overrides。
import { computed, h, type Component } from 'vue';
import {
  NConfigProvider,
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NMenu,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  NButton,
  NTooltip,
  zhCN,
  dateZhCN,
  type MenuOption,
} from 'naive-ui';
import { RouterLink, useRoute } from 'vue-router';
import { useTheme, type ThemeMode } from './composables/useTheme';
import Icon from './components/Icon.vue';

const route = useRoute();

// 主题（light / dark / auto）
const { mode, isDark, theme, themeOverrides, setMode } = useTheme();

const themeModeLabel = computed<string>(() => {
  switch (mode.value) {
    case 'light': return '浅色';
    case 'dark':  return '深色';
    case 'auto':  return '跟随系统';
    default:      return '';
  }
});

// 主题切换按钮图标（SVG，跟随 isDark/mode）
const themeToggleIcon = computed<string>(() => {
  if (mode.value === 'auto') return 'contrast';
  return isDark.value ? 'moon' : 'sun';
});

// 切换器：light → dark → auto 循环
function cycleTheme(): void {
  const order: ThemeMode[] = ['light', 'dark', 'auto'];
  const idx = order.indexOf(mode.value);
  setMode(order[(idx + 1) % order.length]);
}

// 当前激活的菜单 key（与路由路径对齐）
const activeKey = computed(() => route.path);

// 渲染带 router-link 的菜单 label
function renderLinkLabel(to: string, label: string): Component {
  return () => h(RouterLink, { to }, { default: () => label });
}

// 顶部导航 4 项：监控/经验/记忆/维护
const menuOptions = computed<MenuOption[]>(() => [
  { label: renderLinkLabel('/', '监控'), key: '/' },
  { label: renderLinkLabel('/experience', '经验'), key: '/experience' },
  { label: renderLinkLabel('/memory', '记忆'), key: '/memory' },
  { label: renderLinkLabel('/maintain', '维护'), key: '/maintain' },
]);
</script>

<template>
  <NConfigProvider
    :locale="zhCN"
    :date-locale="dateZhCN"
    :theme="theme"
    :theme-overrides="themeOverrides"
  >
    <NMessageProvider>
      <NDialogProvider>
        <NNotificationProvider>
          <NLayout style="min-height: 100vh">
            <NLayoutHeader
              bordered
              style="padding: 0 24px; display: flex; align-items: center; height: 56px;"
            >
              <h1 style="font-weight: 600; margin: 0; margin-right: 32px; font-size: var(--fs-body);">
                LCM Dashboard
              </h1>
              <NMenu
                mode="horizontal"
                :options="menuOptions"
                :value="activeKey"
                aria-label="主导航"
              />
              <!-- 主题切换器：light → dark → auto 循环 -->
              <NTooltip placement="bottom">
                <template #trigger>
                  <NButton
                    quaternary
                    circle
                    :aria-label="`切换主题（当前：${themeModeLabel}）`"
                    style="margin-left: auto;"
                    @click="cycleTheme"
                  >
                    <Icon :name="themeToggleIcon" :size="16" />
                  </NButton>
                </template>
                主题：{{ themeModeLabel }}（点击切换）
              </NTooltip>
            </NLayoutHeader>
            <NLayoutContent style="padding: 24px;">
              <RouterView />
            </NLayoutContent>
          </NLayout>
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
