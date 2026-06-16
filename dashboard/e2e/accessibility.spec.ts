/**
 * Automated accessibility tests using axe-core.
 *
 * Scans each key page with the WCAG 2.1 AA ruleset.
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

test.describe('Accessibility — WCAG 2.1 AA', () => {
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

  test('Model List (/models) has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);
    mockControlPlane.setModels(MODELS);

    await page.goto(bffUrl(bffPort, '/models'));

    // Wait for the table or empty state
    await page.waitForSelector('table, [role="status"]', { timeout: 10_000 }).catch(() => {
      // Empty state may render differently
    });
    await expect(page.getByText('Models').first()).toBeVisible();

    await runA11yCheck(page);
  });

  test('Model Deploy (/models/deploy) has no accessibility violations', async ({
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

  test('Worker List (/workers) has no accessibility violations', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setClusterStatus(CLUSTER_STATUS);
    mockControlPlane.setWorkers(WORKERS);

    await page.goto(bffUrl(bffPort, '/workers'));

    // Wait for the workers page to load
    await expect(page.getByText('Workers').first()).toBeVisible();

    await runA11yCheck(page);
  });

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
