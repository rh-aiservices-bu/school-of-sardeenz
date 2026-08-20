import { defineConfig, configDefaults } from 'vitest/config';

// Default (parallel) config for the control-plane project, used by the root `vitest run`
// (`npm test`). Integration tests are EXCLUDED here: they share a single Postgres test database and
// TRUNCATE it per test, so running the integration files in parallel makes them clobber each other
// (intermittent failures). They run separately and serially via `vitest.integration.config.ts`
// (`npm run test:integration` / `make test-integration`, which sets `fileParallelism: false`).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/__tests__/integration/**'],
  },
});
