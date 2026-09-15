import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

// Load the repo-root .env (all keys, no VITE_ prefix filter) so the dev server port and the
// BFF proxy target come from the same single file as every other service. These are used only
// in dev-server config here — they are never exposed to the client bundle.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      port: Number(env.SARDEENZ_DASHBOARD_PORT ?? 5173),
      proxy: {
        '/api': {
          target: env.SARDEENZ_BFF_PROXY_TARGET ?? 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist/client',
    },
  };
});
