import { test, expect, bffUrl } from './fixtures.js';

const WORKER_1 = {
  workerId: 'worker-a1b2',
  status: 'ONLINE' as const,
  devices: [
    {
      deviceIndex: 0,
      deviceType: 'CUDA',
      memoryTotalBytes: 80 * 1024 ** 3,
      memoryUsedBytes: 24 * 1024 ** 3,
      memoryAvailableBytes: 56 * 1024 ** 3,
    },
  ],
  modelCount: 2,
  lastHeartbeatAt: new Date().toISOString(),
};

const CLUSTER_STATUS_WITH_DATA = {
  workerCount: 1,
  workersOnline: 1,
  modelCounts: {
    total: 3,
    active: 2,
    sleeping: 1,
    starting: 0,
    error: 0,
    other: 0,
  },
  memory: {
    totalBytes: 80 * 1024 ** 3,
    usedBytes: 24 * 1024 ** 3,
    availableBytes: 56 * 1024 ** 3,
  },
};

test.describe('Cluster Overview', () => {
  test('shows Workers summary card', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    await expect(page.getByText('Workers')).toBeVisible();
  });

  test('shows Models summary card', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    await expect(page.getByText('Models')).toBeVisible();
  });

  test('shows GPU Memory summary card', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    await expect(page.getByText('GPU Memory')).toBeVisible();
  });

  test('shows Alerts summary card', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    await expect(page.getByText('Alerts')).toBeVisible();
  });

  test('summary cards show correct counts from mock data', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    // Worker count should show 1 / 1
    const workersCard = page.locator('.pf-v6-c-card').filter({ hasText: 'Workers' }).first();
    await expect(workersCard.getByText('1')).toBeVisible();

    // Models total: 3
    const modelsCard = page.locator('.pf-v6-c-card').filter({ hasText: 'Models' }).first();
    await expect(modelsCard.getByText('3')).toBeVisible();
  });

  test('shows VRAM Usage section', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    await expect(page.getByText('VRAM Usage')).toBeVisible();
  });

  test('shows Model State Breakdown section', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    await expect(page.getByText('Model State Breakdown')).toBeVisible();
  });

  test('shows Recent Events section', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    await expect(page.getByText('Recent Events')).toBeVisible();
  });

  test('worker online count shown as all online when all workers up', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setWorkers([WORKER_1]);
    mockControlPlane.setClusterStatus({
      ...CLUSTER_STATUS_WITH_DATA,
      workerCount: 1,
      workersOnline: 1,
    });

    await page.goto(bffUrl(bffPort, '/'));

    const workersCard = page.locator('.pf-v6-c-card').filter({ hasText: 'Workers' }).first();
    await expect(workersCard.getByText('All online')).toBeVisible();
  });

  test('alerts card shows all clear when no issues', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus({
      workerCount: 1,
      workersOnline: 1,
      modelCounts: { total: 1, active: 1, error: 0 },
      memory: { totalBytes: 10_000, usedBytes: 5_000, availableBytes: 5_000 },
    });

    await page.goto(bffUrl(bffPort, '/'));

    const alertsCard = page.locator('.pf-v6-c-card').filter({ hasText: 'Alerts' }).first();
    await expect(alertsCard.getByText('All clear')).toBeVisible();
  });
});
