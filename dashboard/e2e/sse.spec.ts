/**
 * SSE & Real-time update tests.
 *
 * With Redis running (from compose.yaml), the BFF SSE route successfully
 * subscribes to Redis pub/sub and the frontend connects over EventSource.
 * These tests verify the connection status label, the empty-events state,
 * and degraded-mode behavior when the control plane becomes unreachable.
 */

import { test, expect, bffUrl } from './fixtures.js';

test.describe('SSE & Real-time', () => {
  test('Recent Events section shows Live connection status', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus({
      workerCount: 0,
      workersOnline: 0,
      modelCounts: { total: 0, active: 0 },
      memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0 },
    });

    await page.goto(bffUrl(bffPort, '/'));

    // With Redis available, SSE connects successfully — status should be Live
    const connectionLabel = page.locator('[aria-live="polite"]').first();
    await expect(connectionLabel).toBeVisible();
    await expect(connectionLabel).toHaveText('Live', { timeout: 10_000 });
  });

  test('Recent Events section shows waiting message when no events', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus({
      workerCount: 0,
      workersOnline: 0,
      modelCounts: { total: 0, active: 0 },
      memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0 },
    });

    await page.goto(bffUrl(bffPort, '/'));

    await expect(
      page.getByText('No events yet').or(page.getByText('Waiting for cluster activity')),
    ).toBeVisible();
  });

  test('degraded banner appears when control plane is unreachable', async ({
    page,
    bffPort,
    mockControlPlane,
    testRedis,
  }) => {
    // Seed Redis with minimal data so the fallback has something to return
    await testRedis.seedWorkerDetail({
      workerId: 'worker-test',
      status: 'ONLINE',
      devices: [],
    });

    // Make all CP API endpoints return 503
    mockControlPlane.setApiError(true);

    await page.goto(bffUrl(bffPort, '/'));

    // With Redis serving fallback data, the degraded banner should show
    await expect(page.getByText('Control plane unreachable — showing cached data')).toBeVisible({
      timeout: 15_000,
    });
  });
});
