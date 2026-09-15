import { defineConfig } from 'vitest/config';

// Local vitest config so `npm test -w @sardeenz/dev-worker` (cwd = runners/dev-worker) stops
// falling back to the root vitest.config.ts, whose `test.projects` globs are relative to the
// repo root and dangle when resolved from this directory (#144). The root `vitest run`
// (`npm test` / `make test`) already picks this file up as this project's config — the same
// arrangement control-plane and dashboard use — so both invocations share this config.
export default defineConfig({
  test: {
    // No `projects` key (that's root-only). No integration split to exclude yet; if one is
    // added later, mirror control-plane's config + `vitest.integration.config.ts` pattern.
  },
});
