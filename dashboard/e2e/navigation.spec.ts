import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('loads cluster overview as landing page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Cluster Overview');
  });

  test('navigates to models page via sidebar', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Models');
    await expect(page).toHaveURL('/models');
  });

  test('navigates to workers page via sidebar', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Workers');
    await expect(page).toHaveURL('/workers');
  });

  test('navigates to metrics page via sidebar', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Metrics');
    await expect(page).toHaveURL('/metrics');
  });

  test('sidebar highlights active nav item', async ({ page }) => {
    await page.goto('/models');
    const modelsNavItem = page.locator('[itemid="/models"]');
    await expect(modelsNavItem).toHaveClass(/pf-m-current/);
  });
});
