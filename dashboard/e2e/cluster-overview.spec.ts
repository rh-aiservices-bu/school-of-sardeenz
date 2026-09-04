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

    // Unscoped getByText('Workers') also matches the global nav sidebar link of the same name
    // (a strict-mode violation) — scope to the summary card itself.
    await expect(page.getByTestId('summary-card-workers').getByText('Workers')).toBeVisible();
  });

  test('shows Models summary card', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    // Unscoped getByText('Models') is a case-insensitive substring match and can also hit the
    // global nav sidebar link, or the inference URL banner's "MLServer models" text once
    // /api/config resolves — scope to the summary card itself.
    await expect(page.getByTestId('summary-card-models').getByText('Models')).toBeVisible();
  });

  test('shows GPU Memory summary card', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    // Unscoped getByText('GPU Memory') also matches the global nav sidebar link of the same
    // name — scope to the summary card itself.
    await expect(page.getByTestId('summary-card-gpu-memory').getByText('GPU Memory')).toBeVisible();
  });

  test('shows Alerts summary card', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    // Scoped to the summary card for consistency with the other summary-card assertions, which
    // must scope to avoid colliding with the global nav sidebar / inference URL banner text.
    await expect(page.getByTestId('summary-card-alerts').getByText('Alerts')).toBeVisible();
  });

  test('summary cards show correct counts from mock data', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    // Worker count should show 1 / 1. Scope by data-testid rather than a text filter: the
    // inference URL banner (rendered once /api/config resolves) contains "MLServer models" in
    // its OIP description, and PlaywrightLocator.filter({ hasText }) matches case-insensitively,
    // so `.filter({ hasText: 'Models' })` can race-pick that banner card instead of the actual
    // Models summary card once it mounts.
    const workersCard = page.getByTestId('summary-card-workers');
    await expect(workersCard.getByText('1', { exact: true })).toBeVisible();

    // Models total: 3
    const modelsCard = page.getByTestId('summary-card-models');
    await expect(modelsCard.getByText('3', { exact: true })).toBeVisible();
  });

  test('shows VRAM Usage section', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS_WITH_DATA);

    await page.goto(bffUrl(bffPort, '/'));

    await expect(page.getByRole('heading', { name: 'VRAM Usage' })).toBeVisible();
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

    const workersCard = page.getByTestId('summary-card-workers');
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

    const alertsCard = page.getByTestId('summary-card-alerts');
    await expect(alertsCard.getByText('All clear')).toBeVisible();
  });

  test('moves an active placement to a compatible worker and GPU', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    const gib = 1024 ** 3;
    const capability = {
      runnerType: 'vllm',
      engineName: 'vLLM',
      supportedModelTypes: ['LLM'],
      supportedDeviceTypes: ['CUDA'],
      maxTensorParallelism: 1,
      kvCacheElasticSharing: false,
    };
    mockControlPlane.setModels([
      {
        modelName: 'move-model',
        state: 'ACTIVE',
        runnerType: 'vllm',
        requiredMemory: 8 * gib,
        workerId: 'worker-source',
      },
    ]);
    mockControlPlane.setInstances('move-model', [
      {
        instanceId: 'inst-source',
        state: 'ACTIVE',
        workerId: 'worker-source',
        deviceIndices: [0],
      },
    ]);
    mockControlPlane.setWorkers([
      {
        workerId: 'worker-source',
        status: 'ONLINE',
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryTotalBytes: 24 * gib,
            memoryUsedBytes: 8 * gib,
            memoryAvailableBytes: 16 * gib,
          },
        ],
        runnerCapabilities: [capability],
      },
      {
        workerId: 'worker-target',
        status: 'ONLINE',
        devices: [
          {
            deviceIndex: 1,
            deviceType: 'CUDA',
            memoryTotalBytes: 24 * gib,
            memoryUsedBytes: 0,
            memoryAvailableBytes: 24 * gib,
          },
        ],
        runnerCapabilities: [capability],
      },
    ]);
    mockControlPlane.setClusterMemory({
      workers: [
        {
          workerId: 'worker-source',
          devices: [
            {
              deviceIndex: 0,
              deviceType: 'CUDA',
              memoryTotalBytes: 24 * gib,
              memoryUsedBytes: 8 * gib,
              memoryAvailableBytes: 16 * gib,
            },
          ],
          models: [
            {
              modelName: 'move-model',
              instanceId: 'inst-source',
              state: 'ACTIVE',
              memoryUsedBytes: 8 * gib,
              deviceIndices: [0],
            },
          ],
        },
        {
          workerId: 'worker-target',
          devices: [
            {
              deviceIndex: 1,
              deviceType: 'CUDA',
              memoryTotalBytes: 24 * gib,
              memoryUsedBytes: 0,
              memoryAvailableBytes: 24 * gib,
            },
          ],
          models: [],
        },
      ],
    });

    await page.goto(bffUrl(bffPort, '/'));
    await page.getByRole('button', { name: 'Move move-model (inst-source)' }).click();
    await expect(page.getByRole('dialog', { name: 'Move model instance' })).toBeVisible();
    await page.getByLabel('Target worker').selectOption('worker-target');
    await page.getByLabel('GPU 1').check();

    const requestPromise = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/move'),
    );
    await page.getByRole('button', { name: 'Move instance' }).click();
    const request = await requestPromise;

    expect(request.postDataJSON()).toEqual({
      targetWorkerId: 'worker-target',
      targetDeviceIndices: [1],
    });
    await expect(page.getByText('Deploying replacement instance…')).toBeVisible();
  });
});
