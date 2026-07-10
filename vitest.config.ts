import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/bench/**'],
    environment: 'node',
    testTimeout: 10000,
  },
});
