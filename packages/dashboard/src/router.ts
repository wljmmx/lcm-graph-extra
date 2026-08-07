/**
 * 路由配置：5 个模块各对应一个懒加载 view。
 *
 * v2.3.2：压测 + QMD 测试工具整合为"测试中心"（/testing），旧路由重定向。
 * v2.11.0：监控模块拆分为子路由（MonitorLayout + 6 子页面），旧 / 302 重定向到 /monitor/overview。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  // 监控模块（新架构：MonitorLayout 外壳 + 子路由）
  {
    path: '/monitor',
    component: () => import('./layouts/MonitorLayout.vue'),
    children: [
      { path: '', redirect: '/monitor/overview' },
      { path: 'overview', name: 'monitor-overview', component: () => import('./views/monitor/OverviewView.vue') },
      { path: 'services', name: 'monitor-services', component: () => import('./views/monitor/ServicesView.vue') },
      { path: 'graph', name: 'monitor-graph', component: () => import('./views/monitor/GraphView.vue') },
      { path: 'ai', name: 'monitor-ai', component: () => import('./views/monitor/AIView.vue') },
      { path: 'metrics', name: 'monitor-metrics', component: () => import('./views/monitor/MetricsView.vue') },
      { path: 'moa', name: 'monitor-moa', component: () => import('./views/monitor/MoaView.vue') },
    ],
  },
  // 兼容旧路由：/ → 302 到 /monitor/overview，旧 ?tab= 参数忽略
  { path: '/', redirect: '/monitor/overview' },
  // 经验管理
  { path: '/experience', name: 'experience', component: () => import('./views/ExperienceView.vue') },
  // 记忆查询
  { path: '/memory', name: 'memory', component: () => import('./views/MemoryView.vue') },
  // 维护工具
  { path: '/maintain', name: 'maintain', component: () => import('./views/MaintainView.vue') },
  // 测试中心（整合 CE 压测 + QMD 测试工具）
  { path: '/testing', name: 'testing', component: () => import('./views/TestingCenterView.vue') },
  // 旧路由重定向到测试中心对应 tab（向后兼容书签/外链）
  { path: '/benchmark', redirect: { path: '/testing', query: { tab: 'benchmark' } } },
  { path: '/qmd-test', redirect: { path: '/testing', query: { tab: 'qmd-test' } } },
  // 设置页（MOA 配置 + 模型管理 + 能力档次切换）
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});