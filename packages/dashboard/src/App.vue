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
import { computed, h, ref, watch, type Component } from 'vue';
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
  NDrawer,
  NDrawerContent,
  NDropdown,
  zhCN,
  dateZhCN,
  type MenuOption,
} from 'naive-ui';
import { useBreakpoints } from './composables/useBreakpoints';
import { RouterLink, useRoute } from 'vue-router';
import { useTheme, type ThemeMode } from './composables/useTheme';
import Icon from './components/Icon.vue';

const route = useRoute();

// H5 修复：窄屏导航收起（< 768px 用 hamburger + drawer）
const breakpoints = useBreakpoints({ xs: 0, s: 640, m: 768, l: 1024, xl: 1280 });
const isNarrowScreen = breakpoints.smaller('m'); // < 768px
const drawerActive = ref(false);

function openDrawer(): void { drawerActive.value = true; }
function closeDrawer(): void { drawerActive.value = false; }

// 路由切换时自动关闭抽屉（RouterLink 点击导航后）
watch(() => route.path, () => { drawerActive.value = false; });

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

// M5 修复：主题切换改 NDropdown（直接选择，替代循环点击）
const themeDropdownOptions: { label: string; key: ThemeMode }[] = [
  { label: '浅色', key: 'light' },
  { label: '深色', key: 'dark' },
  { label: '跟随系统', key: 'auto' },
];

function onThemeSelect(key: string): void {
  setMode(key as ThemeMode);
}

// 当前激活的菜单 key（与路由路径对齐；测试中心下的子 tab 路径也归并到 /testing）
const activeKey = computed(() => {
  if (route.path === '/testing' || route.path === '/benchmark' || route.path === '/qmd-test') {
    return '/testing';
  }
  return route.path;
});

// 渲染带 router-link 的菜单 label
function renderLinkLabel(to: string, label: string): Component {
  return () => h(RouterLink, { to }, { default: () => label });
}

// 顶部导航 5 项：监控/经验/记忆/维护/测试中心（v2.3.2 合并压测+测试工具）
const menuOptions = computed<MenuOption[]>(() => [
  { label: renderLinkLabel('/', '监控'), key: '/' },
  { label: renderLinkLabel('/experience', '经验'), key: '/experience' },
  { label: renderLinkLabel('/memory', '记忆'), key: '/memory' },
  { label: renderLinkLabel('/maintain', '维护'), key: '/maintain' },
  { label: renderLinkLabel('/testing', '测试中心'), key: '/testing' },
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
          <a href="#main" class="skip-link">跳到主内容</a>
          <NLayout style="min-height: 100vh">
            <NLayoutHeader
              bordered
              style="padding: 0 24px; display: flex; align-items: center; height: 56px;"
            >
              <h1 style="font-weight: 600; margin: 0; margin-right: 32px; font-size: var(--fs-body);">
                LCM Dashboard
              </h1>
              <!-- H5 修复：窄屏 hamburger，宽屏水平菜单 -->
              <NButton
                v-if="isNarrowScreen"
                quaternary
                circle
                aria-label="打开导航菜单"
                style="margin-right: 8px;"
                @click="openDrawer"
              >
                <Icon name="menu" :size="18" />
              </NButton>
              <NMenu
                v-else
                mode="horizontal"
                :options="menuOptions"
                :value="activeKey"
                aria-label="主导航"
              />
              <!-- M5 修复：主题切换改 NDropdown（直接选择模式，替代循环点击） -->
              <NDropdown
                :options="themeDropdownOptions"
                placement="bottom-end"
                trigger="click"
                @select="onThemeSelect"
              >
                <NButton
                  quaternary
                  circle
                  :aria-label="`切换主题（当前：${themeModeLabel}）`"
                  style="margin-left: auto;"
                >
                  <Icon :name="themeToggleIcon" :size="16" />
                </NButton>
              </NDropdown>
            </NLayoutHeader>
            <NLayoutContent id="main" role="main" tabindex="-1" style="padding: 24px;">
              <RouterView />
            </NLayoutContent>
          </NLayout>
          <!-- H5 修复：窄屏导航抽屉 -->
          <NDrawer v-model:show="drawerActive" placement="left" :width="240">
            <NDrawerContent title="导航" closable>
              <NMenu
                mode="vertical"
                :options="menuOptions"
                :value="activeKey"
                aria-label="移动端导航"
              />
            </NDrawerContent>
          </NDrawer>
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
/* M6：skip-to-content 跳转链接（无障碍）—— 视觉隐藏，键盘 Tab 聚焦时显现 */
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  z-index: 9999;
  padding: 8px 16px;
  background: var(--color-primary);
  color: #fff;
  border-radius: 0 0 var(--radius-md) 0;
  font-size: var(--fs-caption);
  transition: top 0.2s;
}
.skip-link:focus {
  top: 0;
}
</style>
