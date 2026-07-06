import { defineConfig, type PluginOption } from 'vite';
import vue from '@vitejs/plugin-vue';

// Vite 配置：dev 模式前端 :7422，/api 代理到后端 :7421
// 注：npm workspaces 下 @vitejs/plugin-vue 与 vite 可能解析到不同副本，
// 此处用类型断言统一为本地 vite 的 PluginOption，避免类型冲突。
export default defineConfig({
  plugins: [vue() as unknown as PluginOption],
  server: {
    port: 7422,
    proxy: {
      '/api': 'http://127.0.0.1:7421', // 代理到 dashboard 后端
    },
  },
  build: {
    outDir: 'dist-client',
    rollupOptions: {
      output: {
        manualChunks: {
          // EChart 按需模块（core + charts + components + renderers + vue-echarts）
          echarts: [
            'echarts/core',
            'echarts/renderers',
            'echarts/charts',
            'echarts/components',
            'vue-echarts',
          ],
          // Vue 运行时单独拆分
          vue: ['vue', 'vue-router', '@vue/runtime-core'],
          // @tanstack/vue-query
          'vue-query': ['@tanstack/vue-query'],
        },
      },
    },
    // naive-ui 不强制分块：让 Rollup 基于 named import 自动 tree-shake，
    // 仅实际被引用的组件会进入 bundle（避免整库 906KB 进单一 chunk）
    chunkSizeWarningLimit: 800,
  },
});
