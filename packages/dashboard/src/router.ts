/**
 * 路由配置：4 个模块各对应一个懒加载 view。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'monitor', component: () => import('./views/MonitorView.vue') },
  { path: '/experience', name: 'experience', component: () => import('./views/ExperienceView.vue') },
  { path: '/memory', name: 'memory', component: () => import('./views/MemoryView.vue') },
  { path: '/maintain', name: 'maintain', component: () => import('./views/MaintainView.vue') },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
