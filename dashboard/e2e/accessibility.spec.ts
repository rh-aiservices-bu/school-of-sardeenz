/**
 * Automated accessibility tests using axe-core.
 *
 * Scans each key page and view with the WCAG 2.1 AA ruleset.
 * Covers primary list views, detail views, forms, empty states, and modal flows.
 * Uses the existing E2E mock harness from fixtures.ts.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, bffUrl } from './fixtures.js';

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const CLUSTER_STATUS = {
  workerCount: 2,
  workersOnline: 2,
  modelCounts: {
    total: 3,
    active: 2,
    sleeping: 1,
    starting: 0,
    error: 0,
    other: 0,
  },
  memory: {
    totalBytes: 160 * 1024 ** 3,
    usedBytes: 48 * 1024 ** 3,
    availableBytes: 112 * 1024 ** 3,
  },
};

const WORKERS = [
  {
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
  },
  {
    workerId: 'worker-c3d4',
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
    modelCount: 1,
    lastHeartbeatAt: new Date().toISOString(),
  },
];

const MODELS = [
  {
    modelName: 'meta-llama/Llama-3.1-8B-Instruct',
    state: 'ACTIVE',
    runnerType: 'vllm',
    requiredMemory: 16 * 1024 ** 3,
    currentMemory: 15 * 1024 ** 3,
    workerId: 'worker-a1b2',
    pinned: false,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    lastInferenceAt: new Date(Date.now() - 60_000).toISOString(),
  },
  {
    modelName: 'mistralai/Mistral-7B-Instruct-v0.3',
    state: 'SLEEPING',
    runnerType: 'vllm',
    requiredMemory: 8 * 1024 ** 3,
    currentMemory: 0,
    createdAt: new Date(Date.now() - 7200_000).toISOString(),
  },
];

const ACTIVE_MODEL = MODELS[0];
const WORKER_DETAIL = {
  ...WORKERS[0],
  models: [
    {
      modelName: ACTIVE_MODEL.modelName,
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

// WCAG 2.1 AA tags
const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

// ---------------------------------------------------------------------------
// Helper — run AxeBuilder and assert zero violations
// ---------------------------------------------------------------------------

async function runA11yCheck(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(A11Y_TAGS)
    .analyze();

  const violations = results.violations.map(
    (v) => `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} node(s))`,
  );
  expect(violations, `Accessibility violations:\n${violations.join('\n')}`).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Accessibility — WCAG 2.1 AA scanning', () => {
  // ── Primary list views ────────────────────────────────────────────────────

  test('Cluster Overview (/) has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);
    mockControlPlane.setWorkers(WORKERS);
    mockControlPlane.setModels(MODELS);

    await page.goto(bffUrl(bffPort, '/'));

    // Wait for the main content to be visible
    await expect(page.getByText('Workers')).toBeVisible();

    await runA11yCheck(page);
  });

  test('Model List (/models) with data has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);
    mockControlPlane.setModels(MODELS);

    await page.goto(bffUrl(bffPort, '/models'));

    // Wait for the table to render
    await expect(page.locator('table[aria-label="Model list"]')).toBeVisible();

    await runA11yCheck(page);
  });

  test('Model List (/models) empty state has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);
    mockControlPlane.setModels([]);

    await page.goto(bffUrl(bffPort, '/models'));

    await expect(page.getByText('No models deployed')).toBeVisible();

    await runA11yCheck(page);
  });

  test('Worker List (/workers) with data has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);
    mockControlPlane.setWorkers(WORKERS);

    await page.goto(bffUrl(bffPort, '/workers'));

    await expect(page.locator('table[aria-label="Worker list"]')).toBeVisible();

    await runA11yCheck(page);
  });

  test('Worker List (/workers) empty state has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);
    mockControlPlane.setWorkers([]);

    await page.goto(bffUrl(bffPort, '/workers'));

    await expect(page.getByText('No workers registered')).toBeVisible();

    await runA11yCheck(page);
  });

  // ── Detail views ──────────────────────────────────────────────────────────

  test('Model Detail (/models/:name) has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setModels(MODELS);

    const encodedName = encodeURIComponent(ACTIVE_MODEL.modelName);
    await page.goto(bffUrl(bffPort, `/models/${encodedName}`));

    // Wait for the model heading to appear
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(ACTIVE_MODEL.modelName)).toBeVisible();

    await runA11yCheck(page);
  });

  test('Worker Detail (/workers/:id) has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    const workerId = WORKERS[0].workerId;
    mockControlPlane.setWorkers(WORKERS, { [workerId]: WORKER_DETAIL });

    const encodedId = encodeURIComponent(workerId);
    await page.goto(bffUrl(bffPort, `/workers/${encodedId}`));

    // Wait for the worker heading to appear
    await expect(page.getByRole('heading', { name: workerId })).toBeVisible();

    await runA11yCheck(page);
  });

  // ── Form views ────────────────────────────────────────────────────────────

  test('Model Deploy form (/models/deploy) has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);

    await page.goto(bffUrl(bffPort, '/models/deploy'));

    // Wait for the form to be visible
    await expect(page.getByText('Deploy Model')).toBeVisible();

    await runA11yCheck(page);
  });

  // ── Modal flows ───────────────────────────────────────────────────────────

  test('Delete model confirmation modal has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setModels([ACTIVE_MODEL]);

    await page.goto(bffUrl(bffPort, '/models'));
    await expect(page.locator('table[aria-label="Model list"]')).toBeVisible();

    // Open the kebab menu and click Delete to open the modal
    await page.locator(`button[aria-label="Actions for ${ACTIVE_MODEL.modelName}"]`).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();

    // Wait for the modal to appear
    await expect(page.getByText('Delete model?')).toBeVisible();

    await runA11yCheck(page);
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  test('Metrics Dashboard (/metrics) has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
    mockPrometheus,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);
    // Prometheus mock returns empty data by default, which is fine for a11y testing

    await page.goto(bffUrl(bffPort, '/metrics'));

    // Wait for the metrics page heading
    await expect(page.getByText('Metrics').first()).toBeVisible();

    // Wait for charts to settle (loading spinners to resolve or empty states to appear)
    await page.waitForTimeout(1000);

    await runA11yCheck(page);

    void mockPrometheus;
  });
});
