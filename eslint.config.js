// @ts-check

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    ignores: [
      '**/dist/',
      '**/build/',
      '**/node_modules/',
      '**/target/',
      '**/coverage/',
      '**/.claude/',
      'packages/types/src/generated/',
      'vitest.config.ts',
      'vitest.workspace.ts',
      '**/vitest.config.ts',
      '**/vitest.integration.config.ts',
      'dashboard/dist/',
      'dashboard/vite.config.ts',
      'dashboard/playwright.config.ts',
      '**/*.v1.tsx',
      '**/*.v1.ts',
    ],
  },
  {
    files: ['dashboard/e2e/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./dashboard/tsconfig.e2e.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Playwright's fixture runtime introspects the destructured parameter names of the
      // first argument to determine fixture dependencies — `{}` for "no fixtures needed" is
      // required syntax, not an accidental empty pattern (see e2e/fixtures.ts).
      'no-empty-pattern': 'off',
    },
  },
);
