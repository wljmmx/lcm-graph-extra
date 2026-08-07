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
  NBreadcrumb,
  NBreadcrumbItem,
  zhCN,
  dateZhCN,
  type MenuOption,
} from 'naive-ui';
import { useBreakpoints } from './composables/useBreakpoints';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useTheme, type ThemeMode } from './composables/useTheme';
import Icon from './components/Icon.vue';

const route = useRoute();
const router = useRouter();

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

// 当前激活的菜单 key（与路由路径对齐；监控子路由归并到 /monitor/overview；
// 测试中心下的子 tab 路径也归并到 /testing）
const activeKey = computed(() => {
  if (route.path.startsWith('/monitor')) {
    return '/monitor/overview';
  }
  if (route.path === '/testing' || route.path === '/benchmark' || route.path === '/qmd-test') {
    return '/testing';
  }
  return route.path;
});

// 面包屑：路由路径 → 可读名称（监控子路由动态映射）
const breadcrumbMap: Record<string, string> = {
  '/monitor/overview': '监控总览',
  '/monitor/services': '核心服务',
  '/monitor/graph': '图谱中心',
  '/monitor/ai': '智能引擎',
  '/monitor/metrics': '指标分析',
  '/monitor/moa': 'MoA 多模型',
  '/experience': '经验',
  '/memory': '记忆',
  '/maintain': '维护',
  '/testing': '测试中心',
  '/settings': '设置',
};
const breadcrumbLabel = computed(() => breadcrumbMap[route.path] ?? route.path);

// P3-12: 页面标题动态更新
watch(
  () => breadcrumbLabel.value,
  (label) => {
    document.title = label ? `${label} - LCM Dashboard` : 'LCM Dashboard';
  },
  { immediate: true },
);

// 渲染带 router-link + icon 的菜单 label（P2-5 导航优化）
function renderMenuLabel(to: string, label: string, icon: string): Component {
  return () =>
    h(
      RouterLink,
      { to },
      {
        default: () =>
          h('span', { class: 'nav-item' }, [
            h(Icon, { name: icon, size: 16, style: { marginRight: '6px', verticalAlign: 'middle' } }),
            h('span', label),
          ]),
      },
    );
}

// 顶部导航：监控（含子菜单分组）/ 经验 / 记忆 / 维护 / 测试中心 / 设置
const menuOptions = computed<MenuOption[]>(() => [
  {
    label: '监控',
    key: 'monitor-group',
    icon: () => h(Icon, { name: 'activity', size: 16 }),
    children: [
      { label: renderMenuLabel('/monitor/overview', '总览', 'barChart'), key: '/monitor/overview' },
      { label: renderMenuLabel('/monitor/services', '核心服务', 'server'), key: '/monitor/services' },
      { label: renderMenuLabel('/monitor/graph', '图谱中心', 'share'), key: '/monitor/graph' },
      { label: renderMenuLabel('/monitor/ai', '智能引擎', 'cpu'), key: '/monitor/ai' },
      { label: renderMenuLabel('/monitor/metrics', '指标分析', 'trendingUp'), key: '/monitor/metrics' },
      { label: renderMenuLabel('/monitor/moa', 'MoA 多模型', 'layers'), key: '/monitor/moa' },
    ],
  },
  { label: renderMenuLabel('/experience', '经验', 'bookOpen'), key: '/experience' },
  { label: renderMenuLabel('/memory', '记忆', 'database'), key: '/memory' },
  { label: renderMenuLabel('/maintain', '维护', 'tools'), key: '/maintain' },
  { label: renderMenuLabel('/testing', '测试中心', 'flask'), key: '/testing' },
  { label: renderMenuLabel('/settings', '设置', 'settings'), key: '/settings' },
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
              class="app-header"
            >
              <h1 class="app-title">
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
            <!-- 面包屑导航 -->
            <div style="padding: 8px 24px 0; border-bottom: 1px solid var(--color-border);">
              <NBreadcrumb>
                <NBreadcrumbItem clickable @click="router.push('/')">首页</NBreadcrumbItem>
                <NBreadcrumbItem>{{ breadcrumbLabel }}</NBreadcrumbItem>
              </NBreadcrumb>
            </div>
            <NLayoutContent id="main" role="main" tabindex="-1" style="padding: 24px;">
              <!--
                直接渲染 RouterView，不使用 Transition 组件。
                Transition 的 mode="out-in" 与 SettingsView/MonitorView 中
                NTabs 的 animated 动画存在 DOM 销毁/重建时序冲突，
                导致从设置页跳转到监控页时出现空白。
              -->
              <RouterView v-slot="{ Component: RouteComponent, route: slotRoute }">
                <component :is="RouteComponent" :key="slotRoute.path" />
              </RouterView>
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

/* P2-1/P2-4: Header 品牌渐变背景 */
.app-header {
  padding: 0 24px;
  display: flex;
  align-items: center;
  height: 56px;
  background: var(--gradient-header);
}

/* P2-1: 品牌标题 */
.app-title {
  font-weight: 700;
  margin: 0;
  margin-right: 32px;
  font-size: var(--fs-body);
  background: var(--gradient-brand);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  letter-spacing: 0.02em;
}

/* P2-5: 导航项样式 */
.nav-item {
  display: inline-flex;
  align-items: center;
  transition: color var(--motion-fast);
}

/* P2-4: 卡片悬浮微升效果（全局 Naive UI Card 增强） */
.n-card {
  transition: box-shadow var(--motion-base), transform var(--motion-base);
}
.n-card:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}
</style>
