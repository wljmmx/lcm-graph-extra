<script setup lang="ts">
// 根组件：NConfigProvider 包裹 + NLayout 导航 + router-view 内容区
import { computed, h, type Component } from 'vue';
import {
  NConfigProvider,
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NMenu,
  zhCN,
  dateZhCN,
  type MenuOption,
} from 'naive-ui';
import { RouterLink, useRoute } from 'vue-router';

const route = useRoute();

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
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN">
    <NLayout style="min-height: 100vh">
      <NLayoutHeader bordered style="padding: 0 24px; display: flex; align-items: center; height: 56px;">
        <div style="font-weight: 600; margin-right: 32px;">LCM Dashboard</div>
        <NMenu mode="horizontal" :options="menuOptions" :value="activeKey" />
      </NLayoutHeader>
      <NLayoutContent style="padding: 24px;">
        <RouterView />
      </NLayoutContent>
    </NLayout>
  </NConfigProvider>
</template>
