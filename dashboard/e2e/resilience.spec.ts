/**
 * Resilience & live-update E2E tests.
 *
 * These tests prove the three core Phase 3 promises that require a real
 * Redis instance (provided by `podman compose up -d redis`):
 *
 * 1. Degraded mode — CP goes down, Redis fallback keeps the UI usable
 * 2. SSE state transitions — events flow through Redis pub/sub → BFF → frontend
 * 3. Multi-GPU memory visualization — correct rendering with known proportions
 */

import { test, expect, bffUrl } from './fixtures.js';
import type { MockModelInfo, MockWorkerInfo } from './fixtures.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const GiB = 1024 ** 3;

const ACTIVE_MODEL: MockModelInfo = {
  modelName: 'meta-llama/Llama-3.1-8B-Instruct',
  state: 'ACTIVE',
  runnerType: 'vllm',
  requiredMemory: 16 * GiB,
  currentMemory: 15 * GiB,
  workerId: 'worker-gpu-01',
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  lastInferenceAt: new Date(Date.now() - 60_000).toISOString(),
};

const SLEEPING_MODEL: MockModelInfo = {
  modelName: 'mistralai/Mistral-7B-v0.3',
  state: 'SLEEPING',
  runnerType: 'vllm',
  requiredMemory: 8 * GiB,
  currentMemory: 0,
  createdAt: new Date(Date.now() - 7200_000).toISOString(),
};

const WORKER_1: MockWorkerInfo = {
  workerId: 'worker-gpu-01',
  status: 'ONLINE',
  devices: [
    {
      deviceIndex: 0,
      deviceType: 'CUDA',
      memoryTotalBytes: 8 * GiB,
      memoryUsedBytes: 4 * GiB,
      memoryAvailableBytes: 4 * GiB,
    },
    {
      deviceIndex: 1,
      deviceType: 'CUDA',
      memoryTotalBytes: 8 * GiB,
      memoryUsedBytes: 6 * GiB,
      memoryAvailableBytes: 2 * GiB,
    },
  ],
  modelCount: 1,
  lastHeartbeatAt: new Date().toISOString(),
};

const WORKER_2: MockWorkerInfo = {
  workerId: 'worker-gpu-02',
  status: 'ONLINE',
  devices: [
    {
      deviceIndex: 0,
      deviceType: 'CUDA',
      memoryTotalBytes: 16 * GiB,
      memoryUsedBytes: 2 * GiB,
      memoryAvailableBytes: 14 * GiB,
    },
    {
      deviceIndex: 1,
      deviceType: 'CUDA',
      memoryTotalBytes: 16 * GiB,
      memoryUsedBytes: 16 * GiB,
      memoryAvailableBytes: 0,
    },
  ],
  modelCount: 1,
  lastHeartbeatAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Resilience & live updates', () => {
  test('shows degraded banner with cached data when control plane is down', async ({
    page,
    bffPort,
    mockControlPlane,
    testRedis,
  }) => {
    // Seed Redis with model and worker state
    await testRedis.seedModel({
      modelName: ACTIVE_MODEL.modelName,
      state: 'ACTIVE',
      workerId: 'worker-gpu-01',
    });
    await testRedis.seedModel({
      modelName: SLEEPING_MODEL.modelName,
      state: 'SLEEPING',
    });
    await testRedis.seedWorkerDetail({
      workerId: 'worker-gpu-01',
      status: 'ONLINE',
      devices: WORKER_1.devices,
    });

    // Simulate CP being down — all API endpoints return 503
    mockControlPlane.setApiError(true);

    await page.goto(bffUrl(bffPort, '/'));

    // The degraded banner should appear
    await expect(page.getByText('Control plane unreachable — showing cached data')).toBeVisible({
      timeout: 15_000,
    });

    // Data from Redis should still be visible — navigate to models list
    await page.goto(bffUrl(bffPort, '/models'));
    await expect(page.getByText(ACTIVE_MODEL.modelName)).toBeVisible();
    await expect(page.getByText(SLEEPING_MODEL.modelName)).toBeVisible();
  });

  test('model state transitions via SSE event path', async ({
    page,
    bffPort,
    mockControlPlane,
    testRedis,
  }) => {
    // Start with a model in SLEEPING state (served by mock CP)
    mockControlPlane.setModels([SLEEPING_MODEL]);
    mockControlPlane.setWorkers([WORKER_1]);

    await page.goto(bffUrl(bffPort, '/models'));

    // Verify model shows Sleeping state
    await expect(page.getByText('Sleeping')).toBeVisible();

    // Update the mock CP data so the refetch returns the new state
    mockControlPlane.setModels([{ ...SLEEPING_MODEL, state: 'ACTIVE', workerId: 'worker-gpu-01' }]);

    // Publish a MODEL_STATE_CHANGED event through Redis pub/sub.
    // The BFF SSE route picks this up, streams it to the frontend, which
    // invalidates the React Query cache and refetches from the mock CP.
    await testRedis.publishClusterEvent({
      type: 'MODEL_STATE_CHANGED',
      timestamp: new Date().toISOString(),
      modelName: SLEEPING_MODEL.modelName,
      state: 'ACTIVE',
    });

    // The model state should update to Active without a page reload
    await expect(page.getByText('Active')).toBeVisible({ timeout: 10_000 });
  });

  test('multi-GPU memory visualization renders correct proportions', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    // Set up cluster with 2 workers × 2 GPUs each at known proportions:
    //   Worker A GPU 0: 4/8 GiB  (50%)
    //   Worker A GPU 1: 6/8 GiB  (75%)
    //   Worker B GPU 0: 2/16 GiB (12%)
    //   Worker B GPU 1: 16/16 GiB (100%)
    mockControlPlane.setWorkers([WORKER_1, WORKER_2]);
    mockControlPlane.setClusterMemory({
      workers: [
        {
          workerId: WORKER_1.workerId,
          devices: WORKER_1.devices,
        },
        {
          workerId: WORKER_2.workerId,
          devices: WORKER_2.devices,
        },
      ],
    });

    await page.goto(bffUrl(bffPort, '/'));

    // Verify VRAM Allocation card is visible
    await expect(page.getByText('VRAM Allocation')).toBeVisible();

    // Both worker IDs should appear as links
    await expect(page.getByRole('link', { name: WORKER_1.workerId })).toBeVisible();
    await expect(page.getByRole('link', { name: WORKER_2.workerId })).toBeVisible();

    // 4 GPU device bars should be rendered (GPU 0, GPU 1 for each worker)
    const gpuLabels = page.getByText('GPU 0', { exact: false });
    await expect(gpuLabels).toHaveCount(2);
    const gpu1Labels = page.getByText('GPU 1', { exact: false });
    await expect(gpu1Labels).toHaveCount(2);

    // Verify memory values are displayed for Worker A GPU 0: 4.00 GiB / 8.00 GiB
    await expect(page.getByText('4.00 GiB').first()).toBeVisible();
    await expect(page.getByText('6.00 GiB').first()).toBeVisible();

    // Verify Worker B GPU 1 shows full utilization: 16.00 GiB / 16.00 GiB
    await expect(page.getByText('16.00 GiB').first()).toBeVisible();

    // Click a device bar to expand details and verify breakdown
    const expandButton = page.getByRole('button', { name: /Click to expand GPU 0/i }).first();
    await expandButton.click();

    // Expanded panel shows the breakdown
    await expect(page.getByText('50%')).toBeVisible();
  });
});
