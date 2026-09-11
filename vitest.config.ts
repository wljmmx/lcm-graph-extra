import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/bench/**'],
    environment: 'node',
    testTimeout: 10000,
    // 测试环境隔离：指向不存在的 gm-pro 路径，确保 GraphAdapter/工具测试走“gm-pro 不可用”的 mock 路径。
    // 不隔离时，开发者机器上 ~/.openclaw/extensions/graph-memory-pro 等真实安装会被 resolveGmProPath 命中，
    // 导致测试 fake mod 被真实加载覆盖（本机复现 4 个失败；干净 CI runner 无此问题，此为双保险）。
    env: {
      GM_PRO_PATH: '/nonexistent/lcm-test-isolation',
    },
  },
});
