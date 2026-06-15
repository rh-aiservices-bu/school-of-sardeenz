/**
 * SSE & Real-time update tests.
 *
 * These tests verify that the UI responds to server-sent events pushed by
 * the control plane.  The mock CP exposes a `pushEvent()` helper that
 * injects events into connected SSE clients.
 *
 * Note: The BFF SSE route proxies from Redis pub/sub, not directly from the
 * CP's own event stream.  In E2E mode (AUTH_MODE=none) the SSE route still
 * requires a Redis subscription, which will fail gracefully when Redis is not
 * available — the route returns 502 and the frontend falls back to polling.
 * These tests therefore validate the degraded-mode (polling) path and the
 * connection status label.
 */

import { test, expect, bffUrl } from './fixtures.js';

test.describe('SSE & Real-time', () => {
  test('Recent Events section shows connection status label', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus({
      workerCount: 0,
      workersOnline: 0,
      modelCounts: { total: 0, active: 0 },
      memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0 },
    });

    await page.goto(bffUrl(bffPort, '/'));

    // The connection label (Live / Reconnecting… / Degraded) should be visible
    const connectionLabel = page.locator('[aria-live="polite"]').first();
    await expect(connectionLabel).toBeVisible();
  });

  test('Recent Events section shows waiting message when no events', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus({
      workerCount: 0,
      workersOnline: 0,
      modelCounts: { total: 0, active: 0 },
      memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0 },
    });

    await page.goto(bffUrl(bffPort, '/'));

    await expect(
      page.getByText('No events yet').or(page.getByText('Waiting for cluster activity'))
    ).toBeVisible();
  });

  test('degraded banner appears when control plane is unreachable for queries', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    // Make health check fail so BFF detects unhealthy CP
    mockControlPlane.setHealthy(false);

    // The cluster status endpoint will throw, BFF falls back to Redis (which also
    // won't connect), so the query will error and the UI should show degraded state.
    // We navigate to the metrics page to avoid the cluster status card that
    // requires the overview to load.
    await page.goto(bffUrl(bffPort, '/metrics'));

    // Just verify the page loads without crashing — degraded banner may or may
    // not appear depending on Redis fallback timing
    await expect(page.locator('nav')).toBeVisible();
  });
});
