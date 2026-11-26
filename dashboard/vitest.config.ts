import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const dashboardReact = resolve(__dirname, 'node_modules/react/index.js');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Pin the entire React render tree — react, react-dom, their subpath
    // entrypoints, AND @testing-library/react itself — to the dashboard's own
    // node_modules. The monorepo root hoists a React 19 copy (npm resolves it
    // only to satisfy the peer ranges of the hoisted dashboard packages) plus
    // @testing-library/react (which npm resolves against that root React 19).
    // Without pinning RTL, render/renderHook create roots from React 19 while
    // app code is pinned to React 18.3.1 → "Invalid hook call".
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
    //
    // The aliases only apply to modules Vite transforms, i.e. to inlined
    // dependencies (`test.server.deps.inline` below) and to the test files.
    // Externalized dependencies are imported natively by Node and bind the
    // hoisted React 19 no matter what this table says.
    //
    // `mainFields` is ESM-first on purpose: the test resolver otherwise picks
    // each package's CJS `main` (PatternFly's `dist/js`), and inlined CJS is
    // loaded with a native require that bypasses these aliases → React 19.
    mainFields: ['module', 'jsnext:main', 'jsnext', 'browser', 'main'],
    alias: [
      {
        find: 'react/jsx-dev-runtime',
        replacement: resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
      },
      {
        find: 'react/jsx-runtime',
        replacement: resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
      },
      {
        find: 'react-dom/client',
        replacement: resolve(__dirname, 'node_modules/react-dom/client.js'),
      },
      {
        find: 'react-dom/test-utils',
        replacement: resolve(__dirname, 'node_modules/react-dom/test-utils.js'),
      },
      { find: 'react-dom', replacement: resolve(__dirname, 'node_modules/react-dom/index.js') },
      { find: 'react', replacement: dashboardReact },
      {
        find: '@testing-library/react',
        replacement: resolve(
          __dirname,
          '../node_modules/@testing-library/react/dist/@testing-library/react.esm.js',
        ),
      },
      // react-router: its exports map resolves the "node" condition to the CJS
      // build (react-router-dom/dist/index.js), whose native require bypasses
      // the react alias. Pin the ESM entries so the graph is transformed and
      // its `react` imports come back through the alias table.
      {
        find: /^react-router-dom$/,
        replacement: resolve(__dirname, '../node_modules/react-router-dom/dist/index.mjs'),
      },
      {
        find: /^react-router\/dom$/,
        replacement: resolve(
          __dirname,
          '../node_modules/react-router/dist/development/dom-export.mjs',
        ),
      },
      {
        find: /^react-router$/,
        replacement: resolve(__dirname, '../node_modules/react-router/dist/development/index.mjs'),
      },
      // react-i18next imports useSyncExternalStore from this package, whose
      // shim is CJS (`require('react')`) → React 19. React 18.3 exports the
      // same hook natively, so point the shim at React itself.
      {
        find: /^use-sync-external-store(\/shim)?(\/index\.js)?$/,
        replacement: dashboardReact,
      },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    passWithNoTests: true,
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    server: {
      deps: {
        // Every package that imports react must be transformed by Vite so its
        // `react` specifier goes through the alias table above. Anything left
        // externalized binds the hoisted React 19 and fails at render time
        // ("Objects are not valid as a React child" / null dispatcher).
        // A dependency that only ships CJS cannot be fixed here — it needs an
        // ESM-entry alias (see react-router above). New React-consuming
        // dependencies belong in this list, with a probe in
        // src/__tests__/render-probes.test.tsx.
        inline: [
          /node_modules\/@patternfly\//,
          /node_modules\/react-i18next\//,
          /node_modules\/@tanstack\//,
          /node_modules\/react-router/,
          /node_modules\/victory/,
          /node_modules\/react-markdown\//,
          /node_modules\/react-dropzone\//,
          /node_modules\/use-debounce\//,
          /node_modules\/posthog-js\//,
          /node_modules\/@monaco-editor\//,
        ],
      },
    },
  },
});
