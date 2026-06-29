import { test, expect, bffUrl } from './fixtures.js';
import type { MockWorkerInfo, MockWorkerDetail } from './fixtures.js';

const DEVICE_GPU = {
  deviceIndex: 0,
  deviceType: 'CUDA',
  memoryTotalBytes: 80 * 1024 ** 3,
  memoryUsedBytes: 24 * 1024 ** 3,
  memoryAvailableBytes: 56 * 1024 ** 3,
};

const WORKER_ONLINE: MockWorkerInfo = {
  workerId: 'gpu-node-01',
  status: 'ONLINE',
  devices: [DEVICE_GPU],
  modelCount: 1,
  lastHeartbeatAt: new Date().toISOString(),
};

const WORKER_OFFLINE: MockWorkerInfo = {
  workerId: 'gpu-node-02',
  status: 'OFFLINE',
  devices: [],
  modelCount: 0,
  lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString(),
};

const WORKER_DETAIL: MockWorkerDetail = {
  ...WORKER_ONLINE,
  models: [
    {
      modelName: 'meta-llama/Llama-3.1-8B-Instruct',
      state: 'ACTIVE',
      memoryUsedBytes: 15 * 1024 ** 3,
    },
  ],
  runnerCapabilities: [
    {
      runnerType: 'vllm',
      engineName: 'vLLM',
      supportedModelTypes: ['llm'],
      supportedDeviceTypes: ['CUDA'],
    },
  ],
  joinedAt: new Date(Date.now() - 3600_000).toISOString(),
};

test.describe('Workers', () => {
  test.describe('Worker List', () => {
    test('renders worker table when workers exist', async ({ page, bffPort, mockControlPlane }) => {
      mockControlPlane.setWorkers([WORKER_ONLINE]);

      await page.goto(bffUrl(bffPort, '/workers'));

      await expect(page.locator('table[aria-label="Worker list"]')).toBeVisible();
    });

    test('shows worker IDs in the table', async ({ page, bffPort, mockControlPlane }) => {
      mockControlPlane.setWorkers([WORKER_ONLINE, WORKER_OFFLINE]);

      await page.goto(bffUrl(bffPort, '/workers'));

      await expect(page.getByText(WORKER_ONLINE.workerId)).toBeVisible();
      await expect(page.getByText(WORKER_OFFLINE.workerId)).toBeVisible();
    });

    test('shows ONLINE status label for online workers', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setWorkers([WORKER_ONLINE]);

      await page.goto(bffUrl(bffPort, '/workers'));

      await expect(page.getByText('Online')).toBeVisible();
    });

    test('shows OFFLINE status label for offline workers', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setWorkers([WORKER_OFFLINE]);

      await page.goto(bffUrl(bffPort, '/workers'));

      await expect(page.getByText('Offline')).toBeVisible();
    });

    test('shows empty state when no workers registered', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setWorkers([]);

      await page.goto(bffUrl(bffPort, '/workers'));

      await expect(page.getByText('No workers registered')).toBeVisible();
    });

    test('clicking worker ID navigates to worker detail', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setWorkers([WORKER_ONLINE], { [WORKER_ONLINE.workerId]: WORKER_DETAIL });

      await page.goto(bffUrl(bffPort, '/workers'));
      await page.getByText(WORKER_ONLINE.workerId).click();

      await expect(page).toHaveURL(
        new RegExp(`/workers/${encodeURIComponent(WORKER_ONLINE.workerId)}`),
      );
    });
  });

  test.describe('Worker Detail', () => {
    test('worker detail page shows worker ID as heading', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setWorkers([WORKER_ONLINE], { [WORKER_ONLINE.workerId]: WORKER_DETAIL });

      const encodedId = encodeURIComponent(WORKER_ONLINE.workerId);
      await page.goto(bffUrl(bffPort, `/workers/${encodedId}`));

      await expect(page.getByRole('heading', { name: WORKER_ONLINE.workerId })).toBeVisible();
    });

    test('worker detail page shows device memory card', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setWorkers([WORKER_ONLINE], { [WORKER_ONLINE.workerId]: WORKER_DETAIL });

      const encodedId = encodeURIComponent(WORKER_ONLINE.workerId);
      await page.goto(bffUrl(bffPort, `/workers/${encodedId}`));

      await expect(page.getByText('Device Memory')).toBeVisible();
      // GPU 0 — CUDA card should be present
      await expect(page.getByText('GPU 0')).toBeVisible();
    });

    test('worker detail page shows running models section', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setWorkers([WORKER_ONLINE], { [WORKER_ONLINE.workerId]: WORKER_DETAIL });

      const encodedId = encodeURIComponent(WORKER_ONLINE.workerId);
      await page.goto(bffUrl(bffPort, `/workers/${encodedId}`));

      await expect(page.getByText('Running Models')).toBeVisible();
      await expect(page.getByText('meta-llama/Llama-3.1-8B-Instruct')).toBeVisible();
    });

    test('worker detail shows not found message for missing worker', async ({
      page,
      bffPort,
      mockControlPlane,
    }) => {
      mockControlPlane.setWorkers([]);

      await page.goto(bffUrl(bffPort, '/workers/nonexistent-worker-id'));

      await expect(
        page.getByText('Worker not found').or(page.getByText('Failed to load worker')),
      ).toBeVisible();
    });
  });
});
