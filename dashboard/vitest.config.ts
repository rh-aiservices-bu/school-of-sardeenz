import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Pin the entire React render tree — react, react-dom, their subpath
    // entrypoints, AND @testing-library/react itself — to the dashboard's own
    // node_modules. The monorepo root hoists a React 19 copy (transitive dep of
    // @redocly/cli) plus @testing-library/react (which npm resolves against that
    // root React 19). Without pinning RTL, render/renderHook create roots from
    // React 19 while app code is pinned to React 18.3.1 → "Invalid hook call".
    // Alias targets must stay exact *file* paths (not directories): Vite
    // applies these before package-exports resolution, so a directory target
    // would break subpath entrypoints like react-dom/client.
    //
    // RTL is pointed at its ESM build (react.esm.js), NOT its CJS main
    // (dist/index.js): vitest/vite-node runs inlined CJS packages with a native
    // require (createRequire) that bypasses these aliases, so the CJS build's
    // require('react-dom') would bind the monorepo-root React 19 copy. The ESM
    // build's `import`s are rewritten to go through the alias pipeline → React 18.
    // NOTE: npm hoists @testing-library/react to the monorepo ROOT node_modules
    // (it is not in dashboard/node_modules), so its target points one level up.
    alias: {
      'react/jsx-dev-runtime': resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
      'react/jsx-runtime': resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
      'react-dom/client': resolve(__dirname, 'node_modules/react-dom/client.js'),
      'react-dom/test-utils': resolve(__dirname, 'node_modules/react-dom/test-utils.js'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom/index.js'),
      react: resolve(__dirname, 'node_modules/react/index.js'),
      '@testing-library/react': resolve(
        __dirname,
        '../node_modules/@testing-library/react/dist/@testing-library/react.esm.js',
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    passWithNoTests: true,
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
