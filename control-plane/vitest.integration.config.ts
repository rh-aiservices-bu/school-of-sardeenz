import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/integration/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    passWithNoTests: true,
    fileParallelism: false,
  },
});
