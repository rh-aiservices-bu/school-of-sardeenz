import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/types', 'packages/utils', 'control-plane', 'dashboard'],
    passWithNoTests: true,
  },
});
