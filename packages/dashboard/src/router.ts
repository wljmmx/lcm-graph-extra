/**
 * 路由配置：5 个模块各对应一个懒加载 view。
 *
 * v2.3.2：压测 + QMD 测试工具整合为"测试中心"（/testing），旧路由重定向。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'monitor', component: () => import('./views/MonitorView.vue') },
  { path: '/experience', name: 'experience', component: () => import('./views/ExperienceView.vue') },
  { path: '/memory', name: 'memory', component: () => import('./views/MemoryView.vue') },
  { path: '/maintain', name: 'maintain', component: () => import('./views/MaintainView.vue') },
  // 测试中心（整合 CE 压测 + QMD 测试工具）
  { path: '/testing', name: 'testing', component: () => import('./views/TestingCenterView.vue') },
  // 旧路由重定向到测试中心对应 tab（向后兼容书签/外链）
  { path: '/benchmark', redirect: { path: '/testing', query: { tab: 'benchmark' } } },
  { path: '/qmd-test', redirect: { path: '/testing', query: { tab: 'qmd-test' } } },
  // 设置页（MOA 配置 + 模型管理）
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
