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
    // 拆分大体积依赖，避免 EChart chunk > 500KB 警告
    rollupOptions: {
      output: {
        manualChunks: {
          // EChart 全家桶（core + charts + components + renderers + vue-echarts）
          echarts: [
            'echarts/core',
            'echarts/renderers',
            'echarts/charts',
            'echarts/components',
            'vue-echarts',
          ],
          // Vue 运行时单独拆分
          vue: ['vue', 'vue-router', '@vue/runtime-core'],
          // Naive UI 组件库
          'naive-ui': ['naive-ui'],
          // 图表/查询库
          vendor: ['echarts', '@tanstack/vue-query'],
        },
      },
    },
    // 提升 chunk 大小警告阈值到 800KB（多模块拆分后仍可能合并接近 500KB）
    chunkSizeWarningLimit: 800,
  },
});
