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
      'packages/types/src/generated/',
      'vitest.config.ts',
      'vitest.workspace.ts',
      '**/vitest.integration.config.ts',
    ],
  },
);
