<script setup lang="ts">
// 根组件：NConfigProvider（含主题覆盖）+ 全局 Provider 包裹 + NLayout 导航 + router-view 内容区
//
// 全局 Provider 说明（P0 修复）：
//   NMessageProvider / NDialogProvider / NNotificationProvider 必须包裹
//   router-view 内容，否则子组件调用 useMessage()/useDialog()/useNotification()
//   会抛出 "No provider" 运行时错误。
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
  zhCN,
  dateZhCN,
  type MenuOption,
} from 'naive-ui';
import { RouterLink, useRoute } from 'vue-router';
import { lightThemeOverrides } from './styles/theme';

const route = useRoute();

// 主题覆盖（与 styles/tokens.css 色板对齐）
const themeOverrides = lightThemeOverrides;

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
              <div style="font-weight: 600; margin-right: 32px;">
                LCM Dashboard
              </div>
              <NMenu mode="horizontal" :options="menuOptions" :value="activeKey" />
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
