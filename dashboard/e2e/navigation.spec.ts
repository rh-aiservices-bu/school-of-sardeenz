import { test, expect, bffUrl } from './fixtures.js';

test.describe('Navigation', () => {
  test('loads cluster overview as landing page', async ({ page, bffPort, mockControlPlane }) => {
    // Provide minimal cluster status so the overview renders
    mockControlPlane.setClusterStatus({
      workerCount: 0,
      workersOnline: 0,
      modelCounts: { total: 0, active: 0 },
      memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0 },
    });

    await page.goto(bffUrl(bffPort, '/'));

    // The page renders h2 elements (PageTitle within CardTitle), not h1
    await expect(page.locator('h2').first()).toBeVisible();
    // Verify we're on the cluster overview by checking the sidebar nav item is active
    await expect(page.locator('[itemid="/"].pf-m-current')).toBeVisible();
  });

  test('sidebar shows all primary navigation items', async ({
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
      page
        .getByRole('link', { name: 'Cluster Overview' })
        .or(page.locator('nav').getByText('Cluster Overview')),
    ).toBeVisible();
    await expect(page.locator('nav').getByText('Models')).toBeVisible();
    await expect(page.locator('nav').getByText('Workers')).toBeVisible();
    await expect(page.locator('nav').getByText('Metrics')).toBeVisible();
  });

  test('navigates to models page via sidebar', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setModels([]);

    await page.goto(bffUrl(bffPort, '/'));
    await page.locator('nav').getByText('Models').click();
    await expect(page).toHaveURL(/\/models$/);
  });

  test('navigates to workers page via sidebar', async ({ page, bffPort, mockControlPlane }) => {
    mockControlPlane.setWorkers([]);

    await page.goto(bffUrl(bffPort, '/'));
    await page.locator('nav').getByText('Workers').click();
    await expect(page).toHaveURL(/\/workers$/);
  });

  test('navigates to metrics page via sidebar', async ({ page, bffPort }) => {
    await page.goto(bffUrl(bffPort, '/'));
    await page.locator('nav').getByText('Metrics').click();
    await expect(page).toHaveURL(/\/metrics$/);
  });

  test('sidebar highlights active nav item for models page', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setModels([]);

    await page.goto(bffUrl(bffPort, '/models'));
    const modelsNavItem = page.locator('[itemid="/models"]');
    await expect(modelsNavItem).toHaveClass(/pf-m-current/);
  });

  test('sidebar highlights active nav item for workers page', async ({
    page,
    bffPort,
    mockControlPlane,
  }) => {
    mockControlPlane.setWorkers([]);

    await page.goto(bffUrl(bffPort, '/workers'));
    const workersNavItem = page.locator('[itemid="/workers"]');
    await expect(workersNavItem).toHaveClass(/pf-m-current/);
  });

  test('shows 404 page for unknown routes', async ({ page, bffPort }) => {
    await page.goto(bffUrl(bffPort, '/this-route-does-not-exist'));
    await expect(page.getByText('Page not found')).toBeVisible();
  });
});
