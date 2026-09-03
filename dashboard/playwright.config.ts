import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false, // Tests spin up BFF per-test — sequential avoids port exhaustion
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'html',
  use: {
    // baseURL is not set globally because each test fixture gets its own BFF port.
    // Tests must use `page.goto(bffUrl(bffPort, '/'))` or set baseURL explicitly.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // No global webServer — each test fixture starts its own BFF process.
});
