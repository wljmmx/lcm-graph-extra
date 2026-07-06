/**
 * 前端入口：创建 Vue 应用，注册 router / naive-ui / TanStack Query。
 */
import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import { router } from './router';

// 设计令牌：必须在 App 渲染前注入，确保 CSS 变量可用
import './styles/tokens.css';

const app = createApp(App);

// 注册路由
app.use(router);

// 注册 TanStack Query（默认配置，后续可在 setup 中覆盖）
app.use(VueQueryPlugin, {
  queryClientConfig: {
    defaultOptions: {
      queries: {
        // 默认 10s 失效，避免频繁重复请求
        staleTime: 10_000,
        refetchOnWindowFocus: false,
      },
    },
  },
});

app.mount('#app');
